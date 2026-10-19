#include <cstdlib>
#include <iostream>

#include "sr800_capture_time.h"

namespace {

void require(bool condition, const char* message) {
  if (!condition) {
    std::cerr << "FAIL: " << message << '\n';
    std::exit(1);
  }
}

}  // namespace

int main() {
  require(sr800::captureDeltaUs(700000, 0, 80) == 8750,
          "80 MHz capture ticks must convert to microseconds");
  require(sr800::captureDeltaUs(633600, 0, 80) == 7920,
          "asymmetric zero-cross half-cycles must retain their duration");
  require(sr800::captureDeltaUs(8080, 80, 80) == 100,
          "pulse width conversion must preserve 100 us");
  require(sr800::captureDeltaUs(0x00000100U, 0xFFFFFF00U, 80) == 6,
          "unsigned capture deltas must survive 32-bit counter wrap");
  require(sr800::captureDeltaUs(1, 0, 0) == UINT32_MAX,
          "an invalid capture clock must fail closed");

  std::cout << "capture time tests passed\n";
  return 0;
}