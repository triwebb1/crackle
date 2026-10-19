import type { Profile, RoastRun } from './types'

export interface ParsedArchive {
  format: 'crackle-history' | 'crackle-profiles'
  runs: RoastRun[]
  profiles: Profile[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const hasId = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && typeof value.id === 'string' && value.id.trim().length > 0

const isProfile = (value: unknown): value is Profile => {
  if (!hasId(value) || typeof value.name !== 'string' || !isRecord(value.metadata)) return false
  if (value.strategy === 'timed') return Array.isArray(value.points)
  if (value.strategy === 'thermal-intent') return Array.isArray(value.segments)
  return false
}

const isRun = (value: unknown): value is RoastRun =>
  hasId(value) &&
  typeof value.name === 'string' &&
  typeof value.startedAt === 'string' &&
  Array.isArray(value.samples) &&
  Array.isArray(value.events) &&
  isProfile(value.profile)

export const parseArchive = (source: string): ParsedArchive => {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw new Error('That file is not valid JSON')
  }
  if (!isRecord(parsed)) throw new Error('That file is not a Crackle export')
  const format = parsed.format
  if (format !== 'crackle-history' && format !== 'crackle-profiles')
    throw new Error('That file is not a Crackle history or profile export')
  if (
    typeof parsed.version !== 'number' ||
    !Number.isFinite(parsed.version) ||
    parsed.version < 1 ||
    parsed.version > 2
  ) {
    throw new Error('That export uses an unsupported archive version')
  }
  const rawRuns = format === 'crackle-history' ? parsed.runs : []
  const rawProfiles = format === 'crackle-profiles' ? parsed.profiles : []
  if (!Array.isArray(rawRuns) || !Array.isArray(rawProfiles))
    throw new Error('That export is missing its records array')
  const runs = rawRuns.filter(isRun)
  const profiles = rawProfiles.filter(isProfile)
  if (runs.length !== rawRuns.length || profiles.length !== rawProfiles.length)
    throw new Error('That export contains records Crackle cannot read')
  if (runs.length === 0 && profiles.length === 0) throw new Error('That export contains no records')
  return { format, runs, profiles }
}

export const collisionsById = <T extends { id: string }>(existing: T[], imported: T[]) => {
  const known = new Set(existing.map((record) => record.id))
  return imported.filter((record) => known.has(record.id))
}

export const mergeById = <T extends { id: string }>(existing: T[], imported: T[], replaceExisting: boolean) => {
  const merged = [...existing]
  const added: T[] = []
  const replaced: T[] = []
  for (const record of imported) {
    const index = merged.findIndex((candidate) => candidate.id === record.id)
    if (index < 0) {
      merged.push(record)
      added.push(record)
      continue
    }
    if (!replaceExisting) continue
    merged[index] = record
    replaced.push(record)
  }
  return { merged, added, replaced }
}
