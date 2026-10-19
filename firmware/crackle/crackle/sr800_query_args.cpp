#include "sr800_query_args.h"

#include <ctype.h>
#include <stdlib.h>
#include <string.h>

namespace sr800::network {
namespace {

int hexValue(char value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  if (value >= 'A' && value <= 'F') return value - 'A' + 10;
  return -1;
}

}  // namespace

bool QueryArgs::encodedValueIn(const char* encoded, const char* key,
                               const char*& start, size_t& length) {
  if (key == nullptr || key[0] == 0) return false;
  const size_t keyLength = strlen(key);
  const char* cursor = encoded == nullptr ? "" : encoded;
  while (*cursor != 0) {
    const char* itemEnd = strchr(cursor, '&');
    if (itemEnd == nullptr) itemEnd = cursor + strlen(cursor);
    const char* equals = static_cast<const char*>(
        memchr(cursor, '=', static_cast<size_t>(itemEnd - cursor)));
    const size_t candidateLength = equals == nullptr
        ? static_cast<size_t>(itemEnd - cursor)
        : static_cast<size_t>(equals - cursor);
    if (candidateLength == keyLength &&
        memcmp(cursor, key, keyLength) == 0) {
      start = equals == nullptr ? itemEnd : equals + 1;
      length = static_cast<size_t>(itemEnd - start);
      return true;
    }
    cursor = *itemEnd == '&' ? itemEnd + 1 : itemEnd;
  }
  return false;
}

bool QueryArgs::encodedValue(const char* key, const char*& start,
                             size_t& length) const {
  return encodedValueIn(encoded_, key, start, length) ||
      encodedValueIn(fallback_, key, start, length);
}

bool QueryArgs::decode(const char* start, size_t length,
                       char* output, size_t capacity) {
  if (output == nullptr || capacity == 0) return false;
  size_t used = 0;
  for (size_t index = 0; index < length; ++index) {
    char value = start[index];
    if (value == '+') value = ' ';
    else if (value == '%') {
      if (index + 2 >= length) return false;
      const int high = hexValue(start[index + 1]);
      const int low = hexValue(start[index + 2]);
      if (high < 0 || low < 0) return false;
      value = static_cast<char>((high << 4) | low);
      index += 2;
    }
    if (used + 1 >= capacity || value == 0) return false;
    output[used++] = value;
  }
  output[used] = 0;
  return true;
}

bool QueryArgs::has(const char* key) const {
  const char* start = nullptr;
  size_t length = 0;
  return encodedValue(key, start, length);
}

bool QueryArgs::text(const char* key, char* output, size_t capacity) const {
  const char* start = nullptr;
  size_t length = 0;
  return encodedValue(key, start, length) &&
      decode(start, length, output, capacity);
}

bool QueryArgs::equals(const char* key, const char* expected) const {
  if (expected == nullptr) return false;
  char value[64] = {};
  return text(key, value, sizeof(value)) && strcmp(value, expected) == 0;
}

bool QueryArgs::uint32(const char* key, uint32_t& value) const {
  char textValue[16] = {};
  if (!text(key, textValue, sizeof(textValue)) || textValue[0] == 0) {
    return false;
  }
  char* end = nullptr;
  const unsigned long parsed = strtoul(textValue, &end, 10);
  if (end == textValue || *end != 0 || parsed > UINT32_MAX) return false;
  value = static_cast<uint32_t>(parsed);
  return true;
}

bool QueryArgs::levelMilli(const char* key, uint32_t& value) const {
  char textValue[16] = {};
  if (!text(key, textValue, sizeof(textValue)) || textValue[0] == 0) {
    return false;
  }
  const char* cursor = textValue;
  if (*cursor == '+') ++cursor;
  if (!isdigit(static_cast<unsigned char>(*cursor))) return false;
  uint32_t whole = 0;
  while (isdigit(static_cast<unsigned char>(*cursor))) {
    whole = whole * 10U + static_cast<uint32_t>(*cursor - '0');
    if (whole > 10U) return false;
    ++cursor;
  }
  uint32_t fraction = 0;
  uint32_t scale = 100;
  if (*cursor == '.') {
    ++cursor;
    while (isdigit(static_cast<unsigned char>(*cursor))) {
      if (scale > 0) {
        fraction += static_cast<uint32_t>(*cursor - '0') * scale;
        scale /= 10;
      } else if (*cursor != '0') {
        return false;
      }
      ++cursor;
    }
  }
  if (*cursor != 0) return false;
  value = whole * 1000U + fraction;
  return value <= 10000U;
}

}  // namespace sr800::network
