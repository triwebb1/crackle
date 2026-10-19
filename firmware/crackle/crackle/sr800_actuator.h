#pragma once

#include <Arduino.h>
#include "driver/gpio.h"

namespace sr800 {

enum class ActuatorMode : uint8_t {
  IDLE,
  FAN_STARTUP,
  FAN_ONLY,
  HEATING,
  ZERO_CROSS_WAIT,
  FAULT,
};

enum class ActuatorFault : uint8_t {
  NONE,
  MANUAL_CONFLICT,
  ZERO_CROSS_LOST,
  PULSE_SCHEDULER_FAILURE,
  THERMAL_SENSOR,
  OVERTEMPERATURE,
  THERMAL_STALE,
};

enum class ThermalSafetyStatus : uint8_t {
  UNKNOWN,
  HEALTHY,
  SENSOR_FAULT,
  OVERTEMPERATURE,
};

struct PhasePulsePlan {
  uint32_t fanDelayUs;
  uint32_t heaterDelayUs;
  uint32_t pulseWidthUs;
  bool fanEnabled;
  bool heaterEnabled;
};

using SchedulePulsePlan =
    bool (*)(void* context, const PhasePulsePlan& plan);
using CancelPulsePlan = void (*)(void* context);

struct ActuatorConfig {
  gpio_num_t fanPin;
  gpio_num_t heaterPin;
  uint32_t pulseWidthUs;
  uint32_t fanMinimumLevelMilli;
  uint32_t fanMaximumLevelMilli;
  uint32_t fanMinimumDelayUs;
  uint32_t fanMaximumDelayUs;
  uint32_t fanMinimumSoftStartUs;
  uint32_t fanMaximumSoftStartUs;
  uint32_t heaterMinimumDelayUs;
  uint32_t heaterMaximumDelayUs;
  uint32_t fanStartupUs;
  uint32_t fanQualificationUs;
  uint32_t zeroCrossTimeoutUs;
  uint32_t zeroCrossRecoveryGraceUs;
  uint32_t nominalHalfCycleUs;
  uint32_t maximumHeatRunUs;
  uint32_t thermalSafetyFreshnessUs;
  // After an overtemperature trip the core runs the fan at this level, with Heat locked off, until
  // the reading has stayed below the limit for overtempCooldownUs. Only an operator Stop, a
  // manual-control conflict, or a scheduler failure ends it sooner.
  uint32_t overtempCooldownFanMilli;
  uint32_t overtempCooldownUs;
};

struct ActuatorSnapshot {
  ActuatorMode mode;
  ActuatorFault fault;
  uint32_t requestedFanMilli;
  uint32_t requestedHeatMilli;
  uint32_t effectiveFanMilli;
  uint32_t effectiveHeatMilli;
  uint32_t fanSettledDelayUs;
  uint32_t fanStartDelayUs;
  uint32_t heaterDelayUs;
  uint32_t pulseWidthUs;
  uint32_t fanPulseCount;
  uint32_t heaterPulseCount;
  uint32_t fanContinuousUs;
  uint32_t lastZeroCrossAgeUs;
  uint32_t zeroCrossUnavailableMs;
  uint32_t heatDeadlineRemainingMs;
  uint32_t overtempCooldownRemainingMs;
  ThermalSafetyStatus thermalSafetyStatus;
  bool zeroCrossAvailable;
  bool fanQualifiedForHeat;
};

class Actuator {
 public:
  explicit Actuator(const ActuatorConfig& config);

  void begin();
  void setPulseScheduler(SchedulePulsePlan schedule,
                         CancelPulsePlan cancel,
                         void* context);

  // The sole ordinary actuation entry point. Callers request values; the core
  // owns clamping, sequencing, and fault behavior.
  bool request(uint32_t fanMilli, uint32_t heatMilli, uint32_t nowUs,
               const char*& rejection, uint32_t heatRunLimitUs = 0);
  void stop(uint32_t nowUs);
  void service(uint32_t nowUs);
  void updateThermalSafety(ThermalSafetyStatus status, uint32_t nowUs);
  // Clears only the recoverable controller-telemetry lapse. The caller must
  // first abort its active operation; the core additionally requires fresh
  // HEALTHY telemetry, so this can never restart old Heat.
  bool clearThermalStaleFault(uint32_t nowUs);
  // The operator's Stop: ends an overtemperature cooldown, so Stop always means all outputs off.
  // Ordinary stop() calls leave the cooldown running.
  void cancelOvertempCooldown(uint32_t nowUs);

