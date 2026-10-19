#pragma once

#include <stddef.h>

namespace sr800::network {

// Produces a JSON merge object containing only top-level properties whose
// serialized values changed. Inputs must be complete JSON objects.
size_t buildTopLevelJsonDelta(const char* previous, size_t previousLength,
                              const char* current, size_t currentLength,
                              char* output, size_t capacity);

}  // namespace sr800::network
