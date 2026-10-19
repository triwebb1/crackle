import { describe, expect, it } from 'vitest'
import { testRecordedOn } from '../testFixtures/provenance'
import {
  manualChangesFromSamples,
  manualRoastRunId,
  mergeDeviceManualEvents,
  profileFromManualRoast,
} from './manualRoast'
import { timedRoastSteps } from './roastProgram'
import type { ManualRoastChange, RoastEvent, RoastRun, TelemetrySample, TimedProfile } from './types'

const change = (
  elapsedSec: number,
  requestedFan: number,
  requestedHeat: number,
  patch: Partial<ManualRoastChange> = {},
): ManualRoastChange => ({
  id: `change-${elapsedSec}-${requestedFan}-${requestedHeat}`,
  elapsedSec,
  requestedFan,
  requestedHeat,
  effectiveFan: requestedFan,
  effectiveHeat: requestedHeat,
  source: 'local',
  ...patch,
})

const run = (changes: ManualRoastChange[], stoppedElapsedSec: number | undefined = 60): RoastRun => ({
  id: 'manual-run-1',
  name: 'Saturday manual roast',
  startedAt: '2026-07-28T12:00:00.000Z',
  completedAt: '2026-07-28T12:20:00.000Z',
  profile: {
    id: 'manual-run-profile-1',
    name: 'Manual roast',
    revision: 0,
    strategy: 'timed',
    createdAt: '2026-07-28T12:00:00.000Z',
    updatedAt: '2026-07-28T12:00:00.000Z',
    metadata: { intent: 'Manual roast' },
    notes: '',
    points: [],
    coolFan: 9,
    coolDurationSec: 90,
  },
  notes: '',
  controllerVersion: 'test',
  recordedOn: testRecordedOn,
  outcome: 'complete',
  samples: [],
  events: [],
  manualRoast: { changes, stoppedElapsedSec, endReason: 'stopped' },
})

const profile = (value: TimedProfile | string): TimedProfile => {
  expect(typeof value).not.toBe('string')
  return value as TimedProfile
}

describe('manual roast run document identity', () => {
  it('is deterministic for the same controller boot and session', () => {
    expect(manualRoastRunId('7', 'session:7/14')).toBe(manualRoastRunId('7', 'session:7/14'))
  })

  it('uses both halves of controller identity', () => {
    const id = manualRoastRunId('7', 'session:7/14')
    expect(manualRoastRunId('8', 'session:7/14')).not.toBe(id)
    expect(manualRoastRunId('7', 'session:7/15')).not.toBe(id)
  })

  it('always fits the run-document path contract even when controller ids do not', () => {
    const id = manualRoastRunId('boot / with spaces', 'session:7/14 ? café')
    expect(id).toMatch(/^manual-[0-9a-f]{16}$/)
    expect(id!.length).toBeLessThanOrEqual(24)
  })

  it('refuses to invent identity when either controller field is absent', () => {
    expect(manualRoastRunId(undefined, 'session')).toBeUndefined()
    expect(manualRoastRunId('boot', undefined)).toBeUndefined()
    expect(manualRoastRunId(' ', 'session')).toBeUndefined()
    expect(manualRoastRunId('boot', '')).toBeUndefined()
  })
})

/**
 * A browser only journals its OWN acknowledged Applies, and the Controls-history meta document
 * cannot sync while the firmware's flash-write idle gate holds. The roaster's commanded levels are
 * the one cross-browser record during the roast, so steps observed there must reach every
 * browser's presentation without doubling the steps this browser already journaled itself.
 */
