/**
 * ============================================================================================
 * THE MOCK DOCUMENT STORE - `/data`, exactly as the firmware answers it
 * ============================================================================================
 *
 * The firmware's own store is a pure layer (`sr800_doc_store.{h,cpp}`) with the `.ino` acting as a
 * switch over its verdict, and this is deliberately built the same way: everything below is a pure
 * function of (stored documents, request), with no `IncomingMessage`, no device, and no clock. That
 * is what lets `dataStore.test.ts` drive the whole contract - conflict, idle gate, caps, id rules,
 * the volume floor - without an HTTP server.
 *
 * **The store never parses a payload.** It owns identity, concurrency and capacity; every byte after
 * the envelope round-trips verbatim. A mock that validated JSON would be a mock that passes requests
 * the real device refuses, and vice versa, which is the exact failure a mock exists to prevent.
 *
 * The one thing not simulated is the 16-byte binary envelope itself: the payload is held as a
 * string and the envelope is accounted for as 16 bytes of overhead wherever capacity is counted.
 * The envelope's byte layout is the firmware's own host test (`doc_store_test.cpp`); what the
 * BROWSER can observe is the version, the payload and the status code, and those are exact here.
 */

/** Exactly these four, lower case, case sensitive. Anything else is a 400. */
export const DATA_COLLECTIONS = ['profiles', 'beans', 'calibrations', 'meta'] as const
export type DataCollection = (typeof DATA_COLLECTIONS)[number]

export const ENVELOPE_BYTES = 16
export const COLLECTION_CAP_BYTES = 12 * 1024
export const RUN_CAP_BYTES = 8 * 1024
/**
 * The archive's working reserve - `sr800::volume::kLogArchiveReserveBytes`. Retention sweeps until
 * this much would still be free after the incoming recording lands.
 */
export const LOG_ARCHIVE_RESERVE_BYTES = 96 * 1024

/**
 * The largest file a single persist can produce, derived exactly as `sr800_volume_budget.h` does:
 * a 220-byte v4 archive header, a bounded 1,024-byte plan envelope, plus one encoded frame per
 * sample the RAM log can hold at the codec's declared five-channel ceiling.
 * 220 + 1,024 + 4800 x 25 = 121,244.
 */
export const MAX_INCOMING_LOG_BYTES = 220 + 4800 * 25 + 1024

/**
 * Any write that would leave the VOLUME with less than this free is refused with 507.
 *
 * DERIVED, not chosen - `kDocumentWriteFloorBytes == kLogArchiveReserveBytes + kMaxIncomingLogBytes`
 * = 219,548. The mock enforced a flat 64 KB while the firmware had already moved to the derivation,
 * and a mock whose semantics differ from the device does not fail to catch a bug, it certifies one:
 * the app was reading a 64 KB floor and subtracting the 96 KB reserve a second time on top of it.
 */
export const VOLUME_FLOOR_BYTES = LOG_ARCHIVE_RESERVE_BYTES + MAX_INCOMING_LOG_BYTES
export const MAX_LISTED_RUNS = 400
export const DELETE_DATA_CONFIRM = 'DELETE_DATA'
export const BUSY_MESSAGE = 'Document storage waits until actuation finishes.'
export const RECORDING_BUSY_MESSAGE = 'Document storage waits for the current thermal recording to finish.'
export const ARCHIVE_BLOCKED_MESSAGE =
  'The pending thermal recording could not be saved, so the document write was not attempted.'

export interface StoredDocument {
  version: number
  payload: string
  /** A file whose envelope will not decode. Reads 500 at version 0, and `base=0` overwrites it. */
  corrupt?: boolean
}

/** What a handler answers with. `payload` is a raw body; `body` is JSON. Never both. */
export interface StoreVerdict {
  status: number
  body?: Record<string, unknown>
  payload?: string
  version?: number
}

export const isDataCollection = (name: string): name is DataCollection =>
  (DATA_COLLECTIONS as readonly string[]).includes(name)

/**
 * A run id is a PATH SEGMENT, so it is validated rather than looked up: 1-24 characters of
 * `[A-Za-z0-9._-]`, and never all dots (which would address a directory).
 */
