import { stableEquals } from './draft'
import { formatClock } from './model'
import type {
  BeanLot,
  Profile,
  ProfileRevision,
  ThermalIntent,
  ThermalSegment,
  TimedPoint,
  TimedProfile,
} from './types'

/**
 * Dirty tracking and revision summaries for the two catalogs.
 *
 * Both questions are the same comparison read two ways: "is this draft different from what is
 * stored" gates the leave-without-saving prompt, and "how is it different" becomes the one-line
 * summary in the revision history. Deriving both from one deep compare is what stops the prompt
 * firing on a profile nobody touched.
 *
 * `updatedAt` and `revision` move on every save and say nothing about whether the operator edited
 * anything, so they are excluded from both.
 */
/** One wording for the guard, wherever it is raised: internal navigation or a closing tab. */
export const LEAVE_WITHOUT_SAVING = 'Leave without saving changes?'

export const VOLATILE_PROFILE_KEYS = ['updatedAt', 'revision'] as const
export const VOLATILE_BEAN_KEYS = ['updatedAt'] as const

export const profileIsDirty = (draft: Profile, stored?: Profile): boolean =>
  !stored || !stableEquals(draft, stored, VOLATILE_PROFILE_KEYS)

export const beanIsDirty = (draft: BeanLot, stored?: BeanLot): boolean =>
  !stored || !stableEquals(draft, stored, VOLATILE_BEAN_KEYS)

/**
 * ==============================================================================================
 * RESTORING A REVISION - a load, not a rewrite
 * ==============================================================================================
 *
 * Requirement: clicking a revision reverts the profile to that version, and if unsaved changes would
 * be lost, the same are-you-sure prompt appears.
 *
 * Two rules make that safe, and both live here rather than in the editor, so neither can be lost in
 * a re-layout of the table that offers the gesture:
 *
 *   - **History is append-only.** A revision snapshot carries the number it was saved as. Loading it
 *     verbatim would leave the editor holding revision 2 of a profile that is on revision 7, and the
 *     next save - which counts up from whatever the draft says - would mint a SECOND revision 2 and
 *     bury the six saves in between. So the content comes from the snapshot and the identity comes
 *     from the profile as it stands today: restoring is an edit, and like every other edit it becomes
 *     a new revision on top when it is saved. Nothing is ever rewritten or dropped.
 *   - **A dirty draft is never discarded silently.** Same guard, same wording, as leaving the screen
 *     with unsaved work. The confirm is injected rather than reached for, which is what makes both
 *     answers testable without a browser.
 *
 * `restoreRevision` returning `undefined` means the operator said no and nothing should happen.
 */
export const profileFromRevision = (revision: ProfileRevision, current: Profile): Profile => ({
  ...structuredClone(revision.profile),
  id: current.id,
  revision: current.revision,
  createdAt: current.createdAt,
  updatedAt: current.updatedAt,
})

export const restoreRevision = (
  revision: ProfileRevision,
  current: Profile,
  dirty: boolean,
  confirm: (message: string) => boolean,
): Profile | undefined => (dirty && !confirm(LEAVE_WITHOUT_SAVING) ? undefined : profileFromRevision(revision, current))

/*
 * ==============================================================================================
 * WHAT IT WAS, AND WHAT IT BECAME
 * ==============================================================================================
 *
 * Requirement: "what changed" states exactly what was and what it became, not only which field
 * changed.
 *
 * A history row that says `notes edited` or `Changed origins, notes` is an index, not a record: it
 * tells you a save touched something and then makes you load the revision to find out what. Every
 * summary below therefore carries both sides of the move - `Heat step 3: 5.0 → 6.5` - and that rule
 * has no exceptions - not a bean's fields, a profile's name, a zone that was added or removed, or
 * free text.
 *
 * THREE THINGS THAT MAKE IT READABLE RATHER THAN EXHAUSTIVE.
 *   - Free text is truncated on the way in, at `TEXT_LIMIT`, so a four-thousand-character notes
 *     field becomes `notes "Reliable." → "Reliable, with more development a..."` and not a wall.
 *   - An absent or empty value is `(none)` rather than `""`, because an empty pair of quotes is
 *     indistinguishable from a value nobody can see.
 *   - The whole line is still capped at `MAX_PARTS` and counts the rest, which is what stops a
 *     sweeping edit from turning one table row into a paragraph.
 */
const MAX_PARTS = 6
const TEXT_LIMIT = 40
const ARROW = ' → '

const level = (value: number) => value.toFixed(1)
const degrees = (value: number) => `${Number(value.toFixed(1))} °C`
const byTime = (a: TimedPoint, b: TimedPoint) => a.timeSec - b.timeSec
const moved = (label: string, from: string, to: string) => `${label} ${from}${ARROW}${to}`

/**
 * A value as it appears in a summary: shortened, never a bare `""`, and quoted only when quoting
 * says something. A measurement is not prose - `green density "0.55" → "0.61"` reads as two labels
 * where `green density 0.55 → 0.61` reads as a reading that moved, which is what it is.
 */
const quoted = (value: unknown): string => {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '(none)'
  const text = Array.isArray(value) ? value.join(', ') : value === undefined || value === null ? '' : String(value)
  if (text.trim() === '') return '(none)'
  return text.length > TEXT_LIMIT ? `"${text.slice(0, TEXT_LIMIT).trimEnd()}..."` : `"${text}"`
}

