/**
 * The mock controller itself: one simulated device, ticking continuously.
 *
 * ============================================================================================
 * THE CLOCK
 * ============================================================================================
 *
 * Everything runs on a SIMULATED clock (`nowMs`), advanced by the tick interval and scaled by the
 * speed multipliers. Nothing here reads `Date.now()` except to place that clock in wall time, and
 * that separation is what makes three otherwise awkward things trivial: fast-forwarding a
 * calibration pass, seeding an archive of runs that happened days ago, and driving a whole roast to
 * completion synchronously at startup to check the executor still works.
 *
 * The plant ticks whether or not anything is talking to it. A request is an observation of a
 * simulation that was already running, never the thing that advances it - which is the same
 * relationship the app has with a real roaster, and it is why polling and streaming at 1 Hz
 * see a consistent world.
 *
 * ============================================================================================
 * ARBITRATION
 * ============================================================================================
 *
 * One actuator and three programs may want it. Every start path goes through `busyRefusal`, in the
 * firmware's own gate order, so the app's blocked-reason strings are exercised against real
 * refusals rather than against nothing.
 */

import { defaultCalibration } from '../src/data/calibration'
import { richDemoDataset } from '../src/data/demoDataset'
import { minimumFanForHeat } from '../src/domain/actuatorFloors'
import { MANUAL_LIMITS } from '../src/domain/manualControl'
import { ROAST_LIMITS } from '../src/domain/roastProgram'
import type { CalibrationSettings } from '../src/domain/types'
import { Actuator } from './actuator'
import { Archive, type LogSource } from './archive'
import { CalibrationProgram, parseAppliedCoefficients, parseCalibrationArgs } from './calibration'
import {
  AMBIENT_C,
  ARCHIVE_LIST_BUSY_MS,
  ARCHIVE_RESERVE_BYTES,
  ARCHIVE_TOTAL_BYTES,
  BASELINE_MASS_G,
  COMPACT_ROAST_LOG_INTERVAL_MS,
  CONFIRM,
  COOLING_TAIL_MS,
  ENVELOPE_MARGIN_SEC,
  GLOBAL_SPEED,
  IDLE_PERSIST_MS,
  LOG_INTERVAL_MS,
  LOG_TAIL_MS,
  OVERTEMP_C,
  PLAUSIBLE,
  round1,
  round2,
  TICK_MS,
} from './config'
import {
  archiveFileBytes,
  encodePlanEnvelope,
  PLAN_JOURNAL_MAX_EVENTS,
  readArchiveFile,
  VERDICT_REASON,
} from './crkFile'
import { DocumentStore, MAX_INCOMING_LOG_BYTES, type StoreVerdict } from './dataStore'
import type { AppliedCoefficients, ProgramHost } from './host'
import { ManualSession } from './manual'
import { MOCK_ROASTER_IDENTITY, MOCK_THERMAL_MODEL } from './mockDeviceModel'
import { PERSISTED_STATE_VERSION, type PersistedState } from './persistence'
import { Plant } from './plant'
import { parseRoastArgs, parseZones, type Refusal, RoastProgram } from './roast'
import { seedArchive, seedDocuments } from './seed'

const ok = (body: Record<string, unknown> = {}) => ({ status: 200, body: { ok: true, ...body } })

export type CommandOutcome = { status: number; body: Record<string, unknown> }

const refuse = ({ status, message }: Refusal): CommandOutcome => ({ status, body: { ok: false, message } })

export class MockDevice implements ProgramHost {
  readonly plant = new Plant()
  readonly actuator = new Actuator()
  /** The `/data` document store. Shares the archive's volume and its derived 219,548-byte floor. */
  readonly data = new DocumentStore()
  readonly archive = new Archive(
    () => this.data.usedBytes(),
    () => this.thermocoupleOffsetC,
  )
  readonly manual = new ManualSession()
  roast?: RoastProgram
  calibration?: CalibrationProgram
  private calibrationCompletedSteps: Array<{
    index: number
    fan: number
    heat: number
    elapsed_sec: number
    temperature_c: number | null
    outcome: 'settled' | 'capped'
  }> = []
  private calibrationLogId = ''
  private calibrationCompletedEpoch = 0
  private calibrationReadinessReason: 'sensor_invalid' | 'ready' = 'sensor_invalid'
  private probeAvailable = true

  nowMs = 0
  bootCount = 1
  private stateRevision = 1n
  private liveSequence = 0
  thermocoupleOffsetC = -3
  private restoreLease?: { token: string; expiresAtMs: number }
  restoreIncomplete = false
  restoreDirty = false
  /** Nonzero, monotonic within this boot; atomically targets manual Set and Stop. */
  private roastSessionSequence = 0
  appliedCoefficients?: AppliedCoefficients
  /** Set whenever something worth persisting changed. The plugin flushes it. */
  dirty = false
  seeded = false

  /** Wall-clock milliseconds that `nowMs === 0` corresponds to. Moved to seed the archive in the past. */
  private epochBaseMs = Date.now()
  /** Nonzero while the post-stop Fan 10 / Heat 0 cooling tail runs; the deadline it stops at. */
  private coolingTailUntilMs = 0
  private idleSinceMs = 0
  /** When the recording stopped, which is what the persist delay is measured from. */
  private closedAtMs = 0
  /**
   * Until when `/api/logs` answers an explicit busy after the settle-time persist lands: the
   * device's storage worker is still absorbing the settle write burst then, and the app's archive
   * retry path only exists in dev if the mock can actually say so. See `ARCHIVE_LIST_BUSY_MS`.
   * Volatile by design - a power cycle empties the storage queue with it.
   */
  private archiveListBusyUntilMs = 0

  restore(state: PersistedState) {
    this.bootCount = state.bootCount + 1
    try {
      this.stateRevision = BigInt(state.stateRev ?? '1') || 1n
    } catch {
      this.stateRevision = 1n
    }
    this.thermocoupleOffsetC = Number.isFinite(state.thermocoupleOffsetC) ? state.thermocoupleOffsetC! : -3
    this.restoreIncomplete = state.restoreIncomplete === true
    this.restoreDirty = this.restoreIncomplete && state.restoreDirty === true
    this.archive.logs = state.logs
    this.archive.nextLogId = state.nextLogId
    this.archive.lastIssuedLogId =
      state.lastIssuedLogId ?? Math.max(0, state.nextLogId - 1, ...state.logs.map((log) => Number(log.id) || 0))
    this.archive.lostLogs = state.lostLogs
    this.archive.bootCount = this.bootCount
    this.appliedCoefficients = state.applied
    this.seeded = state.seeded
    this.data.restore(state.documents)
  }

  snapshot(): PersistedState {
    return {
      version: PERSISTED_STATE_VERSION,
      bootCount: this.bootCount,
      stateRev: this.stateRev,
      thermocoupleOffsetC: this.thermocoupleOffsetC,
      restoreIncomplete: this.restoreIncomplete || this.restoreLease !== undefined,
      restoreDirty: this.restoreDirty,
      nextLogId: this.archive.nextLogId,
      lastIssuedLogId: this.archive.lastIssuedLogId,
      lostLogs: this.archive.lostLogs,
      seeded: this.seeded,
      logs: this.archive.logs,
      applied: this.appliedCoefficients,
      documents: this.data.snapshot(),
    }
  }