export const isRunId = (id: string) => /^[A-Za-z0-9._-]{1,24}$/.test(id) && !/^\.+$/.test(id)

/**
 * `base` is a strict unsigned decimal. No sign, no whitespace, no `0x`, nothing above 2^32-1 - and
 * a malformed one is a 400 rather than being silently read as 0, because reading it as 0 would turn
 * "update this document" into "create it, and only if it does not exist".
 */
export const parseBase = (raw: string | null | undefined): number | undefined => {
  if (typeof raw !== 'string' || !/^[0-9]{1,10}$/.test(raw)) return undefined
  const value = Number(raw)
  return value <= 4294967295 ? value : undefined
}

/** `profiles` or `runs/<id>`, resolved to a storage key and the cap that applies to it. */
export const parseTarget = (target: string): { key: string; cap: number } | undefined => {
  if (isDataCollection(target)) return { key: target, cap: COLLECTION_CAP_BYTES }
  const run = /^runs\/(.+)$/.exec(target)
  if (run && isRunId(run[1])) return { key: `runs/${run[1]}`, cap: RUN_CAP_BYTES }
  return undefined
}

const payloadBytes = (payload: string) => Buffer.byteLength(payload, 'utf8')

const refuse = (status: number, message: string): StoreVerdict => ({ status, body: { ok: false, message } })

export class DocumentStore {
  /** False puts the whole volume in `needs_format`, where even READS answer 503. */
  mounted = true
  documents = new Map<string, StoredDocument>()

  restore(entries: Array<[string, StoredDocument]> | undefined) {
    if (Array.isArray(entries)) this.documents = new Map(entries)
  }

  snapshot(): Array<[string, StoredDocument]> {
    return [...this.documents.entries()]
  }

  /** On-disk footprint of the whole tree: every payload plus its envelope. */
  usedBytes() {
    let total = 0
    for (const document of this.documents.values()) total += ENVELOPE_BYTES + payloadBytes(document.payload)
    return total
  }

  read(target: string): StoreVerdict {
    if (!this.mounted) return refuse(503, 'Document storage is not mounted')
    const resolved = parseTarget(target)
    if (!resolved) return refuse(400, 'Unknown document')
    const document = this.documents.get(resolved.key)
    if (!document) return refuse(404, 'No document stored there')
    // An unreadable envelope is never reported as "empty": empty is a document, this is damage.
    if (document.corrupt)
      return { status: 500, version: 0, body: { ok: false, message: 'The stored document could not be read' } }
    return { status: 200, payload: document.payload, version: document.version }
  }

  /**
   * The write decision, in the firmware's own order:
   * mounted, identity, base parse, **idle/archive gate**, size cap, version match, volume floor, write.
   *
   * Argument validation runs before the gate. Once the target and base are valid, archive evidence
   * wins over request size: production persists a closed recording before materializing the POST
   * body, and refuses an active or unsavable recording before it can answer 413.
   */
  write(
    target: string,
    payload: string,
    baseRaw: string | null | undefined,
    options: {
      idle: boolean
      archiveState?: 'ready' | 'recording' | 'blocked'
      otherUsedBytes: number
      volumeTotalBytes: number
    },
  ): StoreVerdict {
    if (!this.mounted) return refuse(503, 'Document storage is not mounted')
    const resolved = parseTarget(target)
    if (!resolved) return refuse(400, 'Unknown document')
    const base = parseBase(baseRaw)
    if (base === undefined) return refuse(400, 'base must be an unsigned decimal version')
    if (!options.idle) return refuse(409, BUSY_MESSAGE)
    if (options.archiveState === 'recording') return refuse(409, RECORDING_BUSY_MESSAGE)
    if (options.archiveState === 'blocked') return refuse(503, ARCHIVE_BLOCKED_MESSAGE)
    const bytes = payloadBytes(payload)
    if (bytes > resolved.cap) return refuse(413, `That document is ${bytes} bytes; the limit is ${resolved.cap}`)

    const existing = this.documents.get(resolved.key)
    const current = existing === undefined || existing.corrupt === true ? 0 : existing.version
    if (base !== current) return { status: 409, body: { ok: false, conflict: true, version: current } }

    /*
     * The floor is checked against used + THE WHOLE NEW FILE, not against the delta. A write lands
     * in `/data/pending.tmp` and is renamed over the previous document, so both exist at once for
     * an instant and the peak is what has to fit.
     */
    const projected = options.otherUsedBytes + this.usedBytes() + ENVELOPE_BYTES + bytes
    if (options.volumeTotalBytes - projected < VOLUME_FLOOR_BYTES) {
      return refuse(507, `Storing that would leave less than ${VOLUME_FLOOR_BYTES} bytes free on the volume`)
    }

    const version = current + 1
    this.documents.set(resolved.key, { version, payload })
    return { status: 200, body: { ok: true, version } }
  }

