import { decodeCrkRoastPlan } from '../data/crkValidator'
import type { DeviceLogEntry } from './deviceLogs'
import { manualChangesFromArchivedPlan, manualChangesFromSamples, profileFromManualRoast } from './manualRoast'
import { manualRoastDurationSec } from './model'
import { recordingIdToken, recordingKey, sameRecording } from './provenance'
import { sanitizeRoastName } from './roastProgram'
import { parseThermalCsv } from './thermalLog'
import type {
  ArchivedJourneyZone,
  ArchivedPlanChange,
  ArchivedRoastPlan,
  Profile,
  RecordingOrigin,
  RoastEvent,
  RoastRun,
  TelemetrySample,
  ThermalIntent,
  ThermalSample,
  TimedProfile,
} from './types'

/**
 * Turning a roast the CONTROLLER ran into a roast in the archive.
 *
 * ============================================================================================
 * WHY THIS IS AN IMPORT AND NOT A RECORDING
 * ============================================================================================
 *
 * The browser is no longer present for the roast. It may have been closed the whole time, on a
 * different machine, or on a phone that went to sleep at minute three - that is the entire point of
 * moving execution onto the device. So there is nothing to "finish saving" when the roast ends;
 * there is a recording on the controller's flash that this browser has never seen, and reconciling
 * with it is a reconstruction from evidence rather than a completion of something in progress.
 *
 * Everything here is therefore a pure function of (log entry, CSV text, profile library). No clocks,
 * no fetches, no storage - which is what lets the idempotency rule below be a property the tests can
 * actually pin rather than a promise about a code path.
 *
 * ============================================================================================
 * IDEMPOTENCY, TWICE OVER
 * ============================================================================================
 *
 * Visiting History must never duplicate a roast, and the mechanism is deliberately belt-and-braces
 * because the two halves fail differently:
 *
 *   1. **The run id is derived from the controller's log id** (`device-roast-<logId>`). The log id is
 *      monotonic across boots, so it is a stable global identity, and a second import of the same
 *      recording therefore writes the SAME record rather than a second one - `saveRun` is a `put` by
 *      key. This makes duplication structurally impossible even if the bookkeeping below is lost.
 *   2. **Imported log ids are recorded in the repository.** That is what stops the app re-FETCHING
 *      every recording's CSV on every visit, and - more importantly - what makes a deliberate
 *      deletion stick: a user who deletes an imported roast from History does not want it to
 *      reappear the next time the page loads. Identity alone would resurrect it.
 *
 * The pair is the rule: id-derivation guarantees no duplicates, the ledger guarantees no
 * resurrection. Neither is sufficient alone.
 *
 * ============================================================================================
 * WHAT IS RECONSTRUCTED, AND WHAT IS DECLINED
 * ============================================================================================
 *
 * The controller records temperature, cold junction, effective fan and effective heat at 1 Hz, plus
 * a v2 header carrying the roast name and the per-zone attainment offsets. From that:
 *
 *   - **Samples** are the CSV rows that carry a thermocouple reading. A faulted row is DROPPED
 *     rather than carried as a zero or a NaN, because `TelemetrySample.beanTempC` has no way to say
 *     "missing" and every downstream consumer would read the substitute as a measurement.
 *   - **Requested levels are set equal to effective levels**, because the log records effective
 *     levels and nothing else. That is truthful: the difference between the two is a firmware floor,
 *     and inventing a "requested" number to sit beside it would manufacture the exact distinction
 *     the archive exists to preserve.
 *   - **Zone attainments become annotations**, which is the only honest place for them. They are the
 *     one thing a reviewer cannot recover from the temperature series - attainment is what moved the
 *     plan's time axis, and where a boundary fell is a decision the controller made rather than a
 *     feature of the curve.
 *   - **Rate of rise is computed** over a backward window, because it is arithmetic on the series
 *     rather than a claim about it.
 *   - **The outcome is derived, never invented.** A journey with an unattained zone did not finish
 *     its journey, and that is knowable from the header. Everything else persisted is by definition
 *     a finished recording and reads as complete.
 *   - **The batch mass comes from the header** where the firmware sends one. The controller is
 *     handed a green mass to plan against and writes it into the v2 log header, so the operator
 *     never types a number the device already knows. It arrives as a MEASUREMENT, in the same field
 *     a hand-entered start weight uses, because that is what it is - and it is still editable, since
 *     the roaster's scale is the authority and the plan's figure is what was intended.
 *
 *     The bean lot stays manual, and always will: the controller is handed a 32-byte name and a
 *     number, and it has never been told which beans went in. Inferring one would be a guess written
 *     into the archive as a fact.
 */

/** The id a recording always imports under. Deterministic, so a second import overwrites the first. */
export const deviceRunId = (origin: RecordingOrigin) => `devrun-${recordingIdToken(origin)}`

/** How far back the rate of rise is measured. Matches the archive's own 1 Hz sample spacing. */
export const ROR_WINDOW_SEC = 11

