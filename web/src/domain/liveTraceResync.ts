import type { TelemetrySample } from './types'

/** The two live-frame fields continuity is judged on; the compact `LiveSnapshot` carries both. */
export interface LiveFrameIdentity {
  bootId?: string
  streamSeq?: number
}

/**
 * The live trace is the ROASTER's recording, read back whenever this browser has provably missed
 * some of it.
 *
 * Locking a phone mid-roast and unlocking it must not leave a gap in the live chart: the data is
 * logged on the roaster, not the browser, and the browser syncs to get every point it missed.
 *
 * The data IS logged on the roaster - the 1 Hz thermal recording, served as a consistent prefix by
 * `/thermal.csv` while capture is in progress - and a browser that JOINS a roast already reads it
 * (the hydration effects in `App.tsx`). Joining is not enough on its own: a browser that was already
 * watching, then slept, keeps its session-keyed trace and simply resumes appending after the hole.
 * Hydration is keyed to the session, so it never runs again.
 *
 * So: on any DISCONTINUITY of the live stream for the same session, re-read the recording prefix
 * and merge it in by device second. Four things count as a discontinuity, and each is cheap to
 * detect where it happens:
 *
 *   - the WebSocket reconnecting after it had been up (`stream-reconnect`);
 *   - the page becoming visible again, or being restored from the back-forward cache
 *     (`page-resume`) - the phone-lock case, which on iOS suspends the tab entirely;
 *   - a hole in the live envelope's per-boot sequence wider than a few frames (`sequence-gap`);
 *   - and the one that catches everything else, including a browser on the HTTP fallback poll: two
 *     consecutively ACCEPTED samples further apart on the roaster's clock than its 1 Hz cadence
 *     allows (`sample-gap`).
 *
 * The re-read is bounded: one in flight, never more often than `RESYNC_MIN_INTERVAL_MS`, requests
 * during flight coalesced into one follow-up, and a doubling spacing after EVERY read - success or
 * failure - for as long as discontinuities keep arriving within one roast session. A flaky link
 * that reconnects every few seconds would otherwise re-read the whole recording each time, as it
 * would if each successful read reset the spacing to its floor. The spacing returns to the floor only
 * when the session changes or the stream has been quiet for `RESYNC_QUIET_RESET_MS`. The HTTP layer's own
 * `503 + Retry-After` handling (`fetchWithBusyRetry`) sits underneath and is not repeated here.
 *
 * TIME BASE. Browser-collected samples are stamped with `roast_elapsed_s`, the roaster's integer
 * roast clock. The recording's `t_ms` runs from the thermal log's own start, which the firmware
 * stamps a few hundred milliseconds BEFORE the roast clock starts (the plan-only archive is written
 * between the two); the importer rebases the CSV onto its first sample, so both series are whole
 * roaster seconds and the merge keys on the whole second. The roaster's sample wins any second it
 * covers, so after a resync the covered range is the recording verbatim and only the seconds it has
 * not yet served remain browser-observed.
 */

/** Consecutive accepted samples further apart than the roaster's 1 Hz cadence tolerates. */
export const LIVE_SAMPLE_GAP_SEC = 3
/** Live envelope frames missed in a row before the hole is worth a re-read. */
export const LIVE_SEQUENCE_GAP_FRAMES = 3
export const RESYNC_MIN_INTERVAL_MS = 2_000
export const RESYNC_MAX_BACKOFF_MS = 15_000
/** A stream this long without a discontinuity has recovered; the next one starts at the floor again. */
export const RESYNC_QUIET_RESET_MS = 60_000
/** The browser keeps at most forty minutes of display-only telemetry, as the collectors do. */
const TRACE_CAP = 2400

export type LiveDiscontinuity = 'stream-reconnect' | 'page-resume' | 'sequence-gap' | 'sample-gap'

export const liveSampleGap = (previousElapsedSec: number | undefined, nextElapsedSec: number): boolean =>
  previousElapsedSec !== undefined && nextElapsedSec - previousElapsedSec > LIVE_SAMPLE_GAP_SEC

/** A same-boot hole in the stream sequence. A reboot or a backward frame is continuity's business, not this. */
export const liveSequenceGap = (previous: LiveFrameIdentity | undefined, next: LiveFrameIdentity): boolean => {
  if (!previous?.bootId || previous.streamSeq === undefined || !next.bootId || next.streamSeq === undefined)
    return false
  if (previous.bootId !== next.bootId) return false
  const delta = (next.streamSeq - previous.streamSeq) >>> 0
  return delta > LIVE_SEQUENCE_GAP_FRAMES && delta <= 0x7fff_ffff
}

/**
 * Merge a recording prefix into the trace by roaster second: the roaster wins every second it
 * covers, browser-only seconds survive, the result is sorted and bounded. Idempotent - merging the
 * same prefix twice is the same trace - and monotonic in elapsed time by construction.
 */
