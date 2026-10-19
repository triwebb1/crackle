/**
 * The two documents the app reads: `GET /api/status` and `GET /api/live`.
 *
 * Every field name here was taken from `src/controller/client.ts` rather than from prose, because
 * the CLIENT is the authority on what the contract actually is: a field the parser does not read is
 * decoration, and a field it reads that the mock does not emit degrades silently to "not reported",
 * which is the failure mode a mock exists to prevent. Where the firmware README and the parser could
 * be read differently, the parser wins.
 *
 * Two rules the parser imposes that are easy to get wrong, and are honoured here:
 *
 *   - **`end_reason: "none"` is the idle sentinel** for the calibration, manual and roast blocks. It
 *     is parsed away to undefined, so it must be sent as the literal string rather than omitted.
 *   - **The PRESENCE of a block is feature detection.** `roast` is how the app detects the on-device
 *     executor, `log_archive` is how it detects the recordings archive, and `applied_calibration`
 *     with `present: false` is a real answer meaning "this device holds none". Emitting them is what
 *     makes the mock answer like firmware 2026-07-26.39 and later rather than 2026-07-26.37.
 */

import { mockRecordedOn } from './archive'
import { appliedCalibrationDocument } from './calibration'
import {
  API_VERSION,
  APP_USED_BYTES,
  ARCHIVE_TOTAL_BYTES,
  FIRMWARE_VERSION,
  HOLDOVER_LIMIT_MS,
  LOG_CAPACITY_SAMPLES,
  MANUAL_INSTRUCTION_LIMIT_MS,
  OTA_SLOT_BYTES,
  OVERTEMP_C,
  round1,
  round2,
} from './config'
import { MAX_INCOMING_LOG_BYTES } from './dataStore'
import type { MockDevice } from './device'
import { MOCK_ROASTER_IDENTITY } from './mockDeviceModel'

/** The roast block, always present - running or not - so a reconnecting browser can find out what happened. */
const roastDocument = (device: MockDevice) => {
  const roast = device.roast
  if (!roast) {
    return {
      active: false,
      mode: 'none',
      name: '',
      elapsed_sec: 0,
      started_epoch: 0,
      session_id: 0,
      plan_rev: 0,
      step_index: 0,
      step_elapsed_sec: 0,
      step_count: 0,
      zone_index: 0,
      zone_count: 0,
      zone_entry_sec: 0,
      zone_elapsed_sec: 0,
      zone_nominal_sec: 0,
      zone_end_c: null,
      target_c: null,
      commanded_fan: 0,
      commanded_heat: 0,
      solved_fan: 0,
      solved_heat: 0,
      correction_total: 0,
      integral: 0,
      saturated: false,
      holdover: false,
      holdover_ms: 0,
      holdover_limit_ms: HOLDOVER_LIMIT_MS,
      ambient_c: 0,
      batch_mass_g: 0,
      lease_renewals: 0,
      zone_attained_sec: [],
      envelope_sec: 0,
      end_reason: 'none',
      instruction_age_ms: 0,
      instruction_limit_ms: 0,
    }
  }
  return {
    active: roast.active,
    mode: roast.mode,
    name: roast.spec.name,
    elapsed_sec: roast.elapsedSec,
    started_epoch: roast.startedEpoch,
    session_id: roast.sessionId,
    plan_rev: roast.planRevision,
    profile_id: roast.spec.profileId ?? '',
    profile_revision: roast.spec.profileRevision ?? 0,
    step_index: roast.mode === 'timed' ? roast.stepIndex : 0,
    step_elapsed_sec: roast.mode === 'timed' ? roast.timedStepElapsedSec : 0,
    step_count: roast.stepCount,
    zone_index: roast.zoneIndex,
    zone_count: roast.zoneCount,
    zone_entry_sec: roast.zoneEntrySec,
    zone_elapsed_sec: Math.max(0, roast.elapsedSec - roast.zoneEntrySec),
    zone_nominal_sec: roast.zoneNominalSec,
    zone_end_c: roast.zoneEndC ?? null,
    target_c: roast.mode === 'journey' ? (roast.targetC ?? null) : null,
    commanded_fan: roast.commandedFan,
    commanded_heat: roast.commandedHeat,
    solved_fan: roast.solvedFan,
    solved_heat: roast.solvedHeat,
    correction_total: roast.correctionTotal,
    integral: roast.integral,
    saturated: roast.saturated,
    holdover: roast.holdover,
    holdover_ms: roast.holdoverMs,
    holdover_limit_ms: HOLDOVER_LIMIT_MS,
    ambient_c: roast.ambientC,
    batch_mass_g: roast.spec.batchMassG,
    lease_renewals: device.actuator.leaseRenewals,
    instruction_age_ms: roast.instructionAgeMs(device.nowMs) ?? 0,
    instruction_limit_ms: roast.mode === 'manual' ? MANUAL_INSTRUCTION_LIMIT_MS : 0,
    zone_attained_sec: roast.zoneAttainedSec,
    envelope_sec: roast.envelopeSec,
    end_reason: roast.endReason,
  }
}

