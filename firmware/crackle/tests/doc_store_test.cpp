// Host verification of the on-device document store's pure layer: the stored
// envelope (a wire format), the run-id sanitization that guards a path segment,
// the strict `base` parse, and the whole write decision.
//
// The last block drives an in-memory fake filesystem through the same
// read-modify-write sequence the firmware performs, so the optimistic-
// concurrency contract the web client builds against is proven off-target: an
// opaque payload survives a round trip byte for byte, versions advance by one,
// a stale base is refused without touching the stored bytes, and a delete
// resets the version history so a later base=0 create succeeds.

#include <cstdlib>
#include <cstring>
#include <iostream>
#include <map>
#include <string>
#include <vector>

#include "sr800_doc_store.h"

namespace {

using sr800::docstore::Collection;
using sr800::docstore::DeleteVerdict;
using sr800::docstore::Prefix;
using sr800::docstore::RemoveVerdict;
using sr800::docstore::WriteVerdict;

int failures = 0;

void require(bool condition, const char* message) {
  if (!condition) {
    std::cerr << "FAIL: " << message << '\n';
    failures++;
  }
}

// --- an in-memory stand-in for the /data tree on LittleFS ---
class FakeVolume {
 public:
  explicit FakeVolume(uint32_t totalBytes) : totalBytes_(totalBytes) {}

  bool exists(const std::string& path) const {
    return files_.find(path) != files_.end();
  }

  bool readPrefix(const std::string& path, Prefix& out) const {
    const auto found = files_.find(path);
    if (found == files_.end()) return false;
    if (found->second.size() < sr800::docstore::kPrefixBytes) return false;
    return sr800::docstore::decodePrefix(found->second.data(), out);
  }

  bool readPayload(const std::string& path, std::string& out) const {
    Prefix prefix;
    if (!readPrefix(path, prefix)) return false;
    const std::vector<uint8_t>& bytes = files_.at(path);
    if (bytes.size() != sr800::docstore::kPrefixBytes + prefix.byteLength) {
      return false;
    }
    out.assign(bytes.begin() + sr800::docstore::kPrefixBytes, bytes.end());
    return true;
  }

  void write(const std::string& path, const Prefix& prefix,
             const std::string& payload) {
    std::vector<uint8_t> bytes(sr800::docstore::kPrefixBytes);
    sr800::docstore::encodePrefix(prefix, bytes.data());
    bytes.insert(bytes.end(), payload.begin(), payload.end());
    files_[path] = bytes;
  }

  bool remove(const std::string& path) { return files_.erase(path) == 1; }

  uint32_t usedBytes() const {
    uint32_t used = 0;
    for (const auto& entry : files_) {
      used += static_cast<uint32_t>(entry.second.size());
    }
    return used + otherUsedBytes_;
  }

  void setOtherUsedBytes(uint32_t bytes) { otherUsedBytes_ = bytes; }
  uint32_t totalBytes() const { return totalBytes_; }

  void corrupt(const std::string& path, size_t offset, uint8_t value) {
    files_[path][offset] = value;
  }

