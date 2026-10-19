/**
 * The detailed/compact thermal log and the recordings archive behind it.
 *
 * Two things live here because on the device they are two ends of one pipe: a run is recorded into
 * RAM at its per-run cadence, and once the actuator is fully idle it is written to flash as
 * `/logs/<id>.crk` and becomes an archive entry. The mock reproduces the pipe, including the states
 * the app has to be able to render honestly:
 *
 *   - `unsaved` is a NORMAL state, not a fault. A log that has finished recording but has not been
 *     persisted yet is exactly what the firmware produces after every roast, and `/thermal.csv`
 *     serves it in the meantime.
 *   - Proof/calibration logs shorter than 30 samples are discarded; every roast keeps its occurrence.
 *   - Every new entry is provenance-bearing archive v4. Persisted older dev fixtures are quarantined
 *     and the mock state schema is bumped when a clean reseed is required.
 */

import { thermalCsvHeader } from '../src/domain/thermalLog'
import type { RoastEndReason } from '../src/domain/types'
import {
  ARCHIVE_RESERVE_BYTES,
  ARCHIVE_TOTAL_BYTES,
  FIRMWARE_VERSION,
  LOG_CAPACITY_SAMPLES,
  LOG_HEADER_BYTES,
  LOG_INTERVAL_MS,
  LOG_SAMPLE_BYTES,
  MIN_ARCHIVED_SAMPLES,
  round2,
  round3,
} from './config'
import { encodePlanEnvelope, encodeSamples } from './crkFile'
import { MOCK_ROASTER_IDENTITY } from './mockDeviceModel'

export type LogSource = 'proof' | 'calibration' | 'manual' | 'roast'

/** `[t_ms, thermocouple_c | null, cold_junction_c | null, effective_fan, effective_heat]`. */
export type LogSample = [number, number | null, number | null, number, number]

export interface ArchivedTimedStep {
  fan: number
  heat: number
  durationSec: number
}

export interface ArchivedJourneyZone {
  startC: number
  endC: number
  durationSec: number
  fanMin: number
  fanMax: number
  heatMin: number
  heatMax: number
}

/** Immutable instructions captured when the device accepted a roast start. */
export type ArchivedRoastPlan =
  | { mode: 'timed'; steps: ArchivedTimedStep[] }
  | { mode: 'journey'; zones: ArchivedJourneyZone[] }
  | { mode: 'manual'; fan: number; heat: number }

/** Exact diagnostic program accepted by the controller when calibration recording began. */
export interface ArchivedCalibrationProgram {
  mode: 'calibration'
  steps: ArchivedTimedStep[]
  maxStepSeconds: number
  minStepSeconds: number
  settleSeconds: number
  settleBandC: number
}

export type ArchivedPlan = ArchivedRoastPlan | ArchivedCalibrationProgram

export type ArchivedPlanChange =
  | { elapsed_sec: number; plan_rev: number; step_index: number; step: ArchivedTimedStep }
  | { elapsed_sec: number; plan_rev: number; change: ArchivedJourneyZone[] }
  | {
      elapsed_sec: number
      plan_rev: number
      requested_fan: number
      requested_heat: number
      effective_fan: number
      effective_heat: number
    }

export interface RecordedOn {
  deviceId: string
  modelId: string
  displayNameAtCapture: string
  simulated: boolean
  firmwareVersion: string
  identitySource: 'roaster'
  simulatesModelId?: string
}

export const mockRecordedOn = (): RecordedOn => ({
  deviceId: MOCK_ROASTER_IDENTITY.deviceId,
  modelId: MOCK_ROASTER_IDENTITY.modelId,
  displayNameAtCapture: MOCK_ROASTER_IDENTITY.displayName,
  simulated: true,
  firmwareVersion: FIRMWARE_VERSION,
  identitySource: 'roaster',
  simulatesModelId: MOCK_ROASTER_IDENTITY.simulatesModelId,
})

