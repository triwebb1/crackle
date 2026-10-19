import { describe, expect, it } from 'vitest'
import { deviceRoastSamples } from './deviceRoastImport'
import {
  LIVE_SAMPLE_GAP_SEC,
  LIVE_SEQUENCE_GAP_FRAMES,
  liveSampleGap,
  liveSequenceGap,
  mergeRecordingPrefix,
  RecordingResync,
} from './liveTraceResync'
import type { TelemetrySample } from './types'

const sample = (elapsedSec: number, beanTempC: number, origin = 'browser'): TelemetrySample => ({
  elapsedSec,
  beanTempC,
  rorCPerMin: 0,
  requestedFan: 5,
  effectiveFan: origin === 'device' ? 5 : 4.5,
  requestedHeat: 8,
  effectiveHeat: 8,
  phase: 'DRYING',
})

/** Promise turns, enough for an awaited read and its `finally`. */
const flush = async () => {
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve()
}

/** A manual clock and timer table, so the spacing rules are asserted exactly rather than waited for. */
const fakeClock = () => {
  let nowMs = 0
  const timers: Array<{ atMs: number; fire: () => void }> = []
  return {
    now: () => nowMs,
    setTimer: (fire: () => void, delayMs: number) => {
      const handle = { atMs: nowMs + delayMs, fire }
      timers.push(handle)
      return handle
    },
    clearTimer: (handle: unknown) => {
      const index = timers.indexOf(handle as { atMs: number; fire: () => void })
      if (index >= 0) timers.splice(index, 1)
    },
    pendingTimers: () => timers.length,
    advance: async (ms: number) => {
      nowMs += ms
      for (const due of timers.filter((timer) => timer.atMs <= nowMs)) {
        timers.splice(timers.indexOf(due), 1)
        due.fire()
        await flush()
      }
    },
  }
}

describe('what counts as a live discontinuity', () => {
  it('flags accepted samples further apart than the roaster cadence tolerates, and nothing narrower', () => {
    expect(liveSampleGap(undefined, 100)).toBe(false)
    expect(liveSampleGap(100, 101)).toBe(false)
    expect(liveSampleGap(100, 100 + LIVE_SAMPLE_GAP_SEC)).toBe(false)
    expect(liveSampleGap(100, 100 + LIVE_SAMPLE_GAP_SEC + 1)).toBe(true)
    // The locked phone: a minute of the roaster's clock passed between two frames.
    expect(liveSampleGap(40, 100)).toBe(true)
  })

  it('flags a same-boot hole in the stream sequence but leaves reboots and reorders to continuity', () => {
    expect(liveSequenceGap({ bootId: 'b', streamSeq: 10 }, { bootId: 'b', streamSeq: 11 })).toBe(false)
    expect(
      liveSequenceGap({ bootId: 'b', streamSeq: 10 }, { bootId: 'b', streamSeq: 10 + LIVE_SEQUENCE_GAP_FRAMES }),
    ).toBe(false)
    expect(
      liveSequenceGap({ bootId: 'b', streamSeq: 10 }, { bootId: 'b', streamSeq: 10 + LIVE_SEQUENCE_GAP_FRAMES + 1 }),
    ).toBe(true)
    expect(liveSequenceGap({ bootId: 'b', streamSeq: 10 }, { bootId: 'c', streamSeq: 500 })).toBe(false)
    expect(liveSequenceGap({ bootId: 'b', streamSeq: 500 }, { bootId: 'b', streamSeq: 10 })).toBe(false)
    expect(liveSequenceGap(undefined, { bootId: 'b', streamSeq: 500 })).toBe(false)
    expect(liveSequenceGap({ bootId: 'b', streamSeq: undefined }, { bootId: 'b', streamSeq: 500 })).toBe(false)
  })
})

