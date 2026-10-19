#pragma once

#include <stddef.h>
#include <stdint.h>
#include <string.h>

namespace sr800 {

enum class DisplayMode : uint8_t {
  UNKNOWN,
  STANDBY,
  HEATING,
  COOLING,
};

enum class EditSelection : uint8_t {
  NONE,
  FAN,
  POWER,
  TIMER,
  UNKNOWN,
};

inline const char* displayModeName(DisplayMode mode) {
  switch (mode) {
    case DisplayMode::STANDBY: return "STANDBY";
    case DisplayMode::HEATING: return "HEATING";
    case DisplayMode::COOLING: return "COOLING";
    default: return "UNKNOWN";
  }
}

inline const char* editSelectionName(EditSelection selection) {
  switch (selection) {
    case EditSelection::NONE: return "NONE";
    case EditSelection::FAN: return "FAN";
    case EditSelection::POWER: return "POWER";
    case EditSelection::TIMER: return "TIMER";
    default: return "UNKNOWN";
  }
}

inline int8_t decodeDigit(uint8_t value) {
  switch (static_cast<uint8_t>(value | 0x80)) {
    case 0xC0: return 0;
    case 0xF9: return 1;
    case 0xA4: return 2;
    case 0xB0: return 3;
    case 0x99: return 4;
    case 0x92: return 5;
    case 0x82: return 6;
    case 0xF8: return 7;
    case 0x80: return 8;
    case 0x90: return 9;
    default: return -1;
  }
}

inline bool isCoolingGlyph(uint8_t value) {
  return static_cast<uint8_t>(value | 0x80) == 0xC6;
}

struct DecoderSnapshot {
  DisplayMode mode;
  EditSelection editSelection;
  bool fresh;
  bool phaseLocked;
  uint8_t phaseOffset;
  uint8_t visibleValidMask;
  uint8_t visible[4];
  uint8_t effectiveValidMask;
  uint8_t effective[4];
  uint8_t frameConfidencePct;
  uint8_t modeConfidencePct;
  int8_t fan;
  int8_t power;
  int16_t timerTenths;
  int8_t coolingValue;
  uint32_t lastFrameUs;
  uint32_t inputSamples;
  uint32_t acceptedSamples;
  uint32_t rejectedDisagreements;
  uint32_t rejectedClearLow;
  uint32_t timingResets;
  uint32_t voteWindows;
  uint32_t validFrames;
};

class DisplayDecoder {
 public:
  static constexpr uint32_t kNominalSlotUs = 2016;
  static constexpr uint32_t kVoteWindowUs = 120000;
  static constexpr uint32_t kStaleAfterUs = 750000;

  DisplayDecoder() {
    reset();
  }

  void reset() {
    memset(votes_, 0, sizeof(votes_));
    memset(voteTotals_, 0, sizeof(voteTotals_));
    memset(visible_, 0xFF, sizeof(visible_));
    memset(effective_, 0xFF, sizeof(effective_));
    fanBlink_.reset();
    powerBlink_.reset();
    timerBlink_.reset();
    dpHeartbeat_.reset();
    mode_ = DisplayMode::UNKNOWN;
    editSelection_ = EditSelection::NONE;
    fresh_ = false;
    phaseLocked_ = false;
    phaseOffset_ = 0;
    challengedOffset_ = 0;
    challengeCount_ = 0;
    visibleValidMask_ = 0;
    effectiveValidMask_ = 0;
    frameConfidencePct_ = 0;
    modeConfidencePct_ = 0;
    fan_ = -1;
    power_ = -1;
    timerTenths_ = -1;
    coolingValue_ = -1;
    relativePhase_ = 0;
    haveTiming_ = false;
    windowStarted_ = false;
    windowStartUs_ = 0;
    lastEventUs_ = 0;
    lastFrameUs_ = 0;
    modeCandidate_ = DisplayMode::UNKNOWN;
    modeCandidateCount_ = 0;
    dpBase_ = 0xFF;
    inputSamples_ = 0;
    acceptedSamples_ = 0;
    rejectedDisagreements_ = 0;
    rejectedClearLow_ = 0;
    timingResets_ = 0;
    voteWindows_ = 0;
    validFrames_ = 0;
  }

