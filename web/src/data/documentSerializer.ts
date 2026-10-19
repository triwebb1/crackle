/**
 * ============================================================================================
 * THE DISK FORMAT: what a Crackle document looks like once it leaves the browser
 * ============================================================================================
 *
 * Everything the app owns now lives on the controller, under `/data`, as opaque payloads inside the
 * firmware's 16-byte `CDOC` envelope. The firmware never parses one - it owns identity, concurrency
 * and capacity and nothing else - so THIS module is the entire schema. Documents are minified JSON,
 * zlib-compressed, and Base64-wrapped so the firmware's text transport remains NUL-safe. If a shape
 * is wrong here it is wrong on the device, and no firmware release can rescue it.
 *
 * Two rules run through the whole file, and both exist because they were got wrong somewhere else
 * first.
 *
 * --------------------------------------------------------------------------------------------
 * 1. A MEASURED TEMPERATURE IS STORED IN TENTHS
 * --------------------------------------------------------------------------------------------
 *
 * The rule mirrors what the firmware does to archived recordings: the hundredths are for
 * RAM. The thermocouple is not accurate to 0.01 °C, and a stored `187.00` asserts hundredths the file
 * does not contain - every consumer downstream then believes them.
 *
 * Tenths rather than whole degrees, matching the archive's own **deci-degree** quantum (codec v3).
 * A 1 °C quantum is coarser than the instrument, and on the slow tail of a roast
 * - where the curve moves less than a degree a minute - it turns a smooth decay into a staircase:
 * every sample in a stretch rounds to the same integer, the rate of rise computed from it reads as
 * exactly zero, then jumps as the step is crossed. Tenths cost one character a sample and remove the
 * artefact entirely, and they make a browser-written document and a firmware-written recording agree
 * to the same quantum rather than to two.
 *
 * | | Precision on disk | Why |
 * | --- | --- | --- |
 * | Peak temperature, sample thermocouple/cold-junction readings, settled mesh temperatures, ambient | **tenths of a degree** | Measurements, at the archive's own quantum. |
 * | Fitted coefficients, R2, tau, fit RMS | full | Regression OUTPUT over many samples. Their digits are real. |
 * | Authored profile setpoints, zone endpoints, settle bands, cooling margins | full | Authored intent. 205.5 °C means 205.5 °C. |
 * | Fan and heat levels | one decimal | The step the controller can actually command. |
 * | Rate of rise | one decimal | A rate, not a reading. |
 *
 * RAM and the display keep every decimal they always had: serialization is a one-way narrowing at
 * the boundary, never a mutation of the record the app is holding. `diskTemperatureC` rounds half
 * AWAY FROM ZERO, exactly as `sr800_log_codec`'s `centiToDeciDegrees` does, so a browser-written
 * document and a firmware-written recording never disagree about a boundary case.
 *
 * Centralising it here is the point. A rounding rule applied in four screens is a rounding rule
 * applied in three.
 *
 * --------------------------------------------------------------------------------------------
 * 2. A DOCUMENT THAT DOES NOT FIT IS NOT A DOCUMENT
 * --------------------------------------------------------------------------------------------
 *
 * The firmware caps a collection at 12 KB and a run at 8 KB, and answers `413` rather than storing
 * a truncation. Crackle deliberately targets 8 KB per collection and 6 KB per run so compression
 * creates room for more records instead of immediately spending every saved byte on denser curves.
 * Every serializer sheds the most expendable thing until it reaches that target and says what it shed.
 * always the same class of thing: bulk history that the browser still holds and that nothing
 * structural depends on - old revision rows, old manual-log rows, sample density.
 *
 * **Run documents preserve a bounded fallback.** A controller-recorded run stores its recording id
 * plus a compact, downsampled series: `/logs/<id>.crk` remains the full-resolution archival copy,
 * while the fallback keeps History reviewable after retention removes that recording. Runs whose
 * samples exist nowhere else - demos and imported legacy archives - use the same bounded series.
 */

import { strFromU8, strToU8, unzlibSync, zlibSync } from 'fflate'
import { recordingKey, requireRecordedOn, requireRecordingOrigin, requireStorageAddress } from '../domain/provenance'
import type {
  BeanLot,
  BeanRevision,
  CalibrationCurve,
  CalibrationInheritedCoefficient,
  CalibrationRun,
  CalibrationSettings,
  CalibrationSnapshot,
  ManualEvent,
  Profile,
  ProfileRevision,
  RoastPhase,
  RoastRun,
  TelemetrySample,
  ThermalCoefficientField,
  ThermalSample,
} from '../domain/types'
import { decodeStoredPlanEnvelope } from './crkValidator'

/** The four collection names the firmware accepts, exactly, lower case, case sensitive. */
export const COLLECTIONS = ['profiles', 'beans', 'calibrations', 'meta'] as const
export type CollectionName = (typeof COLLECTIONS)[number]
/** A document address: a collection, or one run under `runs/<id>`. */
export type DocumentTarget = CollectionName | `runs/${string}`