describe('device-observed manual steps on every browser', () => {
  const override = (
    id: string,
    elapsedSec: number,
    label: string,
    type: RoastEvent['type'] = 'OVERRIDE',
  ): RoastEvent => ({ id, elapsedSec, type, label })

  it("adds another browser's steps to an empty journal, in elapsed order", () => {
    const observed = [override('obs-2', 300, 'Fan 5.0 / Heat 7.0'), override('obs-1', 120, 'Fan 6.0 / Heat 5.0')]
    expect(mergeDeviceManualEvents([], observed).map((event) => event.id)).toEqual(['obs-1', 'obs-2'])
  })

  it('does not double a step this browser journaled itself within the acknowledgement latency', () => {
    const own = [override('own-1', 118, 'Fan 6.0 / Heat 5.0')]
    const observed = [override('obs-1', 120, 'Fan 6.0 / Heat 5.0'), override('obs-2', 300, 'Fan 5.0 / Heat 7.0')]
    expect(mergeDeviceManualEvents(own, observed).map((event) => event.id)).toEqual(['own-1', 'obs-2'])
  })

  it('keeps an identical instruction re-applied much later as its own step', () => {
    const own = [override('own-1', 60, 'Fan 6.0 / Heat 5.0')]
    const observed = [override('obs-1', 400, 'Fan 6.0 / Heat 5.0')]
    expect(mergeDeviceManualEvents(own, observed).map((event) => event.id)).toEqual(['own-1', 'obs-1'])
  })

  it('never treats a non-step journal entry as owning an observed step', () => {
    const own = [override('own-safety', 120, 'Fan 6.0 / Heat 5.0', 'SAFETY')]
    const observed = [override('obs-1', 120, 'Fan 6.0 / Heat 5.0')]
    expect(mergeDeviceManualEvents(own, observed).map((event) => event.id)).toEqual(['own-safety', 'obs-1'])
  })

  it('returns the journal untouched when nothing was observed', () => {
    const own = [override('own-1', 10, 'Fan 4.0 / Heat 0.0')]
    expect(mergeDeviceManualEvents(own, [])).toBe(own)
  })
})