  void ingest(uint32_t atUs, uint8_t inputA, uint8_t inputB,
              uint8_t effective, uint8_t clearLevel) {
    ++inputSamples_;

    if (!haveTiming_) {
      relativePhase_ = 0;
      haveTiming_ = true;
      lastEventUs_ = atUs;
      beginWindow(atUs);
    } else {
      const uint32_t deltaUs = atUs - lastEventUs_;
      lastEventUs_ = atUs;
      uint32_t steps = (deltaUs + kNominalSlotUs / 2) / kNominalSlotUs;
      if (steps == 0) steps = 1;
      const uint32_t expectedUs = steps * kNominalSlotUs;
      const uint32_t residualUs =
          deltaUs > expectedUs ? deltaUs - expectedUs : expectedUs - deltaUs;

      if (steps > 64 || residualUs > 800) {
        ++timingResets_;
        relativePhase_ = 0;
        phaseLocked_ = false;
        challengeCount_ = 0;
        clearVotes();
        beginWindow(atUs);
      } else {
        relativePhase_ =
            static_cast<uint8_t>((relativePhase_ + steps) & 0x03);
      }
    }

    if (inputA != inputB) {
      ++rejectedDisagreements_;
    } else if (clearLevel == 0) {
      ++rejectedClearLow_;
    } else {
      ++acceptedSamples_;
      if (voteTotals_[relativePhase_] != UINT16_MAX) {
        ++voteTotals_[relativePhase_];
      }
      if (votes_[relativePhase_][effective] != UINT16_MAX) {
        ++votes_[relativePhase_][effective];
      }
    }

    if (windowStarted_ && atUs - windowStartUs_ >= kVoteWindowUs) {
      finishWindow(atUs);
    }
  }

  void tick(uint32_t nowUs) {
    fanBlink_.tick(nowUs);
    powerBlink_.tick(nowUs);
    timerBlink_.tick(nowUs);
    dpHeartbeat_.tick(nowUs);
    updateEditSelection();

    if (lastFrameUs_ == 0 || nowUs - lastFrameUs_ > kStaleAfterUs) {
      fresh_ = false;
      mode_ = DisplayMode::UNKNOWN;
      modeConfidencePct_ = 0;
      editSelection_ = EditSelection::NONE;
      modeCandidate_ = DisplayMode::UNKNOWN;
      modeCandidateCount_ = 0;
    }
  }

  DecoderSnapshot snapshot() const {
    DecoderSnapshot result{};
    result.mode = mode_;
    result.editSelection = editSelection_;
    result.fresh = fresh_;
    result.phaseLocked = phaseLocked_;
    result.phaseOffset = phaseOffset_;
    result.visibleValidMask = visibleValidMask_;
    memcpy(result.visible, visible_, sizeof(visible_));
    result.effectiveValidMask = effectiveValidMask_;
    memcpy(result.effective, effective_, sizeof(effective_));
    result.frameConfidencePct = frameConfidencePct_;
    result.modeConfidencePct = modeConfidencePct_;
    result.fan = fan_;
    result.power = power_;
    result.timerTenths = timerTenths_;
    result.coolingValue = coolingValue_;
    result.lastFrameUs = lastFrameUs_;
    result.inputSamples = inputSamples_;
    result.acceptedSamples = acceptedSamples_;
    result.rejectedDisagreements = rejectedDisagreements_;
    result.rejectedClearLow = rejectedClearLow_;
    result.timingResets = timingResets_;
    result.voteWindows = voteWindows_;
    result.validFrames = validFrames_;
    return result;
  }

 private:
  struct ToggleTracker {
    int8_t stableState;
    int8_t pendingState;
    uint8_t pendingCount;
    uint8_t goodIntervals;
    bool seenLow;
    bool seenHigh;
    bool active;
    uint32_t lastTransitionUs;

    void reset() {
      stableState = -1;
      pendingState = -1;
      pendingCount = 0;
      goodIntervals = 0;
      seenLow = false;
      seenHigh = false;
      active = false;
      lastTransitionUs = 0;
    }

