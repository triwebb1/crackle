#include "../crackle/sr800_calibration_settle.h"

#include <assert.h>

int main() {
  sr800::CalibrationSettleDetector detector;

  // A flat thermocouple during the post-command dead time is not evidence that
  // the newly requested setting has settled.
  detector.reset(10, 0.3f);
  for (int second = 0; second < 10; ++second) {
    detector.observe(100.0f + (second % 2 == 0 ? 0.0f : 0.05f));
  }
  assert(!detector.transitionObserved());
  assert(!detector.settled());

  // Once a real transition begins, a complete stable window is required.
  detector.observe(100.5f);
  assert(detector.transitionObserved());
  assert(!detector.settled());
  for (int second = 1; second < 10; ++second) {
    detector.observe(100.5f + (second % 2 == 0 ? -0.05f : 0.05f));
  }
  assert(detector.settled());

  // A moving window does not settle merely because enough samples elapsed.
  detector.reset(4, 0.5f);
  detector.observe(80.0f);
  detector.observe(81.0f);
  detector.observe(82.0f);
  detector.observe(83.0f);
  detector.observe(84.0f);
  assert(detector.transitionObserved());
  assert(!detector.settled());
  detector.observe(84.2f);
  detector.observe(84.1f);
  detector.observe(84.0f);
  assert(detector.settled());

  // Resetting for the next command discards the previous plateau and transition.
  detector.reset(2, 1.0f);
  detector.observe(84.0f);
  detector.observe(84.1f);
  assert(!detector.transitionObserved());
  assert(!detector.settled());

  return 0;
}