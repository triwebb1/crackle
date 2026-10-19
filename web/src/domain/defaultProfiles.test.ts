import { describe, expect, it } from 'vitest'
import { parseProfilesDocument, serializeProfilesDocument } from '../data/documentSerializer'
import {
  DEFAULT_JOURNEY_PROFILE_ID,
  DEFAULT_TIMED_PROFILE_ID,
  defaultProfileRevisions,
  defaultProfiles,
} from './defaultProfiles'
import { journeyZonesError, timedRoastSteps, timedStepsError } from './roastProgram'
import type { ThermalIntent, TimedProfile } from './types'

const NOW = '2026-10-19T12:00:00.000Z'

describe('default profiles', () => {
  const [journey, timed] = defaultProfiles(NOW) as [ThermalIntent, TimedProfile]

  it('lists the temperature journey first, under fixed ids', () => {
    expect(journey).toMatchObject({
      id: DEFAULT_JOURNEY_PROFILE_ID,
      name: 'Espresso Express',
      strategy: 'thermal-intent',
    })
    expect(timed).toMatchObject({ id: DEFAULT_TIMED_PROFILE_ID, name: 'Espresso Express (timed)', strategy: 'timed' })
  })

  it('survives the roaster document round trip with a Created history row each', () => {
    const profiles = defaultProfiles(NOW)
    const revisions = defaultProfileRevisions(profiles, NOW)
    const parsed = parseProfilesDocument(serializeProfilesDocument(profiles, revisions))
    expect(parsed.profiles).toEqual(profiles)
    expect(parsed.profileRevisions.map((row) => [row.profileId, row.summary])).toEqual([
      [DEFAULT_JOURNEY_PROFILE_ID, 'Created'],
      [DEFAULT_TIMED_PROFILE_ID, 'Created'],
    ])
  })

  it('is a startable journey: contiguous zones ending in a heat-off cooling zone', () => {
    expect(journeyZonesError(journey.segments)).toBeUndefined()
    for (let index = 1; index < journey.segments.length; index += 1) {
      expect(journey.segments[index].startC).toBe(journey.segments[index - 1].endC)
    }
    const last = journey.segments.at(-1)!
    expect(last.endC).toBeLessThan(last.startC)
    expect(last.heatMax).toBe(0)
  })

  it('is a startable timed roast for a small batch: Fan 5 or more while heating, then two minutes of cooling', () => {
    const steps = timedRoastSteps(timed)
    expect(timedStepsError(steps)).toBeUndefined()
    for (const step of steps.filter((item) => item.heat > 0)) expect(step.fan).toBeGreaterThanOrEqual(5)
    expect(steps.filter((item) => item.heat > 0).reduce((sum, item) => sum + item.durationSec, 0)).toBe(570)
    expect(steps.at(-1)).toEqual({ fan: 10, heat: 0, durationSec: 120 })
  })
})