/**
 * Which of the controller's recordings are roasts this archive has not taken yet.
 *
 * A recording that is still being written is excluded: it has not been persisted, its header is not
 * final, and `/logs/<id>.csv` would serve a moving target. The archive's own listing only contains
 * persisted logs, so this is really a guard against the currently-recording id appearing in both.
 */
export const importableDeviceRoasts = (
  logs: DeviceLogEntry[],
  importedIds: Iterable<string>,
  activeLogId?: string,
): DeviceLogEntry[] => {
  const already = new Set(importedIds)
  return logs.filter(
    (entry) =>
      entry.mode === 'roast' &&
      entry.storageAddress.logId !== activeLogId &&
      // A power-loss-safe provisional remains visible in the device archive after
      // reboot, but it is not a completed roast and must not enter History.
      !(entry.samples === 0 && entry.roastEndReason === undefined) &&
      !already.has(recordingKey(entry.recordingOrigin)),
  )
}

const rateOfRise = (samples: Array<{ elapsedSec: number; beanTempC: number }>, index: number): number => {
  const current = samples[index]
  let earlier = samples[0]
  for (let scan = index; scan >= 0; scan -= 1) {
    earlier = samples[scan]
    if (current.elapsedSec - earlier.elapsedSec >= ROR_WINDOW_SEC) break
  }
  const span = current.elapsedSec - earlier.elapsedSec
  return span <= 0 ? 0 : ((current.beanTempC - earlier.beanTempC) / span) * 60
}

/**
 * Validated archive samples as telemetry. The CSV wrapper below preserves the legacy import path.
 *
 * Phase is read off the actuator history and nothing else: heat on is roasting, and the trailing run
 * of heat-off samples is the cooling tail. It is never read off an annotation - see
 * `eventPolicy.test.ts` for why a marker may not become an input.
 */
export const deviceRoastSamplesFromThermal = (samples: ThermalSample[]): TelemetrySample[] => {
  const valid = samples.filter((row) => row.thermocoupleC !== undefined)
  if (valid.length === 0) return []
  // Rebase onto the first sample IN MILLISECONDS, so whole-second rows stay whole seconds: the
  // firmware's first sample lands a few hundred milliseconds after the log opens (for example 437,
  // 1437, 2437 ...), and `2437 / 1000 - 437 / 1000` is 1.9999999999999998, which a merge keyed on
  // the roaster second would file under second 1 - on top of the real second-1 sample.
  const startMs = valid[0].tMs
  const rows = valid.map((row) => ({
    elapsedSec: (row.tMs - startMs) / 1000,
    beanTempC: row.thermocoupleC as number,
    effectiveFan: row.effectiveFan,
    effectiveHeat: row.effectiveHeat,
  }))
  // Where the cooling tail begins: after the last sample that still had heat.
  let lastHeatIndex = -1
  for (const [index, row] of rows.entries()) if (row.effectiveHeat > 0) lastHeatIndex = index
  return rows.map((row, index) => ({
    elapsedSec: row.elapsedSec,
    beanTempC: row.beanTempC,
    rorCPerMin: rateOfRise(rows, index),
    requestedFan: row.effectiveFan,
    effectiveFan: row.effectiveFan,
    requestedHeat: row.effectiveHeat,
    effectiveHeat: row.effectiveHeat,
    phase: index > lastHeatIndex ? ('COOLING' as const) : ('DRYING' as const),
  }))
}

export const deviceRoastSamples = (csv: string): TelemetrySample[] =>
  deviceRoastSamplesFromThermal(parseThermalCsv(csv))

/**
 * Zone attainments as annotations, plus one for a zone that never arrived.
 *
 * A `null` offset is the controller saying the endpoint was never reached, and that is the single
 * most important thing the header carries: it is the difference between a roast that followed its
 * plan and one the roaster could not deliver.
 */
export const attainmentAnnotations = (zoneAttainedSec: Array<number | null> | undefined): RoastEvent[] => {
  if (!zoneAttainedSec || zoneAttainedSec.length === 0) return []
  return zoneAttainedSec.map(
    (offset, index): RoastEvent =>
      offset === null || !Number.isFinite(offset)
        ? {
            id: `device-zone-${index}-unattained`,
            elapsedSec: 0,
            type: 'SYSTEM',
            label: `Zone ${index + 1} never reached its endpoint`,
            detail: 'No attainment was recorded, so the roast did not complete this zone.',
          }
        : {
            id: `device-zone-${index}`,
            elapsedSec: offset as number,
            type: 'SYSTEM',
            label: `Zone ${index + 1} attained`,
            detail: 'Attainment is what moved the journey time axis.',
          },
  )
}

/**
 * The profile a recording belongs to, by exact sanitized-name match.
 *
 * Exact, and unique, or nothing. The controller only knows the 32-byte name it was handed, so the
 * match is a name comparison and cannot be anything cleverer; a fuzzy match would attach a roast to
 * the wrong recipe, and a roast attached to the wrong recipe is worse than one attached to none.
 * Two profiles that sanitize to the same name are ambiguous by construction, so both are refused and
 * the user picks.
 */