  /** Deleting RESETS the version history: a later `base=0` create succeeds and starts again at 1. */
  remove(
    target: string,
    confirm: string | null | undefined,
    baseRaw: string | null | undefined,
    idle: boolean,
  ): StoreVerdict {
    if (confirm !== DELETE_DATA_CONFIRM) return refuse(409, `confirm=${DELETE_DATA_CONFIRM} is required`)
    if (!this.mounted) return refuse(503, 'Document storage is not mounted')
    const resolved = parseTarget(target)
    if (!resolved) return refuse(400, 'Unknown document')
    const base = parseBase(baseRaw)
    if (base === undefined) return refuse(400, 'base must be an unsigned decimal version')
    if (!idle) return refuse(409, BUSY_MESSAGE)

    const existing = this.documents.get(resolved.key)
    const current = existing === undefined || existing.corrupt === true ? 0 : existing.version
    if (base !== current) return { status: 409, body: { ok: false, conflict: true, version: current } }
    if (!this.documents.delete(resolved.key)) return refuse(404, 'No document stored there')
    return { status: 200, body: { ok: true, deleted: target, version: 0 } }
  }

  /** Envelopes only: the index never opens a payload. `bytes` is the PAYLOAD length. */
  listRuns(): StoreVerdict {
    if (!this.mounted) return refuse(503, 'Document storage is not mounted')
    const runs = [...this.documents.entries()]
      .flatMap(([key, document]) =>
        key.startsWith('runs/') && !document.corrupt
          ? [{ id: key.slice('runs/'.length), bytes: payloadBytes(document.payload), version: document.version }]
          : [],
      )
      .sort((a, b) => a.id.localeCompare(b.id))
    const total = runs.length
    const listed = runs.slice(0, MAX_LISTED_RUNS)
    return { status: 200, body: { ok: true, runs: listed, total, truncated: total > listed.length } }
  }

  /**
   * The `data_store` block. Emitted even when the volume is not mounted, because its PRESENCE is
   * the client's feature detection and a store that vanished from status would read as "this
   * firmware has no store" rather than "this store is unavailable right now".
   *
   * A collection that has never been written is OMITTED, which is the same fact as its GET
   * answering 404. `used_bytes` is a capacity number; every per-document `bytes` is a payload length.
   */
  statusBlock(volumeTotalBytes: number, otherUsedBytes: number) {
    const collections: Record<string, { bytes: number; version: number }> = {}
    let runCount = 0
    let runBytes = 0
    for (const [key, document] of this.documents) {
      if (key.startsWith('runs/')) {
        runCount += 1
        runBytes += payloadBytes(document.payload)
      } else {
        collections[key] = { bytes: payloadBytes(document.payload), version: document.version }
      }
    }
    const used = this.usedBytes()
    return {
      mounted: this.mounted,
      used_bytes: this.mounted ? used : 0,
      total_bytes: this.mounted ? volumeTotalBytes : 0,
      free_bytes: this.mounted ? Math.max(0, volumeTotalBytes - otherUsedBytes - used) : 0,
      // The 507 threshold, emitted exactly as crackle.ino emits it - unconditionally, and whether
      // or not the volume is mounted, because it is a property of the build rather than of the
      // volume. `free_bytes` alone does not say where the line is.
      write_floor_bytes: VOLUME_FLOOR_BYTES,
      collections: this.mounted ? collections : {},
      runs: { count: this.mounted ? runCount : 0, bytes: this.mounted ? runBytes : 0 },
    }
  }
}
