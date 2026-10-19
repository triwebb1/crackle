#include "../crackle/sr800_runtime_contract.h"
#include "../crackle/sr800_recording_handoff.h"

#include <assert.h>
#include <stdint.h>

using sr800::runtime::JourneyPatchInput;
using sr800::runtime::JourneyPatchVerdict;

int main() {
  using namespace sr800::recording;
  assert(!canClaimPersistence(true, true, false));
  assert(canClaimPersistence(false, true, false));
  assert(!canClaimPersistence(false, true, true));
  assert(!canClaimPersistence(false, false, false));
  assert(!canReadFrozenBuffer(true, false));
  assert(!canReadFrozenBuffer(false, true));
  assert(canReadFrozenBuffer(false, false));
  assert(persistenceBlocksNewEpisode(true, false));
  assert(persistenceBlocksNewEpisode(false, true));
  assert(!persistenceBlocksNewEpisode(false, false));
  assert(discardSubminimumAtHandoff(true, false, false));
  assert(!discardSubminimumAtHandoff(true, true, false));
  assert(!discardSubminimumAtHandoff(true, false, true));
  assert(!discardSubminimumAtHandoff(false, false, false));

  using namespace sr800::runtime;

  assert(nextRevision(0) == 1);
  assert(nextRevision(UINT64_MAX - 1) == UINT64_MAX);
  assert(nextRevision(UINT64_MAX) == 1);
  assert(nextSequence(UINT32_MAX) == 1);

  uint64_t value = 0;
  assert(decimalUint64("18446744073709551615", 20, value));
  assert(value == UINT64_MAX);
  assert(!decimalUint64("18446744073709551616", 20, value));
  assert(!decimalUint64("-1", 2, value));
  assert(thermocoupleOffsetAllowed(-25));
  assert(thermocoupleOffsetAllowed(25));
  assert(!thermocoupleOffsetAllowed(26));

  assert(!instructionExpired(1799999, 0, 1800000));
  assert(instructionExpired(1800000, 0, 1800000));
  assert(instructionExpired(4, UINT32_MAX - 1799995, 1800000));

  // A thermal-gate dropout is not a lost ISR lease. Journey holdover owns the
  // first 30 seconds, suppresses qualification timing, and a healthy recovery
  // resumes without inheriting either timer.
  assert(heatLeaseExpired(true, true, true, true, false, false));
  assert(!heatLeaseExpired(false, true, true, true, false, false));
  // Zero-cross coast and requalification retain the actuator request and are
  // not evidence of an expired ISR lease.
  assert(!heatLeaseExpired(true, false, true, true, true, false));
  assert(!heatLeaseExpired(true, true, true, true, true, false));
  JourneyHeatContinuity continuity{};
  constexpr uint32_t dropoutStartMs = 1000;
  assert(!continuity.sensorLost(true, dropoutStartMs, 30000));
  assert(!continuity.qualificationStalled(
      false, true, true, false, dropoutStartMs, 10000));
  assert(!continuity.sensorLost(true, dropoutStartMs + 29999, 30000));
  assert(!continuity.qualificationStalled(
      false, true, true, false, dropoutStartMs + 29999, 10000));

  // The probe returns before the budget expires: Heat is effective again and
  // neither a lease nor a stale qualification timer ends the journey.
  assert(!continuity.sensorLost(false, dropoutStartMs + 29999, 30000));
  assert(!heatLeaseExpired(true, true, true, true, true, true));
  assert(!continuity.qualificationStalled(
      true, false, true, true, dropoutStartMs + 29999, 10000));

  // If Fan qualification had already started, entering holdover clears that
  // partial timer. Recovery with Heat still pending receives a fresh interval.
  constexpr uint32_t qualificationStartMs = 50000;
  assert(!continuity.qualificationStalled(
      true, false, true, false, qualificationStartMs, 10000));
  assert(!continuity.qualificationStalled(
      true, false, true, false, qualificationStartMs + 9000, 10000));
  assert(!continuity.qualificationStalled(
      false, true, true, false, qualificationStartMs + 9500, 10000));
  constexpr uint32_t qualificationRecoveryMs = 70000;
  assert(!continuity.qualificationStalled(
      true, false, true, false, qualificationRecoveryMs, 10000));
  assert(!continuity.qualificationStalled(
      true, false, true, false, qualificationRecoveryMs + 10000, 10000));
  assert(continuity.qualificationStalled(
      true, false, true, false, qualificationRecoveryMs + 10001, 10000));

  // A later continuous dropout receives a fresh full budget and ends only at
  // the sensor-loss boundary.
  constexpr uint32_t sustainedDropoutMs = 100000;
  assert(!continuity.sensorLost(true, sustainedDropoutMs, 30000));
  assert(!continuity.qualificationStalled(
      false, true, true, false, sustainedDropoutMs + 15000, 10000));
  assert(continuity.sensorLost(true, sustainedDropoutMs + 30000, 30000));

  SustainedCondition overtemperature{};
  assert(!overtemperature.observe(true, 100, 3000));
  assert(!overtemperature.observe(true, 3099, 3000));
  assert(overtemperature.observe(true, 3100, 3000));
  assert(!overtemperature.observe(false, 3200, 3000));
  assert(!overtemperature.observe(true, 4000, 3000));

  RestoreLease lease{41, 1000, true, false};
  assert(restoreLeaseValid(lease, 999, 41));
  assert(!restoreLeaseValid(lease, 1000, 41));
  assert(!restoreLeaseValid(lease, 999, 42));
  lease.incomplete = true;
  assert(restoreAbortAllowed(lease));
  lease.dirty = true;
  assert(!restoreAbortAllowed(lease));

  JourneyPatchInput patch{};
  patch.expectedSession = patch.activeSession = 7;
  patch.expectedPlanRevision = patch.activePlanRevision = 2;
  patch.immutableStartC = 180;
  patch.previousEndC = 205;
  patch.proposedEndC = 210;
  patch.elapsedInZoneSec = 20;
  patch.proposedDurationSec = 30;
  patch.temperatureC = 200;
  assert(validateJourneyPatch(patch) == JourneyPatchVerdict::ACCEPT);

  patch.proposedDurationSec = 24;
  assert(validateJourneyPatch(patch) == JourneyPatchVerdict::TOO_SHORT);
  patch.proposedDurationSec = 30;
  patch.proposedEndC = 170;
  assert(validateJourneyPatch(patch) == JourneyPatchVerdict::DIRECTION_CHANGE);
  patch.proposedEndC = 195;
  assert(validateJourneyPatch(patch) ==
         JourneyPatchVerdict::IMMEDIATE_TRANSITION_REQUIRES_CONFIRMATION);
  patch.allowImmediateTransition = true;
  assert(validateJourneyPatch(patch) ==
         JourneyPatchVerdict::ACCEPT_AND_ADVANCE);
  patch.expectedPlanRevision = 1;
  assert(validateJourneyPatch(patch) == JourneyPatchVerdict::STALE_PLAN);
}
