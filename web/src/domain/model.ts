import { minimumFanForHeat } from './actuatorFloors'
import { formatLocalDateTime } from './dateTime'
import { journeyPoints } from './journeyEdit'
import type {
  BeanLot,
  Profile,
  RoastRun,
  TelemetrySample,
  ThermalIntent,
  ThermalSegment,
  TimedPoint,
  TimedProfile,
} from './types'

export const clampLevel = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(10, Math.max(0.1, Math.round(value * 10) / 10))
}

export const formatClock = (seconds: number) => {
  const safe = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(safe / 60)
  return `${minutes}:${String(safe % 60).padStart(2, '0')}`
}

/**
 * The roast boundary in a manual recording.
 *
 * Stop is allowed after an operator has already set Heat to zero and watched a long cooling tail.
 * In that case the Stop acknowledgement is the end of control, not the end of roasting. The
 * immutable thermal series says where roasting actually ended: the first sample in the final
 * heat-off suffix. A recording with no such suffix falls back to the controller's Stop boundary.
 */
export const manualRoastDurationSec = (
  samples: Pick<TelemetrySample, 'elapsedSec' | 'effectiveHeat'>[],
  stoppedElapsedSec?: number,
): number => {
  let lastHeatedIndex = -1
  for (const [index, sample] of samples.entries()) {
    if ((sample.effectiveHeat ?? 0) > 0) lastHeatedIndex = index
  }
  if (lastHeatedIndex >= 0 && lastHeatedIndex + 1 < samples.length) {
    return Math.max(0, samples[lastHeatedIndex + 1].elapsedSec)
  }
  return stoppedElapsedSec !== undefined && Number.isFinite(stoppedElapsedSec) && stoppedElapsedSec >= 0
    ? stoppedElapsedSec
    : (samples.at(-1)?.elapsedSec ?? 0)
}

/** Roast duration excludes the cooling/decay tail retained in a completed manual recording. */
export const runDurationSec = (run: Pick<RoastRun, 'samples' | 'manualRoast'>): number =>
  run.manualRoast
    ? manualRoastDurationSec(run.samples, run.manualRoast.stoppedElapsedSec)
    : (run.samples.at(-1)?.elapsedSec ?? 0)

export const parseClock = (value: string) => {
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  const match = /^(\d+):([0-5]?\d)$/.exec(trimmed)
  if (!match) return undefined
  return Number(match[1]) * 60 + Number(match[2])
}

export const coolingStartSec = (profile: TimedProfile) => {
  const firstCoolingPoint = [...profile.points].sort((a, b) => a.timeSec - b.timeSec).find((point) => point.heat === 0)
  return firstCoolingPoint?.timeSec
}

export const timedDuration = (profile: TimedProfile) => {
  if (profile.points.length === 0) return 0
  const last = [...profile.points].sort((a, b) => a.timeSec - b.timeSec).at(-1)
  const coolDurationSec = Number.isFinite(profile.coolDurationSec) ? profile.coolDurationSec : 0
  return Math.max((last?.timeSec ?? 0) + coolDurationSec, 1)
}

const emptyPoint: TimedPoint = { id: 'empty', timeSec: 0, fan: 0, heat: 0 }

export const valuesAt = (profile: TimedProfile, elapsedSec: number): TimedPoint => {
  if (profile.points.length === 0) return emptyPoint
  const sorted = [...profile.points].sort((a, b) => a.timeSec - b.timeSec)
  return sorted.reduce((current, point) => (point.timeSec <= elapsedSec ? point : current), sorted[0])
}

/**
 * The requested pair on the public 0.1 grid, and what the roaster will actually drive for it. Heat
 * on means Fan 1.0 or higher - the same floor the firmware and `actuatorFloors.effectiveLevels`
 * apply. Flooring at 0.1 instead would simulate heat-on steps at airflow the device never uses.
 */
export const effectiveLevels = (fan: number, heat: number) => {
  const requestedFan = clampLevel(fan)
  const requestedHeat = clampLevel(heat)
  if (requestedHeat === 0) return { requestedFan, requestedHeat, effectiveFan: requestedFan, effectiveHeat: 0 }
  const minimumFan = minimumFanForHeat(requestedHeat)
  return {
    requestedFan,
    requestedHeat,
    effectiveFan: Math.max(requestedFan, minimumFan),
    effectiveHeat: requestedHeat,
  }
}