  /** Seed a first-run controller with a plausible history, by actually running the programs. */
  seed() {
    if (this.seeded) {
      this.archive.bootCount = this.bootCount
      return
    }
    /*
     * A first-run roaster whose user has applied their first fit - which is the only state a
     * journey can be started from, and therefore the state the out-of-box dev flow has to be in.
     *
     * The values are the BEAN-scale estimated baseline (`estimatedBaseline.ts`), never a
     * pass-derived chamber fit: a chamber set's loss coefficient is more than an order of magnitude
     * larger, and seeding one here would hand the roast pre-flight a physically wrong model to
     * judge every zone against. `??=` because a restored state file's applied set - including one
     * deliberately cleared through the API - is the user's and is never overwritten.
     */
    const dataset = richDemoDataset()
    const applied = { ...defaultCalibration, ...dataset.appliedCalibration }
    this.appliedCoefficients ??= {
      heater_gain: applied.heaterGainCPerMinAt10,
      fan_cooling: applied.fanCoolingCPerMinAt10,
      cooling_fan: applied.coolingFanCPerMinAt10,
      loss_per_min: applied.thermalLossPerMinPerC,
      fit_id: applied.thermalSourceRunId ?? 'demo-applied-calibration',
      applied_epoch: Math.floor(Date.parse(applied.updatedAt ?? new Date().toISOString()) / 1000),
    }
    seedArchive(this)
    /*
     * The library, only if the store is genuinely untouched. A restored state file has already put
     * its documents back and must never be overwritten - "existing state loads unchanged" is the
     * whole contract of the persistence file, and a seeder that ignored it would silently discard
     * whatever the last session was actually reviewing.
     */
    if (this.data.documents.size === 0) seedDocuments(this.data, dataset, this.archive.usedBytes)
    this.seeded = true
    this.dirty = true
  }

  // ---------------------------------------------------------------------------------- ProgramHost

  epochSeconds(): number {
    return Math.floor((this.epochBaseMs + this.nowMs) / 1000)
  }

  get stateRev(): string {
    return this.stateRevision.toString(10)
  }

  bumpStateRevision(): string {
    this.stateRevision = this.stateRevision >= 0xffff_ffff_ffff_ffffn ? 1n : this.stateRevision + 1n
    this.dirty = true
    return this.stateRev
  }

  nextStreamSequence(): number {
    this.liveSequence = this.liveSequence >= 0xffff_ffff ? 1 : this.liveSequence + 1
    return this.liveSequence
  }

  /** The corrected thermocouple. Cold-junction/ambient never receives this offset. */
  reading(): number | undefined {
    return this.thermocoupleValid() ? round2(this.plant.thermocoupleC() + this.thermocoupleOffsetC) : undefined
  }

  thermocoupleValid(): boolean {
    return this.probeAvailable && this.actuator.fault !== 'thermal_sensor'
  }

  /** Test/dev control for a recoverable probe dropout, separate from the actuator's fault latch. */
  setProbeAvailable(available: boolean) {
    this.probeAvailable = available
    this.actuator.updateThermalInput(available && this.actuator.fault !== 'thermal_sensor', this.nowMs)
  }

  applied(): AppliedCoefficients | undefined {
    return this.appliedCoefficients
  }

  /** The coefficients the DEVICE holds, as the full model `journeyControlStep` wants. */
  modelCalibration(): CalibrationSettings {
    const applied = this.appliedCoefficients
    return {
      ...MOCK_THERMAL_MODEL,
      coolingTargetMarginC: 5,
      updatedAt: '1970-01-01T00:00:00.000Z',
      heaterGainCPerMinAt10: applied?.heater_gain ?? MOCK_THERMAL_MODEL.heaterGainCPerMinAt10,
      fanCoolingCPerMinAt10: applied?.fan_cooling ?? MOCK_THERMAL_MODEL.fanCoolingCPerMinAt10,
      coolingFanCPerMinAt10: applied?.cooling_fan ?? MOCK_THERMAL_MODEL.coolingFanCPerMinAt10,
      thermalLossPerMinPerC: applied?.loss_per_min ?? MOCK_THERMAL_MODEL.thermalLossPerMinPerC,
    }
  }

  // ----------------------------------------------------------------------------------- simulation

  /**
   * How much simulated time one millisecond of wall time buys right now.
   *
   * A fast-forwarded calibration pass keeps its multiplier through the passive decay tail that
   * lands in the log, so the whole pass is reviewable in minutes.
   */
  private speed(): number {
    return GLOBAL_SPEED * (this.fastForwarding && this.calibration ? this.calibration.speed : 1)
  }

  private fastForwarding = false

  private observeCalibrationReadiness(temperatureC: number | undefined) {
    if (temperatureC === undefined || !Number.isFinite(temperatureC)) {
      this.calibrationReadinessReason = 'sensor_invalid'
      return
    }
    this.calibrationReadinessReason = 'ready'
  }

  calibrationReadiness() {
    if (this.actuator.fault === 'thermal_sensor') {
      return { ready: false, reason: 'sensor_fault_latched' as const, stableForMs: 0 }
    }
    return {
      ready: this.calibrationReadinessReason === 'ready',
      reason: this.calibrationReadinessReason,
      stableForMs: 0,
    }
  }

  /** Advance wall time. Simulated time advances faster; the integration sub-step never does. */
  advance(realDtMs: number) {
    let remaining = realDtMs * this.speed()
    while (remaining > 0) {
      const dtMs = Math.min(remaining, TICK_MS)
      remaining -= dtMs
      this.step(dtMs)
    }
  }

  /** Advance SIMULATED time directly. The seeder drives this; the interval never does. */
  step(dtMs: number) {
    this.nowMs += dtMs
    /*
     * What is IN the chamber, which selects the plant's regime rather than merely scaling it. A batch
     * is present from roast start through the recording's passive tail. Everything else (a
     * calibration pass, a manual session, a heater proof) runs an EMPTY chamber, and an empty chamber
     * is a faster, hotter, lossier machine. Handing the reference mass to a baseline pass would
     * make a grid pass measure a bean model.
     */
    const roasting = this.roast?.active === true || (this.archive.active && this.archive.currentSource === 'roast')
    this.plant.step(dtMs / 1000, {
      fan: this.actuator.effectiveFan,
      heat: this.actuator.effectiveHeat,
      batchMassG: roasting ? this.roast!.spec.batchMassG : undefined,
    })

    // Firmware applies the persisted thermocouple correction once, before both
    // safety and control consume the reading, so the mock cannot display one
    // temperature and protect against another.
    const correctedReading = this.reading()
    this.observeCalibrationReadiness(correctedReading)
    this.actuator.updateThermalInput(correctedReading !== undefined, this.nowMs)
    const safetyProbeC = correctedReading ?? Number.NaN
    const events = this.actuator.tick(this.nowMs, dtMs, safetyProbeC)
    if (events.overtemperature) this.actuator.beginOvertempCooldown(this.nowMs)

    // The post-stop cooling tail retires itself: ten seconds elapsed, or the outputs were already
    // taken away by a fault or a successor instruction. Mirrors the firmware executor exactly.
    if (this.coolingTailUntilMs !== 0 && (this.nowMs >= this.coolingTailUntilMs || !this.actuator.busy)) {
      this.coolingTailUntilMs = 0
      this.actuator.stop(this.nowMs, this.plant.probeC)
    }

    const calibrationBefore = this.calibration?.active
      ? {
          index: this.calibration.stepIndex,
          fan: this.calibration.current?.fan ?? 0,
          heat: this.calibration.current?.heat ?? 0,
          elapsedSec: this.calibration.stepElapsedSec,
        }
      : undefined
    if (this.calibration?.active) this.calibration.tick(this, events.leaseExpired)
    if (
      calibrationBefore &&
      this.calibration &&
      (this.calibration.stepIndex !== calibrationBefore.index || !this.calibration.active) &&
      (this.calibration.lastStepAdvance === 'settled' || this.calibration.lastStepAdvance === 'capped')
    ) {
      this.calibrationCompletedSteps.push({
        index: calibrationBefore.index,
        fan: calibrationBefore.fan,
        heat: calibrationBefore.heat,
        elapsed_sec: Math.max(0, Math.round(calibrationBefore.elapsedSec)),
        temperature_c: this.reading() ?? null,
        outcome: this.calibration.lastStepAdvance,
      })
      this.calibrationCompletedSteps = this.calibrationCompletedSteps.slice(-12)
      if (!this.calibration.active && this.calibration.endReason === 'completed') {
        this.calibrationCompletedEpoch = this.epochSeconds()
      }
    }
    if (this.roast) this.roast.tick(this, events.leaseExpired)
    if (this.manual.active) this.manual.tick(this, events.leaseExpired)
    // The commands just issued are what this instant's log sample has to record.
    this.actuator.settle(this.nowMs)

    this.archive.sample(this.nowMs, {
      tcC: this.reading(),
      // The mock's thermal_sensor fault represents an open/faulted thermocouple input. Match the
      // MAX31856 capture contract: that invalidates TC, but the chip's independent internal
      // cold-junction/ambient measurement remains useful unless it has its own CJ-specific fault.
      cjC: this.plant.coldJunctionReadingC(),
      fan: this.actuator.effectiveFan,
      heat: this.actuator.effectiveHeat,
    })

    if (this.actuator.mode === 'idle') {
      /*
       * The recording stays open for the firmware's finalize window past the last output. That
       * window carries heat-soak rebound and clean passive decay into the log, which is required to
       * estimate thermal loss.
       */
      if (this.archive.active) {
        if (this.nowMs - this.idleSinceMs >= LOG_TAIL_MS) {
          this.archive.close(
            this.roast ? { zoneAttainedSec: [...this.roast.zoneAttainedSec], passiveTailComplete: true } : {},
          )
          this.closedAtMs = this.nowMs
          this.dirty = true
        }
      } else if (this.archive.unsaved && this.nowMs - this.closedAtMs >= IDLE_PERSIST_MS) {
        if (this.archive.persistFinished()) {
          this.bumpStateRevision()
          // The settle-time persist is a storage pile-up on the device; the list read defers.
          this.archiveListBusyUntilMs = this.nowMs + ARCHIVE_LIST_BUSY_MS
        }
      }
      // Fast-forward holds until the tail is in the log; sitting out three real minutes of decay is
      // exactly the wait the compression exists to remove.
      if (!this.archive.active) this.fastForwarding = false
    } else {
      this.idleSinceMs = this.nowMs
      this.closedAtMs = this.nowMs
    }
  }

