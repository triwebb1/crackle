#include <cstdlib>
#include <iostream>

#include "sr800_zero_cross_qualifier.h"

namespace {
void require(bool condition, const char* message) {
  if (!condition) {
    std::cerr << "FAIL: " << message << '\n';
    std::exit(1);
  }
}

sr800::ZeroCrossQualifier makeQualifier() {
  return sr800::ZeroCrossQualifier(6000, 11000, 6);
}
}  // namespace

int main() {
  using sr800::ZeroCrossObservation;
  using sr800::ZeroCrossRejectReason;

  {
    sr800::ZeroCrossQualifier qualifier = makeQualifier();
    require(qualifier.observe(0, false, false) ==
                ZeroCrossObservation::BASELINE,
            "first edge must establish a baseline without qualifying");
    for (int i = 0; i < 5; ++i) {
      require(qualifier.observe(i % 2 == 0 ? 8760 : 7900, true, false) ==
                  ZeroCrossObservation::QUALIFYING,
              "qualification must require the full valid sequence");
    }
    require(qualifier.observe(7900, true, false) ==
                ZeroCrossObservation::ACCEPTED && qualifier.qualified(),
            "six consecutive valid intervals must qualify the stream");
    require(qualifier.validIntervalCount() == 6,
            "every in-band interval must count as valid");
  }

  {
    sr800::ZeroCrossQualifier qualifier = makeQualifier();
    qualifier.observe(0, false, false);
    for (int i = 0; i < 6; ++i) qualifier.observe(8333, true, false);
    require(qualifier.qualified(), "setup must qualify the stream");
    const uint8_t progress = qualifier.consecutiveValidIntervals();
    require(qualifier.observe(3, true, true) ==
                ZeroCrossObservation::IGNORED_GLITCH,
            "sub-minimum chatter must be ignored, not rejected");
    require(qualifier.qualified(),
            "chatter must never demote a qualified stream");
    require(qualifier.consecutiveValidIntervals() == progress,
            "chatter must not disturb qualification progress");
    require(qualifier.ignoredGlitchCount() == 1 &&
                qualifier.lastIgnoredGlitchIntervalUs() == 3,
            "chatter must be recorded as telemetry");
  }

  {
    sr800::ZeroCrossQualifier qualifier = makeQualifier();
    qualifier.observe(0, false, false);
    int valid = 0;
    ZeroCrossObservation last = ZeroCrossObservation::BASELINE;
    while (valid < 6) {
      require(qualifier.observe(5, true, false) ==
                  ZeroCrossObservation::IGNORED_GLITCH,
              "chatter during qualification must be ignored");
      require(qualifier.consecutiveValidIntervals() ==
                  static_cast<uint8_t>(valid),
              "chatter must not reset qualification progress");
      last = qualifier.observe(8333, true, false);
      valid++;
    }
    require(last == ZeroCrossObservation::ACCEPTED && qualifier.qualified(),
            "interleaved chatter must still qualify on the sixth valid "
            "interval");
  }

  {
    sr800::ZeroCrossQualifier qualifier = makeQualifier();
    qualifier.observe(0, false, false);
    for (int i = 0; i < 6; ++i) qualifier.observe(8333, true, false);
    require(qualifier.qualified(), "setup must qualify the stream");
    qualifier.observe(4, true, true);
    qualifier.observe(7, true, true);
    require(qualifier.observe(8767, true, true) ==
                ZeroCrossObservation::ACCEPTED && qualifier.qualified(),
            "a normal interval after chatter must be accepted");
    require(qualifier.lastRejectReason() == ZeroCrossRejectReason::NONE,
            "no polarity state exists that could poison a normal interval");
  }

  {
    sr800::ZeroCrossQualifier qualifier = makeQualifier();
    qualifier.observe(0, false, false);
    for (int i = 0; i < 6; ++i) qualifier.observe(8333, true, false);
    require(qualifier.observe(16663, true, true) ==
                ZeroCrossObservation::REJECTED_ACTIVE && qualifier.qualified() &&
                qualifier.lastRejectReason() ==
                    ZeroCrossRejectReason::TOO_LONG &&
                qualifier.lastRejectedIntervalUs() == 16663,
            "a bounded long gap must stay available to the coast policy");
  }

  {
    sr800::ZeroCrossQualifier qualifier = makeQualifier();
    qualifier.observe(0, false, false);
    for (int i = 0; i < 6; ++i) qualifier.observe(8333, true, false);
    require(qualifier.observe(120000, true, false) ==
                ZeroCrossObservation::REJECTED_IDLE && !qualifier.qualified() &&
                qualifier.idleRejectedCount() == 1 &&
                qualifier.lastRejectReason() ==
                    ZeroCrossRejectReason::TOO_LONG,
            "an idle anomaly must demote qualification");
  }

  {
    sr800::ZeroCrossQualifier qualifier = makeQualifier();
    qualifier.observe(0, false, false);
    for (int i = 0; i < 6; ++i) qualifier.observe(8333, true, false);
    qualifier.restartQualification();
    require(!qualifier.qualified() &&
                qualifier.consecutiveValidIntervals() == 0,
            "a true abort must clear qualification");
    for (int i = 0; i < 5; ++i) {
      require(qualifier.observe(8333, true, false) ==
                  ZeroCrossObservation::QUALIFYING,
              "a restart must require a fresh six-interval sequence");
    }
    require(qualifier.observe(8333, true, false) ==
                ZeroCrossObservation::ACCEPTED && qualifier.qualified(),
            "a healthy stream must requalify after a restart");
  }

  std::cout << "zero-cross qualifier tests passed\n";
  return 0;
}
