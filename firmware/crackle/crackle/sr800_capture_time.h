#pragma once

#include <stdint.h>

namespace sr800 {

inline uint32_t captureDeltaUs(
    uint32_t laterTicks, uint32_t earlierTicks, uint32_t ticksPerUs) {
  if (ticksPerUs == 0) return UINT32_MAX;
  return (laterTicks - earlierTicks) / ticksPerUs;
}

}  // namespace sr800