const calibrationDocument = (device: MockDevice) => {
  const program = device.calibration
  const progress = device.calibrationProgress()
  return {
    active: program?.active === true,
    started_epoch: program?.startedEpoch ?? 0,
    step_index: program?.stepIndex ?? 0,
    step_count: program?.stepCount ?? 0,
    current_fan_level: program?.current?.fan ?? 0,
    current_heat_level: program?.current?.heat ?? 0,
    max_step_seconds: program?.params.maxStepSeconds ?? 0,
    min_step_seconds: program?.params.minStepSeconds ?? 0,
    settle_seconds: program?.params.settleSeconds ?? 0,
    settle_band_c: program?.params.settleBandC ?? 0,
    last_step_advance: program?.lastStepAdvance ?? 'settled',
    log_id: progress.log_id,
    completed_epoch: progress.completed_epoch,
    step_elapsed_sec: progress.step_elapsed_sec,
    settle_state: progress.settle_state,
    completed_steps: progress.completed_steps,
    lease_renewals: device.actuator.leaseRenewals,
    end_reason: program?.endReason ?? 'none',
  }
}

const manualDocument = (device: MockDevice) => ({
  active: device.manual.active,
  fan_level: device.manual.fanLevel,
  heat_level: device.manual.heatLevel,
  since_ms: device.manual.sinceMs(device.nowMs),
  end_reason: device.manual.endReason ?? 'none',
  // The 30-minute instruction lease, exactly as the firmware names it. These replaced
  // `keepalive_ms_ago` / `keepalive_limit_ms` one for one.
  instruction_age_ms: device.manual.instructionAgeMs(device.nowMs),
  instruction_limit_ms: MANUAL_INSTRUCTION_LIMIT_MS,
})

const thermalLogDocument = (device: MockDevice) => ({
  active: device.archive.active,
  samples: device.archive.currentSamples,
  capacity: LOG_CAPACITY_SAMPLES,
  interval_ms: device.archive.currentIntervalMs,
  download: '/thermal.csv',
  source: device.currentLogSource(),
  log_id: device.archive.currentId ?? '',
  unsaved: device.archive.unsaved,
})

/**
 * The whole volume, exactly as `LittleFS.usedBytes()` reports it: recordings AND `/data`.
 *
 * This is the number the firmware puts in `log_archive.used_bytes`. Reporting the archive's share
 * alone would hide a double-counting bug in the app - adding `data_store.used_bytes` on top of it
 * overstates a real roaster by the size of its library and warns about pruning while there is
 * still room. A mock whose semantics differ from the
 * device is worse than no mock: it does not fail to catch the bug, it CERTIFIES it.
 */
const volumeUsedBytes = (device: MockDevice) => device.archive.usedBytes + device.data.usedBytes()

/** The `log_archive` block. Its presence is the archive's feature detection. */
export const logArchiveDocument = (device: MockDevice) => {
  /*
   * `/logs` and `/data` are tenants of one LittleFS volume. `DocumentStore.mounted` is therefore
   * the mock's single volume-health authority, rather than letting the two status blocks disagree.
   */
  const mounted = device.data.mounted
  const usedBytes = mounted ? volumeUsedBytes(device) : 0
  return {
    mounted,
    count: mounted ? device.archive.logs.length : 0,
    // Volume-wide, despite the block it lives in - see `volumeUsedBytes` and crackle.ino's emission.
    used_bytes: usedBytes,
    total_bytes: mounted ? ARCHIVE_TOTAL_BYTES : 0,
    free_bytes: mounted ? Math.max(0, ARCHIVE_TOTAL_BYTES - usedBytes) : 0,
    // The mock's clock is the host's, so it is always "synced" - a real device with no internet
    // reports false, and every log it writes then carries epoch 0.
    clock_synced: true,
    lost_logs: device.archive.lostLogs,
    needs_format: !mounted,
    health: mounted ? 'healthy' : 'needs_format',
    /*
     * The FEATURE DETECTION for backup and restore, and it has to be a key rather than the block:
     * `log_archive` predates those endpoints, so unlike `data_store` its presence proves nothing about
     * them. Its value is the binary file cap a client must respect - 104 + 4800 x 25.
     */
    restore_max_bytes: MAX_INCOMING_LOG_BYTES,
  }
}