  /** Run the simulation forward until a predicate holds, or the budget runs out. Seeding only. */
  runUntil(done: () => boolean, budgetSec = 7200) {
    const deadline = this.nowMs + budgetSec * 1000
    while (!done() && this.nowMs < deadline) this.step(TICK_MS)
  }

  /** Move the whole simulated history back in time, so seeded runs are dated plausibly. */
  setEpochBase(epochMs: number) {
    this.epochBaseMs = epochMs - this.nowMs
  }

  // --------------------------------------------------------------------------------------- gating

  get lifecycle(): string {
    if (this.actuator.conflictLatched) return 'MANUAL_LOCKOUT'
    if (this.actuator.fault !== 'none') return 'FAULT'
    if (this.roast?.active || this.calibration?.active || this.manual.active || this.actuator.mode === 'running')
      return 'RUNNING'
    return 'STANDBY'
  }

  /** The firmware's "another actuator operation is active" gate, with its own wording. */
  private busyRefusal(): Refusal | undefined {
    if (this.actuator.conflictLatched)
      return { status: 423, message: 'ESP actuation is disabled until the roaster is power-cycled.' }
    if (this.roast?.active) return { status: 409, message: 'A roast is already running.' }
    if (this.calibration?.active) return { status: 409, message: 'A calibration program is running.' }
    if (this.manual.active) return { status: 409, message: 'A manual session is running.' }
    if (this.actuator.busy) return { status: 409, message: 'Another actuator operation is active.' }
    if (this.actuator.fault !== 'none') return { status: 409, message: `Actuator fault: ${this.actuator.fault}` }
    return undefined
  }

  /** Flash writes wait for idle - the same 409 the archive and the document store answer. */
  private idleGate(): Refusal | undefined {
    return this.actuator.busy
      ? { status: 409, message: 'The controller defers flash writes until actuation finishes.' }
      : undefined
  }

  /** Storage formatting mirrors firmware's stricter destructive-mutation gate exactly. */
  storageWriteRefusal(): Refusal | undefined {
    if (this.roast?.active || this.calibration?.active || this.manual.active || this.actuator.busy) {
      return { status: 409, message: 'Formatting waits until actuation finishes.' }
    }
    if (this.archive.active || this.archive.unsaved) {
      return { status: 409, message: 'Formatting waits until the active or unsaved recording is finalized.' }
    }
    return undefined
  }

  // ------------------------------------------------------------------------------------- commands

  private maintenanceRefusal(): Refusal | undefined {
    if (this.restoreLease && this.nowMs >= this.restoreLease.expiresAtMs) {
      this.restoreLease = undefined
      this.restoreIncomplete = true
      this.dirty = true
    }
    return this.restoreLease
      ? { status: 423, message: 'A device restore is in progress; only read operations and Stop are available.' }
      : undefined
  }

  beginRestore(args: URLSearchParams): CommandOutcome {
    if (args.get('confirm') !== 'BEGIN_RESTORE')
      return refuse({ status: 409, message: 'confirm=BEGIN_RESTORE is required' })
    const idle = this.idleGate()
    if (idle) return refuse(idle)
    if (!this.restoreLease || this.nowMs >= this.restoreLease.expiresAtMs) {
      const wasIncomplete = this.restoreIncomplete
      const token = String(
        ((this.bootCount * 2654435761) ^ Math.floor(this.nowMs) ^ (this.liveSequence + 1)) >>> 0 || 1,
      )
      this.restoreLease = { token, expiresAtMs: this.nowMs + 120_000 }
      this.restoreIncomplete = true
      if (!wasIncomplete) this.restoreDirty = false
      this.dirty = true
    }
    return ok({
      restore_token: this.restoreLease.token,
      expires_in_ms: Math.max(0, this.restoreLease.expiresAtMs - this.nowMs),
      state_rev: this.stateRev,
    })
  }

  private validRestoreToken(args: URLSearchParams): boolean {
    return (
      this.restoreLease !== undefined &&
      this.nowMs < this.restoreLease.expiresAtMs &&
      args.get('restore_token') === this.restoreLease.token
    )
  }

  restoreTokenAccepted(args: URLSearchParams): boolean {
    return this.validRestoreToken(args)
  }

  markRestoreDirty() {
    if (!this.restoreIncomplete) return
    this.restoreDirty = true
    this.dirty = true
  }

  commitRestore(args: URLSearchParams): CommandOutcome {
    if (!this.validRestoreToken(args))
      return refuse({ status: 409, message: 'restore_token does not identify the active restore lease' })
    this.restoreLease = undefined
    this.restoreIncomplete = false
    this.restoreDirty = false
    return ok({ committed: true, state_rev: this.bumpStateRevision() })
  }

  abortRestore(args: URLSearchParams): CommandOutcome {
    if (!this.validRestoreToken(args))
      return refuse({ status: 409, message: 'restore_token does not identify the active restore lease' })
    if (this.restoreDirty)
      return {
        status: 409,
        body: {
          ok: false,
          incomplete: true,
          dirty: true,
          message:
            'Restore already changed device storage. Resume it and commit; abort cannot recover the previous library.',
        },
      }
    this.restoreLease = undefined
    this.restoreIncomplete = false
    this.restoreDirty = false
    this.dirty = true
    return ok({ aborted: true, state_rev: this.stateRev })
  }

  restoreStatus() {
    this.maintenanceRefusal()
    return {
      active: this.restoreLease !== undefined,
      incomplete: this.restoreIncomplete,
      dirty: this.restoreDirty,
      expires_in_ms: this.restoreLease ? Math.max(0, this.restoreLease.expiresAtMs - this.nowMs) : 0,
    }
  }