describe('manual roast to timed profile', () => {
  it('sorts changes, starts the first accepted request at zero, quantizes, and lets the last same-second command win', () => {
    const converted = profile(
      profileFromManualRoast(run([change(10.2, 5.06, 6.06), change(0.4, 4.04, 5.04), change(10.1, 4.04, 5.04)], 20)),
    )
    expect(converted.points.map(({ timeSec, fan, heat }) => ({ timeSec, fan, heat }))).toEqual([
      { timeSec: 0, fan: 4, heat: 5 },
      { timeSec: 10, fan: 5.1, heat: 6.1 },
      { timeSec: 20, fan: 9, heat: 0 },
    ])
  })

  it('removes adjacent no-op lease renewals without losing the held duration', () => {
    const converted = profile(profileFromManualRoast(run([change(0, 4, 5), change(20, 4, 5), change(40, 6, 7)], 60)))
    expect(timedRoastSteps(converted)).toEqual([
      { fan: 4, heat: 5, durationSec: 40 },
      { fan: 6, heat: 7, durationSec: 20 },
      { fan: 9, heat: 0, durationSec: 90 },
    ])
  })

  it('saves requested instructions rather than levels raised by a firmware floor', () => {
    const converted = profile(
      profileFromManualRoast(run([change(0, 1, 8, { effectiveFan: 1.4, effectiveHeat: 8 })], 120)),
    )
    expect(converted.points[0]).toMatchObject({ fan: 1, heat: 8 })
  })

  it('retains an explicitly authored heat-off hold and does not add a second cooling point', () => {
    const converted = profile(
      profileFromManualRoast(run([change(0, 5, 7), change(100, 8, 0)], 160), { coolFan: 10, coolDurationSec: 300 }),
    )
    expect(timedRoastSteps(converted)).toEqual([
      { fan: 5, heat: 7, durationSec: 100 },
      { fan: 8, heat: 0, durationSec: 60 },
    ])
    expect(converted.coolFan).toBe(8)
    expect(converted.coolDurationSec).toBe(60)
  })

  it('closes a heating instruction at Stop and adds a separate reproducible cooling step', () => {
    const converted = profile(
      profileFromManualRoast(run([change(0, 5, 7)], 95), { coolFan: 9.5, coolDurationSec: 120 }),
    )
    expect(timedRoastSteps(converted)).toEqual([
      { fan: 5, heat: 7, durationSec: 95 },
      { fan: 9.5, heat: 0, durationSec: 120 },
    ])
  })

  it('splits a long hold into legal 1800-second instructions', () => {
    const converted = profile(profileFromManualRoast(run([change(0, 4, 5)], 4000)))
    expect(timedRoastSteps(converted)).toEqual([
      { fan: 4, heat: 5, durationSec: 1800 },
      { fan: 4, heat: 5, durationSec: 1800 },
      { fan: 4, heat: 5, durationSec: 400 },
      { fan: 9, heat: 0, durationSec: 90 },
    ])
  })

  it('rejects a path that cannot fit the firmware step limit rather than thinning it', () => {
    const changes = Array.from({ length: 24 }, (_, index) => change(index * 2, 4 + (index % 2), 5 + (index % 2)))
    expect(profileFromManualRoast(run(changes, 48))).toBe(
      'This manual roast makes 25 timed steps; a profile can hold at most 24',
    )
  })

  it('rejects missing, empty, out-of-run, and zero-duration instruction histories', () => {
    expect(profileFromManualRoast({ ...run([]), manualRoast: undefined })).toContain('no accepted control changes')
    expect(profileFromManualRoast(run([], 30))).toContain('no accepted control changes')
    expect(profileFromManualRoast(run([change(31, 4, 5)], 30))).toContain('outside the roast duration')
    expect(
      profileFromManualRoast({
        ...run([change(0, 4, 5)]),
        manualRoast: { changes: [change(0, 4, 5)], stoppedElapsedSec: undefined },
      }),
    ).toContain('no valid stop boundary')
    expect(profileFromManualRoast(run([change(0, 4, 5), change(30, 5, 6)], 30))).toContain('not held for a full second')
  })

  it('creates a new deterministic revision-one profile without mutating the run snapshot', () => {
    const source = run([change(0, 4, 5), change(30, 5, 6)], 60)
    const before = structuredClone(source)
    const first = profile(profileFromManualRoast(source, { profileId: 'new-profile', name: 'Learned recipe' }))
    const second = profile(profileFromManualRoast(source, { profileId: 'new-profile', name: 'Learned recipe' }))
    expect(first).toEqual(second)
    expect(first).toMatchObject({ id: 'new-profile', name: 'Learned recipe', revision: 1, strategy: 'timed' })
    expect(first.id).not.toBe(source.profile.id)
    expect(first.points.map((point) => point.id)).toEqual(second.points.map((point) => point.id))
    expect(source).toEqual(before)
  })
})

describe('legacy manual recording reconstruction', () => {
  const sample = (elapsedSec: number, fan: number, heat: number): TelemetrySample => ({
    elapsedSec,
    beanTempC: 25 + elapsedSec,
    rorCPerMin: 1,
    requestedFan: fan,
    effectiveFan: fan,
    requestedHeat: heat,
    effectiveHeat: heat,
    phase: heat > 0 ? 'DRYING' : 'COOLING',
  })

  it('records effective transitions as firmware-sourced requested changes and omits terminal idle', () => {
    const changes = manualChangesFromSamples([
      sample(0, 4, 5),
      sample(1, 4, 5),
      sample(20, 1.4, 8),
      sample(30, 9, 0),
      sample(90, 0, 0),
    ])
    expect(
      changes.map(({ elapsedSec, requestedFan, effectiveFan, requestedHeat, source }) => ({
        elapsedSec,
        requestedFan,
        effectiveFan,
        requestedHeat,
        source,
      })),
    ).toEqual([
      { elapsedSec: 0, requestedFan: 4, effectiveFan: 4, requestedHeat: 5, source: 'firmware' },
      { elapsedSec: 20, requestedFan: 1.4, effectiveFan: 1.4, requestedHeat: 8, source: 'firmware' },
      { elapsedSec: 30, requestedFan: 9, effectiveFan: 9, requestedHeat: 0, source: 'firmware' },
    ])
  })
})