export const COLLECTION_CAP_BYTES = 12 * 1024
export const RUN_CAP_BYTES = 8 * 1024
/**
 * Head-room kept under the firmware's hard cap. The cap is enforced on the byte count the device
 * receives; aiming for it exactly would make every rounding difference between this encoder and the
 * transport a `413`. Shedding half a kilobyte of the oldest history instead is free.
 */
export const CAP_MARGIN_BYTES = 512

export const byteLength = (payload: string) => new TextEncoder().encode(payload).length

/**
 * The only document wire format this pre-release application writes or reads.
 *
 * Base64 costs 4/3 of the compressed bytes, but keeps the request body inside the firmware's
 * existing C-string-safe transport. `zlib` is smaller on disk than gzip for these tiny independent
 * documents and still carries an integrity check.
 */
export const DOCUMENT_PREFIX = 'CRKZ1:'
export const RUN_TARGET_BYTES = 6 * 1024
export const COLLECTION_TARGET_BYTES = 8 * 1024

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const base64ToBytes = (encoded: string): Uint8Array => {
  const binary = atob(encoded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

/** Compress already-minified JSON into the exact ASCII payload stored by the controller. */
export const packDocumentJson = (json: string): string =>
  `${DOCUMENT_PREFIX}${bytesToBase64(zlibSync(strToU8(json), { level: 9 }))}`

/** Recover minified JSON from a controller payload. Uncompressed documents are intentionally invalid. */
export const unpackDocumentJson = (payload: string): string => {
  if (!payload.startsWith(DOCUMENT_PREFIX)) throw new Error('Not a compact Crackle document')
  try {
    return strFromU8(unzlibSync(base64ToBytes(payload.slice(DOCUMENT_PREFIX.length))))
  } catch {
    throw new Error('The compact Crackle document is damaged')
  }
}

const packed = (value: unknown): string => packDocumentJson(JSON.stringify(value))

// ------------------------------------------------------------------------------------- rounding

/** A measured temperature as it goes to disk: tenths of a degree, half away from zero. */
export const diskTemperatureC = (value: number): number =>
  ((value < 0 ? -1 : 1) * Math.round(Math.abs(value) * 10)) / 10

export const optionalDiskTemperatureC = (value: number | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? diskTemperatureC(value) : undefined

/** A commanded level, or any other rate the controller works in tenths of. */
export const diskLevel = (value: number): number => (Number.isFinite(value) ? Math.round(value * 10) / 10 : 0)

const optionalLevel = (value: number | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? diskLevel(value) : undefined

// -------------------------------------------------------------------------------------- fitting

/**
 * Keep `count` items spread evenly across the series, always including the last one.
 *
 * Even spacing rather than head-truncation, because a roast curve's shape is the information: the
 * first 200 samples of a 900-sample roast is a different roast, while every fourth sample is the
 * same roast at lower resolution.
 */
export const stridedSample = <T>(items: T[], count: number): T[] => {
  if (count >= items.length || count <= 0) return count <= 0 ? [] : [...items]
  const step = items.length / count
  const kept: T[] = []
  for (let index = 0; index < count; index += 1) kept.push(items[Math.floor(index * step)])
  kept[kept.length - 1] = items[items.length - 1]
  return kept
}

/**
 * Keep calibration actuator segments intact while reducing sample density.
 * Generic striding can erase the firmware's brief fan-on/heat-off tail and therefore a coefficient.
 */
export const calibrationSamples = (samples: ThermalSample[], count: number): ThermalSample[] => {
  if (count >= samples.length || count <= 0) return count <= 0 ? [] : [...samples]
  const segments: number[][] = []
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]
    const previous = samples[index - 1]
    if (
      !previous ||
      diskLevel(previous.effectiveFan) !== diskLevel(sample.effectiveFan) ||
      diskLevel(previous.effectiveHeat) !== diskLevel(sample.effectiveHeat)
    )
      segments.push([])
    segments.at(-1)!.push(index)
  }
  if (segments.length === 1) return stridedSample(samples, count)
  if (segments.length > count)
    return stridedSample(segments, count).map((segment) => {
      const readable = segment.find((index) => samples[index].thermocoupleC !== undefined)
      return samples[readable ?? segment[0]]
    })
  const minimum = count >= segments.length * 5 ? 5 : count >= segments.length * 2 ? 2 : 1
  const allocation = segments.map((segment) => Math.min(segment.length, minimum))
  let remaining = count - allocation.reduce((sum, value) => sum + value, 0)
  while (remaining > 0) {
    let chosen = -1
    let chosenScore = Number.NEGATIVE_INFINITY
    for (let index = 0; index < segments.length; index += 1) {
      if (allocation[index] >= segments[index].length) continue
      const score = Math.sqrt(segments[index].length) / Math.max(1, allocation[index])
      if (score >= chosenScore) {
        chosen = index
        chosenScore = score
      }
    }
    if (chosen < 0) break
    allocation[chosen] += 1
    remaining -= 1
  }
  const keptIndices = segments.flatMap((segment, segmentIndex) => {
    const target = allocation[segmentIndex]
    if (target >= segment.length) return segment
    const selected = new Set<number>()
    const readable = segment.filter((index) => samples[index].thermocoupleC !== undefined)
    if (readable.length > 0) {
      selected.add(readable[0])
      if (target > 1) selected.add(readable.at(-1)!)
    }
    for (const index of stridedSample(segment, target)) {
      if (selected.size >= target) break
      selected.add(index)
    }
    for (const index of segment) {
      if (selected.size >= target) break
      selected.add(index)
    }
    return [...selected].sort((a, b) => a - b)
  })
  return keptIndices.sort((a, b) => a - b).map((index) => samples[index])
}

/**
 * Build a document at successively smaller history limits until it fits.
 *
 * The last limit in the list is the floor and is used whether or not it fits: a document that
 * cannot be made small enough is still worth POSTing, because the firmware's `413` is a clearer
 * answer than a client-side refusal that leaves the device with nothing at all.
 */
const fitByLimit = <T>(
  build: (limit: number) => T,
  limits: readonly number[],
  cap: number,
): { payload: string; limit: number } => {
  let payload = ''
  let limit = limits[limits.length - 1]
  for (const candidate of limits) {
    payload = packed(build(candidate))
    limit = candidate
    if (byteLength(payload) <= cap) break
  }
  return { payload, limit }
}

const parsed = (payload: string): Record<string, unknown> => {
  const value = JSON.parse(unpackDocumentJson(payload)) as unknown
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Not a Crackle document')
  return value as Record<string, unknown>
}

const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])

