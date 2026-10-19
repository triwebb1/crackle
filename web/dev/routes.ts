/**
 * The HTTP surface, and nothing but the HTTP surface.
 *
 * Exactly the routes `src/controller/fetchSurface.test.ts` allows the app to call, plus the two
 * parameterised ones (`/logs/<id>.csv` is the app's; `/api/logs/format` is the firmware's own and is
 * served for completeness). The mock adds no endpoint the app does not already have a reason to
 * call: it exists to answer the contract, not to grow one.
 *
 * Command arguments arrive in the query string. Document writes use raw JSON; recording restore
 * uses one size-capped `application/octet-stream` body, matching the native storage worker.
 *
 * Anything not matched here is handed back to Vite, so the app itself is still served normally.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { logCsv } from './archive'
import { CONFIRM } from './config'
import { encodeArchiveFile } from './crkFile'
import type { MockDevice } from './device'
import { liveDocument, logIndexDocument, statusDocument } from './documents'

type Handler = (device: MockDevice, args: URLSearchParams) => { status: number; body: unknown }

const readBodyBytes = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

const readBody = async (request: IncomingMessage): Promise<string> => (await readBodyBytes(request)).toString('utf8')

const send = (response: ServerResponse, status: number, contentType: string, body: string) => {
  response.statusCode = status
  response.setHeader('content-type', contentType)
  response.setHeader('cache-control', 'no-store')
  response.end(body)
}

const sendJson = (response: ServerResponse, status: number, body: unknown) =>
  send(response, status, 'application/json', JSON.stringify(body))

/**
 * `GET /logs/<id>.csv` and `GET /logs/<id>.crk` - one route, two representations.
 *
 * The SUFFIX picks: `.csv` decodes the recording into rows, `.crk` hands back the stored file byte
 * for byte and interprets NOTHING - not the header, not the version, and not the checksum the CSV
 * route refuses to serve without. A backup's whole job is to hand back what is on the volume, and a
 * route that answered 500 on a damaged recording would make it unrecoverable in the name of not
 * serving it damaged.
 */
const LOG_FILE = /^\/logs\/([^/]+)\.(csv|crk)$/
/** `/api/data/<collection>`, `/api/data/runs` and `/api/data/runs/<id>` - one prefix, three shapes. */
const DATA_PREFIX = '/api/data/'
const DATA_DELETE = '/api/data/delete'