    void observe(int8_t state, uint32_t nowUs) {
      if (state < 0) return;

      if (pendingState != state) {
        pendingState = state;
        pendingCount = 1;
        return;
      }
      if (pendingCount < 2) {
        ++pendingCount;
      }
      if (pendingCount < 2 || stableState == state) return;

      if (stableState < 0) {
        stableState = state;
        seenLow = state == 0;
        seenHigh = state == 1;
        lastTransitionUs = nowUs;
        return;
      }

      const uint32_t intervalUs = nowUs - lastTransitionUs;
      stableState = state;
      lastTransitionUs = nowUs;
      seenLow = seenLow || state == 0;
      seenHigh = seenHigh || state == 1;

      if (intervalUs >= 250000 && intervalUs <= 750000) {
        if (goodIntervals < UINT8_MAX) ++goodIntervals;
      } else {
        goodIntervals = 0;
        active = false;
      }
      active = goodIntervals >= 2 && seenLow && seenHigh;
    }

    void tick(uint32_t nowUs) {
      if (lastTransitionUs != 0 && nowUs - lastTransitionUs > 850000) {
        active = false;
        goodIntervals = 0;
      }
    }
  };

  static bool isDash(uint8_t value) {
    return value == 0xBF;
  }

  static bool isBlank(uint8_t value) {
    return value == 0xFF;
  }

  static bool isTimerWhole(uint8_t value) {
    return decodeDigit(value) >= 0 || isCoolingGlyph(value);
  }

  static int scoreOffset(const uint8_t relative[4], uint8_t validMask,
                         uint8_t offset) {
    int score = 0;
    for (uint8_t rel = 0; rel < 4; ++rel) {
      if ((validMask & (1U << rel)) == 0) continue;
      const uint8_t physical = static_cast<uint8_t>((rel + offset) & 0x03);
      const uint8_t value = relative[rel];

      if (isBlank(value)) continue;
      if (isDash(value)) {
        score -= 2;
        continue;
      }
      if (isCoolingGlyph(value)) {
        score += physical == 2 ? 24 : -28;
        continue;
      }

      const int8_t digit = decodeDigit(value);
      if (digit < 0) {
        score -= 12;
        continue;
      }

      if (physical < 2) {
        score += digit == 0 ? -8 : 3;
      } else {
        score += 3;
      }

      const bool decimalPointOn = (value & 0x80) == 0;
      if (decimalPointOn) {
        score += physical == 2 ? 14 : -18;
      }
    }
    return score;
  }

  void beginWindow(uint32_t atUs) {
    windowStartUs_ = atUs;
    windowStarted_ = true;
  }

  void clearVotes() {
    memset(votes_, 0, sizeof(votes_));
    memset(voteTotals_, 0, sizeof(voteTotals_));
  }

  void finishWindow(uint32_t atUs) {
    ++voteWindows_;
    uint8_t relative[4] = {0xFF, 0xFF, 0xFF, 0xFF};
    uint8_t confidence[4] = {0, 0, 0, 0};
    uint8_t validMask = 0;

    for (uint8_t phase = 0; phase < 4; ++phase) {
      uint16_t bestCount = 0;
      uint8_t bestValue = 0xFF;
      for (uint16_t value = 0; value <= UINT8_MAX; ++value) {
        const uint16_t count = votes_[phase][value];
        if (count > bestCount) {
          bestCount = count;
          bestValue = static_cast<uint8_t>(value);
        }
      }

      const uint16_t total = voteTotals_[phase];
      if (total >= 6) {
        const uint8_t pct =
            static_cast<uint8_t>((static_cast<uint32_t>(bestCount) * 100) /
                                 total);
        if (pct >= 68) {
          relative[phase] = bestValue;
          confidence[phase] = pct;
          validMask |= static_cast<uint8_t>(1U << phase);
        }
      }
    }

    clearVotes();
    beginWindow(atUs);

    const bool allRelativeDashes =
        validMask == 0x0F && isDash(relative[0]) && isDash(relative[1]) &&
        isDash(relative[2]) && isDash(relative[3]);

    if (!allRelativeDashes) {
      updatePhaseLock(relative, validMask);
    }

    visibleValidMask_ = 0;
    memset(visible_, 0xFF, sizeof(visible_));
    frameConfidencePct_ = 0;

    if (allRelativeDashes) {
      memset(visible_, 0xBF, sizeof(visible_));
      visibleValidMask_ = 0x0F;
      frameConfidencePct_ = minimumConfidence(confidence, validMask);
    } else if (phaseLocked_) {
      uint8_t minimum = 100;
      for (uint8_t rel = 0; rel < 4; ++rel) {
        if ((validMask & (1U << rel)) == 0) continue;
        const uint8_t physical =
            static_cast<uint8_t>((rel + phaseOffset_) & 0x03);
        visible_[physical] = relative[rel];
        visibleValidMask_ |= static_cast<uint8_t>(1U << physical);
        if (confidence[rel] < minimum) minimum = confidence[rel];
      }
      frameConfidencePct_ = visibleValidMask_ == 0 ? 0 : minimum;
    }

    if (visibleValidMask_ != 0x0F) return;

    ++validFrames_;
    fresh_ = true;
    lastFrameUs_ = atUs;
    updateEffectiveValues();
    updateTrackers(atUs);
    updateEditSelection();
    updateMode(atUs);
  }