export const mergeRecordingPrefix = (device: TelemetrySample[], current: TelemetrySample[]): TelemetrySample[] => {
  const bySecond = new Map<number, TelemetrySample>()
  // The roaster second, with a hair of tolerance so a floating-point 1.9999999999999998 is second 2.
  const second = (sample: TelemetrySample) => Math.max(0, Math.floor(sample.elapsedSec + 1e-6))
  for (const sample of current) bySecond.set(second(sample), sample)
  for (const sample of device) bySecond.set(second(sample), sample)
  return [...bySecond.values()].sort((left, right) => left.elapsedSec - right.elapsedSec).slice(-TRACE_CAP)
}

export interface RecordingResyncOptions {
  /**
   * Read the recording prefix. `undefined` means there is nothing to sync right now (no live
   * recording on the roaster); an empty array means the read produced nothing usable and is
   * retried with backoff on the next discontinuity. Throwing is a failed read.
   */
  read: (reason: LiveDiscontinuity) => Promise<TelemetrySample[] | undefined>
  apply: (samples: TelemetrySample[], reason: LiveDiscontinuity) => void
  /**
   * The roast session the stream is currently for. A different key than the last request's resets
   * the spacing: consecutive discontinuities only compound within one session.
   */
  session?: () => string | undefined
  minIntervalMs?: number
  maxBackoffMs?: number
  /** Quiet period (no discontinuity requested) after which the spacing resets to the floor. */
  quietResetMs?: number
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** The bounded re-read: one in flight, a minimum spacing, coalesced follow-ups, growing backoff per session. */
export class RecordingResync {
  private readonly minIntervalMs: number
  private readonly maxBackoffMs: number
  private readonly quietResetMs: number
  private readonly now: () => number
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private inFlight = false
  private pending?: LiveDiscontinuity
  private timer?: unknown
  private lastStartedMs = Number.NEGATIVE_INFINITY
  private spacingMs: number
  private lastRequestMs = Number.NEGATIVE_INFINITY
  private sessionKey: string | undefined
  private disposed = false
  /** How many reads have been started. Diagnostics and tests; never a control input. */
  reads = 0

  constructor(private readonly options: RecordingResyncOptions) {
    this.minIntervalMs = options.minIntervalMs ?? RESYNC_MIN_INTERVAL_MS
    this.maxBackoffMs = options.maxBackoffMs ?? RESYNC_MAX_BACKOFF_MS
    this.quietResetMs = options.quietResetMs ?? RESYNC_QUIET_RESET_MS
    this.spacingMs = this.minIntervalMs
    this.now = options.now ?? (() => Date.now())
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  get busy(): boolean {
    return this.inFlight
  }

  /** The current spacing between reads. Diagnostics and tests; never a control input. */
  get spacing(): number {
    return this.spacingMs
  }

  request(reason: LiveDiscontinuity): void {
    if (this.disposed) return
    const nowMs = this.now()
    const session = this.options.session?.()
    if (session !== this.sessionKey || nowMs - this.lastRequestMs >= this.quietResetMs) {
      // A new session, or a stream that has been healthy for a while: start again at the floor.
      this.sessionKey = session
      this.spacingMs = this.minIntervalMs
      if (this.timer === undefined && !this.inFlight) this.lastStartedMs = Number.NEGATIVE_INFINITY
    }
    this.lastRequestMs = nowMs
    if (this.inFlight) {
      this.pending = reason
      return
    }
    if (this.timer !== undefined) return
    const waitMs = Math.max(0, this.lastStartedMs + this.spacingMs - nowMs)
    if (waitMs === 0) {
      void this.run(reason)
      return
    }
    this.timer = this.setTimer(() => {
      this.timer = undefined
      void this.run(reason)
    }, waitMs)
  }

  dispose(): void {
    this.disposed = true
    this.pending = undefined
    if (this.timer !== undefined) this.clearTimer(this.timer)
    this.timer = undefined
  }

  private async run(reason: LiveDiscontinuity): Promise<void> {
    this.inFlight = true
    this.lastStartedMs = this.now()
    this.reads += 1
    try {
      const samples = await this.options.read(reason)
      if (this.disposed) return
      // An empty read produced nothing usable; like a failure it is simply spaced out.
      if (samples !== undefined && samples.length > 0) this.options.apply(samples, reason)
    } catch {
      // A failed read is spaced out like any other; the next discontinuity asks again.
    } finally {
      this.inFlight = false
      // Success does NOT reset the spacing: a success followed by another discontinuity is exactly
      // the flaky-link pattern. `request` resets it on a new session or after a quiet period.
      this.spacingMs = Math.min(this.maxBackoffMs, this.spacingMs * 2)
      const followUp = this.pending
      this.pending = undefined
      if (followUp !== undefined && !this.disposed) this.request(followUp)
    }
  }
}