// ------------------------------------------------------------------------------- run documents

const PHASES: RoastPhase[] = ['READY', 'DRYING', 'MAILLARD', 'DEVELOPMENT', 'COOLING', 'COMPLETE', 'ABORTED']

/** `[elapsedSec, beanC, rorCPerMin, reqFan, effFan, reqHeat, effHeat, phaseIndex]`. */
export type RunSampleTuple = [number, number, number, number, number, number, number, number]

const encodeRunSample = (sample: TelemetrySample): RunSampleTuple => [
  Math.round(sample.elapsedSec * 10) / 10,
  diskTemperatureC(sample.beanTempC),
  diskLevel(sample.rorCPerMin),
  diskLevel(sample.requestedFan),
  diskLevel(sample.effectiveFan),
  diskLevel(sample.requestedHeat),
  diskLevel(sample.effectiveHeat),
  Math.max(0, PHASES.indexOf(sample.phase)),
]

const decodeRunSample = (tuple: RunSampleTuple): TelemetrySample => ({
  elapsedSec: tuple[0],
  beanTempC: tuple[1],
  rorCPerMin: tuple[2],
  requestedFan: tuple[3],
  effectiveFan: tuple[4],
  requestedHeat: tuple[5],
  effectiveHeat: tuple[6],
  phase: PHASES[tuple[7]] ?? 'DRYING',
})

/** What a stored roast says about a series it is not carrying. */
export interface RunSummary {
  peakC?: number
  durationSec: number
  sampleCount: number
}

export interface RunDocument {
  v: 1
  run: Omit<RoastRun, 'samples'>
  /** The controller recording this roast's series lives in, where one exists. */
  recordingId?: string
  summary: RunSummary
  samples?: RunSampleTuple[]
  samplesNote?: string
}

const RUN_BUDGET = Math.min(RUN_TARGET_BYTES, RUN_CAP_BYTES - CAP_MARGIN_BYTES)

const runMetadata = (run: RoastRun): Omit<RoastRun, 'samples'> => {
  const { samples: _samples, ...rest } = run
  void _samples
  // Expanded journal snapshots are convenient in memory but can exceed the whole run-document cap.
  // Codec 2 already gave us the same information in a bounded <=1024-byte envelope, so persist that
  // exact envelope and hydrate the expanded view on read.
  const compactDeviceRoast = run.deviceRoast ? { ...run.deviceRoast } : undefined
  if (compactDeviceRoast?.planEnvelope) {
    delete compactDeviceRoast.initialPlan
    delete compactDeviceRoast.planJournal
  }
  return {
    ...rest,
    deviceRoast: compactDeviceRoast,
    // Ambient is a reading off the cold junction, so it rounds; the masses and volumes beside it
    // come off a scale and are not temperatures.
    measurements: run.measurements
      ? { ...run.measurements, ambientC: optionalDiskTemperatureC(run.measurements.ambientC) }
      : undefined,
    manualRoast: run.manualRoast
      ? {
          ...run.manualRoast,
          stoppedElapsedSec:
            run.manualRoast.stoppedElapsedSec === undefined
              ? undefined
              : Math.round(run.manualRoast.stoppedElapsedSec * 10) / 10,
          changes: run.manualRoast.changes.map((change) => ({
            ...change,
            elapsedSec: Math.round(change.elapsedSec * 10) / 10,
            requestedFan: diskLevel(change.requestedFan),
            requestedHeat: diskLevel(change.requestedHeat),
            effectiveFan: diskLevel(change.effectiveFan),
            effectiveHeat: diskLevel(change.effectiveHeat),
            temperatureC: optionalDiskTemperatureC(change.temperatureC),
          })),
        }
      : undefined,
  }
}

