#pragma once

#include <math.h>
#include <stddef.h>

// Temperature-journey control law, ported line for line from the browser's
// `web/src/domain/journeyControl.ts`. This is the layer ABOVE the frozen
// actuator: it decides WHAT Fan and Heat a roast should be run at; it never
// touches an output, a lease, or a pin.
//
// The module is deliberately free of Arduino, ESP-IDF and FreeRTOS types so the
// host test suite can compile it under MSVC and replay the cross-language
// vectors generated from the TypeScript original
// (`firmware/crackle/tests/vectors/journey_control_vectors.json`). The vector is
// the contract: if the two ever disagree, the PORT is wrong.
//
// The derivation itself is documented at length in the TypeScript file and is
// not repeated here; what IS repeated is every constant, every clamp order and
// every saturation rule, because those are what the vectors pin down.
//
//     dT/dt (C/min) = massFactor x
//                       (4 + (heat/10) x heaterGain
//                        - (fan/10) x fanCooling - loss x (T - ambient))
//
// Everything below is a closed-form solve of that equation, plus a feedback
// loop that corrects the WANTED RATE (not the heat directly) - proportional
// and integral on position error, plus a lag-compensated rate term - and is
// handed back through the same inversion, Heat first and Fan only for what
// Heat cannot deliver, so airflow (and bed circulation) is spent last.

