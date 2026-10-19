#pragma once

#include <stdint.h>

namespace sr800 {

// Three consecutive 250 ms failures are required before a thermocouple fault
// becomes authoritative. The elapsed gate prevents a fast-loop burst from
// satisfying the count early. Once qualified, the decision and its evidence
// stay latched until restart even if later samples recover.
class SensorFaultQualifier {
 public:
  static constexpr uint8_t kRequiredInvalidSamples = 3;
  static constexpr uint32_t kQualificationMs = 750;

  bool observe(bool valid, uint8_t faultByte, uint32_t nowMs) {
    if (valid) {
      if (consecutiveInvalid_ > 0) recoveries_++;
      consecutiveInvalid_ = 0;
      invalidSinceMs_ = 0;
      currentFaultByte_ = 0;
      lastValidMs_ = nowMs;
      hasLastValid_ = true;
      return qualified_;
    }

    if (consecutiveInvalid_ == 0) {
      invalidSinceMs_ = hasLastValid_ ? lastValidMs_ : nowMs;
    }
    if (consecutiveInvalid_ < UINT8_MAX) consecutiveInvalid_++;
    currentFaultByte_ = faultByte;
    const uint32_t durationMs = nowMs - invalidSinceMs_;
    if (!qualified_ && consecutiveInvalid_ >= kRequiredInvalidSamples &&
        durationMs >= kQualificationMs) {
      qualified_ = true;
      tripFaultByte_ = faultByte;
      tripInvalidCount_ = consecutiveInvalid_;
      tripInvalidDurationMs_ = durationMs;
      tripAtMs_ = nowMs;
    }
    return qualified_;
  }

  bool qualified() const { return qualified_; }
  uint8_t currentFaultByte() const { return currentFaultByte_; }
  uint8_t consecutiveInvalid() const { return consecutiveInvalid_; }
  uint32_t invalidDurationMs(uint32_t nowMs) const {
    return consecutiveInvalid_ == 0 ? 0 : nowMs - invalidSinceMs_;
  }
  uint32_t recoveries() const { return recoveries_; }
  uint8_t tripFaultByte() const { return tripFaultByte_; }
  uint8_t tripInvalidCount() const { return tripInvalidCount_; }
  uint32_t tripInvalidDurationMs() const { return tripInvalidDurationMs_; }
  uint32_t tripAtMs() const { return tripAtMs_; }

 private:
  bool qualified_ = false;
  uint8_t currentFaultByte_ = 0;
  uint8_t consecutiveInvalid_ = 0;
  uint32_t invalidSinceMs_ = 0;
  uint32_t lastValidMs_ = 0;
  bool hasLastValid_ = false;
  uint32_t recoveries_ = 0;
  uint8_t tripFaultByte_ = 0;
  uint8_t tripInvalidCount_ = 0;
  uint32_t tripInvalidDurationMs_ = 0;
  uint32_t tripAtMs_ = 0;
};

}  // namespace sr800