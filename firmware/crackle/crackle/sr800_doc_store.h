#ifndef SR800_DOC_STORE_H_
#define SR800_DOC_STORE_H_

#include <stddef.h>
#include <stdint.h>

#include "sr800_volume_budget.h"

// On-device document store: the pure layer.
//
// The controller owns the user's app data — roast metadata, bean lots,
// profiles, calibration fits — so a phone and a PC see identical state without
// either browser being the source of truth. The firmware treats every stored
// document as OPAQUE BYTES: it never parses the JSON it holds. All it owns is a
// 16-byte envelope carrying an optimistic-concurrency counter.
//
// Everything in this header is free of Arduino, LittleFS, and the WebServer so
// the wire format, the identifier rules, and the write decision can be verified
// on a host. The .ino keeps only the filesystem and HTTP glue.
namespace sr800 {
namespace docstore {

// --- the stored envelope, a wire format ---
//
//   offset 0  : magic 'C' 'D' 'O' 'C'
//   offset 4  : uint16 prefix version (little endian), currently 1
//   offset 6  : uint16 reserved, written as 0
//   offset 8  : uint32 document version (little endian)
//   offset 12 : uint32 payload byte length (little endian)
//   offset 16 : the payload, verbatim, unexamined
//
// Encoded and decoded byte by byte rather than memcpy'd from a struct: this
// layout has to outlive any compiler or target that happens to be building it.
constexpr size_t kPrefixBytes = 16;
constexpr uint16_t kPrefixVersion = 1;

// Identifier and size rules.
constexpr size_t kRunIdMaxChars = 24;
constexpr uint32_t kCollectionMaxPayloadBytes = 12u * 1024u;
constexpr uint32_t kRunMaxPayloadBytes = 8u * 1024u;
// A document write may never drive the shared volume below this much free
// space. NOT a number chosen here: it is the archive's own reserve plus the
// largest recording a single persist can present, derived in
// sr800_volume_budget.h. Sizing it any smaller - as a standalone 64 KB floor
// once did - lets a metadata write land inside the archive's reserve and force
// the next persist to prune stored recordings, which is exactly the thing the
// document store promises it can never do.
constexpr uint32_t kVolumeFloorBytes = volume::kDocumentWriteFloorBytes;
// "/data/runs/" + 24 + ".json" + NUL = 41; round up.
constexpr size_t kMaxPathBytes = 48;

enum class Collection : uint8_t { PROFILES = 0, BEANS, CALIBRATIONS, META };
constexpr size_t kCollectionCount = 4;

struct Prefix {
  uint16_t prefixVersion;
  uint16_t reserved;
  uint32_t docVersion;
  uint32_t byteLength;
};

// The outcome of a write request, before any byte is committed.
enum class WriteVerdict : uint8_t {
  OK = 0,        // 200 - store it
  TOO_LARGE,     // 413 - payload exceeds this document class's cap
  CONFLICT,      // 409 - base does not match the stored version
  NO_ROOM        // 507 - would leave the volume under the floor
};

enum class DeleteVerdict : uint8_t {
  OK = 0,
  NOT_FOUND,
  CONFLICT
};
enum class RemoveVerdict : uint8_t {
  OK = 0,
  NOT_FOUND,
  FAILED
};


void encodePrefix(const Prefix& prefix, uint8_t* out);

// False on a foreign magic, an unknown prefix version, or a null buffer. A
// document whose prefix does not decode is unreadable, never "empty".
bool decodePrefix(const uint8_t* in, Prefix& out);

// 1-24 characters of [A-Za-z0-9._-]. An id made entirely of dots is rejected
// as well: it is a path segment, and "." / ".." must never reach the volume.
bool validRunId(const char* id);

bool collectionFromName(const char* name, Collection& out);
const char* collectionName(Collection collection);

// Both return false when the buffer is too small; on success `out` holds a
// NUL-terminated absolute path on the LittleFS volume.
bool collectionPath(char* out, size_t capacity, Collection collection);
bool runPath(char* out, size_t capacity, const char* id);

// Directory entry name (bare or fully qualified) -> run id. False when the
// entry is not a well-formed run document, so foreign files are skipped rather
// than listed.
bool runIdFromFileName(const char* fileName, char* out, size_t capacity);

// Strict unsigned decimal. Rejects empty, signs, whitespace, trailing junk and
// anything above UINT32_MAX so a malformed `base` is a 400 and never a silent 0.
bool parseBaseVersion(const char* text, uint32_t& out);

// `newFileBytes` is the whole on-disk footprint (envelope + payload). The check
// is deliberately conservative: a write lands in a temp file and is renamed over
// the previous document, so both exist at once and the peak is used + new.
bool writeFitsVolume(uint32_t volumeTotalBytes, uint32_t volumeUsedBytes,
                     uint32_t newFileBytes);

// The whole write decision, in one testable place. `nextVersion` is only
// meaningful when the verdict is OK.
WriteVerdict evaluateWrite(bool exists, uint32_t currentVersion,
                           uint32_t baseVersion, uint32_t payloadBytes,
                           uint32_t maxPayloadBytes, uint32_t volumeTotalBytes,
                           uint32_t volumeUsedBytes, uint32_t& nextVersion);

// Delete is the same compare-and-swap boundary as write. A missing document has
// effective version 0; an unreadable document is passed as exists=true/version=0
// so base=0 can deliberately clear damaged data without treating it as absent.
DeleteVerdict evaluateDelete(bool exists, uint32_t currentVersion,
                             uint32_t baseVersion);
// Classify the filesystem commit separately from the compare-and-swap decision:
// an existing path whose remove call fails is a 500, never a 404.
RemoveVerdict evaluateRemove(bool exists, bool removed);


// --- durable replacement ---------------------------------------------------
//
// Committing a document is write-to-temp then rename-over-the-real-name. The
// filesystem arrives as three callbacks so BOTH failure paths can be driven on
// a host, because the interesting behaviour of this sequence is what it does
// when something goes wrong.
//
// THE RULE, and it has no exceptions: the document already on the volume is
// never removed and never becomes unreadable. Not to make room, not to clear
// the way for a retry, not on any path this function can take. Removing the
// existing document when the rename fails and retrying into the hole would mean
// that if the retry also failed, the only copy of the user's data was gone,
// traded for a write that did not even succeed. A failed write must cost
// nothing but the write.
//
// littlefs implements rename with POSIX replace semantics: renaming over an
// existing name is atomic and never unlinks the destination first. There is no
// platform case here that needs a backup-name dance, so there is none. If a
// future filesystem underneath this ever refuses the replace, the answer is a
// persistent backup name recovered at mount - not a delete.
struct ReplaceCallbacks {
  // Write the complete new document to the temp path. False on any short write
  // or failed open. Must never touch the real path.
  bool (*writeTemp)(void* context);
  // Rename the temp path over the real path, replacing whatever is there.
  bool (*renameOver)(void* context);
  // Remove the temp path. The result is deliberately ignored: a leftover temp
  // is discarded at the next mount, and it is never the user's data.
  void (*removeTemp)(void* context);
  void* context;
};

enum class ReplaceOutcome : uint8_t {
  OK = 0,        // the new bytes are under the real name
  WRITE_FAILED,  // 500 - the temp never completed; nothing else was touched
  RENAME_FAILED  // 500 - the temp completed but could not take the name;
                 //       the previous document is still there, intact
};

ReplaceOutcome replaceDocument(const ReplaceCallbacks& callbacks);

}  // namespace docstore
}  // namespace sr800

#endif  // SR800_DOC_STORE_H_