  setThermocoupleOffset(args: URLSearchParams): CommandOutcome {
    if (args.get('confirm') !== 'SET_THERMOCOUPLE_OFFSET')
      return refuse({ status: 409, message: 'confirm=SET_THERMOCOUPLE_OFFSET is required' })
    const blocked = this.maintenanceRefusal() ?? this.idleGate()
    if (blocked) return refuse(blocked)
    const offset = Number(args.get('offset_c'))
    if (!Number.isFinite(offset) || offset < -25 || offset > 25)
      return refuse({ status: 400, message: 'offset_c must be from -25.0 through 25.0 C' })
    this.thermocoupleOffsetC = round2(offset)
    return ok({ thermocouple_offset_c: this.thermocoupleOffsetC, state_rev: this.bumpStateRevision() })
  }

  startManual(args: URLSearchParams): CommandOutcome {
    const maintenance = this.maintenanceRefusal()
    if (maintenance) return refuse(maintenance)
    if (args.get('confirm') !== CONFIRM.manual)
      return refuse({ status: 409, message: 'confirm=MANUAL_CONTROL is required' })
    const requestedFan = Number(args.get('fan'))
    const heat = Number(args.get('heat'))
    if (!Number.isFinite(requestedFan) || requestedFan < 0 || requestedFan > 10) {
      return refuse({ status: 400, message: 'fan and heat must be decimals from 0.0 through 10.0.' })
    }
    if (!Number.isFinite(heat) || heat < MANUAL_LIMITS.heat.min || heat > MANUAL_LIMITS.heat.max) {
      return refuse({ status: 400, message: 'fan and heat must be decimals from 0.0 through 10.0.' })
    }
    // Heat on means Fan 1.0 or higher; a lower fan is lifted, not refused.
    const fan = heat > 0 ? Math.max(requestedFan, minimumFanForHeat(heat)) : requestedFan
    if (heat > 0 && !this.thermocoupleValid()) {
      return refuse({ status: 409, message: 'Heat needs a fresh, fault-free thermocouple reading.' })
    }
    // A newly accepted manual instruction preempts the post-stop cooling tail immediately —
    // the tail must never block manual controls.
    this.preemptCoolingTail()
    if (!this.manual.active) {
      const busy = this.busyRefusal()
      if (busy) return refuse(busy)
      // Match firmware: first actuation closes any preceding real recording, but Manual Controls
      // itself does not open an archive. Recordable manual work belongs to startRoast(mode=manual).
      this.archive.close()
      if (this.archive.persistFinished()) this.bumpStateRevision()
    }
    if (fan === 0 && heat === 0) return this.stopManual()
    const refusal = this.manual.set(this, fan, heat)
    if (refusal) return refuse({ status: 409, message: refusal })
    // So the response reports what is being driven rather than what the last tick was driving.
    this.actuator.settle(this.nowMs)
    this.dirty = true
    return ok({
      manual_active: true,
      fan_level: round1(fan),
      heat_level: round1(heat),
      // What the actuator will really drive, floors included - the app previews the same arithmetic.
      effective_fan: this.actuator.effectiveFan,
      effective_heat: this.actuator.effectiveHeat,
    })
  }

  stopManual(): CommandOutcome {
    this.manual.stop(this)
    this.actuator.cancelOvertempCooldown(this.nowMs, this.plant.probeC)
    // An explicit manual stop during the post-stop cooling tail means genuinely off, now.
    this.preemptCoolingTail()
    return ok({ manual_active: false, heater_off: true })
  }

  /**
   * A Stop that interrupts an ACTIVE ROAST is followed by a Fan 10 /
   * Heat 0 cooling tail for ten seconds, then outputs off — residual element and plate heat must
   * not sit against a stationary bean mass. The tail is an executor-authored instruction like any
   * other: any newly accepted instruction (a manual set, a new start, a second Stop) preempts it
   * immediately, recording closure and end_reason are unchanged, and the actuator itself is
   * untouched. Mirrors the firmware executor.
   */
  private beginCoolingTail() {
    const refusal = this.actuator.request(this.nowMs, 10, 0)
    if (refusal === undefined) this.coolingTailUntilMs = this.nowMs + COOLING_TAIL_MS
  }

  /** A newly accepted instruction owns the actuator; the tail's deadline stands down with it. */
  private releaseCoolingTail() {
    this.coolingTailUntilMs = 0
  }

  /** End the tail and its outputs now — a second Stop, or a start that needs idle outputs. */
  private preemptCoolingTail() {
    if (this.coolingTailUntilMs === 0) return
    this.releaseCoolingTail()
    this.actuator.stop(this.nowMs, this.plant.probeC)
  }

  /** Mock parity with firmware's workflow-agnostic immediate full stop. */
  stopAll(): CommandOutcome {
    const wasActive =
      this.calibration?.active === true ||
      this.manual.active ||
      this.roast?.active === true ||
      this.actuator.effectiveFan > 0 ||
      this.actuator.effectiveHeat > 0
    const roastWasActive = this.roast?.active === true
    this.calibration?.requestStop(this)
    this.manual.stop(this)
    this.roast?.requestStop(this)
    this.actuator.stop(this.nowMs, this.reading() ?? this.plant.probeC)
    this.actuator.cancelOvertempCooldown(this.nowMs, this.plant.probeC)
    // A repeated Stop during a cooling tail means genuinely off, now; a Stop that interrupted an
    // active roast earns the ten-second Fan 10 / Heat 0 tail.
    this.releaseCoolingTail()
    if (roastWasActive) this.beginCoolingTail()
    this.actuator.settle(this.nowMs)
    return ok({
      was_active: wasActive,
      heater_off: true,
      effective_fan: this.actuator.effectiveFan,
      effective_heat: this.actuator.effectiveHeat,
    })
  }

  startCalibration(args: URLSearchParams): CommandOutcome {
    const maintenance = this.maintenanceRefusal()
    if (maintenance) return refuse(maintenance)
    if (args.get('confirm') !== CONFIRM.calibration)
      return refuse({ status: 409, message: 'confirm=FOUR_DASHES_CALIBRATION is required' })
    const params = parseCalibrationArgs(args)
    if ('status' in params) return refuse(params)
    // Firmware reports the more actionable sensor-readiness refusal before it asks the actuator to
    // accept the program, including when the sensor fault has already latched the actuator.
    const readiness = this.calibrationReadiness()
    if (!readiness.ready) {
      return {
        status: 409,
        body: {
          ok: false,
          message: 'Calibration requires a fresh, fault-free thermocouple reading.',
          calibration_readiness: readiness.reason,
          stable_for_ms: readiness.stableForMs,
        },
      }
    }
    // A newly accepted start preempts the post-stop cooling tail immediately.
    this.preemptCoolingTail()
    const busy = this.busyRefusal()
    if (busy) return refuse(busy)

    const speed = Number(args.get('speed'))
    this.archive.open(this.nowMs, this.epochSeconds(), 'calibration', {
      initialPlan: {
        mode: 'calibration',
        steps: params.steps.map((step) => ({ fan: step.fan, heat: step.heat, durationSec: params.maxStepSeconds })),
        maxStepSeconds: params.maxStepSeconds,
        minStepSeconds: params.minStepSeconds,
        settleSeconds: params.settleSeconds,
        settleBandC: params.settleBandC,
      },
      planJournal: [],
    })
    this.calibrationCompletedSteps = []
    this.calibrationCompletedEpoch = 0
    this.calibrationLogId = this.archive.currentId ?? ''
    this.calibration = new CalibrationProgram(params, this, Number.isFinite(speed) && speed > 0 ? speed : undefined)
    this.fastForwarding = true
    this.dirty = true
    return ok({
      calibration_active: true,
      step_count: params.steps.length,
      step_seconds: params.maxStepSeconds,
      min_step_seconds: params.minStepSeconds,
      settle_seconds: params.settleSeconds,
      settle_band_c: params.settleBandC,
      // Not a firmware field. The mock says out loud that it is compressing time.
      mock_speed: this.calibration.speed,
      log_id: this.archive.currentId ?? '',
      plan_rev: 1,
      state_rev: this.stateRev,
    })
  }

