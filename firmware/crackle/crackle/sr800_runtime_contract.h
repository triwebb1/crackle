#pragma once

#include <stddef.h>
#include <stdint.h>

// Small, host-testable pieces of Crackle's runtime wire contract.  Nothing in
// this file depends on Arduino so the edge cases which matter on the device can
// be pinned without flashing hardware.
namespace sr800 {
namespace runtime {

constexpr uint64_t kFirstRevision = 1;
constexpr double kThermocoupleOffsetMinimumC = -25.0;
constexpr double kThermocoupleOffsetMaximumC = 25.0;
constexpr uint32_t kRestoreLeaseMs = 120000;

// Zero is reserved for "not supplied".  Wrapping therefore starts a new
// non-zero epoch rather than publishing an ambiguous revision.
constexpr uint64_t nextRevision(uint64_t current) {
  return current == UINT64_MAX ? kFirstRevision : current + 1;
}

constexpr uint32_t nextSequence(uint32_t current) {
  return current == UINT32_MAX ? 1U : current + 1U;
}

inline bool decimalUint64(const char* text, size_t length, uint64_t& out) {
  if (text == nullptr || length == 0) return false;
  uint64_t value = 0;
  for (size_t i = 0; i < length; ++i) {
    const char c = text[i];
    if (c < '0' || c > '9') return false;
    const uint8_t digit = static_cast<uint8_t>(c - '0');
    if (value > (UINT64_MAX - digit) / 10U) return false;
    value = value * 10U + digit;
  }
  out = value;
  return true;
}

inline bool thermocoupleOffsetAllowed(double offsetC) {
  // This spelling also rejects NaN without needing <math.h>.
  return offsetC >= kThermocoupleOffsetMinimumC &&
         offsetC <= kThermocoupleOffsetMaximumC;
}

struct RestoreLease {
  uint32_t token = 0;
  uint32_t expiresAtMs = 0;
  bool active = false;
  bool incomplete = false;
  // Once any restore mutation lands, abort may not pretend the pre-restore
  // library still exists. Only a successful commit can clear maintenance.
  bool dirty = false;
};

inline bool deadlinePending(uint32_t nowMs, uint32_t deadlineMs) {
  return static_cast<int32_t>(deadlineMs - nowMs) > 0;
}

// Wrap-safe age checks shared by device-owned instruction leases.
inline bool instructionExpired(uint32_t nowMs, uint32_t lastInstructionMs,
                               uint32_t limitMs) {
  return static_cast<uint32_t>(nowMs - lastInstructionMs) >= limitMs;
}

// Effective Heat can fall to zero because the thermal gate deliberately
// suppressed it. That is not evidence that the ISR lease expired: only a
// healthy thermal input makes the fault-free zero-output transition
// unambiguous.
inline bool heatLeaseExpired(bool thermalHealthy, bool zeroCrossAvailable,
                             bool commandRequestsHeat, bool heatObserved,
                             bool actuatorRequestsHeat, bool heatEffective) {
  // A zero-cross coast or requalification deliberately parks effective Heat
  // while retaining the actuator request. A true ISR lease expiry is the
  // narrower state: timing and telemetry are healthy, the operator still wants
  // Heat, but stopOutputs() cleared the actuator request and effective output.
  return thermalHealthy && zeroCrossAvailable && commandRequestsHeat &&
      heatObserved && !actuatorRequestsHeat && !heatEffective;
}

// Qualifies a continuously true condition without a zero-time sentinel.
struct SustainedCondition {
  uint32_t sinceMs = 0;
  bool active = false;

  bool observe(bool condition, uint32_t nowMs, uint32_t holdMs) {
    if (!condition) {
      active = false;
      sinceMs = 0;
      return false;
    }
    if (!active) {
      active = true;
      sinceMs = nowMs;
    }
    return static_cast<uint32_t>(nowMs - sinceMs) >= holdMs;
  }
};

// Journey-specific continuity timers. Sensor holdover owns the dropout budget,
// while Fan-qualification timing is meaningful only with a healthy thermal
// input and a usable reading. Explicit active flags avoid treating a real
// timestamp of zero as an unarmed sentinel.
struct JourneyHeatContinuity {
  uint32_t holdoverSinceMs = 0;
  uint32_t qualificationSinceMs = 0;
  bool holdoverActive = false;
  bool qualificationActive = false;

