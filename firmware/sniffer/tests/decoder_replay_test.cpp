#include <stdint.h>

#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include "../sr800_sniffer/sr800_display_decoder.h"

namespace {

struct Event {
  uint32_t atUs;
  uint8_t inputA;
  uint8_t inputB;
  uint8_t effective;
  uint8_t clear;
};

struct Expectation {
  const char* file;
  sr800::DisplayMode mode;
  sr800::EditSelection edit;
  int fan;
  int power;
  int timerTenths;
  int coolingValue;
};

uint8_t parseHexByte(const std::string& value) {
  return static_cast<uint8_t>(std::stoul(value, nullptr, 16));
}

std::vector<Event> readCapture(const std::string& path) {
  std::ifstream input(path);
  if (!input) {
    throw std::runtime_error("Cannot open " + path);
  }

  std::vector<Event> events;
  std::string line;
  std::getline(input, line);
  while (std::getline(input, line)) {
    std::stringstream row(line);
    std::vector<std::string> fields;
    std::string field;
    while (std::getline(row, field, ',')) fields.push_back(field);
    if (fields.size() != 7) continue;

    Event event{};
    event.atUs = static_cast<uint32_t>(std::stoul(fields[1]));
    event.inputA = parseHexByte(fields[3]);
    event.inputB = parseHexByte(fields[4]);
    event.effective = parseHexByte(fields[5]);
    event.clear = static_cast<uint8_t>(std::stoul(fields[6]));
    events.push_back(event);
  }
  return events;
}

bool checkValue(const char* label, int actual, int expected) {
  if (expected == -999 || actual == expected) return true;
  std::cerr << "  " << label << ": expected " << expected << ", got "
            << actual << '\n';
  return false;
}

bool replay(const std::string& captureRoot, const Expectation& expected) {
  const std::string path = captureRoot + "/" + expected.file;
  const std::vector<Event> events = readCapture(path);
  sr800::DisplayDecoder decoder;
  for (const Event& event : events) {
    decoder.ingest(event.atUs, event.inputA, event.inputB, event.effective,
                   event.clear);
  }
  if (!events.empty()) decoder.tick(events.back().atUs);
  const sr800::DecoderSnapshot state = decoder.snapshot();

  bool passed = true;
  if (state.mode != expected.mode) {
    std::cerr << "  mode: expected " << sr800::displayModeName(expected.mode)
              << ", got " << sr800::displayModeName(state.mode) << '\n';
    passed = false;
  }
  if (state.editSelection != expected.edit) {
    std::cerr << "  edit: expected "
              << sr800::editSelectionName(expected.edit) << ", got "
              << sr800::editSelectionName(state.editSelection) << '\n';
    passed = false;
  }
  passed &= checkValue("fan", state.fan, expected.fan);
  passed &= checkValue("power", state.power, expected.power);
  passed &= checkValue("timer_tenths", state.timerTenths,
                       expected.timerTenths);
  passed &= checkValue("cooling_value", state.coolingValue,
                       expected.coolingValue);

  if (!state.fresh || state.validFrames < 3) {
    std::cerr << "  decoder did not produce a fresh consensus frame\n";
    passed = false;
  }

  std::cout << (passed ? "PASS " : "FAIL ") << expected.file << " mode="
            << sr800::displayModeName(state.mode) << " edit="
            << sr800::editSelectionName(state.editSelection) << " fan="
            << static_cast<int>(state.fan) << " power="
            << static_cast<int>(state.power) << " timer_tenths="
            << state.timerTenths << " cooling="
            << static_cast<int>(state.coolingValue) << " confidence="
            << static_cast<int>(state.frameConfidencePct) << "%\n";
  return passed;
}

bool checkStaleFallback(const std::string& captureRoot) {
  const std::vector<Event> events =
      readCapture(captureRoot + "/sr800-capture-11C.3-cooling.csv");
  sr800::DisplayDecoder decoder;
  for (const Event& event : events) {
    decoder.ingest(event.atUs, event.inputA, event.inputB, event.effective,
                   event.clear);
  }
  decoder.tick(events.back().atUs + sr800::DisplayDecoder::kStaleAfterUs + 1);
  const sr800::DecoderSnapshot state = decoder.snapshot();
  const bool passed = !state.fresh &&
                      state.mode == sr800::DisplayMode::UNKNOWN &&
                      state.editSelection == sr800::EditSelection::NONE;
  std::cout << (passed ? "PASS " : "FAIL ")
            << "stale input falls back to UNKNOWN\n";
  return passed;
}

bool checkDisagreementRejection(const std::string& captureRoot) {
  std::vector<Event> events =
      readCapture(captureRoot + "/sr800-capture-11C.3-cooling.csv");
  sr800::DisplayDecoder decoder;
  for (Event& event : events) {
    event.inputB ^= 0x01;
    decoder.ingest(event.atUs, event.inputA, event.inputB, event.effective,
                   event.clear);
  }
  decoder.tick(events.back().atUs);
  const sr800::DecoderSnapshot state = decoder.snapshot();
  const bool passed = state.mode == sr800::DisplayMode::UNKNOWN &&
                      state.acceptedSamples == 0 &&
                      state.rejectedDisagreements == events.size();
  std::cout << (passed ? "PASS " : "FAIL ")
            << "A/B disagreements cannot produce a decoded mode\n";
  return passed;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc != 2) {
    std::cerr << "Usage: decoder_replay_test <capture-directory>\n";
    return 2;
  }

  const Expectation expectations[] = {
      {"sr800-capture-four-dash-baseline.csv",
       sr800::DisplayMode::STANDBY, sr800::EditSelection::NONE, -1, -1, -1,
       -1},
      {"sr800-capture-post-cooling-dashes.csv",
       sr800::DisplayMode::STANDBY, sr800::EditSelection::NONE, -1, -1, -1,
       -1},
      {"sr800-capture-993.0.csv", sr800::DisplayMode::UNKNOWN,
       sr800::EditSelection::NONE, 9, 9, 30, -1},
      {"sr800-capture-fan-blink.csv", sr800::DisplayMode::UNKNOWN,
       sr800::EditSelection::FAN, 9, 9, 30, -1},
      {"sr800-capture-fan8-blinking.csv", sr800::DisplayMode::UNKNOWN,
       sr800::EditSelection::FAN, 8, 9, 30, -1},
      {"sr800-capture-power9-blink.csv", sr800::DisplayMode::UNKNOWN,
       sr800::EditSelection::POWER, 8, 9, 30, -1},
      {"sr800-capture-timer3.0-blink.csv", sr800::DisplayMode::UNKNOWN,
       sr800::EditSelection::TIMER, 8, 9, 30, -1},
      {"sr800-capture-112.9-blinking-timer.csv",
       sr800::DisplayMode::UNKNOWN, sr800::EditSelection::TIMER, 1, 1, 29,
       -1},
      {"sr800-capture-1-1-0.4-running.csv", sr800::DisplayMode::HEATING,
       sr800::EditSelection::NONE, 1, 1, -999, -1},
      {"sr800-capture-11C.3-cooling.csv", sr800::DisplayMode::COOLING,
       sr800::EditSelection::NONE, 1, 1, -1, 3},
  };

  bool passed = true;
  for (const Expectation& expectation : expectations) {
    passed &= replay(argv[1], expectation);
  }
  passed &= checkStaleFallback(argv[1]);
  passed &= checkDisagreementRejection(argv[1]);
  return passed ? 0 : 1;
}
