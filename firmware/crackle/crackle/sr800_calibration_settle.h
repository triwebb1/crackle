#pragma once

#include <math.h>
#include <stdint.h>

namespace sr800 {

// A calibration step must first prove that its new command moved the measured
// temperature. Otherwise the thermal dead time immediately after a command
// looks flat and can be mistaken for a settled plateau at the minimum dwell.
class CalibrationSettleDetector {
 public:
  static constexpr uint8_t kMaximumSamples = 30;

  void reset(uint8_t requiredSamples, float bandC) {
    requiredSamples_ =
        requiredSamples > kMaximumSamples ? kMaximumSamples : requiredSamples;
    bandC_ = bandC;
    count_ = 0;
    next_ = 0;
    originC_ = NAN;
    transitionObserved_ = false;
  }

  void observe(float temperatureC) {
    if (isnan(temperatureC) || requiredSamples_ == 0) return;

    if (isnan(originC_)) {
      originC_ = temperatureC;
    } else if (!transitionObserved_ &&
               fabsf(temperatureC - originC_) > bandC_) {
      // Start a fresh stability window when the command's response becomes
      // distinguishable from the authored settle tolerance.
      transitionObserved_ = true;
      count_ = 0;
      next_ = 0;
    }

    samples_[next_] = temperatureC;
    next_ = static_cast<uint8_t>((next_ + 1) % requiredSamples_);
    if (count_ < requiredSamples_) count_++;
  }

  bool settled() const {
    if (!transitionObserved_ || count_ < requiredSamples_) return false;
    float low = samples_[0];
    float high = samples_[0];
    for (uint8_t index = 1; index < requiredSamples_; ++index) {
      if (samples_[index] < low) low = samples_[index];
      if (samples_[index] > high) high = samples_[index];
    }
    return high - low <= 2.0f * bandC_;
  }

  bool transitionObserved() const { return transitionObserved_; }

 private:
  float samples_[kMaximumSamples] = {};
  uint8_t requiredSamples_ = 0;
  uint8_t count_ = 0;
  uint8_t next_ = 0;
  float bandC_ = 0.0f;
  float originC_ = NAN;
  bool transitionObserved_ = false;
};

}  // namespace sr800