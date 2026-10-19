import { describe, expect, it } from 'vitest'
import { deviceRoastSamples } from '../src/domain/deviceRoastImport'
import { liveSampleGap, mergeRecordingPrefix, RecordingResync } from '../src/domain/liveTraceResync'
import type { TelemetrySample } from '../src/domain/types'
import { TICK_MS } from './config'
import { MockDevice } from './device'
import { liveDocument } from './documents'

/**
 * A locked phone, against the mock roaster.
 *
 * A browser collector - one point per roaster second off the compact frame, the rule
 * `appendProfiledRoastSample` applies in `App.tsx` (kept out of this node-only project because the
 * component module needs the DOM) - watches a journey for forty seconds, is suspended for a minute
 * while the roaster keeps roasting and recording, and wakes. Its trace has a hole. The resync reads the roaster's own
 * recording prefix (what `/thermal.csv` serves mid-capture) and merges it in; the hole is gone, the
 * roaster's values stand in it, and later frames extend the trace as before.
 */
const startJourney = (device: MockDevice) => {
  device.appliedCoefficients = {
    heater_gain: 100,
    fan_cooling: 30,
    cooling_fan: 40,
    loss_per_min: 0.08,
    fit_id: 'resync-test',
    applied_epoch: 1,
  }
  const started = device.startRoast(
    new URLSearchParams({
      confirm: 'START_ROAST',
      mode: 'journey',
      name: 'Locked phone',
      mass: '225',
      start: '21.5',
      zones: '180:300:2:8:1:10',
    }),
  )
  expect(started.status).toBe(202)
  expect(device.archive.active).toBe(true)
}

/** A browser's live collector: one point per roaster second, read off the compact frame. */
class BrowserTrace {
  samples: TelemetrySample[] = []
  gaps = 0
  private lastElapsedSec?: number

  observe(device: MockDevice) {
    const live = liveDocument(device) as Record<string, unknown>
    const elapsedSec = live.roast_elapsed_s as number
    const beanTempC = live.tc_c
    if (typeof beanTempC !== 'number') return
    if (liveSampleGap(this.lastElapsedSec, elapsedSec)) this.gaps += 1
    this.lastElapsedSec = elapsedSec
    const second = Math.max(0, Math.floor(elapsedSec))
    if (this.samples.at(-1)?.elapsedSec === second) return
    this.samples = [
      ...this.samples,
      {
        elapsedSec: second,
        beanTempC,
        rorCPerMin: 0,
        requestedFan: live.fan_req as number,
        effectiveFan: live.fan as number,
        requestedHeat: live.heat_req as number,
        effectiveHeat: live.heat as number,
        phase: 'DRYING',
      },
    ]
  }
}

const oneSecond = (device: MockDevice, watching?: BrowserTrace) => {
  for (let elapsed = 0; elapsed < 1000; elapsed += TICK_MS) device.step(TICK_MS)
  watching?.observe(device)
}

const flush = async () => {
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve()
}

const seconds = (samples: TelemetrySample[]) => samples.map((row) => row.elapsedSec)
const contiguous = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index)

describe('a browser that slept through part of a roast', () => {
  it('has a hole, fills it from the roaster recording, and keeps collecting on the same clock', async () => {
    const device = new MockDevice()
    startJourney(device)
    const phone = new BrowserTrace()
    for (let second = 0; second < 40; second += 1) oneSecond(device, phone)
    expect(seconds(phone.samples)).toEqual(contiguous(1, 40))

    // Locked: the roaster roasts and records for a minute; the browser sees none of it.
    for (let second = 0; second < 60; second += 1) oneSecond(device)
    // Unlocked: the next frame is a minute later on the roaster's clock.
    for (let second = 0; second < 10; second += 1) oneSecond(device, phone)
    expect(phone.gaps).toBe(1)
    expect(seconds(phone.samples)).toEqual([...contiguous(1, 40), ...contiguous(101, 110)])

    // The resync: the roaster's recording prefix, exactly as `/thermal.csv` serves it mid-capture.
    const recording = () => deviceRoastSamples(device.archive.currentCsv)
    const resync = new RecordingResync({
      minIntervalMs: 0,
      read: async () => recording(),
      apply: (prefix) => {
        phone.samples = mergeRecordingPrefix(prefix, phone.samples)
      },
    })
    resync.request('page-resume')
    await flush()
    expect(resync.reads).toBe(1)
    expect(seconds(phone.samples)).toEqual(contiguous(0, 110))

    // The hole holds the roaster's own samples, verbatim, on the roaster's own clock.
    const prefix = recording()
    for (const second of [41, 70, 100]) {
      expect(phone.samples[second]).toEqual(prefix[second])
    }
    // The roaster wins the seconds it covers on both sides of the hole too.
    expect(phone.samples[10]).toEqual(prefix[10])
    for (let index = 1; index < phone.samples.length; index += 1) {
      expect(phone.samples[index].elapsedSec).toBeGreaterThan(phone.samples[index - 1].elapsedSec)
    }

    // Idempotent: a second read of the same prefix changes nothing.
    const filled = phone.samples
    resync.request('stream-reconnect')
    await flush()
    expect(resync.reads).toBe(2)
    expect(phone.samples).toEqual(filled)

    // Frames after the fill extend the trace on the same second grid, without duplicates.
    for (let second = 0; second < 5; second += 1) oneSecond(device, phone)
    expect(seconds(phone.samples)).toEqual(contiguous(0, 115))
    expect(phone.gaps).toBe(1)
    resync.dispose()
  })

  it('reads nothing into a trace when the roaster has no live recording to serve', async () => {
    const device = new MockDevice()
    const applied: number[] = []
    const resync = new RecordingResync({
      minIntervalMs: 0,
      read: async () => (device.archive.active ? deviceRoastSamples(device.archive.currentCsv) : undefined),
      apply: (prefix) => applied.push(prefix.length),
    })
    resync.request('page-resume')
    await flush()
    expect(resync.reads).toBe(1)
    expect(applied).toEqual([])
    resync.dispose()
  })
})