  static uint8_t minimumConfidence(const uint8_t confidence[4],
                                   uint8_t validMask) {
    uint8_t minimum = 100;
    for (uint8_t phase = 0; phase < 4; ++phase) {
      if ((validMask & (1U << phase)) != 0 && confidence[phase] < minimum) {
        minimum = confidence[phase];
      }
    }
    return validMask == 0 ? 0 : minimum;
  }

  void updatePhaseLock(const uint8_t relative[4], uint8_t validMask) {
    int scores[4];
    uint8_t bestOffset = 0;
    int bestScore = -1000;
    int secondScore = -1000;
    for (uint8_t offset = 0; offset < 4; ++offset) {
      scores[offset] = scoreOffset(relative, validMask, offset);
      if (scores[offset] > bestScore) {
        secondScore = bestScore;
        bestScore = scores[offset];
        bestOffset = offset;
      } else if (scores[offset] > secondScore) {
        secondScore = scores[offset];
      }
    }

    if (!phaseLocked_) {
      if (bestScore >= 8 && bestScore - secondScore >= 8) {
        phaseOffset_ = bestOffset;
        phaseLocked_ = true;
        challengeCount_ = 0;
      }
      return;
    }

    const int lockedScore = scores[phaseOffset_];
    if (bestOffset == phaseOffset_ || bestScore - lockedScore < 12) {
      challengeCount_ = 0;
      return;
    }

    if (challengedOffset_ != bestOffset) {
      challengedOffset_ = bestOffset;
      challengeCount_ = 1;
    } else if (challengeCount_ < UINT8_MAX) {
      ++challengeCount_;
    }

    if (challengeCount_ >= 2) {
      phaseOffset_ = bestOffset;
      challengeCount_ = 0;
      fanBlink_.reset();
      powerBlink_.reset();
      timerBlink_.reset();
      dpHeartbeat_.reset();
    }
  }

  void updateEffectiveValues() {
    for (uint8_t phase = 0; phase < 4; ++phase) {
      const uint8_t value = visible_[phase];
      bool acceptable = false;
      if (phase < 2) {
        acceptable = decodeDigit(value) >= 0;
      } else if (phase == 2) {
        acceptable = isTimerWhole(value);
      } else {
        acceptable = decodeDigit(value) >= 0;
      }
      if (acceptable) {
        effective_[phase] = value;
        effectiveValidMask_ |= static_cast<uint8_t>(1U << phase);
      }
    }

    if (allDashes()) {
      effectiveValidMask_ = 0;
      memset(effective_, 0xFF, sizeof(effective_));
      fan_ = -1;
      power_ = -1;
      timerTenths_ = -1;
      coolingValue_ = -1;
      return;
    }

    fan_ = (effectiveValidMask_ & 0x01) ? decodeDigit(effective_[0]) : -1;
    power_ = (effectiveValidMask_ & 0x02) ? decodeDigit(effective_[1]) : -1;

    if ((effectiveValidMask_ & 0x0C) == 0x0C) {
      const int8_t trailing = decodeDigit(effective_[3]);
      if (isCoolingGlyph(effective_[2])) {
        coolingValue_ = trailing;
        timerTenths_ = -1;
      } else {
        const int8_t whole = decodeDigit(effective_[2]);
        timerTenths_ =
            whole >= 0 && trailing >= 0 ? whole * 10 + trailing : -1;
        coolingValue_ = -1;
      }
    }
  }