export interface StoredLog {
  id: string
  boot: number
  source: LogSource
  /** Unix seconds at the first sample, or 0 for "the clock had never synced". */
  startEpoch: number
  intervalMs: number
  /** New recordings are v4. Older identity-less dev fixtures may exist only to exercise quarantine. */
  version: 1 | 2 | 3 | 4
  recordedOn?: RecordedOn
  recordingOriginLogId?: string
  /** Correction already applied to every stored thermocouple sample. */
  thermocoupleOffsetC?: number
  name?: string
  batchMassG?: number
  zoneCount?: number
  zoneAttainedSec?: Array<number | null>
  /** Which first-class roast contract produced a `source=roast` recording. */
  roastMode?: 'timed' | 'journey' | 'manual'
  roastStopSec?: number
  roastEndReason?: RoastEndReason
  /** False whenever the full passive decay tail did not complete; the archive does not guess why. */
  passiveTailComplete?: boolean
  /** Compact payload length; not derivable from sample count. */
  encodedBytes?: number
  /** Stable provenance captured while the recording is still volatile. */
  profileId?: string
  profileRevision?: number
  initialPlan?: ArchivedPlan
  planJournal?: ArchivedPlanChange[]
  samples: LogSample[]
}

/** Optional run metadata copied into the v4 archive header/payload. */
export interface LogMeta {
  name?: string
  batchMassG?: number
  zoneCount?: number
  zoneAttainedSec?: Array<number | null>
  roastMode?: 'timed' | 'journey' | 'manual'
  roastStopSec?: number
  roastEndReason?: RoastEndReason
  passiveTailComplete?: boolean
  profileId?: string
  profileRevision?: number
  initialPlan?: ArchivedPlan
  planJournal?: ArchivedPlanChange[]
}

interface CurrentLog {
  id: string
  source: LogSource
  startEpoch: number
  intervalMs: number
  samples: LogSample[]
  thermocoupleOffsetC: number
  meta: LogMeta
}

/**
 * What one recording costs on the volume - the size of the FILE, per its own version.
 *
 * v1 and v2 are a fixed stride (`header + samples x 12`). v3 is a delta-varint stream whose length
 * only the file itself knows, which is precisely why the v3 header carries `encodedBytes` at all,
 * and from version 3 on no client may infer a size from the sample count.
 */
const logBytes = (log: StoredLog) =>
  log.version === 4
    ? 220 +
      encodeSamples(log.samples).length +
      (log.initialPlan ? encodePlanEnvelope(log.initialPlan, log.planJournal).length : 0)
    : (log.version === 2 ? LOG_HEADER_BYTES : 32) + log.samples.length * LOG_SAMPLE_BYTES

/** The CSV every log is served as, current or stored. One format, one writer. */
export const logCsv = (samples: LogSample[]): string => {
  const rows = samples.map(([tMs, tcC, cjC, fan, heat]) =>
    [
      Math.round(tMs),
      tcC === null ? '' : round2(tcC).toFixed(2),
      cjC === null ? '' : round2(cjC).toFixed(2),
      round3(fan).toFixed(3),
      round3(heat).toFixed(3),
    ].join(','),
  )
  return `${thermalCsvHeader}\n${rows.join('\n')}\n`
}

export class Archive {
  logs: StoredLog[] = []
  /** Firmware `logseq`: the last id issued, distinct from the next unused candidate. */
  lastIssuedLogId = 0
  nextLogId = 1
  lostLogs = 0
  /** Which power cycle is writing. Set by the device; carried into every entry. */
  bootCount = 1

  /** The run being recorded right now, or the finished one that has not reached flash yet. */
  private current?: CurrentLog
  private recording = false
  private nextSampleAtMs = 0
  private startedAtMs = 0

  constructor(
    private readonly otherVolumeUsedBytes: () => number = () => 0,
    private readonly currentThermocoupleOffsetC: () => number = () => -3,
  ) {}

  /** UINT32_MAX is reserved; choose a positive unused id when the sequence wraps. */
  private availableAfter(id: number): number {
    const occupied = new Set(this.logs.map((log) => log.id))
    let candidate = id >= 0xfffffffe ? 1 : id + 1
    while (occupied.has(String(candidate))) {
      candidate = candidate >= 0xfffffffe ? 1 : candidate + 1
    }
    return candidate
  }