  stopCalibration(): CommandOutcome {
    this.calibration?.requestStop(this)
    this.actuator.cancelOvertempCooldown(this.nowMs, this.plant.probeC)
    return ok({ calibration_active: false, heater_off: true })
  }

  applyCalibration(args: URLSearchParams): CommandOutcome {
    const restoreWrite = args.has('restore_token')
    const maintenance = this.maintenanceRefusal()
    if ((maintenance && !this.validRestoreToken(args)) || (restoreWrite && !this.validRestoreToken(args))) {
      return refuse({
        status: 423,
        message: 'A matching restore_token is required while restore maintenance is active',
      })
    }
    if (args.get('confirm') !== CONFIRM.applyCalibration)
      return refuse({ status: 409, message: 'confirm=APPLY_CALIBRATION is required' })
    const idle = this.idleGate()
    if (idle) return refuse(idle)
    if (args.get('clear') === 'true') {
      this.appliedCoefficients = undefined
      if (restoreWrite) this.markRestoreDirty()
      return ok({ present: false, cleared: true, state_rev: restoreWrite ? this.stateRev : this.bumpStateRevision() })
    }
    const parsed = parseAppliedCoefficients(args, this.epochSeconds())
    if ('status' in parsed) return refuse(parsed)
    this.appliedCoefficients = parsed
    if (restoreWrite) this.markRestoreDirty()
    return ok({
      present: true,
      fit_id: parsed.fit_id,
      state_rev: restoreWrite ? this.stateRev : this.bumpStateRevision(),
    })
  }

  /**
   * `POST /api/roast/start`, gated in the firmware's own order. The order is the contract: a latched
   * actuator is reported as a latch and not as "busy", and a journey without coefficients is
   * reported as missing calibration and not as a bad plan.
   */
  startRoast(args: URLSearchParams): CommandOutcome {
    const maintenance = this.maintenanceRefusal()
    if (maintenance) return refuse(maintenance)
    if (this.actuator.conflictLatched) {
      return refuse({ status: 423, message: 'ESP actuation is disabled until the roaster is power-cycled.' })
    }
    if (args.get('confirm') !== CONFIRM.roast)
      return refuse({ status: 409, message: 'confirm=START_ROAST is required' })

    const plan = parseRoastArgs(args, this.reading())
    if ('status' in plan) return refuse(plan)
    plan.profileId = (args.get('profile_id') ?? '').replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 64) || undefined
    const profileRevision = Number(args.get('profile_revision'))
    plan.profileRevision = Number.isInteger(profileRevision) && profileRevision > 0 ? profileRevision : undefined

    const applied = this.appliedCoefficients
    if (plan.mode === 'journey') {
      const plausible =
        applied !== undefined &&
        applied.heater_gain >= PLAUSIBLE.heater_gain.min &&
        applied.heater_gain <= PLAUSIBLE.heater_gain.max &&
        applied.fan_cooling >= PLAUSIBLE.fan_cooling.min &&
        applied.fan_cooling <= PLAUSIBLE.fan_cooling.max &&
        applied.cooling_fan >= PLAUSIBLE.cooling_fan.min &&
        applied.cooling_fan <= PLAUSIBLE.cooling_fan.max &&
        applied.loss_per_min >= PLAUSIBLE.loss_per_min.min &&
        applied.loss_per_min <= PLAUSIBLE.loss_per_min.max
      if (!plausible) {
        return refuse({
          status: 409,
          message:
            'A journey roast needs applied calibration coefficients. Fit and apply a calibration first, or run the roast in timed mode.',
        })
      }
    }

    const usesHeat =
      plan.mode === 'timed'
        ? plan.steps.some((step) => step.heat > 0)
        : plan.mode === 'journey'
          ? plan.zones.some((zone) => zone.heatMax > 0)
          : (plan.initialHeat ?? 0) > 0
    const readingC = this.reading()
    if (usesHeat && (readingC === undefined || readingC >= OVERTEMP_C)) {
      return refuse({
        status: 409,
        message: 'A plan that uses heat needs a fresh, fault-free thermocouple reading below 400 C.',
      })
    }

    // A newly accepted start preempts the post-stop cooling tail immediately.
    this.preemptCoolingTail()
    const busy = this.busyRefusal()
    if (busy) return refuse(busy)

    // Firmware persists the prior episode while outputs are still idle, before requesting the first
    // manual instruction. Flash writes must never begin after actuation has started.
    if (this.archive.persistFinished()) this.bumpStateRevision()
    const nextSession = this.roastSessionSequence >= 0xffffffff ? 1 : this.roastSessionSequence + 1
    const program = new RoastProgram(plan, this, nextSession)

    // Every accepted roast gets a valid plan-only file before its first actuator command. The
    // detailed/compact choice changes only the later sample cadence.
    this.archive.open(
      this.nowMs,
      this.epochSeconds(),
      'roast',
      {
        name: plan.name,
        batchMassG: plan.batchMassG,
        zoneCount: plan.zones.length,
        zoneAttainedSec: plan.zones.map(() => null),
        roastMode: plan.mode,
        profileId: plan.profileId,
        profileRevision: plan.profileRevision,
        initialPlan:
          plan.mode === 'timed'
            ? {
                mode: 'timed',
                steps: plan.steps.map((step) => ({ fan: step.fan, heat: step.heat, durationSec: step.durationSec })),
              }
            : plan.mode === 'journey'
              ? {
                  mode: 'journey',
                  zones: plan.zones.map((zone) => ({
                    startC: zone.startC,
                    endC: zone.endC,
                    durationSec: zone.durationSec,
                    fanMin: zone.fanMin,
                    fanMax: zone.fanMax,
                    heatMin: zone.heatMin,
                    heatMax: zone.heatMax,
                  })),
                }
              : { mode: 'manual', fan: plan.initialFan ?? 4, heat: plan.initialHeat ?? 0 },
        planJournal: plan.mode === 'manual' ? program.manualJournal : undefined,
      },
      plan.record ? LOG_INTERVAL_MS : COMPACT_ROAST_LOG_INTERVAL_MS,
    )
    if (!this.archive.persistProvisionalRoast()) {
      this.archive.discardCurrentRoast()
      return refuse({ status: 507, message: 'The roast occurrence could not be committed to storage.' })
    }
    this.bumpStateRevision()
    if (plan.mode === 'manual') {
      const refusal = program.setManual(this, plan.initialFan ?? 4, plan.initialHeat ?? 0)
      if (refusal) {
        this.archive.discardCurrentRoast()
        this.bumpStateRevision()
        return refuse({ status: 409, message: refusal })
      }
      this.actuator.settle(this.nowMs)
      program.recordManualInstruction(this.actuator.effectiveFan, this.actuator.effectiveHeat, true)
      this.archive.annotate({ planJournal: program.manualJournal })
    }
    this.roast = program
    this.roastSessionSequence = nextSession
    this.dirty = true