  void updateTrackers(uint32_t atUs) {
    fanBlink_.observe(fieldState(0x01), atUs);
    powerBlink_.observe(fieldState(0x02), atUs);
    timerBlink_.observe(fieldState(0x0C), atUs);

    const uint8_t timerWhole = visible_[2];
    if (!isBlank(timerWhole) && isTimerWhole(timerWhole)) {
      const uint8_t base = static_cast<uint8_t>(timerWhole | 0x80);
      if (dpBase_ != base) {
        dpBase_ = base;
        dpHeartbeat_.reset();
      }
      dpHeartbeat_.observe((timerWhole & 0x80) == 0 ? 1 : 0, atUs);
    }
  }

  int8_t fieldState(uint8_t mask) const {
    bool allBlank = true;
    bool allNonblank = true;
    for (uint8_t phase = 0; phase < 4; ++phase) {
      if ((mask & (1U << phase)) == 0) continue;
      allBlank = allBlank && isBlank(visible_[phase]);
      allNonblank = allNonblank && !isBlank(visible_[phase]) &&
                    !isDash(visible_[phase]);
    }
    if (allBlank) return 1;
    if (allNonblank) return 0;
    return -1;
  }

  void updateEditSelection() {
    const uint8_t activeMask =
        (fanBlink_.active ? 0x01 : 0) |
        (powerBlink_.active ? 0x02 : 0) |
        (timerBlink_.active ? 0x04 : 0);
    switch (activeMask) {
      case 0x00: editSelection_ = EditSelection::NONE; break;
      case 0x01: editSelection_ = EditSelection::FAN; break;
      case 0x02: editSelection_ = EditSelection::POWER; break;
      case 0x04: editSelection_ = EditSelection::TIMER; break;
      default: editSelection_ = EditSelection::UNKNOWN; break;
    }
  }

  bool allDashes() const {
    return visibleValidMask_ == 0x0F && isDash(visible_[0]) &&
           isDash(visible_[1]) && isDash(visible_[2]) &&
           isDash(visible_[3]);
  }

  void updateMode(uint32_t) {
    DisplayMode evidence = DisplayMode::UNKNOWN;
    if (allDashes()) {
      evidence = DisplayMode::STANDBY;
    } else if (isCoolingGlyph(visible_[2]) &&
               decodeDigit(visible_[3]) >= 0) {
      evidence = DisplayMode::COOLING;
    } else if (decodeDigit(visible_[2]) >= 0 &&
               decodeDigit(visible_[3]) >= 0 && dpHeartbeat_.active) {
      evidence = DisplayMode::HEATING;
    }

    if (evidence == DisplayMode::UNKNOWN) {
      modeCandidate_ = DisplayMode::UNKNOWN;
      modeCandidateCount_ = 0;
      return;
    }

    if (modeCandidate_ == evidence) {
      if (modeCandidateCount_ < UINT8_MAX) ++modeCandidateCount_;
    } else {
      modeCandidate_ = evidence;
      modeCandidateCount_ = 1;
    }

    if (modeCandidateCount_ >= 3) {
      mode_ = evidence;
      modeConfidencePct_ = frameConfidencePct_;
    }
  }

  uint16_t votes_[4][256];
  uint16_t voteTotals_[4];
  ToggleTracker fanBlink_;
  ToggleTracker powerBlink_;
  ToggleTracker timerBlink_;
  ToggleTracker dpHeartbeat_;
  DisplayMode mode_;
  EditSelection editSelection_;
  bool fresh_;
  bool phaseLocked_;
  bool haveTiming_;
  bool windowStarted_;
  uint8_t phaseOffset_;
  uint8_t challengedOffset_;
  uint8_t challengeCount_;
  uint8_t relativePhase_;
  uint8_t visibleValidMask_;
  uint8_t visible_[4];
  uint8_t effectiveValidMask_;
  uint8_t effective_[4];
  uint8_t frameConfidencePct_;
  uint8_t modeConfidencePct_;
  uint8_t modeCandidateCount_;
  uint8_t dpBase_;
  int8_t fan_;
  int8_t power_;
  int16_t timerTenths_;
  int8_t coolingValue_;
  uint32_t windowStartUs_;
  uint32_t lastEventUs_;
  uint32_t lastFrameUs_;
  DisplayMode modeCandidate_;
  uint32_t inputSamples_;
  uint32_t acceptedSamples_;
  uint32_t rejectedDisagreements_;
  uint32_t rejectedClearLow_;
  uint32_t timingResets_;
  uint32_t voteWindows_;
  uint32_t validFrames_;
};

}  // namespace sr800
