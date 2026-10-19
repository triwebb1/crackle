#include <cstdlib>
#include <iostream>
#include <string>
#include "sr800_actuator.h"

namespace {
int levels[16] = {};
uint64_t delayedUs = 0;
sr800::PhasePulsePlan lastPlan = {};
uint32_t scheduleCalls = 0;
uint32_t cancelCalls = 0;
bool scheduleSucceeds = true;
bool schedulerPlanActive = false;

bool fakeSchedule(void*, const sr800::PhasePulsePlan& plan) {
  lastPlan = plan;
  scheduleCalls += 1;
  schedulerPlanActive = scheduleSucceeds;
  return scheduleSucceeds;
}

void fakeCancel(void*) {
  cancelCalls += 1;
  schedulerPlanActive = false;
  levels[3] = 0;
  levels[4] = 0;
}

void attachScheduler(sr800::Actuator& actuator) {
  actuator.setPulseScheduler(fakeSchedule, fakeCancel, nullptr);
}

void require(bool condition, const char* message) {
  if (!condition) {
    std::cerr << "FAIL: " << message << '\n';
    std::exit(1);
  }
}

sr800::ActuatorConfig config() {
  return {
      3, 4, 100, 100, 10000,
      4460, 2110, 175, 606, 2820, 800,
      500000, 500000, 25000, 250000, 8333, 30000000, 1000000,
      10000, 180000000};
}

void keepAlive(sr800::Actuator& actuator, uint32_t& nowUs,
               uint32_t durationUs) {
  const uint32_t endUs = nowUs + durationUs;
  while (nowUs < endUs) {
    nowUs += 10000;
    actuator.onZeroCross(nowUs);
    actuator.service(nowUs);
  }
}
}  // namespace

int gpio_set_level(gpio_num_t pin, int level) {
  levels[pin] = level;
  return 0;
}

void esp_rom_delay_us(uint32_t delayUs) {
  delayedUs += delayUs;
}