/**
 * The `data_store` block. Its presence is the document store's feature detection, exactly as
 * `log_archive` is the recordings archive's - so it is emitted whether or not the volume is mounted.
 */
export const dataStoreDocument = (device: MockDevice) =>
  device.data.statusBlock(ARCHIVE_TOTAL_BYTES, device.archive.usedBytes)

export const statusDocument = (device: MockDevice, websocketPort?: number, websocketClients = 0) => {
  const valid = device.thermocoupleValid()
  const reading = device.reading()
  return {
    ok: true,
    firmware_version: FIRMWARE_VERSION,
    roaster: {
      device_id: MOCK_ROASTER_IDENTITY.deviceId,
      model_id: MOCK_ROASTER_IDENTITY.modelId,
      display_name: MOCK_ROASTER_IDENTITY.displayName,
      simulated: true,
      simulates_model_id: MOCK_ROASTER_IDENTITY.simulatesModelId,
    },
    boot_count: device.bootCount,
    boot_id: String(device.bootCount),
    state_rev: device.stateRev,
    thermocouple_offset_c: device.thermocoupleOffsetC,
    calibration_ready: device.calibrationReadiness().ready,
    calibration_readiness: device.calibrationReadiness().reason,
    calibration_stable_for_ms: device.calibrationReadiness().stableForMs,
    uptime_ms: Math.round(device.nowMs),
    lifecycle: device.lifecycle,
    manual_conflict_latched: device.actuator.conflictLatched,
    actuator: {
      mode: device.actuator.mode,
      fault: device.actuator.fault,
      requested_fan: round1(device.actuator.requestedFan),
      requested_heat: round1(device.actuator.requestedHeat),
      effective_fan: device.actuator.effectiveFan,
      effective_heat: device.actuator.effectiveHeat,
      overtemp_limit_c: OVERTEMP_C,
      overtemp_cooldown_remaining_ms:
        device.actuator.overtempCooldownUntilMs === 0
          ? 0
          : Math.max(0, Math.round(device.actuator.overtempCooldownUntilMs - device.nowMs)),
      lease_renewals: device.actuator.leaseRenewals,
    },
    max31856: {
      temperature_valid: valid,
      thermocouple_c: reading ?? null,
      thermocouple_raw_c: valid ? device.plant.thermocoupleC() : null,
      thermocouple_offset_c: device.thermocoupleOffsetC,
      calibration_offset_c: device.thermocoupleOffsetC,
      // An open thermocouple does not invalidate the MAX31856's independent cold-junction sensor.
      cold_junction_c: device.plant.coldJunctionReadingC(),
      fault: valid ? 'none' : 'open_circuit',
    },
    thermal_log: thermalLogDocument(device),
    log_archive: logArchiveDocument(device),
    data_store: dataStoreDocument(device),
    applied_calibration: appliedCalibrationDocument(device.applied()),
    calibration: calibrationDocument(device),
    manual: manualDocument(device),
    roast: roastDocument(device),
    restore_maintenance: device.restoreStatus(),
    capabilities: {
      api_version: API_VERSION,
      diagnostic_tests: true,
      manual_roast: true,
    },
    live_websocket_available: websocketPort !== undefined,
    live_websocket_port: websocketPort ?? 0,
    live_websocket_client_count: websocketPort === undefined ? 0 : websocketClients,
    live_websocket_client_capacity: 4,
    http_rejected_request_count: 0,
    http_worker_failure_count: 0,
    http_worker_stack_low_water_bytes: 8_192,
    storage_worker_stack_low_water_bytes: 8_192,
    app_used_bytes: APP_USED_BYTES,
    ota_slot_bytes: OTA_SLOT_BYTES,
    app_free_bytes: OTA_SLOT_BYTES - APP_USED_BYTES,
    spiffs_reserved_bytes: ARCHIVE_TOTAL_BYTES,
    controller_history_used_bytes: device.archive.usedBytes,
    controller_history_enabled: true,
  }
}

