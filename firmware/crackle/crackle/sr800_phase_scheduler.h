#pragma once

#include <Arduino.h>
#include "driver/gpio.h"
#include "sr800_actuator.h"

namespace sr800 {

enum PhaseTimingFlags : uint8_t {
  PHASE_TIMING_EMITTED = 1U << 0,
  PHASE_TIMING_LATE = 1U << 1,
  PHASE_TIMING_EARLY = 1U << 2,
  PHASE_TIMING_STALE = 1U << 3,
};

struct PhaseTimingRecord {
  uint16_t zeroCrossIndex;
  uint16_t plannedDelayUs;
  uint16_t actualDelayUs;
  uint16_t actualPulseWidthUs;
  uint8_t channelMask;
  uint8_t flags;
};

struct PhaseSchedulerSnapshot {
  bool initialized;
  bool active;
  bool faulted;
  uint32_t plansScheduled;
  uint32_t plansCanceled;
  uint32_t fanPulsesEmitted;
  uint32_t heaterPulsesEmitted;
  uint32_t setupFailures;
  uint32_t invalidPlanRejects;
  uint32_t missedPulseCount;
  uint32_t invalidZeroCrossCount;
  uint32_t coastedZeroCrossCount;
  uint32_t ignoredZeroCrossGlitchCount;
  bool zeroCrossQualified;
  uint8_t zeroCrossConsecutiveValidIntervals;
  uint32_t zeroCrossValidIntervalCount;
  uint32_t zeroCrossIdleRejectedCount;
  uint32_t zeroCrossLastIntervalUs;
  uint32_t zeroCrossLastRejectedIntervalUs;
  uint16_t zeroCrossLastRejectedPhysicalEdgeDelta;
  uint8_t zeroCrossLastRejectReason;
  uint32_t zeroCrossLastIgnoredGlitchIntervalUs;
  uint16_t zeroCrossLastIgnoredGlitchPhysicalEdgeDelta;
  bool timingLogEnabled;
  uint32_t timingLogRecords;
  uint32_t timingLogDropped;
  uint32_t timingLogCapacity;
  uint32_t timingLogEmitted;
  uint32_t timingLogMissed;
  uint32_t timingLogLate;
  uint32_t timingLogMaximumLatenessUs;
  uint32_t auditCaptureRises;
  uint32_t auditCaptureFalls;
  uint32_t auditPairErrors;
  uint32_t auditIndexErrors;
  uint32_t auditExpectedPulses;
  uint32_t auditWindowInvalid;
  uint32_t auditWindowCoasted;
  uint32_t auditWindowIgnored;
  uint32_t fanAuditRecords;
  uint32_t fanAuditExpectedPulses;
  uint32_t fanAuditCaptureRises;
  uint32_t fanAuditCaptureFalls;
  uint32_t fanAuditPairErrors;
  uint32_t fanAuditIndexErrors;
  bool fanAuditValid;
  uint32_t heaterAuditRecords;
  uint32_t heaterAuditExpectedPulses;
  uint32_t heaterAuditCaptureRises;
  uint32_t heaterAuditCaptureFalls;
  uint32_t heaterAuditPairErrors;
  uint32_t heaterAuditIndexErrors;
  bool heaterAuditValid;
  bool auditValid;
};

}  // namespace sr800