export const runSummary = (samples: TelemetrySample[]): RunSummary => ({
  peakC:
    samples.length === 0
      ? undefined
      : diskTemperatureC(samples.reduce((peak, sample) => Math.max(peak, sample.beanTempC), Number.NEGATIVE_INFINITY)),
  durationSec: Math.round(samples.at(-1)?.elapsedSec ?? 0),
  sampleCount: samples.length,
})

const downsampleNote = (kept: number, total: number) =>
  `Downsampled from ${total} samples to ${kept} to fit the roaster's compact 6 KB per-roast target. ` +
  'The roaster keeps the full-resolution recording separately while space allows.'

/**
 * One roast, as the controller stores it.
 *
 * A roast the controller ran carries both its `recordingId` and a compact fallback series. The
 * recording is the full-resolution copy while it exists; the fallback is what keeps the roast curve
 * intact after automatic retention or explicit housekeeping removes that recording. Every source -
 * controller, demo, or import - carries as much of its series as the compact per-roast target allows and says what it shed.
 */
export const serializeRunDocument = (run: RoastRun): string => {
  requireRecordedOn(run.recordedOn)
  if (run.deviceRoast) {
    requireRecordingOrigin(run.deviceRoast.recordingOrigin)
    requireStorageAddress(run.deviceRoast.storageAddress)
  }
  const base: RunDocument = {
    v: 1,
    run: runMetadata(run),
    recordingId: run.deviceRoast ? recordingKey(run.deviceRoast.recordingOrigin) : undefined,
    summary: runSummary(run.samples),
  }
  if (run.samples.length === 0) return packed(base)

  const total = run.samples.length
  let target = total
  for (;;) {
    const kept = stridedSample(run.samples, target)
    const payload = packed({
      ...base,
      samples: kept.map(encodeRunSample),
      ...(kept.length < total ? { samplesNote: downsampleNote(kept.length, total) } : {}),
    })
    if (byteLength(payload) <= RUN_BUDGET) return payload
    if (target <= 8) break
    target = Math.max(8, Math.floor(target * 0.6))
  }
  // Even eight samples do not fit, so the metadata itself is the problem. The summary still tells
  // the truth about a series this document cannot hold.
  return packed({
    ...base,
    samplesNote: `The ${total} recorded samples did not fit the roaster's compact per-roast budget and stayed in this browser.`,
  })
}

export const parseRunDocument = (payload: string): RoastRun => {
  const body = parsed(payload)
  const run = body.run
  if (run === null || typeof run !== 'object') throw new Error('Not a Crackle run document')
  requireRecordedOn((run as RoastRun).recordedOn)
  if ((run as RoastRun).deviceRoast) {
    requireRecordingOrigin((run as RoastRun).deviceRoast!.recordingOrigin)
    requireStorageAddress((run as RoastRun).deviceRoast!.storageAddress)
  }
  const restored = {
    ...(run as Omit<RoastRun, 'samples'>),
    samples: list<RunSampleTuple>(body.samples).map(decodeRunSample),
  }
  const encoded = restored.deviceRoast?.planEnvelope
  const plan = encoded ? decodeStoredPlanEnvelope(encoded) : undefined
  if (plan && restored.deviceRoast) {
    restored.deviceRoast = {
      ...restored.deviceRoast,
      initialPlan: plan.initialPlan,
      planJournal: plan.planJournal,
    }
  }
  return restored
}

// ------------------------------------------------------------------------------- the collections

/**
 * How much per-record edit history the CONTROLLER keeps.
 *
 * The browser keeps 40 revisions per subject; a revision row carries a whole profile, so 40 of them
 * for six profiles is several hundred kilobytes and cannot fit as one device document. The device keeps the
 * newest few - enough that "what did I change last, and can I put it back" works from any browser -
 * and the long tail stays wherever it was written. Falling to 0 is deliberate rather than a failure
 * mode: a profile library big enough to need it is worth more than its own edit log.
 */
export const DEVICE_REVISION_LIMITS = [6, 4, 2, 1, 0] as const
/** Manual history is an operating log. The newest rows are the ones anybody reads. */
export const DEVICE_MANUAL_EVENT_LIMITS = [60, 24, 0] as const
/** Sample density for a stored calibration pass, per pass, largest first. */
export const CALIBRATION_SAMPLE_LIMITS = [4000, 1200, 600, 300, 120, 0] as const

const COLLECTION_BUDGET = Math.min(COLLECTION_TARGET_BYTES, COLLECTION_CAP_BYTES - CAP_MARGIN_BYTES)

const newestPerSubject = <T>(
  rows: T[],
  subjectOf: (row: T) => string,
  savedAtOf: (row: T) => string,
  limit: number,
): T[] => {
  const bySubject = new Map<string, T[]>()
  for (const row of [...rows].sort((a, b) => savedAtOf(b).localeCompare(savedAtOf(a)))) {
    const subject = subjectOf(row)
    const kept = bySubject.get(subject) ?? []
    if (kept.length < limit) kept.push(row)
    bySubject.set(subject, kept)
  }
  return [...bySubject.values()].flat()
}

