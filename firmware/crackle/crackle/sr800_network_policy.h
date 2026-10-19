#pragma once

#include <stdint.h>

namespace sr800::network {

// Live frames publish once per second. Fifteen missed successful sends is long
// enough to distinguish an abandoned/blocked subscriber from ordinary packet
// delay without turning a fifth healthy browser into an eviction loop.
constexpr uint32_t kSubscriberEvictionStaleMs = 15000;

inline bool subscriberEvictionAllowed(uint32_t nowMs,
                                      uint32_t lastSuccessfulSendMs) {
  return static_cast<uint32_t>(nowMs - lastSuccessfulSendMs) >=
      kSubscriberEvictionStaleMs;
}

// UINT32_MAX is the boot sentinel before the corresponding worker has ever
// completed a request. Never serialize it as a physically meaningful byte
// reserve.
inline uint32_t reportedStackLowWaterBytes(uint32_t measuredBytes) {
  return measuredBytes == UINT32_MAX ? 0U : measuredBytes;
}

// Uptime alone cannot prove a newly booted OTA image serves requests. The
// no-browser fallback is eligible only after station association and native
// HTTP startup have both succeeded for the required observation window.
inline bool otaUptimeFallbackAllowed(bool stationConnected,
                                     bool httpServerRunning,
                                     uint32_t uptimeMs,
                                     uint32_t requiredUptimeMs) {
  return stationConnected && httpServerRunning &&
      uptimeMs >= requiredUptimeMs;
}

}  // namespace sr800::network
