// Cross-language verification of the firmware's journey control law.
//
// `sr800_journey_control.cpp` is a hand port of `web/src/domain/journeyControl.ts`. Two
// implementations of the same twenty-minute control law drift silently unless something forces them
// to agree, so the browser is made the ORACLE: `web/scripts/generate-journey-vectors.ts` drives the
// real TypeScript `journeyControlStep` through twelve required scenarios and
// records every input and every
// output, second by second, into `vectors/journey_control_vectors.json`. This test replays all of
// them through the C++ port and requires agreement to 1e-4 on every field of every step.
//
// If this test fails, the PORT is wrong. Regenerating the vector to make it pass converts the
// guarantee into a rubber stamp.
//
// The second half of the file ports the zone-gating behaviours from `journeyControl.zones.test.ts`
// and the integration guards from `journeyControl.pi.test.ts` directly as C++ assertions, because
// those pin down single points that a long replay can pass over.
//
// Build and run from firmware/crackle/tests: `bash run-native-tests.sh` (all suites), or see the
// firmware README for a single-suite command. It reads `vectors/` relative to that directory.
\

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#include "sr800_journey_control.h"

namespace {

int failures = 0;

void require(bool condition, const std::string& message) {
  if (!condition) {
    std::cerr << "FAIL: " << message << '\n';
    failures += 1;
  }
}

void requireClose(double actual, double expected, double tolerance,
                  const std::string& message) {
  const bool actualNan = std::isnan(actual);
  const bool expectedNan = std::isnan(expected);
  if (actualNan || expectedNan) {
    require(actualNan && expectedNan, message + " (NaN mismatch)");
    return;
  }
  if (std::fabs(actual - expected) > tolerance) {
    std::ostringstream detail;
    detail.precision(12);
    detail << message << ": got " << actual << ", expected " << expected
           << " (delta " << std::fabs(actual - expected) << ")";
    require(false, detail.str());
  }
}

// ---------------------------------------------------------------------------
// A minimal JSON reader. Just enough for the vector file: objects, arrays,
// numbers, strings, booleans and null. `null` becomes NaN, which is exactly how
// a dropped thermocouple sample is encoded.
// ---------------------------------------------------------------------------

struct JsonValue;
using JsonPtr = std::shared_ptr<JsonValue>;

struct JsonValue {
  enum class Kind { NUL, BOOL, NUMBER, STRING, ARRAY, OBJECT } kind = Kind::NUL;
  bool boolean = false;
  double number = 0.0;
  std::string text;
  std::vector<JsonPtr> items;
  std::map<std::string, JsonPtr> members;
};

class JsonParser {
 public:
  explicit JsonParser(const std::string& source) : source_(source) {}

  JsonPtr parse() {
    skipWhitespace();
    JsonPtr value = parseValue();
    skipWhitespace();
    return value;
  }

  bool ok() const { return ok_; }
  const std::string& error() const { return error_; }

 private:
  void fail(const std::string& reason) {
    if (ok_) {
      ok_ = false;
      error_ = reason + " at offset " + std::to_string(position_);
    }
  }

  void skipWhitespace() {
    while (position_ < source_.size()) {
      const char c = source_[position_];
      if (c == ' ' || c == '\t' || c == '\n' || c == '\r') position_ += 1;
      else break;
    }
  }

  bool consume(char expected) {
    if (position_ < source_.size() && source_[position_] == expected) {
      position_ += 1;
      return true;
    }
    return false;
  }

  bool literal(const char* word) {
    const size_t length = std::string(word).size();
    if (source_.compare(position_, length, word) != 0) return false;
    position_ += length;
    return true;
  }

  JsonPtr parseValue() {
    if (!ok_ || position_ >= source_.size()) {
      fail("unexpected end of input");
      return std::make_shared<JsonValue>();
    }
    const char c = source_[position_];
    if (c == '{') return parseObject();
    if (c == '[') return parseArray();
    if (c == '"') return parseString();
    if (literal("true")) {
      auto value = std::make_shared<JsonValue>();
      value->kind = JsonValue::Kind::BOOL;
      value->boolean = true;
      return value;
    }
    if (literal("false")) {
      auto value = std::make_shared<JsonValue>();
      value->kind = JsonValue::Kind::BOOL;
      value->boolean = false;
      return value;
    }
    if (literal("null")) {
      auto value = std::make_shared<JsonValue>();
      value->kind = JsonValue::Kind::NUMBER;
      value->number = std::nan("");
      return value;
    }
    return parseNumber();
  }

  JsonPtr parseNumber() {
    const size_t start = position_;
    if (position_ < source_.size() &&
        (source_[position_] == '-' || source_[position_] == '+')) {
      position_ += 1;
    }
    while (position_ < source_.size()) {
      const char c = source_[position_];
      const bool numeric = (c >= '0' && c <= '9') || c == '.' || c == 'e' ||
                           c == 'E' || c == '+' || c == '-';
      if (!numeric) break;
      position_ += 1;
    }
    if (position_ == start) {
      fail("expected a value");
      return std::make_shared<JsonValue>();
    }
    auto value = std::make_shared<JsonValue>();
    value->kind = JsonValue::Kind::NUMBER;
    value->number = std::strtod(source_.substr(start, position_ - start).c_str(),
                                nullptr);
    return value;
  }

  JsonPtr parseString() {
    auto value = std::make_shared<JsonValue>();
    value->kind = JsonValue::Kind::STRING;
    if (!consume('"')) {
      fail("expected a string");
      return value;
    }
    std::string out;
    while (position_ < source_.size()) {
      const char c = source_[position_++];
      if (c == '"') {
        value->text = out;
        return value;
      }
      if (c != '\\') {
        out.push_back(c);
        continue;
      }
      if (position_ >= source_.size()) break;
      const char escape = source_[position_++];
      switch (escape) {
        case 'n': out.push_back('\n'); break;
        case 't': out.push_back('\t'); break;
        case 'r': out.push_back('\r'); break;
        case 'b': out.push_back('\b'); break;
        case 'f': out.push_back('\f'); break;
        case 'u': {
          // The vector file is ASCII; keep the escape readable rather than
          // pretending to decode UTF-16 surrogate pairs.
          if (position_ + 4 <= source_.size()) position_ += 4;
          out.push_back('?');
          break;
        }
        default: out.push_back(escape); break;
      }
    }
    fail("unterminated string");
    return value;
  }

  JsonPtr parseArray() {
    auto value = std::make_shared<JsonValue>();
    value->kind = JsonValue::Kind::ARRAY;
    consume('[');
    skipWhitespace();
    if (consume(']')) return value;
    while (ok_) {
      skipWhitespace();
      value->items.push_back(parseValue());
      skipWhitespace();
      if (consume(',')) continue;
      if (consume(']')) break;
      fail("expected ',' or ']'");
      break;
    }
    return value;
  }

  JsonPtr parseObject() {
    auto value = std::make_shared<JsonValue>();
    value->kind = JsonValue::Kind::OBJECT;
    consume('{');
    skipWhitespace();
    if (consume('}')) return value;
    while (ok_) {
      skipWhitespace();
      JsonPtr key = parseString();
      skipWhitespace();
      if (!consume(':')) {
        fail("expected ':'");
        break;
      }
      skipWhitespace();
      value->members[key->text] = parseValue();
      skipWhitespace();
      if (consume(',')) continue;
      if (consume('}')) break;
      fail("expected ',' or '}'");
      break;
    }
    return value;
  }