int main() {
  const char* rejection = nullptr;
  uint32_t nowUs = 100000;
  auto baseConfig = config();
  sr800::Actuator actuator(baseConfig);
  actuator.begin();
  attachScheduler(actuator);
  actuator.onZeroCross(nowUs);
  actuator.updateThermalSafety(
      sr800::ThermalSafetyStatus::HEALTHY, nowUs);

  require(actuator.request(0, 100, nowUs + 1, rejection, 10000000),
          "lowest heat request should be accepted");
  auto state = actuator.snapshot(nowUs + 1);
  require(state.effectiveFanMilli == 100,
          "heat must raise fan to the minimum floor");
  require(state.effectiveHeatMilli == 0,
          "heater must remain off during fan qualification");
  require(state.mode == sr800::ActuatorMode::FAN_STARTUP,
          "qualification should report fan startup");

  nowUs += 490000;
  actuator.onZeroCross(nowUs);
  actuator.service(nowUs);
  state = actuator.snapshot(nowUs);
  require(state.effectiveHeatMilli == 0,
          "heater must still be off before 500 ms");

  nowUs += 10001;
  actuator.onZeroCross(nowUs);
  actuator.service(nowUs);
  state = actuator.snapshot(nowUs);
  require(state.effectiveHeatMilli == 100,
          "heater should enable only after qualified fan");
  require(state.heaterDelayUs == 2820,
          "heater proof must use reconstructed Power-1 delay");
  require(state.pulseWidthUs == 100,
          "all commands must use the 100 us proof pulse");

  nowUs += 10000;
  actuator.onZeroCross(nowUs);
  require(lastPlan.fanEnabled && lastPlan.heaterEnabled &&
              lastPlan.heaterDelayUs == 2820 &&
              lastPlan.pulseWidthUs == 100,
          "qualified heat must be delegated as a nonblocking pulse plan");
  require(delayedUs == 0,
          "actuator core must not busy-wait inside zero-cross handling");

  actuator.stop(nowUs);
  state = actuator.snapshot(nowUs);
  require(state.effectiveHeatMilli == 0,
          "stop must remove heater immediately");
  require(state.effectiveFanMilli == 0,
          "stop after heat must stop the fan immediately without cooling debt");

  actuator.updateThermalSafety(sr800::ThermalSafetyStatus::HEALTHY, nowUs);
  require(actuator.request(10000, 5000, nowUs, rejection, 10000000),
          "continuous mid-scale heat should be accepted");
  keepAlive(actuator, nowUs, 510000);
  state = actuator.snapshot(nowUs);
  require(state.effectiveHeatMilli == 5000 &&
              state.heaterDelayUs > 800 &&
              state.heaterDelayUs < 2820,
          "mid-scale heat must map between captured endpoint delays");
  actuator.stop(nowUs);
  require(actuator.request(10000, 0, nowUs, rejection),
          "capped maximum fan should be accepted");
  state = actuator.snapshot(nowUs);
  require(state.fanSettledDelayUs == 2110 &&
              state.fanStartDelayUs == 2716,
          "public Fan 10 must map to acoustically capped raw 8.9 timing");

  require(actuator.request(0, 0, nowUs, rejection),
          "Fan-only request should accept an all-off transition");
  state = actuator.snapshot(nowUs);
  require(state.effectiveFanMilli == 0 && state.effectiveHeatMilli == 0 &&
              !schedulerPlanActive,
          "Fan 0 / Heat 0 must disarm a persistent Fan-only pulse plan");

  // Level-change sequence: Fan 4 / Heat 0 -> Fan 4 / Heat 1 ->
  // Fan 4 / Heat 0 must cut Heat while honoring Fan 4 exactly.
  sr800::Actuator levelChange(config());
  levelChange.begin();
  attachScheduler(levelChange);
  uint32_t levelNow = 100000;
  levelChange.onZeroCross(levelNow);
  levelChange.updateThermalSafety(
      sr800::ThermalSafetyStatus::HEALTHY, levelNow);
  require(levelChange.request(4000, 0, levelNow + 1, rejection),
          "Fan 4 setup should start");
  require(levelChange.request(4000, 1000, levelNow + 2, rejection,
                              10000000),
          "Fan 4 / Heat 1 should start qualifying");
  keepAlive(levelChange, levelNow, 510000);
  state = levelChange.snapshot(levelNow);
  require(state.effectiveFanMilli == 4000 &&
              state.effectiveHeatMilli == 1000,
          "Fan 4 / Heat 1 should become effective after qualification");
  require(levelChange.request(4000, 0, levelNow, rejection),
          "Fan 4 / Heat 0 should be accepted");
  state = levelChange.snapshot(levelNow);
  require(state.requestedFanMilli == 4000 &&
              state.requestedHeatMilli == 0 &&
              state.effectiveFanMilli == 4000 &&
              state.effectiveHeatMilli == 0,
          "Heat-off must keep Fan 4 exactly and create no cooling debt");

  levelChange.updateThermalSafety(
      sr800::ThermalSafetyStatus::HEALTHY, levelNow);
  require(levelChange.request(4000, 1000, levelNow, rejection,
                              10000000),
          "Heat may be requested again under the existing Fan");
  keepAlive(levelChange, levelNow, 510000);
  require(levelChange.snapshot(levelNow).effectiveHeatMilli == 1000,
          "the second Heat request should become effective");
  require(levelChange.request(0, 0, levelNow, rejection),
          "Fan 0 / Heat 0 should be accepted");
  state = levelChange.snapshot(levelNow);
  require(state.requestedFanMilli == 0 &&
              state.requestedHeatMilli == 0 &&
              state.effectiveFanMilli == 0 &&
              state.effectiveHeatMilli == 0,
          "Fan 0 / Heat 0 must stop both outputs immediately");

  auto conflictConfig = config();
  sr800::Actuator conflict(conflictConfig);
  conflict.begin();
  attachScheduler(conflict);
  conflict.onZeroCross(100000);
  require(conflict.request(1000, 0, 100001, rejection),
          "fan request should start before conflict");
  conflict.latchManualConflict();
  state = conflict.snapshot(100002);
  require(state.fault == sr800::ActuatorFault::MANUAL_CONFLICT &&
              state.effectiveFanMilli == 0 &&
              state.effectiveHeatMilli == 0 &&
              levels[3] == 0 && levels[4] == 0,
          "manual conflict must latch and drop both outputs");
  require(!conflict.request(1000, 0, 100003, rejection),
          "fault latch must reject later requests");

  auto raceConfig = config();
  sr800::Actuator race(raceConfig);
  race.begin();
  attachScheduler(race);
  race.onZeroCross(100000);
  require(race.request(1000, 0, 100001, rejection),
          "timestamp-race fixture should start");
  race.onZeroCross(110000);
  race.service(109999);
  state = race.snapshot(109999);
  require(state.fault == sr800::ActuatorFault::NONE &&
              state.lastZeroCrossAgeUs == 0,
          "a zero-cross newer than the caller timestamp must not look lost");
  race.service(140001);
  state = race.snapshot(140001);
  require(state.fault == sr800::ActuatorFault::NONE &&
              state.mode == sr800::ActuatorMode::ZERO_CROSS_WAIT &&
              !state.zeroCrossAvailable,
          "a transient Fan-only timeout must suspend without latching");
  race.onZeroCross(150000);
  state = race.snapshot(150000);
  require(state.fault == sr800::ActuatorFault::NONE &&
              state.effectiveFanMilli == 1000 && state.zeroCrossAvailable,
          "a qualified edge must resume the retained Fan command");

  auto wrapConfig = config();
  sr800::Actuator wrap(wrapConfig);
  wrap.begin();
  attachScheduler(wrap);
  const uint32_t wrapEdgeUs = UINT32_MAX - 5000U;
  wrap.onZeroCross(wrapEdgeUs);
  require(wrap.request(1000, 0, 5000U, rejection),
          "a recent zero-cross across micros wrap must remain usable");
  wrap.service(15000U);
  state = wrap.snapshot(15000U);
  require(state.fault == sr800::ActuatorFault::NONE &&
              state.zeroCrossAvailable && state.effectiveFanMilli == 1000,
          "ordinary unsigned micros wrap must not look like an outage");

  // `micros()` legitimately wraps through zero. Explicit arming bits keep zero
  // usable as a real qualification timestamp and a real Heat deadline.
  auto qualificationWrapConfig = config();
  sr800::Actuator qualificationWrap(qualificationWrapConfig);
  qualificationWrap.begin();
  attachScheduler(qualificationWrap);
  qualificationWrap.onZeroCross(UINT32_MAX);
  qualificationWrap.updateThermalSafety(
      sr800::ThermalSafetyStatus::HEALTHY, UINT32_MAX);
  require(qualificationWrap.request(1000, 1000, 0, rejection, 1000000),
          "Heat qualification may start exactly at micros zero");
  for (uint32_t qualificationNow = 10000; qualificationNow <= 500000;
       qualificationNow += 10000) {
    qualificationWrap.onZeroCross(qualificationNow);
    qualificationWrap.service(qualificationNow);
  }
  require(qualificationWrap.snapshot(500000).effectiveHeatMilli == 1000,
          "a zero-valued qualification timestamp must still arm Heat");

  auto deadlineWrapConfig = config();
  deadlineWrapConfig.fanQualificationUs = 0;
  sr800::Actuator deadlineWrap(deadlineWrapConfig);
  deadlineWrap.begin();
  attachScheduler(deadlineWrap);
  const uint32_t deadlineStartUs = UINT32_MAX - 999999U;
  deadlineWrap.onZeroCross(deadlineStartUs);
  deadlineWrap.updateThermalSafety(
      sr800::ThermalSafetyStatus::HEALTHY, deadlineStartUs);
  require(deadlineWrap.request(1000, 1000, deadlineStartUs, rejection,
                               1000000),
          "a Heat lease whose deadline wraps to zero should start");
  state = deadlineWrap.snapshot(deadlineStartUs);
  require(state.effectiveHeatMilli == 1000 &&
              state.heatDeadlineRemainingMs == 1000,
          "the armed zero deadline must report its full remaining lease");
  deadlineWrap.updateThermalSafety(
      sr800::ThermalSafetyStatus::HEALTHY, UINT32_MAX);
  deadlineWrap.onZeroCross(UINT32_MAX);
  require(deadlineWrap.snapshot(UINT32_MAX).effectiveHeatMilli == 1000,
          "Heat must remain active one microsecond before a zero deadline");
  deadlineWrap.onZeroCross(0);
  state = deadlineWrap.snapshot(0);
  require(state.effectiveHeatMilli == 0 && state.effectiveFanMilli == 0,
          "the zero-valued armed deadline must expire the whole request");
  auto longOutageConfig = config();
  sr800::Actuator longOutage(longOutageConfig);
  longOutage.begin();
  attachScheduler(longOutage);
  const uint32_t longOutageEdgeUs = 100000;
  longOutage.onZeroCross(longOutageEdgeUs);
  require(!longOutage.request(1000, 0,
                              longOutageEdgeUs + 0x80000010U, rejection),
          "a real outage beyond the signed half-range must not look fresh");

  auto timeoutConfig = config();
  sr800::Actuator timeout(timeoutConfig);
  timeout.begin();
  attachScheduler(timeout);
  timeout.onZeroCross(100000);
  require(timeout.request(1000, 0, 100001, rejection),
          "timeout fixture should start");
  timeout.service(130002);
  state = timeout.snapshot(130002);
  require(state.fault == sr800::ActuatorFault::NONE &&
              state.mode == sr800::ActuatorMode::ZERO_CROSS_WAIT &&
              state.effectiveFanMilli == 1000,
          "Fan-only timing loss must preserve the command while fail-low");

  auto requalificationConfig = config();
  sr800::Actuator requalification(requalificationConfig);
  requalification.begin();
  attachScheduler(requalification);
  uint32_t requalificationNow = 100000;
  requalification.onZeroCross(requalificationNow);
  requalification.updateThermalSafety(
      sr800::ThermalSafetyStatus::HEALTHY, requalificationNow);
  require(requalification.request(1000, 1000, requalificationNow + 1,
                                  rejection, 10000000),
          "requalification fixture should start");
  keepAlive(requalification, requalificationNow, 510000);
  state = requalification.snapshot(requalificationNow);
  require(state.effectiveHeatMilli == 1000,
          "requalification fixture must reach active Heat");

  const uint32_t lastQualifiedEdgeUs = requalificationNow;
  requalification.service(lastQualifiedEdgeUs + 30001);
  state = requalification.snapshot(lastQualifiedEdgeUs + 30001);
  require(state.fault == sr800::ActuatorFault::NONE &&
              state.effectiveHeatMilli == 0 &&
              state.requestedHeatMilli == 1000 &&
              state.mode == sr800::ActuatorMode::ZERO_CROSS_WAIT,
          "a short timing abort must make logical Heat low but retain intent");

  requalificationNow = lastQualifiedEdgeUs + 100000;
  requalification.updateThermalSafety(
      sr800::ThermalSafetyStatus::HEALTHY, requalificationNow);
  requalification.onZeroCross(requalificationNow);
  requalification.service(requalificationNow);
  state = requalification.snapshot(requalificationNow);
  require(state.effectiveFanMilli == 1000 && state.effectiveHeatMilli == 0,
          "the returning edge must resume Fan without Heat");
  for (int tick = 0; tick < 49; ++tick) {
    requalificationNow += 10000;
    requalification.updateThermalSafety(
        sr800::ThermalSafetyStatus::HEALTHY, requalificationNow);
    requalification.onZeroCross(requalificationNow);
    requalification.service(requalificationNow);
  }
  state = requalification.snapshot(requalificationNow);
  require(state.effectiveHeatMilli == 0,
          "Heat must remain off throughout the new 500 ms qualification");
  requalificationNow += 10001;
  requalification.updateThermalSafety(
      sr800::ThermalSafetyStatus::HEALTHY, requalificationNow);
  requalification.onZeroCross(requalificationNow);
  requalification.service(requalificationNow);
  state = requalification.snapshot(requalificationNow);
  require(state.effectiveHeatMilli == 1000,
          "Heat may resume only after a full new 500 ms Fan qualification");

  auto outageConfig = config();
  sr800::Actuator outage(outageConfig);
  outage.begin();
  attachScheduler(outage);
  uint32_t outageNow = 100000;
  outage.onZeroCross(outageNow);
  outage.updateThermalSafety(
      sr800::ThermalSafetyStatus::HEALTHY, outageNow);
  require(outage.request(1000, 1000, outageNow + 1,
                         rejection, 10000000),
          "Heat outage fixture should start");
  keepAlive(outage, outageNow, 510000);
  state = outage.snapshot(outageNow);
  require(state.effectiveHeatMilli == 1000,
          "Heat outage fixture must reach active Heat");
  outage.service(outageNow + 30001);
  state = outage.snapshot(outageNow + 30001);
  require(state.fault == sr800::ActuatorFault::NONE &&
              state.mode == sr800::ActuatorMode::ZERO_CROSS_WAIT &&
              state.effectiveHeatMilli == 0 &&
              !state.zeroCrossAvailable,
          "short timing loss must suspend with logical Heat fail-low");
  outage.service(outageNow + 280002);
  state = outage.snapshot(outageNow + 280002);
  require(state.fault == sr800::ActuatorFault::ZERO_CROSS_LOST &&
              state.effectiveHeatMilli == 0 &&
              state.effectiveFanMilli == 0,
          "sustained timing loss must latch and stop both outputs");
  outage.onZeroCross(outageNow + 290000);
  state = outage.snapshot(outageNow + 290000);
  require(state.fault == sr800::ActuatorFault::ZERO_CROSS_LOST &&
              state.effectiveHeatMilli == 0 &&
              state.effectiveFanMilli == 0 && state.zeroCrossAvailable,
          "timing recovery after a sustained outage must not resume outputs");
  require(!outage.request(1000, 1000, outageNow + 290001,
                          rejection, 1000000),
          "latched Heat outage must reject automatic Heat restart");
  auto fullConfig = config();
  sr800::Actuator full(fullConfig);
  full.begin();
  attachScheduler(full);
  full.onZeroCross(100000);
  full.updateThermalSafety(
      sr800::ThermalSafetyStatus::HEALTHY, 100000);
  require(full.request(0, 8000, 100001, rejection, 10000000),
          "high heat request should be accepted");
  state = full.snapshot(100001);
  require(state.effectiveFanMilli == 100,
          "all nonzero Heat permits the captured factory Fan-1 endpoint");

  auto schedulerFailureConfig = config();
  sr800::Actuator schedulerFailure(schedulerFailureConfig);
  schedulerFailure.begin();
  attachScheduler(schedulerFailure);
  schedulerFailure.onZeroCross(100000);
  require(schedulerFailure.request(1000, 0, 100001, rejection),
          "scheduler failure fixture should start");
  scheduleSucceeds = false;
  schedulerFailure.onZeroCross(110000);
  scheduleSucceeds = true;
  state = schedulerFailure.snapshot(110001);
  require(state.fault ==
              sr800::ActuatorFault::PULSE_SCHEDULER_FAILURE &&
              state.effectiveFanMilli == 0 &&
              state.effectiveHeatMilli == 0,
          "scheduler failure must latch both outputs off");
  require(scheduleCalls > 0 && cancelCalls > 0,
          "actuator must use both scheduler hooks");

  auto leaseConfig = config();
  leaseConfig.maximumHeatRunUs = 2000000;
  sr800::Actuator lease(leaseConfig);
  lease.begin();
  attachScheduler(lease);
  uint32_t leaseNow = 100000;
  lease.onZeroCross(leaseNow);
  lease.updateThermalSafety(sr800::ThermalSafetyStatus::HEALTHY, leaseNow);
  require(lease.request(1000, 1000, leaseNow + 1, rejection, 1000000),
          "bounded heater lease should start");
  for (int i = 0; i < 55; ++i) {
    leaseNow += 10000;
    lease.onZeroCross(leaseNow);
    lease.service(leaseNow);
  }
  state = lease.snapshot(leaseNow);
  require(state.effectiveHeatMilli == 1000,
          "lease fixture must reach heating after fan qualification");
  const uint32_t leaseCancelCountBeforeExpiry = cancelCalls;
  for (int i = 0; i < 110; ++i) {
    leaseNow += 10000;
    lease.updateThermalSafety(sr800::ThermalSafetyStatus::HEALTHY, leaseNow);
    lease.onZeroCross(leaseNow);
  }
  state = lease.snapshot(leaseNow);
  require(state.effectiveHeatMilli == 0 &&
              state.effectiveFanMilli == 0,
          "zero-cross path must expire the whole request without loop service");
  require(!schedulerPlanActive && cancelCalls > leaseCancelCountBeforeExpiry,
          "lease expiry must cancel the persistent hardware pulse plan");


  auto thermalConfig = config();
  sr800::Actuator thermal(thermalConfig);
  thermal.begin();
  attachScheduler(thermal);
  uint32_t thermalNow = 100000;
  thermal.onZeroCross(thermalNow);
  thermal.updateThermalSafety(sr800::ThermalSafetyStatus::HEALTHY, thermalNow);
  require(thermal.request(1000, 1000, thermalNow + 1, rejection, 10000000),
          "thermal fixture should start");
  for (int i = 0; i < 55; ++i) {
    thermalNow += 10000;
    thermal.onZeroCross(thermalNow);
    thermal.service(thermalNow);
  }
  thermal.updateThermalSafety(sr800::ThermalSafetyStatus::SENSOR_FAULT,
                              thermalNow + 1);
  state = thermal.snapshot(thermalNow + 1);
  require(state.fault == sr800::ActuatorFault::THERMAL_SENSOR &&
              state.effectiveHeatMilli == 0 && state.effectiveFanMilli == 0,
          "thermocouple failure must cut both outputs without cooling debt");
  require(!thermal.clearThermalStaleFault(thermalNow + 2),
          "a qualified physical sensor fault must remain power-cycle latched");

  auto overtemperatureConfig = config();
  sr800::Actuator overtemperature(overtemperatureConfig);
  overtemperature.begin();
  attachScheduler(overtemperature);
  uint32_t overtemperatureNow = 100000;
  overtemperature.onZeroCross(overtemperatureNow);
  overtemperature.updateThermalSafety(
      sr800::ThermalSafetyStatus::HEALTHY, overtemperatureNow);
  require(overtemperature.request(1000, 1000, overtemperatureNow + 1,
                                  rejection, 10000000),
          "overtemperature fixture should start");
  keepAlive(overtemperature, overtemperatureNow, 550000);
  overtemperature.updateThermalSafety(
      sr800::ThermalSafetyStatus::OVERTEMPERATURE, overtemperatureNow + 1);
  state = overtemperature.snapshot(overtemperatureNow + 1);
  require(state.fault == sr800::ActuatorFault::OVERTEMPERATURE &&
              state.effectiveHeatMilli == 0 && state.effectiveFanMilli == 10000 &&
              state.overtempCooldownRemainingMs > 0,
          "qualified sustained overtemperature must cut Heat at once and start a Fan 10 cooldown");
  require(!overtemperature.clearThermalStaleFault(overtemperatureNow + 2),
          "overtemperature must remain power-cycle latched");
  require(!overtemperature.request(1000, 1000, overtemperatureNow + 3, rejection, 10000000) &&
              !overtemperature.request(5000, 0, overtemperatureNow + 3, rejection),
          "no command, Heat or Fan, is accepted during or after an overtemperature trip");
  {
    // The cooldown actually drives the fan: zero crosses schedule fan pulses and never heater pulses.
    const uint32_t before = scheduleCalls;
    keepAlive(overtemperature, overtemperatureNow, 100000);
    require(scheduleCalls > before && lastPlan.fanEnabled && !lastPlan.heaterEnabled,
            "the overtemperature cooldown must schedule fan pulses only");
  }
  // An ordinary stop (a workflow ending) leaves the cooldown running.
  overtemperature.stop(overtemperatureNow + 1);
  keepAlive(overtemperature, overtemperatureNow, 20000);
  state = overtemperature.snapshot(overtemperatureNow);
  require(state.effectiveFanMilli == 10000,
          "an internal stop must not end the overtemperature cooldown");
  // While the reading stays at or above the limit, the cooldown clock restarts.
  keepAlive(overtemperature, overtemperatureNow, 170000000);
  overtemperature.updateThermalSafety(
      sr800::ThermalSafetyStatus::OVERTEMPERATURE, overtemperatureNow);
  keepAlive(overtemperature, overtemperatureNow, 20000000);
  state = overtemperature.snapshot(overtemperatureNow);
  require(state.effectiveFanMilli == 10000 && state.overtempCooldownRemainingMs > 150000,
          "a reading still over the limit must extend the cooldown");
  // Below the limit, the cooldown ends after the full period and every output is off.
  overtemperature.updateThermalSafety(
      sr800::ThermalSafetyStatus::HEALTHY, overtemperatureNow);
  keepAlive(overtemperature, overtemperatureNow, 161000000);
  state = overtemperature.snapshot(overtemperatureNow);
  require(state.effectiveFanMilli == 0 && state.effectiveHeatMilli == 0 &&
              state.overtempCooldownRemainingMs == 0 &&
              state.fault == sr800::ActuatorFault::OVERTEMPERATURE,
          "the cooldown must end with all outputs off and the fault still latched");

  {
    // An operator Stop ends the cooldown at once.
    auto stopConfig = config();
    sr800::Actuator stopCooldown(stopConfig);
    stopCooldown.begin();
    attachScheduler(stopCooldown);
    uint32_t stopNow = 100000;
    stopCooldown.onZeroCross(stopNow);
    stopCooldown.updateThermalSafety(sr800::ThermalSafetyStatus::HEALTHY, stopNow);
    require(stopCooldown.request(1000, 1000, stopNow + 1, rejection, 10000000),
            "Stop-cooldown fixture should start");
    keepAlive(stopCooldown, stopNow, 550000);
    stopCooldown.updateThermalSafety(sr800::ThermalSafetyStatus::OVERTEMPERATURE, stopNow + 1);
    require(stopCooldown.snapshot(stopNow + 1).effectiveFanMilli == 10000,
            "Stop fixture should be cooling");
    stopCooldown.stop(stopNow + 2);
    stopCooldown.cancelOvertempCooldown(stopNow + 2);
    keepAlive(stopCooldown, stopNow, 20000);
    state = stopCooldown.snapshot(stopNow);
    require(state.effectiveFanMilli == 0 && state.effectiveHeatMilli == 0 &&
                levels[3] == 0 && levels[4] == 0,
            "an operator Stop must end the overtemperature cooldown with every output off");
  }

  {
    // Using the factory controls during a cooldown hands the roaster back: everything off.
    auto conflictConfig = config();
    sr800::Actuator conflictCooldown(conflictConfig);
    conflictCooldown.begin();
    attachScheduler(conflictCooldown);
    uint32_t conflictNow = 100000;
    conflictCooldown.onZeroCross(conflictNow);
    conflictCooldown.updateThermalSafety(sr800::ThermalSafetyStatus::HEALTHY, conflictNow);
    require(conflictCooldown.request(1000, 1000, conflictNow + 1, rejection, 10000000),
            "conflict-cooldown fixture should start");
    keepAlive(conflictCooldown, conflictNow, 550000);
    conflictCooldown.updateThermalSafety(sr800::ThermalSafetyStatus::OVERTEMPERATURE, conflictNow + 1);
    conflictCooldown.latchManualConflict();
    keepAlive(conflictCooldown, conflictNow, 20000);
    state = conflictCooldown.snapshot(conflictNow);
    require(state.fault == sr800::ActuatorFault::MANUAL_CONFLICT &&
                state.effectiveFanMilli == 0 && state.overtempCooldownRemainingMs == 0,
            "a manual-control conflict must end the overtemperature cooldown");
  }

  auto staleConfig = config();
  sr800::Actuator stale(staleConfig);
  stale.begin();
  attachScheduler(stale);
  uint32_t staleNow = 100000;
  stale.onZeroCross(staleNow);
  stale.updateThermalSafety(sr800::ThermalSafetyStatus::HEALTHY, staleNow);
  require(stale.request(1000, 1000, staleNow + 1, rejection, 10000000),
          "stale telemetry fixture should start");
  for (int i = 0; i < 55; ++i) {
    staleNow += 10000;
    stale.onZeroCross(staleNow);
    stale.service(staleNow);
  }
  staleNow = 1100001;
  const uint32_t staleCancelCountBeforeAbort = cancelCalls;
  stale.onZeroCross(staleNow);
  state = stale.snapshot(staleNow);
  require(state.fault == sr800::ActuatorFault::THERMAL_STALE &&
              state.effectiveHeatMilli == 0 && state.effectiveFanMilli == 0,
          "a telemetry lapse must cut both outputs without "
          "claiming sensor failure");
  require(std::string(sr800::Actuator::faultName(state.fault)) ==
              "thermal_stale",
          "recoverable lapse must keep an exact wire-level fault name");

  require(!schedulerPlanActive && cancelCalls > staleCancelCountBeforeAbort,
          "ISR thermal abort must cancel the persistent hardware pulse plan");

  stale.updateThermalSafety(sr800::ThermalSafetyStatus::HEALTHY, staleNow + 1);
  staleNow += 1;
  require(stale.clearThermalStaleFault(staleNow),
          "fresh telemetry may clear stale fault immediately after abort");
  state = stale.snapshot(staleNow);
  require(state.fault == sr800::ActuatorFault::NONE &&
              state.effectiveHeatMilli == 0 && state.effectiveFanMilli == 0,
          "clearing telemetry lapse must never restore the old request");
  require(stale.request(1000, 1000, staleNow, rejection, 10000000),
          "a new bounded operation may start after telemetry recovery");
  stale.stop(staleNow);

  sr800::Actuator promoted{config()};
  promoted.begin();
  attachScheduler(promoted);
  uint32_t promotedNow = 100000;
  promoted.onZeroCross(promotedNow);
  promoted.updateThermalSafety(sr800::ThermalSafetyStatus::HEALTHY,
                               promotedNow);
  require(promoted.request(1000, 1000, promotedNow + 1, rejection, 10000000),
          "fault-promotion fixture should start");
  for (int i = 0; i < 55; ++i) {
    promotedNow += 10000;
    promoted.onZeroCross(promotedNow);
    promoted.service(promotedNow);
  }
  promotedNow = 1100001;
  promoted.onZeroCross(promotedNow);
  require(promoted.snapshot(promotedNow).fault ==
              sr800::ActuatorFault::THERMAL_STALE,
          "fixture must first enter the recoverable stale state");
  promoted.updateThermalSafety(sr800::ThermalSafetyStatus::SENSOR_FAULT,
                               promotedNow + 1);
  require(promoted.snapshot(promotedNow + 1).fault ==
              sr800::ActuatorFault::THERMAL_SENSOR,
          "qualified sensor evidence must promote stale to power-cycle latch");
  promoted.updateThermalSafety(sr800::ThermalSafetyStatus::HEALTHY,
                               promotedNow + 2);
  keepAlive(promoted, promotedNow, 3100000);
  require(!promoted.clearThermalStaleFault(promotedNow),
          "physical sensor latch must not clear through stale recovery");

  auto requalifyConfig = config();
  sr800::Actuator requalify(requalifyConfig);
  requalify.begin();
  attachScheduler(requalify);
  uint32_t requalifyNow = 100000;
  requalify.onZeroCross(requalifyNow);
  requalify.updateThermalSafety(sr800::ThermalSafetyStatus::HEALTHY,
                                requalifyNow);
  require(requalify.request(100, 100, requalifyNow + 1,
                            rejection, 10000000),
          "low heat fixture should start");
  for (int i = 0; i < 55; ++i) {
    requalifyNow += 10000;
    requalify.onZeroCross(requalifyNow);
    requalify.service(requalifyNow);
  }
  requalify.updateThermalSafety(
      sr800::ThermalSafetyStatus::HEALTHY, requalifyNow);
  require(requalify.request(100, 8000, requalifyNow,
                            rejection, 10000000),
          "higher heat request should be accepted");
  state = requalify.snapshot(requalifyNow);
  require(state.effectiveFanMilli == 100 && state.effectiveHeatMilli == 8000,
          "raising Heat keeps running when the already-qualified Fan-1 floor is unchanged");

  sr800::Actuator sufficientAirflow(requalifyConfig);
  sufficientAirflow.begin();
  attachScheduler(sufficientAirflow);
  uint32_t sufficientNow = 100000;
  sufficientAirflow.onZeroCross(sufficientNow);
  sufficientAirflow.updateThermalSafety(
      sr800::ThermalSafetyStatus::HEALTHY, sufficientNow);
  require(sufficientAirflow.request(3000, 100, sufficientNow + 1,
                                    rejection, 10000000),
          "high-airflow low-heat fixture should start");
  keepAlive(sufficientAirflow, sufficientNow, 550000);
  state = sufficientAirflow.snapshot(sufficientNow);
  require(state.effectiveHeatMilli == 100,
          "high-airflow fixture should finish initial qualification");
  sufficientAirflow.updateThermalSafety(
      sr800::ThermalSafetyStatus::HEALTHY, sufficientNow);
  require(sufficientAirflow.request(3000, 8000, sufficientNow,
                                    rejection, 10000000),
          "higher heat with already-sufficient airflow should be accepted");
  state = sufficientAirflow.snapshot(sufficientNow);
  require(state.effectiveFanMilli == 3000 && state.effectiveHeatMilli == 8000,
          "raising heat must not restart qualification when current airflow already clears the new floor");
  std::cout << "actuator safety tests passed\n";
  return 0;
}
