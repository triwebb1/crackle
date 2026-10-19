#include "sr800_live_delta.h"

#include <stdint.h>
#include <string.h>

namespace sr800::network {
namespace {

constexpr size_t kMaximumFields = 80;
constexpr size_t kMaximumNesting = 32;

struct JsonField {
  size_t keyStart;
  size_t keyLength;
  size_t valueStart;
  size_t valueLength;
};

bool whitespace(char value) {
  return value == ' ' || value == '\t' || value == '\r' || value == '\n';
}

bool sameSpan(const char* left, size_t leftStart, size_t leftLength,
              const char* right, size_t rightStart, size_t rightLength) {
  return leftLength == rightLength &&
      memcmp(left + leftStart, right + rightStart, leftLength) == 0;
}

size_t skipString(const char* json, size_t length, size_t cursor) {
  if (cursor >= length || json[cursor] != '"') return SIZE_MAX;
  ++cursor;
  while (cursor < length) {
    const unsigned char value = static_cast<unsigned char>(json[cursor]);
    if (value < 0x20) return SIZE_MAX;
    if (json[cursor] == '\\') {
      if (cursor + 1 >= length) return SIZE_MAX;
      const char escape = json[cursor + 1];
      if (escape == 'u') {
        if (cursor + 5 >= length) return SIZE_MAX;
        for (size_t index = cursor + 2; index < cursor + 6; ++index) {
          const char digit = json[index];
          const bool hexadecimal =
              (digit >= '0' && digit <= '9') ||
              (digit >= 'a' && digit <= 'f') ||
              (digit >= 'A' && digit <= 'F');
          if (!hexadecimal) return SIZE_MAX;
        }
        cursor += 6;
        continue;
      }
      if (escape != '"' && escape != '\\' && escape != '/' &&
          escape != 'b' && escape != 'f' && escape != 'n' &&
          escape != 'r' && escape != 't') {
        return SIZE_MAX;
      }
      cursor += 2;
      continue;
    }
    if (json[cursor++] == '"') return cursor;
  }
  return SIZE_MAX;
}

size_t skipNumber(const char* json, size_t length, size_t cursor) {
  const size_t start = cursor;
  if (cursor < length && json[cursor] == '-') ++cursor;
  if (cursor >= length) return SIZE_MAX;
  if (json[cursor] == '0') {
    ++cursor;
  } else {
    if (json[cursor] < '1' || json[cursor] > '9') return SIZE_MAX;
    while (cursor < length && json[cursor] >= '0' && json[cursor] <= '9') {
      ++cursor;
    }
  }
  if (cursor < length && json[cursor] == '.') {
    ++cursor;
    const size_t fractionalStart = cursor;
    while (cursor < length && json[cursor] >= '0' && json[cursor] <= '9') {
      ++cursor;
    }
    if (cursor == fractionalStart) return SIZE_MAX;
  }
  if (cursor < length && (json[cursor] == 'e' || json[cursor] == 'E')) {
    ++cursor;
    if (cursor < length && (json[cursor] == '+' || json[cursor] == '-')) {
      ++cursor;
    }
    const size_t exponentStart = cursor;
    while (cursor < length && json[cursor] >= '0' && json[cursor] <= '9') {
      ++cursor;
    }
    if (cursor == exponentStart) return SIZE_MAX;
  }
  return cursor == start ? SIZE_MAX : cursor;
}

size_t skipValue(const char* json, size_t length, size_t cursor,
                 size_t depth);

size_t skipComposite(const char* json, size_t length, size_t cursor,
                     size_t depth) {
  if (depth >= kMaximumNesting || cursor >= length) return SIZE_MAX;
  const bool object = json[cursor] == '{';
  if (!object && json[cursor] != '[') return SIZE_MAX;
  const char close = object ? '}' : ']';
  ++cursor;
  while (cursor < length && whitespace(json[cursor])) ++cursor;
  if (cursor < length && json[cursor] == close) return cursor + 1;

  while (cursor < length) {
    if (object) {
      if (json[cursor] != '"') return SIZE_MAX;
      cursor = skipString(json, length, cursor);
      if (cursor == SIZE_MAX) return SIZE_MAX;
      while (cursor < length && whitespace(json[cursor])) ++cursor;
      if (cursor >= length || json[cursor++] != ':') return SIZE_MAX;
      while (cursor < length && whitespace(json[cursor])) ++cursor;
    }

    cursor = skipValue(json, length, cursor, depth + 1);
    if (cursor == SIZE_MAX) return SIZE_MAX;
    while (cursor < length && whitespace(json[cursor])) ++cursor;
    if (cursor >= length) return SIZE_MAX;
    if (json[cursor] == close) return cursor + 1;
    if (json[cursor++] != ',') return SIZE_MAX;
    while (cursor < length && whitespace(json[cursor])) ++cursor;
    if (cursor >= length || json[cursor] == close) return SIZE_MAX;
  }
  return SIZE_MAX;
}

size_t skipValue(const char* json, size_t length, size_t cursor,
                 size_t depth) {
  if (cursor >= length) return SIZE_MAX;
  if (json[cursor] == '"') return skipString(json, length, cursor);
  if (json[cursor] == '{' || json[cursor] == '[') {
    return skipComposite(json, length, cursor, depth);
  }
  if (length - cursor >= 4 && memcmp(json + cursor, "true", 4) == 0) {
    return cursor + 4;
  }
  if (length - cursor >= 5 && memcmp(json + cursor, "false", 5) == 0) {
    return cursor + 5;
  }
  if (length - cursor >= 4 && memcmp(json + cursor, "null", 4) == 0) {
    return cursor + 4;
  }
  return skipNumber(json, length, cursor);
}
bool parseFields(const char* json, size_t length, JsonField* fields,
                 size_t& used) {
  used = 0;
  if (json == nullptr) return false;
  size_t cursor = 0;
  while (cursor < length && whitespace(json[cursor])) ++cursor;
  if (cursor >= length || json[cursor++] != '{') return false;
  while (cursor < length && whitespace(json[cursor])) ++cursor;
  if (cursor < length && json[cursor] == '}') {
    ++cursor;
    while (cursor < length && whitespace(json[cursor])) ++cursor;
    return cursor == length;
  }

  while (cursor < length) {
    if (used >= kMaximumFields || json[cursor] != '"') return false;
    const size_t keyStart = cursor;
    const size_t keyEnd = skipString(json, length, cursor);
    if (keyEnd == SIZE_MAX) return false;
    cursor = keyEnd;
    while (cursor < length && whitespace(json[cursor])) ++cursor;
    if (cursor >= length || json[cursor++] != ':') return false;
    while (cursor < length && whitespace(json[cursor])) ++cursor;

    const size_t valueStart = cursor;
    const size_t valueEnd = skipValue(json, length, cursor, 0);
    if (valueEnd == SIZE_MAX || valueEnd == valueStart) return false;
    fields[used++] = {
        keyStart, keyEnd - keyStart, valueStart, valueEnd - valueStart};
    cursor = valueEnd;
    while (cursor < length && whitespace(json[cursor])) ++cursor;
    if (cursor >= length) return false;
    if (json[cursor] == '}') {
      ++cursor;
      while (cursor < length && whitespace(json[cursor])) ++cursor;
      return cursor == length;
    }
    if (json[cursor++] != ',') return false;
    while (cursor < length && whitespace(json[cursor])) ++cursor;
    if (cursor >= length || json[cursor] == '}') return false;
  }
  return false;
}

}  // namespace

size_t buildTopLevelJsonDelta(const char* previous, size_t previousLength,
                              const char* current, size_t currentLength,
                              char* output, size_t capacity) {
  if (previous == nullptr || current == nullptr || output == nullptr ||
      capacity < 3) return 0;
  JsonField before[kMaximumFields];
  JsonField after[kMaximumFields];
  size_t beforeCount = 0;
  size_t afterCount = 0;
  if (!parseFields(previous, previousLength, before, beforeCount) ||
      !parseFields(current, currentLength, after, afterCount) ||
      afterCount == 0) {
    return 0;
  }

  size_t used = 0;
  output[used++] = '{';
  bool first = true;
  for (size_t index = 0; index < afterCount; ++index) {
    bool changed = true;
    for (size_t oldIndex = 0; oldIndex < beforeCount; ++oldIndex) {
      if (!sameSpan(current, after[index].keyStart, after[index].keyLength,
                    previous, before[oldIndex].keyStart,
                    before[oldIndex].keyLength)) continue;
      changed = !sameSpan(current, after[index].valueStart,
                          after[index].valueLength, previous,
                          before[oldIndex].valueStart,
                          before[oldIndex].valueLength);
      break;
    }
    if (!changed) continue;
    const size_t required = (first ? 0 : 1) + after[index].keyLength + 1 +
        after[index].valueLength;
    if (used + required + 1 >= capacity) return 0;
    if (!first) output[used++] = ',';
    memcpy(output + used, current + after[index].keyStart,
           after[index].keyLength);
    used += after[index].keyLength;
    output[used++] = ':';
    memcpy(output + used, current + after[index].valueStart,
           after[index].valueLength);
    used += after[index].valueLength;
    first = false;
  }
  output[used++] = '}';
  output[used] = 0;
  return used;
}

}  // namespace sr800::network