describe('merging the recording prefix into the trace', () => {
  const browser = [sample(0, 25), sample(1, 26), sample(2, 27), sample(40, 90), sample(100, 150), sample(101, 151)]
  const device = Array.from({ length: 101 }, (_, second) => sample(second, 25 + second, 'device'))

  it('fills the hole, lets the roaster win every second it covers, and keeps the newer browser tail', () => {
    const merged = mergeRecordingPrefix(device, browser)
    expect(merged.map((row) => row.elapsedSec)).toEqual(Array.from({ length: 102 }, (_, second) => second))
    expect(merged[40]).toEqual(device[40])
    expect(merged[100]).toEqual(device[100])
    expect(merged[101]).toEqual(browser[5])
  })

  it('is idempotent and monotonic', () => {
    const once = mergeRecordingPrefix(device, browser)
    const twice = mergeRecordingPrefix(device, once)
    expect(twice).toEqual(once)
    for (let index = 1; index < twice.length; index += 1)
      expect(twice[index].elapsedSec).toBeGreaterThan(twice[index - 1].elapsedSec)
  })

  it('agrees with the roaster time base: a log stamped off the log clock lands on whole roast seconds', () => {
    // The firmware's first thermal sample lands a few hundred milliseconds after the log opens
    // (for example t_ms 437, 1437, 2437 ...). The importer rebases onto that first sample, so the
    // prefix keys on the same whole seconds the browser stamps from `roast_elapsed_s`.
    const rows = Array.from(
      { length: 60 },
      (_, second) => `${437 + second * 1000},${(30 + second).toFixed(1)},36.0,10.0,10.0`,
    )
    const prefix = deviceRoastSamples(
      ['t_ms,thermocouple_c,cold_junction_c,effective_fan,effective_heat', ...rows].join('\n'),
    )
    expect(prefix.map((row) => row.elapsedSec)).toEqual(Array.from({ length: 60 }, (_, second) => second))
    const live = [sample(10, 40.4), sample(11, 41.5), sample(59, 88.9), sample(60, 90)]
    const merged = mergeRecordingPrefix(prefix, live)
    expect(merged.map((row) => row.elapsedSec)).toEqual(Array.from({ length: 61 }, (_, second) => second))
    expect(merged[10].beanTempC).toBe(40)
    expect(merged[59].beanTempC).toBe(89)
    expect(merged[60]).toEqual(live[3])
  })
})

