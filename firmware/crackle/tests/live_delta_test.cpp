#include "../crackle/sr800_live_delta.h"
#include "../crackle/sr800_network_policy.h"

#include <cstdlib>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

namespace {

void require(bool condition, const char* message) {
  if (!condition) {
    std::cerr << "FAIL: " << message << '\n';
    std::exit(1);
  }
}

std::string delta(const std::string& previous, const std::string& current,
                  size_t capacity = 512) {
  std::vector<char> output(capacity, '\0');
  const size_t used = sr800::network::buildTopLevelJsonDelta(
      previous.data(), previous.size(), current.data(), current.size(),
      output.data(), output.size());
  return used == 0 ? std::string() : std::string(output.data(), used);
}

}  // namespace

int main() {
  require(!sr800::network::subscriberEvictionAllowed(14'999U, 0U),
          "healthy subscribers must not be evicted");
  require(sr800::network::subscriberEvictionAllowed(15'000U, 0U),
          "a subscriber becomes evictable at the explicit stale boundary");
  require(!sr800::network::subscriberEvictionAllowed(5U, UINT32_MAX - 10'000U),
          "millisecond wrap must preserve a healthy subscriber age");
  require(sr800::network::reportedStackLowWaterBytes(UINT32_MAX) == 0U,
          "an unmeasured stack sentinel must not become a byte count");
  require(sr800::network::reportedStackLowWaterBytes(6144U) == 6144U,
          "a measured stack reserve must pass through unchanged");
  require(!sr800::network::otaUptimeFallbackAllowed(false, true, 120000U, 120000U),
          "OTA uptime fallback requires station association");
  require(!sr800::network::otaUptimeFallbackAllowed(true, false, 120000U, 120000U),
          "OTA uptime fallback requires the native HTTP server");
  require(!sr800::network::otaUptimeFallbackAllowed(true, true, 119999U, 120000U),
          "OTA uptime fallback must wait for the complete observation window");
  require(sr800::network::otaUptimeFallbackAllowed(true, true, 120000U, 120000U),
          "OTA uptime fallback opens at the boundary after network and HTTP health");


  require(delta(R"({"seq":1,"fan":4,"heat":0})",
                R"({"seq":1,"fan":4,"heat":0})") == "{}",
          "unchanged objects should produce an empty merge object");

  require(delta(R"({"seq":1,"fan":4,"heat":0})",
                R"({"seq":2,"fan":4,"heat":1})") ==
              R"({"seq":2,"heat":1})",
          "only changed top-level fields should be emitted");

  require(delta(R"({"roast":{"active":true,"zone":[1,{"x":2}]},"fan":4})",
                R"({"roast":{"active":true,"zone":[1,{"x":3}]},"fan":4})") ==
              R"({"roast":{"active":true,"zone":[1,{"x":3}]}})",
          "a nested change should emit the complete top-level value");

  require(delta(R"({"label":"a\\\"b","path":"c\\\\d"})",
                R"({"label":"a\\\"b","path":"c\\\\e"})") ==
              R"({"path":"c\\\\e"})",
          "escaped quotes and slashes must not desynchronize fields");

  const std::string expected = R"({"seq":2,"heat":1})";
  require(delta(R"({"seq":1,"heat":0})",
                R"({"seq":2,"heat":1})", expected.size() + 1) == expected,
          "an exactly-sized output buffer including NUL should succeed");
  require(delta(R"({"seq":1,"heat":0})",
                R"({"seq":2,"heat":1})", expected.size()).empty(),
          "a buffer without room for the trailing NUL should fail safely");

  for (const std::string& malformed : {
           std::string(R"({"a":[1,2})"),
           std::string(R"({"a":[1,,2]})"),
           std::string(R"({"a":1} trailing)"),
           std::string(R"({"a":truth})"),
           std::string(R"({"a":1,})"),
           std::string(R"({"a":"unterminated})"),
           std::string(R"({"a":"bad\q"})")}) {
    const std::string currentResult = delta(R"({"a":0})", malformed);
    if (!currentResult.empty()) {
      std::cerr << "malformed current accepted: " << malformed
                << " -> " << currentResult << '\n';
      return 1;
    }
    const std::string previousResult = delta(malformed, R"({"a":1})");
    if (!previousResult.empty()) {
      std::cerr << "malformed previous accepted: " << malformed
                << " -> " << previousResult << '\n';
      return 1;
    }
  }

  std::cout << "live delta tests passed\n";
  return 0;
}