  const std::string& source_;
  size_t position_ = 0;
  bool ok_ = true;
  std::string error_;
};

JsonPtr member(const JsonPtr& object, const std::string& name) {
  if (object == nullptr || object->kind != JsonValue::Kind::OBJECT) {
    return nullptr;
  }
  const auto found = object->members.find(name);
  return found == object->members.end() ? nullptr : found->second;
}

double numberAt(const JsonPtr& object, const std::string& name) {
  const JsonPtr value = member(object, name);
  return value == nullptr ? 0.0 : value->number;
}

// ---------------------------------------------------------------------------
// The replay.
// ---------------------------------------------------------------------------

constexpr double kTolerance = 1e-4;

double worstDeviation = 0.0;
std::string worstField;

void compare(double actual, double expected, const std::string& label) {
  if (std::isnan(actual) || std::isnan(expected)) {
    require(std::isnan(actual) && std::isnan(expected), label + " NaN mismatch");
    return;
  }
  const double delta = std::fabs(actual - expected);
  if (delta > worstDeviation) {
    worstDeviation = delta;
    worstField = label;
  }
  requireClose(actual, expected, kTolerance, label);
}

std::vector<sr800::JourneyZone> readZones(const JsonPtr& zonesJson) {
  std::vector<sr800::JourneyZone> zones;
  if (zonesJson == nullptr || zonesJson->kind != JsonValue::Kind::ARRAY) {
    return zones;
  }
  for (const JsonPtr& entry : zonesJson->items) {
    sr800::JourneyZone zone;
    zone.startC = numberAt(entry, "startC");
    zone.endC = numberAt(entry, "endC");
    zone.durationSec = numberAt(entry, "durationSec");
    zone.fanMin = numberAt(entry, "fanMin");
    zone.fanMax = numberAt(entry, "fanMax");
    zone.heatMin = numberAt(entry, "heatMin");
    zone.heatMax = numberAt(entry, "heatMax");
    zones.push_back(zone);
  }
  return zones;
}

int replayScenario(const JsonPtr& scenario,
                   const std::map<std::string, size_t>& column) {
  const std::string name = member(scenario, "name")->text;
  const double ambientC = numberAt(scenario, "ambientC");
  const double batchMassG = numberAt(scenario, "batchMassG");

  const JsonPtr calibrationJson = member(scenario, "calibration");
  sr800::JourneyCalibration calibration;
  calibration.heaterGainCPerMinAt10 =
      numberAt(calibrationJson, "heaterGainCPerMinAt10");
  calibration.fanCoolingCPerMinAt10 =
      numberAt(calibrationJson, "fanCoolingCPerMinAt10");
  calibration.coolingFanCPerMinAt10 =
      numberAt(calibrationJson, "coolingFanCPerMinAt10");
  calibration.thermalLossPerMinPerC =
      numberAt(calibrationJson, "thermalLossPerMinPerC");
  calibration.referenceBatchMassG =
      numberAt(calibrationJson, "referenceBatchMassG");

  const JsonPtr zonesJson = member(scenario, "zones");
  std::vector<sr800::JourneyZone> zones = readZones(zonesJson);

  sr800::JourneyPlan plan;
  plan.zones = zones.data();
  plan.zoneCount = zones.size();

  sr800::JourneyControlState state = sr800::initialJourneyControlState();
  const JsonPtr steps = member(scenario, "steps");
  const JsonPtr planPatches = member(scenario, "planPatches");
  size_t patchIndex = 0;
  int stepCount = 0;

  for (const JsonPtr& row : steps->items) {
    const auto value = [&](const char* field) {
      return row->items[column.at(field)]->number;
    };
    while (planPatches != nullptr &&
           patchIndex < planPatches->items.size() &&
           numberAt(planPatches->items[patchIndex], "elapsedSec") <=
               value("elapsedSec")) {
      zones = readZones(member(planPatches->items[patchIndex], "zones"));
      plan.zones = zones.data();
      plan.zoneCount = zones.size();
      patchIndex += 1;
    }
    const std::string where =
        name + " step " + std::to_string(stepCount) + " (t=" +
        std::to_string(static_cast<long>(value("elapsedSec"))) + "s)";

    sr800::JourneyStepInput input;
    input.plan = plan;
    input.elapsedSec = value("elapsedSec");
    input.beanTempC = value("beanTempC");
    input.ambientC = ambientC;
    input.batchMassG = batchMassG;
    input.calibration = calibration;

    const sr800::JourneyStepResult result =
        sr800::journeyControlStep(state, input);
    state = result.state;

    compare(result.command.fan, value("fan"), where + " fan");
    compare(result.command.heat, value("heat"), where + " heat");
    compare(result.command.unconstrainedHeat, value("unconstrainedHeat"),
            where + " unconstrained heat");
    compare(result.command.goalC, value("targetC"), where + " targetC");
    compare(result.correction.integralRatePerMin, value("integral"),
            where + " integral");
    compare(result.correction.totalRatePerMin, value("total"),
            where + " total correction");
    compare(static_cast<double>(result.zoneIndex), value("zoneIndex"),
            where + " zoneIndex");
    compare(result.zoneEntrySec, value("zoneEntrySec"), where + " zoneEntrySec");
    compare(result.correction.errorC, value("errorC"), where + " errorC");
    compare(result.correction.proportionalRatePerMin, value("proportional"),
            where + " proportional");
    compare(result.command.requiredRateCPerMin, value("requiredRate"),
            where + " requiredRate");
    compare(result.command.commandedRateCPerMin, value("commandedRate"),
            where + " commandedRate");
    compare(result.feedForward.fan, value("feedForwardFan"),
            where + " feedForward fan");
    compare(result.feedForward.heat, value("feedForwardHeat"),
            where + " feedForward heat");
    compare(result.command.baselineRateCPerMin, value("baselineRate"),
            where + " baselineRate");
    // A rate the oracle could not estimate is `null` in the vector and NaN
    // here; `compare` requires NaN on both sides.
    compare(result.rate.measuredRateCPerMin, value("measuredRate"),
            where + " measuredRate");
    compare(result.rate.predictedRateCPerMin, value("predictedRate"),
            where + " predictedRate");
    compare(result.rate.rateRatePerMin, value("rateTerm"),
            where + " rateTerm");

    const auto flag = [&](bool actual, const char* field) {
      const bool expected = value(field) != 0.0;
      require(actual == expected,
              where + " " + field + ": got " + (actual ? "true" : "false") +
                  ", expected " + (expected ? "true" : "false"));
    };
    flag(result.command.cooling, "cooling");
    flag(result.correction.saturated, "saturated");
    flag(result.correction.holdover, "holdover");
    flag(result.command.saturatedHigh, "saturatedHigh");
    flag(result.command.saturatedLow, "saturatedLow");
    flag(result.command.heatSlewLimited, "heatSlewLimited");
    flag(result.command.holdingAtZoneEnd, "holdingAtZoneEnd");
    flag(result.zoneAdvanced, "zoneAdvanced");
    flag(result.zoneCompleted, "zoneCompleted");

    stepCount += 1;
    if (failures > 20) {
      std::cerr << "(too many failures; stopping the replay)\n";
      return stepCount;
    }
  }
  if (planPatches != nullptr) {
    require(patchIndex == planPatches->items.size(),
            name + " did not replay every declared plan patch");
  }
  return stepCount;
}

// ---------------------------------------------------------------------------
// Behaviours ported directly from the TypeScript suites.
// ---------------------------------------------------------------------------

sr800::JourneyCalibration defaultCalibration() {
  sr800::JourneyCalibration calibration;
  calibration.heaterGainCPerMinAt10 = 66.0;
  calibration.fanCoolingCPerMinAt10 = 19.0;
  calibration.coolingFanCPerMinAt10 = 28.0;
  calibration.thermalLossPerMinPerC = 0.17;
  calibration.referenceBatchMassG = 225.0;
  return calibration;
}

void zoneGatingTests() {
  // journeyControl.zones.test.ts: "attainment is direction-aware".
  const sr800::JourneyZone rising = {25, 150, 210, 4, 9, 3, 9};
  const sr800::JourneyZone cooling = {210, 40, 180, 3, 10, 0, 0};

  require(!sr800::zoneAttained(rising, 149.9),
          "a rising zone is not attained just short of its endpoint");
  require(sr800::zoneAttained(rising, 150.0),
          "a rising zone is attained at its endpoint");
  require(!sr800::zoneAttained(cooling, 40.1),
          "a cooling zone is not attained just above its endpoint");
  require(sr800::zoneAttained(cooling, 40.0),
          "a cooling zone is attained at its endpoint");
  require(!sr800::zoneAttained(cooling, 300.0),
          "a cooling zone is emphatically NOT attained by being hot");
  require(!sr800::zoneAttained(rising, std::nan("")),
          "a missing measurement attains nothing");

  // "lets a hold zone - which has no temperature to attain - be decided by its duration".
  const sr800::JourneyZone hold = {180, 180, 90, 4, 9, 1, 9};
  require(std::fabs(hold.endC - hold.startC) < sr800::kZoneHoldEpsilonC,
          "the hold zone under test really is a hold");
  require(!sr800::zoneCompleted(hold, 180.0, 89.0),
          "a hold zone is not complete before its nominal duration");
  require(!sr800::zoneCompleted(hold, 500.0, 89.0),
          "a hold zone ignores temperature entirely");
  require(sr800::zoneCompleted(hold, 180.0, 90.0),
          "a hold zone completes on its nominal duration");
  const sr800::JourneyZone epsilonHold = {180, 179.5, 90, 4, 9, 1, 9};
  require(!sr800::zoneCompleted(epsilonHold, 500.0, 89.0),
          "an exact-epsilon descent remains a timed maintenance hold");
  require(sr800::zoneCompleted(epsilonHold, 500.0, 90.0),
          "an exact-epsilon hold completes on duration");
  require(!sr800::zoneCompleted(rising, 149.9, 100000.0),
          "a real climb ignores the clock, however long it runs");
  require(sr800::zoneCompleted(rising, 150.0, 0.0),
          "a real climb completes the instant it arrives");

  // "the in-zone target".
  const sr800::JourneyZone ramp = {150, 180, 120, 4, 9, 1, 9};
  requireClose(sr800::zoneTargetC(ramp, 0), 150, 1e-9, "target at zone entry");
  requireClose(sr800::zoneTargetC(ramp, 60), 165, 1e-9, "target mid-ramp");
  requireClose(sr800::zoneTargetC(ramp, 120), 180, 1e-9, "target at nominal end");
  requireClose(sr800::zoneTargetC(ramp, 121), 180, 1e-9,
               "the target HOLDS past the nominal duration");
  requireClose(sr800::zoneTargetC(ramp, 100000), 180, 1e-9,
               "the target never overshoots into a ramp nobody asked for");
  requireClose(sr800::zoneTargetC(cooling, 90), 125, 1e-9,
               "a cooling target descends on its own ramp");
  requireClose(sr800::zoneTargetC(cooling, 180), 40, 1e-9,
               "a cooling target reaches its floor");
  requireClose(sr800::zoneTargetC(cooling, 10000), 40, 1e-9,
               "a cooling target holds at its floor rather than driving below it");
}

void authoredRateTests() {
  const sr800::JourneyZone rising = {150, 180, 120, 4, 9, 1, 9};
  sr800::JourneyPlan plan;
  plan.zones = &rising;
  plan.zoneCount = 1;
  for (const double elapsedSec : {119.0, 120.0, 600.0}) {
    const sr800::JourneyCommand command = sr800::journeyCommand(
        plan, elapsedSec, 170, 24.5, 225, defaultCalibration(), 0, 0, 0);
    requireClose(command.requiredRateCPerMin, 15, 1e-12,
                 "authored feed-forward slope survives nominal end and overrun");
  }
  const sr800::JourneyCommand overdue = sr800::journeyCommand(
      plan, 600, 170, 24.5, 225, defaultCalibration(), 0, 0, 0);
  requireClose(overdue.goalC, 180, 1e-12,
               "position target remains capped during an overrun");

  for (const double endC : {179.5, 179.9}) {
    const sr800::JourneyZone hold = {180, endC, 90, 4, 9, 1, 9};
    plan.zones = &hold;
    const sr800::JourneyCommand command = sr800::journeyCommand(
        plan, 45, 180, 24.5, 225, defaultCalibration(), 0, 0, 0);
    require(!command.cooling,
            "equal-epsilon and tiny descending spans are maintenance holds");
    requireClose(command.requiredRateCPerMin, 0, 1e-12,
                 "maintenance holds have zero authored rate");
    require(command.heat > 0,
            "a maintenance hold does not trigger the cooling Heat-off path");
  }

  const sr800::JourneyZone descending = {180, 179.49, 90, 3, 10, 0, 9};
  plan.zones = &descending;
  const sr800::JourneyCommand cooling = sr800::journeyCommand(
      plan, 0, 180, 24.5, 225, defaultCalibration(), 0, 0, 0);
  require(cooling.cooling, "a descent beyond the epsilon enters cooling");
  requireClose(cooling.heat, 0, 1e-12,
               "cooling entry removes Heat immediately");
}
void unreachableZoneTest() {
  // journeyControl.zones.test.ts: "leaves the CONTROLLER holding, which is the
  // correct live behaviour". Heat 5 at fan 8 settles near 153 C; the zone asks
  // for 200 and nothing in the step ever gives up on it.
  const sr800::JourneyZone zones[2] = {
      {25, 200, 300, 8, 10, 1, 5},
      {200, 210, 120, 4, 9, 1, 9},
  };
  sr800::JourneyPlan plan;
  plan.zones = zones;
  plan.zoneCount = 2;

  sr800::JourneyControlState state = sr800::initialJourneyControlState();
  state.lastSampleSec = 3599;
  state.hasLastSample = true;

  sr800::JourneyStepInput input;
  input.plan = plan;
  input.elapsedSec = 3600;
  input.beanTempC = 152;
  input.ambientC = 24.5;
  input.batchMassG = 225;
  input.calibration = defaultCalibration();

  const sr800::JourneyStepResult step = sr800::journeyControlStep(state, input);
  require(step.zoneIndex == 0, "an unreachable zone is never left");
  require(!step.zoneCompleted, "an unreachable zone never reports completion");
  requireClose(step.command.goalC, 200, 1e-6,
               "the target still holds at the endpoint after an hour");
  requireClose(step.command.heat, 5, 1e-9,
               "heat pins at the zone's own maximum");
  require(step.command.saturatedHigh,
          "the derivation reports that it has run out of climb");
  require(step.correction.saturated,
          "and the correction is reported as saturated");
  requireClose(step.state.integralRateCPerMin, 0, 1e-12,
               "conditional integration refuses to wind up against a pinned plant");

  // The same zone with its heat ceiling lifted is reachable, so the verdict is
  // about the BAND, not about the plant.
  requireClose(sr800::modelledSteadyStateC(8, 5, 225, 24.5, defaultCalibration()),
               24.5 + (4 + 33 - 15.2) / 0.17, 1e-9,
               "the steady state explains the saturation");
  require(sr800::modelledSteadyStateC(8, 9, 225, 24.5, defaultCalibration()) > 200,
          "the same zone with heat 9 available would reach its endpoint");

  const double lightSteady =
      sr800::modelledSteadyStateC(1, 10, 100, 24.5, defaultCalibration());
  const double heavySteady =
      sr800::modelledSteadyStateC(1, 10, 300, 24.5, defaultCalibration());
  requireClose(lightSteady, heavySteady, 1e-12,
               "batch mass changes response time, not steady-state reachability");

  const sr800::JourneyZone hold = {180, 180, 120, 1, 10, 1, 10};
  sr800::JourneyPlan holdPlan;
  holdPlan.zones = &hold;
  holdPlan.zoneCount = 1;
  const sr800::JourneyCommand belowFloor = sr800::journeyCommand(
      holdPlan, 30, 180, 25, 225, defaultCalibration(), -9, 0, 0);
  require(belowFloor.saturatedLow,
          "a requested descent below the heating branch floor saturates low");
  require(belowFloor.saturated,
          "the heating-floor limit is visible to conditional integration");
}

void integrationGuardTests() {
  // journeyControl.pi.test.ts: "integrates on sample timestamps, and refuses to
  // integrate across a gap it did not observe".
  const sr800::JourneyZone climb = {25, 200, 900, 4, 10, 1, 10};
  sr800::JourneyPlan plan;
  plan.zones = &climb;
  plan.zoneCount = 1;

  const auto at = [&](double integral, double lastSampleSec, bool hasLast,
                      double elapsedSec) {
    sr800::JourneyControlState state = sr800::initialJourneyControlState();
    state.integralRateCPerMin = integral;
    state.lastSampleSec = lastSampleSec;
    state.hasLastSample = hasLast;

    sr800::JourneyStepInput input;
    input.plan = plan;
    input.elapsedSec = elapsedSec;
    input.beanTempC = sr800::zoneTargetC(climb, elapsedSec) - 2.0;
    input.ambientC = 24.5;
    input.batchMassG = 225;
    input.calibration = defaultCalibration();
    return sr800::journeyControlStep(state, input);
  };

  const double oneSecond =
      at(0, 299, true, 300).correction.integralRatePerMin;
  const double fourSeconds =
      at(0, 296, true, 300).correction.integralRatePerMin;
  require(oneSecond > 0, "a one-second step accumulates something");
  requireClose(fourSeconds, oneSecond * 4, 1e-6,
               "integration is proportional to the observed dt");
  requireClose(at(0, 240, true, 300).correction.integralRatePerMin, 0, 1e-12,
               "a 60 s stall is not integrated at all");
  requireClose(at(0, 0, false, 300).correction.integralRatePerMin, 0, 1e-12,
               "a first sample has no dt to integrate over");
  requireClose(at(0, 18, true, 19).correction.integralRatePerMin, 0, 1e-12,
               "nothing accumulates before the holdoff expires");

  const auto unwindAtLimit = [&](const sr800::JourneyZone& zone,
                                 double startingIntegral,
                                 double beanOffsetC) {
    sr800::JourneyPlan limitPlan;
    limitPlan.zones = &zone;
    limitPlan.zoneCount = 1;
    sr800::JourneyControlState limitState =
        sr800::initialJourneyControlState();
    limitState.integralRateCPerMin = startingIntegral;
    limitState.lastSampleSec = 119;
    limitState.hasLastSample = true;
    sr800::JourneyStepInput limitInput;
    limitInput.plan = limitPlan;
    limitInput.elapsedSec = 120;
    limitInput.beanTempC = sr800::zoneTargetC(zone, 120) + beanOffsetC;
    limitInput.ambientC = 24.5;
    limitInput.batchMassG = 225;
    limitInput.calibration = defaultCalibration();
    return sr800::journeyControlStep(limitState, limitInput);
  };

  const sr800::JourneyZone hotLimit = {25, 265, 180, 4, 10, 1, 10};
  const sr800::JourneyStepResult highUnwind =
      unwindAtLimit(hotLimit, sr800::kMaxIntegralCPerMin, 1);
  require(highUnwind.correction.saturated,
          "high-unwind fixture must remain actuator-limited");
  require(highUnwind.correction.integralRatePerMin <
              sr800::kMaxIntegralCPerMin,
          "negative error must unwind a positive integral at the high limit");

  // A heated zone that cannot shed heat any faster (Heat pinned high, airflow
  // capped) must still unwind a -8 term on an error of the opposite sign.
  const sr800::JourneyZone coldLimit = {200, 200, 600, 1, 2, 9, 10};
  const sr800::JourneyStepResult lowUnwind =
      unwindAtLimit(coldLimit, -sr800::kMaxIntegralCPerMin, -1);
  require(!lowUnwind.command.cooling,
          "low-unwind fixture must be a heated zone");
  require(lowUnwind.correction.saturated,
          "low-unwind fixture must remain actuator-limited");
  require(lowUnwind.correction.integralRatePerMin >
              -sr800::kMaxIntegralCPerMin,
          "positive error must unwind a negative integral at the low limit");

  // A cooling zone commands Fan 10 / Heat 0 whatever the correction says, so
  // the integral is held as it entered.
  const sr800::JourneyZone coolingZone = {250, 25, 180, 4, 10, 1, 10};
  const double coolingCases[][2] = {
      {-sr800::kMaxIntegralCPerMin, -1}, {2.5, 3}, {2.5, -3}};
  for (const auto& coolingCase : coolingCases) {
    const sr800::JourneyStepResult held =
        unwindAtLimit(coolingZone, coolingCase[0], coolingCase[1]);
    require(held.command.cooling && held.command.fan == 10 &&
                held.command.heat == 0,
            "cooling fixture must command Fan 10 / Heat 0");
    require(held.correction.integralRatePerMin == coolingCase[0],
            "a cooling zone must hold the integral as it entered");
  }

  // The holdover rule: no correction, a frozen integral, and the model solved
  // against the PLAN's temperature rather than the last good reading.
  sr800::JourneyControlState state = sr800::initialJourneyControlState();
  state.integralRateCPerMin = 2.5;
  state.lastSampleSec = 299;
  state.hasLastSample = true;
  sr800::JourneyStepInput blind;
  blind.plan = plan;
  blind.elapsedSec = 300;
  blind.beanTempC = std::nan("");
  blind.ambientC = 24.5;
  blind.batchMassG = 225;
  blind.calibration = defaultCalibration();
  const sr800::JourneyStepResult held = sr800::journeyControlStep(state, blind);
  require(held.correction.holdover, "a missing measurement is a holdover");
  requireClose(held.correction.totalRatePerMin, 0, 1e-12,
               "a holdover applies no correction");
  requireClose(held.correction.proportionalRatePerMin, 0, 1e-12,
               "a holdover has no error to be proportional to");
  requireClose(held.correction.integralRatePerMin, 2.5, 1e-12,
               "a holdover freezes the integral at exactly its value");
  require(!held.state.hasLastSample == false,
          "a holdover leaves the sample clock exactly as it found it");
  requireClose(held.state.lastSampleSec, 299, 1e-12,
               "a holdover does not advance the sample clock");
  requireClose(held.command.goalC, sr800::zoneTargetC(climb, 300), 1e-9,
               "a holdover runs feed-forward against the plan");

  // And the zone anchor cannot advance on a step that saw nothing, even when the
  // plan's endpoint had already been passed.
  const sr800::JourneyZone pair[2] = {{25, 100, 100, 4, 10, 1, 10},
                                      {100, 150, 100, 4, 10, 1, 10}};
  sr800::JourneyPlan twoZone;
  twoZone.zones = pair;
  twoZone.zoneCount = 2;
  blind.plan = twoZone;
  const sr800::JourneyStepResult blindPair =
      sr800::journeyControlStep(sr800::initialJourneyControlState(), blind);
  require(blindPair.zoneIndex == 0,
          "a blind step cannot observe an arrival, so it cannot advance a zone");
  sr800::JourneyStepInput seeing = blind;
  seeing.beanTempC = 120;
  const sr800::JourneyStepResult sawIt =
      sr800::journeyControlStep(sr800::initialJourneyControlState(), seeing);
  require(sawIt.zoneIndex == 1 && sawIt.zoneAdvanced,
          "the same temperature, actually measured, advances the zone");
  requireClose(sawIt.zoneEntrySec, 300, 1e-12,
              "the zone is anchored where the roast really entered it");
}

void heatSlewTests() {
  sr800::JourneyZone climb = {25, 200, 900, 4, 10, 6, 10};
  sr800::JourneyPlan plan;
  plan.zones = &climb;
  plan.zoneCount = 1;

  const auto run = [&](const sr800::JourneyControlState& state,
                       double elapsedSec, double beanTempC) {
    sr800::JourneyStepInput input;
    input.plan = plan;
    input.elapsedSec = elapsedSec;
    input.beanTempC = beanTempC;
    input.ambientC = 24.5;
    input.batchMassG = 225;
    input.calibration = defaultCalibration();
    return sr800::journeyControlStep(state, input);
  };

  const sr800::JourneyStepResult first =
      run(sr800::initialJourneyControlState(), 0, 25);
  requireClose(first.command.heat, first.command.unconstrainedHeat, 1e-12,
               "the first journey Heat command remains immediate");
  require(!first.command.heatSlewLimited,
          "the first command is not labelled as slew limited");

  sr800::JourneyControlState prior = sr800::initialJourneyControlState();
  prior.lastSampleSec = 0;
  prior.hasLastSample = true;
  prior.lastCommandHeat = 4;
  prior.lastCommandSec = 0;
  prior.hasLastCommand = true;
  const sr800::JourneyStepResult upward = run(prior, 100, 25);
  requireClose(upward.command.heat, 4.25, 1e-12,
               "a delayed tick still permits only one 0.25 Heat step");
  require(upward.command.heatSlewLimited && upward.command.saturatedHigh,
          "an upward slew limit is observable and blocks more rate of rise");
  require(upward.command.heat < climb.heatMin,
          "a newly higher Heat minimum is crossed gradually");
  require(upward.correction.saturated,
          "the PI sees the upward slew limit as blocked authority");
  requireClose(upward.state.integralRateCPerMin, 0, 1e-12,
               "the integral does not wind up against the slew limit");

  sr800::JourneyZone lowerCeiling = climb;
  lowerCeiling.heatMin = 3;
  lowerCeiling.heatMax = 4;
  plan.zones = &lowerCeiling;
  prior.lastSampleSec = 99;
  prior.lastCommandSec = 99;
  prior.lastCommandHeat = 8;
  const sr800::JourneyStepResult capped = run(prior, 100, 25);
  require(capped.command.heat <= 4,
          "a newly lower authored Heat ceiling is immediate");
  requireClose(capped.command.heat, capped.command.unconstrainedHeat, 1e-12,
               "the hard ceiling wins instead of being reported as smoothing");

  const sr800::JourneyZone risingZones[2] = {
      {25, 100, 300, 4, 9, 3, 9},
      {100, 150, 240, 4, 9, 3, 9},
  };
  plan.zones = risingZones;
  plan.zoneCount = 2;
  prior.zoneIndex = 0;
  prior.zoneEntrySec = 0;
  prior.lastCommandHeat = 7.4;
  const sr800::JourneyStepResult nextRise = run(prior, 100, 100);
  require(nextRise.zoneAdvanced && !nextRise.command.cooling,
          "a rising-to-rising boundary never enters the Heat-off path");
  require(nextRise.command.heat > 0,
          "Heat remains active across a rising-to-rising boundary");

  const sr800::JourneyZone coolingZones[2] = {
      {25, 100, 300, 4, 9, 3, 9},
      {100, 40, 180, 3, 10, 0, 0},
  };
  plan.zones = coolingZones;
  plan.zoneCount = 2;
  prior.zoneIndex = 0;
  prior.zoneEntrySec = 0;
  prior.lastCommandHeat = 7.4;
  const sr800::JourneyStepResult cooling = run(prior, 100, 100);
  require(cooling.zoneAdvanced && cooling.command.cooling,
          "the boundary step enters the cooling zone");
  requireClose(cooling.command.heat, 0, 1e-12,
               "cooling bypasses slew and removes Heat immediately");
  require(!cooling.command.heatSlewLimited,
          "the safety Heat-off is never labelled or delayed as smoothing");
}

void actuatorFloorTests() {
  // Design rule: Heat on means Fan 1.0 or higher at the command layer, on
  // every path. Fan-only normalization keeps the factory 0.1 floor,
  // and the audited actuator core's own 0.1 qualification is untouched.
  requireClose(sr800::minimumFanForHeat(0.001), 1.0, 1e-12,
               "the smallest nonzero Heat requires Fan 1.0");
  requireClose(sr800::minimumFanForHeat(7.525), 1.0, 1e-12,
               "mid Heat requires Fan 1.0 and nothing higher");
  requireClose(sr800::minimumFanForHeat(10), 1.0, 1e-12,
               "maximum Heat requires Fan 1.0 and nothing higher");
  requireClose(sr800::minimumFanForHeat(0), 0, 1e-12,
               "heat 0 needs no airflow at all");
  requireClose(sr800::normalizeFanLevel(0.05), 0.1, 1e-12,
               "a non-zero fan-only level below the drive minimum lifts to 0.1");
  requireClose(sr800::normalizeFanLevel(0), 0, 1e-12, "fan 0 stays off");
  requireClose(sr800::normalizeFanLevel(99), 10, 1e-12, "fan clamps at 10");

  const sr800::JourneyZone tight = {25, 250, 120, 0.5, 2, 1, 10};
  sr800::JourneyPlan plan;
  plan.zones = &tight;
  plan.zoneCount = 1;
  const sr800::JourneyCommand command =
      sr800::journeyCommand(plan, 10, 30, 24.5, 225,
                            defaultCalibration(), 0, 0, 0);
  require(command.heat > 7.525,
          "the zone under test really does need high heat");
  requireClose(command.fan, 10, 1e-12,
               "dense green coffee overrides an unsafe authored Fan ceiling");
  requireClose(sr800::journeyCirculationFloor(130), 10, 1e-12,
               "full airflow is held through the 130 C opening");
  requireClose(sr800::journeyCirculationFloor(130.1), 0, 1e-12,
               "no Journey-specific floor exists above 130 C");
  requireClose(sr800::journeyCirculationFloor(180), 0, 1e-12,
               "no mass-scaled late floor applies");

  // The heat-on floor binding inside the solve: a shallow hot zone whose
  // maximum-airflow answer would be Fan below 1 with Heat still on.
  const sr800::JourneyZone shallowHot = {175, 185, 900, 0.1, 10, 0, 3};
  plan.zones = &shallowHot;
  const sr800::JourneyCommand floored =
      sr800::journeyCommand(plan, 10, 175, 24.5, 225,
                            defaultCalibration(), 0, 0, 0);
  require(floored.heat > 0,
          "the heat-on floor fixture really does carry Heat");
  requireClose(floored.fan, 1.0, 1e-12,
               "Heat on lifts the solved Fan to the universal 1.0 floor");
}

// journeyControl.rate.test.ts: the lag-compensated rate estimate (6)/(7),
// the history rules, and the rate term inside the step.
void rateFeedbackTests() {
  sr800::RateSample history[sr800::kRateHistoryCapacity];
  size_t count = 0;
  const auto fill = [&](double (*temperatureAt)(double), int fromSec,
                        int toSec) {
    count = 0;
    for (int sec = fromSec; sec <= toSec; ++sec) {
      sr800::RateSample sample;
      sample.sec = sec;
      sample.tempC = temperatureAt(sec);
      sr800::appendRateSample(history, count, sample);
    }
  };
  const auto at = [](double sec, double tempC) {
    sr800::RateSample sample;
    sample.sec = sec;
    sample.tempC = tempC;
    return sample;
  };

  // A constant climb reads as its slope with no lead.
  fill([](double sec) { return 25.0 + sec; }, 0, 29);
  const sr800::RateEstimate constant =
      sr800::predictedRate(history, count, at(30, 55));
  require(constant.available, "a constant climb has a rate");
  requireClose(constant.measuredCPerMin, 60, 1e-9, "constant climb level");
  requireClose(constant.leadCPerMin, 0, 1e-9, "constant climb has no lead");

  // T = 0.002 t^2: RoR 6.0 over the last window, 3.6 over the one before,
  // lead 2.4, prediction 2 x 6.0 - 3.6.
  fill([](double sec) { return 0.002 * sec * sec; }, 0, 29);
  const sr800::RateEstimate accelerating =
      sr800::predictedRate(history, count, at(30, 0.002 * 900));
  requireClose(accelerating.measuredCPerMin, 6.0, 1e-9, "accelerating level");
  requireClose(accelerating.leadCPerMin, 2.4, 1e-9, "accelerating lead");
  requireClose(accelerating.predictedCPerMin, 2 * 6.0 - 3.6, 1e-9,
               "one-lag-ahead prediction");

  // T = 0.02 t^2 would lead by 24; the clamp holds it at 10.
  fill([](double sec) { return 0.02 * sec * sec; }, 0, 29);
  const sr800::RateEstimate violent =
      sr800::predictedRate(history, count, at(30, 0.02 * 900));
  requireClose(violent.leadCPerMin, sr800::kMaxRateLeadCPerMin, 1e-12,
               "the lead is clamped");

  // One window is needed for a level, two for a trend; neither is invented.
  count = 0;
  require(!sr800::predictedRate(history, count, at(30, 100)).available,
          "no history, no rate");
  fill([](double sec) { return sec; }, 21, 29);
  require(!sr800::predictedRate(history, count, at(30, 30)).available,
          "less than a window of history, no rate");
  fill([](double sec) { return 0.02 * sec * sec; }, 20, 29);
  const sr800::RateEstimate oneWindow =
      sr800::predictedRate(history, count, at(30, 0.02 * 900));
  require(oneWindow.available, "exactly one window is enough for a level");
  requireClose(oneWindow.leadCPerMin, 0, 1e-12,
               "one window has nothing to trend against");

  // Irregular sampling anchors each window on the newest sample at least a
  // window old: level 84 from the 12 s sample, trend against the 0 s one.
  count = 0;
  sr800::appendRateSample(history, count, at(0, 100));
  sr800::appendRateSample(history, count, at(3, 103));
  sr800::appendRateSample(history, count, at(7, 107));
  sr800::appendRateSample(history, count, at(12, 112));
  sr800::appendRateSample(history, count, at(20, 122));
  const sr800::RateEstimate irregular =
      sr800::predictedRate(history, count, at(22, 126));
  requireClose(irregular.measuredCPerMin, 84, 1e-9, "irregular level");
  requireClose(irregular.leadCPerMin, sr800::kMaxRateLeadCPerMin, 1e-12,
               "irregular lead (24, clamped)");

  // The history drops samples older than its span and never exceeds capacity.
  fill([](double sec) { return sec; }, 0, 100);
  require(count <= sr800::kRateHistoryCapacity, "history respects capacity");
  requireClose(history[0].sec, 100 - sr800::kRateHistorySec, 1e-12,
               "history drops samples older than its span");
  requireClose(history[count - 1].sec, 100, 1e-12, "history keeps the newest");
  count = 0;
  for (int tick = 0; tick <= 200; ++tick) {
    sr800::appendRateSample(history, count, at(tick / 10.0, tick));
  }
  require(count == sr800::kRateHistoryCapacity,
          "a faster cadence is bounded by capacity");
  requireClose(history[count - 1].sec, 20, 1e-12,
               "capacity drops the oldest sample");

  // A sample that fails to advance the clock is not recorded.
  count = 0;
  sr800::appendRateSample(history, count, at(5, 50));
  sr800::appendRateSample(history, count, at(5, 51));
  sr800::appendRateSample(history, count, at(4, 40));
  require(count == 1 && history[0].tempC == 50,
          "a repeated or earlier timestamp is not appended");

  // Inside the step: silent until a window exists, then Kr x (slope - RoR).
  const sr800::JourneyZone climb = {25, 200, 900, 4, 10, 1, 10};
  sr800::JourneyPlan plan;
  plan.zones = &climb;
  plan.zoneCount = 1;
  sr800::JourneyControlState state = sr800::initialJourneyControlState();
  sr800::JourneyStepResult last;
  for (int sec = 0; sec <= 25; ++sec) {
    sr800::JourneyStepInput input;
    input.plan = plan;
    input.elapsedSec = sec;
    input.beanTempC = 25.0 + sec;
    input.ambientC = 24.5;
    input.batchMassG = 225;
    input.calibration = defaultCalibration();
    last = sr800::journeyControlStep(state, input);
    state = last.state;
    if (sec < sr800::kRateWindowSec) {
      require(std::isnan(last.rate.measuredRateCPerMin),
              "no rate before a window of history");
      requireClose(last.rate.rateRatePerMin, 0, 1e-12,
                   "no rate term before a window of history");
    }
  }
  requireClose(last.rate.measuredRateCPerMin, 60, 1e-9, "step-level level");
  requireClose(last.rate.predictedRateCPerMin, 60, 1e-9,
               "step-level prediction");
  requireClose(last.rate.rateRatePerMin,
               sr800::kTrackingRateGain *
                   (last.command.requiredRateCPerMin - 60),
               1e-9, "the rate term is Kr x (slope - predicted RoR)");
  requireClose(last.correction.totalRatePerMin,
               sr800::clampCorrection(last.correction.proportionalRatePerMin +
                                      last.rate.rateRatePerMin +
                                      last.correction.integralRatePerMin),
               1e-9, "the rate term is part of the clamped total");

  // A holdover applies no rate term and appends nothing.
  sr800::JourneyStepInput blind;
  blind.plan = plan;
  blind.elapsedSec = 26;
  blind.beanTempC = std::nan("");
  blind.ambientC = 24.5;
  blind.batchMassG = 225;
  blind.calibration = defaultCalibration();
  const sr800::JourneyStepResult held = sr800::journeyControlStep(state, blind);
  require(held.correction.holdover && held.rate.rateRatePerMin == 0.0 &&
              std::isnan(held.rate.measuredRateCPerMin),
          "a holdover has no rate term");
  require(held.state.rateHistoryCount == state.rateHistoryCount,
          "a holdover appends nothing to the rate history");

  // A gap the control did not observe empties the history; a short one keeps it.
  sr800::JourneyStepInput resumed = blind;
  resumed.elapsedSec = 25 + sr800::kStaleSampleGapSec + 1;
  resumed.beanTempC = 25 + resumed.elapsedSec;
  const sr800::JourneyStepResult afterGap =
      sr800::journeyControlStep(state, resumed);
  require(std::isnan(afterGap.rate.measuredRateCPerMin) &&
              afterGap.state.rateHistoryCount == 1,
          "a stale gap empties the rate history");
  sr800::JourneyStepInput soon = blind;
  soon.elapsedSec = 30;
  soon.beanTempC = 55;
  const sr800::JourneyStepResult kept = sr800::journeyControlStep(state, soon);
  requireClose(kept.rate.measuredRateCPerMin, 60, 1e-9,
               "a short dropout keeps the history on either side");
  require(kept.state.rateHistoryCount == state.rateHistoryCount + 1,
          "a short dropout appends the resumed sample");
}

// journeyControl.rate.test.ts: corrections spend Heat before Fan, (4)/(5).
void heatFirstTests() {
  // 30 C/min with a Heat floor of 6: feed-forward sits at Heat 10 with an
  // interior Fan (about 8.05 at 170 C), and Heat has 26.4 C/min of downward
  // authority before its floor.
  const sr800::JourneyZone zone = {150, 210, 120, 1, 10, 6, 10};
  sr800::JourneyPlan plan;
  plan.zones = &zone;
  plan.zoneCount = 1;
  const auto at = [&](double correction) {
    return sr800::journeyCommand(plan, 120, 170, 24.5, 225,
                                 defaultCalibration(), correction, 0, 0);
  };
  const double heatLevel = defaultCalibration().heaterGainCPerMinAt10 / 10.0;
  const double fanLevel = defaultCalibration().fanCoolingCPerMinAt10 / 10.0;

  const sr800::JourneyCommand baseline = at(0);
  requireClose(baseline.heat, zone.heatMax, 1e-9, "baseline Heat is heatMax");
  require(baseline.fan > zone.fanMin && baseline.fan < zone.fanMax,
          "baseline Fan is interior");
  requireClose(baseline.baselineRateCPerMin, baseline.requiredRateCPerMin,
               1e-9, "an unclamped baseline delivers the plan's slope");

  const sr800::JourneyCommand eased = at(-6);
  requireClose(eased.fan, baseline.fan, 1e-9,
               "a negative correction leaves the baseline Fan alone");
  requireClose(eased.heat, baseline.heat - 6 / heatLevel, 1e-9,
               "a negative correction comes out of Heat");
  require(!eased.saturated, "an in-band Heat move is not saturation");

  const double heatAuthority = (baseline.heat - zone.heatMin) * heatLevel;
  const sr800::JourneyCommand beyond = at(-(heatAuthority + 2));
  requireClose(beyond.heat, zone.heatMin, 1e-9,
               "Heat reaches its floor before Fan moves");
  requireClose(beyond.fan, baseline.fan + 2 / fanLevel, 1e-6,
               "Fan rises only for what Heat could not deliver");
  require(!beyond.saturated, "an in-band Fan move is not saturation");

  const sr800::JourneyCommand pinned = at(-(heatAuthority + 40));
  requireClose(pinned.fan, zone.fanMax, 1e-12, "past airflow, Fan is pinned");
  requireClose(pinned.heat, zone.heatMin, 1e-12, "past airflow, Heat is pinned");
  require(pinned.saturatedLow, "past airflow, the request saturates low");

  const sr800::JourneyCommand pushed = at(6);
  requireClose(pushed.heat, zone.heatMax, 1e-9,
               "a positive correction keeps Heat at heatMax");
  requireClose(pushed.fan, baseline.fan - 6 / fanLevel, 1e-6,
               "a positive correction lowers Fan");

  // A recorded roast, zone 3 at 199 C under its applied fit: feed-forward is pinned at
  // Fan 1 / Heat 10 (the fit wants 10.85), and a -6 correction comes out of
  // the Heat actually running - Fan stays at 1.
  const sr800::JourneyZone overshootZones[5] = {{28.8, 150, 120, 10, 10, 10, 10},
                                       {150, 180, 60, 5, 10, 5, 10},
                                       {180, 215, 120, 1, 10, 0, 10},
                                       {215, 233, 60, 1, 10, 0, 10},
                                       {233, 50, 120, 1, 10, 0, 0}};
  sr800::JourneyPlan overshootPlan;
  overshootPlan.zones = overshootZones;
  overshootPlan.zoneCount = 5;
  sr800::JourneyCalibration fit;
  fit.heaterGainCPerMinAt10 = 49.2;
  fit.fanCoolingCPerMinAt10 = 2.94;
  fit.coolingFanCPerMinAt10 = 19.67;
  fit.thermalLossPerMinPerC = 0.2443;
  fit.referenceBatchMassG = 225;
  const sr800::JourneyCommand feedForward =
      sr800::journeyCommand(overshootPlan, 323, 199, 24.5, 225, fit, 0, 2, 262);
  require(feedForward.fan == 1.0 && feedForward.heat == 10.0 &&
              feedForward.saturatedHigh,
          "recorded-roast feed-forward is pinned at Fan 1 / Heat 10");
  require(feedForward.baselineRateCPerMin <
              feedForward.requiredRateCPerMin - 3,
          "the pinned baseline delivers less than the plan's slope");
  const sr800::JourneyCommand overshootEased =
      sr800::journeyCommand(overshootPlan, 323, 199, 24.5, 225, fit, -6, 2, 262);
  requireClose(overshootEased.fan, 1.0, 1e-12, "recorded roast: Fan stays at 1");
  requireClose(overshootEased.heat, 10 - 6 / (fit.heaterGainCPerMinAt10 / 10.0), 1e-6,
               "recorded roast: the correction comes out of the running Heat");
  require(!overshootEased.saturatedLow, "recorded roast: Heat has room, no low saturation");
}

// The replayed recorded-roast vector, read as behaviour: Fan holds 1.0 through zone 3
// while Heat moves first, the correction is bounded, and it relaxes while the
// measured RoR is still above the zone's slope.
void overshootScenarioTests(const JsonPtr& scenario,
                            const std::map<std::string, size_t>& column) {
  if (scenario == nullptr) return;
  const JsonPtr steps = member(scenario, "steps");
  if (steps == nullptr) return;
  const auto value = [&](const JsonPtr& row, const char* field) {
    return row->items[column.at(field)]->number;
  };
  double maxFan = 0.0;
  double minHeat = 10.0;
  double minTotal = 0.0;
  double minTotalSec = 0.0;
  double entrySec = -1.0;
  double firstHeatMoveSec = -1.0;
  double requiredRate = 0.0;
  bool sawZone3 = false;
  for (const JsonPtr& row : steps->items) {
    if (value(row, "zoneIndex") != 2.0) continue;
    sawZone3 = true;
    const double sec = value(row, "elapsedSec");
    if (entrySec < 0.0) entrySec = sec;
    requiredRate = value(row, "requiredRate");
    const double fan = value(row, "fan");
    const double heat = value(row, "heat");
    const double total = value(row, "total");
    if (fan > maxFan) maxFan = fan;
    if (heat < minHeat) minHeat = heat;
    if (heat < 10.0 - 1e-9 && firstHeatMoveSec < 0.0) firstHeatMoveSec = sec;
    if (total < minTotal) {
      minTotal = total;
      minTotalSec = sec;
    }
  }
  require(sawZone3, "overshoot_lag_recovery must reach zone 3");
  requireClose(maxFan, 1.0, 1e-9,
               "overshoot_lag_recovery: Fan holds 1.0 through zone 3");
  require(minHeat < 9.0, "overshoot_lag_recovery: Heat is what moved");
  require(firstHeatMoveSec >= 0.0 && firstHeatMoveSec - entrySec < 5.0,
          "overshoot_lag_recovery: Heat moves at zone entry");
  require(minTotal >= -sr800::kMaxCoolingCorrectionCPerMin - 1e-9,
          "overshoot_lag_recovery: the cooling bound holds");
  bool relaxed = false;
  for (const JsonPtr& row : steps->items) {
    if (value(row, "zoneIndex") != 2.0) continue;
    if (value(row, "elapsedSec") <= minTotalSec) continue;
    if (value(row, "total") > minTotal + 1.0) {
      require(value(row, "measuredRate") > requiredRate,
              "overshoot_lag_recovery: the correction relaxes while measured "
              "RoR is still above the slope");
      relaxed = true;
      break;
    }
  }
  require(relaxed, "overshoot_lag_recovery: the correction relaxes in zone 3");
}
}  // namespace

