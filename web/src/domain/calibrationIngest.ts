/**
 * The self-contained baseline flow. A calibration pass is only half a measurement: the thermal-loss
 * coefficient comes from the free passive decay after the fan stops, so the log has to be fetched
 * some minutes AFTER the actuator returns to idle, not the moment the program ends. Left to the
 * operator, that delay is easy to forget, and forgetting it silently costs the loss fit.
 *
 * This is the state machine that does it instead. It is driven entirely by the status poll and one
 * clock, holds no effects of its own, and is therefore testable as a pure reducer.
 *
 *   running -> waiting-tail -> fetching -> stored
 *
 * `waiting-tail` observes the passive fan-off measurement tail. Skip collapses it into `fetching`
 * immediately, and the analysis then degrades exactly as it already does
 * without a tail. A 409 means the controller is still running a program, so `fetching` retries with
 * backoff rather than failing.
 */
export type IngestPhase = 'idle' | 'running' | 'waiting-tail' | 'fetching' | 'stored' | 'failed'

export interface IngestState {
  phase: IngestPhase
  endReason?: string
  // Wall clock at which the decay tail is considered captured.
  tailUntilMs?: number
  // Wall clock at or after which the next fetch attempt may be made.
  nextAttemptMs?: number
  attempts: number
  message?: string
}

export type IngestEvent =
  | { type: 'status'; active: boolean; logActive?: boolean; endReason?: string; nowMs: number }
  | { type: 'tick'; nowMs: number }
  | { type: 'skip'; nowMs: number }
  | { type: 'stored'; message: string }
  | { type: 'failed'; retryable: boolean; message: string; nowMs: number }
  | { type: 'dismiss' }

// Three minutes of passive decay after the actuator idles is enough to fit the loss coefficient.
export const DEFAULT_TAIL_SECONDS = 180
export const MAXIMUM_ATTEMPTS = 6

export const initialIngestState: IngestState = { phase: 'idle', attempts: 0 }

// 2 s, 4 s, 8 s, 16 s, then 30 s: enough backoff for a busy archive without making a transient
// controller delay feel like a failed automatic capture.
export const retryDelayMs = (attempts: number) => Math.min(30000, 2000 * 2 ** Math.max(0, attempts - 1))

const beginFetch = (state: IngestState): IngestState => ({
  ...state,
  phase: 'fetching',
  attempts: 0,
  nextAttemptMs: undefined,
  message: undefined,
})

export const ingestReducer = (
  state: IngestState,
  event: IngestEvent,
  tailSeconds = DEFAULT_TAIL_SECONDS,
): IngestState => {
  switch (event.type) {
    case 'status': {
      // A program starting always wins: it supersedes whatever the previous pass was doing, and a
      // new program restarts the controller's log, so any pending capture is moot.
      if (event.active) return { phase: 'running', attempts: 0 }
      const beginTail = (ended: IngestState): IngestState => {
        if (event.logActive === false) return beginFetch(ended)
        if (event.logActive === true) return { ...ended, phase: 'waiting-tail', tailUntilMs: undefined }
        return { ...ended, phase: 'waiting-tail', tailUntilMs: event.nowMs + tailSeconds * 1000 }
      }
      if (state.phase === 'running') {
        const ended: IngestState = { phase: 'waiting-tail', endReason: event.endReason, attempts: 0 }
        return beginTail(ended)
      }
      // A cold reload during the controller-owned tail did not observe the running edge. The paired
      // terminal reason and active log identify that exact completed pass without guessing from an
      // old idle `cal_end` value.
      if (state.phase === 'idle' && event.endReason !== undefined && event.logActive === true) {
        const ended: IngestState = { phase: 'waiting-tail', endReason: event.endReason, attempts: 0 }
        return beginTail(ended)
      }
      const observed =
        state.endReason === undefined &&
        event.endReason !== undefined &&
        (state.phase === 'waiting-tail' || state.phase === 'fetching')
          ? { ...state, endReason: event.endReason }
          : state
      if (observed.phase === 'waiting-tail') {
        if (event.logActive === false) return beginFetch(observed)
        if (event.logActive === true) return { ...observed, tailUntilMs: undefined }
        if (observed.tailUntilMs !== undefined && event.nowMs >= observed.tailUntilMs) return beginFetch(observed)
      }
      return observed
    }
    case 'tick':
      if (state.phase === 'waiting-tail' && state.tailUntilMs !== undefined && event.nowMs >= state.tailUntilMs)
        return beginFetch(state)
      return state
    case 'skip':
      return state.phase === 'waiting-tail' ? beginFetch(state) : state
    case 'stored':
      return state.phase === 'fetching'
        ? { phase: 'stored', endReason: state.endReason, attempts: state.attempts, message: event.message }
        : state
    case 'failed': {
      if (state.phase !== 'fetching') return state
      const attempts = state.attempts + 1
      if (!event.retryable || attempts >= MAXIMUM_ATTEMPTS)
        return { ...state, phase: 'failed', attempts, message: event.message }
      return { ...state, attempts, nextAttemptMs: event.nowMs + retryDelayMs(attempts), message: event.message }
    }
    case 'dismiss':
      return state.phase === 'stored' || state.phase === 'failed' ? initialIngestState : state
  }
}

// Whether the view should actually issue a fetch right now, as opposed to waiting out a backoff.
export const shouldFetchNow = (state: IngestState, nowMs: number) =>
  state.phase === 'fetching' && (state.nextAttemptMs === undefined || nowMs >= state.nextAttemptMs)

export const tailRemainingSec = (state: IngestState, nowMs: number) =>
  state.phase === 'waiting-tail' && state.tailUntilMs !== undefined
    ? Math.max(0, Math.ceil((state.tailUntilMs - nowMs) / 1000))
    : undefined

export const ingestBannerText = (state: IngestState, nowMs: number): string | undefined => {
  const remaining = tailRemainingSec(state, nowMs)
  const ended =
    state.endReason === undefined
      ? 'Program ended.'
      : state.endReason === 'completed'
        ? 'Program completed.'
        : state.endReason === 'stopped'
          ? 'Program stopped.'
          : state.endReason === 'telemetry_stale'
            ? 'Program ended because temperature updates paused; Heat stopped safely.'
            : `Program ended (${state.endReason.replaceAll('_', ' ')}).`
  switch (state.phase) {
    case 'waiting-tail':
      return state.tailUntilMs === undefined
        ? `${ended} The roaster is capturing the cool-down tail for the loss fit; ingest starts when it reports the recording finalized.`
        : `${ended} Capturing cool-down tail for the loss fit: ${Math.floor((remaining ?? 0) / 60)}:${String((remaining ?? 0) % 60).padStart(2, '0')} remaining.`
    case 'fetching':
      return state.attempts > 0
        ? `Fetching the thermal log: attempt ${state.attempts + 1}, the roaster is still busy.`
        : 'Fetching the thermal log and analysing the pass.'
    case 'stored':
      return state.message
    case 'failed':
      return `The thermal log could not be captured automatically: ${state.message ?? 'the roaster did not answer'}. When it appears in Build a calibration, add that exact device recording there.`
    default:
      return undefined
  }
}