/** The compact snapshot, shared by `/api/live` and the 1 Hz stream. */
export const liveDocument = (device: MockDevice) => {
  const reading = device.reading()
  const roast = device.roast
  return {
    firmware_version: FIRMWARE_VERSION,
    roaster: {
      device_id: MOCK_ROASTER_IDENTITY.deviceId,
      model_id: MOCK_ROASTER_IDENTITY.modelId,
      display_name: MOCK_ROASTER_IDENTITY.displayName,
      simulated: true,
      simulates_model_id: MOCK_ROASTER_IDENTITY.simulatesModelId,
    },
    capabilities: { api_version: API_VERSION, diagnostic_tests: true, manual_roast: true },
    manual_conflict_latched: device.actuator.conflictLatched,
    boot_id: String(device.bootCount),
    state_rev: device.stateRev,
    stream_seq: device.nextStreamSequence(),
    roast_session_id: roast?.sessionId ?? 0,
    plan_rev: roast?.planRevision ?? 0,
    tc_c: reading ?? null,
    cj_c: device.plant.coldJunctionReadingC(),
    fan: device.actuator.effectiveFan,
    heat: device.actuator.effectiveHeat,
    fan_req: round1(device.actuator.requestedFan),
    heat_req: round1(device.actuator.requestedHeat),
    mode: device.actuator.mode,
    fault: device.actuator.fault,
    cal_active: device.calibration?.active === true,
    cal_step: device.calibration?.stepIndex ?? 0,
    cal_count: device.calibration?.stepCount ?? 0,
    manual_active: device.manual.active,
    manual_since_ms: device.manual.sinceMs(device.nowMs),
    log_samples: device.archive.currentSamples,
    roast_active: roast?.active === true,
    roast_journey: roast?.mode === 'journey',
    roast_mode: roast?.mode ?? 'none',
    roast_saturated: roast?.saturated === true,
    roast_holdover: roast?.holdover === true,
    roast_name: roast?.spec.name ?? '',
    roast_started_epoch: roast?.startedEpoch ?? 0,
    roast_batch_g: roast?.spec.batchMassG ?? 0,
    roast_ambient_c: roast?.ambientC ?? 0,
    roast_elapsed_s: roast?.elapsedSec ?? 0,
    roast_zone: roast?.zoneIndex ?? 0,
    roast_zones: roast?.zoneCount ?? 0,
    roast_target_c: roast?.mode === 'journey' ? round2(roast.targetC ?? 0) : null,
    // The rest of the executor's per-tick progress tuple: full status is deferred while
    // anything actuates, so the live stream must carry everything the cockpit renders per tick.
    // Null discipline matches the firmware: journey-only values are null in every other mode.
    roast_zone_entry_s: roast?.zoneEntrySec ?? 0,
    roast_zone_nominal_s: roast?.zoneNominalSec ?? 0,
    roast_zone_end_c: roast?.mode === 'journey' ? (roast.zoneEndC ?? null) : null,
    roast_correction: roast?.mode === 'journey' ? round2(roast.correctionTotal ?? 0) : null,
    roast_integral: roast?.mode === 'journey' ? round2(roast.integral ?? 0) : null,
    roast_solved_fan: round2(roast?.solvedFan ?? 0),
    roast_solved_heat: round2(roast?.solvedHeat ?? 0),
    roast_holdover_ms: roast?.holdoverMs ?? 0,
    roast_zones_done: roast?.zoneAttainedSec ?? [],
    roast_end: roast?.endReason ?? 'none',
  }
}

/** The `/api/logs` body: the index, the current recording, and the filesystem behind them. */
export const logIndexDocument = (device: MockDevice) => {
  const valid = device.archive.logs.filter((log) => log.version === 4 && log.recordedOn && log.recordingOriginLogId)
  const quarantined = device.archive.logs
    .filter((log) => !valid.includes(log))
    .map((log) => ({
      reason: 'missing_recording_provenance',
      storage_address: { deviceId: MOCK_ROASTER_IDENTITY.deviceId, logId: log.id },
      download: `/logs/${log.id}.crk`,
    }))
  const recordedOn = mockRecordedOn()
  const currentId = device.archive.currentId
  return {
    ok: true,
    ...logArchiveDocument(device),
    logs: valid.map((log) => device.archive.entry(log)),
    quarantined,
    current: {
      active: device.archive.active,
      unsaved: device.archive.unsaved,
      samples: device.archive.currentSamples,
      interval_ms: device.archive.currentIntervalMs,
      source: device.currentLogSource(),
      recorded_on: recordedOn,
      recording_origin: currentId ? { deviceId: recordedOn.deviceId, logId: currentId } : null,
      storage_address: null,
    },
  }
}
