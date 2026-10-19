import { ROAST_LIMITS } from './roastProgram'
import type {
  ArchivedPlanChange,
  ManualRoastChange,
  RoastEvent,
  RoastRun,
  TelemetrySample,
  TimedPoint,
  TimedProfile,
} from './types'

export const MANUAL_PROFILE_DEFAULT_COOL_FAN = 9
export const MANUAL_PROFILE_DEFAULT_COOL_SECONDS = 90

const fnv1a64 = (value: string): string => {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, '0')
}

/**
 * One controller session has one run document, regardless of which browser first observes it.
 *
 * Run ids are controller path segments limited to 24 `[A-Za-z0-9._-]` characters. Hashing the
 * length-prefixed identity keeps arbitrary controller ids safe and the resulting `manual-` id at
 * 23 characters. This is stable identity, not a security boundary.
 */
export const manualRoastRunId = (bootId?: string, sessionId?: string): string | undefined => {
  if (!bootId?.trim() || !sessionId?.trim()) return undefined
  return `manual-${fnv1a64(`${bootId.length}:${bootId}${sessionId.length}:${sessionId}`)}`
}

/**
 * Fold the roaster-observed step events into a browser's own journaled events.
 *
 * The session document journals only this browser's own acknowledged Applies, and the batched
 * Controls-history meta document cannot sync while the firmware's flash-write idle gate holds. The
 * commanded levels in live status are therefore the one cross-browser record of accepted steps
 * during the roast. An own acknowledged Apply is journaled with the same accepted levels the
 * roaster then reports, so an observation matching a nearby journaled OVERRIDE is that same step,
 * not a second one; the tolerance absorbs status-poll latency between the two records.
 */
export const mergeDeviceManualEvents = (
  journaled: RoastEvent[],
  observed: RoastEvent[],
  toleranceSec = 5,
): RoastEvent[] => {
  if (observed.length === 0) return journaled
  const merged = [...journaled]
  for (const event of observed) {
    const owned = journaled.some(
      (candidate) =>
        candidate.type === 'OVERRIDE' &&
        candidate.label === event.label &&
        Math.abs(candidate.elapsedSec - event.elapsedSec) <= toleranceSec,
    )
    if (!owned) merged.push(event)
  }
  return merged.sort((left, right) => left.elapsedSec - right.elapsedSec)
}

export interface ManualProfileOptions {
  /** A caller saving more than one derivative may supply a fresh catalog id. */
  profileId?: string
  name?: string
  createdAt?: string
  coolFan?: number
  coolDurationSec?: number
}

interface NormalizedChange {
  timeSec: number
  fan: number
  heat: number
}

interface TimedSegment extends NormalizedChange {
  durationSec: number
}

const finite = (value: number) => typeof value === 'number' && Number.isFinite(value)
const quantizeLevel = (value: number) => Math.round(value * 10) / 10
const sameLevels = (left: NormalizedChange, right: NormalizedChange) =>
  left.fan === right.fan && left.heat === right.heat

const levelError = (change: ManualRoastChange, index: number): string | undefined => {
  const values = [change.requestedFan, change.requestedHeat, change.effectiveFan, change.effectiveHeat]
  if (!values.every(finite)) return `Manual change ${index + 1} has a non-numeric fan or heat level`
  if (values.some((value) => value < ROAST_LIMITS.level.min || value > ROAST_LIMITS.level.max)) {
    return `Manual change ${index + 1} has a fan or heat level outside 0.0 through 10.0`
  }
  if (change.requestedFan <= 0) return `Manual change ${index + 1} needs fan of at least 0.1`
  return undefined
}

/**
 * The effective actuator transitions recoverable from an old manual thermal recording.
 *
 * Those files do not carry the requested levels. Copying effective into requested is an explicit
 * statement of that limitation and is preferable to guessing what sat below a firmware fan floor.
 * A terminal 0:0 row is the actuator becoming idle, not an instruction, and is therefore omitted.
 */
/** Exact requested/effective instructions recovered from a codec-2 manual journal. */
export const manualChangesFromArchivedPlan = (
  journal: ArchivedPlanChange[],
  samples: TelemetrySample[],
): ManualRoastChange[] =>
  journal
    .filter((event): event is Extract<ArchivedPlanChange, { requestedFan: number }> => 'requestedFan' in event)
    .map((event, index) => {
      const temperature = [...samples]
        .sort(
          (left, right) => Math.abs(left.elapsedSec - event.elapsedSec) - Math.abs(right.elapsedSec - event.elapsedSec),
        )
        .at(0)?.beanTempC
      return {
        id: `manual-change-archived-${event.planRev}-${index}`,
        elapsedSec: event.elapsedSec,
        requestedFan: event.requestedFan,
        requestedHeat: event.requestedHeat,
        effectiveFan: event.effectiveFan,
        effectiveHeat: event.effectiveHeat,
        temperatureC: temperature,
        source: 'firmware' as const,
      }
    })

export const manualChangesFromSamples = (samples: TelemetrySample[]): ManualRoastChange[] => {
  const changes: ManualRoastChange[] = []
  for (const sample of [...samples].sort((a, b) => a.elapsedSec - b.elapsedSec)) {
    if (![sample.elapsedSec, sample.effectiveFan, sample.effectiveHeat].every(finite)) continue
    if (sample.effectiveFan === 0 && sample.effectiveHeat === 0) continue
    const previous = changes.at(-1)
    if (previous && previous.effectiveFan === sample.effectiveFan && previous.effectiveHeat === sample.effectiveHeat)
      continue
    changes.push({
      id: `manual-change-imported-${changes.length}-${Math.round(sample.elapsedSec * 10)}`,
      elapsedSec: sample.elapsedSec,
      requestedFan: sample.effectiveFan,
      requestedHeat: sample.effectiveHeat,
      effectiveFan: sample.effectiveFan,
      effectiveHeat: sample.effectiveHeat,
      temperatureC: sample.beanTempC,
      source: 'firmware',
    })
  }
  return changes
}