namespace sr800 {

/** PI gains, in C/min of wanted rate per C of tracking error. */
constexpr double kTrackingKpRatePerC = 3.0;
constexpr double kTrackingIntegralTimeSec = 45.0;

/**
 * Rate feedback: derivative time Td = the ~10 s measured onset lag, and
 * the rate gain Kp x Td per minute (0.5 C/min of correction per C/min of
 * predicted rate error).
 */
constexpr double kTrackingDerivativeTimeSec = 10.0;
constexpr double kTrackingRateGain =
    kTrackingKpRatePerC * kTrackingDerivativeTimeSec / 60.0;
/** The trailing RoR window, the lead horizon, and the lead's clamp. */
constexpr double kRateWindowSec = 10.0;
constexpr double kRateLeadSec = 10.0;
constexpr double kMaxRateLeadCPerMin = 10.0;
/** Sample history kept for the rate estimate: by age, and by fixed capacity. */
constexpr double kRateHistorySec = 30.0;
constexpr size_t kRateHistoryCapacity = 32;

/**
 * Authority bounds on the correction, in C/min. Asymmetric: +15 heating,
 * -12 cooling (the largest bound lagged replays of recorded roasts showed no
 * need to exceed and the smallest that still holds a 20%-pessimistic heater
 * model).
 * The integral is clamped harder, at 8 in both directions.
 */
constexpr double kMaxCorrectionCPerMin = 15.0;
constexpr double kMaxIntegralCPerMin = 8.0;
constexpr double kMaxCoolingCorrectionCPerMin = 12.0;
constexpr double kMaxCoolingIntegralCPerMin = 8.0;

/** Integration guards, in seconds. */
constexpr double kMaxIntegrationStepSec = 5.0;
constexpr double kStaleSampleGapSec = 15.0;

/** Journey-only Heat movement bound; delayed ticks never bank a larger jump. */
constexpr double kMaxHeatSlewPerSec = 0.25;
constexpr double kMaxHeatSlewStepSec = 1.0;

/**
 * Dense green coffee gets full airflow through 130 C. Above that there is no
 * Journey-specific floor at all: the zone's own fanMin and the universal
 * heat-on Fan 1.0 command rule are the only constraints. Fan follows the
 * solve immediately at every tick, with no mass-scaled floor and no
 * gradual-reduction rate limit.
 */
constexpr double kFullAirflowUntilC = 130.0;

/** The integral does not start with the roast; charge is a transient. */
constexpr double kIntegralHoldoffSec = 20.0;

/** The plant's fixed bias term and its cooling floor, both from `thermalStep`. */
constexpr double kPlantBiasCPerMin = 4.0;
constexpr double kMinimumModelledCoolingCPerMin = 8.0;

/** A zone with no temperature to attain: `endC == startC` within this band. */
constexpr double kZoneHoldEpsilonC = 0.5;

/**
 * Command-layer level normalization. A nonzero fan-only request is lifted to
 * public level 0.1, and Heat on means Fan 1.0 or higher on every command
 * path. The audited actuator core does not carry this rule: its own
 * 0.1-with-heat qualification remains the deeper backstop.
 */
constexpr double kActuatorMinimumFan = 0.1;
constexpr double kHeatOnMinimumFan = 1.0;
constexpr double kActuatorMaximumFan = 10.0;

/** The largest journey the firmware will accept, and the archive header's bound. */
constexpr size_t kMaxJourneyZones = 12;

/** One authored zone. Times in seconds, temperatures in C, levels 0..10. */
struct JourneyZone {
  double startC = 0.0;
  double endC = 0.0;
  double durationSec = 0.0;
  double fanMin = 0.0;
  double fanMax = 0.0;
  double heatMin = 0.0;
  double heatMax = 0.0;
};

/** The four thermal coefficients the inversion needs, plus their reference mass. */
struct JourneyCalibration {
  double heaterGainCPerMinAt10 = 0.0;
  double fanCoolingCPerMinAt10 = 0.0;
  double coolingFanCPerMinAt10 = 0.0;
  double thermalLossPerMinPerC = 0.0;
  double referenceBatchMassG = 225.0;
};

/** The zones themselves. Addressed by INDEX; the clock never selects a zone. */
struct JourneyPlan {
  const JourneyZone* zones = nullptr;
  size_t zoneCount = 0;
};

/** What one closed-form solve produced. */
struct JourneyCommand {
  double fan = 0.0;
  /** Heat actually handed to the actuator after journey-only slew limiting. */
  double heat = 0.0;
  /** Closed-form answer before slew limiting, retained for diagnostics. */
  double unconstrainedHeat = 0.0;
  bool heatSlewLimited = false;
  bool cooling = false;
  size_t zoneIndex = 0;
  double zoneEntrySec = 0.0;
  /** The nominal ramp is spent and the target is HOLDING at the endpoint. */
  bool holdingAtZoneEnd = false;
  double goalC = 0.0;
  double requiredRateCPerMin = 0.0;
  /**
   * The rate the feed-forward baseline pair delivers in the model. Equal to
   * `requiredRateCPerMin` unless the band clamped feed-forward; it is the base
   * every correction moves the actuators from.
   */
  double baselineRateCPerMin = 0.0;
  double commandedRateCPerMin = 0.0;
  /** The zone's own limits stopped the derivation reaching the rate it asked for. */
  bool saturated = false;
  /** No more rate of RISE is available. */
  bool saturatedHigh = false;
  /** No LESS rate of rise is available. */
  bool saturatedLow = false;
};

/** One measured sample the rate estimate keeps: when, and what the probe read. */
struct RateSample {
  double sec = 0.0;
  double tempC = 0.0;
};

/** The trailing-window RoR and its one-lag-ahead prediction. */
struct RateEstimate {
  /** `undefined` in the TypeScript: not yet one window of history. */
  bool available = false;
  double measuredCPerMin = 0.0;
  double leadCPerMin = 0.0;
  double predictedCPerMin = 0.0;
};

/** The feedback layer's entire memory; the caller owns and threads it. */
struct JourneyControlState {
  double integralRateCPerMin = 0.0;
  double lastSampleSec = 0.0;
  /** `lastSampleSec === undefined` in the TypeScript: no sample has run yet. */
  bool hasLastSample = false;
  size_t zoneIndex = 0;
  double zoneEntrySec = 0.0;
  double lastCommandHeat = 0.0;
  double lastCommandSec = 0.0;
  bool hasLastCommand = false;
  /** The measured samples the rate estimate reads over, oldest first. */
  RateSample rateHistory[kRateHistoryCapacity];
  size_t rateHistoryCount = 0;
};

/** What the PI had to do, recorded so the post-roast refit can consume it. */
struct ControlCorrection {
  double errorC = 0.0;
  double proportionalRatePerMin = 0.0;
  double integralRatePerMin = 0.0;
  double totalRatePerMin = 0.0;
  bool saturated = false;
  bool holdover = false;
};

/** What the rate feedback saw and did; NaN rates mean not enough history yet. */
struct RateFeedback {
  double measuredRateCPerMin = NAN;
  double predictedRateCPerMin = NAN;
  double rateErrorCPerMin = 0.0;
  double rateRatePerMin = 0.0;
};

struct JourneyStepInput {
  JourneyPlan plan;
  double elapsedSec = 0.0;
  /** Non-finite means the reading is missing; see the holdover rule. */
  double beanTempC = 0.0;
  double ambientC = 0.0;
  double batchMassG = 225.0;
  JourneyCalibration calibration;
};

struct JourneyStepResult {
  /** The state to thread into the next step. The input state is never mutated. */
  JourneyControlState state;
  /** What was actually commanded: feed-forward plus the correction. */
  JourneyCommand command;
  /** What the model ALONE would have said. */
  JourneyCommand feedForward;
  ControlCorrection correction;
  RateFeedback rate;
  size_t zoneIndex = 0;
  double zoneEntrySec = 0.0;
  /** True when THIS step is the one that attained the previous zone's endpoint. */
  bool zoneAdvanced = false;
  /** Whether the zone this step ran in has now been attained. */
  bool zoneCompleted = false;
};

/** The firmware's level normalization, mirrored for the fold-back. */
double normalizeFanLevel(double fan);
double minimumFanForHeat(double heat);

/** The asymmetric authority clamps and the direction-aware bound test. */
double clampCorrection(double rateCPerMin);
double clampIntegral(double rateCPerMin);
bool correctionAtBound(double rateCPerMin);

/** Direction-aware: a rising zone arrives from below, a cooling zone from above. */
bool zoneAttained(const JourneyZone& zone, double temperatureC);

/** Attainment, except for a hold zone, which is the one case a clock decides. */
bool zoneCompleted(const JourneyZone& zone, double temperatureC,
                   double zoneElapsedSec);

/** The zone's own nominal ramp from entry, capped at (held at) its endpoint. */
double zoneTargetC(const JourneyZone& zone, double zoneElapsedSec);
/** Full airflow through 130 C; no Journey-specific floor above it. */
double journeyCirculationFloor(double beanTempC);

/** (6)/(7) of the TypeScript: trailing RoR and its lead-ahead prediction. */
RateEstimate predictedRate(const RateSample* history, size_t count,
                           const RateSample& now);
/** The history after one more sample: age-trimmed, capacity-bounded, no repeats. */
void appendRateSample(RateSample* history, size_t& count,
                      const RateSample& sample);

/** One feed-forward solve at an explicit anchor. Feedback lives in the step. */
JourneyCommand journeyCommand(const JourneyPlan& plan, double elapsedSec,
                              double beanTempC, double ambientC,
                              double batchMassG,
                              const JourneyCalibration& calibration,
                              double rateCorrectionCPerMin,
                              size_t anchorZoneIndex,
                              double anchorZoneEntrySec);

/** A roast starts in zone 0 at time zero with no accumulated correction. */
JourneyControlState initialJourneyControlState();

/** One closed-loop control step: inversion, PI + rate feedback, conditional integration. */
JourneyStepResult journeyControlStep(const JourneyControlState& state,
                                     const JourneyStepInput& input);

/** The steady state a pair holds at; the honest way to explain a saturated zone. */
double modelledSteadyStateC(double fan, double heat, double batchMassG,
                            double ambientC,
                            const JourneyCalibration& calibration);

}  // namespace sr800
