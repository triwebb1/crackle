#pragma once

#include <stddef.h>
#include <stdint.h>

namespace sr800 {
namespace retention {

constexpr size_t kMaxPlannedDeletions = 64;

struct Archive {
  uint32_t id;
  uint32_t bytes;
  uint32_t age;
};

enum class Verdict : uint8_t {
  FITS = 0,
  DELETE_ARCHIVES,
  IMPOSSIBLE,
};

struct Plan {
  Verdict verdict;
  uint8_t count;
  uint32_t ids[kMaxPlannedDeletions];
};

inline bool planContains(const Plan& plan, uint32_t id) {
  for (uint8_t i = 0; i < plan.count; ++i) {
    if (plan.ids[i] == id) return true;
  }
  return false;
}

inline Plan planLogRetention(uint32_t totalBytes, uint32_t usedBytes,
                             uint32_t incomingBytes, uint32_t reserveBytes,
                             uint32_t protectedId, const Archive* archives,
                             size_t archiveCount) {
  Plan result = {Verdict::IMPOSSIBLE, 0, {0}};
  const uint64_t required =
      static_cast<uint64_t>(usedBytes) + incomingBytes + reserveBytes;
  if (required <= totalBytes) {
    result.verdict = Verdict::FITS;
    return result;
  }

  const uint64_t bytesToReclaim = required - totalBytes;
  uint64_t reclaimed = 0;

  while (reclaimed < bytesToReclaim) {
    size_t oldestIndex = archiveCount;
    for (size_t i = 0; archives != nullptr && i < archiveCount; ++i) {
      const Archive& candidate = archives[i];
      if (candidate.id == 0 || candidate.id == protectedId ||
          candidate.bytes == 0 || planContains(result, candidate.id)) {
        continue;
      }
      if (oldestIndex == archiveCount ||
          candidate.age > archives[oldestIndex].age ||
          (candidate.age == archives[oldestIndex].age &&
           candidate.id < archives[oldestIndex].id)) {
        oldestIndex = i;
      }
    }

    if (oldestIndex == archiveCount ||
        result.count == kMaxPlannedDeletions) {
      result.count = 0;
      result.verdict = Verdict::IMPOSSIBLE;
      return result;
    }

    const Archive& selected = archives[oldestIndex];
    result.ids[result.count++] = selected.id;
    reclaimed += selected.bytes;
  }

  result.verdict = Verdict::DELETE_ARCHIVES;
  return result;
}

}  // namespace retention
}  // namespace sr800