export const matchProfileByName = (profiles: Profile[], name: string | undefined): Profile | undefined => {
  if (!name) return undefined
  const wanted = sanitizeRoastName(name)
  const matches = profiles.filter((profile) => sanitizeRoastName(profile.name) === wanted)
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * The stand-in for a recording whose profile is not in this library.
 *
 * A `RoastRun` must carry a profile, so an unlinked import gets an empty timed one that says what it
 * is. It has no steps, so nothing derives anything from it, and `deviceRoast.profileLinked` is false
 * so History can offer the one control that replaces it.
 */
export const unlinkedProfile = (logId: string, name: string): TimedProfile => ({
  id: `device-roast-profile-${logId}`,
  name,
  revision: 0,
  strategy: 'timed',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  metadata: { intent: '' },
  notes: 'This roast is not linked to a profile. Choose one only if you know which profile was used.',
  points: [],
  coolFan: 0,
  coolDurationSec: 0,
})

const profileBase = (logId: string, name: string, startedAt: string, notes: string) => ({
  id: `device-roast-profile-${logId}`,
  name,
  revision: 1,
  createdAt: startedAt,
  updatedAt: startedAt,
  metadata: { intent: 'Recorded roaster instructions' },
  notes,
})

const archivedTimedProfile = (
  logId: string,
  name: string,
  startedAt: string,
  plan: Extract<ArchivedRoastPlan, { mode: 'timed' }>,
): TimedProfile => {
  let elapsedSec = 0
  const points = plan.steps.map((step, index) => {
    const point = { id: `device-step-${index}`, timeSec: elapsedSec, fan: step.fan, heat: step.heat }
    elapsedSec += step.durationSec
    return point
  })
  const last = plan.steps.at(-1)!
  // A timed profile's last point uses coolDurationSec as its dwell. If the stored plan ended under
  // heat, add a zero-length Cooling boundary so converting this snapshot back to steps does not
  // replace the controller's final heated step with implicit cooling.
  if (last.heat !== 0) points.push({ id: 'device-step-end', timeSec: elapsedSec, fan: last.fan, heat: 0 })
  return {
    ...profileBase(logId, name, startedAt, 'Reconstructed from the immutable plan stored in the roaster recording.'),
    strategy: 'timed',
    points,
    coolFan: last.fan,
    coolDurationSec: last.heat === 0 ? last.durationSec : 0,
  }
}

const archivedJourneyProfile = (
  logId: string,
  name: string,
  startedAt: string,
  zones: ArchivedJourneyZone[],
  journal: ArchivedPlanChange[],
): ThermalIntent => ({
  ...profileBase(
    logId,
    name,
    startedAt,
    `Reconstructed from the roaster's stored plan. ${journal.length} accepted live edit${journal.length === 1 ? '' : 's'} ${journal.length === 1 ? 'is' : 'are'} preserved with this roast.`,
  ),
  revision: journal.at(-1)?.planRev ?? 1,
  strategy: 'thermal-intent',
  segments: zones.map((zone, index) => ({ ...zone, id: `device-zone-${index}` })),
  calibrationStatus: 'unavailable',
})

/** The executable snapshot represented by codec-2, using the last accepted journey plan. */
export const profileFromArchivedPlan = (
  logId: string,
  name: string,
  startedAt: string,
  initialPlan: ArchivedRoastPlan,
  journal: ArchivedPlanChange[],
): Profile | undefined => {
  if (initialPlan.mode === 'timed') {
    const steps = initialPlan.steps.map((step) => ({ ...step }))
    for (const event of journal)
      if ('stepIndex' in event) {
        if (event.stepIndex > steps.length) return undefined
        steps[event.stepIndex] = { ...event.step }
      }
    return archivedTimedProfile(logId, name, startedAt, { mode: 'timed', steps })
  }
  if (initialPlan.mode === 'journey') {
    const latest = [...journal].reverse().find((event) => 'zones' in event)
    return archivedJourneyProfile(logId, name, startedAt, latest?.zones ?? initialPlan.zones, journal)
  }
  return undefined
}

export interface DeviceRoastImportInput {
  entry: DeviceLogEntry
  csv: string
  profiles: Profile[]
  firmwareVersion: string
  /**
   * When the import is happening. Used ONLY as the start time of a recording whose controller clock
   * had never synced - a bound rather than a reading, and labelled as such.
   */
  importedAtMs: number
  /** Raw .crk bytes when this recording uses codec 2. Legacy imports omit it. */
  archive?: Uint8Array
}

export interface ManualArchiveReconciliationInput {
  entry: DeviceLogEntry
  reconstructed: RoastRun
  localRuns: readonly RoastRun[]
  /** Local runs already claimed by another recording during this reconciliation pass. */
  claimedLocalRunIds?: ReadonlySet<string>
}

export type ManualArchiveReconciliation =
  | { kind: 'merge'; run: RoastRun; logId: string; localRunId: string }
  | { kind: 'ledger-repair'; run: RoastRun; logId: string; localRunId: string }
  | { kind: 'standalone'; run: RoastRun; logId: string }

/**
 * Reconcile one reconstructed manual recording with browser-owned roast history.
 *
 * A browser-created manual run deliberately keeps its id and user-entered fields. The controller
 * archive is authoritative for the terminal state and thermal series, and fills the instruction
 * path only when the browser joined late. An already log-linked run means the durable run write
 * succeeded on an earlier attempt but its ledger write did not; returning `ledger-repair` lets the
 * caller repair that bookkeeping without creating the deterministic standalone run beside it.
 */
export const reconcileManualArchiveRun = ({
  entry,
  reconstructed,
  localRuns,
  claimedLocalRunIds = new Set<string>(),
}: ManualArchiveReconciliationInput): ManualArchiveReconciliation => {
  const decisionKey = recordingKey(entry.recordingOrigin)
  const alreadyLinked = localRuns.find(
    (run) => run.deviceRoast && sameRecording(run.deviceRoast.recordingOrigin, entry.recordingOrigin),
  )
  if (alreadyLinked) {
    return { kind: 'ledger-repair', run: alreadyLinked, logId: decisionKey, localRunId: alreadyLinked.id }
  }
  if (!reconstructed.manualRoast) return { kind: 'standalone', run: reconstructed, logId: decisionKey }

  const exact = localRuns.find((run) => {
    const pending = run.manualRoast?.pendingRecording
    return (
      pending !== undefined &&
      !run.manualRoast?.logId &&
      !claimedLocalRunIds.has(run.id) &&
      sameRecording(pending.recordingOrigin, entry.recordingOrigin) &&
      sameRecording(pending.storageAddress, entry.storageAddress)
    )
  })
  const wantedName = sanitizeRoastName(entry.name ?? reconstructed.name)
  const named = localRuns.filter(
    (run) =>
      run.manualRoast &&
      !run.manualRoast.logId &&
      !claimedLocalRunIds.has(run.id) &&
      sanitizeRoastName(run.name) === wantedName,
  )
  // Without a controller timestamp, a repeated same-name roast in the same boot is indistinguishable
  // from the local candidate. Keep the deterministic archive run separate rather than overwrite the
  // wrong history; a volatile session id protects live control but cannot identify an old file.
  const timed = closestStartedWithinTolerance(named, entry.startedAt)
  // The boot the roast was started under, plus its name, identifies the staged record across
  // browsers, page reloads, and clock skew - but only when exactly one staged record claims it.
  const sameBoot =
    entry.bootId !== undefined && entry.startedAt !== undefined
      ? named.filter(
          (run) =>
            run.manualRoast?.deviceBootId === entry.bootId && withinSameBootWindow(run.startedAt, entry.startedAt),
        )
      : []
  const candidate = exact ?? timed ?? (sameBoot.length === 1 ? sameBoot[0] : undefined)
  if (!candidate) return { kind: 'standalone', run: reconstructed, logId: decisionKey }

  const localManual = candidate.manualRoast
  if (!localManual) return { kind: 'standalone', run: reconstructed, logId: decisionKey }
  const manualRoast = {
    ...reconstructed.manualRoast,
    deviceBootId: localManual.deviceBootId,
    deviceName: localManual.deviceName,
    deviceSessionId: localManual.deviceSessionId,
    deviceStartedEpoch: localManual.deviceStartedEpoch,
    logId: decisionKey,
  }

  // The staged-at-Start marker must not survive reconciliation: this record is complete now.
  const { deviceRoastPending: _pending, ...settledCandidate } = candidate
  return {
    kind: 'merge',
    logId: decisionKey,
    localRunId: candidate.id,
    run: {
      ...settledCandidate,
      completedAt: reconstructed.completedAt,
      outcome: reconstructed.outcome,
      controllerVersion: reconstructed.controllerVersion,
      samples: reconstructed.samples,
      manualRoast,
      deviceRoast: reconstructed.deviceRoast,
      notes: candidate.notes,
    },
  }
}

/**
 * Without the recording identity, a same-name roast further away than this cannot be told apart
 * from a repeat. Shared by the manual and profiled name-and-time fallback joins.
 */
export const START_MATCH_TOLERANCE_MS = 10_000

/**
 * The wider window for the same-boot, same-name join of a recording that HAS a clock. It absorbs
 * the staged write waiting and retrying before Start, and phone-to-roaster clock skew; a genuine
 * repeat under the same name in the same boot starts at least one roast-length later.
 */
export const SAME_BOOT_START_WINDOW_MS = 5 * 60_000

const withinSameBootWindow = (runStartedAt: string, entryStartedAt: string | undefined) =>
  entryStartedAt === undefined ||
  Math.abs(new Date(runStartedAt).getTime() - new Date(entryStartedAt).getTime()) <= SAME_BOOT_START_WINDOW_MS

export interface ProfiledArchiveReconciliationInput {
  entry: DeviceLogEntry
  reconstructed: RoastRun
  localRuns: readonly RoastRun[]
  /** Local runs already claimed by another recording during this reconciliation pass. */
  claimedLocalRunIds?: ReadonlySet<string>
  /**
   * The recording each staged run was observed to open, keyed by run id. Known only to the browser
   * that issued Start (from the acknowledgement or live status); every other browser relies on the
   * name-and-time fallback against the SHARED staged record.
   */
  pendingRecordingByRunId?: ReadonlyMap<string, RecordingOrigin>
}

export type ProfiledArchiveReconciliation =
  | { kind: 'merge'; run: RoastRun; logId: string; localRunId: string }
  | { kind: 'standalone'; run: RoastRun; logId: string }

/**
 * Complete the run record that Start staged on the roaster, from the recording the roaster kept.
 *
 * A device-executed profiled roast begins life as a COMPLETE run
 * record written to the roaster's document store before the Start command - volume, ambient, bean
 * lot and snapshot, mass, name, profile snapshot, outcome `running`. Reconciliation therefore
 * UPDATES that record in place rather than synthesizing a second one from the log header:
 *
 *   - The recording is authoritative for everything it carries: the thermal series, the archived
 *     plan and its journal, the outcome, the duration, and the header mass (the number the firmware
 *     planned against for the whole roast) win over the staged copy.
 *   - The staged record keeps what the device has no way to know: the starting volume, the ambient
 *     reading, the bean selection and its snapshot, and any notes the user already wrote.
 *   - The join is the recording identity where a browser observed it, and otherwise the sanitized
 *     name plus a bounded start-time window - the same fallback the manual reconciliation uses. A
 *     clockless recording falls back once more to same-boot-same-name, which is unambiguous unless
 *     the same name was roasted twice in one boot; ambiguity keeps the records separate rather
 *     than completing the wrong one.
 */
/**
 * The executed plan is the truth about what ran, mid-roast edits included, but a recording carries no
 * profile identity: its plan is named after the roast. The record staged at Start knows which saved
 * profile the operator chose, so the merged record keeps that profile's identity on the executed plan.
 */
export const withStagedProfileIdentity = (staged: Profile, executed: Profile): Profile =>
  staged.strategy !== executed.strategy
    ? executed
    : {
        ...executed,
        id: staged.id,
        name: staged.name,
        revision: staged.revision,
        createdAt: staged.createdAt,
        updatedAt: staged.updatedAt,
        metadata: { ...staged.metadata },
        notes: staged.notes,
      }

export const reconcileProfiledArchiveRun = ({
  entry,
  reconstructed,
  localRuns,
  claimedLocalRunIds = new Set<string>(),
  pendingRecordingByRunId,
}: ProfiledArchiveReconciliationInput): ProfiledArchiveReconciliation => {
  const decisionKey = recordingKey(entry.recordingOrigin)
  const staged = localRuns.filter(
    (run) =>
      run.deviceRoastPending !== undefined &&
      run.outcome === 'running' &&
      !run.manualRoast &&
      !run.deviceRoast &&
      !claimedLocalRunIds.has(run.id),
  )
  const exact = staged.find((run) => {
    const origin = pendingRecordingByRunId?.get(run.id)
    return origin !== undefined && sameRecording(origin, entry.recordingOrigin)
  })
  const wantedName = sanitizeRoastName(entry.name ?? reconstructed.name)
  const named = staged.filter((run) => sanitizeRoastName(run.name) === wantedName)
  const timed = closestStartedWithinTolerance(named, entry.startedAt)
  // The boot the Start was accepted under still identifies the staged record, as long as only one
  // same-name staged record claims that boot. This is not only the clockless fallback: the
  // name-and-time window compares the starting browser's clock, read BEFORE the staged write (which
  // can wait behind other storage work and retry), against the roaster's clock at Start. A phone
  // that reloaded during a long roast has also lost the exact recording identity. When both of
  // those miss, the recording would be reconstructed as a SECOND record beside the staged one: two
  // History rows for one roast, the visible one without the starting volume.
  const sameBoot =
    entry.bootId !== undefined
      ? named.filter(
          (run) =>
            run.deviceRoastPending?.bootId === entry.bootId && withinSameBootWindow(run.startedAt, entry.startedAt),
        )
      : []
  const candidate = exact ?? timed ?? (sameBoot.length === 1 ? sameBoot[0] : undefined)
  if (!candidate) return { kind: 'standalone', run: reconstructed, logId: decisionKey }

  // The header mass wins where present; the staged volume and ambient are the fields the device
  // never knew. Merge order states exactly that.
  const measurements = { ...(candidate.measurements ?? {}), ...(reconstructed.measurements ?? {}) }
  const clockless = entry.startedAt === undefined
  const durationMs =
    new Date(reconstructed.completedAt ?? reconstructed.startedAt).getTime() -
    new Date(reconstructed.startedAt).getTime()
  return {
    kind: 'merge',
    logId: decisionKey,
    localRunId: candidate.id,
    run: {
      ...reconstructed,
      id: candidate.id,
      profile: withStagedProfileIdentity(candidate.profile, reconstructed.profile),
      beanLotId: candidate.beanLotId ?? reconstructed.beanLotId,
      beanLotSnapshot: candidate.beanLotSnapshot ?? reconstructed.beanLotSnapshot,
      ...(Object.keys(measurements).length > 0 ? { measurements } : {}),
      notes: candidate.notes.trim() ? candidate.notes : reconstructed.notes,
      // The user's score belongs to the record, not the recording; a score given before
      // reconciliation finished must survive it.
      ...(candidate.score !== undefined ? { score: candidate.score } : {}),
      // The staged record carries the browser clock at Start - a true reading. When the roaster
      // clock never synced it is strictly better than the import moment the reconstruction fell
      // back to, so the merged record keeps it and drops the recovered-date disclaimer.
      ...(clockless
        ? {
            startedAt: candidate.startedAt,
            completedAt: new Date(new Date(candidate.startedAt).getTime() + durationMs).toISOString(),
            notes: (candidate.notes.trim() ? candidate.notes : reconstructed.notes)
              .replace(
                'The roaster clock had never synced, so the recorded date is unknown; the displayed date is when this record was recovered.',
                'The roaster clock had never synced; the date shown is when this roast was started.',
              )
              .trim(),
          }
        : {}),
    },
  }
}

export const deviceRoastRun = ({
  entry,
  csv,
  profiles,
  firmwareVersion,
  importedAtMs,
  archive,
}: DeviceRoastImportInput): RoastRun => {
  const samples = deviceRoastSamples(csv)
  const manual = entry.roastMode === 'manual'
  const name = entry.name ?? (manual ? `manual roast ${entry.id}` : `roast ${entry.id}`)
  const archivedPlan = archive ? decodeCrkRoastPlan(archive, entry.storageAddress.logId) : undefined
  const v4ArchiveUnavailable = entry.version === 4 && archive === undefined
  // Codec 2 is the controller's exact account of what it accepted. A catalog profile with the same
  // name may since have changed, so name matching is only the compatibility path for an archive we
  // actually read and found to be legacy. A failed v3 fetch stays unlinked rather than guessing.
  const matched = manual || archivedPlan || v4ArchiveUnavailable ? undefined : matchProfileByName(profiles, entry.name)
  const attainments = manual ? undefined : entry.zoneAttainedSec
  const events = attainmentAnnotations(attainments)
  const missedZone = attainments?.some((offset) => offset === null || !Number.isFinite(offset)) === true
  const profiledFailed = entry.roastEndReason !== undefined && entry.roastEndReason !== 'completed'
  /*
   * The date. `start_epoch` of 0 means the controller clock had never synced when the log was
   * persisted, which is "date unknown" and emphatically NOT 1970 - an archive sorted by a 1970
   * timestamp puts every unsynced roast before every real one, forever. The import moment is used
   * instead, which is at least a true upper bound, and the run says so in its own notes and name.
   */
  const dateUnknown = entry.startedAt === undefined
  const startedAt = entry.startedAt ?? new Date(importedAtMs).toISOString()
  const durationSec = entry.durationSec ?? samples.at(-1)?.elapsedSec ?? 0
  // The controller Stop boundary can follow minutes of operator-requested heat-off cooling. The
  // thermal series owns the roast duration: use the beginning of its final heat-off suffix, while
  // retaining roastStopSec below as the exact end of the controller session.
  const roastDurationSec = manual ? manualRoastDurationSec(samples, entry.roastStopSec ?? durationSec) : durationSec
  const originToken = recordingIdToken(entry.recordingOrigin)
  const recordedProfile = archivedPlan
    ? profileFromArchivedPlan(originToken, name, startedAt, archivedPlan.initialPlan, archivedPlan.planJournal)
    : undefined
  const archivedManualChanges =
    manual && archivedPlan?.initialPlan.mode === 'manual'
      ? manualChangesFromArchivedPlan(archivedPlan.planJournal, samples)
      : []

  const restored: RoastRun = {
    id: deviceRunId(entry.recordingOrigin),
    name,
    startedAt,
    completedAt: new Date(new Date(startedAt).getTime() + roastDurationSec * 1000).toISOString(),
    profile: recordedProfile ?? (matched ? structuredClone(matched) : unlinkedProfile(originToken, name)),
    notes: [
      dateUnknown
        ? 'The roaster clock had never synced, so the recorded date is unknown; the displayed date is when this record was recovered.'
        : undefined,
      manual
        ? archivedManualChanges.length > 0
          ? 'This was steered manually. Its controller journal preserves every accepted requested and effective instruction.'
          : 'This was steered manually. This legacy archive stores effective levels, so those levels stand in for requested instructions.'
        : undefined,
      entry.passiveTailComplete === false
        ? "This recording's passive decay tail did not complete, so it is not calibration evidence. The archive does not identify whether a later operation, capacity, or interruption ended it."
        : undefined,
      archivedPlan
        ? `The roaster recording preserved its starting instructions${archivedPlan.planJournal.length > 0 ? ` and ${archivedPlan.planJournal.length} accepted live edit${archivedPlan.planJournal.length === 1 ? '' : 's'}` : ''}.`
        : undefined,
      !manual && v4ArchiveUnavailable
        ? 'The recorded plan could not be read, so this roast remains unlinked rather than guessing from a same-name profile.'
        : undefined,
      !manual && !v4ArchiveUnavailable && !archivedPlan && !matched
        ? 'No recorded plan or matching profile was available, so this roast is not linked to one.'
        : undefined,
    ]
      .filter(Boolean)
      .join(' '),
    controllerVersion: firmwareVersion,
    thermocoupleOffsetC: entry.thermocoupleOffsetC,
    recordedOn: entry.recordedOn,
    // The one measurement the device knows. A v1 header carries none, and a v2 header that sends 0
    // means "unknown" - both arrive here as undefined, so `measurements` is omitted entirely rather
    // than written as an empty object that later reads as "measured, and empty".
    measurements: entry.batchMassG === undefined ? undefined : { startingMassG: entry.batchMassG },
    // A journey that left a zone unattained did not finish its journey, and the header says so.
    outcome: manual
      ? entry.roastEndReason === undefined || entry.roastEndReason === 'stopped' || entry.roastEndReason === 'completed'
        ? 'complete'
        : 'aborted'
      : missedZone || profiledFailed
        ? 'aborted'
        : 'complete',
    samples,
    events,
    manualRoast: manual
      ? {
          // Authored fan-only steps from older archives remain useful telemetry, but they are not
          // operator instructions and must never become profile steps offered after Stop.
          changes:
            archivedManualChanges.length > 0
              ? archivedManualChanges
              : manualChangesFromSamples(
                  entry.roastStopSec === undefined
                    ? samples
                    : samples.filter((sample) => sample.elapsedSec <= entry.roastStopSec!),
                ),
          stoppedElapsedSec: entry.roastStopSec,
          endReason: entry.roastEndReason,
          incomplete:
            entry.roastStopSec === undefined ||
            entry.roastEndReason === undefined ||
            entry.passiveTailComplete === false,
          logId: recordingKey(entry.recordingOrigin),
        }
      : undefined,
    deviceRoast: {
      recordingOrigin: entry.recordingOrigin,
      storageAddress: entry.storageAddress,
      name,
      bootId: entry.bootId,
      dateUnknown,
      zoneAttainedSec: attainments,
      // A manual roast intentionally has no catalog profile to link. Its synthetic snapshot is the
      // instruction path recovered below, so History must not offer to replace it as an orphan.
      profileLinked: manual || archivedPlan !== undefined || matched !== undefined,
      ...(archivedPlan
        ? {
            initialPlan: archivedPlan.initialPlan,
            planJournal: archivedPlan.planJournal,
            planEnvelope: archivedPlan.planEnvelope,
          }
        : {}),
    },
  }
  if (manual) {
    const synthetic = profileFromManualRoast(restored, {
      profileId: `manual-${originToken}`,
      name: `${name} instructions`,
      createdAt: startedAt,
    })
    if (typeof synthetic !== 'string') restored.profile = synthetic
  }
  return restored
}

/**
 * Two or more run records that claim the SAME immutable recording are one roast recorded twice.
 * That happens when one reconciliation pass could not see (or join) the record staged at Start and
 * reconstructed a standalone record, while another pass completed the staged record. This folds
 * each such group into one record and names the others for deletion.
 *
 * The keeper is the record staged by the user's own setup (not a `devrun-` reconstruction), because
 * it carries what only the setup knew - bean lot, starting volume, ambient. Anything the user then
 * entered on another copy (a final weight, a volume, a score, notes) is carried onto the keeper
 * wherever the keeper has no value of its own; where both have a value, the keeper's stands.
 */
export interface DuplicateRecordingMerge {
  keep: RoastRun
  /** The keeper as it was read, so the write rebases onto any edit made meanwhile. */
  basis: RoastRun
  removeIds: string[]
}

const isReconstructionId = (id: string) => id.startsWith('devrun-')

/**
 * The same-name record whose start is CLOSEST to the recording's, within the tolerance. The first
 * match in library order could be a retried Start's leftover a few seconds away.
 */
const closestStartedWithinTolerance = (
  candidates: readonly RoastRun[],
  startedAt: string | undefined,
): RoastRun | undefined => {
  if (!startedAt) return undefined
  const at = new Date(startedAt).getTime()
  let best: RoastRun | undefined
  let bestDistance = Infinity
  for (const run of candidates) {
    const distance = Math.abs(new Date(run.startedAt).getTime() - at)
    if (distance <= START_MATCH_TOLERANCE_MS && distance < bestDistance) {
      best = run
      bestDistance = distance
    }
  }
  return best
}

/** Two copies' notes on one roast are both kept; identical or contained text is not repeated. */
const mergedNotes = (keep: string, other: string): string => {
  const a = keep.trim()
  const b = other.trim()
  if (!a) return other
  if (!b || a.includes(b)) return keep
  if (b.includes(a)) return other
  return [a, b].join('\n\n')
}

export const duplicateRecordingMerges = (runs: readonly RoastRun[]): DuplicateRecordingMerge[] => {
  const groups = new Map<string, RoastRun[]>()
  for (const run of runs) {
    if (!run.deviceRoast) continue
    const key = recordingKey(run.deviceRoast.recordingOrigin)
    groups.set(key, [...(groups.get(key) ?? []), run])
  }
  const merges: DuplicateRecordingMerge[] = []
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const ranked = [...group].sort(
      (a, b) =>
        Number(isReconstructionId(a.id)) - Number(isReconstructionId(b.id)) ||
        Number(b.beanLotId !== undefined) - Number(a.beanLotId !== undefined) ||
        a.id.localeCompare(b.id),
    )
    const [keeper, ...others] = ranked
    let keep: RoastRun = keeper
    for (const other of others) {
      const measurements = { ...(other.measurements ?? {}), ...definedOnly(keep.measurements ?? {}) }
      keep = {
        ...keep,
        ...(Object.keys(measurements).length > 0 ? { measurements } : {}),
        notes: mergedNotes(keep.notes, other.notes),
        ...(keep.score === undefined && other.score !== undefined ? { score: other.score } : {}),
        ...(keep.beanLotId === undefined && other.beanLotId !== undefined
          ? { beanLotId: other.beanLotId, beanLotSnapshot: other.beanLotSnapshot }
          : {}),
      }
    }
    merges.push({ keep, basis: keeper, removeIds: others.map((run) => run.id) })
  }
  return merges
}

