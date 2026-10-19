#ifndef SR800_LOG_CODEC_H_
#define SR800_LOG_CODEC_H_

#include <stddef.h>
#include <stdint.h>

// Recording codec: the on-disk form of an archived thermal recording.
//
// Current RAM capture already uses deci-degrees so its 12-byte row spans the sensor's full
// plausible range. Legacy raw archives and the live /thermal.csv can still carry centi-degrees;
// what goes to FLASH in the current codec is a MEASURED temperature stored in
// TENTHS of a degree. The hundredths were never information - the thermocouple
// is nowhere near accurate to 0.01 C, and writing them to disk spent bytes
// claiming a precision the sensor does not have.
//
// WHY TENTHS AND NOT WHOLE DEGREES. Whole degrees were the first design, and
// they were wrong for one specific reason: the passive decay tail. Once the fan
// stops, the roaster gives up heat at a fraction of a degree per second, and
// that tail is the single most fit-critical stretch of the recording - it is
// what the loss and tau coefficients are regressed from. At whole-degree
// resolution a 0.1 C/s decay is not a curve at all; it is a staircase of
// ten-second flats, and a fit run over it reads the flats as the signal. The
// hundredths were noise, but the tenths are the measurement. Tenths cost
// essentially nothing: a varint token is one byte for any delta up to +/-6.3
// C/s, which no thermal process in this machine approaches.
//
// Fitted model coefficients, R2/tau, and authored profile setpoints are NOT
// measurements and keep their full precision elsewhere; this rounding applies
// only to the recorded series.
//
// Everything here is free of Arduino, LittleFS and the WebServer so the frame
// layout can be proven on a host. The sketch keeps only the filesystem glue.
//
// ---------------------------------------------------------------------------
// THE FRAME, BYTE-PRECISELY
// ---------------------------------------------------------------------------
//
// The encoded payload is a bare concatenation of per-sample frames. It carries
// no header of its own: the sample count, the byte length, the CRC32 and the
// codec id all live in the archive header the sketch writes ahead of it, so a
// reader knows how much payload to expect before it reads any of it.
//
// Each frame is five unsigned LEB128 varints, in this order and no other:
//
//   1. TIME    zigzag(dt - prevDt), dt = tMs - prevTMs
//                                                    prevTMs  starts at 0
//                                                    prevDt   starts at 0
//   2. TC      0                    when missing
//              zigzag(deci - prevTC) + 1  otherwise  prevTC   starts at 0
//   3. CJ      0                    when missing
//              zigzag(deci - prevCJ) + 1  otherwise  prevCJ   starts at 0
//   4. FAN     zigzag(deci - prevFan)                prevFan  starts at 0
//   5. HEAT    zigzag(deci - prevHeat)               prevHeat starts at 0
//
// All four non-time channels are deci-units; only their meaning differs. The
// unit change from whole degrees to tenths moved no byte in this layout - it
// is the same five tokens with a finer quantum behind two of them.
//
// Every predictor starts at zero, so the first sample of a recording encodes
// its own absolute value - there is no separate "first sample" rule to get
// wrong. A predictor advances ONLY when the channel carried a value: a missing
// temperature leaves `prevTC` exactly where the last real reading left it, so a
// dropout costs one byte and does not disturb the deltas around it.
//
// TIME is the one channel carrying a second-order predictor, and it earns it. A
// first-order dt on a 1 Hz recording is ~1000 every single sample: it never
// fits one varint byte, so a third of the whole stream would go on restating an
// interval that never changes. The residual against the PREVIOUS interval is 0
// in the steady state and +/-5 under the loop's real scheduling jitter - one
// byte either way. It stays self-describing (nothing is read from the archive
// header, so a future logging rate needs no format change) and the timestamps
// it reconstructs are still exact to the millisecond.
//
// The `+ 1` on the two temperature channels is what makes "missing" expressible
// without a per-sample flags byte: token 0 is the escape and can never collide
// with a temperature, because every real delta - zero included - maps to 1 or
// above. A flags byte would have cost a sixth of the stream to describe an
// event that almost never happens.
//
//   varint : unsigned LEB128, 7 payload bits per byte, low group first, high
//            bit set on every byte but the last. At most 5 bytes for a u32.
//   zigzag : (n << 1) ^ (n >> 31) - small magnitudes of either sign stay small.
//
// UNITS ON DISK, and they are the whole point of the format:
//
//   TIME     milliseconds since the first sample, exact, never rounded.
//   TC / CJ  DECI-DEGREES C (centi / 10), rounded half away from zero. This is
//            lossy and it is meant to be - one significant figure past what the
//            sensor can support, and one finer than the decay tail needs.
//   FAN/HEAT DECI-LEVELS (milli / 100). Levels are commanded in 0.1 steps, so
//            this is lossless for every value the controller can produce; a
//            value off the step grid rounds half away from zero.
//
// A steady 1 Hz recording therefore costs one byte per channel - 5 bytes per
// sample against the 12 the raw struct spent - and pays more only where
// something actually happened. A temperature channel leaves one byte only when
// it moves more than 63 deci (6.3 C) between consecutive samples.
//
// ROUND TRIP: decode(encode(s)) == quantize(s) exactly, for every sample,
// including missing ones; and encode(decode(p)) == p byte for byte.
namespace sr800 {
namespace logcodec {

// The frozen raw sample layout - what version 1 and version 2 archives store
// and what the sketch holds in RAM. 12 bytes, little endian.
constexpr size_t kRawSampleBytes = 12;
// Centi-degree sentinel meaning "no reading". Shared by both temperatures.
constexpr int16_t kMissingCenti = INT16_MIN;

// Codec ids, as stored in the version 3 archive header.
constexpr uint8_t kCodecRaw = 0;          // reserved: version 2's raw payload
constexpr uint8_t kCodecDeltaVarint = 1;  // the format documented above

// Worst case bytes one frame can occupy: five varints of five bytes. This is
// the encoder's output-buffer contract AND the number the shared volume budget
// sizes its worst-case recording from (see sr800_volume_budget.h), so it is
// the format's permitted ceiling rather than a measured one.
constexpr size_t kMaxEncodedSampleBytes = 25;

// Deci-levels can never exceed this: `fanMilli`/`heatMilli` are uint16.
constexpr int32_t kMaxDeciLevel = 655;

// A sample exactly as RAM holds it.
struct RawSample {
  uint32_t tMs;
  int16_t thermocoupleCenti;  // kMissingCenti = no reading
  int16_t coldJunctionCenti;  // kMissingCenti = no reading
  uint16_t fanMilli;
  uint16_t heatMilli;
};

// A sample in the units the archive stores. This is what a reader gets back,
// and printing it is honest: the integer IS the stored value, and dividing it
// by ten is the only arithmetic a reader may do to it.
struct Sample {
  uint32_t tMs;
  int16_t thermocoupleDeci;  // deci-degrees C; meaningless unless valid
  int16_t coldJunctionDeci;  // deci-degrees C; meaningless unless valid
  uint16_t fanDeci;          // level x 10
  uint16_t heatDeci;         // level x 10
  bool thermocoupleValid;
  bool coldJunctionValid;
};

// Round half away from zero. -125 -> -13, 125 -> 13, so the rule does not
// drift toward zero the way truncation would over a long cooling tail - which
// matters precisely because that tail is what the loss fit reads.
int16_t centiToDeciDegrees(int16_t centi);
uint16_t milliToDeci(uint16_t milli);

// The lossy step, isolated so a test can pin it. Applying it twice changes
// nothing, which is what makes the round-trip rule statable at all.
Sample quantize(const RawSample& raw);

// Decode the frozen 12-byte raw layout. Used by the sketch to read version 1
// and version 2 payloads, so that layout is host-verified rather than implied
// by a struct definition the compiler happens to agree with.
bool decodeRawSample(const uint8_t* in, size_t available, RawSample& out);

// --- encoding ---

struct Encoder {
  int32_t prevTMs;
  int32_t prevDt;
  int32_t prevTc;
  int32_t prevCj;
  int32_t prevFan;
  int32_t prevHeat;
};

void encodeBegin(Encoder& state);

// Appends one frame to `out`, which must have room for kMaxEncodedSampleBytes.
// Returns the number of bytes written. `sample` is taken as already quantized;
// values outside the storable domain are clamped rather than silently wrapping.
size_t encodeSample(Encoder& state, const Sample& sample, uint8_t* out);

// quantize() then encodeSample(): the path the sketch uses at persist time.
size_t encodeRawSample(Encoder& state, const RawSample& raw, uint8_t* out);

// --- decoding, one sample at a time ---
//
// The decoder never owns a buffer and never reads a file: the caller feeds it
// whatever slice of the payload it happens to hold. NEED_MORE means the slice
// ended mid-frame - refill and call again with the same unconsumed bytes at the
// front. That is what keeps CSV serving from ever buffering a whole recording.

enum class DecodeStatus : uint8_t {
  OK = 0,     // `out` holds a sample; `consumed` bytes were used
  NEED_MORE,  // the slice ended mid-frame; nothing was consumed
  MALFORMED   // the bytes cannot be a frame; the stream is unusable
};

struct Decoder {
  int32_t prevTMs;
  int32_t prevDt;
  int32_t prevTc;
  int32_t prevCj;
  int32_t prevFan;
  int32_t prevHeat;
};

void decodeBegin(Decoder& state);

DecodeStatus decodeSample(Decoder& state, const uint8_t* in, size_t available,
                          size_t& consumed, Sample& out);

// --- immutable roast-plan provenance ----------------------------------------
//
// Codec 2 prefixes the existing sample stream with this compact envelope. The
// accepted initial plan is immutable; journey edits are timestamped full-plan
// snapshots in RAM but encoded as field deltas against the preceding plan.
// Manual instructions reuse one PlanItem per journal event: fan/heat are the
// requested levels and fanMin/heatMin are the effective levels.
constexpr uint8_t kCodecDeltaVarintPlan = 2;
constexpr size_t kMaxTimedPlanItems = 24;
constexpr size_t kMaxCalibrationPlanItems = 48;
constexpr size_t kMaxPlanItems = kMaxCalibrationPlanItems;
constexpr size_t kMaxPlanJournalEvents = 32;
constexpr size_t kMaxPlanEnvelopeBytes = 1024;
constexpr uint8_t kPlanEnvelopeMagic = 0xC7;
constexpr uint8_t kPlanEnvelopeVersion = 1;

enum class PlanMode : uint8_t { TIMED = 1, JOURNEY = 2, MANUAL = 3, CALIBRATION = 4 };

struct PlanItem {
  int16_t startDeci;
  int16_t endDeci;
  uint16_t durationSec;
  uint8_t fanDeci;
  uint8_t heatDeci;
  uint8_t fanMinDeci;
  uint8_t fanMaxDeci;
  uint8_t heatMinDeci;
  uint8_t heatMaxDeci;
};

struct PlanJournalEvent {
  uint16_t elapsedSec;
  uint32_t planRevision;
  /** Timed events change one step; ignored for journey/manual events. */
  uint8_t itemIndex;
  uint8_t itemCount;
  PlanItem items[12];
};

struct PlanProvenance {
  PlanMode mode;
  uint8_t itemCount;
  PlanItem items[kMaxPlanItems];
  uint8_t journalCount;
  /** CALIBRATION-only program gates; zero for roast modes. */
  uint8_t minimumDwellSec;
  uint8_t settleSeconds;
  uint8_t settleBandTenthsC;
  PlanJournalEvent journal[kMaxPlanJournalEvents];
};

// Returns zero on invalid input or insufficient capacity.
size_t encodePlanProvenance(const PlanProvenance& plan, uint8_t* out,
                            size_t capacity);
// Decodes exactly one envelope from the front and reports its byte length.
bool decodePlanProvenance(const uint8_t* data, size_t length,
                          PlanProvenance& out, size_t& consumed);
// Syntax/domain validation without materializing the large decoded journal.
bool validatePlanEnvelope(const uint8_t* data, size_t length,
                          size_t& consumed);

// --- CRC32 (IEEE 802.3: reflected 0xEDB88320, init/final xor 0xFFFFFFFF) ---
//
// Stored in the archive header and checked before a single row is served. A
// recording that flipped a bit in flash must read as broken, not as a roast
// that briefly hit 300 C.
constexpr uint32_t kCrc32Init = 0xFFFFFFFFu;
uint32_t crc32Update(uint32_t crc, const uint8_t* data, size_t length);
inline uint32_t crc32Finish(uint32_t crc) { return crc ^ 0xFFFFFFFFu; }

// ---------------------------------------------------------------------------
// THE ARCHIVE FILE, VALIDATED AS A BUFFER
// ---------------------------------------------------------------------------
//
// Everything above describes the payload. What follows describes the whole
// FILE - header and payload together - and exists for exactly one caller:
// `POST /api/logs/restore`, the only path by which recording bytes enter the
// archive from off the device.
//
// Every other writer of `/logs/<id>.crk` is the encoder above, which cannot
// produce a file the reader would refuse. A restored file was produced by
// something else - a browser, a zip, a backup that sat on a disk for a year -
// so the format has to be CHECKED rather than assumed, and the checking has to
// be provable on a host rather than reasoned about on a device.
//
// The header is read BY BYTE OFFSET, not by casting a struct over the buffer.
// The sketch owns the struct (`LogArchiveHeader`) and static_asserts its
// `offsetof`s against the constants below, so the two cannot drift; but this
// layout is a wire format that has to outlive any compiler that happens to be
// building it, and a wire format is decoded by offset. The same reasoning the
// document store's envelope is decoded under.
//
// Validation is deliberately STRICTER than the serving reader. The reader
// checks the v4 header, provenance, and whole-file CRC. This also DECODES the payload: a
// restore is the one moment the device can find out that a file which
// checksums correctly is nonetheless not a recording, and refusing then costs
// one pass over ~9 KB, while accepting means an archive entry that lists fine
// and serves a truncated CSV forever.

constexpr uint32_t kArchiveMagic = 0x4C4B5243u;  // "CRKL"
// Version 4 is the first self-identifying recording. This product has not
// shipped with user data, so identity-less v1-v3 files fail closed instead of
// being attributed to whichever device happens to hold them now.
constexpr uint16_t kArchiveVersionMin = 4;
constexpr uint16_t kArchiveVersionMax = 4;
constexpr size_t kArchiveHeaderV1Bytes = 32;
constexpr size_t kArchiveHeaderV2Bytes = 92;
constexpr size_t kArchiveHeaderV3Bytes = 104;
constexpr size_t kArchiveDeviceIdBytes = 24;
constexpr size_t kArchiveModelIdBytes = 24;
constexpr size_t kArchiveDisplayNameBytes = 32;
constexpr size_t kArchiveFirmwareVersionBytes = 24;
constexpr size_t kArchiveHeaderV4Bytes = 220;
// Version 2's `zoneCount` may not exceed the journey zone maximum. Stated here
// as a number rather than pulled from sr800_journey_control.h so this header
// stays dependency-free; the sketch static_asserts the two agree.
constexpr uint8_t kArchiveMaxZones = 12;

// Byte offsets of every field this validator reads. The fields it does not
// read - boot, epoch, duration, interval, name, attainments - are identity, not
// structure: a wrong one makes a recording mislabelled, never unreadable.
constexpr size_t kArchiveOffsetMagic = 0;
constexpr size_t kArchiveOffsetVersion = 4;
constexpr size_t kArchiveOffsetSource = 6;
constexpr size_t kArchiveOffsetLogId = 8;
constexpr size_t kArchiveOffsetSampleCount = 24;
constexpr size_t kArchiveOffsetZoneCount = 64;
constexpr size_t kArchiveOffsetEncodedBytes = 92;
constexpr size_t kArchiveOffsetCrc32 = 96;
constexpr size_t kArchiveOffsetCodec = 100;
constexpr size_t kArchiveOffsetRoastStopSec = 101;
constexpr size_t kArchiveOffsetRoastEndReason = 103;
constexpr size_t kArchiveOffsetSourceDeviceId = 104;
constexpr size_t kArchiveOffsetSourceModelId = 128;
constexpr size_t kArchiveOffsetSourceDisplayName = 152;
constexpr size_t kArchiveOffsetSourceFirmwareVersion = 184;
constexpr size_t kArchiveOffsetOriginLogId = 208;
constexpr size_t kArchiveOffsetProvenanceFlags = 212;
constexpr size_t kArchiveOffsetThermocoupleOffsetCenti = 213;
constexpr size_t kArchiveOffsetThermocoupleOffsetFlags = 215;
constexpr size_t kArchiveOffsetProvenanceCrc32 = 216;
constexpr uint8_t kArchiveProvenanceSimulated = 0x01;
constexpr uint8_t kArchivePassiveTailIncomplete = 0x02;
constexpr uint8_t kArchiveThermocoupleOffsetPresent = 0x01;
constexpr int16_t kArchiveThermocoupleOffsetMinimumCenti = -2500;
constexpr int16_t kArchiveThermocoupleOffsetMaximumCenti = 2500;

// What a valid self-identifying version 4 file turned out to be.
struct ArchiveSummary {
  uint16_t version;
  uint8_t source;
  uint8_t codec;
  uint32_t logId;
  uint32_t sampleCount;
  uint32_t encodedBytes;
  uint32_t crc32;
  uint32_t headerBytes;
  char sourceDeviceId[kArchiveDeviceIdBytes + 1];
  char sourceModelId[kArchiveModelIdBytes + 1];
  char sourceDisplayName[kArchiveDisplayNameBytes + 1];
  char sourceFirmwareVersion[kArchiveFirmwareVersionBytes + 1];
  uint32_t originLogId;
  bool simulated;
  bool thermocoupleOffsetPresent;
  int16_t thermocoupleOffsetCenti;
};

// Which check failed. This is a contract, not a diagnostic: the restore
// endpoint puts the name straight into its 400 so the operator is told what is
// wrong with the file rather than that something is.
enum class ArchiveVerdict : uint8_t {
  OK = 0,
  TRUNCATED_HEADER,   // fewer bytes than the version's header needs
  BAD_MAGIC,          // not "CRKL" - not an archive file at all
  BAD_VERSION,        // 0, or newer than this firmware knows how to read
  SAMPLE_COUNT,       // more samples than the RAM log could ever have held
  ZONE_COUNT,         // v2+ zoneCount past the journey maximum
  BAD_CODEC,          // v4 codec id this firmware cannot decode
  SIZE_MISMATCH,      // length != header + payload, per the version's rule
  CRC_MISMATCH,       // v4 header identity/payload checksum mismatch
  PROVENANCE,         // v4 source identity is missing or malformed
  PAYLOAD_UNDECODABLE // checksums fine, is not a recording
};

// Machine-readable token (`crc_mismatch`, ...) and a sentence for a human.
const char* archiveVerdictName(ArchiveVerdict verdict);
const char* archiveVerdictReason(ArchiveVerdict verdict);

// `maxSamples` is the RAM log's capacity, passed in rather than included so
// this header stays free of the volume budget that already includes it.
ArchiveVerdict validateArchiveBuffer(const uint8_t* data, size_t length,
                                     uint32_t maxSamples, ArchiveSummary& out);

// Multipart upload writes the recording to a temp file in bounded chunks.
// Validation therefore reads at offsets instead of copying the file into RAM.
// `readAt` returns the bytes read; anything shorter than requested is failure.
using ArchiveReadAt =
    size_t (*)(void* context, size_t offset, uint8_t* out, size_t length);
ArchiveVerdict validateArchiveReader(ArchiveReadAt readAt, void* context,
                                     size_t length, uint32_t maxSamples,
                                     ArchiveSummary& out);
}  // namespace logcodec
}  // namespace sr800

#endif  // SR800_LOG_CODEC_H_