describe('the bounded recording re-read', () => {
  it('reads once for a burst of discontinuities and folds the rest into one follow-up', async () => {
    const clock = fakeClock()
    let resolveRead: ((samples: TelemetrySample[]) => void) | undefined
    const applied: number[] = []
    const resync = new RecordingResync({
      ...clock,
      minIntervalMs: 2000,
      read: () =>
        new Promise<TelemetrySample[]>((resolve) => {
          resolveRead = resolve
        }),
      apply: (samples) => applied.push(samples.length),
    })
    resync.request('stream-reconnect')
    resync.request('page-resume')
    resync.request('sequence-gap')
    resync.request('sample-gap')
    expect(resync.reads).toBe(1)
    expect(resync.busy).toBe(true)
    resolveRead!([sample(0, 25, 'device')])
    await flush()
    expect(applied).toEqual([1])
    expect(resync.busy).toBe(false)
    // The follow-up waits out the (already doubled) spacing rather than firing straight back.
    expect(resync.reads).toBe(1)
    expect(clock.pendingTimers()).toBe(1)
    await clock.advance(3999)
    expect(resync.reads).toBe(1)
    await clock.advance(1)
    expect(resync.reads).toBe(2)
    resolveRead!([sample(0, 25, 'device'), sample(1, 26, 'device')])
    await flush()
    expect(applied).toEqual([1, 2])
    resync.dispose()
  })

  it('backs off every read within a session, doubling to the cap, success included', async () => {
    const clock = fakeClock()
    let fail = true
    const resync = new RecordingResync({
      ...clock,
      minIntervalMs: 2000,
      maxBackoffMs: 5000,
      read: async () => {
        if (fail) throw new Error('503 busy')
        return [sample(0, 25, 'device')]
      },
      apply: () => {},
    })
    resync.request('sample-gap')
    await flush()
    expect(resync.reads).toBe(1)
    resync.request('sample-gap')
    await clock.advance(3999)
    expect(resync.reads).toBe(1)
    await clock.advance(1)
    expect(resync.reads).toBe(2)
    resync.request('sample-gap')
    await clock.advance(4999)
    expect(resync.reads).toBe(2)
    await clock.advance(1)
    expect(resync.reads).toBe(3)
    fail = false
    resync.request('sample-gap')
    await clock.advance(5000)
    expect(resync.reads).toBe(4)
    // A success no longer drops the spacing to its floor: the flaky link keeps being spaced out.
    resync.request('sample-gap')
    await clock.advance(4999)
    expect(resync.reads).toBe(4)
    await clock.advance(1)
    expect(resync.reads).toBe(5)
    resync.dispose()
  })

  /**
   * The reconnect storm: a link that drops every few seconds, each reconnect a discontinuity, each
   * read a success. The re-reads must thin out rather than hit the roaster at the minimum spacing.
   */
  it('thins out re-reads across a storm of successful reconnect resyncs', async () => {
    const clock = fakeClock()
    const resync = new RecordingResync({
      ...clock,
      minIntervalMs: 2000,
      maxBackoffMs: 15000,
      session: () => 'roast:boot-1:31',
      read: async () => [sample(0, 25, 'device')],
      apply: () => {},
    })
    // A reconnect every 3 seconds for a minute.
    for (let second = 0; second < 60; second += 3) {
      resync.request('stream-reconnect')
      await clock.advance(3000)
    }
    // At the floor that would be ~20 reads; with compounding spacing it is a handful.
    expect(resync.reads).toBeLessThanOrEqual(7)
    expect(resync.spacing).toBe(15000)
    resync.dispose()
  })

  it('resets the spacing when the session changes or after a quiet period', async () => {
    const clock = fakeClock()
    let session = 'roast:boot-1:31'
    const resync = new RecordingResync({
      ...clock,
      minIntervalMs: 2000,
      maxBackoffMs: 15000,
      quietResetMs: 60000,
      session: () => session,
      read: async () => [sample(0, 25, 'device')],
      apply: () => {},
    })
    resync.request('stream-reconnect')
    await flush()
    resync.request('stream-reconnect')
    await clock.advance(4000)
    expect(resync.reads).toBe(2)
    expect(resync.spacing).toBe(8000)
    // A new roast session starts at the floor and may read immediately.
    session = 'roast:boot-1:32'
    resync.request('stream-reconnect')
    await flush()
    expect(resync.reads).toBe(3)
    expect(resync.spacing).toBe(4000)
    // A minute without a discontinuity: the stream recovered, so the next one starts fresh.
    await clock.advance(60000)
    resync.request('page-resume')
    await flush()
    expect(resync.reads).toBe(4)
    expect(resync.spacing).toBe(4000)
    resync.dispose()
  })

  it('applies nothing for an absent recording or an empty read, and spaces both out', async () => {
    const clock = fakeClock()
    const applied: number[] = []
    let answer: TelemetrySample[] | undefined
    const resync = new RecordingResync({
      ...clock,
      minIntervalMs: 2000,
      read: async () => answer,
      apply: (samples) => applied.push(samples.length),
    })
    resync.request('page-resume')
    await flush()
    expect(applied).toEqual([])
    answer = []
    resync.request('page-resume')
    await clock.advance(3999)
    expect(resync.reads).toBe(1)
    await clock.advance(1)
    expect(resync.reads).toBe(2)
    expect(applied).toEqual([])
    answer = [sample(0, 25, 'device')]
    resync.request('page-resume')
    await clock.advance(7999)
    expect(resync.reads).toBe(2)
    await clock.advance(1)
    expect(resync.reads).toBe(3)
    expect(applied).toEqual([1])
    resync.dispose()
  })

  it('drops its timer and pending follow-up on dispose, and applies nothing afterwards', async () => {
    const clock = fakeClock()
    let resolveRead: ((samples: TelemetrySample[]) => void) | undefined
    const applied: number[] = []
    const resync = new RecordingResync({
      ...clock,
      minIntervalMs: 2000,
      read: () =>
        new Promise<TelemetrySample[]>((resolve) => {
          resolveRead = resolve
        }),
      apply: (samples) => applied.push(samples.length),
    })
    resync.request('stream-reconnect')
    resync.request('sample-gap')
    resync.dispose()
    resolveRead!([sample(0, 25, 'device')])
    await flush()
    expect(applied).toEqual([])
    expect(clock.pendingTimers()).toBe(0)
    resync.request('sample-gap')
    expect(resync.reads).toBe(1)
  })
})