const definedOnly = <T extends object>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>

/**
 * Staged records that can never be completed.
 *
 * A record staged at Start is completed by the recording the roaster keeps. Two things strand it:
 * the roaster restarted mid-roast, leaving only a header-only provisional recording (no samples,
 * no end reason - deliberately never imported), or Start was never confirmed and the roaster has no
 * recording of it at all. Either way the record waits as "running" forever. Once the roaster is on a
 * LATER boot than the one the record was staged under, and the archive has been listed in full, no
 * recording can still arrive for it, so it is settled as aborted - every setup detail kept.
 */
export interface OrphanedStagedRun {
  run: RoastRun
  reason: 'restarted' | 'unconfirmed' | 'superseded'
}

export const orphanedStagedRuns = (
  runs: readonly RoastRun[],
  logs: readonly DeviceLogEntry[],
  currentBootId: string | undefined,
): OrphanedStagedRun[] => {
  if (currentBootId === undefined) return []
  // A recording another record already holds can complete nothing else: a Start whose acknowledgement
  // was lost and was pressed again stages a second same-name record, and only one of the two can
  // ever be completed.
  const linked = new Set(
    runs.flatMap((run) => (run.deviceRoast ? [recordingKey(run.deviceRoast.recordingOrigin)] : [])),
  )
  return runs.flatMap((run): OrphanedStagedRun[] => {
    const stagedBoot = run.deviceRoastPending?.bootId
    if (run.outcome !== 'running' || run.deviceRoast || run.manualRoast || stagedBoot === undefined) return []
    if (stagedBoot === currentBootId) return []
    const name = sanitizeRoastName(run.name)
    const sameRoast = logs.filter(
      (entry) => entry.mode === 'roast' && entry.bootId === stagedBoot && sanitizeRoastName(entry.name ?? '') === name,
    )
    // A recording with samples or an end reason is the normal reconciliation's to join; never
    // settle a record that could still be completed from it.
    const unclaimed = sameRoast.filter((entry) => !linked.has(recordingKey(entry.recordingOrigin)))
    if (unclaimed.some((entry) => (entry.samples ?? 0) > 0 || entry.roastEndReason !== undefined)) return []
    if (unclaimed.length > 0) return [{ run, reason: 'restarted' }]
    return [{ run, reason: sameRoast.length > 0 ? 'superseded' : 'unconfirmed' }]
  })
}

export const orphanedStagedRunNote = (reason: OrphanedStagedRun['reason']): string =>
  reason === 'restarted'
    ? 'The roaster restarted during this roast, so its recording holds no temperature samples. The setup details are kept.'
    : reason === 'superseded'
      ? 'Start was pressed again for this roast; the other record with the same name holds its recording. The setup details are kept.'
      : 'The roaster never confirmed this roast started and holds no recording of it. The setup details are kept.'