  /** Newest-first age on the firmware's valid 1..UINT32_MAX-1 id ring. */
  private ageFromLastIssued(id: string): number {
    const numeric = Number(id)
    if (!Number.isInteger(numeric) || numeric <= 0 || numeric > 0xfffffffe || this.lastIssuedLogId <= 0) {
      return Number.MAX_SAFE_INTEGER
    }
    return this.lastIssuedLogId >= numeric
      ? this.lastIssuedLogId - numeric
      : 0xfffffffe - numeric + this.lastIssuedLogId
  }

  private orderNewestFirst() {
    this.logs.sort((left, right) => this.ageFromLastIssued(left.id) - this.ageFromLastIssued(right.id))
  }

  get active() {
    return this.recording
  }
  get unsaved() {
    return this.current !== undefined && !this.recording
  }
  get currentSource(): LogSource | 'none' {
    return this.current?.source ?? 'none'
  }
  get currentSamples() {
    return this.current?.samples.length ?? 0
  }
  get currentId() {
    return this.current?.id
  }
  get currentIntervalMs() {
    return this.current?.intervalMs ?? LOG_INTERVAL_MS
  }
  get currentCsv() {
    return logCsv(this.current?.samples ?? [])
  }

  /**
   * Open a new log. The previous one is finalized and persisted FIRST, while outputs are still idle
   * - the firmware's rule, and the reason a fan-only test cannot contaminate a decay tail.
   *
   * `close()` first, because a recording may still be running out its post-idle tail (see
   * `LOG_TAIL_MS`): the firmware ends that tail early when the next episode starts, and a recording
   * that is cut short is still a recording. Dropping it on the floor would lose a whole run whenever
   * somebody started the next one promptly.
   */
  open(nowMs: number, epochSeconds: number, source: LogSource, meta: LogMeta = {}, intervalMs = LOG_INTERVAL_MS) {
    this.close()
    this.persistFinished()
    // Reserve identity at open so volatile and archived provenance share one id.
    const id = String(this.nextLogId)
    this.lastIssuedLogId = this.nextLogId
    this.nextLogId = this.availableAfter(this.lastIssuedLogId)
    this.current = {
      id,
      source,
      startEpoch: epochSeconds,
      intervalMs,
      samples: [],
      thermocoupleOffsetC: this.currentThermocoupleOffsetC(),
      meta: source === 'roast' ? { ...meta, passiveTailComplete: false } : meta,
    }
    this.recording = true
    this.startedAtMs = nowMs
    this.nextSampleAtMs = nowMs
  }

  /** Update the current log's header - a roast earns its attainments while it is being recorded. */
  annotate(meta: LogMeta) {
    if (this.current) this.current.meta = { ...this.current.meta, ...meta }
  }

  sample(nowMs: number, reading: { tcC?: number; cjC?: number; fan: number; heat: number }) {
    if (!this.recording || !this.current) return
    if (nowMs < this.nextSampleAtMs) return
    if (this.current.samples.length >= LOG_CAPACITY_SAMPLES) {
      this.recording = false
      return
    }
    this.current.samples.push([
      // The SLOT's time, not the tick's. A 1 Hz log is stamped 0, 1000, 2000 - the sub-second
      // jitter of whichever simulation step happened to cross the boundary is not data.
      Math.round(this.nextSampleAtMs - this.startedAtMs),
      reading.tcC ?? null,
      reading.cjC ?? null,
      reading.fan,
      reading.heat,
    ])
    this.nextSampleAtMs += this.current.intervalMs
    if (this.current.samples.length >= LOG_CAPACITY_SAMPLES) this.recording = false
    // A long stall must not produce a burst of catch-up samples.
    if (this.nextSampleAtMs < nowMs) this.nextSampleAtMs = nowMs + this.current.intervalMs
  }

