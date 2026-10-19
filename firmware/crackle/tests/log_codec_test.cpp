// Host verification of the recording codec: the frame layout that decides what
// an archived roast actually costs on the 896 KB volume, and what precision it
// keeps once it is there.
//
// The load-bearing claim is the round trip. Storage rounds a measured
// temperature to a TENTH of a degree on purpose, so "lossless" is not the
// property to test - idempotence is: quantize once and the bytes carry that
// value forever, decode gives it back exactly, and re-encoding what was decoded
// reproduces the payload byte for byte. Everything else here defends that:
// missing readings survive as missing, a corrupt frame stops the stream instead
// of poisoning the samples after it, and a truncated file is refused rather
// than served short.
//
// `testDecayTailResolution` is the reason the unit is tenths rather than whole
// degrees, stated as an assertion: a passive decay of 0.1 C/s must come back as
// a curve, not as a staircase of ten-second flats, because that tail is what
// the loss and tau coefficients are fitted from.
//
// The compression measurement runs a synthetic 25-minute roast rather than a
// contrived best case, because the number in the README is a capacity promise.

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

#include "sr800_log_codec.h"

namespace {

using sr800::logcodec::Decoder;
using sr800::logcodec::DecodeStatus;
using sr800::logcodec::Encoder;
using sr800::logcodec::RawSample;
using sr800::logcodec::Sample;

int failures = 0;

void require(bool condition, const char* message) {
  if (!condition) {
    std::cerr << "FAIL: " << message << '\n';
    failures++;
  }
}

std::vector<uint8_t> encodeAll(const std::vector<RawSample>& samples) {
  Encoder encoder;
  sr800::logcodec::encodeBegin(encoder);
  std::vector<uint8_t> payload;
  uint8_t frame[sr800::logcodec::kMaxEncodedSampleBytes];
  for (const RawSample& raw : samples) {
    const size_t written =
        sr800::logcodec::encodeRawSample(encoder, raw, frame);
    require(written <= sizeof(frame), "a frame stayed inside the worst case");
    payload.insert(payload.end(), frame, frame + written);
  }
  return payload;
}

// Decodes exactly `count` samples, one at a time, through a deliberately mean
// feed: the decoder is handed one more byte at a time than it had before, so
// every NEED_MORE boundary in the format is exercised rather than assumed.
bool decodeAllDribbled(const std::vector<uint8_t>& payload, size_t count,
                       std::vector<Sample>& out) {
  Decoder decoder;
  sr800::logcodec::decodeBegin(decoder);
  out.clear();
  size_t offset = 0;
  size_t visible = 0;
  while (out.size() < count) {
    Sample sample = {};
    size_t consumed = 0;
    const DecodeStatus status = sr800::logcodec::decodeSample(
        decoder, payload.data() + offset, visible, consumed, sample);
    if (status == DecodeStatus::OK) {
      offset += consumed;
      visible -= consumed;
      out.push_back(sample);
      continue;
    }
    if (status == DecodeStatus::MALFORMED) return false;
    if (offset + visible >= payload.size()) return false;  // truncated
    visible++;
  }
  return true;
}

bool sameSample(const Sample& a, const Sample& b) {
  if (a.tMs != b.tMs) return false;
  if (a.thermocoupleValid != b.thermocoupleValid) return false;
  if (a.coldJunctionValid != b.coldJunctionValid) return false;
  if (a.thermocoupleValid && a.thermocoupleDeci != b.thermocoupleDeci) {
    return false;
  }
  if (a.coldJunctionValid && a.coldJunctionDeci != b.coldJunctionDeci) {
    return false;
  }
  return a.fanDeci == b.fanDeci && a.heatDeci == b.heatDeci;
}

RawSample makeSample(uint32_t tMs, int16_t tcCenti, int16_t cjCenti,
                     uint16_t fanMilli, uint16_t heatMilli) {
  RawSample raw = {};
  raw.tMs = tMs;
  raw.thermocoupleCenti = tcCenti;
  raw.coldJunctionCenti = cjCenti;
  raw.fanMilli = fanMilli;
  raw.heatMilli = heatMilli;
  return raw;
}

// --- the rounding rule itself -------------------------------------------

void testQuantization() {
  require(sr800::logcodec::centiToDeciDegrees(0) == 0, "0.00 C rounds to 0");
  require(sr800::logcodec::centiToDeciDegrees(4999) == 500, "49.99 -> 50.0");
  require(sr800::logcodec::centiToDeciDegrees(1855) == 186,
          "half rounds away from zero, upward");
  require(sr800::logcodec::centiToDeciDegrees(-1855) == -186,
          "half rounds away from zero, downward");
  require(sr800::logcodec::centiToDeciDegrees(1854) == 185, "18.54 -> 18.5");
  require(sr800::logcodec::centiToDeciDegrees(-1854) == -185,
          "-18.54 -> -18.5");
  require(sr800::logcodec::centiToDeciDegrees(32767) == 3277,
          "the top of the centi range still fits a deci-degree int16");
  require(sr800::logcodec::centiToDeciDegrees(-32767) == -3277,
          "the bottom of the centi range does too");
  // The whole point of the revision: a tenth of a degree is representable, so
  // consecutive readings a tenth apart stay distinct instead of collapsing.
  require(sr800::logcodec::centiToDeciDegrees(18740) !=
              sr800::logcodec::centiToDeciDegrees(18750),
          "187.4 and 187.5 are different stored values");

  require(sr800::logcodec::milliToDeci(0) == 0, "fan off is 0 deci");
  require(sr800::logcodec::milliToDeci(5000) == 50, "level 5.0 is 50 deci");
  require(sr800::logcodec::milliToDeci(10000) == 100, "level 10.0 is 100 deci");
  require(sr800::logcodec::milliToDeci(3300) == 33,
          "every commandable 0.1 step is exact");
  require(sr800::logcodec::milliToDeci(3350) == 34,
          "an off-grid value rounds half away from zero");
  require(sr800::logcodec::milliToDeci(65535) == 655,
          "the deci ceiling matches the uint16 milli ceiling");

  // Quantization must be idempotent, or "encode(decode(x)) == decode(encode(x))"
  // would be a claim about one round only.
  const RawSample raw = makeSample(1234, 18763, 2649, 7350, 4425);
  const Sample once = sr800::logcodec::quantize(raw);
  RawSample requantized = raw;
  requantized.thermocoupleCenti =
      static_cast<int16_t>(once.thermocoupleDeci * 10);
  requantized.coldJunctionCenti =
      static_cast<int16_t>(once.coldJunctionDeci * 10);
  requantized.fanMilli = static_cast<uint16_t>(once.fanDeci * 100);
  requantized.heatMilli = static_cast<uint16_t>(once.heatDeci * 100);
  require(sameSample(once, sr800::logcodec::quantize(requantized)),
          "quantizing an already-quantized sample changes nothing");
  // The controller's safety latch is 400 C. The in-flight log must therefore
  // retain every plausible pre-latch value instead of wrapping at 327.68 C.
  Sample high = {};
  high.tMs = 1000;
  high.thermocoupleValid = true;
  high.coldJunctionValid = true;
  high.thermocoupleDeci = 3999;
  high.coldJunctionDeci = 250;
  high.fanDeci = 100;
  high.heatDeci = 100;
  Encoder highEncoder;
  sr800::logcodec::encodeBegin(highEncoder);
  uint8_t highFrame[sr800::logcodec::kMaxEncodedSampleBytes];
  const size_t highBytes = sr800::logcodec::encodeSample(
      highEncoder, high, highFrame);
  Decoder highDecoder;
  sr800::logcodec::decodeBegin(highDecoder);
  Sample highDecoded = {};
  size_t highConsumed = 0;
  require(sr800::logcodec::decodeSample(
              highDecoder, highFrame, highBytes, highConsumed, highDecoded) ==
              DecodeStatus::OK &&
              highConsumed == highBytes && highDecoded.thermocoupleDeci == 3999,
          "399.9 C survives the v4 recording codec without int16 centi wrap");
}

// --- exact round trip ----------------------------------------------------

void testRoundTrip() {
  std::vector<RawSample> samples;
  // First sample carries absolutes on every channel, and a non-zero start time.
  samples.push_back(makeSample(500, 2438, 2210, 5000, 0));
  // A long constant stretch: the case the delta framing exists for.
  for (int index = 1; index <= 400; ++index) {
    samples.push_back(makeSample(500 + 1000u * index, 2438, 2210, 5000, 0));
  }
  // Level changes, both directions, including a jump to the ceiling.
  samples.push_back(makeSample(401500, 3000, 2215, 10000, 9000));
  samples.push_back(makeSample(402500, 4550, 2220, 100, 100));
  samples.push_back(makeSample(403500, 4550, 2220, 65535, 65535));
  samples.push_back(makeSample(404500, 4550, 2220, 0, 0));
  // A dropout: the thermocouple went missing while the cold junction did not.
  samples.push_back(makeSample(405500, sr800::logcodec::kMissingCenti, 2225,
                               5000, 3000));
  samples.push_back(makeSample(406500, sr800::logcodec::kMissingCenti, 2225,
                               5000, 3000));
  // Both missing at once, then a return: the predictor must have stood still.
  samples.push_back(makeSample(407500, sr800::logcodec::kMissingCenti,
                               sr800::logcodec::kMissingCenti, 5000, 3000));
  samples.push_back(makeSample(408500, 4551, 2226, 5000, 3000));
  // A negative reading, and one either side of the rounding boundary - which
  // for tenths sits at the half-CENTI, not the half-degree.
  samples.push_back(makeSample(409500, -455, -1244, 5000, 3000));
  samples.push_back(makeSample(410500, 1245, 1244, 5000, 3000));
  // A time gap far larger than the nominal interval.
  samples.push_back(makeSample(999999, 2000, 2000, 0, 0));

  const std::vector<uint8_t> payload = encodeAll(samples);
  std::vector<Sample> decoded;
  require(decodeAllDribbled(payload, samples.size(), decoded),
          "the whole stream decoded through a byte-at-a-time feed");
  require(decoded.size() == samples.size(), "every sample came back");

  bool exact = true;
  for (size_t index = 0; index < decoded.size() && index < samples.size();
       ++index) {
    if (!sameSample(decoded[index], sr800::logcodec::quantize(samples[index]))) {
      exact = false;
      std::cerr << "  sample " << index << " differs from its quantized form\n";
    }
  }
  require(exact, "decode(encode(x)) equals quantize(x) for every sample");

  // The dropout must not have moved the temperature predictor: 45.50 stores as
  // 455 before it and 45.51 stores as 455 after, so the returning sample is a
  // zero delta against a reading three samples earlier.
  if (decoded.size() == samples.size()) {
    require(decoded[405].thermocoupleValid == false,
            "a missing thermocouple decodes as missing, not as a substitute");
    require(decoded[405].coldJunctionValid &&
                decoded[405].coldJunctionDeci == 223,
            "one channel can go missing while the other keeps reporting");
    require(decoded[407].thermocoupleValid == false &&
                decoded[407].coldJunctionValid == false,
            "both channels can be missing in the same sample");
    require(decoded[408].thermocoupleValid &&
                decoded[408].thermocoupleDeci == 455,
            "the reading after a dropout is relative to the last real one");
    require(decoded[409].thermocoupleDeci == -46 &&
                decoded[409].coldJunctionDeci == -124,
            "negative readings round away from zero, not toward it");
    require(decoded[410].thermocoupleDeci == 125 &&
                decoded[410].coldJunctionDeci == 124,
            "the rounding boundary falls where the tenths rule says");
    require(decoded[411].tMs == 999999,
            "a time gap far off the nominal interval survives exactly");
  }

  // And the other direction: re-encoding what came out must reproduce the bytes.
  Encoder encoder;
  sr800::logcodec::encodeBegin(encoder);
  std::vector<uint8_t> reencoded;
  uint8_t frame[sr800::logcodec::kMaxEncodedSampleBytes];
  for (const Sample& sample : decoded) {
    const size_t written =
        sr800::logcodec::encodeSample(encoder, sample, frame);
    reencoded.insert(reencoded.end(), frame, frame + written);
  }
  require(reencoded.size() == payload.size() &&
              std::memcmp(reencoded.data(), payload.data(), payload.size()) == 0,
          "encode(decode(payload)) reproduces the payload byte for byte");
}

// --- the frame layout, byte by byte -------------------------------------

void testFrameLayout() {
  Encoder encoder;
  sr800::logcodec::encodeBegin(encoder);
  uint8_t frame[sr800::logcodec::kMaxEncodedSampleBytes];

  // t=0, tc=0 C, cj=0 C, fan=0, heat=0: every channel is its own zero, so the
  // first frame is the five cheapest tokens the format can produce.
  const size_t first = sr800::logcodec::encodeRawSample(
      encoder, makeSample(0, 0, 0, 0, 0), frame);
  require(first == 5, "an all-zero first sample costs exactly five bytes");
  require(frame[0] == 0x00, "time zigzag(0) is 0x00");
  require(frame[1] == 0x01, "a present temperature of delta 0 is token 1");
  require(frame[2] == 0x01, "the cold junction uses the same escape offset");
  require(frame[3] == 0x00 && frame[4] == 0x00, "levels use no offset");

  // The first 1 Hz step is the only place the interval is spelled out: the
  // previous interval was 0, so the residual is the whole 1000 ms.
  const size_t second = sr800::logcodec::encodeRawSample(
      encoder, makeSample(1000, 0, 0, 0, 0), frame);
  require(second == 6, "the first interval of a recording costs six bytes");
  require(frame[0] == 0xD0 && frame[1] == 0x0F,
          "zigzag(1000) = 2000 encodes as D0 0F");

  // From there a steady interval is free: this is the 5 bytes/sample the
  // capacity math rests on.
  const size_t third = sr800::logcodec::encodeRawSample(
      encoder, makeSample(2000, 0, 0, 0, 0), frame);
  require(third == 5, "a steady 1 Hz sample costs exactly five bytes");
  require(frame[0] == 0x00, "an unchanged interval is the single byte 0x00");

  // Scheduling jitter must stay inside one byte, or the steady state is a lie.
  const size_t jittered = sr800::logcodec::encodeRawSample(
      encoder, makeSample(3004, 0, 0, 0, 0), frame);
  require(jittered == 5, "a 4 ms interval wobble still costs five bytes");

  // The missing escape is token 0 and is one byte, whatever the last reading was.
  const size_t dropout = sr800::logcodec::encodeRawSample(
      encoder,
      makeSample(4008, sr800::logcodec::kMissingCenti,
                 sr800::logcodec::kMissingCenti, 0, 0),
      frame);
  require(dropout == 5, "a dropout costs no more than a reading");
  require(frame[1] == 0x00 && frame[2] == 0x00,
          "a missing channel is the single byte 0x00");

  // Tenths have to be free, or they would not be worth having. A varint token
  // stays one byte for any zigzagged delta below 128, so a temperature channel
  // costs one byte for every step up to +/-63 deci - 6.3 C between consecutive
  // samples, which nothing thermal in this machine does.
  sr800::logcodec::Encoder walker;
  sr800::logcodec::encodeBegin(walker);
  // Two samples to settle the time predictor, so what follows measures the
  // temperature channel and nothing else.
  sr800::logcodec::encodeRawSample(walker, makeSample(0, 2000, 2000, 0, 0),
                                   frame);
  sr800::logcodec::encodeRawSample(walker, makeSample(1000, 2000, 2000, 0, 0),
                                   frame);
  const size_t tenth = sr800::logcodec::encodeRawSample(
      walker, makeSample(2000, 2010, 2000, 0, 0), frame);
  require(tenth == 5, "a 0.1 C step costs exactly five bytes, like no step");
  const size_t bigStep = sr800::logcodec::encodeRawSample(
      walker, makeSample(3000, 2640, 2000, 0, 0), frame);
  require(bigStep == 5,
          "a 6.3 C move in one second is still one byte of temperature");
  const size_t hugeStep = sr800::logcodec::encodeRawSample(
      walker, makeSample(4000, 3290, 2000, 0, 0), frame);
  require(hugeStep == 6,
          "only a move past 6.3 C/s spends a second byte on temperature");
}

// --- the passive decay tail, which is why the unit is tenths ---------------

// A 0.1 C/s decay is the shape the loss and tau fit is regressed from. Stored
// as whole degrees it is not a decay at all: it is a staircase of ten-second
// flats, and 90% of the samples in it carry no information. This test asserts
// the property that failure would violate - every sample distinguishable from
// the one before it - rather than asserting the unit.
void testDecayTailResolution() {
  constexpr int kTailSeconds = 180;  // the recorded tail, at its new length
  std::vector<RawSample> samples;
  for (int second = 0; second < kTailSeconds; ++second) {
    // 120.00 C falling exactly 0.1 C per second, fan and heat off.
    const int16_t centi = static_cast<int16_t>(12000 - 10 * second);
    samples.push_back(makeSample(1000u * second, centi, 2500, 0, 0));
  }

  const std::vector<uint8_t> payload = encodeAll(samples);
  std::vector<Sample> decoded;
  require(decodeAllDribbled(payload, samples.size(), decoded),
          "the decay tail decodes completely");
  require(decoded.size() == samples.size(), "every tail sample came back");

  // No flats. Consecutive samples must differ by exactly one deci-degree.
  bool strictlyFalling = decoded.size() == samples.size();
  int distinct = decoded.empty() ? 0 : 1;
  for (size_t index = 1; index < decoded.size(); ++index) {
    const int step =
        decoded[index].thermocoupleDeci - decoded[index - 1].thermocoupleDeci;
    if (step != -1) strictlyFalling = false;
    if (step != 0) distinct++;
  }
  require(strictlyFalling,
          "a 0.1 C/s decay falls by one stored unit every single second");
  require(distinct == kTailSeconds,
          "the tail reconstructs as 180 distinct points, not 18 flats");

  // And the resolution is not paid for: every steady frame is the same five
  // bytes whole degrees would have cost. Frame 0 carries three absolute values
  // (7 bytes) and frame 1 spells out the opening 1000 ms interval (6); from
  // there the tail is flat at five, one deci-degree of decay per byte.
  require(payload.size() == static_cast<size_t>(7 + 6 + 5 * (kTailSeconds - 2)),
          "a tenth-degree decay costs the steady five bytes a sample");

  // The reconstructed curve must be the measured one to within the stored
  // quantum, because the fit reads these numbers directly.
  bool withinQuantum = true;
  for (size_t index = 0; index < decoded.size(); ++index) {
    const double stored = decoded[index].thermocoupleDeci / 10.0;
    const double measured = samples[index].thermocoupleCenti / 100.0;
    if (std::fabs(stored - measured) > 0.05) withinQuantum = false;
  }
  require(withinQuantum,
          "every stored point is within half a tenth of what was measured");
}

// --- corruption and truncation ------------------------------------------

void testCrcDetectsCorruption() {
  std::vector<RawSample> samples;
  for (int index = 0; index < 200; ++index) {
    samples.push_back(makeSample(1000u * index,
                                 static_cast<int16_t>(2500 + index * 40),
                                 2300, 6000, 4000));
  }
  const std::vector<uint8_t> payload = encodeAll(samples);
  const uint32_t crc = sr800::logcodec::crc32Finish(sr800::logcodec::crc32Update(
      sr800::logcodec::kCrc32Init, payload.data(), payload.size()));

  // A known-answer check, so the stored checksum is the standard one and a file
  // written by this image stays verifiable by anything that speaks CRC-32.
  const uint8_t reference[] = {'1', '2', '3', '4', '5',
                               '6', '7', '8', '9'};
  const uint32_t referenceCrc =
      sr800::logcodec::crc32Finish(sr800::logcodec::crc32Update(
          sr800::logcodec::kCrc32Init, reference, sizeof(reference)));
  require(referenceCrc == 0xCBF43926u,
          "CRC32 of \"123456789\" is the IEEE check value");

  // Chunked accumulation must equal the one-shot value: the device computes it
  // across 256-byte file reads, never over the whole payload at once.
  uint32_t chunked = sr800::logcodec::kCrc32Init;
  for (size_t offset = 0; offset < payload.size(); offset += 37) {
    const size_t length =
        offset + 37 <= payload.size() ? 37 : payload.size() - offset;
    chunked = sr800::logcodec::crc32Update(chunked, payload.data() + offset,
                                           length);
  }
  require(sr800::logcodec::crc32Finish(chunked) == crc,
          "a chunked CRC equals the one-shot CRC");

  // Every single-byte flip anywhere in the payload must change the checksum.
  bool everyFlipCaught = true;
  for (size_t index = 0; index < payload.size(); index += 7) {
    std::vector<uint8_t> damaged = payload;
    damaged[index] ^= 0x40u;
    const uint32_t damagedCrc =
        sr800::logcodec::crc32Finish(sr800::logcodec::crc32Update(
            sr800::logcodec::kCrc32Init, damaged.data(), damaged.size()));
    if (damagedCrc == crc) everyFlipCaught = false;
  }
  require(everyFlipCaught, "a flipped byte always changes the CRC");
}

void testTruncationRefused() {
  std::vector<RawSample> samples;
  for (int index = 0; index < 50; ++index) {
    samples.push_back(makeSample(1000u * index,
                                 static_cast<int16_t>(2500 + index * 137),
                                 2300, 6000, 4000));
  }
  const std::vector<uint8_t> payload = encodeAll(samples);

  // Cut the payload at every length short of the whole thing. The decoder must
  // never invent the missing tail: it either yields fewer samples than the
  // header promises or says NEED_MORE, and it never reports success for 50.
  bool refusedEverywhere = true;
  for (size_t length = 1; length < payload.size(); ++length) {
    std::vector<uint8_t> cut(payload.begin(), payload.begin() + length);
    std::vector<Sample> decoded;
    if (decodeAllDribbled(cut, samples.size(), decoded)) {
      refusedEverywhere = false;
    }
    if (decoded.size() >= samples.size()) refusedEverywhere = false;
  }
  require(refusedEverywhere,
          "no truncation of the payload ever decodes as a complete recording");

  // A frame cut mid-varint reports NEED_MORE, not MALFORMED: the caller must be
  // able to tell "refill me" from "this file is broken".
  Decoder decoder;
  sr800::logcodec::decodeBegin(decoder);
  Sample sample = {};
  size_t consumed = 0;
  const uint8_t continued[] = {0x80u};  // a varint that never terminates
  require(sr800::logcodec::decodeSample(decoder, continued, sizeof(continued),
                                        consumed, sample) ==
              DecodeStatus::NEED_MORE,
          "an unterminated varint asks for more bytes");
  require(sr800::logcodec::decodeSample(decoder, payload.data(), 0, consumed,
                                        sample) == DecodeStatus::NEED_MORE,
          "an empty slice asks for more bytes");

  // An illegal varint - six continuation bytes - is corruption, not a refill.
  const uint8_t overlong[] = {0x80u, 0x80u, 0x80u, 0x80u, 0x80u, 0x00u};
  sr800::logcodec::decodeBegin(decoder);
  require(sr800::logcodec::decodeSample(decoder, overlong, sizeof(overlong),
                                        consumed, sample) ==
              DecodeStatus::MALFORMED,
          "an over-long varint is refused as corruption");

  // An out-of-domain level: fan deci above the uint16 milli ceiling.
  const uint8_t badLevel[] = {0x00u, 0x01u, 0x01u, 0xFFu, 0xFFu, 0x03u, 0x00u};
  sr800::logcodec::decodeBegin(decoder);
  require(sr800::logcodec::decodeSample(decoder, badLevel, sizeof(badLevel),
                                        consumed, sample) ==
              DecodeStatus::MALFORMED,
          "a level outside the storable domain is refused");
}

// --- the raw layout the v1/v2 payloads still use -------------------------

void testRawSampleLayout() {
  // A v2-shaped payload: the frozen 12-byte little-endian record. The sketch
  // streams v1 and v2 archives through decodeRawSample, so this is the shipped
  // reader, not a parallel one.
  const uint8_t stream[] = {
      // t = 1000 ms, tc = 24.38 C (2438), cj = 22.10 C (2210), fan 5000, heat 0
      0xE8, 0x03, 0x00, 0x00, 0x86, 0x09, 0xA2, 0x08, 0x88, 0x13, 0x00, 0x00,
      // t = 2000 ms, tc missing (INT16_MIN), cj = -12.50 C (-1250), 100, 65535
      0xD0, 0x07, 0x00, 0x00, 0x00, 0x80, 0x1E, 0xFB, 0x64, 0x00, 0xFF, 0xFF};
  RawSample first = {};
  RawSample second = {};
  require(sr800::logcodec::decodeRawSample(stream, sizeof(stream), first),
          "the first raw record parses");
  require(sr800::logcodec::decodeRawSample(
              stream + sr800::logcodec::kRawSampleBytes,
              sizeof(stream) - sr800::logcodec::kRawSampleBytes, second),
          "the second raw record parses");
  require(first.tMs == 1000 && first.thermocoupleCenti == 2438 &&
              first.coldJunctionCenti == 2210 && first.fanMilli == 5000 &&
              first.heatMilli == 0,
          "the v2 record decodes to its stored centi-degrees");
  require(second.tMs == 2000 &&
              second.thermocoupleCenti == sr800::logcodec::kMissingCenti &&
              second.coldJunctionCenti == -1250 && second.fanMilli == 100 &&
              second.heatMilli == 65535,
          "the missing sentinel and a negative reading survive the raw layout");
  require(!sr800::logcodec::decodeRawSample(stream, 11, first),
          "a short raw record is refused rather than read past its end");

  // v1/v2 files keep their centi-degree precision forever: reading one must not
  // quietly apply the archive's rounding rule to data already on disk.
  require(first.thermocoupleCenti == 2438,
          "an archived v2 reading is not re-rounded on the way out");
}

// --- restore validation ----------------------------------------------------
//
// `POST /api/logs/restore` is the only way archive bytes enter the device from
// outside, so this is the only place the archive format is CHECKED rather than
// produced. Every assertion below is a 400 the operator would otherwise not get.

using sr800::logcodec::ArchiveSummary;
using sr800::logcodec::ArchiveVerdict;

constexpr uint32_t kMaxSamples = 4800;  // sr800::volume::kMaxRecordingSamples

void writeU16(std::vector<uint8_t>& out, size_t offset, uint16_t value) {
  out[offset] = static_cast<uint8_t>(value & 0xFFu);
  out[offset + 1] = static_cast<uint8_t>((value >> 8) & 0xFFu);
}

void writeU32(std::vector<uint8_t>& out, size_t offset, uint32_t value) {
  for (size_t index = 0; index < 4; ++index) {
    out[offset + index] = static_cast<uint8_t>((value >> (8 * index)) & 0xFFu);
  }
}

// A synthetic archive file built the way the sketch builds one: header fields
// at their wire offsets, then the payload. `version` selects which shape.
std::vector<uint8_t> makeArchiveFile(uint16_t version, uint32_t logId,
                                     const std::vector<RawSample>& samples) {
  size_t headerBytes = sr800::logcodec::kArchiveHeaderV1Bytes;
  if (version == 2) headerBytes = sr800::logcodec::kArchiveHeaderV2Bytes;
  if (version == 3) headerBytes = sr800::logcodec::kArchiveHeaderV3Bytes;
  if (version == 4) headerBytes = sr800::logcodec::kArchiveHeaderV4Bytes;

  std::vector<uint8_t> payload;
  if (version < 3) {
    // The frozen 12-byte record, little endian, exactly as v1/v2 stored it.
    for (const RawSample& raw : samples) {
      const uint16_t tc = static_cast<uint16_t>(raw.thermocoupleCenti);
      const uint16_t cj = static_cast<uint16_t>(raw.coldJunctionCenti);
      const uint8_t record[12] = {
          static_cast<uint8_t>(raw.tMs & 0xFFu),
          static_cast<uint8_t>((raw.tMs >> 8) & 0xFFu),
          static_cast<uint8_t>((raw.tMs >> 16) & 0xFFu),
          static_cast<uint8_t>((raw.tMs >> 24) & 0xFFu),
          static_cast<uint8_t>(tc & 0xFFu),
          static_cast<uint8_t>(tc >> 8),
          static_cast<uint8_t>(cj & 0xFFu),
          static_cast<uint8_t>(cj >> 8),
          static_cast<uint8_t>(raw.fanMilli & 0xFFu),
          static_cast<uint8_t>(raw.fanMilli >> 8),
          static_cast<uint8_t>(raw.heatMilli & 0xFFu),
          static_cast<uint8_t>(raw.heatMilli >> 8)};
      payload.insert(payload.end(), record, record + sizeof(record));
    }
  } else {
    payload = encodeAll(samples);
  }

  std::vector<uint8_t> file(headerBytes + payload.size(), 0);
  writeU32(file, sr800::logcodec::kArchiveOffsetMagic,
           sr800::logcodec::kArchiveMagic);
  writeU16(file, sr800::logcodec::kArchiveOffsetVersion, version);
  file[sr800::logcodec::kArchiveOffsetSource] = 4;  // ROAST
  writeU32(file, sr800::logcodec::kArchiveOffsetLogId, logId);
  writeU32(file, sr800::logcodec::kArchiveOffsetSampleCount,
           static_cast<uint32_t>(samples.size()));
  if (version >= 2) file[sr800::logcodec::kArchiveOffsetZoneCount] = 3;
  if (version >= 3) {
    writeU32(file, sr800::logcodec::kArchiveOffsetEncodedBytes,
             static_cast<uint32_t>(payload.size()));
    file[sr800::logcodec::kArchiveOffsetCodec] =
        sr800::logcodec::kCodecDeltaVarint;
  }
  if (version == 4) {
    const auto putText = [&](size_t offset, size_t capacity, const char* value) {
      const size_t count = std::min(capacity - 1, std::strlen(value));
      std::copy(value, value + count, file.begin() + offset);
    };
    putText(sr800::logcodec::kArchiveOffsetSourceDeviceId,
            sr800::logcodec::kArchiveDeviceIdBytes, "esp32-a1b2c3d4e5f6");
    putText(sr800::logcodec::kArchiveOffsetSourceModelId,
            sr800::logcodec::kArchiveModelIdBytes, "freshroast-sr800");
    putText(sr800::logcodec::kArchiveOffsetSourceDisplayName,
            sr800::logcodec::kArchiveDisplayNameBytes, "FreshRoast SR800");
    putText(sr800::logcodec::kArchiveOffsetSourceFirmwareVersion,
            sr800::logcodec::kArchiveFirmwareVersionBytes, "2026-07-26.43");
    writeU32(file, sr800::logcodec::kArchiveOffsetOriginLogId, logId);
    writeU16(file, sr800::logcodec::kArchiveOffsetThermocoupleOffsetCenti,
             static_cast<uint16_t>(static_cast<int16_t>(-300)));
    file[sr800::logcodec::kArchiveOffsetThermocoupleOffsetFlags] =
        sr800::logcodec::kArchiveThermocoupleOffsetPresent;
    const uint32_t provenanceCrc = sr800::logcodec::crc32Finish(
        sr800::logcodec::crc32Update(
            sr800::logcodec::kCrc32Init,
            file.data() + sr800::logcodec::kArchiveOffsetSourceDeviceId,
            sr800::logcodec::kArchiveOffsetProvenanceCrc32 -
                sr800::logcodec::kArchiveOffsetSourceDeviceId));
    writeU32(file, sr800::logcodec::kArchiveOffsetProvenanceCrc32,
             provenanceCrc);
  }
  std::copy(payload.begin(), payload.end(), file.begin() + headerBytes);
  if (version == 3) {
    writeU32(file, sr800::logcodec::kArchiveOffsetCrc32,
             sr800::logcodec::crc32Finish(sr800::logcodec::crc32Update(
                 sr800::logcodec::kCrc32Init, payload.data(), payload.size())));
  } else if (version == 4) {
    uint32_t crc = sr800::logcodec::kCrc32Init;
    crc = sr800::logcodec::crc32Update(
        crc, file.data(), sr800::logcodec::kArchiveOffsetCrc32);
    crc = sr800::logcodec::crc32Update(
        crc, file.data() + sr800::logcodec::kArchiveOffsetCodec,
        headerBytes - sr800::logcodec::kArchiveOffsetCodec);
    crc = sr800::logcodec::crc32Update(crc, payload.data(), payload.size());
    writeU32(file, sr800::logcodec::kArchiveOffsetCrc32,
             sr800::logcodec::crc32Finish(crc));
  }
  return file;
}

void rewriteArchiveV4Crc(std::vector<uint8_t>& file) {
  uint32_t crc = sr800::logcodec::kCrc32Init;
  crc = sr800::logcodec::crc32Update(
      crc, file.data(), sr800::logcodec::kArchiveOffsetCrc32);
  crc = sr800::logcodec::crc32Update(
      crc, file.data() + sr800::logcodec::kArchiveOffsetCodec,
      sr800::logcodec::kArchiveHeaderV4Bytes -
          sr800::logcodec::kArchiveOffsetCodec);
  crc = sr800::logcodec::crc32Update(
      crc, file.data() + sr800::logcodec::kArchiveHeaderV4Bytes,
      file.size() - sr800::logcodec::kArchiveHeaderV4Bytes);
  writeU32(file, sr800::logcodec::kArchiveOffsetCrc32,
           sr800::logcodec::crc32Finish(crc));
}

std::vector<RawSample> restoreFixtureSamples(size_t count) {
  std::vector<RawSample> samples;
  for (size_t index = 0; index < count; ++index) {
    RawSample raw = {};
    raw.tMs = static_cast<uint32_t>(index * 1000);
    raw.thermocoupleCenti = static_cast<int16_t>(2500 + index * 37);
    raw.coldJunctionCenti = static_cast<int16_t>(2210 + (index % 5));
    raw.fanMilli = 800;
    raw.heatMilli = static_cast<uint16_t>(index % 2 == 0 ? 700 : 600);
    samples.push_back(raw);
  }
  return samples;
}

ArchiveVerdict verdictOf(const std::vector<uint8_t>& file) {
  ArchiveSummary summary = {};
  return sr800::logcodec::validateArchiveBuffer(file.data(), file.size(),
                                                kMaxSamples, summary);
}

void testRestoreValidation() {
  const std::vector<RawSample> samples = restoreFixtureSamples(120);

  // --- the happy path, and what it reports back ---
  const std::vector<uint8_t> v3 = makeArchiveFile(4, 4242, samples);
  ArchiveSummary summary = {};
  require(sr800::logcodec::validateArchiveBuffer(v3.data(), v3.size(),
                                                 kMaxSamples, summary) ==
              ArchiveVerdict::OK,
          "a well-formed v4 recording validates");
  require(summary.version == 4 && summary.logId == 4242 &&
              summary.sampleCount == samples.size() &&
              summary.headerBytes == sr800::logcodec::kArchiveHeaderV4Bytes &&
              summary.codec == sr800::logcodec::kCodecDeltaVarint,
          "the summary reports the identity the restore endpoint stores it "
          "under");
  require(summary.encodedBytes == v3.size() - sr800::logcodec::kArchiveHeaderV4Bytes,
          "encodedBytes describes the whole payload and nothing else");
  std::vector<uint8_t> missingOffset = v3;
  missingOffset[sr800::logcodec::kArchiveOffsetThermocoupleOffsetFlags] = 0;
  const uint32_t missingOffsetProvenanceCrc = sr800::logcodec::crc32Finish(
      sr800::logcodec::crc32Update(
          sr800::logcodec::kCrc32Init,
          missingOffset.data() + sr800::logcodec::kArchiveOffsetSourceDeviceId,
          sr800::logcodec::kArchiveOffsetProvenanceCrc32 -
              sr800::logcodec::kArchiveOffsetSourceDeviceId));
  writeU32(missingOffset, sr800::logcodec::kArchiveOffsetProvenanceCrc32,
           missingOffsetProvenanceCrc);
  rewriteArchiveV4Crc(missingOffset);
  require(verdictOf(missingOffset) == ArchiveVerdict::PROVENANCE,
          "a v4 recording without its applied thermocouple offset is refused");
  require(std::strcmp(summary.sourceDeviceId, "esp32-a1b2c3d4e5f6") == 0 &&
              std::strcmp(summary.sourceModelId, "freshroast-sr800") == 0 &&
              std::strcmp(summary.sourceFirmwareVersion, "2026-07-26.43") == 0 &&
              summary.originLogId == 4242 && !summary.simulated &&
              summary.thermocoupleOffsetPresent &&
              summary.thermocoupleOffsetCenti == -300,
          "the archive reports its immutable producer and origin log identity");

  // A pre-actuation provisional is a complete archive whose plan envelope is
  // the whole payload. Equality is valid only because sampleCount is zero.
  {
    sr800::logcodec::PlanProvenance provisional = {};
    provisional.mode = sr800::logcodec::PlanMode::MANUAL;
    provisional.itemCount = 1;
    provisional.items[0].fanDeci = 40;
    provisional.items[0].heatDeci = 0;
    uint8_t plan[sr800::logcodec::kMaxPlanEnvelopeBytes] = {};
    const size_t planBytes = sr800::logcodec::encodePlanProvenance(
        provisional, plan, sizeof(plan));
    require(planBytes > 0, "a provisional manual plan encodes");

    std::vector<uint8_t> planOnly = makeArchiveFile(
        4, 4243, std::vector<RawSample>{});
    planOnly.resize(sr800::logcodec::kArchiveHeaderV4Bytes + planBytes);
    std::copy(plan, plan + planBytes,
              planOnly.begin() + sr800::logcodec::kArchiveHeaderV4Bytes);
    writeU32(planOnly, sr800::logcodec::kArchiveOffsetEncodedBytes,
             static_cast<uint32_t>(planBytes));
    planOnly[sr800::logcodec::kArchiveOffsetCodec] =
        sr800::logcodec::kCodecDeltaVarintPlan;
    rewriteArchiveV4Crc(planOnly);

    ArchiveSummary provisionalSummary = {};
    require(sr800::logcodec::validateArchiveBuffer(
                planOnly.data(), planOnly.size(), kMaxSamples,
                provisionalSummary) == ArchiveVerdict::OK &&
                provisionalSummary.sampleCount == 0 &&
                provisionalSummary.encodedBytes == planBytes,
            "a plan-only zero-sample provisional validates for restore");

    std::vector<uint8_t> missingSample = planOnly;
    writeU32(missingSample, sr800::logcodec::kArchiveOffsetSampleCount, 1);
    rewriteArchiveV4Crc(missingSample);
    require(verdictOf(missingSample) == ArchiveVerdict::PAYLOAD_UNDECODABLE,
            "plan-length equality cannot hide a missing declared sample");
  }
  // An automatic restore changes only the local storage id and whole-file CRC.
  // The immutable producer identity and producer-side log id remain intact.
  std::vector<uint8_t> remapped = v3;
  writeU32(remapped, sr800::logcodec::kArchiveOffsetLogId, 77);
  rewriteArchiveV4Crc(remapped);
  ArchiveSummary remappedSummary = {};
  require(sr800::logcodec::validateArchiveBuffer(
              remapped.data(), remapped.size(), kMaxSamples, remappedSummary) ==
              ArchiveVerdict::OK &&
              remappedSummary.logId == 77 &&
              remappedSummary.originLogId == 4242 &&
              std::strcmp(remappedSummary.sourceDeviceId,
                          "esp32-a1b2c3d4e5f6") == 0,
          "assigning a local restore address preserves immutable origin identity");

  // --- v1 and v2 validate under THEIR rules, not v3's ---
  //
  // These are the files already on deployed devices. A backup taken from a
  // device that has never written v3 must restore, and it has no checksum to
  // offer - the size rule is the only structure a v1 file has.
  const std::vector<uint8_t> v1 = makeArchiveFile(1, 7, samples);
  const std::vector<uint8_t> v2 = makeArchiveFile(2, 8, samples);
  require(v1.size() == 32 + samples.size() * 12,
          "a v1 file is a 32-byte header and a fixed-stride array");
  require(v2.size() == 92 + samples.size() * 12,
          "a v2 file is a 92-byte header and the same array");
  require(verdictOf(v1) == ArchiveVerdict::BAD_VERSION,
          "an identity-less v1 recording is quarantined");
  require(verdictOf(v2) == ArchiveVerdict::BAD_VERSION,
          "an identity-less v2 recording is quarantined");

  // A v1/v2 file whose length disagrees with sampleCount x 12 is refused: with
  // no checksum, the stride IS the integrity check.
  std::vector<uint8_t> v2Short = v2;
  v2Short.pop_back();
  require(verdictOf(v2Short) == ArchiveVerdict::BAD_VERSION,
          "a v2 file one byte short of its stride is refused");
  std::vector<uint8_t> v2Long = v2;
  v2Long.push_back(0);
  require(verdictOf(v2Long) == ArchiveVerdict::BAD_VERSION,
          "a v2 file with a trailing byte is refused");

  // --- truncation, at every length ---
  //
  // Not one truncation: all of them. A restore must never accept a partial
  // upload, and "the last byte is missing" is the failure a transfer actually
  // produces.
  bool everyTruncationRefused = true;
  for (size_t length = 0; length < v3.size(); ++length) {
    ArchiveSummary ignored = {};
    if (sr800::logcodec::validateArchiveBuffer(v3.data(), length, kMaxSamples,
                                               ignored) == ArchiveVerdict::OK) {
      everyTruncationRefused = false;
    }
  }
  require(everyTruncationRefused,
          "no prefix of a recording, of any length, validates as one");
  require(verdictOf(std::vector<uint8_t>(v3.begin(), v3.begin() + 20)) ==
              ArchiveVerdict::TRUNCATED_HEADER,
          "a file shorter than a v1 header fails as a truncated header");
  require(verdictOf(std::vector<uint8_t>(v3.begin(), v3.begin() + 96)) ==
              ArchiveVerdict::TRUNCATED_HEADER,
          "a v3 file cut inside its own header fails as a truncated header");

  // --- the checksum ---
  std::vector<uint8_t> flippedCrc = v3;
  flippedCrc[sr800::logcodec::kArchiveOffsetCrc32] ^= 0x01;
  require(verdictOf(flippedCrc) == ArchiveVerdict::CRC_MISMATCH,
          "a flipped bit in the stored CRC is refused");
  std::vector<uint8_t> flippedPayload = v3;
  flippedPayload[sr800::logcodec::kArchiveHeaderV4Bytes + 6] ^= 0x80;
  require(verdictOf(flippedPayload) == ArchiveVerdict::CRC_MISMATCH,
          "a flipped bit in the payload is refused");

  // --- a file that checksums and still is not a recording ---
  //
  // This is the check the serving reader does not do. Re-checksumming garbage
  // makes it self-consistent; only decoding it finds out what it is. Without
  // this, the restore would land an archive entry that lists correctly and
  // serves a truncated CSV forever.
  {
    std::vector<uint8_t> garbage = v3;
    for (size_t index = sr800::logcodec::kArchiveHeaderV4Bytes; index < garbage.size(); ++index) {
      garbage[index] = 0xFF;  // never a terminated varint
    }
    rewriteArchiveV4Crc(garbage);

    require(verdictOf(garbage) == ArchiveVerdict::PAYLOAD_UNDECODABLE,
            "a payload that checksums but does not decode is refused");
  }
  {
    // The subtler one: a payload that decodes fine but ends early, so the
    // header's sample count and its byte count cannot both be true.
    std::vector<uint8_t> shortCount = makeArchiveFile(4, 9, samples);
    writeU32(shortCount, sr800::logcodec::kArchiveOffsetSampleCount,
             static_cast<uint32_t>(samples.size() - 5));
    rewriteArchiveV4Crc(shortCount);
    require(verdictOf(shortCount) == ArchiveVerdict::PAYLOAD_UNDECODABLE,
            "a payload with frames left over after the last sample is refused");
  }

  // Provenance has its own checksum so listing never exposes a relabelled
  // recording, and the full-file checksum independently covers it too.
  std::vector<uint8_t> relabelled = v3;
  relabelled[sr800::logcodec::kArchiveOffsetSourceDeviceId] ^= 1;
  require(verdictOf(relabelled) == ArchiveVerdict::PROVENANCE,
          "tampered producer identity is quarantined before listing");
  std::vector<uint8_t> missingIdentity = v3;
  for (size_t index = 0; index < sr800::logcodec::kArchiveDeviceIdBytes; ++index) {
    missingIdentity[sr800::logcodec::kArchiveOffsetSourceDeviceId + index] = 0;
  }
  const uint32_t provenanceCrc = sr800::logcodec::crc32Finish(
      sr800::logcodec::crc32Update(
          sr800::logcodec::kCrc32Init,
          missingIdentity.data() + sr800::logcodec::kArchiveOffsetSourceDeviceId,
          sr800::logcodec::kArchiveOffsetProvenanceCrc32 -
              sr800::logcodec::kArchiveOffsetSourceDeviceId));
  writeU32(missingIdentity, sr800::logcodec::kArchiveOffsetProvenanceCrc32,
           provenanceCrc);
  rewriteArchiveV4Crc(missingIdentity);
  require(verdictOf(missingIdentity) == ArchiveVerdict::PROVENANCE,
          "an empty producer identity cannot be made valid by recomputing checksums");

  // --- header fields ---
  std::vector<uint8_t> badMagic = v3;
  badMagic[0] = 'X';
  require(verdictOf(badMagic) == ArchiveVerdict::BAD_MAGIC,
          "a file that is not an archive at all is refused on its magic");
  std::vector<uint8_t> futureVersion = v3;
  writeU16(futureVersion, sr800::logcodec::kArchiveOffsetVersion, 5);
  require(verdictOf(futureVersion) == ArchiveVerdict::BAD_VERSION,
          "a version this firmware cannot read is refused, not guessed at");
  std::vector<uint8_t> zeroVersion = v3;
  writeU16(zeroVersion, sr800::logcodec::kArchiveOffsetVersion, 0);
  require(verdictOf(zeroVersion) == ArchiveVerdict::BAD_VERSION,
          "version 0 is refused");
  std::vector<uint8_t> hugeCount = v3;
  writeU32(hugeCount, sr800::logcodec::kArchiveOffsetSampleCount, 0xFFFFFFFFu);
  require(verdictOf(hugeCount) == ArchiveVerdict::SAMPLE_COUNT,
          "a sample count past the RAM log's capacity is refused BEFORE it is "
          "multiplied by a stride");
  std::vector<uint8_t> badZones = v3;
  badZones[sr800::logcodec::kArchiveOffsetZoneCount] = 13;
  require(verdictOf(badZones) == ArchiveVerdict::ZONE_COUNT,
          "more journey zones than exist is refused");
  std::vector<uint8_t> badCodec = v3;
  badCodec[sr800::logcodec::kArchiveOffsetCodec] = 9;
  require(verdictOf(badCodec) == ArchiveVerdict::BAD_CODEC,
          "an unknown codec id is refused");
  std::vector<uint8_t> lyingLength = v3;
  writeU32(lyingLength, sr800::logcodec::kArchiveOffsetEncodedBytes,
           static_cast<uint32_t>(v3.size()));
  require(verdictOf(lyingLength) == ArchiveVerdict::SIZE_MISMATCH,
          "a header claiming a longer payload than the file holds is refused");

  // The reserved v3 codec (a v2-shaped payload under a v3 header) still has to
  // match the stride. Nothing writes it; if anything ever does, it is checked.
  {
    std::vector<uint8_t> rawCodec = makeArchiveFile(4, 11, samples);
    rawCodec[sr800::logcodec::kArchiveOffsetCodec] =
        sr800::logcodec::kCodecRaw;
    require(verdictOf(rawCodec) == ArchiveVerdict::SIZE_MISMATCH,
            "a v3 header naming the raw codec is held to the 12-byte stride");
  }

  // Every verdict has a name and a sentence: the endpoint puts both in its 400,
  // so an unnamed one would ship as "unknown" to the operator.
  const ArchiveVerdict verdicts[] = {
      ArchiveVerdict::OK,          ArchiveVerdict::TRUNCATED_HEADER,
      ArchiveVerdict::BAD_MAGIC,   ArchiveVerdict::BAD_VERSION,
      ArchiveVerdict::SAMPLE_COUNT, ArchiveVerdict::ZONE_COUNT,
      ArchiveVerdict::BAD_CODEC,   ArchiveVerdict::SIZE_MISMATCH,
      ArchiveVerdict::CRC_MISMATCH, ArchiveVerdict::PROVENANCE,
      ArchiveVerdict::PAYLOAD_UNDECODABLE};
  bool named = true;
  for (const ArchiveVerdict verdict : verdicts) {
    if (std::strcmp(sr800::logcodec::archiveVerdictName(verdict), "unknown") ==
            0 ||
        std::strlen(sr800::logcodec::archiveVerdictReason(verdict)) < 10) {
      named = false;
    }
  }
  require(named, "every verdict carries a token and a sentence");
}

// --- bounded streaming validation -----------------------------------------
//
// The device's multipart callback writes straight to LittleFS. The validator
// then reads the temp file through this exact read-at contract, never through a
// second file-sized allocation.
struct ArchiveVectorReader {
  const std::vector<uint8_t>* bytes;
  size_t readableBytes;
  size_t largestRequest;
  size_t calls;
};

size_t readArchiveVector(void* context, size_t offset, uint8_t* out,
                         size_t length) {
  ArchiveVectorReader& reader = *static_cast<ArchiveVectorReader*>(context);
  reader.calls++;
  reader.largestRequest = std::max(reader.largestRequest, length);
  if (offset > reader.readableBytes ||
      length > reader.readableBytes - offset) {
    return 0;
  }
  std::copy(reader.bytes->begin() + offset,
            reader.bytes->begin() + offset + length, out);
  return length;
}

void testStreamingRestoreValidation() {
  const std::vector<uint8_t> file =
      makeArchiveFile(4, 31, restoreFixtureSamples(4800));
  ArchiveVectorReader reader{&file, file.size(), 0, 0};
  ArchiveSummary summary = {};
  require(sr800::logcodec::validateArchiveReader(
              &readArchiveVector, &reader, file.size(), kMaxSamples,
              summary) == ArchiveVerdict::OK,
          "a maximum-sample recording validates through bounded reads");
  require(summary.logId == 31 && summary.sampleCount == 4800,
          "streaming validation returns the same archive identity");
  require(reader.largestRequest <= 256 && reader.calls > 2,
          "validation never requests a file-sized buffer");

  ArchiveVectorReader shortReader{&file, file.size() - 1, 0, 0};
  ArchiveSummary ignored = {};
  require(sr800::logcodec::validateArchiveReader(
              &readArchiveVector, &shortReader, file.size(), kMaxSamples,
              ignored) != ArchiveVerdict::OK,
          "a short file read cannot validate as a complete upload");

  std::vector<uint8_t> damaged = file;
  damaged.back() ^= 0x01;
  ArchiveVectorReader damagedReader{&damaged, damaged.size(), 0, 0};
  require(sr800::logcodec::validateArchiveReader(
              &readArchiveVector, &damagedReader, damaged.size(), kMaxSamples,
              ignored) == ArchiveVerdict::CRC_MISMATCH,
          "the streaming path rejects payload corruption before commit");
}

void setJourneyZone(sr800::logcodec::PlanItem& item, int startDeci,
                    int endDeci, int duration, int fanMin, int fanMax,
                    int heatMin, int heatMax) {
  item = sr800::logcodec::PlanItem{};
  item.startDeci = static_cast<int16_t>(startDeci);
  item.endDeci = static_cast<int16_t>(endDeci);
  item.durationSec = static_cast<uint16_t>(duration);
  item.fanMinDeci = static_cast<uint8_t>(fanMin);
  item.fanMaxDeci = static_cast<uint8_t>(fanMax);
  item.heatMinDeci = static_cast<uint8_t>(heatMin);
  item.heatMaxDeci = static_cast<uint8_t>(heatMax);
}

void testPlanProvenanceCodec() {
  using sr800::logcodec::PlanMode;
  using sr800::logcodec::PlanProvenance;
  PlanProvenance plan = {};
  plan.mode = PlanMode::JOURNEY;
  plan.itemCount = 3;
  setJourneyZone(plan.items[0], 250, 1400, 180, 20, 80, 10, 100);
  setJourneyZone(plan.items[1], 1400, 1850, 210, 30, 90, 10, 90);
  setJourneyZone(plan.items[2], 1850, 2050, 160, 40, 100, 0, 80);
  plan.journalCount = 2;
  plan.journal[0].elapsedSec = 75;
  plan.journal[0].planRevision = 2;
  plan.journal[0].itemCount = 3;
  memcpy(plan.journal[0].items, plan.items,
         plan.itemCount * sizeof(plan.items[0]));
  plan.journal[0].items[1].endDeci = 1880;
  plan.journal[0].items[1].durationSec = 240;
  plan.journal[1].elapsedSec = 130;
  plan.journal[1].planRevision = 3;
  plan.journal[1].itemCount = 4;
  memcpy(plan.journal[1].items, plan.journal[0].items,
         plan.journal[0].itemCount * sizeof(plan.items[0]));
  setJourneyZone(plan.journal[1].items[3], 2050, 2150, 90, 50, 100, 0, 60);

  uint8_t encoded[sr800::logcodec::kMaxPlanEnvelopeBytes] = {};
  const size_t bytes = sr800::logcodec::encodePlanProvenance(
      plan, encoded, sizeof(encoded));
  require(bytes > 0 && bytes < 100,
          "a four-zone initial plan and two edits stay under 100 bytes");

  PlanProvenance decoded = {};
  size_t consumed = 0;
  require(sr800::logcodec::decodePlanProvenance(
              encoded, bytes, decoded, consumed) &&
              consumed == bytes,
          "plan provenance round-trips as one exact envelope");
  require(decoded.mode == PlanMode::JOURNEY && decoded.itemCount == 3 &&
              decoded.journalCount == 2,
          "initial plan identity and journal count survive");
  require(decoded.items[1].endDeci == 1850 &&
              decoded.journal[0].items[1].endDeci == 1880 &&
              decoded.journal[1].itemCount == 4 &&
              decoded.journal[1].items[3].endDeci == 2150,
          "the immutable initial plan and accepted snapshots remain distinct");

  PlanProvenance timed = {};
  timed.mode = PlanMode::TIMED;
  timed.itemCount = 1;
  timed.items[0].fanDeci = 40;
  timed.items[0].heatDeci = 50;
  timed.items[0].durationSec = 30;
  timed.journalCount = 2;
  timed.journal[0].elapsedSec = 5;
  timed.journal[0].planRevision = 2;
  timed.journal[0].itemIndex = 0;
  timed.journal[0].itemCount = 1;
  timed.journal[0].items[0] = timed.items[0];
  timed.journal[0].items[0].heatDeci = 60;
  timed.journal[1].elapsedSec = 9;
  timed.journal[1].planRevision = 3;
  timed.journal[1].itemIndex = 1;
  timed.journal[1].itemCount = 1;
  timed.journal[1].items[0] = timed.items[0];
  timed.journal[1].items[0].fanDeci = 70;
  timed.journal[1].items[0].durationSec = 45;
  const size_t timedBytes = sr800::logcodec::encodePlanProvenance(
      timed, encoded, sizeof(encoded));
  require(timedBytes > 0 && timedBytes < 40,
          "timed replacement and append provenance stay compact");
  PlanProvenance decodedTimed = {};
  require(sr800::logcodec::decodePlanProvenance(
              encoded, timedBytes, decodedTimed, consumed) &&
              consumed == timedBytes && decodedTimed.journalCount == 2 &&
              decodedTimed.journal[1].itemIndex == 1,
          "timed replacement and next-step append round-trip");

  const std::vector<uint8_t> validTimedEnvelope(encoded, encoded + timedBytes);
  std::vector<uint8_t> timedBackwardsElapsed = validTimedEnvelope;
  timedBackwardsElapsed[18] = 4;
  require(!sr800::logcodec::validatePlanEnvelope(
              timedBackwardsElapsed.data(), timedBackwardsElapsed.size(), consumed),
          "the decoder rejects a journal whose elapsed time moves backwards");
  std::vector<uint8_t> timedDuplicateRevision(encoded, encoded + timedBytes);
  timedDuplicateRevision[19] = 2;
  require(!sr800::logcodec::validatePlanEnvelope(
              timedDuplicateRevision.data(), timedDuplicateRevision.size(), consumed),
          "the decoder rejects a journal whose revision does not increase");
  std::vector<uint8_t> timedHeatWithoutFan(encoded, encoded + timedBytes);
  timedHeatWithoutFan[7] = 0;
  require(!sr800::logcodec::validatePlanEnvelope(
              timedHeatWithoutFan.data(), timedHeatWithoutFan.size(), consumed),
          "the decoder rejects initial timed heat with fan zero");
  std::vector<uint8_t> timedDurationTooLong(encoded, encoded + timedBytes);
  timedDurationTooLong[9] = 0x09;
  timedDurationTooLong[10] = 0x07;
  require(!sr800::logcodec::validatePlanEnvelope(
              timedDurationTooLong.data(), timedDurationTooLong.size(), consumed),
          "the decoder rejects an initial timed duration above 1800 seconds");
  std::vector<uint8_t> timedJournalHeatWithoutFan(encoded, encoded + timedBytes);
  timedJournalHeatWithoutFan[14] = 0;
  require(!sr800::logcodec::validatePlanEnvelope(
              timedJournalHeatWithoutFan.data(), timedJournalHeatWithoutFan.size(), consumed),
          "the decoder rejects journaled timed heat with fan zero");
  std::vector<uint8_t> timedJournalDurationTooLong(encoded, encoded + timedBytes);
  timedJournalDurationTooLong[16] = 0x09;
  timedJournalDurationTooLong[17] = 0x07;
  require(!sr800::logcodec::validatePlanEnvelope(
              timedJournalDurationTooLong.data(), timedJournalDurationTooLong.size(), consumed),
          "the decoder rejects a journaled timed duration above 1800 seconds");
  std::vector<uint8_t> timedItemOverflow = {
      sr800::logcodec::kPlanEnvelopeMagic,
      sr800::logcodec::kPlanEnvelopeVersion, 1, 24, 1, 0, 0};
  for (uint8_t index = 0; index < 24; ++index) {
    timedItemOverflow.push_back(40);
    timedItemOverflow.push_back(0);
    timedItemOverflow.push_back(30);
    timedItemOverflow.push_back(0);
  }
  timedItemOverflow.insert(timedItemOverflow.end(), {1, 2, 24, 40, 0, 30, 0});
  timedItemOverflow[5] = static_cast<uint8_t>(timedItemOverflow.size());
  timedItemOverflow[6] = static_cast<uint8_t>(timedItemOverflow.size() >> 8);
  require(!sr800::logcodec::validatePlanEnvelope(
              timedItemOverflow.data(), timedItemOverflow.size(), consumed),
          "the decoder cannot append a twenty-fifth timed step");

  PlanProvenance invalidTimed = timed;
  invalidTimed.journal[1].elapsedSec = 4;
  require(sr800::logcodec::encodePlanProvenance(
              invalidTimed, encoded, sizeof(encoded)) == 0,
          "the encoder rejects a journal whose elapsed time moves backwards");
  invalidTimed = timed;
  invalidTimed.journal[1].planRevision = 2;
  require(sr800::logcodec::encodePlanProvenance(
              invalidTimed, encoded, sizeof(encoded)) == 0,
          "the encoder rejects a journal whose revision does not increase");
  invalidTimed = timed;
  invalidTimed.items[0].fanDeci = 0;
  require(sr800::logcodec::encodePlanProvenance(
              invalidTimed, encoded, sizeof(encoded)) == 0,
          "the encoder rejects initial timed heat with fan zero");
  invalidTimed = timed;
  invalidTimed.items[0].durationSec = 1801;
  require(sr800::logcodec::encodePlanProvenance(
              invalidTimed, encoded, sizeof(encoded)) == 0,
          "the encoder rejects an initial timed duration above 1800 seconds");
  invalidTimed = timed;
  invalidTimed.journal[0].items[0].fanDeci = 0;
  require(sr800::logcodec::encodePlanProvenance(
              invalidTimed, encoded, sizeof(encoded)) == 0,
          "the encoder rejects journaled timed heat with fan zero");
  invalidTimed = timed;
  invalidTimed.journal[0].items[0].durationSec = 1801;
  require(sr800::logcodec::encodePlanProvenance(
              invalidTimed, encoded, sizeof(encoded)) == 0,
          "the encoder rejects a journaled timed duration above 1800 seconds");

  PlanProvenance calibration = {};
  calibration.mode = PlanMode::CALIBRATION;
  calibration.itemCount = 2;
  calibration.minimumDwellSec = 23;
  calibration.settleSeconds = 14;
  calibration.settleBandTenthsC = 17;
  calibration.items[0].fanDeci = 40;
  calibration.items[0].heatDeci = 20;
  calibration.items[0].durationSec = 171;
  calibration.items[1].fanDeci = 60;
  calibration.items[1].heatDeci = 80;
  calibration.items[1].durationSec = 171;
  const size_t calibrationBytes = sr800::logcodec::encodePlanProvenance(
      calibration, encoded, sizeof(encoded));
  PlanProvenance decodedCalibration = {};
  require(calibrationBytes > 0 &&
              sr800::logcodec::decodePlanProvenance(
                  encoded, calibrationBytes, decodedCalibration, consumed) &&
              consumed == calibrationBytes &&
              decodedCalibration.mode == PlanMode::CALIBRATION &&
              decodedCalibration.itemCount == 2 &&
              decodedCalibration.items[1].fanDeci == 60 &&
              decodedCalibration.items[1].durationSec == 171 &&
              decodedCalibration.minimumDwellSec == 23 &&
              decodedCalibration.settleSeconds == 14 &&
              decodedCalibration.settleBandTenthsC == 17,
          "the exact calibration program and settle policy round-trip");
  PlanProvenance invalidCalibration = calibration;
  invalidCalibration.journalCount = 1;
  require(sr800::logcodec::encodePlanProvenance(
              invalidCalibration, encoded, sizeof(encoded)) == 0,
          "calibration provenance refuses a mutable journal");
  invalidCalibration = calibration;
  invalidCalibration.settleBandTenthsC = 1;
  require(sr800::logcodec::encodePlanProvenance(
              invalidCalibration, encoded, sizeof(encoded)) == 0,
          "calibration provenance refuses an out-of-range settle band");
  std::vector<uint8_t> timedGap = validTimedEnvelope;
  timedGap[13] = 3;
  require(!sr800::logcodec::validatePlanEnvelope(
              timedGap.data(), timedGap.size(), consumed),
          "a timed journal cannot create a hole in the executable step list");
  timed.journal[1].itemIndex = 3;
  require(sr800::logcodec::encodePlanProvenance(
              timed, encoded, sizeof(encoded)) == 0,
          "the encoder refuses a timed journal step hole");

  PlanProvenance manual = {};
  manual.mode = PlanMode::MANUAL;
  manual.itemCount = 1;
  manual.items[0].fanDeci = 40;
  manual.items[0].heatDeci = 0;
  manual.journalCount = 3;
  for (uint8_t index = 0; index < manual.journalCount; ++index) {
    manual.journal[index].elapsedSec = index;
    manual.journal[index].planRevision = index + 1;
    manual.journal[index].itemCount = 1;
    manual.journal[index].items[0].fanDeci = 40 + index * 10;
    manual.journal[index].items[0].heatDeci = index * 20;
    manual.journal[index].items[0].fanMinDeci = 40 + index * 10;
    manual.journal[index].items[0].heatMinDeci = index == 1 ? 0 : index * 20;
  }
  const size_t manualBytes = sr800::logcodec::encodePlanProvenance(
      manual, encoded, sizeof(encoded));
  require(manualBytes > 0 && manualBytes < 40,
          "three manual instructions stay compact");
  PlanProvenance decodedManual = {};
  require(sr800::logcodec::decodePlanProvenance(
              encoded, manualBytes, decodedManual, consumed) &&
              consumed == manualBytes && decodedManual.journalCount == 3,
          "manual instruction provenance round-trips");
  require(decodedManual.journal[1].items[0].fanDeci == 50 &&
              decodedManual.journal[1].items[0].heatDeci == 20 &&
              decodedManual.journal[1].items[0].fanMinDeci == 50 &&
              decodedManual.journal[1].items[0].heatMinDeci == 0,
          "manual requested and effective levels remain distinct");

  size_t ignored = 0;
  std::vector<uint8_t> damaged(encoded, encoded + manualBytes);
  damaged[0] ^= 0x01;
  require(!sr800::logcodec::validatePlanEnvelope(
              damaged.data(), damaged.size(), ignored),
          "plan envelope corruption is refused");
  require(!sr800::logcodec::validatePlanEnvelope(
              encoded, manualBytes - 1, ignored),
          "a truncated plan envelope is refused");

  PlanProvenance maximum = {};
  maximum.mode = PlanMode::JOURNEY;
  maximum.itemCount = 12;
  for (uint8_t index = 0; index < maximum.itemCount; ++index) {
    setJourneyZone(maximum.items[index], 250 + 100 * index,
                   350 + 100 * index, 300, 10, 100, 0, 100);
  }
  maximum.journalCount =
      static_cast<uint8_t>(sr800::logcodec::kMaxPlanJournalEvents);
  for (uint8_t event = 0; event < maximum.journalCount; ++event) {
    maximum.journal[event].elapsedSec = static_cast<uint16_t>(event * 90);
    maximum.journal[event].planRevision = static_cast<uint16_t>(event + 2);
    maximum.journal[event].itemCount = maximum.itemCount;
    const sr800::logcodec::PlanItem* prior =
        event == 0 ? maximum.items : maximum.journal[event - 1].items;
    memcpy(maximum.journal[event].items, prior,
           maximum.itemCount * sizeof(maximum.items[0]));
    maximum.journal[event].items[event % maximum.itemCount].durationSec++;
  }
  const size_t maximumBytes = sr800::logcodec::encodePlanProvenance(
      maximum, encoded, sizeof(encoded));
  require(maximumBytes > 0 &&
              maximumBytes <= sr800::logcodec::kMaxPlanEnvelopeBytes,
          "all 32 accepted single-field edits fit the bounded envelope");

  // Deliberately hostile full-plan churn cannot grow the file: it is refused
  // once it crosses the explicit 1024-byte contract.
  for (uint8_t event = 0; event < maximum.journalCount; ++event) {
    for (uint8_t index = 0; index < maximum.itemCount; ++index) {
      maximum.journal[event].items[index].startDeci =
          static_cast<int16_t>((event * 300 + index * 17) % 3000);
      maximum.journal[event].items[index].endDeci =
          static_cast<int16_t>((event * 280 + index * 23 + 100) % 3000);
      maximum.journal[event].items[index].durationSec =
          static_cast<uint16_t>(50 + event * 30 + index);
      maximum.journal[event].items[index].fanMinDeci =
          static_cast<uint8_t>((event + index) % 40);
      maximum.journal[event].items[index].fanMaxDeci =
          static_cast<uint8_t>(60 + (event + index) % 41);
      maximum.journal[event].items[index].heatMinDeci =
          static_cast<uint8_t>((event * 2 + index) % 30);
      maximum.journal[event].items[index].heatMaxDeci =
          static_cast<uint8_t>(70 + (event + index) % 31);
    }
  }
  require(sr800::logcodec::encodePlanProvenance(
              maximum, encoded, sizeof(encoded)) == 0,
          "worst-case plan churn is rejected rather than exceeding 1024 bytes");
}

// --- what a real roast actually costs ------------------------------------

// A 25-minute roast at 1 Hz: charge from 25 C, an S-shaped rise to 210 C with
// +/-0.3 C of measurement noise, then the cooling tail. Fan and heat move the
// way a journey moves them - a handful of level changes, not per-sample churn.
//
// The recording ends with the PASSIVE DECAY TAIL, which is a real part of every
// stored roast: the fan stops, the log keeps sampling for kLogIdleFinalizeMs
// (3 minutes), and what it captures is ~30 s of heat-soak rebound - stored
// element and wall heat pushing the probe back up with no airflow to carry it
// away - followed by the clean sub-degree-per-second decay the loss and tau fit
// is regressed from. It is modelled here because the README's capacity number
// is a promise about real recordings, and this is what one contains.
std::vector<RawSample> syntheticRoast() {
  std::vector<RawSample> samples;
  const int roastSeconds = 25 * 60;
  const int coolSeconds = 4 * 60;
  const int decaySeconds = 3 * 60;  // kLogIdleFinalizeMs
  const int tailSeconds = coolSeconds + decaySeconds;
  uint32_t noise = 0x1234567u;
  double coldJunction = 22.0;
  double decayFrom = 0.0;
  for (int second = 0; second < roastSeconds + tailSeconds; ++second) {
    noise = noise * 1103515245u + 12345u;
    const double jitter =
        (static_cast<double>((noise >> 16) & 0x7FFFu) / 32767.0 - 0.5) * 0.6;

    double beanC;
    if (second < roastSeconds) {
      const double progress = static_cast<double>(second) / roastSeconds;
      // Charge dip, then a decelerating rise - the shape of a real bean curve.
      beanC = 25.0 + 185.0 * (1.0 - std::exp(-2.6 * progress)) /
                         (1.0 - std::exp(-2.6));
      beanC -= 6.0 * std::exp(-progress * 40.0);
    } else if (second < roastSeconds + coolSeconds) {
      const double cooling = static_cast<double>(second - roastSeconds);
      beanC = 22.0 + 188.0 * std::exp(-cooling / 150.0);
      decayFrom = beanC;
    } else {
      // Fan off. First the heat-soak rebound: stored element and wall heat
      // with nowhere to go pushes the probe up ~4 C over ~30 s. Then the clean
      // passive decay, ~0.1 C/s falling, which is what the fit reads.
      const double idle = static_cast<double>(second - roastSeconds -
                                              coolSeconds);
      const double rebound = 4.0 * (1.0 - std::exp(-idle / 12.0)) *
                             std::exp(-idle / 55.0);
      beanC = 22.0 + (decayFrom - 22.0) * std::exp(-idle / 900.0) + rebound;
    }
    // The board warms up inside the roaster over the run.
    coldJunction = 22.0 + 14.0 * (1.0 - std::exp(-static_cast<double>(second) /
                                                 900.0));

    double fanLevel;
    double heatLevel;
    if (second < roastSeconds) {
      const int zone = second / 300;  // five-minute zones
      fanLevel = 4.0 + 0.5 * zone;
      heatLevel = 9.0 - 0.7 * zone;
      // The PI trims heat within a zone; it moves in 0.1 steps and not often.
      heatLevel += 0.1 * static_cast<double>((second / 20) % 5);
    } else if (second < roastSeconds + coolSeconds) {
      fanLevel = 9.0;
      heatLevel = 0.0;
    } else {
      // Everything off. Both level channels are a zero delta for the whole
      // decay tail - one byte each, which is what makes a longer tail cheap
      // and a shorter one worth having anyway.
      fanLevel = 0.0;
      heatLevel = 0.0;
    }

    RawSample raw = {};
    raw.tMs = static_cast<uint32_t>(second) * 1000u;
    raw.thermocoupleCenti =
        static_cast<int16_t>(std::lround((beanC + jitter) * 100.0));
    raw.coldJunctionCenti =
        static_cast<int16_t>(std::lround(coldJunction * 100.0));
    raw.fanMilli = static_cast<uint16_t>(std::lround(fanLevel * 1000.0));
    raw.heatMilli = static_cast<uint16_t>(std::lround(heatLevel * 1000.0));
    samples.push_back(raw);
  }
  return samples;
}

void testCompressionRatio() {
  const std::vector<RawSample> samples = syntheticRoast();
  const std::vector<uint8_t> payload = encodeAll(samples);
  const double bytesPerSample =
      static_cast<double>(payload.size()) / samples.size();

  // The recording must survive its own compression, on real-shaped data.
  std::vector<Sample> decoded;
  require(decodeAllDribbled(payload, samples.size(), decoded),
          "the synthetic roast decodes completely");
  bool exact = decoded.size() == samples.size();
  for (size_t index = 0; index < decoded.size() && index < samples.size();
       ++index) {
    if (!sameSample(decoded[index], sr800::logcodec::quantize(samples[index]))) {
      exact = false;
    }
  }
  require(exact, "every sample of the synthetic roast round-trips exactly");

  constexpr uint32_t kHeaderBytes = 220;      // archive header version 4
  constexpr uint32_t kVolumeBytes = 917504u;  // 896 KB, 0xE0000
  // Two different ceilings, and the README quotes both because they answer
  // different questions. Recordings alone may grow until only the archive's
  // 96 KB reserve is left. But a library whose roasts still get NAMED is also
  // writing run documents, and those stop at the document floor - the reserve
  // plus a whole worst-case recording (sr800_volume_budget.h). The second
  // number is the one a user actually meets.
  constexpr uint32_t kArchiveOnlyBytes = kVolumeBytes - 98304u;
  constexpr uint32_t kWithDocumentsBytes = kVolumeBytes - 219548u;
  // Current rich mock fixture average; protocol cap is not a capacity estimate.
  constexpr uint32_t kRunDocumentBytes = 5063u;
  const double storedBytes =
      static_cast<double>(payload.size() + kHeaderBytes);
  const double rawBytes =
      static_cast<double>(samples.size() * 12 + 92);
  std::printf(
      "  synthetic roast: %zu samples (%d min), %zu payload bytes, "
      "%.3f bytes/sample\n",
      samples.size(), static_cast<int>(samples.size() / 60), payload.size(),
      bytesPerSample);
  std::printf("  stored %.0f B vs %.0f B raw (%.2fx)\n", storedBytes, rawBytes,
              rawBytes / storedBytes);
  std::printf(
      "  capacity: %.1f recordings alone (%u KB), %.1f with a %u B run "
      "document each (%u KB)\n",
      kArchiveOnlyBytes / storedBytes, kArchiveOnlyBytes / 1024u,
      kWithDocumentsBytes / (storedBytes + kRunDocumentBytes),
      kRunDocumentBytes, kWithDocumentsBytes / 1024u);

  require(bytesPerSample <= 6.0,
          "a realistic roast stores at six bytes per sample or better");
  // The steady state is five bytes; the slack here is the roast's real events -
  // zone changes, the cooling transition, the odd large step. Tightening this
  // is what would catch a predictor regression that the 6-byte bar, written for
  // the first-order time channel, would sail through.
  //
  // The bar was 5.2 when temperatures were whole degrees, and it is 5.2 still.
  // That is a measured result of the deci-degree encoding and it deserves to
  // be stated rather than assumed: a temperature token is one varint byte for
  // any step below 6.3 C/s, so ten times finer readings cost nothing at all.
  // If tenths had actually cost bytes, this line is where it would show.
  require(bytesPerSample <= 5.2,
          "deci-degrees hold the stream at the same five bytes whole degrees "
          "did");
}

}  // namespace

int main() {
  testQuantization();
  testRoundTrip();
  testFrameLayout();
  testDecayTailResolution();
  testCrcDetectsCorruption();
  testTruncationRefused();
  testRawSampleLayout();
  testRestoreValidation();
  testStreamingRestoreValidation();
  testPlanProvenanceCodec();
  testCompressionRatio();

  if (failures == 0) {
    std::cout << "log codec: all checks passed\n";
    return 0;
  }
  std::cerr << "log codec: " << failures << " check(s) failed\n";
  return 1;
}