const decodePathSegment = (value: string): string | undefined => {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

const malformedPath = (response: ServerResponse) => {
  sendJson(response, 400, { ok: false, message: 'The URL contains an invalid percent escape.' })
}

/**
 * A document verdict, on the wire.
 *
 * A successful read answers with the PAYLOAD as its body and the version in `X-Doc-Version`;
 * everything else is JSON in the usual `{"ok":...}` style. A 500 from a corrupted envelope still
 * carries `X-Doc-Version: 0`, because 0 is the base a recovering write has to use.
 */
const sendVerdict = (
  response: ServerResponse,
  verdict: { status: number; body?: unknown; payload?: string; version?: number },
) => {
  if (verdict.version !== undefined) response.setHeader('x-doc-version', String(verdict.version))
  if (verdict.payload !== undefined) {
    send(response, verdict.status, 'application/json', verdict.payload)
    return
  }
  sendJson(response, verdict.status, verdict.body ?? { ok: verdict.status < 400 })
}

export interface RouterOptions {
  /**
   * The port the live WebSocket is reachable on, or undefined when it is not served. A callback
   * because the dev server's port is not known until it is listening, which is after this is built.
   */
  websocketPort?: () => number | undefined
  /** Current subscribers, reported by diagnostics just as the firmware reports its live clients. */
  websocketClients?: () => number
}

export const createRouter = (device: MockDevice, options: RouterOptions = {}) => {
  const commands: Record<string, Handler> = {
    '/api/stop': (target) => target.stopAll(),
    '/api/manual/set': (target, args) => target.startManual(args),
    '/api/manual/stop': (target) => target.stopManual(),
    '/api/calibration/start': (target, args) => target.startCalibration(args),
    '/api/calibration/stop': (target) => target.stopCalibration(),
    '/api/calibration/apply': (target, args) => target.applyCalibration(args),
    '/api/roast/start': (target, args) => target.startRoast(args),
    '/api/roast/set': (target, args) => target.setRoast(args),
    '/api/roast/stop': (target, args) => target.stopRoast(args),
    '/api/roast/active-plan': (target, args) => target.patchRoastPlan(args),
    '/api/restore/begin': (target, args) => target.beginRestore(args),
    '/api/restore/commit': (target, args) => target.commitRestore(args),
    '/api/restore/abort': (target, args) => target.abortRestore(args),
    '/api/settings/thermocouple-offset': (target, args) => target.setThermocoupleOffset(args),
    '/api/logs/delete': (target, args) => target.deleteLog(args),
  }

  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? '/', 'http://mock.local')
    const path = url.pathname
    const method = (request.method ?? 'GET').toUpperCase()

    if (method === 'GET') {
      if (path === '/api/status') {
        sendJson(response, 200, statusDocument(device, options.websocketPort?.(), options.websocketClients?.() ?? 0))
        return true
      }
      if (path === '/api/live') {
        sendJson(response, 200, liveDocument(device))
        return true
      }
      if (path === '/api/roast/active-plan') {
        const outcome = device.activeRoastPlan()
        sendJson(response, outcome.status, outcome.body)
        return true
      }
      if (path === '/api/logs') {
        if (!device.data.mounted) {
          sendJson(response, 503, { ok: false, message: 'Log storage is not mounted.' })
          return true
        }
        // The firmware's storage worker answers list reads with `503 + Retry-After` while the
        // settle-time write burst holds it; without the header this would read as unmounted.
        if (device.archiveListBusy()) {
          response.setHeader('Retry-After', '1')
          sendJson(response, 503, {
            ok: false,
            message: 'The roaster is busy saving the latest recording. Retry shortly.',
          })
          return true
        }
        sendJson(response, 200, logIndexDocument(device))
        return true
      }
      if (path === '/thermal.csv') {
        // Read-only RAM snapshot, available while a recording is open so a reload can hydrate the
        // trace already captured.
        send(response, 200, 'text/csv', device.archive.currentCsv)
        return true
      }
      if (path === '/api/data/manifest') {
        const outcome = device.manifestPage(url.searchParams.get('cursor'))
        sendJson(response, outcome.status, outcome.body)
        return true
      }
      if (path.startsWith(DATA_PREFIX)) {
        const target = decodePathSegment(path.slice(DATA_PREFIX.length))
        if (target === undefined) {
          malformedPath(response)
          return true
        }
        sendVerdict(response, target === 'runs' ? device.listRunData() : device.readData(target))
        return true
      }
      const fileMatch = LOG_FILE.exec(path)
      if (fileMatch) {
        const id = decodePathSegment(fileMatch[1])
        if (id === undefined) {
          malformedPath(response)
          return true
        }
        const log = device.archive.find(id)
        if (!log) {
          sendJson(response, 404, { ok: false, message: 'No stored recording with that id' })
          return true
        }
        if (fileMatch[2] === 'crk') {
          const file = Buffer.from(encodeArchiveFile(log))
          response.statusCode = 200
          response.setHeader('content-type', 'application/octet-stream')
          response.setHeader('content-disposition', `attachment; filename=crackle-log-${log.id}.crk`)
          response.setHeader('content-length', String(file.length))
          response.setHeader('cache-control', 'no-store')
          response.end(file)
          return true
        }
        send(response, 200, 'text/csv', logCsv(log.samples))
        return true
      }
      return false
    }

    if (method !== 'POST') return false

    if (path === DATA_DELETE) {
      sendVerdict(response, device.deleteData(url.searchParams))
      return true
    }
    if (path.startsWith(DATA_PREFIX)) {
      /*
       * The body is the document, byte for byte, and it is read RAW. The firmware takes it from
       * by the native storage worker, matching the device byte for byte.
       */
      const target = decodePathSegment(path.slice(DATA_PREFIX.length))
      if (target === undefined) {
        malformedPath(response)
        return true
      }
      const body = await readBody(request)
      sendVerdict(
        response,
        device.writeData(target, body, url.searchParams.get('base'), url.searchParams.get('restore_token')),
      )
      return true
    }

    /* The firmware streams this raw archive body to a temporary file; query args remain visible. */
    if (path === '/api/logs/restore') {
      const contentType = request.headers['content-type'] ?? ''
      if (!/^application\/octet-stream(?:\s*;.*)?$/i.test(contentType)) {
        sendJson(response, 415, {
          ok: false,
          check: 'upload',
          message: 'Content-Type must be application/octet-stream',
        })
        return true
      }
      // Firmware can check query args at UPLOAD_FILE_START, before it examines the file field.
      // The mock still buffers the file rather than streaming its chunks, so size-vs-idle ordering
      // remains inherently different; confirmation and identity need not be.
      if (url.searchParams.get('confirm') !== CONFIRM.restoreLog) {
        sendJson(response, 409, { ok: false, message: 'confirm=RESTORE_LOG is required' })
        return true
      }
      const id = url.searchParams.get('id') ?? ''
      if (id !== 'auto' && (!/^[1-9][0-9]*$/.test(id) || Number(id) >= 0xffffffff)) {
        sendJson(response, 400, {
          ok: false,
          check: 'id',
          message: "id must be 'auto' or a positive decimal recording id below 4294967295",
        })
        return true
      }
      const recording = await readBodyBytes(request)
      const outcome = device.restoreLog(url.searchParams, Uint8Array.from(recording))
      sendJson(response, outcome.status, outcome.body)
      return true
    }

    const handler = commands[path]
    if (path === '/api/logs/format') {
      if (url.searchParams.get('confirm') !== CONFIRM.formatLogs) {
        sendJson(response, 409, { ok: false, message: 'confirm=FORMAT_LOGS is required' })
        return true
      }
      // It is the same volume, so formatting takes the document store with it. Saying so out loud
      // is the difference between "my recordings are gone" and "my whole library is gone".
      const maintenance = device.restoreStatus()
      const restoreWrite = device.restoreTokenAccepted(url.searchParams)
      if ((maintenance.active || maintenance.incomplete) && !restoreWrite) {
        sendJson(response, 423, { ok: false, message: 'A matching restore_token is required' })
        return true
      }
      const idle = device.storageWriteRefusal()
      if (idle) {
        sendJson(response, idle.status, { ok: false, message: idle.message })
        return true
      }
      if (restoreWrite) device.markRestoreDirty()
      device.archive.logs = []
      // The id counter starts again, which is exactly why a restore has to lift it back: without
      // the bump, the next roast would be written over restored recording #1.
      device.archive.nextLogId = 1
      device.archive.lastIssuedLogId = 0
      device.data.documents.clear()
      // `/logs` and `/data` share one volume. A successful format mounts that volume and clears
      // the `needs_format` state reported by both status blocks.
      device.data.mounted = true
      device.dirty = true
      const stateRev = restoreWrite ? device.stateRev : device.bumpStateRevision()
      sendJson(response, 200, { ok: true, mounted: true, data_store_erased: true, state_rev: stateRev })
      return true
    }
    if (!handler) return false

    // Query args are what the client sends; a form-encoded body is accepted for hand testing.
    const args = url.searchParams
    const contentType = request.headers['content-type'] ?? ''
    if (contentType.includes('application/x-www-form-urlencoded')) {
      for (const [key, value] of new URLSearchParams(await readBody(request))) args.set(key, value)
    }

    const outcome = handler(device, args)
    sendJson(response, outcome.status, outcome.body)
    return true
  }
}
