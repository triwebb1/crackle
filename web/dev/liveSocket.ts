/**
 * `/ws/live` - the 1 Hz push stream, served by hand.
 *
 * ============================================================================================
 * WHY THIS IS WRITTEN OUT RATHER THAN DELEGATED
 * ============================================================================================
 *
 * The real controller serves same-origin WebSocket state at /ws/live and the app falls back to
 * a 1 Hz `GET /api/live` poll whenever that stream is not up. Leaving `/ws/live` unserved in the
 * mock would therefore have been legitimate - the app would simply have polled - but it would also
 * have meant the entire streaming path (the 1.75 s watchdog, the reconnect backoff, the
 * `websocket`/`fallback` indicator, and the roast fields that only move at stream cadence) was
 * untestable in development, and that path is a large part of what development needs to exercise.
 *
 * Vite's own dev WebSocket cannot be borrowed for this: its upgrade listener answers only its own
 * HMR sub-protocol on its own path and ignores everything else, so an upgrade to `/ws/live` is left
 * hanging rather than refused. But "ignores" is exactly what makes a second listener safe - it can
 * complete the handshake itself without racing Vite for the socket.
 *
 * So the handshake is done here, with `node:crypto` and no dependency: RFC 6455 is a SHA-1 of the
 * client key against the protocol's fixed GUID, and a server-to-client text frame is a two-to-ten
 * byte header in front of the payload with no mask. Incoming frames are barely parsed, because a
 * browser on this endpoint only ever sends a close or a ping - it has nothing to say.
 */
import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

/**
 * Just enough of a server to attach an upgrade listener to. Vite's `httpServer` is an `http.Server`
 * or an `Http2SecureServer` depending on configuration, and this is the shape both of them share.
 */
export interface UpgradableServer {
  on(event: 'upgrade', listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown
  off(event: 'upgrade', listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_CLIENT_FRAME_BYTES = 4096
const MAX_PENDING_BYTES = 64 * 1024

export interface ClientFrame {
  opcode: number
  payload: Buffer
}

export interface ClientFrameParse {
  frames: ClientFrame[]
  closeCode?: 1002 | 1009
}

/**
 * Buffered RFC 6455 client-frame parser. Browsers mask every client frame; control frames are
 * single-frame and at most 125 bytes. Data frames are ignored by this endpoint, but their
 * fragmentation state is still validated so an interleaved Ping cannot desynchronize the stream.
 */
export class ClientFrameParser {
  private pending = Buffer.alloc(0)
  private fragmentedOpcode?: number

  push(chunk: Buffer): ClientFrameParse {
    if (chunk.length > 0) this.pending = Buffer.concat([this.pending, chunk])
    if (this.pending.length > MAX_PENDING_BYTES) return this.fail(1009)

    const frames: ClientFrame[] = []
    while (this.pending.length >= 2) {
      const first = this.pending[0]
      const second = this.pending[1]
      const fin = (first & 0x80) !== 0
      const rsv = first & 0x70
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let payloadLength = second & 0x7f
      let headerLength = 2

      if (rsv !== 0 || !masked) return this.fail(1002, frames)
      if (payloadLength === 126) {
        if (this.pending.length < 4) break
        payloadLength = this.pending.readUInt16BE(2)
        headerLength = 4
      } else if (payloadLength === 127) {
        if (this.pending.length < 10) break
        const wide = this.pending.readBigUInt64BE(2)
        if (wide > BigInt(MAX_CLIENT_FRAME_BYTES)) return this.fail(1009, frames)
        payloadLength = Number(wide)
        headerLength = 10
      }

      const control = opcode >= 0x8
      if (payloadLength > MAX_CLIENT_FRAME_BYTES) return this.fail(1009, frames)
      if (control && (!fin || payloadLength > 125)) return this.fail(1002, frames)
      if (opcode === 0x8 && payloadLength === 1) return this.fail(1002, frames)

      const totalLength = headerLength + 4 + payloadLength
      if (this.pending.length < totalLength) break
      const mask = this.pending.subarray(headerLength, headerLength + 4)
      const encoded = this.pending.subarray(headerLength + 4, totalLength)
      const payload = Buffer.alloc(payloadLength)
      for (let index = 0; index < payloadLength; index += 1) {
        payload[index] = encoded[index] ^ mask[index & 3]
      }
      this.pending = this.pending.subarray(totalLength)

      if (opcode === 0x0) {
        if (this.fragmentedOpcode === undefined) return this.fail(1002, frames)
        if (fin) this.fragmentedOpcode = undefined
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (this.fragmentedOpcode !== undefined) return this.fail(1002, frames)
        if (!fin) this.fragmentedOpcode = opcode
      } else if (opcode !== 0x8 && opcode !== 0x9 && opcode !== 0xa) {
        return this.fail(1002, frames)
      }

      frames.push({ opcode, payload })
    }
    return { frames }
  }

  private fail(closeCode: 1002 | 1009, frames: ClientFrame[] = []): ClientFrameParse {
    this.pending = Buffer.alloc(0)
    this.fragmentedOpcode = undefined
    return { frames, closeCode }
  }
}

/** One unmasked server frame with a caller-selected opcode. */
const serverFrame = (opcode: number, payload: Buffer): Buffer => {
  if (payload.length >= 126) throw new RangeError('Control payload is too large')
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload])
}

/** One server-to-client text frame: FIN + opcode 1, unmasked, with the three length forms. */
const textFrame = (text: string): Buffer => {
  const payload = Buffer.from(text, 'utf8')
  let header: Buffer
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length])
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  return Buffer.concat([header, payload])
}

