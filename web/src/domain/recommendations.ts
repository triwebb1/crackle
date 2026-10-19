import type { Profile, RoastRun } from './types'

/**
 * Which profile to suggest for a bean lot, derived from what was actually roasted.
 *
 * There is deliberately no hand-maintained checklist of "compatible bean lots" on each profile. The
 * roast archive already knows which profiles have been used with which lot, it knows it more
 * accurately than a checklist maintained by hand, and it cannot go stale. Declaring the same fact
 * twice is the problem a checklist would create.
 *
 * A recommendation is still only an ordering. Nothing is filtered out and nothing is hidden: a
 * profile that has never touched this lot sits below the ones that have, one click away.
 *
 * Legacy `metadata.beanLotIds` values are dropped by `normalizeProfile` on read, so an archive
 * exported before 0.7.0 loads without error and simply stops carrying the retired field.
 */

export interface ProfileUsage {
  profileId: string
  lastUsedAt: string
  useCount: number
}

/** Every profile ever used with this bean lot, most recently used first. */
export const profileUsageForBean = (runs: RoastRun[], beanLotId?: string): ProfileUsage[] => {
  if (!beanLotId) return []
  const usage = new Map<string, ProfileUsage>()
  for (const run of runs) {
    if (run.beanLotId !== beanLotId) continue
    const profileId = run.profile.id
    const existing = usage.get(profileId)
    if (!existing) usage.set(profileId, { profileId, lastUsedAt: run.startedAt, useCount: 1 })
    else
      usage.set(profileId, {
        profileId,
        lastUsedAt: existing.lastUsedAt.localeCompare(run.startedAt) >= 0 ? existing.lastUsedAt : run.startedAt,
        useCount: existing.useCount + 1,
      })
  }
  return [...usage.values()].sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
}

export interface RecommendedProfile {
  profile: Profile
  recommended: boolean
  lastUsedAt?: string
  useCount: number
}

/**
 * Profiles used with this lot first, most recent first; everything else after in the order it
 * arrived, so the tail never reshuffles for a reason the reader cannot see.
 */
export const recommendedProfileOrder = (
  profiles: Profile[],
  runs: RoastRun[],
  beanLotId?: string,
): RecommendedProfile[] => {
  const usage = new Map(profileUsageForBean(runs, beanLotId).map((entry) => [entry.profileId, entry]))
  const marked = profiles.map((profile) => {
    const used = usage.get(profile.id)
    return { profile, recommended: Boolean(used), lastUsedAt: used?.lastUsedAt, useCount: used?.useCount ?? 0 }
  })
  const recommended = marked
    .filter((entry) => entry.recommended)
    .sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''))
  return [...recommended, ...marked.filter((entry) => !entry.recommended)]
}

/** Every roast ever run with a given bean lot, newest first. */
export const runsForBean = (runs: RoastRun[], beanLotId?: string): RoastRun[] =>
  beanLotId === undefined
    ? []
    : runs.filter((run) => run.beanLotId === beanLotId).sort((a, b) => b.startedAt.localeCompare(a.startedAt))

/** Every roast ever run from a given profile, newest first, whichever revision it used. */
export const runsForProfile = (runs: RoastRun[], profileId?: string): RoastRun[] =>
  profileId === undefined
    ? []
    : runs.filter((run) => run.profile.id === profileId).sort((a, b) => b.startedAt.localeCompare(a.startedAt))

/** The mass to default a new roast (or a simulation) to: whatever was last actually roasted. */
export const lastRoastedMassG = (runs: RoastRun[], fallbackG = 225): number => {
  const recent = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  return recent.find((run) => (run.measurements?.startingMassG ?? 0) > 0)?.measurements?.startingMassG ?? fallbackG
}