  /** Commit the accepted roast plan to simulated flash while the live samples remain in RAM. */
  persistProvisionalRoast(): StoredLog | undefined {
    const current = this.current
    if (!current || !this.recording || current.source !== 'roast' || !current.meta.initialPlan) return undefined
    const stored: StoredLog = {
      id: current.id,
      boot: this.bootCount,
      source: 'roast',
      startEpoch: current.startEpoch,
      intervalMs: current.intervalMs,
      version: 4,
      samples: [],
      recordedOn: mockRecordedOn(),
      recordingOriginLogId: current.id,
      thermocoupleOffsetC: current.thermocoupleOffsetC,
      name: current.meta.name,
      batchMassG: current.meta.batchMassG,
      zoneCount: current.meta.zoneCount ?? 0,
      zoneAttainedSec: current.meta.zoneAttainedSec ?? [],
      roastMode: current.meta.roastMode,
      encodedBytes: encodePlanEnvelope(current.meta.initialPlan).length,
      profileId: current.meta.profileId,
      profileRevision: current.meta.profileRevision,
      initialPlan: current.meta.initialPlan,
      planJournal: [],
      passiveTailComplete: false,
    }
    const existing = this.logs.findIndex((log) => log.id === stored.id)
    if (existing >= 0) this.logs.splice(existing, 1)
    this.logs.unshift(stored)
    this.orderNewestFirst()
    this.enforceRetention()
    return stored
  }

  /** Remove a pre-actuation provisional after a synchronous command refusal. */
  discardCurrentRoast() {
    const id = this.current?.id
    this.current = undefined
    this.recording = false
    if (id !== undefined) {
      const existing = this.logs.findIndex((log) => log.id === id)
      if (existing >= 0) this.logs.splice(existing, 1)
    }
  }

  /** Stop recording. The log is now `unsaved`, which is a state the app is required to render. */
  close(meta: LogMeta = {}) {
    if (!this.recording) return
    this.recording = false
    this.annotate(meta)
  }

  /**
   * Write the finished log to "flash". Called only when the actuator is fully idle, exactly as the
   * firmware defers every flash write, and a run too short to mean anything is dropped rather than
   * stored.
   */
  persistFinished(): StoredLog | undefined {
    if (!this.current || this.recording) return undefined
    const finished = this.current
    this.current = undefined
    // Every accepted roast is an authoritative occurrence, even when compact
    // cadence plus an immediate Stop yields only a handful of samples. Proof
    // and calibration retain their existing evidence-quality floor.
    const minimumSamples = finished.source === 'roast' ? 1 : MIN_ARCHIVED_SAMPLES
    if (finished.samples.length < minimumSamples) return undefined

    const isRoast = finished.source === 'roast'
    const stored: StoredLog = {
      id: finished.id,
      boot: this.bootCount,
      source: finished.source,
      startEpoch: finished.startEpoch,
      intervalMs: finished.intervalMs,
      version: 4,
      recordedOn: mockRecordedOn(),
      recordingOriginLogId: finished.id,
      thermocoupleOffsetC: finished.thermocoupleOffsetC,
      samples: finished.samples,
      encodedBytes:
        encodeSamples(finished.samples).length +
        (finished.meta.initialPlan
          ? encodePlanEnvelope(finished.meta.initialPlan, finished.meta.planJournal).length
          : 0),
      initialPlan: finished.meta.initialPlan,
      planJournal: finished.meta.planJournal,
      ...(isRoast
        ? {
            name: finished.meta.name,
            batchMassG: finished.meta.batchMassG,
            zoneCount: finished.meta.zoneCount ?? 0,
            zoneAttainedSec: finished.meta.zoneAttainedSec ?? [],
            roastMode: finished.meta.roastMode,
            roastStopSec: finished.meta.roastStopSec,
            roastEndReason: finished.meta.roastEndReason,
            passiveTailComplete: finished.meta.passiveTailComplete ?? true,

            profileId: finished.meta.profileId,
            profileRevision: finished.meta.profileRevision,
          }
        : {}),
    }
    const existing = this.logs.findIndex((log) => log.id === stored.id)
    if (existing >= 0) this.logs.splice(existing, 1)
    this.logs.unshift(stored)
    this.orderNewestFirst()
    this.enforceRetention()
    return stored
  }