/*
 * `phaseFromEvents` was removed in 0.7.0.
 *
 * It derived a roast phase by asking whether a crack or dry-end marker had been recorded,
 * which made an operator's annotation an input to a computed value. Crack and dry-end markers are
 * observations a person writes down; they are not measurements, they are not detected, and nothing
 * in this app may compute from them. The function was already unreferenced, so removing it costs
 * nothing and closes the door.
 *
 * Annotations still travel with a roast, are still drawn on the chart, and are still preserved by
 * `compressTelemetry` as retained sample points. Preserving a point is not consuming it.
 */

// The mass comes from the roast being set up, not from the profile: a recipe does not have a batch
// size, a roast does.
export const automaticRunName = (profile: Profile, date = new Date(), beanLot?: BeanLot, massG?: number) => {
  const started = formatLocalDateTime(date)
  const bean = beanLot ? beanLot.name.trim() || beanLot.origins[0] || 'Coffee' : 'Coffee'
  const mass = massG !== undefined && Number.isFinite(massG) && massG > 0 ? `${massG} g` : ''
  return [started, bean, mass, profile.metadata.intent].filter(Boolean).join(' / ')
}

export const resolveRunName = (
  customName: string | undefined,
  profile: Profile,
  date = new Date(),
  beanLot?: BeanLot,
  massG?: number,
) => customName?.trim() || automaticRunName(profile, date, beanLot, massG)

/**
 * Repair the two legacy automatic-name forms without touching a user-authored name. Older builds
 * prefixed the lot with its first origin; one manual path also repeated that origin instead of the
 * lot name. A correction is safe only when the stored bean snapshot proves the intended suffix.
 */
export const correctedLegacyRunName = (run: Pick<RoastRun, 'name' | 'beanLotSnapshot'>): string => {
  const lot = run.beanLotSnapshot
  const lotName = lot?.name.trim()
  const origin = lot?.origins[0]?.trim()
  if (!lotName || !origin || lotName === origin) return run.name

  const redundantComposite = `${origin} ${lotName}`
  if (run.name.includes(redundantComposite)) {
    return run.name.replace(redundantComposite, lotName)
  }
  const repeatedOrigin = `${origin} ${origin}`
  if (lotName.startsWith(`${origin} `) && run.name.endsWith(repeatedOrigin)) {
    return `${run.name.slice(0, -repeatedOrigin.length)}${lotName}`
  }
  return run.name
}
export const effectiveCoolingTargetC = (requestedTargetC: number, ambientC = 24.5, marginC = 5) =>
  Math.max(requestedTargetC, ambientC + Math.max(0, marginC))

/**
 * The control law's hold band (`ZONE_HOLD_EPSILON_C` in journeyControl.ts, duplicated here because
 * journeyControl imports this module): a zone whose span is within it is solved as a HEATED hold,
 * and only a span below its negative is a cooling zone.
 */
const COOLING_SPAN_EPSILON_C = 0.5

/** Whether a zone, as authored, is a cooling zone in the control law's own terms. */
export const isAuthoredCoolingZone = (segment: { startC: number; endC: number }) =>
  segment.endC - segment.startC < -COOLING_SPAN_EPSILON_C

/**
 * The journey as it will actually be run: every cooling endpoint lifted to ambient plus the margin,
 * and every later zone relinked to start where the lifted zone now ends.
 *
 * Lifting an end without relinking the next start would turn an authored cooling zone into a
 * HEATED one: 25->200, 200->28, 28->20 would become 200->29.5 | 28->29.5, and the last zone would run
 * the heating solve (Heat 3.5 at Fan 10 in simulation). So a zone authored as cooling can never become
 * heated: once lifted and relinked, a cooling zone whose span has collapsed into the hold band (it
 * starts at or below where it may end) becomes an exact hold at its start with its Heat band forced
 * to 0 - an unheated full-airflow dwell for the authored duration, never a heated hold. Zone count,
 * order and durations are preserved, so zone indices still line up with the authored profile.
 */
