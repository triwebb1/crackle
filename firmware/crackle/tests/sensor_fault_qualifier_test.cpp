#include "../crackle/sr800_sensor_fault_qualifier.h"

#include <assert.h>

int main() {
  sr800::SensorFaultQualifier qualifier;
  sr800::SensorFaultQualifier zeroStart;
  assert(!zeroStart.observe(true, 0, 0));
  assert(!zeroStart.observe(false, 0x01, 250));
  assert(!zeroStart.observe(false, 0x01, 500));
  assert(zeroStart.observe(false, 0x01, 750));
  assert(!qualifier.observe(true, 0, 1000));
  assert(!qualifier.observe(false, 0x41, 1250));
  assert(!qualifier.observe(false, 0x41, 1500));
  assert(!qualifier.qualified());
  assert(qualifier.consecutiveInvalid() == 2);
  assert(qualifier.invalidDurationMs(1500) == 500);

  assert(qualifier.observe(false, 0x41, 1750));
  assert(qualifier.qualified());
  assert(qualifier.tripFaultByte() == 0x41);
  assert(qualifier.tripInvalidCount() == 3);
  assert(qualifier.tripInvalidDurationMs() == 750);
  assert(qualifier.tripAtMs() == 1750);

  // Recovery clears current evidence, but never erases the qualified trip.
  assert(qualifier.observe(true, 0, 2000));
  assert(qualifier.recoveries() == 1);
  assert(qualifier.consecutiveInvalid() == 0);
  assert(qualifier.tripFaultByte() == 0x41);

  // Later healthy samples cannot un-latch the authoritative decision.
  assert(qualifier.observe(true, 0, 2250));
  assert(qualifier.qualified());
  assert(qualifier.recoveries() == 1);
  return 0;
}