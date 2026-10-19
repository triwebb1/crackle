import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TAIL_SECONDS,
  type IngestEvent,
  type IngestState,
  ingestBannerText,
  ingestReducer,
  initialIngestState,
  MAXIMUM_ATTEMPTS,
  retryDelayMs,
  shouldFetchNow,
  tailRemainingSec,
} from './calibrationIngest'

const NOW = 1_800_000_000_000

const run = (events: IngestEvent[], from: IngestState = initialIngestState, tailSeconds?: number) =>
  events.reduce((state, event) => ingestReducer(state, event, tailSeconds), from)

const poll = (overrides: Partial<Extract<IngestEvent, { type: 'status' }>> = {}): IngestEvent => ({
  type: 'status',
  active: false,
  nowMs: NOW,
  ...overrides,
})

describe('calibration auto-ingest state machine', () => {
  it('walks running -> waiting-tail -> fetching -> stored with no clicks', () => {
    const running = run([poll({ active: true })])
    expect(running.phase).toBe('running')

    const waiting = ingestReducer(running, poll({ endReason: 'completed' }))
    expect(waiting).toMatchObject({ phase: 'waiting-tail', endReason: 'completed' })
    expect(waiting.tailUntilMs).toBe(NOW + DEFAULT_TAIL_SECONDS * 1000)
    expect(tailRemainingSec(waiting, NOW)).toBe(DEFAULT_TAIL_SECONDS)
    expect(shouldFetchNow(waiting, NOW)).toBe(false)

    const early = ingestReducer(waiting, { type: 'tick', nowMs: waiting.tailUntilMs! - 1000 })
    expect(early.phase).toBe('waiting-tail')
    const fetching = ingestReducer(waiting, { type: 'tick', nowMs: waiting.tailUntilMs! })
    expect(fetching.phase).toBe('fetching')
    expect(shouldFetchNow(fetching, waiting.tailUntilMs!)).toBe(true)

    const stored = ingestReducer(fetching, { type: 'stored', message: 'stored 900 samples' })
    expect(stored).toMatchObject({ phase: 'stored', message: 'stored 900 samples', endReason: 'completed' })
    expect(ingestReducer(stored, { type: 'dismiss' })).toEqual(initialIngestState)
  })

  it('waits for the authoritative active log and fetches exactly on its finalized edge', () => {
    const running = run([poll({ active: true, logActive: true })])
    const tail = ingestReducer(running, poll({ endReason: 'completed', logActive: true }))
    expect(tail).toMatchObject({ phase: 'waiting-tail', endReason: 'completed' })
    expect(tail.tailUntilMs).toBeUndefined()
    expect(ingestReducer(tail, { type: 'tick', nowMs: NOW + 600000 })).toBe(tail)
    const fetching = ingestReducer(tail, poll({ endReason: 'completed', logActive: false, nowMs: NOW + 600001 }))
    expect(fetching.phase).toBe('fetching')
    expect(ingestReducer(fetching, poll({ endReason: 'completed', logActive: false, nowMs: NOW + 600002 }))).toBe(
      fetching,
    )
  })

  it('resumes a calibration tail on cold load only from paired terminal and active-log evidence', () => {
    const resumed = ingestReducer(initialIngestState, poll({ endReason: 'completed', logActive: true }))
    expect(resumed).toMatchObject({ phase: 'waiting-tail', endReason: 'completed' })
    expect(ingestReducer(initialIngestState, poll({ endReason: 'completed', logActive: false }))).toEqual(
      initialIngestState,
    )
    expect(ingestBannerText(resumed, NOW)).toContain('reports the recording finalized')
  })

  it('goes straight to the passive tail when the program ends', () => {
    const state = run([poll({ active: true }), poll({ endReason: 'stopped' })])
    expect(state).toMatchObject({
      phase: 'waiting-tail',
      endReason: 'stopped',
      tailUntilMs: NOW + DEFAULT_TAIL_SECONDS * 1000,
    })
  })

  it('accepts the controller end reason when full status follows the faster inactive event', () => {
    const waitingWithoutReason = run([poll({ active: true }), poll({})])
    expect(waitingWithoutReason).toMatchObject({ phase: 'waiting-tail', endReason: undefined })
    expect(ingestBannerText(waitingWithoutReason, NOW)).toContain('Program ended.')
    expect(ingestBannerText(waitingWithoutReason, NOW)).not.toContain('reason not reported')

    const reconciled = ingestReducer(waitingWithoutReason, poll({ endReason: 'completed', nowMs: NOW + 1000 }))
    expect(reconciled).toMatchObject({ phase: 'waiting-tail', endReason: 'completed' })
    expect(reconciled.tailUntilMs).toBe(waitingWithoutReason.tailUntilMs)
    expect(ingestBannerText(reconciled, NOW + 1000)).toContain('Program completed.')
  })

  it('explains a telemetry-stale abort without showing its wire identifier', () => {
    const interrupted = run([poll({ active: true }), poll({ endReason: 'telemetry_stale' })])
    const banner = ingestBannerText(interrupted, NOW)
    expect(banner).toContain('temperature updates paused; Heat stopped safely')
    expect(banner).not.toContain('telemetry_stale')
  })

  it('skips the passive-tail wait and ignores skip everywhere else', () => {
    const waiting = run([poll({ active: true }), poll({})])
    const skipped = ingestReducer(waiting, { type: 'skip', nowMs: NOW })
    expect(skipped.phase).toBe('fetching')
    expect(shouldFetchNow(skipped, NOW)).toBe(true)

    expect(ingestReducer(initialIngestState, { type: 'skip', nowMs: NOW }).phase).toBe('idle')
    expect(ingestReducer(run([poll({ active: true })]), { type: 'skip', nowMs: NOW }).phase).toBe('running')
  })

  it('retries a 409 with backoff and only gives up after the attempt limit', () => {
    let state = run([poll({ active: true }), poll({}), { type: 'skip', nowMs: NOW }])
    expect(state.phase).toBe('fetching')

    state = ingestReducer(state, { type: 'failed', retryable: true, message: 'still running', nowMs: NOW })
    // Still fetching, just not yet: the backoff is a wait, not a failure.
    expect(state).toMatchObject({ phase: 'fetching', attempts: 1, nextAttemptMs: NOW + retryDelayMs(1) })
    expect(shouldFetchNow(state, NOW)).toBe(false)
    expect(shouldFetchNow(state, NOW + retryDelayMs(1))).toBe(true)

    for (let attempt = 2; attempt < MAXIMUM_ATTEMPTS; attempt += 1) {
      state = ingestReducer(state, { type: 'failed', retryable: true, message: 'still running', nowMs: NOW })
      expect(state.phase).toBe('fetching')
    }
    state = ingestReducer(state, { type: 'failed', retryable: true, message: 'still running', nowMs: NOW })
    expect(state).toMatchObject({ phase: 'failed', attempts: MAXIMUM_ATTEMPTS })
    expect(ingestReducer(state, { type: 'dismiss' })).toEqual(initialIngestState)
  })

  it('gives up immediately on a failure that retrying cannot fix', () => {
    const fetching = run([poll({ active: true }), poll({}), { type: 'skip', nowMs: NOW }])
    expect(
      ingestReducer(fetching, { type: 'failed', retryable: false, message: 'HTTP 500', nowMs: NOW }),
    ).toMatchObject({ phase: 'failed', message: 'HTTP 500' })
  })

  it('backs off geometrically and then holds at half a minute', () => {
    expect([1, 2, 3, 4, 5, 6].map(retryDelayMs)).toEqual([2000, 4000, 8000, 16000, 30000, 30000])
  })

  it('lets a new program supersede any pending capture', () => {
    // A new program restarts the controller's log, so whatever the previous pass was waiting for is
    // gone regardless of which phase it had reached.
    for (const phase of [
      run([poll({ active: true }), poll({})]),
      run([poll({ active: true }), poll({}), { type: 'skip', nowMs: NOW }]),
    ]) {
      expect(ingestReducer(phase, poll({ active: true })).phase).toBe('running')
    }
  })

  it('does not start a capture for a program it never saw running', () => {
    // A page opened onto an idle controller must not fetch a log it has no reason to want.
    expect(run([poll({}), poll({}), { type: 'tick', nowMs: NOW + 600000 }])).toEqual(initialIngestState)
  })

  it('honors a shorter tail when one is configured', () => {
    const state = run([poll({ active: true }), poll({})], initialIngestState, 30)
    expect(state.tailUntilMs).toBe(NOW + 30000)
  })

  it('narrates every phase the operator can see', () => {
    const waiting = run([poll({ active: true }), poll({ endReason: 'completed' })])
    expect(ingestBannerText(waiting, NOW)).toContain('Program completed.')
    expect(ingestBannerText(waiting, NOW)).toContain('3:00 remaining')
    expect(ingestBannerText({ phase: 'fetching', attempts: 0 }, NOW)).toContain('Fetching the thermal log')
    expect(ingestBannerText({ phase: 'fetching', attempts: 2 }, NOW)).toContain('attempt 3')
    expect(ingestBannerText({ phase: 'failed', attempts: 6, message: 'HTTP 500' }, NOW)).toContain(
      'add that exact device recording',
    )
    expect(ingestBannerText(initialIngestState, NOW)).toBeUndefined()
  })
})