export const effectiveThermalIntent = (intent: ThermalIntent, ambientC = 24.5, marginC = 5): ThermalIntent => {
  const segments: ThermalSegment[] = []
  for (const [index, segment] of intent.segments.entries()) {
    const startC = index === 0 ? segment.startC : segments[index - 1].endC
    if (!isAuthoredCoolingZone(segment)) {
      segments.push(index === 0 ? segment : { ...segment, startC })
      continue
    }
    const endC = effectiveCoolingTargetC(segment.endC, ambientC, marginC)
    segments.push(
      endC - startC < -COOLING_SPAN_EPSILON_C
        ? { ...segment, startC, endC }
        : { ...segment, startC, endC: startC, heatMin: 0, heatMax: 0 },
    )
  }
  return { ...intent, segments }
}

/**
 * The nominal zone path: exactly what the profile editor's chart draws, because it is literally the
 * same function. Two implementations of "where does this journey go" is what let the simulation
 * chart draw a straight line while the editor drew the real shape, so there is now one.
 */
export const targetPoints = (intent: ThermalIntent) =>
  journeyPoints(intent.segments).map((point) => ({ timeSec: point.timeSec, temperatureC: point.temperatureC }))

export const targetTemperatureAt = (intent: ThermalIntent, elapsedSec: number) => {
  const points = targetPoints(intent)
  if (points.length === 0) return undefined
  if (elapsedSec <= points[0].timeSec) return points[0].temperatureC
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]
    const current = points[index]
    if (elapsedSec <= current.timeSec) {
      const span = Math.max(1, current.timeSec - previous.timeSec)
      const progress = (elapsedSec - previous.timeSec) / span
      return previous.temperatureC + (current.temperatureC - previous.temperatureC) * progress
    }
  }
  return points.at(-1)?.temperatureC
}

export const adaptiveTargetPoints = (
  intent: ThermalIntent,
  samples: TelemetrySample[],
  elapsedSec: number,
  ambientC = 24.5,
  coolingMarginC = 5,
) => {
  const effectiveIntent = effectiveThermalIntent(intent, ambientC, coolingMarginC)
  const completions = thermalZoneCompletions(effectiveIntent, samples, ambientC, coolingMarginC)
  const points = [{ timeSec: 0, temperatureC: effectiveIntent.segments[0]?.startC ?? ambientC }]
  let zoneStartSec = 0
  for (const [index, segment] of effectiveIntent.segments.entries()) {
    const completion = completions[index]
    const plannedEnd = zoneStartSec + Math.max(1, segment.durationSec)
    const timeSec =
      completion?.elapsedSec ?? (index === completions.length ? Math.max(plannedEnd, elapsedSec) : plannedEnd)
    points.push({ timeSec, temperatureC: segment.endC })
    zoneStartSec = timeSec
  }
  return points
}

export const adaptiveTargetTemperatureAt = (
  intent: ThermalIntent,
  samples: TelemetrySample[],
  elapsedSec: number,
  ambientC = 24.5,
  coolingMarginC = 5,
) => {
  const effectiveIntent = effectiveThermalIntent(intent, ambientC, coolingMarginC)
  const completions = thermalZoneCompletions(effectiveIntent, samples, ambientC, coolingMarginC)
  const zoneIndex = Math.min(completions.length, effectiveIntent.segments.length - 1)
  const zone = effectiveIntent.segments[zoneIndex]
  if (!zone) return undefined
  const previous = zoneIndex === 0 ? undefined : completions[zoneIndex - 1]
  // The next zone is re-anchored to the previous measured completion, exactly as the simulation does.
  const zoneStartSec = previous?.elapsedSec ?? 0
  const zoneStartC = previous?.temperatureC ?? zone.startC
  const progress = Math.max(0, Math.min(1, (elapsedSec - zoneStartSec) / Math.max(1, zone.durationSec)))
  return zoneStartC + (zone.endC - zoneStartC) * progress
}

