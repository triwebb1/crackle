import type { CalibrationProgramProgressStatus, LiveSnapshot } from '../controller/client'
import type { ControllerStatus } from './types'

const ACTIVE_ACTUATOR_MODES = new Set(['running', 'fan_startup', 'fan_only', 'heating', 'zero_cross_wait'])

/**
 * True only when a connected compact stream carries direct evidence that an
 * output-owning operation is still in progress. This is deliberately broader
 * than the three program flags because older firmware may report only its actuator mode or levels.
 */
export const liveIndicatesActuation = (live?: LiveSnapshot): boolean =>
  Boolean(
    live?.connected &&
      (live.calibrationActive ||
        live.manualActive ||
        live.roastActive ||
        (live.effectiveFan ?? 0) > 0 ||
        (live.effectiveHeat ?? 0) > 0 ||
        (live.actuatorMode !== undefined && ACTIVE_ACTUATOR_MODES.has(live.actuatorMode))),
  )
/** Passive recording is status-unsafe, but is not actuation and must not imply Running or Stop. */
export const liveBlocksFullStatus = (live?: LiveSnapshot): boolean =>
  Boolean(live?.connected && (live.thermalLogActive || liveIndicatesActuation(live)))
/** Full-status work is safe only when the latest merged controller state is idle. */
export const statusIndicatesActuation = (status: ControllerStatus): boolean =>
  Boolean(
    status.connected &&
      (status.calibration?.active ||
        status.manual?.active ||
        status.roast?.active ||
        (status.effectiveFan ?? 0) > 0 ||
        (status.effectiveHeat ?? 0) > 0 ||
        status.lifecycle === 'RUNNING' ||
        (status.actuatorMode !== undefined && ACTIVE_ACTUATOR_MODES.has(status.actuatorMode))),
  )
/**
 * Overlays the 1 Hz WebSocket or `/api/live` fallback onto the explicitly reconciled `/api/status` document.
 *
 * The two polls answer different questions. Status is the contract - capabilities, firmware, the
 * full calibration and manual blocks - and stays on its slow cadence because it is large and the
 * controller's web server is synchronous. Live carries only what visibly moves: probe temperature,
 * effective fan and heat, mode, fault, and compact program progress.
 *
 * Merging here rather than in each view is what makes every screen update from the shared live transport without any of
 * them knowing there are two polls. The rules are deliberately narrow: live may only refresh fields
 * it actually carries, it may never invent a capability or a lifecycle it has no evidence for, and
 * a failed live poll changes nothing at all - only the status poll decides that the controller is
 * gone. `receivedAtMs` advances on a good live poll, which is what keeps the staleness check honest:
 * a controller answering the fast endpoint is not stale.
 */