const normalizedChanges = (run: RoastRun): NormalizedChange[] | string => {
  const changes = run.manualRoast?.changes
  if (!changes || changes.length === 0) return 'This manual roast has no accepted control changes to save'
  const stopped = run.manualRoast?.stoppedElapsedSec
  if (!finite(stopped as number) || (stopped as number) <= 0) return 'This manual roast has no valid stop boundary'

  for (const [index, change] of changes.entries()) {
    if (!finite(change.elapsedSec) || change.elapsedSec < 0 || change.elapsedSec > (stopped as number)) {
      return `Manual change ${index + 1} falls outside the roast duration`
    }
    const badLevel = levelError(change, index)
    if (badLevel) return badLevel
  }

  const ordered = changes
    .map((change, index) => ({ change, index }))
    .sort((left, right) => left.change.elapsedSec - right.change.elapsedSec || left.index - right.index)
    .map(({ change }, index) => ({
      // The first accepted instruction starts the roast. Network acknowledgement delay must not
      // become a dead interval in the recipe made from it.
      timeSec: index === 0 ? 0 : Math.round(change.elapsedSec),
      fan: quantizeLevel(change.requestedFan),
      heat: quantizeLevel(change.requestedHeat),
    }))

  // A timed profile cannot express two instructions in one whole second. The last accepted one is
  // the state that survived that second, so it wins deterministically.
  const bySecond = new Map<number, NormalizedChange>()
  for (const change of ordered) bySecond.set(change.timeSec, change)
  const onePerSecond = [...bySecond.values()].sort((left, right) => left.timeSec - right.timeSec)

  // Re-applying the same levels renews the manual lease but does not change the recipe. The event
  // remains in `manualRoast.changes`; only the derived profile omits it.
  return onePerSecond.filter((change, index, values) => index === 0 || !sameLevels(change, values[index - 1]))
}

const splitSegments = (segments: TimedSegment[]): TimedSegment[] => {
  const split: TimedSegment[] = []
  for (const segment of segments) {
    let timeSec = segment.timeSec
    let remaining = segment.durationSec
    while (remaining > ROAST_LIMITS.stepSeconds.max) {
      split.push({ ...segment, timeSec, durationSec: ROAST_LIMITS.stepSeconds.max })
      timeSec += ROAST_LIMITS.stepSeconds.max
      remaining -= ROAST_LIMITS.stepSeconds.max
    }
    split.push({ ...segment, timeSec, durationSec: remaining })
  }
  return split
}

/**
 * Turn one completed manual roast into a NEW timed profile.
 *
 * The run is evidence and is never mutated. Exactness wins over convenience: when the controller's
 * 24-step program cannot carry the instruction path, this returns a reason rather than silently
 * thinning or moving it.
 */
export const profileFromManualRoast = (run: RoastRun, options: ManualProfileOptions = {}): TimedProfile | string => {
  if (run.manualRoast?.incomplete)
    return 'Wait for the controller recording to finish importing before saving this recovered roast as a profile'
  const normalized = normalizedChanges(run)
  if (typeof normalized === 'string') return normalized
  const stopSec = Math.round(run.manualRoast!.stoppedElapsedSec as number)
  if (normalized.length === 0 || stopSec <= normalized.at(-1)!.timeSec) {
    return 'The final manual instruction was not held for a full second before Stop'
  }

  const segments: TimedSegment[] = normalized.map((change, index) => ({
    ...change,
    durationSec: (normalized[index + 1]?.timeSec ?? stopSec) - change.timeSec,
  }))
  if (segments.some((segment) => segment.durationSec < ROAST_LIMITS.stepSeconds.min)) {
    return 'Two manual instructions are too close together to become one-second profile steps'
  }

  if (segments.at(-1)!.heat > 0) {
    const fan = quantizeLevel(options.coolFan ?? MANUAL_PROFILE_DEFAULT_COOL_FAN)
    const durationSec = Math.round(options.coolDurationSec ?? MANUAL_PROFILE_DEFAULT_COOL_SECONDS)
    if (fan <= 0 || fan > ROAST_LIMITS.level.max) return 'The cooling fan must be between 0.1 and 10.0'
    if (durationSec < ROAST_LIMITS.stepSeconds.min) return 'The cooling step must run for at least one second'
    segments.push({ timeSec: stopSec, fan, heat: 0, durationSec })
  }

  const split = splitSegments(segments)
  if (split.length > ROAST_LIMITS.steps.max) {
    return `This manual roast makes ${split.length} timed steps; a profile can hold at most ${ROAST_LIMITS.steps.max}`
  }

  const points: TimedPoint[] = split.map((segment, index) => ({
    id: `manual-point-${run.id}-${index}-${segment.timeSec}`,
    timeSec: segment.timeSec,
    fan: segment.fan,
    heat: segment.heat,
  }))
  const last = split.at(-1)!
  const createdAt = options.createdAt ?? run.completedAt ?? run.startedAt
  return {
    id: options.profileId ?? `profile-from-${run.id}`,
    name: options.name?.trim() || `${run.name} profile`,
    revision: 1,
    strategy: 'timed',
    createdAt,
    updatedAt: createdAt,
    metadata: { intent: 'Manual roast' },
    notes: `Created from manual roast “${run.name}”.`,
    points,
    coolFan: last.fan,
    coolDurationSec: last.durationSec,
  }
}
