#include "sr800_actuator.h"

#include <math.h>

namespace sr800 {
namespace {
constexpr uint32_t kMaximumFutureTimestampSkewUs = 100000U;
uint32_t IRAM_ATTR elapsedUsOrZero(uint32_t nowUs, uint32_t thenUs) {
  const uint32_t elapsedUs = nowUs - thenUs;
  // An ISR can publish `thenUs` just after a loop caller captured `nowUs`.
  // Clamp only that narrowly bounded race. A signed half-range comparison
  // would incorrectly turn every real 35.8-71.6 minute outage into zero.
  return elapsedUs > UINT32_MAX - kMaximumFutureTimestampSkewUs ? 0
                                                                : elapsedUs;
}
bool IRAM_ATTR deadlineReached(bool armed, uint32_t nowUs,
                               uint32_t deadlineUs) {
  return armed && static_cast<int32_t>(nowUs - deadlineUs) >= 0;
}
}  // namespace

Actuator::Actuator(const ActuatorConfig& config) : config_(config) {}

void Actuator::begin() {
  pinMode(static_cast<uint8_t>(config_.fanPin), OUTPUT);
  pinMode(static_cast<uint8_t>(config_.heaterPin), OUTPUT);
  gpio_set_level(config_.fanPin, 0);
  gpio_set_level(config_.heaterPin, 0);
}

void Actuator::setPulseScheduler(SchedulePulsePlan schedule,
                                 CancelPulsePlan cancel,
                                 void* context) {
  portENTER_CRITICAL(&mux_);
  schedulePulsePlan_ = schedule;
  cancelPulsePlan_ = cancel;
  pulseSchedulerContext_ = context;
  portEXIT_CRITICAL(&mux_);
}

uint32_t IRAM_ATTR Actuator::normalizeLevel(uint32_t levelMilli) const {
  if (levelMilli == 0) return 0;
  if (levelMilli < config_.fanMinimumLevelMilli) {
    return config_.fanMinimumLevelMilli;
  }
  if (levelMilli > config_.fanMaximumLevelMilli) {
    return config_.fanMaximumLevelMilli;
  }
  return levelMilli;
}

uint32_t Actuator::minimumFanForHeat(uint32_t heatMilli) const {
  return heatMilli == 0 ? 0 : config_.fanMinimumLevelMilli;
}

double Actuator::phasePowerForDelay(uint32_t delayUs) const {
  const double alpha =
      (static_cast<double>(delayUs) / config_.nominalHalfCycleUs) * kPi;
  return 1.0 - alpha / kPi + sin(2.0 * alpha) / (2.0 * kPi);
}

uint32_t Actuator::delayForPhasePower(double targetPower,
                                      uint32_t earlierUs,
                                      uint32_t laterUs) const {
  for (uint8_t iteration = 0; iteration < 16; ++iteration) {
    const uint32_t middleUs = (earlierUs + laterUs) / 2U;
    if (phasePowerForDelay(middleUs) > targetPower) earlierUs = middleUs;
    else laterUs = middleUs;
  }
  return (earlierUs + laterUs) / 2U;
}

Actuator::FanTiming Actuator::calculateFanTiming(uint32_t levelMilli) const {
  if (levelMilli <= config_.fanMinimumLevelMilli) {
    return {config_.fanMinimumDelayUs,
            config_.fanMinimumDelayUs + config_.fanMinimumSoftStartUs};
  }
  if (levelMilli >= config_.fanMaximumLevelMilli) {
    return {config_.fanMaximumDelayUs,
            config_.fanMaximumDelayUs + config_.fanMaximumSoftStartUs};
  }
  const double position =
      static_cast<double>(levelMilli - config_.fanMinimumLevelMilli) /
      (config_.fanMaximumLevelMilli - config_.fanMinimumLevelMilli);
  const double minimumPower = phasePowerForDelay(config_.fanMinimumDelayUs);
  const double maximumPower = phasePowerForDelay(config_.fanMaximumDelayUs);
  const double targetPower =
      minimumPower + position * (maximumPower - minimumPower);
  const uint32_t settledDelayUs = delayForPhasePower(
      targetPower, config_.fanMaximumDelayUs, config_.fanMinimumDelayUs);
  const uint32_t softStartRangeUs =
      config_.fanMaximumSoftStartUs - config_.fanMinimumSoftStartUs;
  const uint32_t softStartUs = config_.fanMinimumSoftStartUs +
      static_cast<uint32_t>(lround(position * softStartRangeUs));
  return {settledDelayUs, settledDelayUs + softStartUs};
}

uint32_t Actuator::calculateHeaterDelay(uint32_t levelMilli) const {
  if (levelMilli <= config_.fanMinimumLevelMilli) {
    return config_.heaterMinimumDelayUs;
  }
  if (levelMilli >= config_.fanMaximumLevelMilli) {
    return config_.heaterMaximumDelayUs;
  }
  const double position =
      static_cast<double>(levelMilli - config_.fanMinimumLevelMilli) /
      (config_.fanMaximumLevelMilli - config_.fanMinimumLevelMilli);
  const double minimumPower = phasePowerForDelay(config_.heaterMinimumDelayUs);
  const double maximumPower = phasePowerForDelay(config_.heaterMaximumDelayUs);
  return delayForPhasePower(
      minimumPower + position * (maximumPower - minimumPower),
      config_.heaterMaximumDelayUs, config_.heaterMinimumDelayUs);
}

void Actuator::stopOutputs(uint32_t nowUs, ActuatorFault fault) {
  (void)nowUs;
  requestedHeatMilli_ = 0;
  requestedFanMilli_ = 0;
  effectiveHeatMilli_ = 0;
  effectiveFanMilli_ = 0;
  heaterDelayUs_ = 0;
  fanSettledDelayUs_ = 0;
  fanStartDelayUs_ = 0;
  fanStartedUs_ = 0;
  heatDeadlineUs_ = 0;
  heatDeadlineArmed_ = false;
  pendingHeatRunLimitUs_ = 0;
  heatQualificationStartedUs_ = 0;
  heatQualificationActive_ = false;
  if (fault != ActuatorFault::NONE) fault_ = fault;
  mode_ = fault_ == ActuatorFault::NONE
      ? ActuatorMode::IDLE : ActuatorMode::FAULT;
}

// Heat is already off and latched; the fan clears the hot chamber. Only flags change here, so the
// zero-cross ISR may call it: the next applyEffectiveState (the caller's, or service()'s) turns the
// cooldown into fan output, and onZeroCross keeps scheduling fan pulses under this fault.
void Actuator::beginOvertempCooldown(uint32_t nowUs) {
  overtempCooldownActive_ = true;
  overtempCooldownDeadlineUs_ = nowUs + config_.overtempCooldownUs;
}

void Actuator::markZeroCrossUnavailable(uint32_t nowUs) {
  if (zeroCrossAvailable_) {
    zeroCrossAvailable_ = false;
    zeroCrossUnavailableSinceUs_ = nowUs;
  } else if (zeroCrossUnavailableSinceUs_ == 0) {
    zeroCrossUnavailableSinceUs_ = nowUs;
  }
  // A true timing abort parks hardware outputs low. Preserve the requested
  // command for bounded recovery, but make logical Heat low as well so the
  // returning zero-cross must first establish 500 ms of Fan airflow.
  if (requestedHeatMilli_ > 0) {
    effectiveHeatMilli_ = 0;
    heaterDelayUs_ = 0;
    heatQualificationActive_ = false;
    heatQualificationStartedUs_ = 0;
  }
  if (fault_ == ActuatorFault::NONE &&
      (requestedFanMilli_ > 0 || requestedHeatMilli_ > 0 ||
       effectiveFanMilli_ > 0 || effectiveHeatMilli_ > 0)) {
    mode_ = ActuatorMode::ZERO_CROSS_WAIT;
  }
}

bool Actuator::request(uint32_t fanMilli, uint32_t heatMilli,
                       uint32_t nowUs, const char*& rejection,
                       uint32_t heatRunLimitUs) {
  rejection = nullptr;
  if (fanMilli > config_.fanMaximumLevelMilli ||
      heatMilli > config_.fanMaximumLevelMilli) {
    rejection = "Requested level is outside 0.0 through 10.0.";
    return false;
  }
  const uint32_t fan = normalizeLevel(fanMilli);
  const uint32_t heat = normalizeLevel(heatMilli);
  bool cancelNow = false;
  portENTER_CRITICAL(&mux_);
  if (fault_ != ActuatorFault::NONE) {
    portEXIT_CRITICAL(&mux_);
    rejection = "Actuation is fault-latched until controller restart.";
    return false;
  }
  if ((fan > 0 || heat > 0) &&
      (lastZeroCrossUs_ == 0 ||
       elapsedUsOrZero(nowUs, lastZeroCrossUs_) > config_.zeroCrossTimeoutUs)) {
    portEXIT_CRITICAL(&mux_);
    rejection = "Zero-cross timing is unavailable.";
    return false;
  }
  if (heat > 0) {
    if (heatRunLimitUs == 0 || heatRunLimitUs > config_.maximumHeatRunUs) {
      portEXIT_CRITICAL(&mux_);
      rejection = "Heat requires a bounded run duration.";
      return false;
    }
    if (thermalSafetyStatus_ != ThermalSafetyStatus::HEALTHY ||
        thermalSafetyUpdatedUs_ == 0 ||
        elapsedUsOrZero(nowUs, thermalSafetyUpdatedUs_) >
            config_.thermalSafetyFreshnessUs) {
      portEXIT_CRITICAL(&mux_);
      rejection = "Fresh fault-free thermocouple telemetry is required.";
      return false;
    }
  }

  const bool wasHeatingRequested = requestedHeatMilli_ > 0;
  const bool wasHeatingEffective = effectiveHeatMilli_ > 0;
  const uint32_t oldHeatFloor = minimumFanForHeat(requestedHeatMilli_);
  const uint32_t newHeatFloor = minimumFanForHeat(heat);
  requestedFanMilli_ = fan;
  requestedHeatMilli_ = heat;
  if (heat > 0) {
    pendingHeatRunLimitUs_ = heatRunLimitUs;
    if (!wasHeatingRequested ||
        (newHeatFloor > oldHeatFloor && effectiveFanMilli_ < newHeatFloor)) {
      heatQualificationActive_ = true;
      heatQualificationStartedUs_ = nowUs;
      heatDeadlineArmed_ = false;
      heatDeadlineUs_ = 0;
    } else if (wasHeatingEffective) {
      // The profile runner may renew a short lease. If it stops renewing,
      // the zero-cross ISR still removes Heat at the existing deadline.
      heatDeadlineUs_ = nowUs + heatRunLimitUs;
      heatDeadlineArmed_ = true;
    }
  } else {
    pendingHeatRunLimitUs_ = 0;
    heatQualificationActive_ = false;
    heatQualificationStartedUs_ = 0;
    heatDeadlineUs_ = 0;
    heatDeadlineArmed_ = false;
    cancelNow = wasHeatingRequested || wasHeatingEffective ||
        (fan == 0 && effectiveFanMilli_ > 0);
  }
  applyEffectiveState(nowUs);
  portEXIT_CRITICAL(&mux_);
  if (cancelNow) cancelScheduledPulses();
  return true;
}

void Actuator::stop(uint32_t nowUs) {
  portENTER_CRITICAL(&mux_);
  requestedFanMilli_ = 0;
  requestedHeatMilli_ = 0;
  pendingHeatRunLimitUs_ = 0;
  heatQualificationActive_ = false;
  heatQualificationStartedUs_ = 0;
  heatDeadlineArmed_ = false;
  heatDeadlineUs_ = 0;
  applyEffectiveState(nowUs);
  portEXIT_CRITICAL(&mux_);
  cancelScheduledPulses();
}

void Actuator::applyEffectiveState(uint32_t nowUs) {
  const bool actuationAbortFault = fault_ == ActuatorFault::THERMAL_STALE ||
                            fault_ == ActuatorFault::THERMAL_SENSOR ||
                            fault_ == ActuatorFault::OVERTEMPERATURE ||
                            fault_ == ActuatorFault::ZERO_CROSS_LOST;
  if (fault_ != ActuatorFault::NONE && !actuationAbortFault) {
    effectiveFanMilli_ = 0;
    effectiveHeatMilli_ = 0;
    mode_ = ActuatorMode::FAULT;
    return;
  }

  const bool cooling = fault_ == ActuatorFault::OVERTEMPERATURE && overtempCooldownActive_;
  uint32_t fan = actuationAbortFault
      ? (cooling ? config_.overtempCooldownFanMilli : 0) : requestedFanMilli_;
  const uint32_t heatFloor = actuationAbortFault ? 0 :
      minimumFanForHeat(requestedHeatMilli_);
  if (fan < heatFloor) fan = heatFloor;
  if (fan > 0) {
    if (effectiveFanMilli_ == 0) fanStartedUs_ = nowUs;
    effectiveFanMilli_ = fan;
    const FanTiming timing = calculateFanTiming(fan);
    fanSettledDelayUs_ = timing.settledDelayUs;
    fanStartDelayUs_ = timing.startDelayUs;
  } else {
    effectiveFanMilli_ = 0;
    fanSettledDelayUs_ = fanStartDelayUs_ = fanStartedUs_ = 0;
  }

  const bool wasHeating = effectiveHeatMilli_ > 0;
  const bool fanQualified = requestedHeatMilli_ > 0 &&
      effectiveFanMilli_ >= heatFloor && heatQualificationActive_ &&
      nowUs - heatQualificationStartedUs_ >= config_.fanQualificationUs;
  effectiveHeatMilli_ = requestedHeatMilli_ > 0 && fanQualified && !actuationAbortFault
      ? requestedHeatMilli_ : 0;
  heaterDelayUs_ = effectiveHeatMilli_ > 0
      ? calculateHeaterDelay(effectiveHeatMilli_) : 0;
  if (!wasHeating && effectiveHeatMilli_ > 0) {
    heatDeadlineUs_ = nowUs + pendingHeatRunLimitUs_;
    heatDeadlineArmed_ = true;
  }

  if (actuationAbortFault) mode_ = ActuatorMode::FAULT;
  else if (effectiveHeatMilli_ > 0) mode_ = ActuatorMode::HEATING;
  else if (requestedHeatMilli_ > 0) mode_ = ActuatorMode::FAN_STARTUP;
  else if (effectiveFanMilli_ > 0) {
    mode_ = nowUs - fanStartedUs_ < config_.fanStartupUs
        ? ActuatorMode::FAN_STARTUP : ActuatorMode::FAN_ONLY;
  } else mode_ = ActuatorMode::IDLE;
}

void Actuator::service(uint32_t nowUs) {
  bool cancelNow = false;
  portENTER_CRITICAL(&mux_);
  const bool outputsWereActive =
      effectiveFanMilli_ > 0 || effectiveHeatMilli_ > 0;
  lastServiceUs_ = nowUs;
  const bool timingNeeded = requestedFanMilli_ > 0 || requestedHeatMilli_ > 0 ||
      effectiveFanMilli_ > 0 || effectiveHeatMilli_ > 0;
  const bool zeroCrossTimedOut = lastZeroCrossUs_ == 0 ||
      elapsedUsOrZero(nowUs, lastZeroCrossUs_) > config_.zeroCrossTimeoutUs;
  if (timingNeeded && zeroCrossTimedOut) {
    if (zeroCrossAvailable_) {
      markZeroCrossUnavailable(nowUs);
      cancelNow = true;
    }
    const bool heatContext = requestedHeatMilli_ > 0 || effectiveHeatMilli_ > 0;
    if (heatContext && fault_ == ActuatorFault::NONE &&
        zeroCrossUnavailableSinceUs_ != 0 &&
        elapsedUsOrZero(nowUs, zeroCrossUnavailableSinceUs_) >=
            config_.zeroCrossRecoveryGraceUs) {
      stopOutputs(nowUs, ActuatorFault::ZERO_CROSS_LOST);
    }
  }

  if (overtempCooldownActive_ &&
      deadlineReached(true, nowUs, overtempCooldownDeadlineUs_)) {
    overtempCooldownActive_ = false;
    applyEffectiveState(nowUs);
  }
  if (zeroCrossAvailable_) {
    applyEffectiveState(nowUs);
  }
  const bool faultStopsAll = fault_ != ActuatorFault::NONE &&
      fault_ != ActuatorFault::THERMAL_STALE &&
      fault_ != ActuatorFault::THERMAL_SENSOR &&
      fault_ != ActuatorFault::OVERTEMPERATURE &&
      fault_ != ActuatorFault::ZERO_CROSS_LOST;
  const bool outputsStopped = outputsWereActive &&
      effectiveFanMilli_ == 0 && effectiveHeatMilli_ == 0;
  portEXIT_CRITICAL(&mux_);
  if (cancelNow || faultStopsAll || outputsStopped) cancelScheduledPulses();
}

void Actuator::updateThermalSafety(
    ThermalSafetyStatus status, uint32_t nowUs) {
  bool tripped = false;
  portENTER_CRITICAL(&mux_);
  thermalSafetyStatus_ = status;
  thermalSafetyUpdatedUs_ = nowUs;
  const bool authoritativeFault =
      status == ThermalSafetyStatus::SENSOR_FAULT ||
      status == ThermalSafetyStatus::OVERTEMPERATURE;
  if ((requestedHeatMilli_ > 0 || effectiveHeatMilli_ > 0 ||
       fault_ == ActuatorFault::THERMAL_STALE) &&
      authoritativeFault) {
    stopOutputs(nowUs,
        status == ThermalSafetyStatus::OVERTEMPERATURE
            ? ActuatorFault::OVERTEMPERATURE
            : ActuatorFault::THERMAL_SENSOR);
    if (fault_ == ActuatorFault::OVERTEMPERATURE) {
      beginOvertempCooldown(nowUs);
      applyEffectiveState(nowUs);
    }
    tripped = true;
  } else if (status == ThermalSafetyStatus::OVERTEMPERATURE && overtempCooldownActive_) {
    // Still at or above the limit: the cooldown runs until the reading has stayed below it for
    // the whole cooldown period.
    overtempCooldownDeadlineUs_ = nowUs + config_.overtempCooldownUs;
  }
  portEXIT_CRITICAL(&mux_);
  if (tripped) cancelScheduledPulses();
}

bool Actuator::clearThermalStaleFault(uint32_t nowUs) {
  bool cleared = false;
  portENTER_CRITICAL(&mux_);
  const bool telemetryFresh =
      thermalSafetyStatus_ == ThermalSafetyStatus::HEALTHY &&
      thermalSafetyUpdatedUs_ != 0 &&
      elapsedUsOrZero(nowUs, thermalSafetyUpdatedUs_) <=
          config_.thermalSafetyFreshnessUs;
  if (fault_ == ActuatorFault::THERMAL_STALE && telemetryFresh &&
      requestedHeatMilli_ == 0 && effectiveHeatMilli_ == 0) {
    fault_ = ActuatorFault::NONE;
    applyEffectiveState(nowUs);
    cleared = true;
  }
  portEXIT_CRITICAL(&mux_);
  return cleared;
}

void Actuator::cancelOvertempCooldown(uint32_t nowUs) {
  bool ended = false;
  portENTER_CRITICAL(&mux_);
  if (overtempCooldownActive_) {
    overtempCooldownActive_ = false;
    applyEffectiveState(nowUs);
    ended = true;
  }
  portEXIT_CRITICAL(&mux_);
  if (ended) cancelScheduledPulses();
}

void Actuator::forceOutputsLow() { cancelScheduledPulses(); }
void Actuator::cancelScheduledPulses() {
  CancelPulsePlan cancel = nullptr;
  void* context = nullptr;
  portENTER_CRITICAL_SAFE(&mux_);
  cancel = cancelPulsePlan_;
  context = pulseSchedulerContext_;
  portEXIT_CRITICAL_SAFE(&mux_);
  if (cancel != nullptr) cancel(context);
  gpio_set_level(config_.heaterPin, 0);
  gpio_set_level(config_.fanPin, 0);
}

void Actuator::latchManualConflict() {
  portENTER_CRITICAL_ISR(&mux_);
  fault_ = ActuatorFault::MANUAL_CONFLICT;
  overtempCooldownActive_ = false;
  requestedHeatMilli_ = requestedFanMilli_ = 0;
  heatDeadlineArmed_ = false;
  heatQualificationActive_ = false;
  effectiveHeatMilli_ = effectiveFanMilli_ = 0;
  mode_ = ActuatorMode::FAULT;
  portEXIT_CRITICAL_ISR(&mux_);
  forceOutputsLow();
}

void Actuator::onZeroCross(uint32_t nowUs) {
  bool schedulerFailed = false;
  bool outputsStopped = false;
  portENTER_CRITICAL_ISR(&mux_);
  const bool resumed = !zeroCrossAvailable_;
  lastZeroCrossUs_ = nowUs;
  zeroCrossAvailable_ = true;
  zeroCrossUnavailableSinceUs_ = 0;
  if (resumed) {
    if (requestedHeatMilli_ > 0 && effectiveHeatMilli_ == 0) {
      heatQualificationStartedUs_ = nowUs;
      heatQualificationActive_ = true;
    }
    if (fault_ != ActuatorFault::NONE) mode_ = ActuatorMode::FAULT;
    else if (effectiveHeatMilli_ > 0) mode_ = ActuatorMode::HEATING;
    else if (requestedHeatMilli_ > 0) mode_ = ActuatorMode::FAN_STARTUP;
    else if (effectiveFanMilli_ > 0) mode_ = ActuatorMode::FAN_ONLY;
    else mode_ = ActuatorMode::IDLE;
  }
  if (effectiveHeatMilli_ > 0) {
    const bool thermalStale = thermalSafetyUpdatedUs_ == 0 ||
        elapsedUsOrZero(nowUs, thermalSafetyUpdatedUs_) >
            config_.thermalSafetyFreshnessUs;
    const bool authoritativeFault =
        thermalSafetyStatus_ == ThermalSafetyStatus::SENSOR_FAULT ||
        thermalSafetyStatus_ == ThermalSafetyStatus::OVERTEMPERATURE;
    if (thermalStale || authoritativeFault) {
      stopOutputs(nowUs,
          thermalSafetyStatus_ == ThermalSafetyStatus::OVERTEMPERATURE
              ? ActuatorFault::OVERTEMPERATURE
              : thermalSafetyStatus_ == ThermalSafetyStatus::SENSOR_FAULT
                  ? ActuatorFault::THERMAL_SENSOR
                  : ActuatorFault::THERMAL_STALE);
      if (fault_ == ActuatorFault::OVERTEMPERATURE) beginOvertempCooldown(nowUs);
      outputsStopped = true;
    } else if (deadlineReached(heatDeadlineArmed_, nowUs, heatDeadlineUs_)) {
      stopOutputs(nowUs, ActuatorFault::NONE);
      outputsStopped = true;
    }
  }

  const bool maySchedule = fault_ == ActuatorFault::NONE ||
      fault_ == ActuatorFault::THERMAL_STALE ||
      fault_ == ActuatorFault::THERMAL_SENSOR ||
      fault_ == ActuatorFault::OVERTEMPERATURE ||
      fault_ == ActuatorFault::ZERO_CROSS_LOST;
  if (maySchedule) {
    const bool fanEnabled = effectiveFanMilli_ > 0;
    const bool heaterEnabled = effectiveHeatMilli_ > 0 &&
        fault_ == ActuatorFault::NONE;
    uint32_t fanDelayUs = fanSettledDelayUs_;
    if (fanEnabled && fanStartedUs_ != 0) {
      const uint32_t fanElapsedUs = nowUs - fanStartedUs_;
      if (fanElapsedUs < config_.fanStartupUs) {
        const uint32_t rangeUs = fanStartDelayUs_ - fanSettledDelayUs_;
        fanDelayUs = fanStartDelayUs_ - static_cast<uint32_t>(
            (static_cast<uint64_t>(rangeUs) * fanElapsedUs) /
            config_.fanStartupUs);
      }
    }
    if (fanEnabled || heaterEnabled) {
      const PhasePulsePlan plan = {
          fanDelayUs, heaterDelayUs_, config_.pulseWidthUs,
          fanEnabled, heaterEnabled};
      if (schedulePulsePlan_ == nullptr ||
          !schedulePulsePlan_(pulseSchedulerContext_, plan)) {
        fault_ = ActuatorFault::PULSE_SCHEDULER_FAILURE;
        overtempCooldownActive_ = false;
        requestedHeatMilli_ = requestedFanMilli_ = 0;
        heatDeadlineArmed_ = false;
        heatQualificationActive_ = false;
        effectiveHeatMilli_ = effectiveFanMilli_ = 0;
        mode_ = ActuatorMode::FAULT;
        schedulerFailed = true;
      } else {
        if (fanEnabled) fanPulseCount_++;
        if (heaterEnabled) heaterPulseCount_++;
      }
    }
  }
  portEXIT_CRITICAL_ISR(&mux_);
  if (schedulerFailed || outputsStopped) forceOutputsLow();
}

void Actuator::onZeroCrossDiscontinuity(uint32_t nowUs) {
  portENTER_CRITICAL_ISR(&mux_);
  markZeroCrossUnavailable(nowUs);
  portEXIT_CRITICAL_ISR(&mux_);
}

void Actuator::latchPulseSchedulerFailure() {
  portENTER_CRITICAL_SAFE(&mux_);
  fault_ = ActuatorFault::PULSE_SCHEDULER_FAILURE;
  overtempCooldownActive_ = false;
  requestedHeatMilli_ = requestedFanMilli_ = 0;
  effectiveHeatMilli_ = effectiveFanMilli_ = 0;
  heatDeadlineArmed_ = false;
  heatQualificationActive_ = false;
  mode_ = ActuatorMode::FAULT;
  portEXIT_CRITICAL_SAFE(&mux_);
  forceOutputsLow();
}

bool Actuator::outputsActive() const {
  portENTER_CRITICAL(&mux_);
  const bool active = effectiveFanMilli_ > 0 || effectiveHeatMilli_ > 0;
  portEXIT_CRITICAL(&mux_);
  return active;
}

ActuatorSnapshot Actuator::snapshot(uint32_t nowUs) const {
  ActuatorSnapshot result{};
  portENTER_CRITICAL(&mux_);
  result.mode = mode_;
  result.fault = fault_;
  result.requestedFanMilli = requestedFanMilli_;
  result.requestedHeatMilli = requestedHeatMilli_;
  result.effectiveFanMilli = effectiveFanMilli_;
  result.effectiveHeatMilli = effectiveHeatMilli_;
  result.fanSettledDelayUs = fanSettledDelayUs_;
  result.fanStartDelayUs = fanStartDelayUs_;
  result.heaterDelayUs = heaterDelayUs_;
  result.pulseWidthUs = config_.pulseWidthUs;
  result.fanPulseCount = fanPulseCount_;
  result.heaterPulseCount = heaterPulseCount_;
  result.fanContinuousUs = fanStartedUs_ == 0 ? 0 : nowUs - fanStartedUs_;
  result.lastZeroCrossAgeUs = lastZeroCrossUs_ == 0
      ? UINT32_MAX : elapsedUsOrZero(nowUs, lastZeroCrossUs_);
  result.zeroCrossUnavailableMs = zeroCrossUnavailableSinceUs_ == 0
      ? 0 : elapsedUsOrZero(nowUs, zeroCrossUnavailableSinceUs_) / 1000U;
  result.heatDeadlineRemainingMs = !heatDeadlineArmed_ ||
      deadlineReached(heatDeadlineArmed_, nowUs, heatDeadlineUs_) ? 0 :
      (heatDeadlineUs_ - nowUs) / 1000U;
  result.overtempCooldownRemainingMs = !overtempCooldownActive_ ||
      deadlineReached(true, nowUs, overtempCooldownDeadlineUs_) ? 0 :
      (overtempCooldownDeadlineUs_ - nowUs) / 1000U;
  result.thermalSafetyStatus = thermalSafetyStatus_;
  result.zeroCrossAvailable = zeroCrossAvailable_;
  result.fanQualifiedForHeat = effectiveFanMilli_ > 0 &&
      heatQualificationActive_ &&
      nowUs - heatQualificationStartedUs_ >= config_.fanQualificationUs;
  portEXIT_CRITICAL(&mux_);
  return result;
}

const char* Actuator::modeName(ActuatorMode mode) {
  switch (mode) {
    case ActuatorMode::IDLE: return "idle";
    case ActuatorMode::FAN_STARTUP: return "fan_startup";
    case ActuatorMode::FAN_ONLY: return "fan_only";
    case ActuatorMode::HEATING: return "heating";
    case ActuatorMode::ZERO_CROSS_WAIT: return "zero_cross_wait";
    case ActuatorMode::FAULT: return "fault";
    default: return "unknown";
  }
}
const char* Actuator::faultName(ActuatorFault fault) {
  switch (fault) {
    case ActuatorFault::NONE: return "none";
    case ActuatorFault::MANUAL_CONFLICT: return "manual_conflict";
    case ActuatorFault::ZERO_CROSS_LOST: return "zero_cross_lost";
    case ActuatorFault::PULSE_SCHEDULER_FAILURE: return "pulse_scheduler_failure";
    case ActuatorFault::THERMAL_STALE: return "thermal_stale";
    case ActuatorFault::THERMAL_SENSOR: return "thermal_sensor";
    case ActuatorFault::OVERTEMPERATURE: return "overtemperature";
    default: return "unknown";
  }
}
const char* Actuator::thermalSafetyName(ThermalSafetyStatus status) {
  switch (status) {
    case ThermalSafetyStatus::UNKNOWN: return "unknown";
    case ThermalSafetyStatus::HEALTHY: return "healthy";
    case ThermalSafetyStatus::SENSOR_FAULT: return "sensor_fault";
    case ThermalSafetyStatus::OVERTEMPERATURE: return "overtemperature";
    default: return "unknown";
  }
}
}  // namespace sr800