    const coefficients =
      applied === undefined
        ? undefined
        : {
            heater_gain: applied.heater_gain,
            fan_cooling: applied.fan_cooling,
            cooling_fan: applied.cooling_fan,
            loss_per_min: applied.loss_per_min,
            reference_batch_mass_g: BASELINE_MASS_G,
            fit_id: applied.fit_id,
          }
    return {
      status: 202,
      body: {
        ok: true,
        roast_active: true,
        mode: plan.mode,
        name: plan.name,
        batch_mass_g: plan.batchMassG,
        ambient_c: this.roast.ambientC,
        ambient_source: 'cold_junction',
        steps: plan.steps.length,
        zones: plan.zones.length,
        started_epoch: this.roast.startedEpoch,
        session_id: this.roast.sessionId,
        plan_rev: this.roast.planRevision,
        profile_id: plan.profileId ?? '',
        profile_revision: plan.profileRevision ?? 0,
        boot: this.bootCount,
        elapsed_sec: 0,
        thermal_log_interval_ms: this.archive.currentIntervalMs,
        log_id: this.archive.currentId ?? '',
        state_rev: this.stateRev,
        envelope_sec: this.roast.envelopeSec,
        ...(plan.mode === 'manual'
          ? {
              fan_level: round1(plan.initialFan ?? 4),
              heat_level: round1(plan.initialHeat ?? 0),
              accepted_fan: round1(plan.initialFan ?? 4),
              accepted_heat: round1(plan.initialHeat ?? 0),
              effective_fan: this.actuator.effectiveFan,
              effective_heat: this.actuator.effectiveHeat,
              instruction_limit_ms: 1_800_000,
            }
          : {}),
        ...(plan.mode === 'journey' ? { start_c: round1(plan.startC), coefficients } : {}),
      },
    }
  }

  activeRoastPlan(): CommandOutcome {
    const roast = this.roast
    if (!roast) return ok({ active: false, boot_id: String(this.bootCount), session_id: 0, plan_rev: 0 })
    return ok({
      active: roast.active,
      boot_id: String(this.bootCount),
      session_id: roast.sessionId,
      plan_rev: roast.planRevision,
      mode: roast.mode,
      profile_id: roast.spec.profileId ?? '',
      profile_revision: roast.spec.profileRevision ?? 0,
      name: roast.spec.name,
      start_c: roast.spec.startC,
      batch_mass_g: roast.spec.batchMassG,
      steps: roast.spec.steps.map((step) => ({ fan: step.fan, heat: step.heat, duration_sec: step.durationSec })),
      zones: roast.spec.zones.map((zone) => ({
        start_c: zone.startC,
        end_c: zone.endC,
        duration_sec: zone.durationSec,
        fan_min: zone.fanMin,
        fan_max: zone.fanMax,
        heat_min: zone.heatMin,
        heat_max: zone.heatMax,
      })),
      ...(roast.mode === 'journey'
        ? {
            initial_zones: roast.planJournal[0].change.map((zone) => ({
              start_c: zone.startC,
              end_c: zone.endC,
              duration_sec: zone.durationSec,
              fan_min: zone.fanMin,
              fan_max: zone.fanMax,
              heat_min: zone.heatMin,
              heat_max: zone.heatMax,
            })),
          }
        : {}),
      journal:
        roast.mode === 'manual' ? roast.manualJournal : roast.mode === 'timed' ? roast.timedJournal : roast.planJournal,
    })
  }

  patchRoastPlan(args: URLSearchParams): CommandOutcome {
    if (args.get('confirm') !== 'PATCH_ROAST_PLAN')
      return refuse({ status: 409, message: 'confirm=PATCH_ROAST_PLAN is required' })
    if (!this.roast?.active || (this.roast.mode !== 'journey' && this.roast.mode !== 'timed'))
      return refuse({ status: 409, message: 'No editable profiled roast is active.' })
    const roast = this.roast
    if (args.get('expected_session') !== String(roast.sessionId))
      return { status: 409, body: { ok: false, message: 'The roast session changed.', session_id: roast.sessionId } }
    if (args.get('expected_plan_rev') !== String(roast.planRevision))
      return {
        status: 409,
        body: {
          ok: false,
          message: 'The active plan changed.',
          session_id: roast.sessionId,
          plan_rev: roast.planRevision,
        },
      }
    if (roast.mode === 'timed') {
      const index = Number(args.get('step_index'))
      const fan = Number(args.get('fan'))
      const heat = Number(args.get('heat'))
      const durationSec = Number(args.get('duration_sec'))
      if (
        !Number.isInteger(index) ||
        index < roast.stepIndex ||
        index > roast.stepCount ||
        index >= ROAST_LIMITS.steps.max
      )
        return refuse({ status: 400, message: 'Only the current, upcoming, or next appended step can be edited.' })
      if (
        !Number.isFinite(fan) ||
        !Number.isFinite(heat) ||
        fan < 0 ||
        fan > 10 ||
        heat < 0 ||
        heat > 10 ||
        (fan === 0 && heat > 0)
      )
        return refuse({ status: 400, message: 'Fan and Heat must be 0.0 through 10.0; Fan 0 requires Heat 0.' })
      if (
        !Number.isInteger(durationSec) ||
        durationSec < ROAST_LIMITS.stepSeconds.min ||
        durationSec > ROAST_LIMITS.stepSeconds.max
      )
        return refuse({
          status: 400,
          message: `Step duration must be ${ROAST_LIMITS.stepSeconds.min} through ${ROAST_LIMITS.stepSeconds.max} seconds.`,
        })
      if (index === roast.stepIndex && durationSec < roast.timedStepElapsedSec + 5)
        return refuse({
          status: 400,
          message: `The current step must retain at least 5 seconds; enter ${roast.timedStepElapsedSec + 5} seconds or more.`,
        })
      if (roast.timedJournal.length >= PLAN_JOURNAL_MAX_EVENTS)
        return refuse({
          status: 409,
          message: 'This recording already contains the maximum 32 accepted live plan edits.',
        })
      // Heat on means Fan 1.0 or higher; a lower fan is lifted, not refused.
      const refusal = roast.applyTimedStep(this, index, {
        fan: Math.max(fan, minimumFanForHeat(heat)),
        heat,
        durationSec,
      })
      if (refusal) return refuse({ status: 409, message: refusal })
      this.archive.annotate({ planJournal: [...roast.timedJournal] })
      this.dirty = true
      return { status: 202, body: this.activeRoastPlan().body }
    }
    const parsed = parseZones(args.get('zones') ?? '', roast.spec.startC)
    if ('status' in parsed) return refuse(parsed)
    const current = roast.zoneIndex
    if (parsed.length <= current)
      return refuse({ status: 400, message: 'The patched plan must retain the active zone.' })
    const fields = ['startC', 'endC', 'durationSec', 'fanMin', 'fanMax', 'heatMin', 'heatMax'] as const
    for (let index = 0; index < current; index += 1) {
      if (!roast.spec.zones[index] || fields.some((field) => roast.spec.zones[index][field] !== parsed[index][field])) {
        return refuse({ status: 409, message: 'Completed zones are immutable.' })
      }
    }
    const oldZone = roast.spec.zones[current]
    const newZone = parsed[current]
    const oldDelta = oldZone.endC - oldZone.startC
    const newDelta = newZone.endC - oldZone.startC
    const oldHold = Math.abs(oldDelta) <= 0.5
    const newHold = Math.abs(newDelta) <= 0.5
    if (oldHold !== newHold || (!oldHold && oldDelta > 0 !== newDelta > 0)) {
      return refuse({
        status: 400,
        message: 'The active zone cannot reverse direction from its immutable entry temperature.',
      })
    }
    const zoneElapsed = Math.max(0, roast.elapsedSec - roast.zoneEntrySec)
    if (newZone.durationSec < zoneElapsed + 5)
      return refuse({ status: 400, message: `The active zone duration must be at least ${zoneElapsed + 5} seconds.` })
    const reading = this.reading()
    const crossed =
      reading !== undefined && !newHold && (newDelta > 0 ? reading >= newZone.endC : reading <= newZone.endC)
    if (crossed && args.get('allow_immediate_transition') !== '1') {
      return {
        status: 409,
        body: {
          ok: false,
          message: 'The new endpoint has already been crossed; explicitly allow the immediate transition.',
          requires_immediate_transition: true,
          plan_rev: roast.planRevision,
        },
      }
    }
    if (roast.planJournal.length - 1 >= PLAN_JOURNAL_MAX_EVENTS) {
      return refuse({
        status: 409,
        message: 'This recording already contains the maximum 32 accepted live plan edits.',
      })
    }
    const nextRevision = roast.planRevision >= 0xffffffff ? 1 : roast.planRevision + 1
    const candidateJournal = [
      ...roast.planJournal.slice(1),
      { elapsed_sec: roast.elapsedSec, plan_rev: nextRevision, change: parsed },
    ]
    try {
      encodePlanEnvelope({ mode: 'journey', zones: roast.planJournal[0].change }, candidateJournal)
    } catch {
      return refuse({ status: 409, message: "This edit would exceed the recording's 1024-byte plan-history bound." })
    }
    roast.applyJourneyPlan(parsed)
    if (crossed) roast.applyImmediateJourneyTransition(this)
    this.archive.annotate({ planJournal: roast.planJournal.slice(1) })
    this.dirty = true
    return { status: 202, body: { ...this.activeRoastPlan().body, immediate_transition: crossed } }
  }

  setRoast(args: URLSearchParams): CommandOutcome {
    const maintenance = this.maintenanceRefusal()
    if (maintenance) return refuse(maintenance)
    if (this.actuator.conflictLatched) {
      return refuse({ status: 423, message: 'ESP actuation is disabled until the roaster is power-cycled.' })
    }
    if (args.get('confirm') !== CONFIRM.roastControl)
      return refuse({ status: 409, message: 'confirm=CONTROL_ROAST is required' })
    if (!this.roast?.active || this.roast.mode !== 'manual') {
      return refuse({ status: 409, message: 'No manual roast is running.' })
    }
    if (args.get('expected_session') !== String(this.roast.sessionId)) {
      return refuse({ status: 409, message: 'The manual roast session changed; refresh before sending controls.' })
    }
    const requestedFan = Number(args.get('fan'))
    const heat = Number(args.get('heat'))
    if (
      !Number.isFinite(requestedFan) ||
      requestedFan < MANUAL_LIMITS.fan.min ||
      requestedFan > MANUAL_LIMITS.fan.max
    ) {
      return refuse({ status: 400, message: 'Fan must be between 0.1 and 10.0' })
    }
    if (!Number.isFinite(heat) || heat < MANUAL_LIMITS.heat.min || heat > MANUAL_LIMITS.heat.max) {
      return refuse({ status: 400, message: 'Heat must be between 0.0 and 10.0' })
    }
    // Heat on means Fan 1.0 or higher; a lower fan is lifted, not refused.
    const fan = Math.max(requestedFan, minimumFanForHeat(heat))
    const readingC = this.reading()
    if (heat > 0 && (readingC === undefined || readingC >= OVERTEMP_C)) {
      return refuse({ status: 409, message: 'Heat needs a fresh, fault-free thermocouple reading below 400 C.' })
    }
    if (this.roast.manualJournal.length >= PLAN_JOURNAL_MAX_EVENTS) {
      return refuse({
        status: 409,
        message: 'This recording already contains the maximum 32 accepted manual instructions.',
      })
    }
    const refusal = this.roast.setManual(this, fan, heat)
    if (refusal) return refuse({ status: 409, message: refusal })
    this.actuator.settle(this.nowMs)
    this.roast.recordManualInstruction(this.actuator.effectiveFan, this.actuator.effectiveHeat)
    this.archive.annotate({ planJournal: this.roast.manualJournal })
    this.dirty = true
    return {
      status: 202,
      body: {
        ok: true,
        roast_active: true,
        mode: 'manual',
        name: this.roast.spec.name,
        boot: this.bootCount,
        started_epoch: this.roast.startedEpoch,
        session_id: this.roast.sessionId,
        elapsed_sec: this.roast.elapsedSec,
        plan_rev: this.roast.planRevision,
        fan_level: round1(fan),
        heat_level: round1(heat),
        accepted_fan: round1(fan),
        accepted_heat: round1(heat),
        effective_fan: this.actuator.effectiveFan,
        effective_heat: this.actuator.effectiveHeat,
        instruction_age_ms: 0,
        instruction_limit_ms: 1_800_000,
      },
    }
  }

  stopRoast(args = new URLSearchParams()): CommandOutcome {
    const wasActive = this.roast?.active === true
    const expectedSession = args.get('expected_session')
    if (
      wasActive &&
      ((expectedSession !== null && expectedSession !== String(this.roast!.sessionId)) ||
        (this.roast?.mode === 'manual' && expectedSession === null))
    ) {
      return refuse({ status: 409, message: 'The manual roast session changed; refresh before stopping it.' })
    }
    this.roast?.requestStop(this)
    this.actuator.cancelOvertempCooldown(this.nowMs, this.plant.probeC)
    // The post-stop cooling tail: Fan 10 / Heat 0 for ten seconds after a Stop that
    // interrupted an active roast; a repeated Stop during the tail means genuinely off, now.
    if (wasActive) this.beginCoolingTail()
    else this.preemptCoolingTail()
    this.actuator.settle(this.nowMs)
    return ok({
      roast_active: false,
      was_active: wasActive,
      mode: this.roast?.mode ?? 'none',
      name: this.roast?.spec.name ?? '',
      boot: this.bootCount,
      started_epoch: this.roast?.startedEpoch ?? 0,
      session_id: this.roast?.sessionId ?? 0,
      elapsed_sec: this.roast?.elapsedSec ?? 0,
      heater_off: true,
      effective_fan: this.actuator.effectiveFan,
      effective_heat: this.actuator.effectiveHeat,
      end_reason: this.roast?.endReason ?? 'none',
    })
  }

  deleteLog(args: URLSearchParams): CommandOutcome {
    const maintenance = this.maintenanceRefusal()
    if (maintenance) return refuse(maintenance)
    if (args.get('confirm') !== CONFIRM.deleteLog)
      return refuse({ status: 409, message: 'confirm=DELETE_LOG is required' })
    const idle = this.idleGate()
    if (idle) return refuse(idle)
    const rawId = args.get('id') ?? ''
    const parsedId = Number(rawId)
    if (!/^[0-9]+$/.test(rawId) || !Number.isInteger(parsedId) || parsedId < 1 || parsedId > 0xfffffffe) {
      return refuse({ status: 400, message: 'id must be a decimal recording id from 1 through 4294967294.' })
    }
    const id = String(parsedId)
    if (!this.archive.delete(id)) return refuse({ status: 404, message: 'No stored recording with that id' })
    return ok({ deleted: id, state_rev: this.bumpStateRevision() })
  }

  /**
   * `POST /api/logs/restore?id=..&confirm=RESTORE_LOG`, one raw `.crk` body.
   *
   * The gate order is the firmware's, and the order is the contract: a missing confirm token is
   * reported as a missing confirm token rather than as a bad file, and an over-cap upload is refused
   * from its binary length before validation.
   *
   *   confirm -> id -> size cap -> idle -> validation -> volume reserve -> write
   *
   * Room is a REFUSAL (`507`) and never a sweep: pruning here would delete recordings out of the
   * very backup being restored, in an order the user never chose. The check is the conservative
   * one - `used + file + reserve > total` - because on an overwrite the temp and the file it
   * replaces are both on the volume until the rename.
   */
  restoreLog(args: URLSearchParams, bytes: Uint8Array): CommandOutcome {
    if (args.get('confirm') !== CONFIRM.restoreLog)
      return refuse({ status: 409, message: 'confirm=RESTORE_LOG is required' })
    if (this.restoreIncomplete && !this.validRestoreToken(args))
      return refuse({
        status: 423,
        message: 'Restore maintenance is active or incomplete; a matching restore_token is required',
      })
    const requestedId = args.get('id') ?? ''
    const autoAllocate = requestedId === 'auto'
    if (!autoAllocate && (!/^[1-9][0-9]*$/.test(requestedId) || Number(requestedId) >= 0xffffffff)) {
      return {
        status: 400,
        body: {
          ok: false,
          check: 'id',
          message: "id must be 'auto' or a positive decimal recording id below 4294967295",
        },
      }
    }
    if (bytes.length > MAX_INCOMING_LOG_BYTES)
      return refuse({ status: 413, message: `A recording may be at most ${MAX_INCOMING_LOG_BYTES} bytes` })
    const idle = this.idleGate()
    if (idle) return refuse(idle)
    const read = readArchiveFile(bytes, requestedId)
    if (read.verdict !== 'ok' || !read.log) {
      return { status: 400, body: { ok: false, check: read.verdict, message: VERDICT_REASON[read.verdict] } }
    }
    const used = this.archive.usedBytes + this.data.usedBytes()
    if (used + bytes.length + ARCHIVE_RESERVE_BYTES > ARCHIVE_TOTAL_BYTES) {
      return refuse({
        status: 507,
        message:
          'There is not enough room on the roaster for that recording, and a restore never deletes one to make room',
      })
    }
    const id = autoAllocate ? String(this.archive.nextLogId) : requestedId
    read.log.id = id
    const replaced = this.archive.restore(read.log)
    if (this.restoreIncomplete) this.markRestoreDirty()
    else this.bumpStateRevision()
    this.dirty = true
    return ok({
      id: Number(id),
      bytes: bytes.length,
      version: read.log.version,
      samples: read.log.samples.length,
      replaced,
      origin_log_id: Number(read.log.recordingOriginLogId),
      recorded_on: read.log.recordedOn,
      recording_origin: { deviceId: read.log.recordedOn!.deviceId, logId: read.log.recordingOriginLogId },
      storage_address: { deviceId: MOCK_ROASTER_IDENTITY.deviceId, logId: id },
      count: this.archive.logs.length,
      logseq: this.archive.lastIssuedLogId,
      state_rev: this.stateRev,
    })
  }
  /*
   * ------------------------------------------------------------------------------ the document store
   *
   * Reads are ALWAYS allowed - a browser can list and render the whole store mid-roast - and only
   * the committing of bytes waits for idle. That asymmetry is the whole reason the write queue in
   * the app is reviewable on the dev instance: start a mock roast, edit a bean note, and the write
   * really is refused with a 409 that carries no `conflict` flag.
   */
  readData(target: string): StoreVerdict {
    return this.data.read(target)
  }

  manifestPage(cursor: string | null): CommandOutcome {
    if (!this.data.mounted) return refuse({ status: 503, message: 'Document storage is not mounted' })
    const match = cursor === null ? undefined : /^m:([0-9]+)$/.exec(cursor)
    if (cursor !== null && !match) return refuse({ status: 400, message: 'cursor is not a valid manifest cursor' })
    const offset = match ? Number(match[1]) : 0
    const byteLength = (value: string) => new TextEncoder().encode(value).length
    const collections: Record<string, { bytes: number; version: number } | null> = {
      profiles: null,
      beans: null,
      calibrations: null,
      meta: null,
    }
    const entries: Array<
      | { kind: 'run'; value: { id: string; bytes: number; version: number } }
      | { kind: 'log'; value: { id: string; bytes: number } }
    > = []
    for (const [key, document] of this.data.documents) {
      if (document.corrupt) continue
      if (key.startsWith('runs/')) {
        entries.push({
          kind: 'run',
          value: { id: key.slice('runs/'.length), bytes: byteLength(document.payload), version: document.version },
        })
      } else if (Object.hasOwn(collections, key)) {
        collections[key] = { bytes: byteLength(document.payload), version: document.version }
      }
    }
    entries.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'run' ? -1 : 1
      return left.value.id.localeCompare(right.value.id, undefined, { numeric: true })
    })
    for (const log of this.archive.logs) {
      entries.push({ kind: 'log', value: { id: log.id, bytes: archiveFileBytes(log) } })
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > entries.length) {
      return refuse({ status: 400, message: 'cursor is outside the manifest' })
    }
    const pageSize = 64
    const page = entries.slice(offset, offset + pageSize)
    const nextOffset = offset + page.length
    return ok({
      state_rev: this.stateRev,
      boot_id: String(this.bootCount),
      collections,
      runs: page.filter((entry) => entry.kind === 'run').map((entry) => entry.value),
      logs: page.filter((entry) => entry.kind === 'log').map((entry) => entry.value),
      ...(nextOffset < entries.length ? { next_cursor: `m:${nextOffset}` } : {}),
      restore_maintenance: this.restoreStatus(),
    })
  }

  listRunData(): StoreVerdict {
    return this.data.listRuns()
  }

  writeData(target: string, payload: string, baseRaw: string | null, restoreToken?: string | null): StoreVerdict {
    const restoreWrite = restoreToken !== undefined && restoreToken !== null
    if (
      (this.maintenanceRefusal() && !restoreWrite) ||
      (restoreWrite && !this.validRestoreToken(new URLSearchParams({ restore_token: restoreToken })))
    ) {
      return {
        status: 423,
        body: { ok: false, message: 'A matching restore_token is required while restore maintenance is active' },
      }
    }
    // Match the firmware data-store gate: a live passive tail blocks the write;
    // a closed recording is persisted before the document body is considered.
    if (!this.actuator.busy && !this.archive.active && this.archive.unsaved) {
      if (this.archive.persistFinished()) this.bumpStateRevision()
    }
    const verdict = this.data.write(target, payload, baseRaw, {
      idle: !this.actuator.busy,
      archiveState: this.archive.active ? 'recording' : 'ready',
      otherUsedBytes: this.archive.usedBytes,
      volumeTotalBytes: ARCHIVE_TOTAL_BYTES,
    })
    if (verdict.status === 200) {
      if (restoreWrite) this.markRestoreDirty()
      else this.bumpStateRevision()
      if (verdict.body && typeof verdict.body === 'object')
        (verdict.body as Record<string, unknown>).state_rev = this.stateRev
    }
    return verdict
  }

  deleteData(args: URLSearchParams): StoreVerdict {
    if (this.maintenanceRefusal())
      return { status: 423, body: { ok: false, message: 'A device restore is in progress' } }
    const verdict = this.data.remove(
      args.get('target') ?? '',
      args.get('confirm'),
      args.get('base'),
      !this.actuator.busy,
    )
    if (verdict.status === 200) {
      this.bumpStateRevision()
      if (verdict.body && typeof verdict.body === 'object')
        (verdict.body as Record<string, unknown>).state_rev = this.stateRev
    }
    return verdict
  }

  calibrationProgress() {
    return {
      log_id: this.calibrationLogId,
      completed_epoch: this.calibrationCompletedEpoch,
      step_elapsed_sec: this.calibration?.active ? Math.round(this.calibration.stepElapsedSec) : 0,
      settle_state: this.calibration?.active ? this.calibration.settleState : undefined,
      completed_steps: this.calibrationCompletedSteps.map((event) => ({ ...event })),
    }
  }

  /** Ambient is a property of the room, not of the device. Exposed so the seeder can read it. */
  readonly ambientC = AMBIENT_C
  /** The envelope margin, echoed for the start response. */
  readonly envelopeMarginSec = ENVELOPE_MARGIN_SEC

  /** What the current recording is, for the status document. */
  currentLogSource(): LogSource | 'none' {
    return this.archive.currentSource
  }

  /** Whether `GET /api/logs` currently answers the firmware's explicit `503 + Retry-After` busy. */
  archiveListBusy(): boolean {
    return this.nowMs < this.archiveListBusyUntilMs
  }
}
