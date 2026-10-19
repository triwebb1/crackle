#include "sr800_journey_control.h"

#include <cmath>

namespace sr800 {
namespace {

/**
 * The TypeScript `clamp`, reproduced exactly - including its tolerance for
 * inverted bounds, which a zone with `fanMin > fanMax` would otherwise turn
 * into a NaN or a silently wrong pick:
 *
 *   clamp = max(min(lo, hi), min(max(lo, hi), value))
 */
double clampValue(double value, double minimum, double maximum) {
  const double low = minimum < maximum ? minimum : maximum;
  const double high = minimum < maximum ? maximum : minimum;
  const double upper = high < value ? high : value;
  return low > upper ? low : upper;
}

bool finite(double value) { return std::isfinite(value); }

struct EffectiveLevels {
  double fan;
  double heat;
};

// What the actuator will actually drive for a requested pair.
EffectiveLevels effectiveLevels(double fan, double heat) {
  double boundedHeat = 0.0;
  if (finite(heat)) {
    boundedHeat = heat < 0.0 ? 0.0 : (heat > 10.0 ? 10.0 : heat);
  }
  const double normalized = normalizeFanLevel(fan);
  const double floor = minimumFanForHeat(boundedHeat);
  return {normalized > floor ? normalized : floor, boundedHeat};
}

// Shape Journey Heat only. Fan follows the solve IMMEDIATELY — increases,
// reductions and cooling alike, with no gradual-reduction or retention
// state; the zone's fanMin is the circulation knob. Heat keeps its
// symmetric positive-to-positive bound. Manual/timed commands never pass
// through this function. If the slew holds Heat above zero after the solve
// asked for less, the universal heat-on Fan floor still applies to the pair
// actually commanded.
JourneyCommand slewLimitedJourneyCommand(const JourneyControlState& state,
                                          double elapsedSec,
                                          const JourneyZone& zone,
                                          const JourneyCommand& unconstrained) {
  JourneyCommand command = unconstrained;
  command.unconstrainedHeat = unconstrained.heat;
  command.heatSlewLimited = false;
  if (unconstrained.cooling) return command;
  if (!state.hasLastCommand) return command;

  double stepSec = elapsedSec - state.lastCommandSec;
  if (stepSec < 0.0) stepSec = 0.0;
  if (stepSec > kMaxHeatSlewStepSec) stepSec = kMaxHeatSlewStepSec;
  const double maxDelta = kMaxHeatSlewPerSec * stepSec;
  double heat = clampValue(unconstrained.heat,
                           state.lastCommandHeat - maxDelta,
                           state.lastCommandHeat + maxDelta);
  if (heat > zone.heatMax) heat = zone.heatMax;
  // Heat on means Fan 1.0 or higher on every command path. The solve already
  // folds the rule into its own pair; a slewed Heat that outlives a solved
  // Heat of zero must not escape it.
  const double fanFloor = minimumFanForHeat(heat);
  const double fan =
      unconstrained.fan > fanFloor ? unconstrained.fan : fanFloor;
  command.fan = fan;
  if (std::fabs(heat - unconstrained.heat) <= 1e-9) {
    command.heat = heat;
    return command;
  }

  command.heat = heat;
  command.heatSlewLimited = true;
  if (unconstrained.heat > heat) command.saturatedHigh = true;
  else command.saturatedLow = true;
  return command;
}

}  // namespace

double normalizeFanLevel(double fan) {
  if (!finite(fan) || fan <= 0.0) return 0.0;
  const double capped = fan > kActuatorMaximumFan ? kActuatorMaximumFan : fan;
  return capped < kActuatorMinimumFan ? kActuatorMinimumFan : capped;
}

// Heat needs real airflow: Fan 1.0 or higher whenever Heat is above zero.
// The actuator core's own 0.1-with-heat qualification is the audited
// backstop beneath this command rule.
double minimumFanForHeat(double heat) {
  return !finite(heat) || heat <= 0.0 ? 0.0 : kHeatOnMinimumFan;
}

// The asymmetric authority clamps and the direction-aware bound test, exactly
// as the TypeScript `clampCorrection` / `clampIntegral` / `correctionAtBound`.
double clampCorrection(double rateCPerMin) {
  return clampValue(rateCPerMin, -kMaxCoolingCorrectionCPerMin,
                    kMaxCorrectionCPerMin);
}

double clampIntegral(double rateCPerMin) {
  return clampValue(rateCPerMin, -kMaxCoolingIntegralCPerMin,
                    kMaxIntegralCPerMin);
}

bool correctionAtBound(double rateCPerMin) {
  return rateCPerMin >= kMaxCorrectionCPerMin ||
         rateCPerMin <= -kMaxCoolingCorrectionCPerMin;
}

bool zoneAttained(const JourneyZone& zone, double temperatureC) {
  if (!finite(temperatureC)) return false;
  return zone.endC >= zone.startC ? temperatureC >= zone.endC
                                  : temperatureC <= zone.endC;
}
// Fan 10 through 130 C; above that there is no Journey-specific floor at all.
// The zone's own fanMin and the universal heat-on Fan 1.0 rule are the only
// constraints, exactly as in the TypeScript oracle.
double journeyCirculationFloor(double beanTempC) {
  return beanTempC <= kFullAirflowUntilC ? kActuatorMaximumFan : 0.0;
}


bool zoneCompleted(const JourneyZone& zone, double temperatureC,
                   double zoneElapsedSec) {
  const double span = zone.endC - zone.startC;
  if (std::fabs(span) <= kZoneHoldEpsilonC) {
    const double nominal = zone.durationSec > 1.0 ? zone.durationSec : 1.0;
    return zoneElapsedSec >= nominal;
  }
  return zoneAttained(zone, temperatureC);
}

double zoneTargetC(const JourneyZone& zone, double zoneElapsedSec) {
  const double span = zone.endC - zone.startC;
  const double duration = zone.durationSec > 1.0 ? zone.durationSec : 1.0;
  const double elapsed = zoneElapsedSec > 0.0 ? zoneElapsedSec : 0.0;
  const double raw = zone.startC + (span / duration) * elapsed;
  if (span >= 0.0) return raw < zone.endC ? raw : zone.endC;
  return raw > zone.endC ? raw : zone.endC;
}

// (6)/(7): the trailing-window RoR and its one-lag-ahead prediction, from the
// history of earlier samples plus the sample being controlled on. Unavailable
// until a sample at least one window older exists; the lead is zero until a
// second window before that one exists too.
RateEstimate predictedRate(const RateSample* history, size_t count,
                           const RateSample& now) {
  RateEstimate estimate;
  // The newest sample at least one window old anchors the measured RoR.
  size_t refIndex = 0;
  bool haveRef = false;
  for (size_t index = count; index > 0; --index) {
    if (now.sec - history[index - 1].sec >= kRateWindowSec) {
      refIndex = index - 1;
      haveRef = true;
      break;
    }
  }
  if (!haveRef) return estimate;
  const RateSample& ref = history[refIndex];
  const double measuredCPerMin =
      (60.0 * (now.tempC - ref.tempC)) / (now.sec - ref.sec);

  // The window before it gives the trend; without one there is no lead.
  size_t earlierIndex = 0;
  bool haveEarlier = false;
  for (size_t index = refIndex; index > 0; --index) {
    if (ref.sec - history[index - 1].sec >= kRateWindowSec) {
      earlierIndex = index - 1;
      haveEarlier = true;
      break;
    }
  }
  double leadCPerMin = 0.0;
  if (haveEarlier) {
    const RateSample& earlier = history[earlierIndex];
    const double previousCPerMin =
        (60.0 * (ref.tempC - earlier.tempC)) / (ref.sec - earlier.sec);
    const double trendCPerMinPerSec =
        (measuredCPerMin - previousCPerMin) / (now.sec - ref.sec);
    leadCPerMin = clampValue(kRateLeadSec * trendCPerMinPerSec,
                             -kMaxRateLeadCPerMin, kMaxRateLeadCPerMin);
  }
  estimate.available = true;
  estimate.measuredCPerMin = measuredCPerMin;
  estimate.leadCPerMin = leadCPerMin;
  estimate.predictedCPerMin = measuredCPerMin + leadCPerMin;
  return estimate;
}

// The history after this sample: samples older than the history span are
// dropped, the capacity is enforced oldest-first, and a sample that does not
// advance the clock is not recorded twice. The array is ordered by time, so
// the age filter is a compaction pass.
void appendRateSample(RateSample* history, size_t& count,
                      const RateSample& sample) {
  if (count > 0 && sample.sec <= history[count - 1].sec) return;
  size_t kept = 0;
  for (size_t index = 0; index < count; ++index) {
    if (sample.sec - history[index].sec <= kRateHistorySec) {
      history[kept] = history[index];
      kept += 1;
    }
  }
  count = kept;
  if (count == kRateHistoryCapacity) {
    for (size_t index = 1; index < count; ++index) {
      history[index - 1] = history[index];
    }
    count -= 1;
  }
  history[count] = sample;
  count += 1;
}

JourneyCommand journeyCommand(const JourneyPlan& plan, double elapsedSec,
                              double beanTempC, double ambientC,
                              double batchMassG,
                              const JourneyCalibration& calibration,
                              double rateCorrectionCPerMin,
                              size_t anchorZoneIndex,
                              double anchorZoneEntrySec) {
  JourneyCommand command;
  if (plan.zones == nullptr || plan.zoneCount == 0) return command;

  const size_t index = anchorZoneIndex < plan.zoneCount ? anchorZoneIndex
                                                        : plan.zoneCount - 1;
  const JourneyZone& zone = plan.zones[index];
  const double zoneEntrySec = anchorZoneEntrySec;
  const double zoneElapsedSec = elapsedSec - zoneEntrySec;

  const double goalC = zoneTargetC(zone, zoneElapsedSec);
  const double spanC = zone.endC - zone.startC;
  const double nominal = zone.durationSec > 1.0 ? zone.durationSec : 1.0;
  const bool holdingZone = std::fabs(spanC) <= kZoneHoldEpsilonC;

  command.zoneIndex = index;
  command.zoneEntrySec = zoneEntrySec;
  command.holdingAtZoneEnd = zoneElapsedSec >= nominal;
  command.goalC = goalC;
  // Position error remains capped at the endpoint, while feed-forward retains
  // the authored slope during an overrun.
  command.requiredRateCPerMin =
      holdingZone ? 0.0 : (spanC / nominal) * 60.0;

  // The slope the plan and the feedback ask for together.
  const double correction =
      finite(rateCorrectionCPerMin) ? rateCorrectionCPerMin : 0.0;
  command.commandedRateCPerMin = command.requiredRateCPerMin + correction;

  const double overAmbientC =
      (beanTempC - ambientC) > 0.0 ? (beanTempC - ambientC) : 0.0;
  const double passiveLoss = overAmbientC * calibration.thermalLossPerMinPerC;
  const double massG = batchMassG > 1.0 ? batchMassG : 1.0;
  const double capacityScale = calibration.referenceBatchMassG / massG;

  if (spanC < -kZoneHoldEpsilonC) {
    // Cooling is also the final chaff-clearing pass: always use full airflow.
    const double wantedRate = -command.commandedRateCPerMin > 0.0
                                  ? -command.commandedRateCPerMin
                                  : 0.0;
    const double fan = kActuatorMaximumFan;
    const double delivered =
        (fan / 10.0) * calibration.coolingFanCPerMinAt10 + passiveLoss;
    const double achievable = capacityScale *
        (delivered > kMinimumModelledCoolingCPerMin
             ? delivered
             : kMinimumModelledCoolingCPerMin);
    command.fan = fan;
    command.heat = 0.0;
    command.unconstrainedHeat = 0.0;
    command.heatSlewLimited = false;
    command.cooling = true;
    command.baselineRateCPerMin = command.requiredRateCPerMin;
    command.saturated = std::fabs(achievable - wantedRate) > 1.0;
    command.saturatedHigh = achievable > wantedRate + 1.0;
    command.saturatedLow = achievable < wantedRate - 1.0;
    return command;
  }

  const double rawAuthority = calibration.heaterGainCPerMinAt10;
  const double heaterAuthority = rawAuthority > 0.1 ? rawAuthority : 0.1;
  const double fanCooling = calibration.fanCoolingCPerMinAt10 > 0.1
                                ? calibration.fanCoolingCPerMinAt10
                                : 0.1;
  const double circulationFloor = journeyCirculationFloor(beanTempC);
  const double fanMin = zone.fanMin > circulationFloor ? zone.fanMin : circulationFloor;
  // The full-airflow floor may override an authored lower ceiling.
  const double fanMax = zone.fanMax > fanMin ? zone.fanMax : fanMin;

  // (1): the heat a given fan needs to produce a plant rate here.
  const auto heatFor = [&](double fan, double plantRate) {
    return (10.0 * (plantRate - kPlantBiasCPerMin +
                    (fan / 10.0) * calibration.fanCoolingCPerMinAt10 +
                    passiveLoss)) /
           heaterAuthority;
  };
  // (2): the fan at which a given heat produces a plant rate.
  const auto fanFor = [&](double heat, double plantRate) {
    return (10.0 * ((heat / 10.0) * heaterAuthority - plantRate +
                    kPlantBiasCPerMin - passiveLoss)) /
           fanCooling;
  };
  // (3): the plant rate a pair delivers - the model equation read forwards.
  const auto plantRateOf = [&](double fan, double heat) {
    return kPlantBiasCPerMin + (heat / 10.0) * heaterAuthority -
           (fan / 10.0) * calibration.fanCoolingCPerMinAt10 - passiveLoss;
  };

  // FEED-FORWARD BASELINE: the greatest airflow whose required Heat fits the
  // plan's own slope, the heat clamped into the band, and the heat-on Fan
  // floor folded back once so the pair is the one really driven.
  const double requiredPlantRate = command.requiredRateCPerMin / capacityScale;
  double baselineFan =
      clampValue(fanFor(zone.heatMax, requiredPlantRate), fanMin, fanMax);
  double baselineHeat = clampValue(heatFor(baselineFan, requiredPlantRate),
                                   zone.heatMin, zone.heatMax);
  const EffectiveLevels baselineFloored =
      effectiveLevels(baselineFan, baselineHeat);
  if (baselineFloored.fan != baselineFan) {
    baselineFan = baselineFloored.fan;
    baselineHeat = clampValue(heatFor(baselineFan, requiredPlantRate),
                              zone.heatMin, zone.heatMax);
  }
  const double baselinePlantRate = plantRateOf(baselineFan, baselineHeat);

  // CORRECTION ALLOCATION (4)/(5): Heat first, at the baseline Fan. Fan moves
  // only for the part of the correction Heat could not deliver - down for
  // more heating, up for more airflow.
  const double solvePlantRate = baselinePlantRate + correction / capacityScale;
  double fan = baselineFan;
  const double heatAtBaselineFan = heatFor(fan, solvePlantRate);
  if (heatAtBaselineFan > zone.heatMax + 1e-9) {
    fan = clampValue(fanFor(zone.heatMax, solvePlantRate), fanMin, baselineFan);
  } else if (heatAtBaselineFan < zone.heatMin - 1e-9) {
    fan = clampValue(fanFor(zone.heatMin, solvePlantRate), baselineFan, fanMax);
  }
  const double heat = heatFor(fan, solvePlantRate);

  // SATURATION describes the rate the plan and the feedback asked for, at the
  // fan finally chosen.
  const double requestedPlantRate = command.commandedRateCPerMin / capacityScale;
  const double heatingFloorRate = -5.0 * capacityScale;
  const bool floorLimited = command.commandedRateCPerMin < heatingFloorRate;
  const double heatForRequested = heatFor(fan, requestedPlantRate);
  bool saturatedHigh = heatForRequested > zone.heatMax + 1e-9;
  bool saturatedLow = floorLimited || heatForRequested < zone.heatMin - 1e-9;
  bool saturated = saturatedHigh || saturatedLow;

  double commandedHeat = clampValue(heat, zone.heatMin, zone.heatMax);
  double commandedFan = clampValue(fan, fanMin, fanMax);

  // The actuator floor, accounted for rather than discovered: fold the floored
  // fan back into (1) once - closed form, no iteration - and re-solve the heat
  // against the airflow that will actually be present.
  const EffectiveLevels floored = effectiveLevels(commandedFan, commandedHeat);
  if (floored.fan != commandedFan) {
    commandedFan = floored.fan;
    commandedHeat = clampValue(heatFor(commandedFan, solvePlantRate),
                               zone.heatMin, zone.heatMax);
    // The extra airflow can push the required heat past the band it was
    // inside a moment ago.
    if (heatFor(commandedFan, requestedPlantRate) > zone.heatMax) {
      saturated = true;
      saturatedHigh = true;
    }
  }

  command.fan = commandedFan;
  command.heat = commandedHeat;
  command.unconstrainedHeat = commandedHeat;
  command.heatSlewLimited = false;
  command.cooling = false;
  command.baselineRateCPerMin = baselinePlantRate * capacityScale;
  command.saturated = saturated;
  command.saturatedHigh = saturatedHigh;
  command.saturatedLow = saturatedLow;
  return command;
}

JourneyControlState initialJourneyControlState() {
  JourneyControlState state;
  state.integralRateCPerMin = 0.0;
  state.lastSampleSec = 0.0;
  state.hasLastSample = false;
  state.zoneIndex = 0;
  state.zoneEntrySec = 0.0;
  state.lastCommandHeat = 0.0;
  state.lastCommandSec = 0.0;
  state.hasLastCommand = false;
  state.rateHistoryCount = 0;
  return state;
}

JourneyStepResult journeyControlStep(const JourneyControlState& state,
                                     const JourneyStepInput& input) {
  JourneyStepResult result;
  const JourneyPlan& plan = input.plan;
  const double elapsedSec = input.elapsedSec;
  const double beanTempC = input.beanTempC;
  const bool measured = finite(beanTempC);
  const double startingIntegral = state.integralRateCPerMin;

  if (plan.zones == nullptr || plan.zoneCount == 0) {
    result.state = state;
    return result;
  }

  /*
   * Zone advancement happens FIRST, and it happens on the MEASUREMENT. A blind
   * step cannot observe an arrival, so the anchor stays exactly where it was -
   * the same holdover rule the integral follows, for the same reason. The loop
   * (rather than a single test) is for an overshoot that genuinely clears
   * several endpoints at once; it terminates because entering a zone resets its
   * elapsed time to zero, so a hold zone can never clear in the step it entered.
   */
  size_t zoneIndex = state.zoneIndex;
  double zoneEntrySec = state.zoneEntrySec;
  if (measured) {
    while (zoneIndex + 1 < plan.zoneCount &&
           zoneCompleted(plan.zones[zoneIndex], beanTempC,
                         elapsedSec - zoneEntrySec)) {
      zoneIndex += 1;
      zoneEntrySec = elapsedSec;
    }
  }
  const bool zoneAdvanced = zoneIndex != state.zoneIndex;

  const size_t anchoredIndex =
      zoneIndex < plan.zoneCount ? zoneIndex : plan.zoneCount - 1;
  const JourneyZone& zone = plan.zones[anchoredIndex];
  const double goalC = zoneTargetC(zone, elapsedSec - zoneEntrySec);
  const bool completedNow =
      measured && zoneCompleted(zone, beanTempC, elapsedSec - zoneEntrySec);

  const auto solve = [&](double rateCorrection, double temperatureC) {
    return journeyCommand(plan, elapsedSec, temperatureC, input.ambientC,
                          input.batchMassG, input.calibration, rateCorrection,
                          zoneIndex, zoneEntrySec);
  };

  // The model's own answer, always computed, always recorded: it is the
  // baseline the correction is the residual against, so it is solved at the
  // same temperature the applied command is.
  const double modelTemperatureC = measured ? beanTempC : goalC;
  const JourneyCommand feedForward = solve(0.0, modelTemperatureC);
  const auto applySlew = [&](const JourneyCommand& unconstrained) {
    return slewLimitedJourneyCommand(state, elapsedSec, zone, unconstrained);
  };

  result.zoneIndex = zoneIndex;
  result.zoneEntrySec = zoneEntrySec;
  result.zoneAdvanced = zoneAdvanced;
  result.zoneCompleted = completedNow;
  result.feedForward = feedForward;

  if (!measured) {
    // A missing measurement is a HOLDOVER, not a zero: no error to act on, so
    // the correction is dropped, the integral frozen exactly as it was, the
    // rate history left untouched, and the inversion solved against the
    // PLAN's own temperature.
    result.state.integralRateCPerMin = startingIntegral;
    result.state.lastSampleSec = state.lastSampleSec;
    result.state.hasLastSample = state.hasLastSample;
    result.state.zoneIndex = zoneIndex;
    result.state.zoneEntrySec = zoneEntrySec;
    for (size_t index = 0; index < state.rateHistoryCount; ++index) {
      result.state.rateHistory[index] = state.rateHistory[index];
    }
    result.state.rateHistoryCount = state.rateHistoryCount;
    result.command = applySlew(feedForward);
    result.state.lastCommandHeat = result.command.heat;
    result.state.lastCommandSec = elapsedSec;
    result.state.hasLastCommand = true;
    result.correction.errorC = 0.0;
    result.correction.proportionalRatePerMin = 0.0;
    result.correction.integralRatePerMin = startingIntegral;
    result.correction.totalRatePerMin = 0.0;
    result.correction.saturated = false;
    result.correction.holdover = true;
    return result;
  }

  const double errorC = goalC - beanTempC;
  const double proportionalRatePerMin = kTrackingKpRatePerC * errorC;

  // `dt` from the samples. A first step, a step backwards in time, and a step
  // across a gap the control did not observe all integrate nothing.
  const double rawDtSec =
      state.hasLastSample ? elapsedSec - state.lastSampleSec : 0.0;
  const bool observed = rawDtSec > 0.0 && rawDtSec <= kStaleSampleGapSec;
  const double dtSec =
      observed ? (rawDtSec < kMaxIntegrationStepSec ? rawDtSec
                                                    : kMaxIntegrationStepSec)
               : 0.0;
  // A cooling zone commands Fan 10 / Heat 0 whatever the correction says, so
  // the integral has nothing to act on there and is held as it entered.
  const bool mayIntegrate =
      elapsedSec >= kIntegralHoldoffSec && dtSec > 0.0 && !feedForward.cooling;

  const double integralTime = kTrackingIntegralTimeSec > 1.0
                                  ? kTrackingIntegralTimeSec
                                  : 1.0;
  const double integralGainPerSec = kTrackingKpRatePerC / integralTime;
  const double advancedIntegral =
      mayIntegrate
          ? clampIntegral(startingIntegral + integralGainPerSec * errorC * dtSec)
          : startingIntegral;
  const double integralDelta = advancedIntegral - startingIntegral;

  // The rate history survives only across a continuous stretch of samples: a
  // stale gap or a clock that went backwards means the trend across it was
  // never observed, so it is not pretended.
  const bool continuous =
      !state.hasLastSample ||
      (rawDtSec >= 0.0 && rawDtSec <= kStaleSampleGapSec);
  RateSample history[kRateHistoryCapacity];
  size_t historyCount = 0;
  if (continuous) {
    for (size_t index = 0; index < state.rateHistoryCount; ++index) {
      history[index] = state.rateHistory[index];
    }
    historyCount = state.rateHistoryCount;
  }
  RateSample now;
  now.sec = elapsedSec;
  now.tempC = beanTempC;
  const RateEstimate estimate = predictedRate(history, historyCount, now);
  RateFeedback rate;
  if (estimate.available) {
    const double rateErrorCPerMin =
        feedForward.requiredRateCPerMin - estimate.predictedCPerMin;
    rate.measuredRateCPerMin = estimate.measuredCPerMin;
    rate.predictedRateCPerMin = estimate.predictedCPerMin;
    rate.rateErrorCPerMin = rateErrorCPerMin;
    rate.rateRatePerMin = kTrackingRateGain * rateErrorCPerMin;
  }
  appendRateSample(history, historyCount, now);

  // A correction is "blocked" when the plant cannot move any further the way
  // the correction is pushing. The clamp binding counts.
  const auto blocked = [&](double rateCPerMin, const JourneyCommand& solved) {
    if (rateCPerMin > 0.0 &&
        (solved.saturatedHigh || rateCPerMin >= kMaxCorrectionCPerMin)) {
      return true;
    }
    return rateCPerMin < 0.0 &&
           (solved.saturatedLow ||
            rateCPerMin <= -kMaxCoolingCorrectionCPerMin);
  };
  const auto totalWith = [&](double integral) {
    return clampCorrection(proportionalRatePerMin + rate.rateRatePerMin +
                           integral);
  };

  double integralRatePerMin = advancedIntegral;
  double totalRatePerMin = totalWith(integralRatePerMin);
  JourneyCommand command = applySlew(solve(totalRatePerMin, beanTempC));
  const bool integrationBlocked = blocked(totalRatePerMin, command);
  // Slew is transient shaping, not evidence that the calibrated plant is
  // infeasible. It blocks integration without polluting residual saturation.
  const bool saturated = integrationBlocked &&
      (!command.heatSlewLimited || command.saturated ||
       correctionAtBound(totalRatePerMin));

  // Exact Math.sign parity with the TypeScript oracle: at totalRatePerMin == 0 the TS
  // comparison is false for any non-zero delta, so the zero case must not collapse into
  // the negative case the way (a > 0) == (b > 0) would.
  const auto signOf = [](double value) { return (value > 0.0) - (value < 0.0); };
  const bool accumulationPushesIntoBlock =
      integrationBlocked && integralDelta != 0.0 &&
      signOf(integralDelta) == signOf(totalRatePerMin);

  if (accumulationPushesIntoBlock) {
    // Conditional integration freezes only accumulation that pushes farther
    // into the bound. An opposing delta must be retained so an integral pinned
    // at either limit can unwind while the command is still saturated.
    integralRatePerMin = startingIntegral;
    totalRatePerMin = totalWith(integralRatePerMin);
    command = applySlew(solve(totalRatePerMin, beanTempC));
  }

  result.state.integralRateCPerMin = integralRatePerMin;
  result.state.lastSampleSec = elapsedSec;
  result.state.hasLastSample = true;
  result.state.zoneIndex = zoneIndex;
  result.state.zoneEntrySec = zoneEntrySec;
  result.state.lastCommandHeat = command.heat;
  result.state.lastCommandSec = elapsedSec;
  result.state.hasLastCommand = true;
  for (size_t index = 0; index < historyCount; ++index) {
    result.state.rateHistory[index] = history[index];
  }
  result.state.rateHistoryCount = historyCount;
  result.command = command;
  result.correction.errorC = errorC;
  result.correction.proportionalRatePerMin = proportionalRatePerMin;
  result.correction.integralRatePerMin = integralRatePerMin;
  result.correction.totalRatePerMin = totalRatePerMin;
  result.correction.saturated = saturated;
  result.correction.holdover = false;
  result.rate = rate;
  return result;
}

double modelledSteadyStateC(double fan, double heat, double batchMassG,
                            double ambientC,
                            const JourneyCalibration& calibration) {
  (void)batchMassG;  // Thermal capacity changes time-to-target, not equilibrium.
  const double heating = (heat / 10.0) * calibration.heaterGainCPerMinAt10;
  const double airflow = (fan / 10.0) * calibration.fanCoolingCPerMinAt10;
  if (calibration.thermalLossPerMinPerC <= 0.0) return HUGE_VAL;
  return ambientC + (kPlantBiasCPerMin + heating - airflow) /
                        calibration.thermalLossPerMinPerC;
}

}  // namespace sr800