const trimNote = (kind: string, limit: number, total: number, kept: number) =>
  kept >= total
    ? undefined
    : `The roaster keeps the newest ${limit} ${kind} per record (${kept} of ${total}) so this fits its ${COLLECTION_CAP_BYTES / 1024} KB cap. The rest stay in the browser that wrote them.`

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const textValue = (value: unknown): value is string => typeof value === 'string'
const numberValue = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const stringListValue = (value: unknown): value is string[] => Array.isArray(value) && value.every(textValue)

const validProfile = (value: unknown): value is Profile => {
  const profile = objectValue(value)
  const metadata = objectValue(profile?.metadata)
  if (
    !profile ||
    !textValue(profile.id) ||
    !textValue(profile.name) ||
    !numberValue(profile.revision) ||
    !textValue(profile.createdAt) ||
    !textValue(profile.updatedAt) ||
    !textValue(profile.notes) ||
    !metadata ||
    !textValue(metadata.intent)
  )
    return false
  if (profile.strategy === 'timed') {
    return (
      numberValue(profile.coolFan) &&
      numberValue(profile.coolDurationSec) &&
      Array.isArray(profile.points) &&
      profile.points.every((pointValue) => {
        const point = objectValue(pointValue)
        return Boolean(
          point &&
            textValue(point.id) &&
            numberValue(point.timeSec) &&
            numberValue(point.fan) &&
            numberValue(point.heat),
        )
      })
    )
  }
  if (profile.strategy === 'thermal-intent') {
    return (
      ['unavailable', 'experimental', 'validated'].includes(String(profile.calibrationStatus)) &&
      Array.isArray(profile.segments) &&
      profile.segments.every((segmentValue) => {
        const segment = objectValue(segmentValue)
        return Boolean(
          segment &&
            textValue(segment.id) &&
            numberValue(segment.startC) &&
            numberValue(segment.endC) &&
            numberValue(segment.durationSec) &&
            numberValue(segment.fanMin) &&
            numberValue(segment.fanMax) &&
            numberValue(segment.heatMin) &&
            numberValue(segment.heatMax),
        )
      })
    )
  }
  return false
}

const validBean = (value: unknown): value is BeanLot => {
  const bean = objectValue(value)
  if (
    !bean ||
    !textValue(bean.id) ||
    !textValue(bean.name) ||
    !stringListValue(bean.origins) ||
    !stringListValue(bean.cultivars) ||
    !textValue(bean.notes) ||
    !textValue(bean.createdAt) ||
    !textValue(bean.updatedAt)
  )
    return false
  for (const field of ['lotId', 'species', 'process'] as const)
    if (bean[field] !== undefined && !textValue(bean[field])) return false
  for (const field of ['greenDensityGPerMl', 'moisturePercent'] as const)
    if (bean[field] !== undefined && !numberValue(bean[field])) return false
  return true
}

const validatedList = <T>(value: unknown, label: string, valid: (item: unknown) => item is T): T[] => {
  if (!Array.isArray(value) || !value.every(valid)) throw new Error(`Invalid ${label} document schema`)
  return value
}

const validProfileRevision = (value: unknown): value is ProfileRevision => {
  const revision = objectValue(value)
  return Boolean(
    revision &&
      textValue(revision.id) &&
      textValue(revision.profileId) &&
      numberValue(revision.revision) &&
      textValue(revision.savedAt) &&
      textValue(revision.summary) &&
      validProfile(revision.profile),
  )
}

const validBeanRevision = (value: unknown): value is BeanRevision => {
  const revision = objectValue(value)
  return Boolean(
    revision &&
      textValue(revision.id) &&
      textValue(revision.beanId) &&
      textValue(revision.savedAt) &&
      textValue(revision.summary) &&
      validBean(revision.bean),
  )
}
export interface ProfilesDocument {
  v: 1
  profiles: Profile[]
  profileRevisions: ProfileRevision[]
  revisionNote?: string
}

export const serializeProfilesDocument = (profiles: Profile[], revisions: ProfileRevision[]): string =>
  fitByLimit(
    (limit) => {
      const kept = newestPerSubject(
        revisions,
        (row) => row.profileId,
        (row) => row.savedAt,
        limit,
      )
      return {
        v: 1,
        profiles,
        profileRevisions: kept,
        revisionNote: trimNote('profile revisions', limit, revisions.length, kept.length),
      }
    },
    DEVICE_REVISION_LIMITS,
    COLLECTION_BUDGET,
  ).payload

export const parseProfilesDocument = (payload: string) => {
  const body = parsed(payload)
  if (body.v !== 1) throw new Error('Invalid profiles document schema')
  return {
    profiles: validatedList(body.profiles, 'profiles', validProfile),
    profileRevisions: validatedList(body.profileRevisions, 'profile revisions', validProfileRevision),
  }
}

export interface BeansDocument {
  v: 1
  beans: BeanLot[]
  beanRevisions: BeanRevision[]
  revisionNote?: string
}

