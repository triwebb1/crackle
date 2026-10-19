#include "sr800_doc_store.h"

#include <stdio.h>
#include <string.h>

namespace sr800 {
namespace docstore {
namespace {

constexpr char kDataDir[] = "/data";
constexpr char kRunsDir[] = "/data/runs";
constexpr char kDocSuffix[] = ".json";

const char* const kCollectionNames[kCollectionCount] = {
    "profiles", "beans", "calibrations", "meta"};

void putU16(uint8_t* out, uint16_t value) {
  out[0] = static_cast<uint8_t>(value & 0xFFu);
  out[1] = static_cast<uint8_t>((value >> 8) & 0xFFu);
}

void putU32(uint8_t* out, uint32_t value) {
  out[0] = static_cast<uint8_t>(value & 0xFFu);
  out[1] = static_cast<uint8_t>((value >> 8) & 0xFFu);
  out[2] = static_cast<uint8_t>((value >> 16) & 0xFFu);
  out[3] = static_cast<uint8_t>((value >> 24) & 0xFFu);
}

uint16_t getU16(const uint8_t* in) {
  return static_cast<uint16_t>(static_cast<uint16_t>(in[0]) |
                               (static_cast<uint16_t>(in[1]) << 8));
}

uint32_t getU32(const uint8_t* in) {
  return static_cast<uint32_t>(in[0]) |
         (static_cast<uint32_t>(in[1]) << 8) |
         (static_cast<uint32_t>(in[2]) << 16) |
         (static_cast<uint32_t>(in[3]) << 24);
}

bool idCharAllowed(char value) {
  return (value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z') ||
         (value >= '0' && value <= '9') || value == '.' || value == '_' ||
         value == '-';
}

}  // namespace

void encodePrefix(const Prefix& prefix, uint8_t* out) {
  if (out == nullptr) return;
  out[0] = 'C';
  out[1] = 'D';
  out[2] = 'O';
  out[3] = 'C';
  putU16(out + 4, prefix.prefixVersion);
  putU16(out + 6, prefix.reserved);
  putU32(out + 8, prefix.docVersion);
  putU32(out + 12, prefix.byteLength);
}

bool decodePrefix(const uint8_t* in, Prefix& out) {
  if (in == nullptr) return false;
  if (in[0] != 'C' || in[1] != 'D' || in[2] != 'O' || in[3] != 'C') {
    return false;
  }
  Prefix decoded;
  decoded.prefixVersion = getU16(in + 4);
  decoded.reserved = getU16(in + 6);
  decoded.docVersion = getU32(in + 8);
  decoded.byteLength = getU32(in + 12);
  // A future prefix version could mean a longer envelope; refusing to guess is
  // the only safe answer, because the payload offset would be wrong.
  if (decoded.prefixVersion != kPrefixVersion) return false;
  out = decoded;
  return true;
}

bool validRunId(const char* id) {
  if (id == nullptr) return false;
  size_t length = 0;
  bool allDots = true;
  for (; id[length] != '\0'; ++length) {
    if (length >= kRunIdMaxChars) return false;
    if (!idCharAllowed(id[length])) return false;
    if (id[length] != '.') allDots = false;
  }
  if (length == 0) return false;
  return !allDots;
}

bool collectionFromName(const char* name, Collection& out) {
  if (name == nullptr) return false;
  for (size_t index = 0; index < kCollectionCount; ++index) {
    if (strcmp(name, kCollectionNames[index]) == 0) {
      out = static_cast<Collection>(index);
      return true;
    }
  }
  return false;
}

const char* collectionName(Collection collection) {
  const size_t index = static_cast<size_t>(collection);
  return index < kCollectionCount ? kCollectionNames[index] : "";
}

bool collectionPath(char* out, size_t capacity, Collection collection) {
  if (out == nullptr || capacity == 0) return false;
  const size_t index = static_cast<size_t>(collection);
  if (index >= kCollectionCount) {
    out[0] = '\0';
    return false;
  }
  const int written = snprintf(out, capacity, "%s/%s%s", kDataDir,
                               kCollectionNames[index], kDocSuffix);
  return written > 0 && static_cast<size_t>(written) < capacity;
}

bool runPath(char* out, size_t capacity, const char* id) {
  if (out == nullptr || capacity == 0) return false;
  if (!validRunId(id)) {
    out[0] = '\0';
    return false;
  }
  const int written =
      snprintf(out, capacity, "%s/%s%s", kRunsDir, id, kDocSuffix);
  return written > 0 && static_cast<size_t>(written) < capacity;
}

bool runIdFromFileName(const char* fileName, char* out, size_t capacity) {
  if (fileName == nullptr || out == nullptr || capacity == 0) return false;
  const char* slash = strrchr(fileName, '/');
  const char* base = slash == nullptr ? fileName : slash + 1;
  const size_t baseLength = strlen(base);
  const size_t suffixLength = sizeof(kDocSuffix) - 1;
  if (baseLength <= suffixLength) return false;
  if (strcmp(base + baseLength - suffixLength, kDocSuffix) != 0) return false;
  const size_t idLength = baseLength - suffixLength;
  if (idLength >= capacity) return false;
  char id[kRunIdMaxChars + 1];
  if (idLength >= sizeof(id)) return false;
  memcpy(id, base, idLength);
  id[idLength] = '\0';
  if (!validRunId(id)) return false;
  memcpy(out, id, idLength + 1);
  return true;
}

bool parseBaseVersion(const char* text, uint32_t& out) {
  if (text == nullptr || text[0] == '\0') return false;
  uint64_t value = 0;
  for (size_t index = 0; text[index] != '\0'; ++index) {
    const char digit = text[index];
    if (digit < '0' || digit > '9') return false;
    value = value * 10u + static_cast<uint64_t>(digit - '0');
    if (value > 0xFFFFFFFFull) return false;
  }
  out = static_cast<uint32_t>(value);
  return true;
}

bool writeFitsVolume(uint32_t volumeTotalBytes, uint32_t volumeUsedBytes,
                     uint32_t newFileBytes) {
  const uint64_t peak = static_cast<uint64_t>(volumeUsedBytes) +
                        static_cast<uint64_t>(newFileBytes) +
                        static_cast<uint64_t>(kVolumeFloorBytes);
  return peak <= static_cast<uint64_t>(volumeTotalBytes);
}

WriteVerdict evaluateWrite(bool exists, uint32_t currentVersion,
                           uint32_t baseVersion, uint32_t payloadBytes,
                           uint32_t maxPayloadBytes, uint32_t volumeTotalBytes,
                           uint32_t volumeUsedBytes, uint32_t& nextVersion) {
  nextVersion = 0;
  if (payloadBytes > maxPayloadBytes) return WriteVerdict::TOO_LARGE;
  // base=0 means "I am creating this; it must not exist yet". Any other base
  // must equal the stored version exactly, so two browsers editing the same
  // document cannot silently overwrite one another.
  const uint32_t effectiveCurrent = exists ? currentVersion : 0u;
  if (baseVersion != effectiveCurrent) return WriteVerdict::CONFLICT;
  if (!writeFitsVolume(volumeTotalBytes, volumeUsedBytes,
                       static_cast<uint32_t>(kPrefixBytes) + payloadBytes)) {
    return WriteVerdict::NO_ROOM;
  }
  // Unreachable in practice (one write per second for 136 years), but a wrapped
  // version would read as "never written" and defeat the concurrency check.
  nextVersion = effectiveCurrent == 0xFFFFFFFFu ? 1u : effectiveCurrent + 1u;
  return WriteVerdict::OK;
}

DeleteVerdict evaluateDelete(bool exists, uint32_t currentVersion,
                             uint32_t baseVersion) {
  const uint32_t effectiveCurrent = exists ? currentVersion : 0u;
  if (baseVersion != effectiveCurrent) return DeleteVerdict::CONFLICT;
  return exists ? DeleteVerdict::OK : DeleteVerdict::NOT_FOUND;
}
RemoveVerdict evaluateRemove(bool exists, bool removed) {
  if (!exists) return RemoveVerdict::NOT_FOUND;
  return removed ? RemoveVerdict::OK : RemoveVerdict::FAILED;
}


ReplaceOutcome replaceDocument(const ReplaceCallbacks& callbacks) {
  // A missing callback is a programming error, not a runtime condition; report
  // it as the failure it is rather than dereferencing null.
  if (callbacks.writeTemp == nullptr || callbacks.renameOver == nullptr ||
      callbacks.removeTemp == nullptr) {
    return ReplaceOutcome::WRITE_FAILED;
  }
  if (!callbacks.writeTemp(callbacks.context)) {
    // The temp file may exist and be short. It is the only thing that can be
    // wrong here, so it is the only thing that gets cleaned up.
    callbacks.removeTemp(callbacks.context);
    return ReplaceOutcome::WRITE_FAILED;
  }
  if (!callbacks.renameOver(callbacks.context)) {
    // The new bytes are complete but homeless. Discard them and leave the
    // stored document exactly as it was: the user keeps the version they had,
    // and the client gets a 500 telling it the write did not happen. There is
    // no second attempt, because every second attempt worth making would have
    // to start by removing the good copy.
    callbacks.removeTemp(callbacks.context);
    return ReplaceOutcome::RENAME_FAILED;
  }
  return ReplaceOutcome::OK;
}

}  // namespace docstore
}  // namespace sr800