 private:
  std::map<std::string, std::vector<uint8_t>> files_;
  uint32_t totalBytes_;
  uint32_t otherUsedBytes_ = 0;
};

// The firmware's POST path, transcribed: everything the .ino does between the
// idle gate and the rename.
struct StoreResult {
  WriteVerdict verdict;
  uint32_t version;  // new version on OK, current version on CONFLICT
};

StoreResult storeDocument(FakeVolume& volume, const std::string& path,
                          uint32_t baseVersion, const std::string& payload,
                          uint32_t maxPayloadBytes) {
  Prefix current;
  const bool exists = volume.readPrefix(path, current);
  const uint32_t currentVersion = exists ? current.docVersion : 0u;
  uint32_t nextVersion = 0;
  const WriteVerdict verdict = sr800::docstore::evaluateWrite(
      exists, currentVersion, baseVersion,
      static_cast<uint32_t>(payload.size()), maxPayloadBytes,
      volume.totalBytes(), volume.usedBytes(), nextVersion);
  if (verdict != WriteVerdict::OK) return {verdict, currentVersion};
  Prefix next;
  next.prefixVersion = sr800::docstore::kPrefixVersion;
  next.reserved = 0;
  next.docVersion = nextVersion;
  next.byteLength = static_cast<uint32_t>(payload.size());
  volume.write(path, next, payload);
  return {WriteVerdict::OK, nextVersion};
}

void testEnvelopeRoundTrip() {
  Prefix written;
  written.prefixVersion = sr800::docstore::kPrefixVersion;
  written.reserved = 0;
  written.docVersion = 0xDEADBEEFu;
  written.byteLength = 0x00C0FFEEu;

  uint8_t bytes[sr800::docstore::kPrefixBytes];
  sr800::docstore::encodePrefix(written, bytes);

  require(bytes[0] == 'C' && bytes[1] == 'D' && bytes[2] == 'O' &&
              bytes[3] == 'C',
          "the envelope must open with the CDOC magic");
  require(bytes[4] == 1 && bytes[5] == 0,
          "the prefix version must be stored little endian");
  require(bytes[6] == 0 && bytes[7] == 0,
          "the reserved field must be written as zero");
  require(bytes[8] == 0xEF && bytes[9] == 0xBE && bytes[10] == 0xAD &&
              bytes[11] == 0xDE,
          "the document version must be stored little endian");
  require(bytes[12] == 0xEE && bytes[13] == 0xFF && bytes[14] == 0xC0 &&
              bytes[15] == 0x00,
          "the payload length must be stored little endian");

  Prefix read;
  require(sr800::docstore::decodePrefix(bytes, read),
          "a well-formed envelope must decode");
  require(read.prefixVersion == written.prefixVersion &&
              read.reserved == written.reserved &&
              read.docVersion == written.docVersion &&
              read.byteLength == written.byteLength,
          "every envelope field must survive the round trip");

  uint8_t foreign[sr800::docstore::kPrefixBytes];
  memcpy(foreign, bytes, sizeof(foreign));
  foreign[1] = 'X';
  require(!sr800::docstore::decodePrefix(foreign, read),
          "a foreign magic must not decode");

  uint8_t future[sr800::docstore::kPrefixBytes];
  memcpy(future, bytes, sizeof(future));
  future[4] = 2;
  require(!sr800::docstore::decodePrefix(future, read),
          "an unknown prefix version must not decode as version 1");

  require(sr800::docstore::kPrefixBytes == 16,
          "the envelope is a wire format and must stay 16 bytes");
}

void testRunIdSanitization() {
  require(sr800::docstore::validRunId("a"), "a single character is a valid id");
  require(sr800::docstore::validRunId("2026-07-28.3_ethiopia-a1"),
          "letters, digits, dot, underscore and dash are all allowed");
  require(sr800::docstore::validRunId("012345678901234567890123"),
          "24 characters is the maximum and must be accepted");

  require(!sr800::docstore::validRunId(""), "an empty id must be rejected");
  require(!sr800::docstore::validRunId(nullptr),
          "a null id must be rejected rather than dereferenced");
  require(!sr800::docstore::validRunId("0123456789012345678901234"),
          "25 characters must be rejected");
  require(!sr800::docstore::validRunId("../secrets"),
          "a traversal attempt must be rejected");
  require(!sr800::docstore::validRunId("a/b"),
          "a path separator must never appear in an id");
  require(!sr800::docstore::validRunId("."),
          "a lone dot must be rejected even though dot is an allowed character");
  require(!sr800::docstore::validRunId(".."),
          "a lone double dot must be rejected");
  require(!sr800::docstore::validRunId("..."),
          "an all-dots id must be rejected");
  require(sr800::docstore::validRunId(".hidden"),
          "a leading dot is fine as long as the id is not all dots");
  require(!sr800::docstore::validRunId("run 1"),
          "a space must be rejected");
  require(!sr800::docstore::validRunId("run\\1"),
          "a backslash must be rejected");
  require(!sr800::docstore::validRunId("caf\xC3\xA9"),
          "non-ASCII bytes must be rejected");
  require(!sr800::docstore::validRunId("a%2e%2e"),
          "percent encoding must be rejected rather than decoded");

  char path[sr800::docstore::kMaxPathBytes];
  require(sr800::docstore::runPath(path, sizeof(path), "abc") &&
              strcmp(path, "/data/runs/abc.json") == 0,
          "a run path must be /data/runs/<id>.json");
  require(!sr800::docstore::runPath(path, sizeof(path), "../x"),
          "an invalid id must never produce a path");
  require(sr800::docstore::runPath(path, sizeof(path),
                                   "012345678901234567890123"),
          "the longest legal id must still fit kMaxPathBytes");

  require(sr800::docstore::collectionPath(path, sizeof(path),
                                          Collection::PROFILES) &&
              strcmp(path, "/data/profiles.json") == 0,
          "a collection path must be /data/<collection>.json");
  require(sr800::docstore::collectionPath(path, sizeof(path),
                                          Collection::CALIBRATIONS) &&
              strcmp(path, "/data/calibrations.json") == 0,
          "calibrations must map to its own file");

  Collection collection = Collection::META;
  require(sr800::docstore::collectionFromName("profiles", collection) &&
              collection == Collection::PROFILES,
          "profiles must resolve");
  require(sr800::docstore::collectionFromName("beans", collection) &&
              collection == Collection::BEANS,
          "beans must resolve");
  require(sr800::docstore::collectionFromName("calibrations", collection) &&
              collection == Collection::CALIBRATIONS,
          "calibrations must resolve");
  require(sr800::docstore::collectionFromName("meta", collection) &&
              collection == Collection::META,
          "meta must resolve");
  require(!sr800::docstore::collectionFromName("runs", collection),
          "runs is not a whole-collection document");
  require(!sr800::docstore::collectionFromName("Profiles", collection),
          "collection names are case sensitive");
  require(!sr800::docstore::collectionFromName("", collection),
          "an empty collection name must be rejected");
  require(!sr800::docstore::collectionFromName("delete", collection),
          "the delete endpoint must never be reachable as a collection");

  char id[sr800::docstore::kRunIdMaxChars + 1];
  require(sr800::docstore::runIdFromFileName("/data/runs/r-7.json", id,
                                             sizeof(id)) &&
              strcmp(id, "r-7") == 0,
          "a fully qualified entry name must yield its id");
  require(sr800::docstore::runIdFromFileName("r-7.json", id, sizeof(id)) &&
              strcmp(id, "r-7") == 0,
          "a bare entry name must yield its id");
  require(!sr800::docstore::runIdFromFileName("pending.tmp", id, sizeof(id)),
          "a temp file must not be listed as a run");
  require(!sr800::docstore::runIdFromFileName(".json", id, sizeof(id)),
          "a suffix with no id must not be listed");
  require(!sr800::docstore::runIdFromFileName("r-7.JSON", id, sizeof(id)),
          "the suffix is case sensitive");
  require(!sr800::docstore::runIdFromFileName(
              "0123456789012345678901234.json", id, sizeof(id)),
          "an over-long stem must not be listed");
}

void testBaseVersionParse() {
  uint32_t value = 99;
  require(sr800::docstore::parseBaseVersion("0", value) && value == 0,
          "base=0 must parse as the create sentinel");
  require(sr800::docstore::parseBaseVersion("7", value) && value == 7,
          "a plain decimal must parse");
  require(sr800::docstore::parseBaseVersion("007", value) && value == 7,
          "leading zeros are harmless");
  require(sr800::docstore::parseBaseVersion("4294967295", value) &&
              value == 0xFFFFFFFFu,
          "UINT32_MAX must parse");

  require(!sr800::docstore::parseBaseVersion("4294967296", value),
          "one past UINT32_MAX must be rejected, not wrapped");
  require(!sr800::docstore::parseBaseVersion("99999999999999999999", value),
          "an absurd value must be rejected without overflowing");
  require(!sr800::docstore::parseBaseVersion("", value),
          "an empty base must be rejected");
  require(!sr800::docstore::parseBaseVersion(nullptr, value),
          "a missing base must be rejected rather than dereferenced");
  require(!sr800::docstore::parseBaseVersion("-1", value),
          "a negative base must be rejected");
  require(!sr800::docstore::parseBaseVersion("+1", value),
          "a signed base must be rejected");
  require(!sr800::docstore::parseBaseVersion(" 1", value),
          "leading whitespace must be rejected");
  require(!sr800::docstore::parseBaseVersion("1 ", value),
          "trailing whitespace must be rejected");
  require(!sr800::docstore::parseBaseVersion("1.0", value),
          "a decimal point must be rejected");
  require(!sr800::docstore::parseBaseVersion("0x2", value),
          "hexadecimal must be rejected");
  require(!sr800::docstore::parseBaseVersion("latest", value),
          "a word must be rejected and never read as zero");
}

void testDeleteVerdicts() {
  require(sr800::docstore::evaluateDelete(true, 7, 7) == DeleteVerdict::OK,
          "delete accepts the exact stored version");
  require(sr800::docstore::evaluateDelete(true, 7, 6) == DeleteVerdict::CONFLICT,
          "delete rejects a stale stored version");
  require(sr800::docstore::evaluateDelete(true, 7, 0) == DeleteVerdict::CONFLICT,
          "base zero cannot delete an existing readable document");
  require(sr800::docstore::evaluateDelete(false, 0, 0) == DeleteVerdict::NOT_FOUND,
          "a matching delete of an absent document remains idempotently absent");
  require(sr800::docstore::evaluateDelete(false, 0, 7) == DeleteVerdict::CONFLICT,
          "a stale delete observes that another client already removed the document");
  require(sr800::docstore::evaluateDelete(true, 0, 0) == DeleteVerdict::OK,
          "base zero can deliberately remove an unreadable document");
}

void testRemoveVerdicts() {
  require(sr800::docstore::evaluateRemove(false, false) == RemoveVerdict::NOT_FOUND,
          "a missing path remains a 404");
  require(sr800::docstore::evaluateRemove(true, true) == RemoveVerdict::OK,
          "a successful filesystem removal commits the delete");
  require(sr800::docstore::evaluateRemove(true, false) == RemoveVerdict::FAILED,
          "a failed removal of an existing path is a 500, never absence");
}

void testWriteVerdicts() {
  constexpr uint32_t kTotal = 917504u;  // the real volume: 896 KB, 0xE0000
  uint32_t next = 0;

  require(sr800::docstore::evaluateWrite(false, 0, 0, 100,
                                         sr800::docstore::kRunMaxPayloadBytes,
                                         kTotal, 0, next) == WriteVerdict::OK &&
              next == 1,
          "creating with base=0 must succeed and start at version 1");
  require(sr800::docstore::evaluateWrite(true, 3, 3, 100,
                                         sr800::docstore::kRunMaxPayloadBytes,
                                         kTotal, 0, next) == WriteVerdict::OK &&
              next == 4,
          "a matching base must advance the version by exactly one");
  require(sr800::docstore::evaluateWrite(true, 4, 3, 100,
                                         sr800::docstore::kRunMaxPayloadBytes,
                                         kTotal, 0, next) ==
              WriteVerdict::CONFLICT,
          "a stale base must conflict");
  require(sr800::docstore::evaluateWrite(true, 4, 0, 100,
                                         sr800::docstore::kRunMaxPayloadBytes,
                                         kTotal, 0, next) ==
              WriteVerdict::CONFLICT,
          "base=0 against an existing document must conflict");
  require(sr800::docstore::evaluateWrite(false, 0, 1, 100,
                                         sr800::docstore::kRunMaxPayloadBytes,
                                         kTotal, 0, next) ==
              WriteVerdict::CONFLICT,
          "a non-zero base against a missing document must conflict");
  require(sr800::docstore::evaluateWrite(true, 0xFFFFFFFFu, 0xFFFFFFFFu, 100,
                                         sr800::docstore::kRunMaxPayloadBytes,
                                         kTotal, 0, next) == WriteVerdict::OK &&
              next == 1,
          "a wrapping version must never land on the create sentinel");

  require(sr800::docstore::evaluateWrite(
              false, 0, 0, sr800::docstore::kRunMaxPayloadBytes,
              sr800::docstore::kRunMaxPayloadBytes, kTotal, 0, next) ==
              WriteVerdict::OK,
          "a payload exactly at the cap must be accepted");
  require(sr800::docstore::evaluateWrite(
              false, 0, 0, sr800::docstore::kRunMaxPayloadBytes + 1,
              sr800::docstore::kRunMaxPayloadBytes, kTotal, 0, next) ==
              WriteVerdict::TOO_LARGE,
          "one byte over the run cap must be 413");
  require(sr800::docstore::evaluateWrite(
              false, 0, 0, sr800::docstore::kCollectionMaxPayloadBytes,
              sr800::docstore::kCollectionMaxPayloadBytes, kTotal, 0, next) ==
              WriteVerdict::OK,
          "a collection payload at the configured cap must be accepted");
  // The size check runs before the version check: a client that sends a
  // too-large body learns that, rather than being told to rebase and retry it.
  require(sr800::docstore::evaluateWrite(
              true, 4, 3, sr800::docstore::kRunMaxPayloadBytes + 1,
              sr800::docstore::kRunMaxPayloadBytes, kTotal, 0, next) ==
              WriteVerdict::TOO_LARGE,
          "an over-sized payload must be 413 even when the base is also stale");

  // The volume floor. Used is set so that exactly the floor plus the new file
  // remains; one byte more used, and the write must be refused.
  const uint32_t fileBytes =
      static_cast<uint32_t>(sr800::docstore::kPrefixBytes) + 100u;
  const uint32_t tightUsed =
      kTotal - sr800::docstore::kVolumeFloorBytes - fileBytes;
  require(sr800::docstore::evaluateWrite(false, 0, 0, 100,
                                         sr800::docstore::kRunMaxPayloadBytes,
                                         kTotal, tightUsed, next) ==
              WriteVerdict::OK,
          "a write that lands exactly on the floor must be allowed");
  require(sr800::docstore::evaluateWrite(false, 0, 0, 100,
                                         sr800::docstore::kRunMaxPayloadBytes,
                                         kTotal, tightUsed + 1, next) ==
              WriteVerdict::NO_ROOM,
          "one byte past the floor must be 507");

  // --- and the floor is the right SIZE, which is what matters -------------
  //
  // The promise is that an accepted document write can never force the
  // recordings archive to prune. That is not a property of the write path; it
  // is arithmetic between two constants, so it is asserted as arithmetic.
  //
  // Retention sweeps when: used + incomingLog + reserve > total
  // A document write is accepted only when: total - used >= floor
  // The promise holds iff: floor >= reserve + the largest possible incoming log
  require(sr800::docstore::kVolumeFloorBytes ==
              sr800::volume::kLogArchiveReserveBytes +
                  sr800::volume::kMaxIncomingLogBytes,
          "the write floor is the archive reserve plus a worst-case recording");
  require(sr800::volume::kMaxIncomingLogBytes ==
              sr800::volume::kLogArchiveHeaderBytes +
                  sr800::volume::kMaxRecordingSamples *
                      sr800::logcodec::kMaxEncodedSampleBytes +
                  sr800::logcodec::kMaxPlanEnvelopeBytes,
          "the worst-case recording includes the bounded plan envelope");
  require(sr800::volume::kMaxIncomingLogBytes == 121244u,
          "worst-case samples, v4 header, and plan total 121,244 bytes");
  require(sr800::docstore::kVolumeFloorBytes == 219548u,
          "the floor is 214 KB, not the 64 KB that let documents into the "
          "archive's reserve");

  // Drive the invariant rather than restating it: accept a write at the very
  // edge of the floor, then ask whether retention would now have work to do
  // for the largest recording the device could possibly present. It must not.
  {
    const uint32_t edgeUsed =
        kTotal - sr800::docstore::kVolumeFloorBytes - fileBytes;
    require(sr800::docstore::evaluateWrite(
                false, 0, 0, 100, sr800::docstore::kRunMaxPayloadBytes, kTotal,
                edgeUsed, next) == WriteVerdict::OK,
            "the edge write is accepted");
    const uint64_t usedAfter =
        static_cast<uint64_t>(edgeUsed) + static_cast<uint64_t>(fileBytes);
    const uint64_t sweepNeeds =
        usedAfter + sr800::volume::kMaxIncomingLogBytes +
        sr800::volume::kLogArchiveReserveBytes;
    require(sweepNeeds <= kTotal,
            "after the tightest accepted document write, a worst-case "
            "recording still fits without pruning anything");
  }
  // The floor is checked after the conflict check: a client with a stale base
  // must be told to rebase, not that the disk is full.
  require(sr800::docstore::evaluateWrite(true, 4, 3, 100,
                                         sr800::docstore::kRunMaxPayloadBytes,
                                         kTotal, kTotal, next) ==
              WriteVerdict::CONFLICT,
          "a stale base on a full volume is still a conflict");
  require(sr800::docstore::writeFitsVolume(kTotal, 0xFFFFFF00u, 0xFFFFFF00u) ==
              false,
          "the budget check must not overflow into a false accept");
}

void testStoreSequence() {
  FakeVolume volume(917504u);  // 896 KB, 0xE0000
  // 400 KB of recordings already on the shared volume. Comfortably clear of
  // the 219,548-byte write floor, so this block tests the concurrency contract and
  // not the budget - the budget has its own block above.
  volume.setOtherUsedBytes(400u * 1024u);

  char profilesPath[sr800::docstore::kMaxPathBytes];
  require(sr800::docstore::collectionPath(profilesPath, sizeof(profilesPath),
                                          Collection::PROFILES),
          "the profiles path must build");
  const std::string path(profilesPath);

  require(!volume.exists(path),
          "a never-written collection must not exist (404, not empty)");

  // A payload the firmware must never look inside: unbalanced braces, a NUL,
  // and non-UTF-8 bytes. Opaque means opaque.
  std::string payload = "{\"profiles\":[{\"n\":\"} not json \\\"\"}]";
  payload.push_back('\0');
  payload.append("\xFF\xFE binary tail");

  StoreResult result = storeDocument(volume, path, 0, payload,
                                     sr800::docstore::kCollectionMaxPayloadBytes);
  require(result.verdict == WriteVerdict::OK && result.version == 1,
          "the first write must create version 1");

  std::string readBack;
  require(volume.readPayload(path, readBack),
          "the stored document must read back");
  require(readBack.size() == payload.size() && readBack == payload,
          "the payload must survive byte for byte, NULs and all");

  result = storeDocument(volume, path, 0, "{}",
                         sr800::docstore::kCollectionMaxPayloadBytes);
  require(result.verdict == WriteVerdict::CONFLICT && result.version == 1,
          "a second create must conflict and report the current version");
  require(volume.readPayload(path, readBack) && readBack == payload,
          "a refused write must not have touched the stored bytes");

  result = storeDocument(volume, path, 1, "{\"profiles\":[]}",
                         sr800::docstore::kCollectionMaxPayloadBytes);
  require(result.verdict == WriteVerdict::OK && result.version == 2,
          "a matching base must store and advance to version 2");
  require(volume.readPayload(path, readBack) && readBack == "{\"profiles\":[]}",
          "the new payload must replace the old one exactly");

  result = storeDocument(volume, path, 1, "{\"stale\":true}",
                         sr800::docstore::kCollectionMaxPayloadBytes);
  require(result.verdict == WriteVerdict::CONFLICT && result.version == 2,
          "the losing writer must be told the current version to rebase onto");

  // An empty payload is a legitimate document and must stay distinct from
  // "never written".
  result = storeDocument(volume, path, 2, "",
                         sr800::docstore::kCollectionMaxPayloadBytes);
  require(result.verdict == WriteVerdict::OK && result.version == 3,
          "an empty payload must store");
  require(volume.exists(path) && volume.readPayload(path, readBack) &&
              readBack.empty(),
          "an empty document exists and is not the same as a missing one");

  // Delete resets the version history, so a later base=0 create succeeds.
  require(volume.remove(path), "delete must remove the document");
  require(!volume.exists(path), "the document must be gone");
  result = storeDocument(volume, path, 3, "{}",
                         sr800::docstore::kCollectionMaxPayloadBytes);
  require(result.verdict == WriteVerdict::CONFLICT,
          "the old version must not be usable after a delete");
  result = storeDocument(volume, path, 0, "{}",
                         sr800::docstore::kCollectionMaxPayloadBytes);
  require(result.verdict == WriteVerdict::OK && result.version == 1,
          "a base=0 create must succeed after a delete and restart at 1");

  // Per-run documents share the same machinery and their own bounded cap.
  char runPath[sr800::docstore::kMaxPathBytes];
  require(sr800::docstore::runPath(runPath, sizeof(runPath), "2026-07-28.3"),
          "a run path must build");
  const std::string run(runPath);
  const std::string tooBig(sr800::docstore::kRunMaxPayloadBytes + 1, 'x');
  require(storeDocument(volume, run, 0, tooBig,
                        sr800::docstore::kRunMaxPayloadBytes)
                  .verdict == WriteVerdict::TOO_LARGE,
          "a run document over the configured cap must be refused");
  require(!volume.exists(run),
          "a refused run write must not have created the file");
  require(storeDocument(volume, run, 0, std::string(2048, 'x'),
                        sr800::docstore::kRunMaxPayloadBytes)
                  .verdict == WriteVerdict::OK,
          "a 2 KB run document must store");

  // A corrupted envelope reads as unreadable, never as version 0 / empty.
  volume.corrupt(run, 0, 'X');
  Prefix prefix;
  require(!volume.readPrefix(run, prefix),
          "a corrupted envelope must not decode into a usable version");
}

// --- the replacement sequence, and every way it can fail -------------------
//
// This is the property with teeth. A write path that, when the rename over an
// existing document fails, DELETES the existing document and retries into the
// gap loses the user's only copy if that retry also fails - traded for a write
// that did not succeed either. The property under test is the absence of
// that trade: after ANY failure, the stored document is byte for byte what it
// was, and the client is told the write did not happen.

using sr800::docstore::ReplaceCallbacks;
using sr800::docstore::ReplaceOutcome;

constexpr char kTempPath[] = "/data/pending.tmp";
constexpr char kRealPath[] = "/data/profiles.json";

struct FaultyFs {
  std::map<std::string, std::string> files;
  std::vector<std::string> removed;
  bool writeSucceeds = true;
  bool renameSucceeds = true;
  int writeCalls = 0;
  int renameCalls = 0;
};

bool faultyWriteTemp(void* context) {
  FaultyFs& fs = *static_cast<FaultyFs*>(context);
  fs.writeCalls++;
  // A failing write still leaves a partial temp behind - that is what a short
  // write on a full or sick flash actually looks like, and the cleanup has to
  // cope with it rather than with a tidy no-op.
  fs.files[kTempPath] = fs.writeSucceeds ? "NEW-DOCUMENT" : "NEW-DOC";
  return fs.writeSucceeds;
}

bool faultyRenameOver(void* context) {
  FaultyFs& fs = *static_cast<FaultyFs*>(context);
  fs.renameCalls++;
  if (!fs.renameSucceeds) return false;
  fs.files[kRealPath] = fs.files[kTempPath];
  fs.files.erase(kTempPath);
  return true;
}

void faultyRemoveTemp(void* context) {
  FaultyFs& fs = *static_cast<FaultyFs*>(context);
  fs.removed.push_back(kTempPath);
  fs.files.erase(kTempPath);
}

ReplaceCallbacks callbacksFor(FaultyFs& fs) {
  ReplaceCallbacks callbacks;
  callbacks.writeTemp = &faultyWriteTemp;
  callbacks.renameOver = &faultyRenameOver;
  callbacks.removeTemp = &faultyRemoveTemp;
  callbacks.context = &fs;
  return callbacks;
}

bool holdsOriginal(const FaultyFs& fs) {
  const auto found = fs.files.find(kRealPath);
  return found != fs.files.end() && found->second == "OLD-DOCUMENT";
}

void testDurableReplacement() {
  // The ordinary path: the temp takes the real name and nothing is left over.
  {
    FaultyFs fs;
    fs.files[kRealPath] = "OLD-DOCUMENT";
    require(sr800::docstore::replaceDocument(callbacksFor(fs)) ==
                ReplaceOutcome::OK,
            "a healthy replacement succeeds");
    require(fs.files[kRealPath] == "NEW-DOCUMENT",
            "the new bytes are under the real name");
    require(fs.files.count(kTempPath) == 0, "no temp file survives a success");
    require(fs.renameCalls == 1, "the rename is attempted exactly once");
  }

  // The write fails. The rename must never be attempted, because there is
  // nothing complete to rename - and the stored document is untouched.
  {
    FaultyFs fs;
    fs.files[kRealPath] = "OLD-DOCUMENT";
    fs.writeSucceeds = false;
    require(sr800::docstore::replaceDocument(callbacksFor(fs)) ==
                ReplaceOutcome::WRITE_FAILED,
            "a short write reports WRITE_FAILED");
    require(holdsOriginal(fs),
            "a failed write leaves the stored document exactly as it was");
    require(fs.renameCalls == 0,
            "a failed write never reaches the rename");
    require(fs.files.count(kTempPath) == 0,
            "the partial temp is cleaned up");
  }

  // The rename fails over an EXISTING document. This is the case that matters: the
  // original must still be there, readable, at its old version, and there must
  // be no second attempt - because any second attempt worth making would have
  // had to remove the good copy first.
  {
    FaultyFs fs;
    fs.files[kRealPath] = "OLD-DOCUMENT";
    fs.renameSucceeds = false;
    require(sr800::docstore::replaceDocument(callbacksFor(fs)) ==
                ReplaceOutcome::RENAME_FAILED,
            "a refused rename reports RENAME_FAILED");
    require(holdsOriginal(fs),
            "a failed rename never destroys the stored document");
    require(fs.renameCalls == 1,
            "there is no delete-then-retry, so the rename runs once");
    require(fs.writeCalls == 1, "and the payload is not rewritten either");
    require(fs.files.count(kTempPath) == 0,
            "the homeless new bytes are discarded, not left to be found later");
    for (const std::string& path : fs.removed) {
      require(path != kRealPath,
              "no failure path ever removes the real document");
    }
  }

  // The same failure on a CREATE. Nothing existed, so nothing must exist after
  // it: a failed create must not leave a half-registered document behind.
  {
    FaultyFs fs;
    fs.renameSucceeds = false;
    require(sr800::docstore::replaceDocument(callbacksFor(fs)) ==
                ReplaceOutcome::RENAME_FAILED,
            "a failed create reports RENAME_FAILED too");
    require(fs.files.count(kRealPath) == 0,
            "a failed create leaves no document");
    require(fs.files.count(kTempPath) == 0, "and no temp file");
  }

  // A missing callback is a programming error; it must report failure rather
  // than dereference null.
  {
    FaultyFs fs;
    fs.files[kRealPath] = "OLD-DOCUMENT";
    ReplaceCallbacks callbacks = callbacksFor(fs);
    callbacks.renameOver = nullptr;
    require(sr800::docstore::replaceDocument(callbacks) ==
                ReplaceOutcome::WRITE_FAILED,
            "an incomplete callback set fails closed");
    require(holdsOriginal(fs), "and still does not touch the stored document");
  }
}

}  // namespace

int main() {
  testEnvelopeRoundTrip();
  testRunIdSanitization();
  testBaseVersionParse();
  testDeleteVerdicts();
  testWriteVerdicts();
  testRemoveVerdicts();
  testStoreSequence();
  testDurableReplacement();

  if (failures != 0) {
    std::cerr << failures << " document store assertion(s) failed\n";
    return 1;
  }
  std::cout << "document store tests passed\n";
  return 0;
}