export const mergeLiveSnapshot = (status: ControllerStatus, live?: LiveSnapshot): ControllerStatus => {
  if (!live?.connected) return status
  const fault = live.fault ?? status.fault
  // During controller work, full status is intentionally deferred. Current firmware therefore sends
  // the immutable controller contract with compact live state; durable catalogs still remain status-only.
  // Older frames omit those fields and continue to fail closed instead of being guessed.
  const coldLiveShell = !status.connected
  const calibrationRecordingMatches =
    live.thermalLogSource === 'calibration' &&
    live.calibrationId !== undefined &&
    live.thermalLogId === live.calibrationId
  const calibration =
    (status.calibration as CalibrationProgramProgressStatus | undefined) ??
    (coldLiveShell && (live.calibrationActive || calibrationRecordingMatches)
      ? { active: live.calibrationActive }
      : undefined)
  const thermalLog =
    status.thermalLog ??
    (coldLiveShell &&
    live.thermalLogActive !== undefined &&
    live.thermalLogSource !== undefined &&
    live.thermalLogSource !== 'none'
      ? { active: live.thermalLogActive, logId: live.thermalLogId, source: live.thermalLogSource }
      : undefined)
  const manual =
    status.manual ??
    (coldLiveShell && live.capabilities !== undefined
      ? {
          active: live.manualActive,
          fanLevel: live.requestedFan,
          heatLevel: live.requestedHeat,
          sinceMs: live.manualSinceMs,
        }
      : undefined)
  const roast =
    status.roast ??
    (coldLiveShell && live.roastMode !== undefined
      ? {
          active: live.roastActive ?? false,
          mode: live.roastMode,
          saturated: live.roastSaturated ?? false,
          holdover: live.roastHoldover ?? false,
        }
      : undefined)
  const calibrationIdentityChanged = live.calibrationId !== undefined && live.calibrationId !== calibration?.logId
  const manualLockout = live.manualLockout ?? status.manualLockout
  /*
   * Firmware 2026-07-26.107 and later publishes the executor's WHOLE per-tick zone tuple - index,
   * entry, nominal duration, endpoint, attainments - atomically from one controller snapshot, so the
   * tuple is internally coherent by construction and needs no confirming status poll. That matters
   * because there IS no status poll to wait for: full status is deferred for as long as anything
   * actuates, so waiting for one would leave every progress field frozen at its start value for the
   * entire roast the moment the device's zone advanced past the stale status document's. The freeze
   * below - never combine a newly streamed zone index with the previous zone's timestamps - remains
   * only for older firmware that streams a zone index without its entry.
   */
  const liveZoneTuple = live.roastZoneEntrySec !== undefined
  const roastZoneCoherent =
    !roast || liveZoneTuple || live.roastZone === undefined || live.roastZone === roast.zoneIndex
  const liveLifecycle = fault
    ? 'FAULT'
    : liveIndicatesActuation(live)
      ? 'RUNNING'
      : coldLiveShell
        ? 'STANDBY'
        : status.lifecycle
  return {
    ...status,
    connected: true,
    stale: false,
    firmwareVersion: live.firmwareVersion ?? status.firmwareVersion,
    roaster: live.roaster ?? status.roaster,
    capabilities: live.capabilities ?? status.capabilities,
    manualLockout,
    bootId: live.bootId ?? status.bootId,
    receivedAtMs: Math.max(status.receivedAtMs, live.receivedAtMs),
    // A fault seen on the fast poll must reach the banner within a second, not five.
    fault,
    // Full status is paused while the roaster actuates, so a status document read before Start still
    // says STANDBY; the stream's evidence of actuation is what makes every browser read RUNNING.
    lifecycle: manualLockout ? 'MANUAL_LOCKOUT' : liveLifecycle,
    temperatureC: live.temperatureC ?? status.temperatureC,
    // The firmware sends null for a faulted probe, so a live reading is itself the validity signal.
    thermocoupleValid: live.temperatureC !== undefined,
    ambientC: live.ambientC ?? status.ambientC,
    actuatorMode: live.actuatorMode ?? status.actuatorMode,
    effectiveFan: live.effectiveFan ?? status.effectiveFan,
    effectiveHeat: live.effectiveHeat ?? status.effectiveHeat,
    calibration: calibration
      ? {
          ...calibration,
          active: live.calibrationActive,
          stepIndex: live.calibrationStep ?? calibration.stepIndex,
          stepCount: live.calibrationCount ?? calibration.stepCount,
          logId: live.calibrationId ?? calibration.logId,
          currentFanLevel: live.calibrationFan ?? calibration.currentFanLevel,
          currentHeatLevel: live.calibrationHeat ?? calibration.currentHeatLevel,
          stepElapsedSec: live.calibrationElapsedSec ?? calibration.stepElapsedSec,
          settleState: live.calibrationSettleState ?? calibration.settleState,
          endReason: live.calibrationEndReason ?? calibration.endReason,
          // `cal_done` is a bounded latest-step journal. Empty intentionally clears a previous pass. A changed `cal_id`
          // fences an old pass even before the first completed event arrives. Absent fields preserve the
          // last full contract for older firmware that does not enrich compact live telemetry.
          completedSteps:
            live.calibrationCompletedSteps ?? (calibrationIdentityChanged ? [] : calibration.completedSteps),
        }
      : undefined,
    manual: manual
      ? {
          ...manual,
          active: live.manualActive,
          sinceMs: live.manualSinceMs ?? manual.sinceMs,
          fanLevel: live.requestedFan ?? manual.fanLevel,
          heatLevel: live.requestedHeat ?? manual.heatLevel,
        }
      : undefined,
    thermalLog: thermalLog
      ? {
          ...thermalLog,
          active: live.thermalLogActive ?? thermalLog.active,
          // An active recording is necessarily not yet durable. Do not retain a previous idle
          // status document's `unsaved: false`, or catalog writes will race the recording tail.
          unsaved: live.thermalLogActive === true ? true : thermalLog.unsaved,
          logId: live.thermalLogId ?? thermalLog.logId,
          source: live.thermalLogSource ?? thermalLog.source,
          samples: live.logSamples ?? thermalLog.samples,
        }
      : undefined,
    // The explicit live roast contract permits exact cold recovery during an active program. Older
    // firmware still merges only into an existing status-owned block and never gains model authority.
    roast: roast
      ? {
          ...roast,
          active: live.roastActive ?? roast.active,
          mode:
            live.roastMode ??
            (live.roastActive
              ? roast.mode === 'manual'
                ? 'manual'
                : live.roastJourney
                  ? 'journey'
                  : 'timed'
              : roast.mode),
          sessionId: live.roastSessionId ?? roast.sessionId,
          planRev: live.planRev ?? roast.planRev,
          saturated: live.roastSaturated ?? roast.saturated,
          holdover: live.roastHoldover ?? roast.holdover,
          name: live.roastName ?? roast.name,
          startedEpoch:
            live.roastStartedEpoch && live.roastStartedEpoch > 0 ? live.roastStartedEpoch : roast.startedEpoch,
          batchMassG: live.roastBatchMassG ?? roast.batchMassG,
          ambientC: live.roastAmbientC ?? roast.ambientC,
          commandedFan: live.requestedFan ?? roast.commandedFan,
          commandedHeat: live.requestedHeat ?? roast.commandedHeat,
          // Zone timing rides the live tuple on 2026-07-26.107+ firmware (see `liveZoneTuple` above). On older
          // firmware it remains status-owned: never combine a newly streamed zone index with the
          // previous zone's timestamps; wait one status poll for a coherent transition instead of
          // flashing a fictitious overrun. The elapsed time belongs to that same tuple: advancing the
          // old zone with the new zone's clock would still lengthen its overrun.
          elapsedSec: roastZoneCoherent ? (live.roastElapsedSec ?? roast.elapsedSec) : roast.elapsedSec,
          zoneIndex: roastZoneCoherent ? (live.roastZone ?? roast.zoneIndex) : roast.zoneIndex,
          zoneCount: live.roastZones ?? roast.zoneCount,
          targetC: roastZoneCoherent ? (live.roastTargetC ?? roast.targetC) : roast.targetC,
          ...(liveZoneTuple
            ? {
                zoneEntrySec: live.roastZoneEntrySec,
                zoneElapsedSec:
                  live.roastElapsedSec !== undefined
                    ? Math.max(0, live.roastElapsedSec - (live.roastZoneEntrySec ?? 0))
                    : roast.zoneElapsedSec,
                zoneNominalSec: live.roastZoneNominalSec,
                zoneEndC: live.roastZoneEndC,
                correctionTotal: live.roastCorrectionTotal,
                integral: live.roastIntegral,
                solvedFan: live.roastSolvedFan ?? roast.solvedFan,
                solvedHeat: live.roastSolvedHeat ?? roast.solvedHeat,
                holdoverMs: live.roastHoldoverMs ?? roast.holdoverMs,
                zoneAttainedSec: live.roastZonesAttained ?? roast.zoneAttainedSec,
                endReason: live.roastEndReason ?? roast.endReason,
              }
            : {}),
        }
      : undefined,
  }
}