  void IRAM_ATTR onZeroCross(uint32_t nowUs);
  void IRAM_ATTR onZeroCrossDiscontinuity(uint32_t nowUs);
  void IRAM_ATTR latchManualConflict();
  void IRAM_ATTR latchPulseSchedulerFailure();

  ActuatorSnapshot snapshot(uint32_t nowUs) const;
  bool outputsActive() const;

  static const char* modeName(ActuatorMode mode);
  static const char* faultName(ActuatorFault fault);
  static const char* thermalSafetyName(ThermalSafetyStatus status);

 private:
  struct FanTiming {
    uint32_t settledDelayUs;
    uint32_t startDelayUs;
  };

  static constexpr double kPi = 3.14159265358979323846;

  uint32_t IRAM_ATTR normalizeLevel(uint32_t levelMilli) const;
  uint32_t minimumFanForHeat(uint32_t heatMilli) const;
  FanTiming calculateFanTiming(uint32_t levelMilli) const;
  uint32_t calculateHeaterDelay(uint32_t levelMilli) const;
  double phasePowerForDelay(uint32_t delayUs) const;
  uint32_t delayForPhasePower(double targetPower,
                              uint32_t earlierUs,
                              uint32_t laterUs) const;
  void applyEffectiveState(uint32_t nowUs);
  void IRAM_ATTR stopOutputs(uint32_t nowUs, ActuatorFault fault);
  void IRAM_ATTR beginOvertempCooldown(uint32_t nowUs);
  void IRAM_ATTR markZeroCrossUnavailable(uint32_t nowUs);
  void IRAM_ATTR forceOutputsLow();
  void IRAM_ATTR cancelScheduledPulses();

  const ActuatorConfig config_;
  mutable portMUX_TYPE mux_ = portMUX_INITIALIZER_UNLOCKED;
  SchedulePulsePlan schedulePulsePlan_ = nullptr;
  CancelPulsePlan cancelPulsePlan_ = nullptr;
  void* pulseSchedulerContext_ = nullptr;

  volatile ActuatorMode mode_ = ActuatorMode::IDLE;
  volatile ActuatorFault fault_ = ActuatorFault::NONE;
  volatile uint32_t requestedFanMilli_ = 0;
  volatile uint32_t requestedHeatMilli_ = 0;
  volatile uint32_t effectiveFanMilli_ = 0;
  volatile uint32_t effectiveHeatMilli_ = 0;
  volatile uint32_t fanSettledDelayUs_ = 0;
  volatile uint32_t fanStartDelayUs_ = 0;
  volatile uint32_t heaterDelayUs_ = 0;
  volatile uint32_t fanStartedUs_ = 0;
  volatile bool heatQualificationActive_ = false;
  volatile uint32_t heatQualificationStartedUs_ = 0;
  volatile uint32_t lastZeroCrossUs_ = 0;
  volatile uint32_t zeroCrossUnavailableSinceUs_ = 0;
  volatile bool zeroCrossAvailable_ = false;
  volatile uint32_t fanPulseCount_ = 0;
  volatile uint32_t heaterPulseCount_ = 0;
  volatile uint32_t pendingHeatRunLimitUs_ = 0;
  volatile uint32_t heatDeadlineUs_ = 0;
  volatile bool heatDeadlineArmed_ = false;
  volatile ThermalSafetyStatus thermalSafetyStatus_ =
      ThermalSafetyStatus::UNKNOWN;
  volatile uint32_t thermalSafetyUpdatedUs_ = 0;
  volatile bool overtempCooldownActive_ = false;
  volatile uint32_t overtempCooldownDeadlineUs_ = 0;
  volatile uint32_t lastServiceUs_ = 0;
};

}  // namespace sr800