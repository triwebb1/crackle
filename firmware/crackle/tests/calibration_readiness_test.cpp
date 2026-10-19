#include "../crackle/sr800_calibration_readiness.h"

#include <assert.h>

int main() {
  sr800::CalibrationReadiness readiness;
  readiness.observe(false, NAN, 1000);
  assert(!readiness.ready(20000));
  assert(readiness.reason() ==
         sr800::CalibrationReadinessReason::SENSOR_INVALID);

  readiness.observe(true, 80.0f, 2000);
  assert(readiness.ready(2000));
  assert(readiness.reason() == sr800::CalibrationReadinessReason::READY);
  assert(readiness.candidateC() == 80.0f);
  assert(readiness.stableForMs(2000) == 0);

  // A single invalid sample revokes readiness immediately.
  readiness.observe(false, NAN, 2500);
  assert(!readiness.ready(40000));
  return 0;
}
