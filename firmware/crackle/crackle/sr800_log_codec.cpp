#include "sr800_log_codec.h"

#include <cstring>

namespace sr800 {
namespace logcodec {
namespace {

// Deci-degrees ride in an int16, so the storable band is -3276.8 to +3276.7 C.
// A centi-degree reading (int16, -327.68 to +327.67 C) can never leave it.
constexpr int32_t kDeciDegreeMin = -32768;
constexpr int32_t kDeciDegreeMax = 32767;
// Sample offsets are milliseconds since the recording's first sample. The
// format's domain stops at 2^31-1 ms (24.8 days) so every predictor can stay a
// plain int32; the RAM log holds 80 minutes.
constexpr int64_t kMaxOffsetMs = 2147483647ll;

uint32_t zigzagEncode(int32_t value) {
  return (static_cast<uint32_t>(value) << 1) ^
         static_cast<uint32_t>(value >> 31);
}

int32_t zigzagDecode(uint32_t value) {
  return static_cast<int32_t>((value >> 1) ^ (~(value & 1u) + 1u));
}

size_t putVarint(uint32_t value, uint8_t* out) {
  size_t written = 0;
  while (value >= 0x80u) {
    out[written++] = static_cast<uint8_t>(value) | 0x80u;
    value >>= 7;
  }
  out[written++] = static_cast<uint8_t>(value);
  return written;
}

// Returns false when the slice ended mid-varint (`consumed` untouched) or when
// the encoding is illegal - more than five bytes, or a fifth byte carrying more
// than the 4 bits a u32 has left. `overlong` distinguishes the two: a truncated
// varint is a refill, an illegal one is a corrupt stream.
bool takeVarint(const uint8_t* in, size_t available, size_t& consumed,
                uint32_t& out, bool& overlong) {
  uint32_t value = 0;
  size_t index = 0;
  overlong = false;
  while (index < available) {
    const uint8_t byte = in[index];
    if (index == 4 && (byte & 0xF0u) != 0) {
      overlong = true;
      return false;
    }
    value |= static_cast<uint32_t>(byte & 0x7Fu) << (7 * index);
    index++;
    if ((byte & 0x80u) == 0) {
      consumed = index;
      out = value;
      return true;
    }
    if (index == 5) {
      overlong = true;
      return false;
    }
  }
  return false;
}

int32_t clampToDeciDegrees(int32_t value) {
  if (value < kDeciDegreeMin) return kDeciDegreeMin;
  if (value > kDeciDegreeMax) return kDeciDegreeMax;
  return value;
}

int32_t clampToDeciLevel(int32_t value) {
  if (value < 0) return 0;
  if (value > kMaxDeciLevel) return kMaxDeciLevel;
  return value;
}

uint16_t readU16(const uint8_t* in) {
  return static_cast<uint16_t>(in[0]) |
         static_cast<uint16_t>(static_cast<uint16_t>(in[1]) << 8);
}

uint32_t readU32(const uint8_t* in) {
  return static_cast<uint32_t>(in[0]) |
         (static_cast<uint32_t>(in[1]) << 8) |
         (static_cast<uint32_t>(in[2]) << 16) |
         (static_cast<uint32_t>(in[3]) << 24);
}

}  // namespace

int16_t centiToDeciDegrees(int16_t centi) {
  const int32_t value = static_cast<int32_t>(centi);
  const int32_t rounded = value >= 0 ? (value + 5) / 10 : -((-value + 5) / 10);
  return static_cast<int16_t>(rounded);
}

uint16_t milliToDeci(uint16_t milli) {
  return static_cast<uint16_t>((static_cast<uint32_t>(milli) + 50u) / 100u);
}

Sample quantize(const RawSample& raw) {
  Sample sample = {};
  sample.tMs = raw.tMs;
  sample.thermocoupleValid = raw.thermocoupleCenti != kMissingCenti;
  sample.coldJunctionValid = raw.coldJunctionCenti != kMissingCenti;
  sample.thermocoupleDeci = sample.thermocoupleValid
      ? centiToDeciDegrees(raw.thermocoupleCenti) : 0;
  sample.coldJunctionDeci = sample.coldJunctionValid
      ? centiToDeciDegrees(raw.coldJunctionCenti) : 0;
  sample.fanDeci = milliToDeci(raw.fanMilli);
  sample.heatDeci = milliToDeci(raw.heatMilli);
  return sample;
}

bool decodeRawSample(const uint8_t* in, size_t available, RawSample& out) {
  if (in == nullptr || available < kRawSampleBytes) return false;
  out.tMs = static_cast<uint32_t>(in[0]) |
            (static_cast<uint32_t>(in[1]) << 8) |
            (static_cast<uint32_t>(in[2]) << 16) |
            (static_cast<uint32_t>(in[3]) << 24);
  out.thermocoupleCenti = static_cast<int16_t>(readU16(in + 4));
  out.coldJunctionCenti = static_cast<int16_t>(readU16(in + 6));
  out.fanMilli = readU16(in + 8);
  out.heatMilli = readU16(in + 10);
  return true;
}

void encodeBegin(Encoder& state) {
  state.prevTMs = 0;
  state.prevDt = 0;
  state.prevTc = 0;
  state.prevCj = 0;
  state.prevFan = 0;
  state.prevHeat = 0;
}

size_t encodeSample(Encoder& state, const Sample& sample, uint8_t* out) {
  size_t written = 0;

  const int32_t tMs = static_cast<int32_t>(sample.tMs);
  const int32_t dt = tMs - state.prevTMs;
  written += putVarint(zigzagEncode(dt - state.prevDt), out + written);
  state.prevTMs = tMs;
  state.prevDt = dt;

  if (sample.thermocoupleValid) {
    const int32_t value = clampToDeciDegrees(sample.thermocoupleDeci);
    written += putVarint(zigzagEncode(value - state.prevTc) + 1u, out + written);
    state.prevTc = value;
  } else {
    written += putVarint(0, out + written);
  }

  if (sample.coldJunctionValid) {
    const int32_t value = clampToDeciDegrees(sample.coldJunctionDeci);
    written += putVarint(zigzagEncode(value - state.prevCj) + 1u, out + written);
    state.prevCj = value;
  } else {
    written += putVarint(0, out + written);
  }

  const int32_t fan = clampToDeciLevel(sample.fanDeci);
  written += putVarint(zigzagEncode(fan - state.prevFan), out + written);
  state.prevFan = fan;

  const int32_t heat = clampToDeciLevel(sample.heatDeci);
  written += putVarint(zigzagEncode(heat - state.prevHeat), out + written);
  state.prevHeat = heat;

  return written;
}

size_t encodeRawSample(Encoder& state, const RawSample& raw, uint8_t* out) {
  return encodeSample(state, quantize(raw), out);
}

void decodeBegin(Decoder& state) {
  state.prevTMs = 0;
  state.prevDt = 0;
  state.prevTc = 0;
  state.prevCj = 0;
  state.prevFan = 0;
  state.prevHeat = 0;
}

DecodeStatus decodeSample(Decoder& state, const uint8_t* in, size_t available,
                          size_t& consumed, Sample& out) {
  if (in == nullptr || available == 0) return DecodeStatus::NEED_MORE;
  size_t offset = 0;
  uint32_t tokens[5] = {0, 0, 0, 0, 0};
  for (size_t channel = 0; channel < 5; ++channel) {
    size_t used = 0;
    bool overlong = false;
    if (!takeVarint(in + offset, available - offset, used, tokens[channel],
                    overlong)) {
      return overlong ? DecodeStatus::MALFORMED : DecodeStatus::NEED_MORE;
    }
    offset += used;
  }

  // Every channel is range-checked against what the units can physically hold
  // before any predictor advances, so a corrupt frame cannot poison the samples
  // that follow it - the stream stops instead.
  Sample sample = {};

  const int64_t dt = static_cast<int64_t>(state.prevDt) +
                     static_cast<int64_t>(zigzagDecode(tokens[0]));
  if (dt < -2147483648ll || dt > 2147483647ll) return DecodeStatus::MALFORMED;
  const int64_t tMs = static_cast<int64_t>(state.prevTMs) + dt;
  if (tMs < 0 || tMs > kMaxOffsetMs) return DecodeStatus::MALFORMED;
  sample.tMs = static_cast<uint32_t>(tMs);

  int32_t nextTc = state.prevTc;
  if (tokens[1] == 0) {
    sample.thermocoupleValid = false;
  } else {
    const int64_t value = static_cast<int64_t>(state.prevTc) +
                          static_cast<int64_t>(zigzagDecode(tokens[1] - 1u));
    if (value < kDeciDegreeMin || value > kDeciDegreeMax) {
      return DecodeStatus::MALFORMED;
    }
    nextTc = static_cast<int32_t>(value);
    sample.thermocoupleValid = true;
    sample.thermocoupleDeci = static_cast<int16_t>(value);
  }

  int32_t nextCj = state.prevCj;
  if (tokens[2] == 0) {
    sample.coldJunctionValid = false;
  } else {
    const int64_t value = static_cast<int64_t>(state.prevCj) +
                          static_cast<int64_t>(zigzagDecode(tokens[2] - 1u));
    if (value < kDeciDegreeMin || value > kDeciDegreeMax) {
      return DecodeStatus::MALFORMED;
    }
    nextCj = static_cast<int32_t>(value);
    sample.coldJunctionValid = true;
    sample.coldJunctionDeci = static_cast<int16_t>(value);
  }

  const int64_t fan = static_cast<int64_t>(state.prevFan) +
                      static_cast<int64_t>(zigzagDecode(tokens[3]));
  if (fan < 0 || fan > kMaxDeciLevel) return DecodeStatus::MALFORMED;
  const int64_t heat = static_cast<int64_t>(state.prevHeat) +
                       static_cast<int64_t>(zigzagDecode(tokens[4]));
  if (heat < 0 || heat > kMaxDeciLevel) return DecodeStatus::MALFORMED;
  sample.fanDeci = static_cast<uint16_t>(fan);
  sample.heatDeci = static_cast<uint16_t>(heat);

  state.prevTMs = static_cast<int32_t>(sample.tMs);
  state.prevDt = static_cast<int32_t>(dt);
  state.prevTc = nextTc;
  state.prevCj = nextCj;
  state.prevFan = static_cast<int32_t>(fan);
  state.prevHeat = static_cast<int32_t>(heat);

  consumed = offset;
  out = sample;
  return DecodeStatus::OK;
}


namespace {

struct PlanWriter {
  uint8_t* out;
  size_t capacity;
  size_t at;
  bool byte(uint8_t value) {
    if (at >= capacity) return false;
    out[at++] = value;
    return true;
  }
  bool u16(uint16_t value) {
    return byte(static_cast<uint8_t>(value)) &&
           byte(static_cast<uint8_t>(value >> 8));
  }
  bool varint(uint32_t value) {
    uint8_t encoded[5];
    const size_t count = putVarint(value, encoded);
    if (count > capacity - at) return false;
    memcpy(out + at, encoded, count);
    at += count;
    return true;
  }
  bool signedVarint(int32_t value) { return varint(zigzagEncode(value)); }
};

struct PlanReader {
  const uint8_t* data;
  size_t length;
  size_t at;
  bool byte(uint8_t& value) {
    if (at >= length) return false;
    value = data[at++];
    return true;
  }
  bool u16(uint16_t& value) {
    uint8_t lo = 0;
    uint8_t hi = 0;
    if (!byte(lo) || !byte(hi)) return false;
    value = static_cast<uint16_t>(lo) |
            static_cast<uint16_t>(static_cast<uint16_t>(hi) << 8);
    return true;
  }
  bool varint(uint32_t& value) {
    size_t used = 0;
    bool overlong = false;
    if (!takeVarint(data + at, length - at, used, value, overlong)) {
      return false;
    }
    at += used;
    return true;
  }
  bool signedVarint(int16_t& value) {
    uint32_t encoded = 0;
    if (!varint(encoded)) return false;
    const int32_t decoded = zigzagDecode(encoded);
    if (decoded < INT16_MIN || decoded > INT16_MAX) return false;
    value = static_cast<int16_t>(decoded);
    return true;
  }
};

bool planItemValid(const PlanItem& item, PlanMode mode) {
  if (mode == PlanMode::TIMED) {
    return item.durationSec >= 1 && item.durationSec <= 1800 &&
           item.fanDeci <= 100 && item.heatDeci <= 100 &&
           (item.fanDeci != 0 || item.heatDeci == 0);
  }
  if (mode == PlanMode::CALIBRATION) {
    return item.durationSec > 0 && item.fanDeci <= 100 &&
           item.heatDeci <= 100;
  }
  if (mode == PlanMode::MANUAL) {
    return item.fanDeci <= 100 && item.heatDeci <= 100;
  }
  return item.durationSec > 0 && item.fanMinDeci <= item.fanMaxDeci &&
         item.heatMinDeci <= item.heatMaxDeci &&
         item.fanMaxDeci <= 100 && item.heatMaxDeci <= 100;
}

uint8_t journeyMask(const PlanItem* before, const PlanItem& after) {
  if (before == nullptr) return 0x7F;
  uint8_t mask = 0;
  if (before->startDeci != after.startDeci) mask |= 0x01;
  if (before->endDeci != after.endDeci) mask |= 0x02;
  if (before->durationSec != after.durationSec) mask |= 0x04;
  if (before->fanMinDeci != after.fanMinDeci) mask |= 0x08;
  if (before->fanMaxDeci != after.fanMaxDeci) mask |= 0x10;
  if (before->heatMinDeci != after.heatMinDeci) mask |= 0x20;
  if (before->heatMaxDeci != after.heatMaxDeci) mask |= 0x40;
  return mask;
}

bool writeJourneyItem(PlanWriter& writer, const PlanItem& item, uint8_t mask) {
  if ((mask & 0x01) && !writer.signedVarint(item.startDeci)) return false;
  if ((mask & 0x02) && !writer.signedVarint(item.endDeci)) return false;
  if ((mask & 0x04) && !writer.varint(item.durationSec)) return false;
  if ((mask & 0x08) && !writer.byte(item.fanMinDeci)) return false;
  if ((mask & 0x10) && !writer.byte(item.fanMaxDeci)) return false;
  if ((mask & 0x20) && !writer.byte(item.heatMinDeci)) return false;
  if ((mask & 0x40) && !writer.byte(item.heatMaxDeci)) return false;
  return true;
}

bool readJourneyItem(PlanReader& reader, PlanItem& item, uint8_t mask) {
  if ((mask & 0x01) && !reader.signedVarint(item.startDeci)) return false;
  if ((mask & 0x02) && !reader.signedVarint(item.endDeci)) return false;
  if ((mask & 0x04)) {
    uint32_t duration = 0;
    if (!reader.varint(duration) || duration > UINT16_MAX) return false;
    item.durationSec = static_cast<uint16_t>(duration);
  }
  if ((mask & 0x08) && !reader.byte(item.fanMinDeci)) return false;
  if ((mask & 0x10) && !reader.byte(item.fanMaxDeci)) return false;
  if ((mask & 0x20) && !reader.byte(item.heatMinDeci)) return false;
  if ((mask & 0x40) && !reader.byte(item.heatMaxDeci)) return false;
  return true;
}

bool decodePlanCommon(const uint8_t* data, size_t length,
                      PlanProvenance* decoded, size_t& consumed) {
  consumed = 0;
  if (data == nullptr || length < 7 || data[0] != kPlanEnvelopeMagic ||
      data[1] != kPlanEnvelopeVersion) {
    return false;
  }
  const size_t envelopeBytes =
      static_cast<size_t>(data[5]) | (static_cast<size_t>(data[6]) << 8);
  if (envelopeBytes < 7 || envelopeBytes > kMaxPlanEnvelopeBytes ||
      envelopeBytes > length) {
    return false;
  }
  const PlanMode mode = static_cast<PlanMode>(data[2]);
  const uint8_t itemCount = data[3];
  const uint8_t journalCount = data[4];
  const uint8_t maximumItems =
      mode == PlanMode::JOURNEY ? 12 :
      mode == PlanMode::TIMED ? static_cast<uint8_t>(kMaxTimedPlanItems) :
      mode == PlanMode::CALIBRATION
          ? static_cast<uint8_t>(kMaxCalibrationPlanItems) : 1;
  if ((mode != PlanMode::TIMED && mode != PlanMode::JOURNEY &&
       mode != PlanMode::MANUAL && mode != PlanMode::CALIBRATION) ||
      itemCount == 0 || itemCount > maximumItems ||
      journalCount > kMaxPlanJournalEvents ||
      (mode == PlanMode::CALIBRATION && journalCount != 0)) {
    return false;
  }

  PlanItem initial[kMaxPlanItems] = {};
  if (decoded != nullptr) {
    *decoded = PlanProvenance{};
    decoded->mode = mode;
    decoded->itemCount = itemCount;
    decoded->journalCount = journalCount;
  }
  PlanReader reader{data, envelopeBytes, 7};
  if (mode == PlanMode::CALIBRATION) {
    uint8_t minimumDwellSec = 0;
    uint8_t settleSeconds = 0;
    uint8_t settleBandTenthsC = 0;
    if (!reader.byte(minimumDwellSec) || !reader.byte(settleSeconds) ||
        !reader.byte(settleBandTenthsC) ||
        minimumDwellSec < 5 || minimumDwellSec > 120 ||
        settleSeconds < 2 || settleSeconds > 30 ||
        settleBandTenthsC < 2 || settleBandTenthsC > 100) return false;
    if (decoded != nullptr) {
      decoded->minimumDwellSec = minimumDwellSec;
      decoded->settleSeconds = settleSeconds;
      decoded->settleBandTenthsC = settleBandTenthsC;
    }
  }
  for (uint8_t index = 0; index < itemCount; ++index) {
    PlanItem item = {};
    if (mode == PlanMode::TIMED || mode == PlanMode::CALIBRATION) {
      if (!reader.byte(item.fanDeci) || !reader.byte(item.heatDeci) ||
          !reader.u16(item.durationSec)) return false;
    } else if (mode == PlanMode::JOURNEY) {
      if (!readJourneyItem(reader, item, 0x7F)) return false;
    } else {
      if (!reader.byte(item.fanDeci) || !reader.byte(item.heatDeci)) {
        return false;
      }
    }
    if (!planItemValid(item, mode)) return false;
    initial[index] = item;
    if (decoded != nullptr) decoded->items[index] = item;
  }

  PlanItem current[12] = {};
  if (mode == PlanMode::JOURNEY) {
    memcpy(current, initial, itemCount * sizeof(PlanItem));
  }
  uint8_t currentCount = itemCount;
  uint32_t previousRevision = 0;
  uint32_t previousElapsed = 0;
  for (uint8_t eventIndex = 0; eventIndex < journalCount; ++eventIndex) {
    uint32_t elapsed = 0;
    uint32_t revision = 0;
    if (mode == PlanMode::TIMED) {
      PlanItem item = {};
      uint8_t itemIndex = 0;
      if (!reader.varint(elapsed) || elapsed > UINT16_MAX ||
          !reader.varint(revision) || revision <= previousRevision ||
          elapsed < previousElapsed || !reader.byte(itemIndex) ||
          itemIndex >= kMaxTimedPlanItems || itemIndex > currentCount ||
          !reader.byte(item.fanDeci) ||
          !reader.byte(item.heatDeci) || !reader.u16(item.durationSec) ||
          !planItemValid(item, PlanMode::TIMED)) return false;
      if (decoded != nullptr) {
        PlanJournalEvent& event = decoded->journal[eventIndex];
        event.elapsedSec = static_cast<uint16_t>(elapsed);
        event.planRevision = revision;
        event.itemIndex = itemIndex;
        event.itemCount = 1;
        event.items[0] = item;
      }
      if (itemIndex == currentCount) currentCount++;
      previousRevision = revision;
      previousElapsed = elapsed;
      continue;
    }
    if (mode == PlanMode::MANUAL) {
      PlanItem item = {};
      if (!reader.varint(elapsed) || elapsed > UINT16_MAX ||
          !reader.varint(revision) || revision <= previousRevision ||
          elapsed < previousElapsed ||
          !reader.byte(item.fanDeci) || !reader.byte(item.heatDeci) ||
          !reader.byte(item.fanMinDeci) || !reader.byte(item.heatMinDeci) ||
          !planItemValid(item, PlanMode::MANUAL) ||
          item.fanMinDeci > 100 || item.heatMinDeci > 100) {
        return false;
      }
      if (decoded != nullptr) {
        PlanJournalEvent& event = decoded->journal[eventIndex];
        event.elapsedSec = static_cast<uint16_t>(elapsed);
        event.planRevision = revision;
        event.itemCount = 1;
        event.items[0] = item;
      }
      previousRevision = revision;
      previousElapsed = elapsed;
      continue;
    }
    uint8_t nextCount = 0;
    uint8_t patchCount = 0;
    if (!reader.varint(elapsed) || elapsed > UINT16_MAX ||
        !reader.varint(revision) || revision <= previousRevision ||
        elapsed < previousElapsed ||
        !reader.byte(nextCount) || !reader.byte(patchCount) ||
        nextCount == 0 || nextCount > 12 || patchCount > nextCount) {
      return false;
    }
    if (nextCount > currentCount) {
      memset(current + currentCount, 0,
             (nextCount - currentCount) * sizeof(PlanItem));
    }
    bool seen[12] = {};
    for (uint8_t patch = 0; patch < patchCount; ++patch) {
      uint8_t index = 0;
      uint8_t mask = 0;
      if (!reader.byte(index) || !reader.byte(mask) || index >= nextCount ||
          mask == 0 || (mask & 0x80) != 0 || seen[index]) {
        return false;
      }
      seen[index] = true;
      if (!readJourneyItem(reader, current[index], mask)) return false;
    }
    currentCount = nextCount;
    for (uint8_t index = 0; index < currentCount; ++index) {
      if (!planItemValid(current[index], PlanMode::JOURNEY)) return false;
    }
    if (decoded != nullptr) {
      PlanJournalEvent& event = decoded->journal[eventIndex];
      event.elapsedSec = static_cast<uint16_t>(elapsed);
      event.planRevision = revision;
      event.itemCount = currentCount;
      memcpy(event.items, current, currentCount * sizeof(PlanItem));
    }
    previousRevision = revision;
    previousElapsed = elapsed;
  }
  if (reader.at != envelopeBytes) return false;
  consumed = envelopeBytes;
  return true;
}

}  // namespace

size_t encodePlanProvenance(const PlanProvenance& plan, uint8_t* out,
                            size_t capacity) {
  if (out == nullptr || capacity < 7 ||
      plan.journalCount > kMaxPlanJournalEvents) return 0;
  const uint8_t maximumItems =
      plan.mode == PlanMode::JOURNEY ? 12 :
      plan.mode == PlanMode::TIMED ? static_cast<uint8_t>(kMaxTimedPlanItems) :
      plan.mode == PlanMode::CALIBRATION
          ? static_cast<uint8_t>(kMaxCalibrationPlanItems) : 1;
  if ((plan.mode != PlanMode::TIMED && plan.mode != PlanMode::JOURNEY &&
       plan.mode != PlanMode::MANUAL && plan.mode != PlanMode::CALIBRATION) ||
      plan.itemCount == 0 || plan.itemCount > maximumItems ||
      (plan.mode == PlanMode::CALIBRATION &&
       (plan.journalCount != 0 || plan.minimumDwellSec < 5 ||
        plan.minimumDwellSec > 120 || plan.settleSeconds < 2 ||
        plan.settleSeconds > 30 || plan.settleBandTenthsC < 2 ||
        plan.settleBandTenthsC > 100))) return 0;

  PlanWriter writer{out, capacity, 0};
  if (!writer.byte(kPlanEnvelopeMagic) || !writer.byte(kPlanEnvelopeVersion) ||
      !writer.byte(static_cast<uint8_t>(plan.mode)) ||
      !writer.byte(plan.itemCount) || !writer.byte(plan.journalCount) ||
      !writer.u16(0)) return 0;
  if (plan.mode == PlanMode::CALIBRATION &&
      (!writer.byte(plan.minimumDwellSec) || !writer.byte(plan.settleSeconds) ||
       !writer.byte(plan.settleBandTenthsC))) return 0;
  for (uint8_t index = 0; index < plan.itemCount; ++index) {
    const PlanItem& item = plan.items[index];
    if (!planItemValid(item, plan.mode)) return 0;
    if (plan.mode == PlanMode::TIMED || plan.mode == PlanMode::CALIBRATION) {
      if (!writer.byte(item.fanDeci) || !writer.byte(item.heatDeci) ||
          !writer.u16(item.durationSec)) return 0;
    } else if (plan.mode == PlanMode::JOURNEY) {
      if (!writeJourneyItem(writer, item, 0x7F)) return 0;
    } else if (!writer.byte(item.fanDeci) || !writer.byte(item.heatDeci)) {
      return 0;
    }
  }

  const PlanItem* previous = plan.items;
  uint8_t previousCount = plan.itemCount;
  uint32_t previousRevision = 0;
  uint16_t previousElapsed = 0;
  for (uint8_t eventIndex = 0; eventIndex < plan.journalCount; ++eventIndex) {
    const PlanJournalEvent& event = plan.journal[eventIndex];
    if (event.planRevision <= previousRevision ||
        event.elapsedSec < previousElapsed) return 0;
    previousRevision = event.planRevision;
    previousElapsed = event.elapsedSec;
    if (plan.mode == PlanMode::TIMED) {
      if (event.itemCount != 1 || event.itemIndex >= kMaxTimedPlanItems ||
          event.itemIndex > previousCount ||
          !planItemValid(event.items[0], PlanMode::TIMED) ||
          !writer.varint(event.elapsedSec) ||
          !writer.varint(event.planRevision) ||
          !writer.byte(event.itemIndex) ||
          !writer.byte(event.items[0].fanDeci) ||
          !writer.byte(event.items[0].heatDeci) ||
          !writer.u16(event.items[0].durationSec)) return 0;
      if (event.itemIndex == previousCount) previousCount++;
      continue;
    }
    if (plan.mode == PlanMode::MANUAL) {
      if (event.itemCount != 1 ||
          !planItemValid(event.items[0], PlanMode::MANUAL) ||
          event.items[0].fanMinDeci > 100 ||
          event.items[0].heatMinDeci > 100 ||
          !writer.varint(event.elapsedSec) ||
          !writer.varint(event.planRevision) ||
          !writer.byte(event.items[0].fanDeci) ||
          !writer.byte(event.items[0].heatDeci) ||
          !writer.byte(event.items[0].fanMinDeci) ||
          !writer.byte(event.items[0].heatMinDeci)) {
        return 0;
      }
      continue;
    }
    if (event.itemCount == 0 || event.itemCount > 12 ||
        !writer.varint(event.elapsedSec) ||
        !writer.varint(event.planRevision) ||
        !writer.byte(event.itemCount)) return 0;
    uint8_t masks[12] = {};
    uint8_t patchCount = 0;
    for (uint8_t index = 0; index < event.itemCount; ++index) {
      if (!planItemValid(event.items[index], PlanMode::JOURNEY)) return 0;
      masks[index] = journeyMask(
          index < previousCount ? &previous[index] : nullptr,
          event.items[index]);
      if (masks[index] != 0) patchCount++;
    }
    if (!writer.byte(patchCount)) return 0;
    for (uint8_t index = 0; index < event.itemCount; ++index) {
      if (masks[index] == 0) continue;
      if (!writer.byte(index) || !writer.byte(masks[index]) ||
          !writeJourneyItem(writer, event.items[index], masks[index])) {
        return 0;
      }
    }
    previous = event.items;
    previousCount = event.itemCount;
  }
  if (writer.at > kMaxPlanEnvelopeBytes || writer.at > UINT16_MAX) return 0;
  out[5] = static_cast<uint8_t>(writer.at);
  out[6] = static_cast<uint8_t>(writer.at >> 8);
  return writer.at;
}

bool decodePlanProvenance(const uint8_t* data, size_t length,
                          PlanProvenance& out, size_t& consumed) {
  return decodePlanCommon(data, length, &out, consumed);
}

bool validatePlanEnvelope(const uint8_t* data, size_t length,
                          size_t& consumed) {
  return decodePlanCommon(data, length, nullptr, consumed);
}

uint32_t crc32Update(uint32_t crc, const uint8_t* data, size_t length) {
  // Nibble table: 64 bytes of rodata against the 1 KB a byte table would cost,
  // and still eight times faster than the bit-at-a-time loop.
  static const uint32_t kTable[16] = {
      0x00000000u, 0x1DB71064u, 0x3B6E20C8u, 0x26D930ACu,
      0x76DC4190u, 0x6B6B51F4u, 0x4DB26158u, 0x5005713Cu,
      0xEDB88320u, 0xF00F9344u, 0xD6D6A3E8u, 0xCB61B38Cu,
      0x9B64C2B0u, 0x86D3D2D4u, 0xA00AE278u, 0xBDBDF21Cu};
  if (data == nullptr) return crc;
  for (size_t index = 0; index < length; ++index) {
    crc ^= data[index];
    crc = (crc >> 4) ^ kTable[crc & 0x0Fu];
    crc = (crc >> 4) ^ kTable[crc & 0x0Fu];
  }
  return crc;
}

const char* archiveVerdictName(ArchiveVerdict verdict) {
  switch (verdict) {
    case ArchiveVerdict::OK: return "ok";
    case ArchiveVerdict::TRUNCATED_HEADER: return "truncated_header";
    case ArchiveVerdict::BAD_MAGIC: return "bad_magic";
    case ArchiveVerdict::BAD_VERSION: return "bad_version";
    case ArchiveVerdict::SAMPLE_COUNT: return "sample_count";
    case ArchiveVerdict::ZONE_COUNT: return "zone_count";
    case ArchiveVerdict::BAD_CODEC: return "bad_codec";
    case ArchiveVerdict::SIZE_MISMATCH: return "size_mismatch";
    case ArchiveVerdict::CRC_MISMATCH: return "crc_mismatch";
    case ArchiveVerdict::PROVENANCE: return "provenance";
    case ArchiveVerdict::PAYLOAD_UNDECODABLE: return "payload_undecodable";
  }
  return "unknown";
}

const char* archiveVerdictReason(ArchiveVerdict verdict) {
  switch (verdict) {
    case ArchiveVerdict::OK:
      return "the file is a valid recording";
    case ArchiveVerdict::TRUNCATED_HEADER:
      return "the file is shorter than the header its version declares";
    case ArchiveVerdict::BAD_MAGIC:
      return "the file does not begin with the CRKL archive magic";
    case ArchiveVerdict::BAD_VERSION:
      return "the archive is not the self-identifying version this firmware requires";
    case ArchiveVerdict::SAMPLE_COUNT:
      return "the header claims more samples than a recording can hold";
    case ArchiveVerdict::ZONE_COUNT:
      return "the header claims more journey zones than exist";
    case ArchiveVerdict::BAD_CODEC:
      return "the payload names a codec this firmware cannot decode";
    case ArchiveVerdict::SIZE_MISMATCH:
      return "the file length disagrees with the payload length in its header";
    case ArchiveVerdict::CRC_MISMATCH:
      return "the archive identity, metadata, or payload does not match its checksum";
    case ArchiveVerdict::PROVENANCE:
      return "the recording does not carry a complete source device and log identity";
    case ArchiveVerdict::PAYLOAD_UNDECODABLE:
      return "the payload passes its checksum but does not decode as a recording";
  }
  return "the file failed an unnamed check";
}

ArchiveVerdict validateArchiveReader(ArchiveReadAt readAt, void* context,
                                     size_t length, uint32_t maxSamples,
                                     ArchiveSummary& out) {
  out = ArchiveSummary{};
  if (readAt == nullptr || length < kArchiveHeaderV1Bytes) {
    return ArchiveVerdict::TRUNCATED_HEADER;
  }
  uint8_t header[kArchiveHeaderV4Bytes] = {0};
  if (readAt(context, 0, header, kArchiveHeaderV1Bytes) !=
      kArchiveHeaderV1Bytes) {
    return ArchiveVerdict::TRUNCATED_HEADER;
  }
  if (readU32(header + kArchiveOffsetMagic) != kArchiveMagic) {
    return ArchiveVerdict::BAD_MAGIC;
  }
  const uint16_t version = readU16(header + kArchiveOffsetVersion);
  if (version < kArchiveVersionMin || version > kArchiveVersionMax) {
    return ArchiveVerdict::BAD_VERSION;
  }
  const size_t headerBytes = kArchiveHeaderV4Bytes;
  if (length < headerBytes) return ArchiveVerdict::TRUNCATED_HEADER;
  if (headerBytes > kArchiveHeaderV1Bytes &&
      readAt(context, kArchiveHeaderV1Bytes,
             header + kArchiveHeaderV1Bytes,
             headerBytes - kArchiveHeaderV1Bytes) !=
          headerBytes - kArchiveHeaderV1Bytes) {
    return ArchiveVerdict::TRUNCATED_HEADER;
  }

  out.version = version;
  out.headerBytes = static_cast<uint32_t>(headerBytes);
  out.source = header[kArchiveOffsetSource];
  out.logId = readU32(header + kArchiveOffsetLogId);
  out.sampleCount = readU32(header + kArchiveOffsetSampleCount);
  if (out.sampleCount > maxSamples) return ArchiveVerdict::SAMPLE_COUNT;
  if (version >= 2 && header[kArchiveOffsetZoneCount] > kArchiveMaxZones) {
    return ArchiveVerdict::ZONE_COUNT;
  }

  {
    out.codec = header[kArchiveOffsetCodec];
    out.crc32 = readU32(header + kArchiveOffsetCrc32);
    out.encodedBytes = readU32(header + kArchiveOffsetEncodedBytes);
    if (out.codec != kCodecRaw && out.codec != kCodecDeltaVarint &&
        out.codec != kCodecDeltaVarintPlan) {
      return ArchiveVerdict::BAD_CODEC;
    }
    if (out.codec == kCodecRaw &&
        out.encodedBytes !=
            out.sampleCount * static_cast<uint32_t>(kRawSampleBytes)) {
      return ArchiveVerdict::SIZE_MISMATCH;
    }
  }
  if (length - headerBytes != static_cast<size_t>(out.encodedBytes)) {
    return ArchiveVerdict::SIZE_MISMATCH;
  }

  auto copyIdentity = [&](size_t offset, size_t bytes, char* destination) {
    size_t used = 0;
    while (used < bytes && header[offset + used] != 0) {
      const uint8_t value = header[offset + used];
      if (value < 0x20 || value > 0x7E || value == '"' || value == '\\') {
        return false;
      }
      destination[used] = static_cast<char>(value);
      used++;
    }
    destination[used] = '\0';
    return used > 0;
  };
  const bool hasDevice = copyIdentity(
      kArchiveOffsetSourceDeviceId, kArchiveDeviceIdBytes, out.sourceDeviceId);
  const bool hasModel = copyIdentity(
      kArchiveOffsetSourceModelId, kArchiveModelIdBytes, out.sourceModelId);
  const bool hasDisplay = copyIdentity(
      kArchiveOffsetSourceDisplayName, kArchiveDisplayNameBytes,
      out.sourceDisplayName);
  const bool hasFirmware = copyIdentity(
      kArchiveOffsetSourceFirmwareVersion, kArchiveFirmwareVersionBytes,
      out.sourceFirmwareVersion);
  const uint32_t provenanceCrc = readU32(
      header + kArchiveOffsetProvenanceCrc32);
  const uint32_t expectedProvenanceCrc = crc32Finish(crc32Update(
      kCrc32Init, header + kArchiveOffsetSourceDeviceId,
      kArchiveOffsetProvenanceCrc32 - kArchiveOffsetSourceDeviceId));
  if (provenanceCrc != expectedProvenanceCrc) {
    return ArchiveVerdict::PROVENANCE;
  }
  out.originLogId = readU32(header + kArchiveOffsetOriginLogId);
  out.simulated =
      (header[kArchiveOffsetProvenanceFlags] & kArchiveProvenanceSimulated) != 0;
  out.thermocoupleOffsetPresent =
      (header[kArchiveOffsetThermocoupleOffsetFlags] &
       kArchiveThermocoupleOffsetPresent) != 0;
  out.thermocoupleOffsetCenti = static_cast<int16_t>(
      readU16(header + kArchiveOffsetThermocoupleOffsetCenti));
  if (!hasDevice || !hasModel || !hasDisplay || !hasFirmware ||
      out.originLogId == 0 || !out.thermocoupleOffsetPresent ||
      out.thermocoupleOffsetCenti < kArchiveThermocoupleOffsetMinimumCenti ||
      out.thermocoupleOffsetCenti > kArchiveThermocoupleOffsetMaximumCenti) {
    return ArchiveVerdict::PROVENANCE;
  }

  uint8_t buffer[256];
  {
    uint32_t crc = kCrc32Init;
    crc = crc32Update(crc, header, kArchiveOffsetCrc32);
    crc = crc32Update(crc, header + kArchiveOffsetCodec,
                      headerBytes - kArchiveOffsetCodec);
    size_t offset = 0;
    while (offset < out.encodedBytes) {
      size_t want = static_cast<size_t>(out.encodedBytes) - offset;
      if (want > sizeof(buffer)) want = sizeof(buffer);
      if (readAt(context, headerBytes + offset, buffer, want) != want) {
        return ArchiveVerdict::SIZE_MISMATCH;
      }
      crc = crc32Update(crc, buffer, want);
      offset += want;
    }
    if (crc32Finish(crc) != out.crc32) {
      return ArchiveVerdict::CRC_MISMATCH;
    }
  }
  size_t samplePayloadOffset = 0;
  if (out.codec == kCodecDeltaVarintPlan) {
    uint8_t prefix[7] = {};
    if (out.encodedBytes < sizeof(prefix) ||
        readAt(context, headerBytes, prefix, sizeof(prefix)) != sizeof(prefix)) {
      return ArchiveVerdict::PAYLOAD_UNDECODABLE;
    }
    const size_t declared = static_cast<size_t>(prefix[5]) |
        (static_cast<size_t>(prefix[6]) << 8);
    if (declared < sizeof(prefix) || declared > kMaxPlanEnvelopeBytes ||
        declared > out.encodedBytes) {
      return ArchiveVerdict::PAYLOAD_UNDECODABLE;
    }
    uint8_t planBytes[kMaxPlanEnvelopeBytes];
    if (readAt(context, headerBytes, planBytes, declared) != declared ||
        !validatePlanEnvelope(planBytes, declared, samplePayloadOffset) ||
        samplePayloadOffset != declared) {
      return ArchiveVerdict::PAYLOAD_UNDECODABLE;
    }
  }
  if (out.codec == kCodecDeltaVarint || out.codec == kCodecDeltaVarintPlan) {
    const size_t samplePayloadBytes =
        static_cast<size_t>(out.encodedBytes) - samplePayloadOffset;
    Decoder decoder;
    decodeBegin(decoder);
    size_t filled = 0;
    size_t offset = 0;
    size_t payloadRead = 0;
    uint32_t emitted = 0;
    while (emitted < out.sampleCount) {
      Sample sample;
      size_t consumed = 0;
      const DecodeStatus status =
          decodeSample(decoder, buffer + offset, filled - offset, consumed,
                       sample);
      if (status == DecodeStatus::OK) {
        offset += consumed;
        emitted++;
        continue;
      }
      if (status != DecodeStatus::NEED_MORE) {
        return ArchiveVerdict::PAYLOAD_UNDECODABLE;
      }
      if (offset > 0) {
        memmove(buffer, buffer + offset, filled - offset);
        filled -= offset;
        offset = 0;
      }
      size_t want = sizeof(buffer) - filled;
      const size_t remaining =
          samplePayloadBytes - payloadRead;
      if (want > remaining) want = remaining;
      if (want == 0 ||
          readAt(context, headerBytes + samplePayloadOffset + payloadRead,
                 buffer + filled, want) !=
              want) {
        return ArchiveVerdict::PAYLOAD_UNDECODABLE;
      }
      filled += want;
      payloadRead += want;
    }
    if (payloadRead != samplePayloadBytes ||
        offset != filled) {
      return ArchiveVerdict::PAYLOAD_UNDECODABLE;
    }
  }
  return ArchiveVerdict::OK;
}

struct BufferReader {
  const uint8_t* data;
  size_t length;
};

size_t readArchiveBuffer(void* context, size_t offset, uint8_t* out,
                         size_t length) {
  const BufferReader& reader = *static_cast<BufferReader*>(context);
  if (reader.data == nullptr || offset > reader.length ||
      length > reader.length - offset) {
    return 0;
  }
  memcpy(out, reader.data + offset, length);
  return length;
}

ArchiveVerdict validateArchiveBuffer(const uint8_t* data, size_t length,
                                     uint32_t maxSamples, ArchiveSummary& out) {
  BufferReader reader{data, length};
  return validateArchiveReader(&readArchiveBuffer, &reader, length, maxSamples,
                               out);
}
}  // namespace logcodec
}  // namespace sr800
