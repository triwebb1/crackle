#pragma once

#include <math.h>
#include <stdint.h>

namespace sr800 {

enum class CalibrationReadinessReason : uint8_t {
  READY,
  SENSOR_INVALID,
};

class CalibrationReadiness {
 public:
  void observe(bool valid, float temperatureC, uint32_t) {
    if (!valid || !isfinite(temperatureC)) {
      valid_ = false;
      temperatureC_ = NAN;
      reason_ = CalibrationReadinessReason::SENSOR_INVALID;
      return;
    }
    valid_ = true;
    temperatureC_ = temperatureC;
    reason_ = CalibrationReadinessReason::READY;
  }

  bool ready(uint32_t) const { return valid_; }
  uint32_t stableForMs(uint32_t) const { return 0; }
  float candidateC() const { return temperatureC_; }
  CalibrationReadinessReason reason() const { return reason_; }

  static const char* reasonName(CalibrationReadinessReason reason) {
    switch (reason) {
      case CalibrationReadinessReason::READY: return "ready";
      case CalibrationReadinessReason::SENSOR_INVALID: return "sensor_invalid";
      default: return "sensor_invalid";
    }
  }

 private:
  bool valid_ = false;
  float temperatureC_ = NAN;
  CalibrationReadinessReason reason_ =
      CalibrationReadinessReason::SENSOR_INVALID;
};

}  // namespace sr800