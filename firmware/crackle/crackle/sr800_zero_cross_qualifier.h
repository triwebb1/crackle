#pragma once

#include <stdint.h>

namespace sr800 {

enum class ZeroCrossObservation : uint8_t {
  BASELINE,
  QUALIFYING,
  ACCEPTED,
  IGNORED_GLITCH,
  REJECTED_IDLE,
  REJECTED_ACTIVE,
};

enum class ZeroCrossRejectReason : uint8_t {
  NONE,
  TOO_LONG,
};

class ZeroCrossQualifier {
 public:
  ZeroCrossQualifier(uint32_t minimumIntervalUs,
                     uint32_t maximumIntervalUs,
                     uint8_t requiredValidIntervals)
      : minimumIntervalUs_(minimumIntervalUs),
        maximumIntervalUs_(maximumIntervalUs),
        requiredValidIntervals_(requiredValidIntervals) {}

  ZeroCrossObservation observe(uint32_t intervalUs, bool intervalAvailable,
                               bool actuationActive) {
    if (!intervalAvailable) {
      consecutiveValidIntervals_ = 0;
      return ZeroCrossObservation::BASELINE;
    }

    // Comparator chatter arrives as bursts of edges microseconds apart. It
    // carries no information about the mains stream, so it must neither demote
    // a qualified stream nor reset qualification progress.
    if (intervalUs < minimumIntervalUs_) {
      ignoredGlitchCount_++;
      lastIgnoredGlitchIntervalUs_ = intervalUs;
      return ZeroCrossObservation::IGNORED_GLITCH;
    }

    lastIntervalUs_ = intervalUs;
    if (intervalUs > maximumIntervalUs_) {
      lastRejectedIntervalUs_ = intervalUs;
      lastRejectReason_ = ZeroCrossRejectReason::TOO_LONG;
      if (actuationActive && qualified_) {
        return ZeroCrossObservation::REJECTED_ACTIVE;
      }
      qualified_ = false;
      consecutiveValidIntervals_ = 0;
      idleRejectedCount_++;
      return ZeroCrossObservation::REJECTED_IDLE;
    }

    validIntervalCount_++;
    if (!qualified_) {
      if (consecutiveValidIntervals_ < UINT8_MAX) {
        consecutiveValidIntervals_++;
      }
      if (consecutiveValidIntervals_ < requiredValidIntervals_) {
        return ZeroCrossObservation::QUALIFYING;
      }
      qualified_ = true;
    }
    return ZeroCrossObservation::ACCEPTED;
  }

  void restartQualification() {
    qualified_ = false;
    consecutiveValidIntervals_ = 0;
  }

  bool qualified() const { return qualified_; }
  uint8_t consecutiveValidIntervals() const {
    return consecutiveValidIntervals_;
  }
  uint32_t validIntervalCount() const { return validIntervalCount_; }
  uint32_t idleRejectedCount() const { return idleRejectedCount_; }
  uint32_t ignoredGlitchCount() const { return ignoredGlitchCount_; }
  uint32_t lastIgnoredGlitchIntervalUs() const {
    return lastIgnoredGlitchIntervalUs_;
  }
  uint32_t lastIntervalUs() const { return lastIntervalUs_; }
  uint32_t lastRejectedIntervalUs() const {
    return lastRejectedIntervalUs_;
  }
  ZeroCrossRejectReason lastRejectReason() const {
    return lastRejectReason_;
  }

 private:
  const uint32_t minimumIntervalUs_;
  const uint32_t maximumIntervalUs_;
  const uint8_t requiredValidIntervals_;
  bool qualified_ = false;
  uint8_t consecutiveValidIntervals_ = 0;
  uint32_t validIntervalCount_ = 0;
  uint32_t idleRejectedCount_ = 0;
  uint32_t ignoredGlitchCount_ = 0;
  uint32_t lastIgnoredGlitchIntervalUs_ = 0;
  uint32_t lastIntervalUs_ = 0;
  uint32_t lastRejectedIntervalUs_ = 0;
  ZeroCrossRejectReason lastRejectReason_ = ZeroCrossRejectReason::NONE;
};

}  // namespace sr800