const textChanges = (label: string, from: unknown, to: unknown): string[] =>
  stableEquals(from ?? '', to ?? '') ? [] : [moved(label, quoted(from), quoted(to))]

const condense = (parts: string[]): string => {
  if (parts.length === 0) return 'Saved with no field changes'
  if (parts.length <= MAX_PARTS) return parts.join('; ')
  const extra = parts.length - MAX_PARTS
  return `${parts.slice(0, MAX_PARTS).join('; ')}; and ${extra} more change${extra === 1 ? '' : 's'}`
}

const pointAt = (point: TimedPoint) =>
  `${formatClock(point.timeSec)}, fan ${level(point.fan)}, heat ${level(point.heat)}`

const timedChanges = (previous: TimedProfile, next: TimedProfile): string[] => {
  const before = [...previous.points].sort(byTime)
  const after = [...next.points].sort(byTime)
  const parts: string[] = []
  for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
    const from = before[index]
    const to = after[index]
    if (!from) {
      parts.push(`step ${index + 1} added (${pointAt(to)})`)
      continue
    }
    if (!to) {
      parts.push(`step ${index + 1} removed (was ${pointAt(from)})`)
      continue
    }
    if (from.fan !== to.fan) parts.push(moved(`Fan step ${index + 1}:`, level(from.fan), level(to.fan)))
    if (from.heat !== to.heat) parts.push(moved(`Heat step ${index + 1}:`, level(from.heat), level(to.heat)))
    if (from.timeSec !== to.timeSec)
      parts.push(moved(`step ${index + 1} at`, formatClock(from.timeSec), formatClock(to.timeSec)))
  }
  if (previous.coolDurationSec !== next.coolDurationSec)
    parts.push(moved('cool duration', formatClock(previous.coolDurationSec), formatClock(next.coolDurationSec)))
  if (previous.coolFan !== next.coolFan) parts.push(moved('cool fan', level(previous.coolFan), level(next.coolFan)))
  return parts
}

const zoneSpan = (segment: ThermalSegment) =>
  `${degrees(segment.startC)}${ARROW}${degrees(segment.endC)} over ${formatClock(segment.durationSec)}`

const zoneChanges = (previous: ThermalIntent, next: ThermalIntent): string[] => {
  const before: ThermalSegment[] = previous.segments
  const after: ThermalSegment[] = next.segments
  const parts: string[] = []
  for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
    const from = before[index]
    const to = after[index]
    if (!from) {
      parts.push(`zone ${index + 1} added (${zoneSpan(to)})`)
      continue
    }
    if (!to) {
      parts.push(`zone ${index + 1} removed (was ${zoneSpan(from)})`)
      continue
    }
    if (from.startC !== to.startC)
      parts.push(moved(`zone ${index + 1} start`, degrees(from.startC), degrees(to.startC)))
    if (from.endC !== to.endC) parts.push(moved(`zone ${index + 1} end`, degrees(from.endC), degrees(to.endC)))
    if (from.durationSec !== to.durationSec)
      parts.push(moved(`zone ${index + 1} duration`, formatClock(from.durationSec), formatClock(to.durationSec)))
    if (from.fanMin !== to.fanMin || from.fanMax !== to.fanMax)
      parts.push(
        moved(
          `zone ${index + 1} fan limits`,
          `${level(from.fanMin)}-${level(from.fanMax)}`,
          `${level(to.fanMin)}-${level(to.fanMax)}`,
        ),
      )
    if (from.heatMin !== to.heatMin || from.heatMax !== to.heatMax)
      parts.push(
        moved(
          `zone ${index + 1} heat limits`,
          `${level(from.heatMin)}-${level(from.heatMax)}`,
          `${level(to.heatMin)}-${level(to.heatMax)}`,
        ),
      )
  }
  if (previous.calibrationStatus !== next.calibrationStatus)
    parts.push(moved('calibration', previous.calibrationStatus, next.calibrationStatus))
  return parts
}

/** One line describing what a save actually changed, for the revision history table. */
export const summarizeProfileChange = (previous: Profile, next: Profile): string => {
  const parts: string[] = [
    ...textChanges('name', previous.name, next.name),
    ...(previous.strategy === next.strategy ? [] : [moved('strategy', previous.strategy, next.strategy)]),
    ...textChanges('intent', previous.metadata.intent, next.metadata.intent),
    ...textChanges('notes', previous.notes, next.notes),
  ]
  if (previous.strategy === 'timed' && next.strategy === 'timed') parts.push(...timedChanges(previous, next))
  else if (previous.strategy === 'thermal-intent' && next.strategy === 'thermal-intent')
    parts.push(...zoneChanges(previous, next))
  return condense(parts)
}

const BEAN_FIELDS: Array<{ key: keyof BeanLot; label: string }> = [
  { key: 'name', label: 'name' },
  { key: 'origins', label: 'origins' },
  { key: 'lotId', label: 'lot ID' },
  { key: 'species', label: 'species' },
  { key: 'cultivars', label: 'cultivars' },
  { key: 'process', label: 'process' },
  { key: 'greenDensityGPerMl', label: 'green density' },
  { key: 'moisturePercent', label: 'moisture' },
  { key: 'notes', label: 'notes' },
]

/** Bean lots read exactly like profiles now: the field, what it was, and what it became. */
export const summarizeBeanChange = (previous: BeanLot, next: BeanLot): string =>
  condense(BEAN_FIELDS.flatMap((field) => textChanges(field.label, previous[field.key], next[field.key])))