export const serializeBeansDocument = (beans: BeanLot[], revisions: BeanRevision[]): string =>
  fitByLimit(
    (limit) => {
      const kept = newestPerSubject(
        revisions,
        (row) => row.beanId,
        (row) => row.savedAt,
        limit,
      )
      return {
        v: 1,
        beans,
        beanRevisions: kept,
        revisionNote: trimNote('bean lot revisions', limit, revisions.length, kept.length),
      }
    },
    DEVICE_REVISION_LIMITS,
    COLLECTION_BUDGET,
  ).payload

export const parseBeansDocument = (payload: string) => {
  const body = parsed(payload)
  if (body.v !== 1) throw new Error('Invalid beans document schema')
  return {
    beans: validatedList(body.beans, 'beans', validBean),
    beanRevisions: validatedList(body.beanRevisions, 'bean revisions', validBeanRevision),
  }
}

/** `[tMs, thermocoupleC | null, coldJunctionC | null, effectiveFan, effectiveHeat]`. */
export type ThermalTuple = [number, number | null, number | null, number, number]

const encodeThermalSample = (sample: ThermalSample): ThermalTuple => [
  Math.round(sample.tMs),
  optionalDiskTemperatureC(sample.thermocoupleC) ?? null,
  optionalDiskTemperatureC(sample.coldJunctionC) ?? null,
  diskLevel(sample.effectiveFan),
  diskLevel(sample.effectiveHeat),
]

const decodeThermalSample = (tuple: ThermalTuple): ThermalSample => ({
  tMs: tuple[0],
  thermocoupleC: tuple[1] ?? undefined,
  coldJunctionC: tuple[2] ?? undefined,
  effectiveFan: tuple[3],
  effectiveHeat: tuple[4],
})

/**
 * A mesh point on disk.
 *
 * `steadyStateC` and `riseOverAmbientC` are what the chamber MEASURED and round to whole degrees.
 * `tauSec` and `r2` come out of the curve fit over that step's samples and keep every digit - they
 * are not readings, and their significance is real.
 */
const encodeCurve = (curve: CalibrationCurve): CalibrationCurve => ({
  fanLevel: diskLevel(curve.fanLevel),
  points: curve.points.map((point) => ({
    ...point,
    heat: diskLevel(point.heat),
    steadyStateC: diskTemperatureC(point.steadyStateC),
    riseOverAmbientC: optionalDiskTemperatureC(point.riseOverAmbientC),
  })),
})

const requireCalibrationSource = (value: { recordedOn?: unknown }, label: string) => {
  try {
    requireRecordedOn(value.recordedOn)
  } catch {
    throw new Error(`${label} is missing its required recording provenance`)
  }
}
/** The complete persistent calibration shape. Synthetic sensor/electrical fields never cross this boundary. */
export const storedCalibrationSettings = (settings: CalibrationSettings): CalibrationSettings => ({
  referenceBatchMassG: settings.referenceBatchMassG,
  heaterGainCPerMinAt10: settings.heaterGainCPerMinAt10,
  fanCoolingCPerMinAt10: settings.fanCoolingCPerMinAt10,
  coolingFanCPerMinAt10: settings.coolingFanCPerMinAt10,
  thermalLossPerMinPerC: settings.thermalLossPerMinPerC,
  coolingTargetMarginC: settings.coolingTargetMarginC,
  updatedAt: settings.updatedAt,
  thermalSourceDeviceId: settings.thermalSourceDeviceId,
  thermalSourceModelId: settings.thermalSourceModelId,
  thermalSourceRunId: settings.thermalSourceRunId,
  thermalSourceCapturedAt: settings.thermalSourceCapturedAt,
  thermalStagedAt: settings.thermalStagedAt,
})

const THERMAL_COEFFICIENT_FIELDS = [
  'heaterGainCPerMinAt10',
  'fanCoolingCPerMinAt10',
  'coolingFanCPerMinAt10',
  'thermalLossPerMinPerC',
] as const satisfies readonly ThermalCoefficientField[]

const saneMetadataText = (value: unknown, maxLength = 160): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point of this check
  return trimmed.length > 0 && trimmed.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(trimmed)
    ? trimmed
    : undefined
}

const saneMetadataDate = (value: unknown): string | undefined => {
  const text = saneMetadataText(value, 64)
  return text !== undefined && Number.isFinite(Date.parse(text)) ? text : undefined
}

