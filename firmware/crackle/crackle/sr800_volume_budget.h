#ifndef SR800_VOLUME_BUDGET_H_
#define SR800_VOLUME_BUDGET_H_

#include <stdint.h>

#include "sr800_log_codec.h"

// The shared-volume budget: ONE definition of how the recordings archive and
// the document store divide a disk they both live on.
//
// Two subsystems write to the same LittleFS volume. The recordings archive
// prunes oldest-first to keep a working reserve free; the document store
// refuses a write (507) that would leave too little behind. Those two numbers
// are not independent, and when they lived apart they drifted: the archive
// worked to a 96 KB reserve while documents were allowed to fill the volume to
// within 64 KB, so a metadata write could land in the archive's reserve and
// force the very retention sweep the documentation promised it never could.
//
// So the floor is DERIVED here rather than chosen twice.
//
// ---------------------------------------------------------------------------
// THE INVARIANT
// ---------------------------------------------------------------------------
//
// Retention prunes when
//
//     used + incomingLogBytes + kLogArchiveReserveBytes > total
//
// A document write is allowed only when it leaves
//
//     total - used >= kDocumentWriteFloorBytes
//                  == kLogArchiveReserveBytes + kMaxIncomingLogBytes
//
// Substituting the second into the first: for every incoming recording no
// larger than kMaxIncomingLogBytes, the sweep's condition is false immediately
// after any accepted document write. A document can therefore never be the
// reason a stored recording is deleted. That is the whole promise, and it is
// one line of arithmetic rather than a coincidence between two constants.
//
// ---------------------------------------------------------------------------
// THE WORST-CASE INCOMING RECORDING, DERIVED HONESTLY
// ---------------------------------------------------------------------------
//
// A persist writes one archive header, one bounded plan envelope, and one
// encoded frame per sample held in RAM. All bounds are structural, not typical:
//
//   samples      kMaxRecordingSamples          = 4800   (the RAM log's capacity;
//                                                        it cannot hold more)
//   bytes/sample logcodec::kMaxEncodedSampleBytes = 25   (five channels x the
//                                                        five-byte ceiling of an
//                                                        unsigned LEB128 u32 -
//                                                        the same bound the
//                                                        encoder's frame buffer
//                                                        is sized to)
//   header       kLogArchiveHeaderBytes        = 220
//   plan         logcodec::kMaxPlanEnvelopeBytes = 1024
//
//   220 + 1024 + 4800 x 25 = 121,244 bytes
//
// This is deliberately the codec's own declared frame ceiling and not a
// measured figure. A real recording costs ~5 bytes/sample, and even a
// pathological one cannot exceed 15 (the temperature channels are bounded by
// the int16 domain and the level channels by 655 deci) - but the reserve exists
// for the case nobody predicted, so it is sized to what the format PERMITS.
// The unit change to deci-degrees does not move this number: the bound comes
// from the varint, not from what the varint happens to be carrying.
//
// The result is a 219,548-byte floor on a 896 KiB volume. That is a real cost, paid
// knowingly: the alternative is a promise that holds only for typical data.
namespace sr800 {
namespace volume {

// The archive's working reserve. Retention sweeps until this much would remain
// free after the incoming recording lands.
constexpr uint32_t kLogArchiveReserveBytes = 96u * 1024u;

// The RAM thermal log's capacity in samples. A persist can never present more
// than this, because the buffer stops accepting at exactly this count.
constexpr uint32_t kMaxRecordingSamples = 4800u;

// Version 4 self-identifying archive header. The sketch static_asserts sizeof(LogArchiveHeader)
// against this, so the two cannot disagree.
constexpr uint32_t kLogArchiveHeaderBytes = 220u;

// The largest file a single persist can produce.
constexpr uint32_t kMaxIncomingLogBytes =
    kLogArchiveHeaderBytes +
    kMaxRecordingSamples *
        static_cast<uint32_t>(logcodec::kMaxEncodedSampleBytes) +
    static_cast<uint32_t>(logcodec::kMaxPlanEnvelopeBytes);

// The free space a document write must leave behind. 507 below this.
constexpr uint32_t kDocumentWriteFloorBytes =
    kLogArchiveReserveBytes + kMaxIncomingLogBytes;

}  // namespace volume
}  // namespace sr800

#endif  // SR800_VOLUME_BUDGET_H_