export interface LiveSocketServer {
  /** How many browsers are attached. The device does no periodic push work when this is zero. */
  readonly clients: number
  broadcast: (payload: unknown) => void
  /**
   * Sever every attached client without closing the server: each browser sees its socket close,
   * backs off, and reconnects - exactly what a phone lock or a Wi-Fi dropout does to the real
   * stream. Returns how many were dropped.
   */
  dropClients: () => number
  close: () => void
}

const LIVE_CLIENT_CAPACITY = 4
const STALE_CLIENT_MS = 15_000

export const oldestStaleSubscriber = <T>(lastSentBySubscriber: ReadonlyMap<T, number>, now: number): T | undefined => {
  let selected: T | undefined
  let oldestAge = -1
  for (const [subscriber, lastSentAt] of lastSentBySubscriber) {
    const age = now - lastSentAt
    if (age < STALE_CLIENT_MS || age <= oldestAge) continue
    selected = subscriber
    oldestAge = age
  }
  return selected
}

export const serveLiveSocket = (
  httpServer: UpgradableServer,
  path: string,
  snapshot: () => unknown,
  intervalMs: number,
): LiveSocketServer => {
  const sockets = new Map<Duplex, number>()

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '/', 'http://mock.local')
    if (url.pathname !== path) return
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    if (sockets.size >= LIVE_CLIENT_CAPACITY) {
      const stale = oldestStaleSubscriber(sockets, Date.now())
      if (!stale) {
        socket.end(
          'HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        )
        return
      }
      sockets.delete(stale)
      stale.destroy()
    }
    const accept = createHash('sha1')
      .update(key + GUID)
      .digest('base64')
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'),
    )
    if ('setNoDelay' in socket && typeof socket.setNoDelay === 'function') socket.setNoDelay(true)
    sockets.set(socket, Date.now())

    const drop = () => {
      sockets.delete(socket)
      socket.destroy()
    }
    const finish = (frame: Buffer) => {
      sockets.delete(socket)
      if (socket.writable) socket.end(frame)
      else socket.destroy()
    }
    socket.on('error', drop)
    socket.on('close', () => sockets.delete(socket))
    const parser = new ClientFrameParser()
    const receive = (chunk: Buffer) => {
      const parsed = parser.push(chunk)
      for (const frame of parsed.frames) {
        if (frame.opcode === 0x8) {
          finish(serverFrame(0x8, frame.payload))
          return
        }
        if (frame.opcode === 0x9 && socket.writable) {
          socket.write(serverFrame(0xa, frame.payload))
        }
      }
      if (parsed.closeCode !== undefined) {
        const payload = Buffer.alloc(2)
        payload.writeUInt16BE(parsed.closeCode)
        finish(serverFrame(0x8, payload))
      }
    }
    socket.on('data', receive)

    // The first frame goes out immediately so the app need not wait one cadence to establish liveness.
    socket.write(textFrame(JSON.stringify(snapshot())))
    sockets.set(socket, Date.now())
    if (head.length > 0) receive(head)
  }

  httpServer.on('upgrade', onUpgrade)

  const timer = setInterval(() => {
    if (sockets.size === 0) return
    const frame = textFrame(JSON.stringify(snapshot()))
    for (const socket of sockets.keys()) {
      if (socket.writable) {
        socket.write(frame)
        sockets.set(socket, Date.now())
      } else sockets.delete(socket)
    }
  }, intervalMs)
  timer.unref?.()

  return {
    get clients() {
      return sockets.size
    },
    broadcast: (payload: unknown) => {
      const frame = textFrame(JSON.stringify(payload))
      for (const socket of sockets.keys()) {
        if (socket.writable) {
          socket.write(frame)
          sockets.set(socket, Date.now())
        } else sockets.delete(socket)
      }
    },
    dropClients: () => {
      const dropped = sockets.size
      for (const socket of sockets.keys()) socket.destroy()
      sockets.clear()
      return dropped
    },
    close: () => {
      clearInterval(timer)
      httpServer.off('upgrade', onUpgrade)
      for (const socket of sockets.keys()) socket.destroy()
      sockets.clear()
    },
  }
}
