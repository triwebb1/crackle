import { describe, expect, it } from 'vitest'
import { testRecordedOn } from '../testFixtures/provenance'
import {
  lastRoastedMassG,
  profileUsageForBean,
  recommendedProfileOrder,
  runsForBean,
  runsForProfile,
} from './recommendations'
import type { Profile, RoastRun } from './types'

const profile = (id: string): Profile => ({
  id,
  name: id,
  revision: 1,
  strategy: 'timed',
  createdAt: '',
  updatedAt: '',
  metadata: { intent: '' },
  notes: '',
  points: [],
  coolFan: 9,
  coolDurationSec: 90,
})

const run = (
  id: string,
  profileId: string,
  beanLotId: string | undefined,
  startedAt: string,
  massG?: number,
): RoastRun => ({
  id,
  name: id,
  startedAt,
  profile: profile(profileId),
  beanLotId,
  notes: '',
  controllerVersion: 'test',
  recordedOn: testRecordedOn,
  measurements: massG === undefined ? undefined : { startingMassG: massG },
  outcome: 'complete',
  samples: [],
  events: [],
})

const order = (profiles: Profile[], runs: RoastRun[], beanLotId?: string) =>
  recommendedProfileOrder(profiles, runs, beanLotId).map((item) => `${item.profile.id}${item.recommended ? '*' : ''}`)

/**
 * There is no hand-maintained "compatible bean lots" checklist. The roast archive already
 * knows which profiles have been used with which lot, it knows it more accurately, and it cannot go
 * stale - so the recommendation is derived from it rather than declared a second time.
 */
describe('recommendations derived from roast history', () => {
  const runs = [
    run('r1', 'house', 'bean-guji', '2026-05-01T09:00:00.000Z'),
    run('r2', 'filter', 'bean-guji', '2026-06-01T09:00:00.000Z'),
    run('r3', 'house', 'bean-guji', '2026-07-01T09:00:00.000Z'),
    run('r4', 'dark', 'bean-lintong', '2026-07-02T09:00:00.000Z'),
    run('r5', 'decaf', undefined, '2026-07-03T09:00:00.000Z'),
  ]

  it('reports which profiles a lot has actually been through, most recent first', () => {
    expect(profileUsageForBean(runs, 'bean-guji')).toEqual([
      { profileId: 'house', lastUsedAt: '2026-07-01T09:00:00.000Z', useCount: 2 },
      { profileId: 'filter', lastUsedAt: '2026-06-01T09:00:00.000Z', useCount: 1 },
    ])
    expect(profileUsageForBean(runs, 'bean-unused')).toEqual([])
    expect(profileUsageForBean(runs, undefined)).toEqual([])
  })

  it('orders used profiles first, most recently used at the top', () => {
    const profiles = [profile('dark'), profile('filter'), profile('house'), profile('decaf')]
    expect(order(profiles, runs, 'bean-guji')).toEqual(['house*', 'filter*', 'dark', 'decaf'])
  })

  it('never filters: an unused profile is still in the list, just below', () => {
    const profiles = [profile('dark'), profile('filter'), profile('house'), profile('decaf')]
    expect(recommendedProfileOrder(profiles, runs, 'bean-guji')).toHaveLength(profiles.length)
    expect(order(profiles, runs, 'bean-lintong')).toEqual(['dark*', 'filter', 'house', 'decaf'])
  })

  it('keeps the incoming order in the unused group, so the tail never reshuffles unexplained', () => {
    const profiles = [profile('a'), profile('b'), profile('c')]
    expect(order(profiles, runs, 'bean-guji')).toEqual(['a', 'b', 'c'])
    expect(order(profiles, runs, undefined)).toEqual(['a', 'b', 'c'])
    expect(order(profiles, [], 'bean-guji')).toEqual(['a', 'b', 'c'])
  })

  it('carries the usage figures the UI reports beside the group', () => {
    const [top] = recommendedProfileOrder([profile('house'), profile('filter')], runs, 'bean-guji')
    expect(top).toMatchObject({ recommended: true, useCount: 2, lastUsedAt: '2026-07-01T09:00:00.000Z' })
  })

  it('answers the same question from either side, newest first', () => {
    expect(runsForBean(runs, 'bean-guji').map((item) => item.id)).toEqual(['r3', 'r2', 'r1'])
    expect(runsForProfile(runs, 'house').map((item) => item.id)).toEqual(['r3', 'r1'])
    expect(runsForBean(runs, undefined)).toEqual([])
    expect(runsForProfile(runs, undefined)).toEqual([])
  })
})

/** Mass moved off the profile in 0.7.0, so a new roast defaults to what was last actually roasted. */
describe('the default batch mass', () => {
  it('is the most recent roast that recorded one', () => {
    const runs = [
      run('old', 'house', 'bean-1', '2026-05-01T09:00:00.000Z', 200),
      run('new', 'house', 'bean-1', '2026-07-01T09:00:00.000Z', 260),
      run('newest-without', 'house', 'bean-1', '2026-07-05T09:00:00.000Z'),
    ]
    expect(lastRoastedMassG(runs)).toBe(260)
  })

  it('falls back rather than inventing a zero', () => {
    expect(lastRoastedMassG([])).toBe(225)
    expect(lastRoastedMassG([run('a', 'house', 'bean-1', '2026-07-01T09:00:00.000Z', 0)])).toBe(225)
    expect(lastRoastedMassG([], 180)).toBe(180)
  })
})