const normalizeInheritedCoefficients = (
  value: unknown,
  patch: unknown,
): CalibrationSnapshot['inheritedCoefficients'] => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const appliedPatch =
    patch && typeof patch === 'object' && !Array.isArray(patch) ? (patch as Record<string, unknown>) : {}
  const normalized: Partial<Record<ThermalCoefficientField, CalibrationInheritedCoefficient>> = {}
  for (const field of THERMAL_COEFFICIENT_FIELDS) {
    const candidate = source[field]
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const record = candidate as Record<string, unknown>
    if (record.source !== 'roaster-applied' || typeof record.value !== 'number' || !Number.isFinite(record.value))
      continue
    const appliedValue = appliedPatch[field]
    if (typeof appliedValue !== 'number' || !Number.isFinite(appliedValue) || appliedValue !== record.value) continue
    const fitId = saneMetadataText(record.fitId)
    const appliedAt = saneMetadataDate(record.appliedAt)
    normalized[field] = {
      source: 'roaster-applied',
      value: record.value,
      ...(fitId !== undefined ? { fitId } : {}),
      ...(appliedAt !== undefined ? { appliedAt } : {}),
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

const normalizeSnapshotMetadata = (snapshot: CalibrationSnapshot): CalibrationSnapshot => {
  const { inheritedCoefficients: rawInherited, applicationFitId: rawApplicationFitId, ...ordinary } = snapshot
  const inheritedCoefficients = normalizeInheritedCoefficients(rawInherited, ordinary.patch)
  const applicationFitId = saneMetadataText(rawApplicationFitId)
  return {
    ...ordinary,
    ...(inheritedCoefficients !== undefined ? { inheritedCoefficients } : {}),
    ...(applicationFitId !== undefined ? { applicationFitId } : {}),
  }
}

const encodeSnapshot = (snapshot: CalibrationSnapshot): CalibrationSnapshot => {
  requireCalibrationSource(snapshot, `Calibration “${snapshot.name}”`)
  const normalized = normalizeSnapshotMetadata(snapshot)
  return {
    ...normalized,
    ambientC: optionalDiskTemperatureC(normalized.ambientC),
    curves: normalized.curves.map(encodeCurve),
  }
}

interface CalibrationRunDocument extends Omit<CalibrationRun, 'samples'> {
  samples: ThermalTuple[]
  samplesNote?: string
}

const encodeCalibrationRun = (run: CalibrationRun, limit: number): CalibrationRunDocument => {
  requireCalibrationSource(run, `Calibration recording “${run.id}”`)
  const { samples, ...rest } = run
  const kept = calibrationSamples(samples, Math.min(limit, samples.length))
  return {
    ...rest,
    ambientC: optionalDiskTemperatureC(run.ambientC),
    samples: kept.map(encodeThermalSample),
    samplesNote:
      kept.length >= samples.length
        ? undefined
        : `Downsampled from ${samples.length} samples to ${kept.length} so the calibrations document fits its ${COLLECTION_CAP_BYTES / 1024} KB cap.`,
  }
}

const decodeCalibrationRun = (run: CalibrationRunDocument): CalibrationRun => {
  const { samplesNote: _note, ...rest } = run
  void _note
  return { ...rest, samples: list<ThermalTuple>(run.samples).map(decodeThermalSample) }
}

export interface CalibrationsDocument {
  v: 2
  settings?: CalibrationSettings
  snapshots: CalibrationSnapshot[]
  runs: CalibrationRunDocument[]
}

/** The byte count the roaster will actually accept for a collection, with the transport margin. */
const COLLECTION_HARD_BUDGET = COLLECTION_CAP_BYTES - CAP_MARGIN_BYTES
/** Saved calibrations whose display curves are never shed, newest first. */
export const CALIBRATION_CURVES_KEPT = 3

const THERMAL_PATCH_FIELDS = [
  'heaterGainCPerMinAt10',
  'fanCoolingCPerMinAt10',
  'coolingFanCPerMinAt10',
  'thermalLossPerMinPerC',
] as const
const isAppliedSnapshot = (snapshot: CalibrationSnapshot, settings: CalibrationSettings | undefined) =>
  settings !== undefined &&
  THERMAL_PATCH_FIELDS.every((field) => {
    const saved = snapshot.patch[field]
    return saved === undefined || Math.abs(saved - settings[field]) <= 1e-6 * Math.max(1, Math.abs(saved))
  }) &&
  THERMAL_PATCH_FIELDS.some((field) => snapshot.patch[field] !== undefined)

/**
 * Evidence samples are shed first (they are re-hydrated from the recordings archive). Past that,
 * every saved calibration still carries its display curves (~0.7 KB each), and the document grows
 * toward the roaster's hard 12 KB cap until a save is refused as too large (measured: 9.5 KB after
 * 12 calibrations). So, only when the hard budget would be exceeded, the curves of the
 * OLDEST calibrations are shed - never the newest few, never the applied one (the dashboard draws
 * its curves). Coefficients, inputs and fit RMS are always kept: the record stays a record.
 */
export const serializeCalibrationsDocument = (
  settings: CalibrationSettings | undefined,
  snapshots: CalibrationSnapshot[],
  runs: CalibrationRun[],
): string => {
  const build = (limit: number, shed: ReadonlySet<string>) => ({
    v: 2 as const,
    settings: settings ? storedCalibrationSettings(settings) : undefined,
    snapshots: snapshots.map((snapshot) =>
      encodeSnapshot(shed.has(snapshot.id) ? { ...snapshot, curves: [] } : snapshot),
    ),
    runs: runs.map((run) => encodeCalibrationRun(run, limit)),
  })
  const fitted = fitByLimit((limit) => build(limit, new Set()), CALIBRATION_SAMPLE_LIMITS, COLLECTION_BUDGET)
  if (byteLength(fitted.payload) <= COLLECTION_HARD_BUDGET) return fitted.payload
  const newestFirst = [...snapshots].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const kept = new Set(newestFirst.slice(0, CALIBRATION_CURVES_KEPT).map((snapshot) => snapshot.id))
  const sheddable = newestFirst
    .reverse()
    .filter(
      (snapshot) => !kept.has(snapshot.id) && snapshot.curves.length > 0 && !isAppliedSnapshot(snapshot, settings),
    )
  const shed = new Set<string>()
  let payload = fitted.payload
  for (const snapshot of sheddable) {
    shed.add(snapshot.id)
    payload = packed(build(fitted.limit, shed))
    if (byteLength(payload) <= COLLECTION_HARD_BUDGET) break
  }
  return payload
}

export const parseCalibrationsDocument = (payload: string) => {
  const body = parsed(payload)
  if (body.v !== 2) throw new Error(`Unsupported calibrations document version ${String(body.v)}`)
  const snapshots = list<CalibrationSnapshot>(body.snapshots).map(normalizeSnapshotMetadata)
  const runDocuments = list<CalibrationRunDocument>(body.runs)
  for (const snapshot of snapshots) requireCalibrationSource(snapshot, `Calibration “${snapshot.name ?? snapshot.id}”`)
  for (const run of runDocuments) requireCalibrationSource(run, `Calibration recording “${run.id}”`)
  return {
    settings: body.settings ? storedCalibrationSettings(body.settings as CalibrationSettings) : undefined,
    snapshots,
    runs: runDocuments.map(decodeCalibrationRun),
  }
}

/** `[atMs, kindIndex, fan, heat, temperatureC|null, sourceIndex, id, detail|null, recordedOn]`. */
export type ManualEventTuple = [
  number,
  number,
  number,
  number,
  number | null,
  number,
  string,
  string | null,
  ManualEvent['recordedOn'],
]

const encodeManualEvent = (event: ManualEvent): ManualEventTuple => [
  Math.round(event.atMs),
  event.kind === 'apply' ? 1 : 0,
  diskLevel(event.fan),
  diskLevel(event.heat),
  optionalDiskTemperatureC(event.temperatureC) ?? null,
  event.source === 'firmware' ? 1 : 0,
  event.id,
  event.detail ?? null,
  requireRecordedOn(event.recordedOn),
]

const decodeManualEvent = (tuple: ManualEventTuple): ManualEvent => ({
  atMs: tuple[0],
  kind: tuple[1] === 1 ? 'apply' : 'stop',
  fan: tuple[2],
  heat: tuple[3],
  temperatureC: tuple[4] ?? undefined,
  source: tuple[5] === 1 ? 'firmware' : 'local',
  id: tuple[6],
  detail: tuple[7] ?? undefined,
  recordedOn: requireRecordedOn(tuple[8]),
})
export interface MetaDocument {
  v: 1
  /**
   * Which controller recordings this LIBRARY has already turned into roasts.
   *
   * It lives on the device with everything else, and it has to: a roast the user deleted on the
   * phone must stay deleted on the PC, and a per-browser ledger would have the PC re-import the
   * recording and push the deleted roast straight back onto the controller.
   */
  importedDeviceLogs: string[]
  manualEvents: ManualEventTuple[]
  manualNote?: string
  /**
   * When this library was last exported whole, ISO. It lives on the CONTROLLER rather than in a
   * browser because it is a fact about the library: the question "is there a copy of this off the
   * roaster" has one answer, and a per-browser one would tell a phone "never" the morning after the
   * laptop made a backup.
   */
  lastExportedAt?: string
}

export const serializeMetaDocument = (
  importedDeviceLogs: string[],
  manualEvents: ManualEvent[],
  lastExportedAt?: string,
): string =>
  fitByLimit(
    (limit) => {
      const sorted = [...manualEvents].sort((a, b) => a.atMs - b.atMs)
      const kept = limit === 0 ? [] : sorted.slice(-limit)
      return {
        v: 1,
        importedDeviceLogs: [...importedDeviceLogs].sort(),
        lastExportedAt,
        manualEvents: kept.map(encodeManualEvent),
        manualNote:
          kept.length >= manualEvents.length
            ? undefined
            : `The roaster keeps the newest ${limit} manual events (${kept.length} of ${manualEvents.length}); manual history is an operating log, not an archive.`,
      }
    },
    DEVICE_MANUAL_EVENT_LIMITS,
    COLLECTION_BUDGET,
  ).payload

export const parseMetaDocument = (payload: string) => {
  const body = parsed(payload)
  return {
    importedDeviceLogs: list<string>(body.importedDeviceLogs).filter((id) => typeof id === 'string' && id.length > 0),
    manualEvents: list<ManualEventTuple>(body.manualEvents).map(decodeManualEvent),
    lastExportedAt: typeof body.lastExportedAt === 'string' ? body.lastExportedAt : undefined,
  }
}

/** Every disk-facing rounding rule, in one place, for the test that pins them. */
export const DISK_ROUNDING = {
  measuredTemperature: diskTemperatureC,
  level: diskLevel,
  optionalTemperature: optionalDiskTemperatureC,
  optionalLevel,
} as const