int main(int argc, char** argv) {
  const std::string path =
      argc > 1 ? argv[1] : "vectors/journey_control_vectors.json";
  std::ifstream file(path, std::ios::binary);
  if (!file) {
    std::cerr << "FAIL: could not open the vector file: " << path << '\n';
    std::cerr << "      (run: npx vite-node scripts/generate-journey-vectors.ts"
                 " from web/)\n";
    return 1;
  }
  std::ostringstream buffer;
  buffer << file.rdbuf();
  const std::string source = buffer.str();

  JsonParser parser(source);
  const JsonPtr document = parser.parse();
  if (!parser.ok() || document == nullptr) {
    std::cerr << "FAIL: the vector file did not parse: " << parser.error()
              << '\n';
    return 1;
  }

  const JsonPtr columnsJson = member(document, "columns");
  std::map<std::string, size_t> column;
  for (size_t index = 0; index < columnsJson->items.size(); ++index) {
    column[columnsJson->items[index]->text] = index;
  }

  const JsonPtr scenarios = member(document, "scenarios");
  require(scenarios != nullptr && scenarios->kind == JsonValue::Kind::ARRAY,
          "the vector file must carry a scenarios array");

  const std::set<std::string> requiredScenarios = {
      "nominal", "weak_heater", "saturated_windup", "hold_zone",
      "mid_roast_plan_patch", "non_reference_mass", "cool_then_heat",
      "irregular_cadence", "dropout", "heavy_mass_immediate_reduction",
      "heat_on_fan_floor", "overshoot_lag_recovery"};
  std::map<std::string, JsonPtr> scenarioByName;
  if (scenarios != nullptr && scenarios->kind == JsonValue::Kind::ARRAY) {
    for (const JsonPtr& scenario : scenarios->items) {
      const JsonPtr name = member(scenario, "name");
      const JsonPtr zones = member(scenario, "zones");
      const JsonPtr steps = member(scenario, "steps");
      const JsonPtr patches = member(scenario, "planPatches");
      require(name != nullptr && name->kind == JsonValue::Kind::STRING &&
                  !name->text.empty(),
              "every vector scenario must have a non-empty name");
      if (name == nullptr || name->kind != JsonValue::Kind::STRING) continue;
      require(scenarioByName.emplace(name->text, scenario).second,
              "vector scenario names must be unique: " + name->text);
      require(zones != nullptr && zones->kind == JsonValue::Kind::ARRAY &&
                  !zones->items.empty(),
              name->text + " must carry at least one initial zone");
      require(steps != nullptr && steps->kind == JsonValue::Kind::ARRAY &&
                  !steps->items.empty(),
              name->text + " must carry replay steps");
      require(patches != nullptr && patches->kind == JsonValue::Kind::ARRAY,
              name->text + " must carry a planPatches array");
      if (steps != nullptr && steps->kind == JsonValue::Kind::ARRAY) {
        for (const JsonPtr& row : steps->items) {
          require(row != nullptr && row->kind == JsonValue::Kind::ARRAY &&
                      row->items.size() == columnsJson->items.size(),
                  name->text + " has a malformed replay row");
        }
      }
    }
  }
  for (const std::string& name : requiredScenarios) {
    require(scenarioByName.count(name) == 1,
            "required vector scenario is missing: " + name);
  }

  const JsonPtr holdScenario = scenarioByName["hold_zone"];
  bool trueHold = false;
  if (holdScenario != nullptr) {
    const JsonPtr zones = member(holdScenario, "zones");
    if (zones != nullptr) {
      for (const JsonPtr& zone : zones->items) {
        trueHold = trueHold ||
            numberAt(zone, "startC") == numberAt(zone, "endC");
      }
    }
  }
  require(trueHold, "hold_zone must contain a true startC == endC zone");

  const JsonPtr patchScenario = scenarioByName["mid_roast_plan_patch"];
  const JsonPtr patches =
      patchScenario == nullptr ? nullptr : member(patchScenario, "planPatches");
  require(patches != nullptr && patches->kind == JsonValue::Kind::ARRAY &&
              patches->items.size() == 1,
          "mid_roast_plan_patch must carry exactly one plan patch event");
  if (patches != nullptr && patches->items.size() == 1) {
    const JsonPtr event = patches->items[0];
    const JsonPtr patchedZones = member(event, "zones");
    require(numberAt(event, "elapsedSec") == 120,
            "the plan patch event must occur at 120 seconds");
    require(patchedZones != nullptr &&
                patchedZones->kind == JsonValue::Kind::ARRAY &&
                !patchedZones->items.empty(),
            "the plan patch event must carry its replacement zones");
    const JsonPtr initialZones = member(patchScenario, "zones");
    require(initialZones != nullptr && !initialZones->items.empty() &&
                patchedZones != nullptr && !patchedZones->items.empty() &&
                numberAt(initialZones->items[0], "endC") !=
                    numberAt(patchedZones->items[0], "endC"),
            "the patch must actually replace the active plan");
    const JsonPtr patchSteps = member(patchScenario, "steps");
    if (patchSteps != nullptr && patchSteps->items.size() >= 2) {
      const double firstElapsed =
          patchSteps->items.front()->items[column.at("elapsedSec")]->number;
      const double lastElapsed =
          patchSteps->items.back()->items[column.at("elapsedSec")]->number;
      require(firstElapsed < 120 && lastElapsed > 120,
              "the plan patch must occur between replay samples");
    }
  }

  // The constants the vector was generated with have to be the constants the
  // port is built with, or every later comparison is measuring the wrong thing.
  const JsonPtr constants = member(document, "constants");
  requireClose(numberAt(constants, "trackingKpRatePerC"),
               sr800::kTrackingKpRatePerC, 1e-12, "Kp");
  requireClose(numberAt(constants, "trackingIntegralTimeSec"),
               sr800::kTrackingIntegralTimeSec, 1e-12, "integral time");
  requireClose(numberAt(constants, "maxHeatSlewPerSec"),
               sr800::kMaxHeatSlewPerSec, 1e-12, "Heat slew rate");
  requireClose(numberAt(constants, "maxHeatSlewStepSec"),
               sr800::kMaxHeatSlewStepSec, 1e-12, "Heat slew tick cap");
  requireClose(numberAt(constants, "maxCorrectionCPerMin"),
               sr800::kMaxCorrectionCPerMin, 1e-12, "correction clamp");
  requireClose(numberAt(constants, "maxIntegralCPerMin"),
               sr800::kMaxIntegralCPerMin, 1e-12, "integral clamp");
  requireClose(numberAt(constants, "maxIntegrationStepSec"),
               sr800::kMaxIntegrationStepSec, 1e-12, "dt cap");
  requireClose(numberAt(constants, "staleSampleGapSec"),
               sr800::kStaleSampleGapSec, 1e-12, "stale gap");
  requireClose(numberAt(constants, "integralHoldoffSec"),
               sr800::kIntegralHoldoffSec, 1e-12, "holdoff");
  requireClose(numberAt(constants, "plantBiasCPerMin"),
               sr800::kPlantBiasCPerMin, 1e-12, "plant bias");
  requireClose(numberAt(constants, "minimumModelledCoolingCPerMin"),
               sr800::kMinimumModelledCoolingCPerMin, 1e-12, "cooling floor");
  requireClose(numberAt(constants, "zoneHoldEpsilonC"), sr800::kZoneHoldEpsilonC,
               1e-12, "hold epsilon");
  requireClose(numberAt(constants, "heatOnMinimumFan"), sr800::kHeatOnMinimumFan,
               1e-12, "heat-on fan floor");
  requireClose(numberAt(constants, "fullAirflowUntilC"),
               sr800::kFullAirflowUntilC, 1e-12, "full-airflow boundary");
  requireClose(numberAt(constants, "trackingDerivativeTimeSec"),
               sr800::kTrackingDerivativeTimeSec, 1e-12, "derivative time");
  requireClose(numberAt(constants, "trackingRateGain"),
               sr800::kTrackingRateGain, 1e-12, "rate gain");
  requireClose(numberAt(constants, "rateWindowSec"), sr800::kRateWindowSec,
               1e-12, "rate window");
  requireClose(numberAt(constants, "rateLeadSec"), sr800::kRateLeadSec, 1e-12,
               "rate lead");
  requireClose(numberAt(constants, "maxRateLeadCPerMin"),
               sr800::kMaxRateLeadCPerMin, 1e-12, "rate lead clamp");
  requireClose(numberAt(constants, "rateHistorySec"), sr800::kRateHistorySec,
               1e-12, "rate history span");
  requireClose(numberAt(constants, "rateHistoryCapacity"),
               static_cast<double>(sr800::kRateHistoryCapacity), 1e-12,
               "rate history capacity");
  requireClose(numberAt(constants, "maxCoolingCorrectionCPerMin"),
               sr800::kMaxCoolingCorrectionCPerMin, 1e-12,
               "cooling correction clamp");
  requireClose(numberAt(constants, "maxCoolingIntegralCPerMin"),
               sr800::kMaxCoolingIntegralCPerMin, 1e-12,
               "cooling integral clamp");


  int totalSteps = 0;
  for (const JsonPtr& scenario : scenarios->items) {
    const int replayed = replayScenario(scenario, column);
    std::cout << "  replayed " << member(scenario, "name")->text << ": "
              << replayed << " steps\n";
    totalSteps += replayed;
  }

  zoneGatingTests();
  authoredRateTests();
  unreachableZoneTest();
  integrationGuardTests();
  heatSlewTests();
  actuatorFloorTests();
  rateFeedbackTests();
  heatFirstTests();
  overshootScenarioTests(scenarioByName["overshoot_lag_recovery"], column);

  if (failures != 0) {
    std::cerr << failures << " assertion(s) failed\n";
    return 1;
  }
  std::cout.precision(4);
  std::cout << "journey control vector tests passed: "
            << scenarios->items.size() << " scenarios, " << totalSteps
            << " steps, worst deviation " << std::scientific << worstDeviation
            << " (" << worstField << "), tolerance " << kTolerance << '\n';
  return 0;
}