  bool sensorLost(bool holdover, uint32_t nowMs, uint32_t limitMs) {
    if (!holdover) {
      holdoverActive = false;
      holdoverSinceMs = 0;
      return false;
    }
    if (!holdoverActive) {
      holdoverActive = true;
      holdoverSinceMs = nowMs;
    }
    return static_cast<uint32_t>(nowMs - holdoverSinceMs) >= limitMs;
  }

  bool qualificationStalled(bool thermalHealthy, bool holdover,
                            bool heatRequested, bool heatEffective,
                            uint32_t nowMs, uint32_t limitMs) {
    const bool eligible = thermalHealthy && !holdover && heatRequested &&
                          !heatEffective;
    if (!eligible) {
      qualificationActive = false;
      qualificationSinceMs = 0;
      return false;
    }
    if (!qualificationActive) {
      qualificationActive = true;
      qualificationSinceMs = nowMs;
    }
    return static_cast<uint32_t>(nowMs - qualificationSinceMs) > limitMs;
  }

  void reset() {
    holdoverSinceMs = 0;
    qualificationSinceMs = 0;
    holdoverActive = false;
    qualificationActive = false;
  }
};

inline bool restoreLeaseValid(const RestoreLease& lease, uint32_t nowMs,
                              uint32_t token) {
  return lease.active && token != 0 && token == lease.token &&
         deadlinePending(nowMs, lease.expiresAtMs);
}

inline bool restoreAbortAllowed(const RestoreLease& lease) {
  return lease.incomplete && !lease.dirty;
}

enum class JourneyPatchVerdict : uint8_t {
  ACCEPT = 0,
  ACCEPT_AND_ADVANCE,
  STALE_SESSION,
  STALE_PLAN,
  BAD_ZONE,
  DIRECTION_CHANGE,
  TOO_SHORT,
  IMMEDIATE_TRANSITION_REQUIRES_CONFIRMATION
};

struct JourneyPatchInput {
  uint32_t expectedSession = 0;
  uint32_t activeSession = 0;
  uint32_t expectedPlanRevision = 0;
  uint32_t activePlanRevision = 0;
  double immutableStartC = 0.0;
  double previousEndC = 0.0;
  double proposedEndC = 0.0;
  double elapsedInZoneSec = 0.0;
  double proposedDurationSec = 0.0;
  double temperatureC = 0.0;
  bool allowImmediateTransition = false;
};

inline JourneyPatchVerdict validateJourneyPatch(const JourneyPatchInput& patch) {
  if (patch.expectedSession == 0 ||
      patch.expectedSession != patch.activeSession) {
    return JourneyPatchVerdict::STALE_SESSION;
  }
  if (patch.expectedPlanRevision == 0 ||
      patch.expectedPlanRevision != patch.activePlanRevision) {
    return JourneyPatchVerdict::STALE_PLAN;
  }
  if (!(patch.proposedDurationSec >= 5.0) ||
      !(patch.elapsedInZoneSec >= 0.0)) {
    return JourneyPatchVerdict::BAD_ZONE;
  }

  const double oldDelta = patch.previousEndC - patch.immutableStartC;
  const double newDelta = patch.proposedEndC - patch.immutableStartC;
  const bool oldHold = oldDelta >= -0.5 && oldDelta <= 0.5;
  const bool newHold = newDelta >= -0.5 && newDelta <= 0.5;
  if (oldHold != newHold ||
      (!oldHold && ((oldDelta > 0.0) != (newDelta > 0.0)))) {
    return JourneyPatchVerdict::DIRECTION_CHANGE;
  }
  if (patch.proposedDurationSec < patch.elapsedInZoneSec + 5.0) {
    return JourneyPatchVerdict::TOO_SHORT;
  }

  const bool crossed = !newHold &&
      (newDelta > 0.0 ? patch.temperatureC >= patch.proposedEndC
                      : patch.temperatureC <= patch.proposedEndC);
  if (crossed && !patch.allowImmediateTransition) {
    return JourneyPatchVerdict::IMMEDIATE_TRANSITION_REQUIRES_CONFIRMATION;
  }
  return crossed ? JourneyPatchVerdict::ACCEPT_AND_ADVANCE
                 : JourneyPatchVerdict::ACCEPT;
}

}  // namespace runtime
}  // namespace sr800
