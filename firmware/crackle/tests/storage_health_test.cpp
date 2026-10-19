#include <cstdlib>
#include <iostream>

#include "sr800_storage_health.h"

namespace {

int failures = 0;

void require(bool condition, const char* message) {
  if (!condition) {
    std::cerr << "FAIL: " << message << '\n';
    failures++;
  }
}

}  // namespace

int main() {
  using sr800::storage::Layout;
  using sr800::storage::LayoutVerdict;
  using sr800::storage::Marker;

  const Layout current = {0x310000u, 0x0E0000u,
                          sr800::storage::kFilesystemFormatVersion};
  require(sr800::storage::classifyLayout({false, false, {}}, current) ==
              LayoutVerdict::FRESH,
          "an uninitialized controller is fresh; firmware separately requires erased flash before formatting");
  require(sr800::storage::classifyLayout({true, false, {}}, current) ==
              LayoutVerdict::REQUIRES_FORMAT,
          "a legacy bool-only marker must never masquerade as current");
  require(sr800::storage::classifyLayout({true, true, current}, current) ==
              LayoutVerdict::CURRENT,
          "the exact offset, size, and format version must be accepted");

  const Marker oldGeometry = {
      true, true,
      {0x290000u, 0x160000u, sr800::storage::kFilesystemFormatVersion}};
  require(sr800::storage::classifyLayout(oldGeometry, current) ==
              LayoutVerdict::REQUIRES_FORMAT,
          "the old larger partition must require an explicit format");

  const Marker futureFormat = {
      true, true, {current.offset, current.size,
                   static_cast<uint16_t>(current.formatVersion + 1)}};
  require(sr800::storage::classifyLayout(futureFormat, current) ==
              LayoutVerdict::REQUIRES_FORMAT,
          "unknown on-disk formats must fail closed");

  if (failures != 0) return EXIT_FAILURE;
  std::cout << "storage layout health: PASS\n";
  return EXIT_SUCCESS;
}