  /**
   * Oldest first out as the volume fills. A pruned recording increments `lost_logs` - the counter
   * the firmware added so a recording that goes away can never do so silently.
   */
  private enforceRetention() {
    while (
      this.usedBytes + this.otherVolumeUsedBytes() > ARCHIVE_TOTAL_BYTES - ARCHIVE_RESERVE_BYTES &&
      this.logs.length > 1
    ) {
      this.logs.pop()
      this.lostLogs += 1
    }
  }

  get usedBytes(): number {
    return this.logs.reduce((sum, log) => sum + logBytes(log), 0)
  }

  find(id: string): StoredLog | undefined {
    return this.logs.find((log) => log.id === id)
  }

  delete(id: string): boolean {
    const index = this.logs.findIndex((log) => log.id === id)
    if (index < 0) return false
    this.logs.splice(index, 1)
    return true
  }

  /**
   * Put a restored recording on the volume.
   *
   * **Restore wins** - an id that already holds a recording is overwritten, with no conflict token
   * and no version dance, because a restore is not an edit: it is the user replaying an archive
   * they already hold, and a restore that stopped to ask about each collision would not be one.
   *
   * **And it never prunes.** The persist path sweeps oldest-first because a finished roast has
   * nowhere else to go; a restore that swept would be deleting recordings out of the very backup it
   * is restoring, in an order the user never chose. Room is a REFUSAL here (see `device.restoreLog`),
   * decided before this is called.
   *
   * The id counter only ever RISES to a restored id. Without it, restoring an archive onto a
   * formatted device leaves the counter at 1 and the next roast is written over recording #1.
   * Rewinding it would be worse still: a device that has since gone further would start handing out
   * ids that already exist.
   */
  restore(log: StoredLog): boolean {
    const index = this.logs.findIndex((entry) => entry.id === log.id)
    const replaced = index >= 0
    if (replaced) this.logs.splice(index, 1)
    this.logs.push(log)
    const id = Number(log.id) || 0
    if (id > this.lastIssuedLogId) {
      this.lastIssuedLogId = id
    }
    // A restore below logseq can still occupy the wrapped next candidate.
    // Firmware scans the files on every allocation, so the mock must rescan too.
    this.nextLogId = this.availableAfter(this.lastIssuedLogId)
    this.orderNewestFirst()
    return replaced
  }

  /** One `/api/logs` entry, in the firmware's own field names. */
  entry(log: StoredLog): Record<string, unknown> {
    const base: Record<string, unknown> = {
      id: log.id,
      boot: log.boot,
      duration_ms: log.samples.at(-1)?.[0] ?? 0,
      samples: log.samples.length,
      interval_ms: log.intervalMs,
      source: log.source,
      start_epoch: log.startEpoch,
      bytes: logBytes(log),
      version: log.version,
      download: `/logs/${log.id}.csv`,
    }
    if (log.version === 4) {
      // From version 4 there is no fixed stride, so the entry states the payload and the codec.
      base.payload_bytes = log.encodedBytes ?? 0
      base.codec = log.initialPlan ? 2 : 1
      const recordedOn = log.recordedOn!
      base.recorded_on = recordedOn
      base.recording_origin = { deviceId: recordedOn.deviceId, logId: log.recordingOriginLogId ?? log.id }
      base.thermocouple_offset_c = log.thermocoupleOffsetC
      base.storage_address = { deviceId: MOCK_ROASTER_IDENTITY.deviceId, logId: log.id }
      if (log.roastEndReason !== undefined && log.roastStopSec !== undefined) {
        base.roast_stop_sec = log.roastStopSec
        base.roast_end_reason = log.roastEndReason
      }
      if (log.source === 'roast') base.passive_tail_complete = log.passiveTailComplete !== false
    }
    if (log.version >= 2) {
      base.name = log.name ?? ''
      // 0 is the firmware's "not a roast, or mass unknown" - it has no other way to spell absence.
      base.batch_mass_g = log.batchMassG ?? 0
      base.zone_count = log.zoneCount ?? 0
      base.zone_attained_sec = log.zoneAttainedSec ?? []
      base.roast_mode = log.roastMode ?? (base.zone_count ? 'journey' : 'timed')
    }
    return base
  }
}
