import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { Duplex } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LIVE_STREAM_MS } from './config'
import { ClientFrameParser, oldestStaleSubscriber, serveLiveSocket, type UpgradableServer } from './liveSocket'

const maskedFrame = (opcode: number, payload: Buffer, fin = true) => {
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44])
  if (payload.length >= 126) throw new Error('test helper only builds short frames')
  const encoded = Buffer.from(payload)
  for (let index = 0; index < encoded.length; index += 1) encoded[index] ^= mask[index & 3]
  return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length]), mask, encoded])
}

class TestSocket extends Duplex {
  writes: Buffer[] = []

  _read() {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.writes.push(Buffer.from(chunk))
    callback()
  }

  setNoDelay() {
    return this
  }
}

const request = () =>
  ({
    url: '/ws/live',
    headers: { 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
  }) as unknown as IncomingMessage

afterEach(() => vi.useRealTimers())

describe('the dev live WebSocket client-frame parser', () => {
  it('publishes on the production 1 Hz cadence after the immediate initial frame', () => {
    vi.useFakeTimers()
    const http = new EventEmitter()
    let sequence = 0
    const live = serveLiveSocket(
      http as unknown as UpgradableServer,
      '/ws/live',
      () => ({ sequence: ++sequence }),
      LIVE_STREAM_MS,
    )
    const socket = new TestSocket()
    http.emit('upgrade', request(), socket, Buffer.alloc(0))
    socket.writes = []

    expect(LIVE_STREAM_MS).toBe(1000)
    vi.advanceTimersByTime(999)
    expect(socket.writes).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(socket.writes).toHaveLength(1)
    expect(sequence).toBe(2)
    live.close()
  })

  it('buffers a frame split across TCP chunks and preserves the exact Ping payload', () => {
    const parser = new ClientFrameParser()
    const payload = Buffer.from([0, 1, 2, 250, 255])
    const frame = maskedFrame(0x9, payload)

    expect(parser.push(frame.subarray(0, 1)).frames).toEqual([])
    expect(parser.push(frame.subarray(1, 6)).frames).toEqual([])
    const parsed = parser.push(frame.subarray(6))
    expect(parsed.closeCode).toBeUndefined()
    expect(parsed.frames).toHaveLength(1)
    expect(parsed.frames[0].opcode).toBe(0x9)
    expect(parsed.frames[0].payload).toEqual(payload)
  })

  it('parses multiple masked frames and permits a Ping between data fragments', () => {
    const parser = new ClientFrameParser()
    const frames = Buffer.concat([
      maskedFrame(0x1, Buffer.from('part one'), false),
      maskedFrame(0x9, Buffer.from('alive')),
      maskedFrame(0x0, Buffer.from('part two'), true),
      maskedFrame(0x9, Buffer.from('again')),
    ])
    const parsed = parser.push(frames)
    expect(parsed.closeCode).toBeUndefined()
    expect(parsed.frames.map((frame) => frame.opcode)).toEqual([0x1, 0x9, 0x0, 0x9])
    expect(parsed.frames[1].payload.toString()).toBe('alive')
    expect(parsed.frames[3].payload.toString()).toBe('again')
  })

  it('rejects unmasked, malformed-fragment, and oversized client frames', () => {
    expect(new ClientFrameParser().push(Buffer.from([0x89, 0])).closeCode).toBe(1002)
    expect(new ClientFrameParser().push(maskedFrame(0x0, Buffer.from('orphan'))).closeCode).toBe(1002)

    const oversizedHeader = Buffer.from([0x82, 0xfe, 0x10, 0x01, 1, 2, 3, 4])
    expect(new ClientFrameParser().push(oversizedHeader).closeCode).toBe(1009)
  })

  it('echoes the exact Ping payload as a Pong and closes safely on malformed input', () => {
    const http = new EventEmitter()
    const live = serveLiveSocket(http as unknown as UpgradableServer, '/ws/live', () => ({ ok: true }), 60_000)
    const socket = new TestSocket()
    http.emit('upgrade', request(), socket, Buffer.alloc(0))
    socket.writes = []

    const ping = maskedFrame(0x9, Buffer.from([0, 7, 128, 255]))
    socket.emit('data', ping.subarray(0, 3))
    socket.emit('data', ping.subarray(3))
    expect(socket.writes).toEqual([Buffer.from([0x8a, 4, 0, 7, 128, 255])])

    socket.writes = []
    socket.emit('data', Buffer.from([0x89, 0]))
    expect(socket.writes[0]).toEqual(Buffer.from([0x88, 2, 0x03, 0xea]))
    expect(socket.writableEnded).toBe(true)
    expect(live.clients).toBe(0)
    live.close()
  })

  it('admits four healthy subscribers and rejects a fifth without displacing them', () => {
    const http = new EventEmitter()
    const live = serveLiveSocket(http as unknown as UpgradableServer, '/ws/live', () => ({ ok: true }), 60_000)
    const accepted = Array.from({ length: 4 }, () => new TestSocket())
    for (const socket of accepted) http.emit('upgrade', request(), socket, Buffer.alloc(0))

    const rejected = new TestSocket()
    http.emit('upgrade', request(), rejected, Buffer.alloc(0))

    expect(live.clients).toBe(4)
    expect(rejected.writes.map((chunk) => chunk.toString()).join('')).toContain('503 Service Unavailable')
    expect(accepted.every((socket) => !socket.destroyed)).toBe(true)
    live.close()
  })

  it('selects the least recently served eligible subscriber, not insertion order', () => {
    const insertedFirst = new TestSocket()
    const leastRecentlyServed = new TestSocket()
    const timestamps = new Map<Duplex, number>([
      [insertedFirst, 1_000],
      [leastRecentlyServed, 0],
    ])
    expect(oldestStaleSubscriber(timestamps, 16_001)).toBe(leastRecentlyServed)
  })

  it('reclaims a stale subscriber when the four-client capacity is full', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const http = new EventEmitter()
    const live = serveLiveSocket(http as unknown as UpgradableServer, '/ws/live', () => ({ ok: true }), 60_000)
    const accepted = Array.from({ length: 4 }, () => new TestSocket())
    for (const socket of accepted) http.emit('upgrade', request(), socket, Buffer.alloc(0))

    vi.setSystemTime(15_001)
    const replacement = new TestSocket()
    http.emit('upgrade', request(), replacement, Buffer.alloc(0))

    expect(live.clients).toBe(4)
    expect(accepted[0].destroyed).toBe(true)
    expect(replacement.writes[0].toString()).toContain('101 Switching Protocols')
    live.close()
  })

  it('consumes a complete frame already present in the HTTP upgrade head', () => {
    const http = new EventEmitter()
    const live = serveLiveSocket(http as unknown as UpgradableServer, '/ws/live', () => ({ ok: true }), 60_000)
    const socket = new TestSocket()
    const payload = Buffer.from('head-ping')
    http.emit('upgrade', request(), socket, maskedFrame(0x9, payload))

    expect(socket.writes.at(-1)).toEqual(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]))
    live.close()
  })

  it('drops every attached client on demand so browsers must reconnect, and takes them back', () => {
    const http = new EventEmitter()
    let frames = 0
    const live = serveLiveSocket(http as unknown as UpgradableServer, '/ws/live', () => ({ frame: ++frames }), 60_000)
    const first = new TestSocket()
    const second = new TestSocket()
    http.emit('upgrade', request(), first, Buffer.alloc(0))
    http.emit('upgrade', request(), second, Buffer.alloc(0))
    expect(live.clients).toBe(2)

    // The phone-lock discontinuity on demand: the server stays up, the clients do not.
    expect(live.dropClients()).toBe(2)
    expect(live.clients).toBe(0)
    expect(first.destroyed).toBe(true)
    expect(second.destroyed).toBe(true)
    expect(live.dropClients()).toBe(0)

    const back = new TestSocket()
    http.emit('upgrade', request(), back, Buffer.alloc(0))
    expect(live.clients).toBe(1)
    expect(back.writes[0].toString()).toContain('101 Switching Protocols')
    // The immediate first frame, so a reconnecting browser re-establishes liveness at once.
    expect(back.writes[1].toString()).toContain('"frame":3')
    live.close()
  })
})
