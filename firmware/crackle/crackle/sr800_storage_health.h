#ifndef SR800_STORAGE_HEALTH_H_
#define SR800_STORAGE_HEALTH_H_

#include <stdint.h>

namespace sr800 {
namespace storage {

constexpr uint16_t kFilesystemFormatVersion = 1;

struct Layout {
  uint32_t offset;
  uint32_t size;
  uint16_t formatVersion;
};

struct Marker {
  bool initialized;
  bool hasLayout;
  Layout layout;
};

enum class LayoutVerdict : uint8_t {
  FRESH = 0,
  CURRENT,
  REQUIRES_FORMAT,
};

constexpr bool sameLayout(const Layout& left, const Layout& right) {
  return left.offset == right.offset && left.size == right.size &&
         left.formatVersion == right.formatVersion;
}

constexpr LayoutVerdict classifyLayout(const Marker& marker,
                                       const Layout& current) {
  if (!marker.initialized) return LayoutVerdict::FRESH;
  if (!marker.hasLayout) return LayoutVerdict::REQUIRES_FORMAT;
  return sameLayout(marker.layout, current) ? LayoutVerdict::CURRENT
                                            : LayoutVerdict::REQUIRES_FORMAT;
}

}  // namespace storage
}  // namespace sr800

#endif  // SR800_STORAGE_HEALTH_H_
