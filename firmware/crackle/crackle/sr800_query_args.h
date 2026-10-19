#pragma once

#include <stddef.h>
#include <stdint.h>

namespace sr800::network {

class QueryArgs {
 public:
  // The primary source wins when both strings contain the same key. Native
  // command handling passes a form body as primary and the URL query as
  // fallback, so credentials never need to be placed in the request URL.
  explicit QueryArgs(const char* encoded, const char* fallback = nullptr)
      : encoded_(encoded == nullptr ? "" : encoded),
        fallback_(fallback == nullptr ? "" : fallback) {}

  bool has(const char* key) const;
  bool text(const char* key, char* output, size_t capacity) const;
  bool equals(const char* key, const char* expected) const;
  bool uint32(const char* key, uint32_t& value) const;
  bool levelMilli(const char* key, uint32_t& value) const;

 private:
  bool encodedValue(const char* key, const char*& start, size_t& length) const;
  static bool encodedValueIn(const char* encoded, const char* key,
                             const char*& start, size_t& length);
  static bool decode(const char* start, size_t length,
                     char* output, size_t capacity);

  const char* encoded_;
  const char* fallback_;
};

}  // namespace sr800::network