export const normalizeThermalContinuity = (intent: ThermalIntent): ThermalIntent => ({
  ...intent,
  segments: intent.segments.map((segment, index, segments) =>
    index === 0 ? segment : { ...segment, startC: segments[index - 1].endC },
  ),
})
export const thermalZoneCompletions = (
  intent: ThermalIntent,
  samples: TelemetrySample[],
  ambientC = 24.5,
  coolingMarginC = 5,
) => {
  const effectiveIntent = effectiveThermalIntent(intent, ambientC, coolingMarginC)
  const completions: Array<{
    zoneId: string
    zoneIndex: number
    elapsedSec: number
    temperatureC: number
    plannedTimeSec: number
  }> = []
  let searchIndex = 0
  let plannedTimeSec = 0
  for (const [zoneIndex, segment] of effectiveIntent.segments.entries()) {
    plannedTimeSec += segment.durationSec
    const ascending = segment.endC >= segment.startC
    const foundIndex = samples.findIndex(
      (sample, index) =>
        index >= searchIndex && (ascending ? sample.beanTempC >= segment.endC : sample.beanTempC <= segment.endC),
    )
    if (foundIndex < 0) break
    const sample = samples[foundIndex]
    const previous = samples[Math.max(0, foundIndex - 1)]
    const deltaC = sample.beanTempC - previous.beanTempC
    const fraction =
      foundIndex > 0 && Math.abs(deltaC) > 0.001
        ? Math.max(0, Math.min(1, (segment.endC - previous.beanTempC) / deltaC))
        : 1
    const elapsedSec = previous.elapsedSec + (sample.elapsedSec - previous.elapsedSec) * fraction
    completions.push({ zoneId: segment.id, zoneIndex, elapsedSec, temperatureC: segment.endC, plannedTimeSec })
    searchIndex = foundIndex
  }
  return completions
}
export const profileFromRun = (run: RoastRun): TimedProfile | undefined => {
  if (run.profile.strategy !== 'timed') return undefined
  const activeSamples = run.samples.filter(
    (sample) => sample.phase !== 'COOLING' && sample.phase !== 'COMPLETE' && sample.phase !== 'ABORTED',
  )
  if (activeSamples.length === 0) return undefined
  const points: TimedPoint[] = []
  for (const sample of activeSamples) {
    const previous = points.at(-1)
    const fan = clampLevel(sample.requestedFan)
    const heat = clampLevel(sample.requestedHeat)
    if (previous && previous.fan === fan && previous.heat === heat) continue
    points.push({
      id: `point-${points.length}-${Math.round(sample.elapsedSec * 10)}`,
      timeSec: Math.round(sample.elapsedSec),
      fan,
      heat,
    })
  }
  const now = new Date().toISOString()
  return {
    ...structuredClone(run.profile),
    revision: run.profile.revision + 1,
    updatedAt: now,
    points,
  }
}

export const latestSample = (samples: TelemetrySample[]) => samples.at(-1)
export interface CompressionPolicy {
  maximumGapSec: number
  temperatureDeltaC: number
  rorDeltaCPerMin: number
  actuatorDelta: number
}

export const defaultCompressionPolicy: CompressionPolicy = {
  maximumGapSec: 15,
  temperatureDeltaC: 1.1,
  rorDeltaCPerMin: 0.75,
  actuatorDelta: 0.5,
}

export const compressTelemetry = (
  samples: TelemetrySample[],
  eventTimes: number[] = [],
  policy = defaultCompressionPolicy,
) => {
  if (samples.length <= 2) return samples
  const retained: TelemetrySample[] = [samples[0]]
  for (let index = 1; index < samples.length - 1; index += 1) {
    const sample = samples[index]
    const previous = retained.at(-1)!
    const eventNearby = eventTimes.some((time) => Math.abs(time - sample.elapsedSec) < 0.51)
    const significant =
      sample.elapsedSec - previous.elapsedSec >= policy.maximumGapSec ||
      Math.abs(sample.beanTempC - previous.beanTempC) >= policy.temperatureDeltaC ||
      Math.abs(sample.rorCPerMin - previous.rorCPerMin) >= policy.rorDeltaCPerMin ||
      Math.abs(sample.effectiveFan - previous.effectiveFan) >= policy.actuatorDelta ||
      Math.abs(sample.effectiveHeat - previous.effectiveHeat) >= policy.actuatorDelta ||
      sample.phase !== previous.phase ||
      eventNearby
    if (significant) retained.push(sample)
  }
  retained.push(samples.at(-1)!)
  return retained
}
