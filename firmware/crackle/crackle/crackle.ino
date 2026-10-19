#include <Arduino.h>
#include <ESPmDNS.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <SPI.h>
#include <WiFi.h>
#include <time.h>
#include <algorithm>
#include <type_traits>
#include "driver/gpio.h"
#include "driver/temperature_sensor.h"
#include "esp_ota_ops.h"
#include "esp_app_format.h"
#include "esp_partition.h"
#include "esp_http_server.h"
#include "esp_heap_caps.h"
#include "esp_littlefs.h"
#include "esp_cpu.h"
#include "esp_rom_sys.h"
#include "mbedtls/sha256.h"
#include "sr800_actuator.h"
#include "sr800_calibration_settle.h"
#include "sr800_calibration_readiness.h"
#include "sr800_sensor_fault_qualifier.h"
#include "sr800_phase_scheduler.h"
#include "sr800_mcpwm_phase_scheduler.h"
#include "sr800_journey_control.h"
#include "sr800_doc_store.h"
#include "sr800_log_codec.h"
#include "sr800_log_retention.h"
#include "sr800_network_mailbox.h"
#include "sr800_query_args.h"
#include "sr800_network_policy.h"
#include "sr800_network_server.h"
#include "sr800_runtime_contract.h"
#include "sr800_recording_handoff.h"
#include "sr800_storage_health.h"
#include "sr800_volume_budget.h"
#include "crackle_bundle.h"
#include "esp_core_dump.h"
#include "esp_app_desc.h"
#include "sr800_web_pages.h"

// Keep a newly selected OTA image pending until maybeValidateOtaImage() has
// observed real application health. Arduino's default accepts it before setup().
extern "C" bool verifyRollbackLater() {
  return true;
}

namespace {

constexpr char kApName[] = "Crackle";
constexpr char kApPassword[] = "freshroast";
constexpr char kHostName[] = "crackle";
constexpr char kFirmwareVersion[] = "2026-07-26.128";
constexpr char kRoasterModelId[] = "freshroast-sr800";
constexpr char kRoasterDisplayName[] = "FreshRoast SR800";
constexpr char kCaptureRole[] = "crackle_controller";
constexpr char kPreferencesNamespace[] = "sr800-net";
constexpr char kDiagnosticsNamespace[] = "sr800-diag";
constexpr char kRuntimeNamespace[] = "sr800-state";

constexpr gpio_num_t kPins[] = {
    GPIO_NUM_3, GPIO_NUM_4, GPIO_NUM_5, GPIO_NUM_6};
constexpr size_t kChannelCount = sizeof(kPins) / sizeof(kPins[0]);
constexpr size_t kEventCapacity = 512;
constexpr uint8_t kStopNone = 0;
constexpr uint8_t kStopEventLimit = 1;
constexpr uint8_t kStopManual = 2;
constexpr uint32_t kReconnectIntervalMs = 5000;
constexpr uint32_t kApShutdownDelayMs = 15000;
constexpr uint32_t kApRecoveryDelayMs = 15000;
constexpr uint32_t kOtaValidationUptimeMs = 120000;
constexpr gpio_num_t kFanOutputPin = GPIO_NUM_3;
constexpr gpio_num_t kHeaterOutputPin = GPIO_NUM_4;
constexpr gpio_num_t kFactoryFanMonitorPin = GPIO_NUM_5;
constexpr gpio_num_t kZeroCrossPin = GPIO_NUM_6;
constexpr gpio_num_t kMaxDrdyPin = GPIO_NUM_7;
constexpr gpio_num_t kMaxFaultPin = GPIO_NUM_8;
constexpr gpio_num_t kMaxCsPin = GPIO_NUM_9;
constexpr gpio_num_t kMaxMosiPin = GPIO_NUM_10;
constexpr gpio_num_t kMaxMisoPin = GPIO_NUM_11;
constexpr gpio_num_t kMaxSckPin = GPIO_NUM_12;
constexpr uint32_t kMaxSampleIntervalMs = 250;
constexpr uint16_t kNativeHttpPort = 80;
constexpr uint16_t kNativeHttpShadowControlPort = 32768;
constexpr uint32_t kHttpServerRetryIntervalMs = 30000;
uint32_t lastHttpServerStartAttemptMs = 0;
constexpr uint32_t kOtaReceiveNoProgressMs = 30000;
constexpr uint32_t kOtaAdmissionWaitMs = 20000;
constexpr size_t kOtaReceiveChunkBytes = 2048;
constexpr size_t kLiveStatusPayloadBytes = 3072;
// A calibration program can contain 48 steps. The compact/status progress history
// deliberately retains only the latest 12 completed transitions in a rolling window.
constexpr size_t kCalibrationCompletedEventCount = 12;
constexpr size_t kLiveStatusBaseJsonWorstCaseBytes = 1536;
constexpr size_t kLiveStatusCompletedStepWorstCaseBytes = 112;
static_assert(kLiveStatusPayloadBytes >
    kLiveStatusBaseJsonWorstCaseBytes +
        kCalibrationCompletedEventCount * kLiveStatusCompletedStepWorstCaseBytes + 2,
    "live status buffer must hold every retained calibration event");
// Persisted field correction. It applies only to the thermocouple channel;
// cold-junction temperature remains the ambient measurement.
constexpr float kThermocoupleOffsetDefaultC = -3.0f;
float thermocoupleOffsetC = kThermocoupleOffsetDefaultC;
uint64_t stateRevision = sr800::runtime::kFirstRevision;
portMUX_TYPE stateRevisionMux = portMUX_INITIALIZER_UNLOCKED;
uint32_t liveStreamSequence = 0;
uint32_t lastLoopEntryMs = 0;
uint32_t lastLoopGapMs = 0;
uint32_t maximumLoopGapMs = 0;
uint32_t lastThermalArchivePersistMs = 0;
uint32_t maximumThermalArchivePersistMs = 0;
uint32_t thermalArchivePersistCount = 0;

struct ThermalArchivePersistTimer {
  const uint32_t startedMs = millis();

  ~ThermalArchivePersistTimer() {
    const uint32_t durationMs = millis() - startedMs;
    lastThermalArchivePersistMs = durationMs;
    maximumThermalArchivePersistMs =
        std::max(maximumThermalArchivePersistMs, durationMs);
    thermalArchivePersistCount++;
  }
};
sr800::runtime::RestoreLease restoreLease;
constexpr uint32_t kFactoryFanDetectionSpanUs = 50000;
constexpr uint32_t kFactoryFanMaximumGapUs = 25000;
constexpr uint32_t kActuatorPulseWidthUs = 100;
constexpr uint32_t kFanLevelMinimumMilli = 100;
// Design rule: whenever Heat is on, Fan must be 1.0 or higher — on every
// command path, always — so the element is never heating still air. Enforced
// at this command layer (parsers and request sites); the audited actuator core
// keeps its own deeper 0.1-with-heat qualification as the backstop.
constexpr uint32_t kHeatOnFanMinimumMilli = 1000;
constexpr uint32_t kFanLevelMaximumMilli = 10000;
constexpr uint32_t kFanLevelOneDelayUs = 4460;
// Acoustic calibration maps public Fan 10.0 to the old raw 8.9 point.
constexpr uint32_t kFanCappedMaximumDelayUs = 2110;
constexpr uint32_t kFanLevelOneSoftStartUs = 175;
constexpr uint32_t kFanCappedMaximumSoftStartUs = 606;
constexpr uint32_t kHeaterFactoryLevelOneDelayUs = 2820;
constexpr uint32_t kHeaterFactoryLevelNineDelayUs = 800;
constexpr uint32_t kNominalHalfCycleUs = 8333;
constexpr uint32_t kFanRampUs = 500000;
constexpr uint32_t kFanQualificationUs = 500000;
constexpr uint32_t kZeroCrossTimeoutUs = 100000;
constexpr uint32_t kZeroCrossRecoveryGraceUs = 250000;
// Flash/NVS work performed while outputs are off can pause capture callbacks.
// Once that work is complete, allow the six-edge qualifier to catch up before
// issuing the first command instead of making Start depend on a lucky instant.
constexpr uint32_t kActuationStartTimingWaitMs = 250;
constexpr uint32_t kFanTestDefaultMs = 3000;
constexpr uint32_t kFanTestMaximumMs = 3000;
constexpr uint32_t kHeaterProofDefaultMs = 10000;
// Longest heater proof the bounded phase timing log can audit without dropping
// records (sr800_mcpwm_phase_scheduler.h kTimingLogCapacity). Distinct from
// kHeaterProofMaximumMs, which remains the ISR heat lease bound for all modes.
constexpr uint32_t kHeaterProofDiagnosticMaximumMs = 15000;
constexpr uint32_t kHeatDeadlineLoopGraceUs = 500000;
constexpr size_t kCalibrationMaxSteps = 48;
constexpr size_t kCalibrationMaxGridFans = 6;
constexpr size_t kCalibrationMaxGridHeats = 7;
constexpr uint32_t kCalibrationStepMinimumS = 15;
constexpr uint32_t kCalibrationStepMaximumS = 300;
constexpr uint32_t kCalibrationStepDefaultS = 300;
constexpr uint32_t kCalibrationRenewIntervalUs = 5000000;
constexpr uint32_t kCalibrationQualifyStallUs = 10000000;
// Measured air-map data showed chamber air rises 2-3 C/s
// mid-transient with a time constant near a minute: a short settle window
// with a wide band declares "settled" mid-rise and yields time-ordered, not
// setting-ordered, readings. The window range bound implies a slope bound of
// 2*band/window; keep the window long and the band tight.
constexpr uint8_t kCalibrationSettleSecondsDefault = 20;
constexpr uint8_t kCalibrationSettleSecondsMaximum = 30;
constexpr float kCalibrationSettleBandDefaultC = 0.2f;
// A small transition barely moves the probe at first, so the settle window
// alone can fire before the transient has begun. Settled advances are held
// until the step has dwelt at least this long; capped advances are
// unaffected.
constexpr uint32_t kCalibrationMinDwellDefaultS = 20;
constexpr uint32_t kHeaterProofMaximumMs = 30000;
constexpr uint32_t kThermalSafetyFreshnessUs = 1000000;
// The overheat limit, the one thermal safety limit. A fault-free bean-probe
// reading at or above it for the sustain window, while Heat is requested or on,
// latches an overtemperature fault: Heat off at once and locked off until power
// cycle, then a cooldown at Fan 10 that lasts until the reading has stayed below
// the limit for kOvertempCooldownMs (an operator Stop ends it sooner). Roasts end
// near 230 C, so a working probe never reaches 260 C in a normal roast.
// BUILDERS: to roast hotter, raise kOvertempDisableC here and build your own
// image; the web app reads the limit from /api/status.
constexpr float kOvertempDisableC = 260.0f;
constexpr uint32_t kOvertempSustainMs = 1000;
constexpr uint32_t kOvertempCooldownMs = 180000;
constexpr uint32_t kOvertempCooldownFanMilli = 10000;

const sr800::ActuatorConfig kActuatorConfig = {
    kFanOutputPin,
    kHeaterOutputPin,
    kActuatorPulseWidthUs,
    kFanLevelMinimumMilli,
    kFanLevelMaximumMilli,
    kFanLevelOneDelayUs,
    kFanCappedMaximumDelayUs,
    kFanLevelOneSoftStartUs,
    kFanCappedMaximumSoftStartUs,
    kHeaterFactoryLevelOneDelayUs,
    kHeaterFactoryLevelNineDelayUs,
    kFanRampUs,
    kFanQualificationUs,
    kZeroCrossTimeoutUs,
    kZeroCrossRecoveryGraceUs,
    kNominalHalfCycleUs,
    kHeaterProofMaximumMs * 1000U,
    kThermalSafetyFreshnessUs,
    kOvertempCooldownFanMilli,
    kOvertempCooldownMs * 1000U,
};

sr800::Actuator actuator(kActuatorConfig);
sr800::McpwmPhaseScheduler phaseScheduler(
    kFanOutputPin, kHeaterOutputPin, kZeroCrossPin);

struct EdgeEvent {
  uint32_t sequence;
  uint32_t atUs;
  uint32_t precedingGapUs;
  uint8_t changedMask;
  uint8_t levels;
};

DRAM_ATTR volatile EdgeEvent eventBuffer[kEventCapacity];
DRAM_ATTR volatile uint32_t eventCount = 0;
DRAM_ATTR volatile uint32_t lastEventUs = 0;
DRAM_ATTR volatile uint32_t lastEdgeUs[kChannelCount] = {};
DRAM_ATTR volatile uint32_t riseCount[kChannelCount] = {};
DRAM_ATTR volatile uint32_t fallCount[kChannelCount] = {};
DRAM_ATTR volatile uint32_t lastHighUs[kChannelCount] = {};
DRAM_ATTR volatile uint32_t minHighUs[kChannelCount] = {};
DRAM_ATTR volatile uint32_t maxHighUs[kChannelCount] = {};
DRAM_ATTR volatile uint32_t lastLowUs[kChannelCount] = {};
DRAM_ATTR volatile uint32_t minLowUs[kChannelCount] = {};
DRAM_ATTR volatile uint32_t maxLowUs[kChannelCount] = {};
DRAM_ATTR volatile uint8_t lastLevels = 0;
DRAM_ATTR volatile uint8_t seenHighMask = 0;
DRAM_ATTR volatile uint8_t seenLowMask = 0;
DRAM_ATTR volatile bool captureEnabled = false;
DRAM_ATTR volatile bool captureComplete = false;
DRAM_ATTR volatile uint8_t captureStopReason = kStopNone;

DRAM_ATTR volatile bool fanTestActive = false;
DRAM_ATTR volatile uint32_t fanTestEndUs = 0;
DRAM_ATTR volatile uint32_t fanTestLevelMilli = 0;
DRAM_ATTR volatile uint32_t fanTestStartPulseCount = 0;
DRAM_ATTR volatile bool manualConflictLatched = false;

enum class HeaterProofPhase : uint8_t {
  IDLE,
  FAN_QUALIFICATION,
  HEATING,
};

volatile HeaterProofPhase heaterProofPhase = HeaterProofPhase::IDLE;
uint32_t heaterProofDurationMs = 0;
uint32_t heaterProofFanLevelMilli = 0;
uint32_t heaterProofHeatLevelMilli = 0;
uint32_t heaterProofDeadlineUs = 0;
uint32_t heaterProofStartPulseCount = 0;
uint32_t heaterProofQualificationStartedUs = 0;
// Calibration program: one Fan level, a staircase of Heat steps each held for
// a fixed time. Heat runs under renewed 30 s leases so the zero-cross ISR
// bound stays authoritative.
bool calibrationActive = false;
bool calibrationHeatObserved = false;
uint32_t calibrationStepFanMilli[kCalibrationMaxSteps] = {};
uint32_t calibrationHeatMilli[kCalibrationMaxSteps] = {};
size_t calibrationStepCount = 0;
size_t calibrationStepIndex = 0;
// A step boundary whose request met a transient refusal (see serviceCalibrationStepRequest).
bool calibrationStepRequestPending = false;
uint32_t calibrationStepMs = 120000;
uint32_t calibrationMinDwellMs = kCalibrationMinDwellDefaultS * 1000U;
uint32_t calibrationStepEndUs = 0;
bool calibrationStepDeadlineArmed = false;
uint32_t calibrationStepStartedUs = 0;
uint32_t calibrationLastRenewUs = 0;
uint32_t calibrationRenewals = 0;
const char* calibrationEndReason = "none";
const char* calibrationLastAdvance = "none";
struct CalibrationCompletedEvent {
  uint8_t index;
  uint16_t elapsedSec;
  uint8_t fanDeci;
  uint8_t heatDeci;
  float temperatureC;
  const char* outcome;
};
CalibrationCompletedEvent calibrationCompletedEvents[kCalibrationCompletedEventCount] = {};
size_t calibrationCompletedEventUsed = 0;
uint32_t calibrationStableLogId = 0;
uint32_t calibrationStartedEpoch = 0;
uint32_t calibrationCompletedEpoch = 0;

// Manual control: apply any fan/heat under the same renewed 30 s Heat leases
// the calibration program uses, bounded by the 30-minute instruction lease
// below; every always-on protocol (thermal gating, floors, sustained
// overtemperature latch) applies unchanged.

bool manualActive = false;
uint32_t manualFanMilli = 0;
uint32_t manualHeatMilli = 0;
bool manualHeatObserved = false;
uint32_t manualSinceMs = 0;
uint32_t manualLastRenewUs = 0;
// The instruction lease. One rule covers every path that can command the
// machine: an instruction is good for at most 30 minutes, and a NEW
// instruction - the same levels repeated or different ones - resets the clock.
// Manual control is the one path where the instruction comes from a hand rather
// than from a program, so this is where the bound has to be enforced explicitly.
//
// There is deliberately no client-keepalive rule. Making heat conditional on a
// browser staying open and chattering puts the safeguard in the wrong place:
// closing the browser is not an emergency, and the device must not depend on a
// page to stay safe. A manual session survives a closed browser, a dead laptop
// and a dropped link for the full 30 minutes of its instruction, and then stops
// itself.
//
// Expiry stops the active instruction immediately; the actuator remains the
// fail-low authority even if loop service is delayed.
constexpr uint32_t kManualInstructionLeaseMs = 1800000;
uint32_t manualLastInstructionMs = 0;
const char* manualEndReason = "none";
// Adaptive settling: a step advances early once the corrected thermocouple
// first proves the new command has caused a transition, then holds within
// +/- settleBand for settleSeconds consecutive 1 Hz samples.
uint8_t calibrationSettleSeconds = kCalibrationSettleSecondsDefault;
float calibrationSettleBandC = kCalibrationSettleBandDefaultC;
sr800::CalibrationSettleDetector calibrationSettleDetector;
uint32_t calibrationSettleLastMs = 0;

// ---------------------------------------------------------------------------
// The roast executor: Crackle runs the roast, not the browser.
//
// Requirement: once started, a roast continues on the controller after the
// browser that started it closes or disconnects. So a roast is a
// DEVICE-RESIDENT program, a sibling of the calibration program above and built
// out of the same parts: it owns its own 30 s Heat leases and renews them
// itself, it ends on a fault exactly as calibration does, and its recording may
// retain a passive fan-off decay tail.
//
// The 30-minute instruction lease enforced explicitly in the manual block is
// satisfied here BY CONSTRUCTION, and no client-liveness rule of any kind may be
// copied into this path. A running program re-instructs the actuator constantly:
// JOURNEY issues a fresh request every 1 Hz control tick, TIMED issues one at
// every step boundary and renews within a step every 5 s. The longest a program
// can hold Heat without issuing a new actuator request is therefore one renewal
// interval, three orders of magnitude inside the 30-minute bound - see the audit
// note in the README. The program-level outer bound is the runtime envelope
// (2x nominal + 600 s), which is what actually ends a program that will not end
// itself.
//
// A disconnected browser is not a reason to stop; it is the entire point.
//
// Three modes share the framework:
//
//   TIMED   - explicit `F:H:seconds` steps, run on their exact durations. No
//             model, no feedback: what was asked for is what runs.
//   JOURNEY - zones with temperature endpoints, driven at 1 Hz by the ported
//             control law in `sr800_journey_control.*`. Zone advancement is
//             temperature-gated and never time-gated, exactly as the browser's
//             simulation and the cross-language vectors define it.
//   MANUAL  - an operator supplies each Fan/Heat instruction. The controller
//             owns the actuator lease, expiry, and recording exactly as it does
//             for a program; only the next requested levels come from
//             the browser. A lost browser therefore cannot defeat a safety
//             boundary, though it naturally cannot make another adjustment.
// ---------------------------------------------------------------------------
enum class RoastMode : uint8_t { NONE = 0, TIMED, JOURNEY, MANUAL };

constexpr size_t kRoastMaxSteps = 24;
constexpr size_t kActivePlanFixedMaxBytes = 512;
constexpr size_t kActivePlanTimedStepMaxBytes = 64;
constexpr size_t kActivePlanJourneyZoneMaxBytes = 128;
constexpr size_t kActivePlanInitialZoneMaxBytes = 128;
constexpr size_t kActivePlanTimedWorstCaseBytes =
    kActivePlanFixedMaxBytes + kRoastMaxSteps * kActivePlanTimedStepMaxBytes;
constexpr size_t kActivePlanJourneyWorstCaseBytes =
    kActivePlanFixedMaxBytes + sr800::kMaxJourneyZones *
        (kActivePlanJourneyZoneMaxBytes + kActivePlanInitialZoneMaxBytes);
constexpr size_t kActivePlanWorstCaseBytes =
    kActivePlanTimedWorstCaseBytes > kActivePlanJourneyWorstCaseBytes
        ? kActivePlanTimedWorstCaseBytes : kActivePlanJourneyWorstCaseBytes;
static_assert(sr800::kMaxJourneyZones <= 12,
              "Recalculate the active-plan response bound for more zones");
static_assert(kActivePlanWorstCaseBytes <
                  sr800::network::kCommandResponseBytes,
              "Active-plan response must fit the fixed command mailbox");
constexpr uint32_t kRoastStepMinimumS = 1;
constexpr uint32_t kRoastStepMaximumS = 1800;
constexpr uint32_t kRoastZoneMinimumS = 5;
constexpr uint32_t kRoastZoneMaximumS = 1800;
constexpr uint32_t kRoastMassMinimumG = 20;
constexpr uint32_t kRoastMassMaximumG = 2000;
constexpr size_t kRoastNameBytes = 32;
// The control tick. One second is the plan's own resolution, the thermal log's
// interval, and comfortably inside the 30 s Heat lease it renews.
constexpr uint32_t kRoastControlIntervalMs = 1000;
// How long a roast may run feed-forward on a missing or stale reading before the
// dropout is called what it is. The step's own holdover rule covers the gap;
// beyond this the probe is gone and the roast ends with both outputs off.
constexpr uint32_t kRoastHoldoverLimitMs = 30000;
// A thermocouple sample older than this is not a measurement any more. It sits
// deliberately BELOW the actuator's own `thermalSafetyFreshnessUs` (1 s): if the
// roast still called a sample fresh after the actuator had stopped doing so,
// every Heat request in that window would be rejected as stale telemetry and a
// perfectly recoverable poll hiccup would end the roast. Holding over first
// keeps the two gates in the right order.
constexpr uint32_t kRoastSampleFreshnessMs = 900;
constexpr uint16_t kRoastZoneNotAttained = 0xFFFF;

bool roastActive = false;
RoastMode roastMode = RoastMode::NONE;
char roastName[kRoastNameBytes + 1] = {0};
const char* roastEndReason = "none";
uint32_t roastStartedMs = 0;
uint32_t roastStartEpoch = 0;
// A roast's stable identity even when SNTP has not supplied a start epoch.
// Zero means no roast has started during this boot. Each accepted start gets
// the next positive value; failed starts do not consume an id.
uint32_t roastSessionId = 0;
uint32_t roastSessionCounter = 0;
uint32_t roastPlanRevision = 0;
char roastProfileId[65] = {0};
uint32_t roastProfileRevision = 0;
// The operator/program boundary, deliberately separate from the thermal-log
// duration. A recording may continue through a three-minute fan-off decay tail;
// the tail does not belong in a reusable instruction path. Manual roasts are
// bounded to 30 minutes, so uint16 is ample, while the
// saturation keeps the same field well-defined for every roast mode.
uint16_t roastStopSec = 0;
uint32_t roastLastRenewUs = 0;
uint32_t roastRenewals = 0;
uint32_t roastCommandFanMilli = 0;
uint32_t roastCommandHeatMilli = 0;
// MANUAL roast: the same whole-instruction lease as the diagnostic Manual
// page, kept separately so status and end reasons cannot cross-contaminate.
uint32_t roastLastInstructionMs = 0;

// TIMED
uint32_t roastStepFanMilli[kRoastMaxSteps] = {};
uint32_t roastStepHeatMilli[kRoastMaxSteps] = {};
uint32_t roastStepSeconds[kRoastMaxSteps] = {};
size_t roastStepCount = 0;
size_t roastStepIndex = 0;
uint32_t roastStepEndUs = 0;
bool roastStepDeadlineArmed = false;
uint32_t roastStepStartedUs = 0;
uint32_t roastStepDwellRemainingSec = 0;
bool roastHeatObserved = false;

// JOURNEY
sr800::JourneyZone roastZones[sr800::kMaxJourneyZones] = {};
size_t roastZoneCount = 0;
uint16_t roastZoneAttainedSec[sr800::kMaxJourneyZones] = {};
sr800::JourneyControlState roastControlState;
sr800::JourneyCalibration roastCalibration;
double roastAmbientC = 0.0;
double roastBatchMassG = 225.0;
double roastTargetC = 0.0;
double roastCorrectionTotal = 0.0;
double roastIntegral = 0.0;
double roastCommandFan = 0.0;
double roastCommandHeat = 0.0;
uint32_t roastElapsedSec = 0;
uint32_t roastLastTickMs = 0;
sr800::runtime::JourneyHeatContinuity roastHeatContinuity;
bool roastHoldover = false;
bool roastSaturated = false;
// Immutable archive provenance for the currently recorded roast. Full snapshots
// stay in RAM only; codec 2 delta-encodes them into at most 1024 bytes on persist.
sr800::logcodec::PlanProvenance roastArchivePlan = {};
bool roastArchivePlanValid = false;
// The archive format has no truncation marker, so a manual roast whose bounded
// instruction journal is full keeps running every new instruction and simply
// drops the journal entry; this flag reports that the recording's journal is
// incomplete (the journal must never gate the actuator).
bool roastArchiveJournalTruncated = false;
sr800::logcodec::PlanProvenance calibrationArchivePlan = {};
bool calibrationArchivePlanValid = false;
// Device-enforced runtime envelope: 2x the plan's total nominal seconds plus
// ten minutes. Attainment-gated zones mean an unreachable endpoint holds — and
// renews Heat — forever without this bound; browser preflight is advice, not a
// safety boundary.
constexpr uint32_t kRoastEnvelopeMarginSec = 600;
uint32_t roastEnvelopeSec = 0;

uint8_t archivePlanLevel(double level) {
  const long deci = lround(level * 10.0);
  return static_cast<uint8_t>(deci < 0 ? 0 : deci > 100 ? 100 : deci);
}

int16_t archivePlanTemperature(double temperatureC) {
  const long deci = lround(temperatureC * 10.0);
  return static_cast<int16_t>(
      deci < INT16_MIN ? INT16_MIN : deci > INT16_MAX ? INT16_MAX : deci);
}

bool captureCalibrationArchivePlan(const uint32_t* fanMilli,
                                   const uint32_t* heatMilli,
                                   size_t stepCount,
                                   uint32_t maximumStepSeconds,
                                   uint32_t minimumDwellSeconds,
                                   uint8_t settleSeconds,
                                   float settleBandC) {
  calibrationArchivePlan = sr800::logcodec::PlanProvenance{};
  calibrationArchivePlanValid = false;
  if (fanMilli == nullptr || heatMilli == nullptr || stepCount == 0 ||
      stepCount > sr800::logcodec::kMaxCalibrationPlanItems ||
      maximumStepSeconds == 0 || maximumStepSeconds > UINT16_MAX ||
      minimumDwellSeconds > UINT8_MAX) return false;
  calibrationArchivePlan.mode = sr800::logcodec::PlanMode::CALIBRATION;
  calibrationArchivePlan.itemCount = static_cast<uint8_t>(stepCount);
  calibrationArchivePlan.minimumDwellSec =
      static_cast<uint8_t>(minimumDwellSeconds);
  calibrationArchivePlan.settleSeconds = settleSeconds;
  calibrationArchivePlan.settleBandTenthsC = static_cast<uint8_t>(
      lroundf(settleBandC * 10.0f));
  for (size_t index = 0; index < stepCount; ++index) {
    sr800::logcodec::PlanItem& item = calibrationArchivePlan.items[index];
    item.fanDeci = static_cast<uint8_t>((fanMilli[index] + 50U) / 100U);
    item.heatDeci = static_cast<uint8_t>((heatMilli[index] + 50U) / 100U);
    item.durationSec = static_cast<uint16_t>(maximumStepSeconds);
  }
  uint8_t proof[sr800::logcodec::kMaxPlanEnvelopeBytes];
  calibrationArchivePlanValid = sr800::logcodec::encodePlanProvenance(
      calibrationArchivePlan, proof, sizeof(proof)) > 0;
  return calibrationArchivePlanValid;
}
void captureInitialRoastArchivePlan() {
  roastArchivePlan = sr800::logcodec::PlanProvenance{};
  roastArchivePlanValid = false;
  roastArchiveJournalTruncated = false;
  roastArchivePlan.mode =
      roastMode == RoastMode::TIMED ? sr800::logcodec::PlanMode::TIMED :
      roastMode == RoastMode::JOURNEY ? sr800::logcodec::PlanMode::JOURNEY :
      sr800::logcodec::PlanMode::MANUAL;
  if (roastMode == RoastMode::TIMED) {
    roastArchivePlan.itemCount = static_cast<uint8_t>(roastStepCount);
    for (size_t index = 0; index < roastStepCount; ++index) {
      sr800::logcodec::PlanItem& item = roastArchivePlan.items[index];
      item.fanDeci = static_cast<uint8_t>(
          (roastStepFanMilli[index] + 50U) / 100U);
      item.heatDeci = static_cast<uint8_t>(
          (roastStepHeatMilli[index] + 50U) / 100U);
      item.durationSec = static_cast<uint16_t>(roastStepSeconds[index]);
    }
  } else if (roastMode == RoastMode::JOURNEY) {
    roastArchivePlan.itemCount = static_cast<uint8_t>(roastZoneCount);
    for (size_t index = 0; index < roastZoneCount; ++index) {
      const sr800::JourneyZone& zone = roastZones[index];
      sr800::logcodec::PlanItem& item = roastArchivePlan.items[index];
      item.startDeci = archivePlanTemperature(zone.startC);
      item.endDeci = archivePlanTemperature(zone.endC);
      item.durationSec = static_cast<uint16_t>(lround(zone.durationSec));
      item.fanMinDeci = archivePlanLevel(zone.fanMin);
      item.fanMaxDeci = archivePlanLevel(zone.fanMax);
      item.heatMinDeci = archivePlanLevel(zone.heatMin);
      item.heatMaxDeci = archivePlanLevel(zone.heatMax);
    }
  } else if (roastMode == RoastMode::MANUAL) {
    roastArchivePlan.itemCount = 1;
    roastArchivePlan.items[0].fanDeci = static_cast<uint8_t>(
        (roastCommandFanMilli + 50U) / 100U);
    roastArchivePlan.items[0].heatDeci = static_cast<uint8_t>(
        (roastCommandHeatMilli + 50U) / 100U);
  } else {
    return;
  }
  uint8_t proof[sr800::logcodec::kMaxPlanEnvelopeBytes];
  roastArchivePlanValid = sr800::logcodec::encodePlanProvenance(
      roastArchivePlan, proof, sizeof(proof)) > 0;
}

bool stageRoastArchivePlanChange(const sr800::JourneyZone* zones,
                                 size_t zoneCount,
                                 uint32_t elapsedSec,
                                 uint32_t planRevision) {
  if (!roastArchivePlanValid ||
      roastArchivePlan.mode != sr800::logcodec::PlanMode::JOURNEY ||
      roastArchivePlan.journalCount >=
          sr800::logcodec::kMaxPlanJournalEvents ||
      zoneCount == 0 || zoneCount > sr800::kMaxJourneyZones ||
      elapsedSec > UINT16_MAX) {
    return false;
  }
  sr800::logcodec::PlanJournalEvent& event =
      roastArchivePlan.journal[roastArchivePlan.journalCount];
  event = sr800::logcodec::PlanJournalEvent{};
  event.elapsedSec = static_cast<uint16_t>(elapsedSec);
  event.planRevision = planRevision;
  event.itemCount = static_cast<uint8_t>(zoneCount);
  for (size_t index = 0; index < zoneCount; ++index) {
    sr800::logcodec::PlanItem& item = event.items[index];
    item.startDeci = archivePlanTemperature(zones[index].startC);
    item.endDeci = archivePlanTemperature(zones[index].endC);
    item.durationSec = static_cast<uint16_t>(lround(zones[index].durationSec));
    item.fanMinDeci = archivePlanLevel(zones[index].fanMin);
    item.fanMaxDeci = archivePlanLevel(zones[index].fanMax);
    item.heatMinDeci = archivePlanLevel(zones[index].heatMin);
    item.heatMaxDeci = archivePlanLevel(zones[index].heatMax);
  }
  roastArchivePlan.journalCount++;
  uint8_t proof[sr800::logcodec::kMaxPlanEnvelopeBytes];
  if (sr800::logcodec::encodePlanProvenance(
          roastArchivePlan, proof, sizeof(proof)) == 0) {
    roastArchivePlan.journalCount--;
    return false;
  }
  return true;
}

bool stageTimedRoastArchiveChange(size_t stepIndex,
                                  uint32_t fanMilli,
                                  uint32_t heatMilli,
                                  uint32_t durationSec,
                                  uint32_t elapsedSec,
                                  uint32_t planRevision) {
  if (!roastArchivePlanValid || roastArchivePlan.mode != sr800::logcodec::PlanMode::TIMED ||
      roastArchivePlan.journalCount >= sr800::logcodec::kMaxPlanJournalEvents ||
      stepIndex >= kRoastMaxSteps || elapsedSec > UINT16_MAX || durationSec == 0 || durationSec > UINT16_MAX) return false;
  sr800::logcodec::PlanJournalEvent& event = roastArchivePlan.journal[roastArchivePlan.journalCount];
  event = sr800::logcodec::PlanJournalEvent{};
  event.elapsedSec = static_cast<uint16_t>(elapsedSec);
  event.planRevision = planRevision;
  event.itemIndex = static_cast<uint8_t>(stepIndex);
  event.itemCount = 1;
  event.items[0].fanDeci = static_cast<uint8_t>((fanMilli + 50U) / 100U);
  event.items[0].heatDeci = static_cast<uint8_t>((heatMilli + 50U) / 100U);
  event.items[0].durationSec = static_cast<uint16_t>(durationSec);
  roastArchivePlan.journalCount++;
  uint8_t proof[sr800::logcodec::kMaxPlanEnvelopeBytes];
  if (sr800::logcodec::encodePlanProvenance(roastArchivePlan, proof, sizeof(proof)) == 0) {
    roastArchivePlan.journalCount--;
    return false;
  }
  return true;
}

bool canStageManualRoastArchiveChange(uint32_t elapsedSec) {
  return roastArchivePlanValid &&
      roastArchivePlan.mode == sr800::logcodec::PlanMode::MANUAL &&
      roastArchivePlan.journalCount < sr800::logcodec::kMaxPlanJournalEvents &&
      elapsedSec <= UINT16_MAX;
}

bool stageManualRoastArchiveChange(uint32_t elapsedSec,
                                   uint32_t planRevision,
                                   uint32_t requestedFanMilli,
                                   uint32_t requestedHeatMilli,
                                   uint32_t effectiveFanMilli,
                                   uint32_t effectiveHeatMilli) {
  if (!canStageManualRoastArchiveChange(elapsedSec)) return false;
  sr800::logcodec::PlanJournalEvent& event =
      roastArchivePlan.journal[roastArchivePlan.journalCount];
  event = sr800::logcodec::PlanJournalEvent{};
  event.elapsedSec = static_cast<uint16_t>(elapsedSec);
  event.planRevision = planRevision;
  event.itemCount = 1;
  event.items[0].fanDeci = static_cast<uint8_t>((requestedFanMilli + 50U) / 100U);
  event.items[0].heatDeci = static_cast<uint8_t>((requestedHeatMilli + 50U) / 100U);
  event.items[0].fanMinDeci = static_cast<uint8_t>((effectiveFanMilli + 50U) / 100U);
  event.items[0].heatMinDeci = static_cast<uint8_t>((effectiveHeatMilli + 50U) / 100U);
  roastArchivePlan.journalCount++;
  uint8_t proof[sr800::logcodec::kMaxPlanEnvelopeBytes];
  if (sr800::logcodec::encodePlanProvenance(
          roastArchivePlan, proof, sizeof(proof)) == 0) {
    roastArchivePlan.journalCount--;
    return false;
  }
  return true;
}

const char* roastModeName(RoastMode mode) {
  switch (mode) {
    case RoastMode::TIMED: return "timed";
    case RoastMode::JOURNEY: return "journey";
    case RoastMode::MANUAL: return "manual";
    default: return "none";
  }
}

// Stable one-byte archive codes. Zero is the old-v3 reserved-byte value and
// therefore means "not recorded"; values are never inferred for older files.
uint8_t roastEndReasonCode(const char* reason) {
  if (reason == nullptr || strcmp(reason, "none") == 0) return 0;
  if (strcmp(reason, "stopped") == 0) return 1;
  if (strcmp(reason, "completed") == 0) return 2;
  if (strcmp(reason, "fault") == 0) return 3;
  if (strcmp(reason, "instruction_expired") == 0) return 4;
  if (strcmp(reason, "renewal_rejected") == 0) return 5;
  if (strcmp(reason, "qualification_stalled") == 0) return 6;
  if (strcmp(reason, "sensor_lost") == 0) return 7;
  if (strcmp(reason, "command_rejected") == 0) return 8;
  if (strcmp(reason, "envelope_timeout") == 0) return 9;
  if (strcmp(reason, "step_rejected") == 0) return 10;
  if (strcmp(reason, "telemetry_stale") == 0) return 11;
  if (strcmp(reason, "heat_lease_expired") == 0) return 12;
  return 0;
}

const char* roastEndReasonFromCode(uint8_t code) {
  switch (code) {
    case 1: return "stopped";
    case 2: return "completed";
    case 3: return "fault";
    case 4: return "instruction_expired";
    case 5: return "renewal_rejected";
    case 6: return "qualification_stalled";
    case 7: return "sensor_lost";
    case 8: return "command_rejected";
    case 9: return "envelope_timeout";
    case 10: return "step_rejected";
    case 11: return "telemetry_stale";
    case 12: return "heat_lease_expired";
    default: return nullptr;
  }
}

// Capture the end while the roast clock still belongs to the active program.
// Every exit path uses this helper so status, Stop acknowledgements and the
// eventual archive header all report the same boundary and reason.
void markRoastEnded(const char* reason) {
  const uint32_t elapsed = (millis() - roastStartedMs) / 1000U;
  roastElapsedSec = elapsed;
  roastStopSec = elapsed > UINT16_MAX ? UINT16_MAX
                                      : static_cast<uint16_t>(elapsed);
  roastActive = false;
  roastEndReason = reason;
}

// A solved level in 0.0 through 10.0 as the actuator's milli-units, with the
// same drive-minimum treatment every other request path applies.
uint32_t roastLevelToMilli(double level) {
  if (!(level > 0.0)) return 0;
  double bounded = level < 0.1 ? 0.1 : level;
  if (bounded > 10.0) bounded = 10.0;
  uint32_t milli = static_cast<uint32_t>(lround(bounded * 1000.0));
  if (milli < kFanLevelMinimumMilli) milli = kFanLevelMinimumMilli;
  if (milli > kFanLevelMaximumMilli) milli = kFanLevelMaximumMilli;
  return milli;
}

// The universal heat-on Fan floor (see kHeatOnFanMinimumMilli): a commanded pair
// carrying Heat is lifted — never refused — to Fan 1.0 when its fan is lower.
uint32_t heatOnFanFloorMilli(uint32_t fanMilli, uint32_t heatMilli) {
  return heatMilli > 0 && fanMilli < kHeatOnFanMinimumMilli
             ? kHeatOnFanMinimumMilli
             : fanMilli;
}

void resetCalibrationSettle() {
  calibrationSettleDetector.reset(
      calibrationSettleSeconds, calibrationSettleBandC);
  calibrationSettleLastMs = 0;
}

bool calibrationStepSettled() {
  return calibrationSettleDetector.settled();
}

// Calibration thermal log: 1 Hz corrected-temperature samples from program or
// proof start through command completion and passive decay. Loop-task only; no ISR access.
//
// The capacity is defined in the shared volume budget rather than here, because
// it is one of the two terms that decide how large a single persist can be —
// and therefore how much free space a document write has to leave behind. The
// two subsystems get one number or they drift apart again.
constexpr uint32_t kThermalLogCapacity = sr800::volume::kMaxRecordingSamples;
constexpr uint32_t kThermalLogIntervalMs = 1000;
constexpr uint32_t kCompactRoastLogIntervalMs = 10000;
struct ThermalSample {
  uint32_t tMs;
  int16_t thermocoupleDeci;
  int16_t coldJunctionDeci;
  uint16_t fanMilli;
  uint16_t heatMilli;
};
// The RAM log uses the v4 archive's honest 0.1 C precision. Keeping a 12-byte
// row matters for the 4,800-sample capacity, but centi-degrees in an int16 wrap
// at 327.68 C — below the 400 C safety latch. Deci-degrees preserve the full
// plausible roast/calibration range without spending more RAM. INT16_MIN is
// reserved as the missing-channel sentinel.
static_assert(sizeof(ThermalSample) == sr800::logcodec::kRawSampleBytes,
              "the in-flight sample must stay inside the 12-byte RAM budget");
ThermalSample* thermalLog = nullptr;

// The codec's already-quantized view. Persisting this directly avoids treating
// a deci-degree value as a legacy raw centi-degree value.
sr800::logcodec::Sample toCodecSample(const ThermalSample& sample) {
  sr800::logcodec::Sample encoded = {};
  encoded.tMs = sample.tMs;
  encoded.thermocoupleValid = sample.thermocoupleDeci != INT16_MIN;
  encoded.coldJunctionValid = sample.coldJunctionDeci != INT16_MIN;
  encoded.thermocoupleDeci = encoded.thermocoupleValid
      ? sample.thermocoupleDeci : 0;
  encoded.coldJunctionDeci = encoded.coldJunctionValid
      ? sample.coldJunctionDeci : 0;
  encoded.fanDeci = sr800::logcodec::milliToDeci(sample.fanMilli);
  encoded.heatDeci = sr800::logcodec::milliToDeci(sample.heatMilli);
  return encoded;
}
uint32_t thermalLogCount = 0;
uint32_t thermalLogStartMs = 0;
uint32_t thermalLogLastSampleMs = 0;
uint32_t thermalLogIntervalMs = kThermalLogIntervalMs;
float thermalLogThermocoupleOffsetC = kThermocoupleOffsetDefaultC;
bool thermalLogActive = false;
// Core 1 owns capture state and closes the recording. Core 0 may only claim a
// frozen recording for persistence; the handoff is protected by this mux.
portMUX_TYPE thermalLogMux = portMUX_INITIALIZER_UNLOCKED;
bool thermalLogPersistenceClaimed = false;
// False whenever the recording policy for this source did not complete. Roast
// programs normally retain a passive decay tail; a manual roast deliberately
// completes at the operator's Stop boundary. The archive never guesses why an
// interrupted capture ended.
bool thermalLogPassiveTailComplete = true;

// On-device log archive: every completed thermal log persists to the 896 KB
// LittleFS partition so Crackle can list, fetch, and select historical runs
// without any third-party export step. Flash writes stall the MCPWM capture
// callbacks (the cache-blackout failure mode behind the coast policy), so a
// persist may only ever run while the actuator is fully idle: before a start
// request is issued, or from the idle-finalize watcher in the service loop.
enum class ThermalLogSource : uint8_t {
  NONE = 0, PROOF, CALIBRATION,
  MANUAL,  // Legacy archive tag; current Manual Controls does not record.
  ROAST
};
constexpr char kLogArchiveDir[] = "/logs";
constexpr char kLogArchiveTempPath[] = "/logs/pending.tmp";
constexpr uint8_t kLogPersistMaxAttempts = 3;
constexpr uint32_t kLogArchiveMagic = 0x4C4B5243;  // "CRKL"
// Version 4 adds immutable producer identity. This development build has no
// pre-existing data to preserve: only v4 is accepted, and older/unprovenanced
// files are quarantined by the listing endpoint.
constexpr uint16_t kLogArchiveVersion = 4;
constexpr size_t kLogArchiveHeaderV1Bytes = 32;
constexpr size_t kLogArchiveHeaderV2Bytes = 92;
constexpr uint32_t kLogArchiveMinSamples = 30;
// The archive's working reserve, and the document store's 507 floor, come from
// the same derivation — see sr800_volume_budget.h. Retention sweeps to keep
// this much free; a document write is refused unless it leaves this much PLUS
// the largest recording a persist could present, which is what makes "a
// metadata write never forces retention" arithmetic rather than a hope.
constexpr uint32_t kLogArchiveReserveBytes = sr800::volume::kLogArchiveReserveBytes;
// How long everything must stay idle before a recording is closed. This is the
// length of the PASSIVE DECAY TAIL the recording captures, and it is chosen
// against what that tail is for.
//
// The tail is the loss/tau fit's raw material, but not all of it is usable. The
// first ~30 s after the fan stops is HEAT-SOAK REBOUND: the element and the
// chamber wall are still hotter than the bean mass, and with no airflow to
// carry it away that stored heat pushes the probe back UP. It is a real
// measurement of a real thing, and it is emphatically not exponential decay —
// fitting a loss coefficient through it reads the rebound as negative loss and
// biases tau long. So the window has to clear the rebound and then keep going
// long enough to have a clean stretch worth regressing: ~3 minutes gives ~30 s
// of rebound and ~150 s of clean decay, which at deci-degree resolution is
// ~150 distinguishable points down a curve that falls a fraction of a degree
// per second. (At whole-degree resolution it would have been ~15 flats, which
// is half of why the archive now stores tenths.)
//
// It was 10 minutes, which was not more information — it was ~600 samples of
// asymptote, ~40% of a typical recording's bytes, describing the last few
// degrees of approach to room temperature that no fit is sensitive to.
// The tail closes on time alone. A temperature-based early exit (<100 C
// sustained 60 s) was tried and withdrawn: after outputs stop, the fan-off
// tail usually BEGINS below 100 C, so that rule closed recordings at
// the 60 s mark — ~30 s of heat-soak rebound plus ~30 s of decay — gutting
// the clean-slope window the 3-minute cap exists to capture. The rule could
// only ever shorten the tail when shortening hurt the fit, and never fired
// when the chamber was hot (the cap wins there). Cost of the full window over
// the early exit: ~600 bytes per recording.
constexpr uint32_t kLogIdleFinalizeMs = 3U * 60U * 1000U;
struct LogArchiveHeader {
  // --- version 1: the first 32 bytes, and their layout is frozen ---
  uint32_t magic;
  uint16_t version;
  uint8_t source;
  uint8_t reserved;
  uint32_t logId;
  uint32_t boot;
  uint32_t startEpoch;  // Unix seconds at first sample; 0 = clock never synced
  uint32_t durationMs;
  uint32_t sampleCount;
  uint32_t intervalMs;
  // --- version 2 additions ---
  char name[kRoastNameBytes];  // roast name, NOT null-terminated when full
  uint8_t zoneCount;           // 0 for a timed roast or a non-roast log
  // RoastMode on newly written roast logs; 0 on older files and non-roast
  // logs. This deliberately consumes the frozen v2 reserved byte rather than
  // preserving the former v3 byte offsets inside the v4 header. The serving
  // new browser can distinguish manual from timed recordings without guessing
  // from the actuator curve.
  uint8_t roastMode;
  uint16_t batchMassG;         // 0 = not a roast / mass unknown
  uint16_t zoneAttainedSec[sr800::kMaxJourneyZones];  // 0xFFFF = not attained
  // --- version 3 additions ---
  uint32_t encodedBytes;  // payload length on disk, whatever the codec
  uint32_t crc32;         // v4 metadata, provenance, and payload integrity
  uint8_t codec;          // see sr800_log_codec.h; 0 = the raw v2 layout
  // Former v3 reserved bytes. Stop seconds are little-endian at 101..102;
  // reason is the stable code above at 103. Old v3 files contain zeroes.
  uint8_t roastStopSecBytes[2];
  uint8_t roastEndReason;
  // --- version 4: immutable producer identity, covered by the file CRC ---
  char sourceDeviceId[sr800::logcodec::kArchiveDeviceIdBytes];
  char sourceModelId[sr800::logcodec::kArchiveModelIdBytes];
  char sourceDisplayName[sr800::logcodec::kArchiveDisplayNameBytes];
  char sourceFirmwareVersion[sr800::logcodec::kArchiveFirmwareVersionBytes];
  uint32_t originLogId;
  uint8_t provenanceFlags;
  uint8_t provenanceReserved[3];
  uint32_t provenanceCrc32;
};
static_assert(sizeof(LogArchiveHeader) == sr800::volume::kLogArchiveHeaderBytes,
              "the archive header layout is a wire format, and the volume "
              "budget sizes the worst-case recording from it");
constexpr size_t kLogArchiveHeaderV3Bytes = sr800::logcodec::kArchiveHeaderV3Bytes;
constexpr size_t kLogArchiveHeaderV4Bytes = sizeof(LogArchiveHeader);
// `sr800_log_codec.h` validates an UPLOADED archive file by byte offset — it is
// a wire format, and it has to be checkable on a host where this struct's
// padding is the host compiler's business. These assertions are the joint: the
// struct the device writes and the offsets the validator reads cannot drift
// apart without failing the build.
static_assert(kLogArchiveMagic == sr800::logcodec::kArchiveMagic, "magic");
static_assert(kLogArchiveVersion <= sr800::logcodec::kArchiveVersionMax,
              "the validator must know every version this firmware writes");
static_assert(kLogArchiveHeaderV1Bytes == sr800::logcodec::kArchiveHeaderV1Bytes,
              "v1 header size");
static_assert(kLogArchiveHeaderV2Bytes == sr800::logcodec::kArchiveHeaderV2Bytes,
              "v2 header size");
static_assert(kLogArchiveHeaderV3Bytes == sr800::logcodec::kArchiveHeaderV3Bytes,
              "v3 header size");
static_assert(kLogArchiveHeaderV4Bytes == sr800::logcodec::kArchiveHeaderV4Bytes,
              "v4 header size");
static_assert(sr800::kMaxJourneyZones == sr800::logcodec::kArchiveMaxZones,
              "zone maximum");
static_assert(offsetof(LogArchiveHeader, magic) ==
              sr800::logcodec::kArchiveOffsetMagic, "magic offset");
static_assert(offsetof(LogArchiveHeader, version) ==
              sr800::logcodec::kArchiveOffsetVersion, "version offset");
static_assert(offsetof(LogArchiveHeader, source) ==
              sr800::logcodec::kArchiveOffsetSource, "source offset");
static_assert(offsetof(LogArchiveHeader, logId) ==
              sr800::logcodec::kArchiveOffsetLogId, "logId offset");
static_assert(offsetof(LogArchiveHeader, sampleCount) ==
              sr800::logcodec::kArchiveOffsetSampleCount, "sampleCount offset");
static_assert(offsetof(LogArchiveHeader, zoneCount) ==
               sr800::logcodec::kArchiveOffsetZoneCount, "zoneCount offset");
static_assert(offsetof(LogArchiveHeader, roastMode) == 65,
              "roast mode occupies the v2 reserved byte");
static_assert(offsetof(LogArchiveHeader, encodedBytes) ==
              sr800::logcodec::kArchiveOffsetEncodedBytes,
              "encodedBytes offset");
static_assert(offsetof(LogArchiveHeader, crc32) ==
              sr800::logcodec::kArchiveOffsetCrc32, "crc32 offset");
static_assert(offsetof(LogArchiveHeader, codec) ==
              sr800::logcodec::kArchiveOffsetCodec, "codec offset");
static_assert(offsetof(LogArchiveHeader, roastStopSecBytes) ==
                  sr800::logcodec::kArchiveOffsetRoastStopSec,
              "roast stop seconds occupy v3 reserved bytes 101..102");
static_assert(offsetof(LogArchiveHeader, roastEndReason) ==
                  sr800::logcodec::kArchiveOffsetRoastEndReason,
              "roast end reason occupies v3 reserved byte 103");
static_assert(offsetof(LogArchiveHeader, sourceDeviceId) ==
                  sr800::logcodec::kArchiveOffsetSourceDeviceId,
              "source device id offset");
static_assert(offsetof(LogArchiveHeader, sourceModelId) ==
                  sr800::logcodec::kArchiveOffsetSourceModelId,
              "source model id offset");
static_assert(offsetof(LogArchiveHeader, sourceDisplayName) ==
                  sr800::logcodec::kArchiveOffsetSourceDisplayName,
              "source display name offset");
static_assert(offsetof(LogArchiveHeader, sourceFirmwareVersion) ==
                  sr800::logcodec::kArchiveOffsetSourceFirmwareVersion,
              "source firmware version offset");
static_assert(offsetof(LogArchiveHeader, originLogId) ==
                  sr800::logcodec::kArchiveOffsetOriginLogId,
              "origin log id offset");
static_assert(offsetof(LogArchiveHeader, provenanceFlags) ==
                  sr800::logcodec::kArchiveOffsetProvenanceFlags,
              "provenance flags offset");
static_assert(offsetof(LogArchiveHeader, provenanceReserved) ==
                  sr800::logcodec::kArchiveOffsetThermocoupleOffsetCenti,
              "thermocouple offset metadata starts at byte 213");
static_assert(offsetof(LogArchiveHeader, provenanceCrc32) ==
                  sr800::logcodec::kArchiveOffsetProvenanceCrc32,
              "provenance checksum offset");
static_assert(sizeof(ThermalSample) == sr800::logcodec::kRawSampleBytes,
              "the v1/v2 payload stride the validator assumes");

void formatStableDeviceId(char* out, size_t capacity) {
  snprintf(out, capacity, "esp32-%012llx",
           static_cast<unsigned long long>(ESP.getEfuseMac() & 0xFFFFFFFFFFFFULL));
}

void fillArchiveProvenance(LogArchiveHeader& header) {
  formatStableDeviceId(header.sourceDeviceId, sizeof(header.sourceDeviceId));
  snprintf(header.sourceModelId, sizeof(header.sourceModelId), "%s",
           kRoasterModelId);
  snprintf(header.sourceDisplayName, sizeof(header.sourceDisplayName), "%s",
           kRoasterDisplayName);
  snprintf(header.sourceFirmwareVersion, sizeof(header.sourceFirmwareVersion),
           "%s", kFirmwareVersion);
  header.originLogId = header.logId;
  header.provenanceFlags = thermalLogPassiveTailComplete
      ? 0 : sr800::logcodec::kArchivePassiveTailIncomplete;
  const long offsetCentiLong = lroundf(thermalLogThermocoupleOffsetC * 100.0f);
  const int16_t offsetCenti = static_cast<int16_t>(
      offsetCentiLong < sr800::logcodec::kArchiveThermocoupleOffsetMinimumCenti
          ? sr800::logcodec::kArchiveThermocoupleOffsetMinimumCenti
          : offsetCentiLong > sr800::logcodec::kArchiveThermocoupleOffsetMaximumCenti
              ? sr800::logcodec::kArchiveThermocoupleOffsetMaximumCenti
              : offsetCentiLong);
  const uint16_t offsetCentiBits = static_cast<uint16_t>(offsetCenti);
  header.provenanceReserved[0] = static_cast<uint8_t>(offsetCentiBits & 0xFFU);
  header.provenanceReserved[1] = static_cast<uint8_t>((offsetCentiBits >> 8) & 0xFFU);
  header.provenanceReserved[2] = sr800::logcodec::kArchiveThermocoupleOffsetPresent;
  // Physical firmware never sets kArchiveProvenanceSimulated.
  const uint8_t* bytes = reinterpret_cast<const uint8_t*>(&header);
  header.provenanceCrc32 = sr800::logcodec::crc32Finish(
      sr800::logcodec::crc32Update(
          sr800::logcodec::kCrc32Init,
          bytes + sr800::logcodec::kArchiveOffsetSourceDeviceId,
          sr800::logcodec::kArchiveOffsetProvenanceCrc32 -
              sr800::logcodec::kArchiveOffsetSourceDeviceId));
}

bool archiveThermocoupleOffset(const LogArchiveHeader& header,
                               int16_t& offsetCenti) {
  if ((header.provenanceReserved[2] &
       sr800::logcodec::kArchiveThermocoupleOffsetPresent) == 0) return false;
  const uint16_t raw = static_cast<uint16_t>(header.provenanceReserved[0]) |
      (static_cast<uint16_t>(header.provenanceReserved[1]) << 8);
  offsetCenti = static_cast<int16_t>(raw);
  return offsetCenti >= sr800::logcodec::kArchiveThermocoupleOffsetMinimumCenti &&
      offsetCenti <= sr800::logcodec::kArchiveThermocoupleOffsetMaximumCenti;
}

uint32_t archiveIntegrityCrcBegin(const LogArchiveHeader& header) {
  const uint8_t* bytes = reinterpret_cast<const uint8_t*>(&header);
  uint32_t crc = sr800::logcodec::kCrc32Init;
  crc = sr800::logcodec::crc32Update(
      crc, bytes, sr800::logcodec::kArchiveOffsetCrc32);
  return sr800::logcodec::crc32Update(
      crc, bytes + sr800::logcodec::kArchiveOffsetCodec,
      sizeof(header) - sr800::logcodec::kArchiveOffsetCodec);
}
ThermalLogSource thermalLogSource = ThermalLogSource::NONE;
bool thermalLogUnsaved = false;
uint8_t thermalLogPersistAttempts = 0;
uint32_t thermalLogPersistNotBeforeMs = 0;
// Meaningful logs that could not be persisted and are gone. Surfaced in
// /api/status so a sick filesystem is a visible fact, not a silent one.
uint32_t logArchiveLostLogs = 0;
// True when the archive volume failed to mount but was previously initialized:
// formatting would destroy stored logs, so it waits for an explicit command.
bool logArchiveNeedsFormat = false;
bool logArchiveMounted = false;
enum class StorageFailureStage : uint8_t {
  NONE = 0,
  PARTITION_MISSING,
  LAYOUT_MISMATCH,
  MARKER_WRITE,
  MOUNT,
  FORMAT,
  PROBE_DEST_OPEN,
  PROBE_DEST_WRITE,
  PROBE_TEMP_OPEN,
  PROBE_TEMP_WRITE,
  PROBE_RENAME,
  PROBE_VERIFY,
  LOG_DIRECTORY,
  DATA_DIRECTORY,
  ARCHIVE_WRITE,
  ARCHIVE_RENAME,
  DOCUMENT_WRITE,
  DOCUMENT_RENAME,
};
StorageFailureStage storageFailureStage = StorageFailureStage::NONE;
uint32_t storageFailureFreeHeapBytes = 0;
uint32_t storageFailureMinFreeHeapBytes = 0;
uint32_t storageFailureLargestBlockBytes = 0;
uint32_t storageWriteFailures = 0;
uint32_t storageExpectedOffset = 0;
uint32_t storageExpectedSize = 0;
uint32_t storageStoredOffset = 0;
uint32_t storageStoredSize = 0;
uint16_t storageStoredFormatVersion = 0;
bool storageMarkerPresent = false;
volatile bool storageMutationActive = false;
TaskHandle_t storageMutationOwner = nullptr;
uint16_t storageMutationDepth = 0;
volatile bool storageRequestActive = false;
TaskHandle_t storageRequestOwner = nullptr;
// Once an actuation start collides with a read, briefly refuse new library
// transfers so the device-owned retry can acquire storage as soon as the
// already-running transfer finishes. This is scheduling only: it never delays
// Stop and never permits actuation before the mutation guard is held.
// Sized to outlast one library transfer: a 32-recording /api/logs list takes ~2.3 s
// and a manifest ~1.3 s (measured), so a 1.5 s window with 1 s of device-owned retry
// would let every Start lose to back-to-back reconnect hydration.
constexpr uint32_t kActuationStartStoragePriorityMs = 3500;
bool storageMutationPriorityActive = false;
uint32_t storageMutationPriorityUntilMs = 0;
portMUX_TYPE storageMutationMux = portMUX_INITIALIZER_UNLOCKED;

bool otaReservesPort80();

class StorageMutationGuard {
 public:
  explicit StorageMutationGuard(bool required = true, bool prioritize = false)
      : required_(required) {
    if (!required_) {
      acquired_ = true;
      return;
    }
    if (otaReservesPort80()) return;
    const TaskHandle_t current = xTaskGetCurrentTaskHandle();
    const uint32_t nowMs = millis();
    portENTER_CRITICAL(&storageMutationMux);
    // Re-check while owning the storage arbiter. OTA admission takes these
    // locks in the same storage-then-OTA order, closing the preemption gap.
    if (otaReservesPort80()) {
      portEXIT_CRITICAL(&storageMutationMux);
      return;
    }
    const bool priorityActive =
        storageMutationPriorityActive &&
        sr800::runtime::deadlinePending(
            nowMs, storageMutationPriorityUntilMs);
    if (!priorityActive) {
      storageMutationPriorityActive = false;
      storageMutationPriorityUntilMs = 0;
    }
    if (storageMutationActive && storageMutationOwner == current) {
      ++storageMutationDepth;
      if (prioritize) {
        storageMutationPriorityActive = false;
        storageMutationPriorityUntilMs = 0;
      }
      acquired_ = true;
    } else if (!storageMutationActive &&
               (!storageRequestActive || storageRequestOwner == current)) {
      storageMutationActive = true;
      storageMutationOwner = current;
      storageMutationDepth = 1;
      if (prioritize) {
        storageMutationPriorityActive = false;
        storageMutationPriorityUntilMs = 0;
      }
      acquired_ = true;
    } else if (prioritize) {
      storageMutationPriorityActive = true;
      storageMutationPriorityUntilMs =
          nowMs + kActuationStartStoragePriorityMs;
    }
    portEXIT_CRITICAL(&storageMutationMux);
  }
  ~StorageMutationGuard() {
    if (!acquired_ || !required_) return;
    portENTER_CRITICAL(&storageMutationMux);
    if (storageMutationOwner == xTaskGetCurrentTaskHandle() &&
        storageMutationDepth > 0 && --storageMutationDepth == 0) {
      storageMutationOwner = nullptr;
      storageMutationActive = false;
    }
    portEXIT_CRITICAL(&storageMutationMux);
  }
  explicit operator bool() const { return acquired_; }

 private:
  bool required_ = true;
  bool acquired_ = false;
};
uint32_t actuatorIdleSinceMs = 0;
uint32_t thermalLogReservedId = 0;
// True once the accepted-or-pending roast has a valid zero-sample archive on
// LittleFS. The final persist atomically replaces that file rather than
// counting the same occurrence twice.
bool thermalLogProvisionalPersisted = false;

struct ThermalLogStateSnapshot {
  bool active = false;
  bool unsaved = false;
  bool persistenceClaimed = false;
  uint32_t sampleCount = 0;
  // Names the episode the fenced sampleCount belongs to, so a reader can tell
  // when a stop+start recycled the buffer underneath it.
  uint32_t reservedId = 0;
};

ThermalLogStateSnapshot copyThermalLogState() {
  ThermalLogStateSnapshot snapshot;
  portENTER_CRITICAL(&thermalLogMux);
  snapshot.active = thermalLogActive;
  snapshot.unsaved = thermalLogUnsaved;
  snapshot.persistenceClaimed = thermalLogPersistenceClaimed;
  snapshot.sampleCount = thermalLogCount;
  snapshot.reservedId = thermalLogReservedId;
  portEXIT_CRITICAL(&thermalLogMux);
  return snapshot;
}

uint32_t nextLogArchiveId();
void advanceStateRevision();
uint64_t currentStateRevision();
bool persistProvisionalRoastArchive();
void discardProvisionalRoastArchive();

const char* thermalLogSourceName(ThermalLogSource source) {
  switch (source) {
    case ThermalLogSource::PROOF: return "proof";
    case ThermalLogSource::CALIBRATION: return "calibration";
    case ThermalLogSource::MANUAL: return "manual";
    case ThermalLogSource::ROAST: return "roast";
    default: return "none";
  }
}

uint32_t minimumArchivedSamples(ThermalLogSource source) {
  // A roast archive is the durable occurrence record, even when a compact
  // roast is stopped before the general 30-sample evidence floor.
  return source == ThermalLogSource::ROAST ? 1U : kLogArchiveMinSamples;
}

bool terminalRoastArchiveNeedsReplacement() {
  return thermalLogUnsaved &&
      thermalLogSource == ThermalLogSource::ROAST && !roastActive &&
      roastEndReasonCode(roastEndReason) != 0 && thermalLogReservedId != 0 &&
      roastArchivePlanValid;
}

bool meaningfulUnsavedThermalLog() {
  return thermalLogUnsaved &&
      (thermalLogCount >= minimumArchivedSamples(thermalLogSource) ||
       terminalRoastArchiveNeedsReplacement());
}

void startThermalLog(ThermalLogSource source,
                     uint32_t intervalMs = kThermalLogIntervalMs) {
  // Callers must have finalized the preceding episode first. Keep this
  // fail-safe accounting as a last line of defence if a future caller does not.
  if (meaningfulUnsavedThermalLog()) {
    logArchiveLostLogs++;
  }
  const uint32_t reservedId = nextLogArchiveId();
  portENTER_CRITICAL(&thermalLogMux);
  thermalLogCount = 0;
  thermalLogStartMs = millis();
  thermalLogLastSampleMs = 0;
  thermalLogIntervalMs = intervalMs;
  thermalLogThermocoupleOffsetC = thermocoupleOffsetC;
  thermalLogActive = true;
  // Each source marks its capture policy complete at its authoritative boundary.
  // Until then a provisional archive must fail closed across power loss or interruption.
  thermalLogPassiveTailComplete = false;
  thermalLogSource = source;
  thermalLogUnsaved = true;
  thermalLogPersistAttempts = 0;
  thermalLogProvisionalPersisted = false;
  // Reserve the archive identity now. Calibration status and a later .crk
  // therefore name the same recording even across the volatile interval.
  thermalLogReservedId = reservedId;
  portEXIT_CRITICAL(&thermalLogMux);
}

void rollbackThermalLogStart() {
  // A start may reserve an archive id before asking the actuator to change
  // outputs. If that synchronous request is refused, abandon only the new
  // volatile episode; the monotonic NVS id remains consumed deliberately.
  portENTER_CRITICAL(&thermalLogMux);
  thermalLogCount = 0;
  thermalLogStartMs = 0;
  thermalLogLastSampleMs = 0;
  thermalLogIntervalMs = kThermalLogIntervalMs;
  thermalLogActive = false;
  thermalLogPassiveTailComplete = true;
  thermalLogSource = ThermalLogSource::NONE;
  thermalLogUnsaved = false;
  thermalLogPersistAttempts = 0;
  thermalLogProvisionalPersisted = false;
  thermalLogReservedId = 0;
  portEXIT_CRITICAL(&thermalLogMux);
}
// Defined with the archive code below; start paths call it before requesting
// actuation so the flash write lands while outputs are idle.
bool finalizeThermalLogForNewEpisode();
bool takeOverPriorRecordingForNewEpisode(const char*& rejection);
esp_err_t handleNativeStorageRequest(httpd_req_t* request);
esp_err_t handleOtaVersion(httpd_req_t* request);

esp_err_t handleRawOtaUpload(httpd_req_t* request);
bool finishRoast(uint32_t nowUs, const char* endReason);
bool finalizeEndedRoastRecordingForStop();
bool meaningfulUnsavedThermalLog();
void persistUnsavedThermalLog(bool force);
bool nvsMutationAllowed();
DRAM_ATTR volatile uint32_t factoryFanWindowStartUs = 0;
DRAM_ATTR volatile uint32_t factoryFanLastRiseUs = 0;
DRAM_ATTR volatile uint32_t factoryFanPulseCount = 0;
portMUX_TYPE captureMux = portMUX_INITIALIZER_UNLOCKED;
bool sendBoundedResponse(int statusCode, const char* contentType,
                         const String& body,
                         const char* extraHeaderName,
                         const char* extraHeaderValue);


// Request bindings are TASK-LOCAL. The loop task binds a mailbox command here while the
// crackle-store task binds a storage request, concurrently, on the other core; every request helper
// (requestHasArg, requestArg, sendRequestResponse, sendBoundedResponse, HttpResponseWriter) chooses
// between them. As plain globals, a storage handler running while the loop served a command would
// read the COMMAND's query (no `base`, `cursor`, confirm token...) and write its reply into the
// command's mailbox response - a successful Start could reach the browser as a storage error, and
// the storage socket got no reply at all. Thread-local pointers make each task
// see only the binding it set. POD pointers only; ESP-IDF zero-initialises them per task.
static __thread const sr800::network::CommandRequest* nativeCommandRequest = nullptr;
static __thread sr800::network::CommandResponse* nativeCommandResponse = nullptr;
static __thread httpd_req_t* nativeStorageRequest = nullptr;
// Written and read only by the crackle-store task, which is the only task with a storage binding.
String nativeStorageBody;

// Long flash work (directory walks, CSV streams, archive encodes) must let core 0's IDLE task run:
// the task watchdog checks only IDLE0 (CONFIG_ESP_TASK_WDT_CHECK_IDLE_TASK_CPU0) with a 5 s timeout.
// `delay(0)` is `vTaskDelay(0)`, which yields only to tasks of EQUAL OR HIGHER priority - never to
// IDLE, which is below every Crackle worker - so loops that "yielded" with it still starved IDLE0.
// The manifest walk is the typical case (crackle-store inside handleDataManifest ->
// File::openNextFile -> lfs_bd_read): a walk of /data/runs and /logs can take over a second idle,
// grows with every roast and recording, slows under concurrent app traffic, and can cross 5 s
// without IDLE0 ever running.
// pacedYield() sleeps one tick (1 ms at CONFIG_FREERTOS_HZ=1000) after every 20 ms of work on the
// calling task. Never call it inside a portENTER_CRITICAL section.
static __thread uint32_t lastIdleYieldMs = 0;
inline void pacedYield() {
  const uint32_t nowMs = millis();
  if (nowMs - lastIdleYieldMs < 20) return;
  vTaskDelay(1);
  lastIdleYieldMs = millis();
}

const char* nativeHttpStatus(int statusCode) {
  switch (statusCode) {
    case 200: return "200 OK";
    case 202: return "202 Accepted";
    case 307: return "307 Temporary Redirect";
    case 400: return "400 Bad Request";
    case 404: return "404 Not Found";
    case 405: return "405 Method Not Allowed";
    case 408: return "408 Request Timeout";
    case 409: return "409 Conflict";
    case 413: return "413 Content Too Large";
    case 415: return "415 Unsupported Media Type";
    case 423: return "423 Locked";
    case 429: return "429 Too Many Requests";
    case 500: return "500 Internal Server Error";
    case 501: return "501 Not Implemented";
    case 503: return "503 Service Unavailable";
    case 504: return "504 Gateway Timeout";
    case 507: return "507 Insufficient Storage";
    default: return "500 Internal Server Error";
  }
}

bool nativeRequestHasRawContentType(httpd_req_t* request) {
  if (request == nullptr) return false;
  char contentType[64] = {};
  if (httpd_req_get_hdr_value_str(
          request, "Content-Type", contentType, sizeof(contentType)) != ESP_OK) {
    return false;
  }
  static constexpr char expected[] = "application/octet-stream";
  return strncmp(contentType, expected, sizeof(expected) - 1) == 0 &&
      (contentType[sizeof(expected) - 1] == 0 ||
       contentType[sizeof(expected) - 1] == ';');
}

bool nativeStorageQueryArg(const char* name, String& value) {
  if (nativeStorageRequest == nullptr || name == nullptr) return false;
  const size_t queryLength = httpd_req_get_url_query_len(nativeStorageRequest);
  if (queryLength == 0 || queryLength >= sr800::network::kCommandQueryBytes) {
    return false;
  }
  char query[sr800::network::kCommandQueryBytes] = {};
  if (httpd_req_get_url_query_str(nativeStorageRequest, query,
                                  sizeof(query)) != ESP_OK) return false;
  char decoded[sr800::network::kCommandQueryBytes] = {};
  if (!sr800::network::QueryArgs(query).text(name, decoded,
                                             sizeof(decoded))) return false;
  value = decoded;
  return true;
}

String requestPathArg(size_t index) {
  if (nativeStorageRequest == nullptr) return String();
  if (index != 0 || nativeStorageRequest->uri == nullptr) return String();
  const char* uri = nativeStorageRequest->uri;
  const char* segment = nullptr;
  if (strncmp(uri, "/api/data/runs/", 15) == 0) segment = uri + 15;
  else if (strncmp(uri, "/api/data/", 10) == 0) segment = uri + 10;
  else if (strncmp(uri, "/logs/", 6) == 0) segment = uri + 6;
  if (segment == nullptr) return String();
  const char* query = strchr(segment, '?');
  return query == nullptr
      ? String(segment)
      : String(segment).substring(0, static_cast<unsigned>(query - segment));
}

void bindNativeCommandRequest(
    const sr800::network::CommandRequest* request,
    sr800::network::CommandResponse* response) {
  nativeCommandRequest = request;
  nativeCommandResponse = response;
}

void releaseNativeCommandRequest() {
  nativeCommandRequest = nullptr;
  nativeCommandResponse = nullptr;
}

bool requestHasArg(const char* name) {
  if (nativeCommandRequest != nullptr) {
    const char* form = nativeCommandRequest->formUrlEncoded
        ? reinterpret_cast<const char*>(nativeCommandRequest->body) : nullptr;
    // A form field intentionally overrides a duplicate query field. This keeps
    // secrets out of URLs while retaining query compatibility for every route.
    return sr800::network::QueryArgs(
        form == nullptr ? nativeCommandRequest->query : form,
        form == nullptr ? nullptr : nativeCommandRequest->query).has(name);
  }
  if (nativeStorageRequest != nullptr) {
    if (strcmp(name, "plain") == 0) return true;
    String ignored;
    return nativeStorageQueryArg(name, ignored);
  }
  return false;
}

String requestArg(const char* name) {
  if (nativeCommandRequest != nullptr) {
    char value[sr800::network::kCommandQueryBytes] = {};
    const char* form = nativeCommandRequest->formUrlEncoded
        ? reinterpret_cast<const char*>(nativeCommandRequest->body) : nullptr;
    const sr800::network::QueryArgs args(
        form == nullptr ? nativeCommandRequest->query : form,
        form == nullptr ? nullptr : nativeCommandRequest->query);
    if (!args.text(name, value, sizeof(value))) return String();
    return String(value);
  }
  if (nativeStorageRequest != nullptr) {
    if (strcmp(name, "plain") == 0) return nativeStorageBody;
    String value;
    nativeStorageQueryArg(name, value);
    return value;
  }
  return String();
}

void sendRequestResponse(int statusCode, const char* contentType,
                         const String& body) {
  if (nativeCommandResponse == nullptr) {
    if (nativeStorageRequest != nullptr) {
      httpd_resp_set_status(nativeStorageRequest, nativeHttpStatus(statusCode));
      httpd_resp_set_type(nativeStorageRequest,
                          contentType == nullptr ? "application/json" : contentType);
      httpd_resp_set_hdr(nativeStorageRequest, "Cache-Control", "no-store");
      httpd_resp_send(nativeStorageRequest, body.c_str(), body.length());
    }
    return;
  }
  nativeCommandResponse->status = statusCode;
  strlcpy(nativeCommandResponse->contentType,
          contentType == nullptr ? "application/json" : contentType,
          sizeof(nativeCommandResponse->contentType));
  if (body.length() >= sizeof(nativeCommandResponse->body)) {
    static constexpr char overflow[] =
        "{\"ok\":false,\"message\":\"The controller response exceeded its fixed mailbox.\"}";
    nativeCommandResponse->status = 507;
    strlcpy(nativeCommandResponse->contentType, "application/json",
            sizeof(nativeCommandResponse->contentType));
    nativeCommandResponse->bodyLength = sizeof(overflow) - 1;
    memcpy(nativeCommandResponse->body, overflow, sizeof(overflow));
    nativeCommandResponse->stateRevision = currentStateRevision();
    return;
  }
  nativeCommandResponse->bodyLength = body.length();
  memcpy(nativeCommandResponse->body, body.c_str(),
         nativeCommandResponse->bodyLength);
  nativeCommandResponse->body[nativeCommandResponse->bodyLength] = 0;
  nativeCommandResponse->stateRevision = currentStateRevision();
}

enum class LiveCalibrationSettleState : uint8_t {
  CHECKING = 0,
  MINIMUM_DWELL,
  WAITING_FOR_TRANSITION,
  SETTLED,
};

enum class LiveCalibrationOutcome : uint8_t {
  UNKNOWN = 0,
  SETTLED,
  CAPPED,
};

enum class LiveCalibrationEndReason : uint8_t {
  NONE = 0,
  STOPPED,
  FAULT,
  TELEMETRY_STALE,
  QUALIFICATION_STALLED,
  COMPLETED,
  STEP_REJECTED,
  RENEWAL_REJECTED,
  UNKNOWN,
};

struct LiveCalibrationCompletedStep {
  uint8_t index;
  uint8_t fanDeci;
  uint8_t heatDeci;
  uint16_t elapsedSec;
  float temperatureC;
  LiveCalibrationOutcome outcome;
};

const char* liveCalibrationSettleStateName(
    LiveCalibrationSettleState state) {
  switch (state) {
    case LiveCalibrationSettleState::MINIMUM_DWELL:
      return "minimum_dwell";
    case LiveCalibrationSettleState::WAITING_FOR_TRANSITION:
      return "waiting_for_transition";
    case LiveCalibrationSettleState::SETTLED:
      return "settled";
    case LiveCalibrationSettleState::CHECKING:
    default:
      return "checking";
  }
}

const char* liveCalibrationOutcomeName(LiveCalibrationOutcome outcome) {
  switch (outcome) {
    case LiveCalibrationOutcome::SETTLED:
      return "settled";
    case LiveCalibrationOutcome::CAPPED:
      return "capped";
    case LiveCalibrationOutcome::UNKNOWN:
    default:
      return "unknown";
  }
}

const char* liveCalibrationEndReasonName(LiveCalibrationEndReason reason) {
  switch (reason) {
    case LiveCalibrationEndReason::STOPPED: return "stopped";
    case LiveCalibrationEndReason::FAULT: return "fault";
    case LiveCalibrationEndReason::TELEMETRY_STALE: return "telemetry_stale";
    case LiveCalibrationEndReason::QUALIFICATION_STALLED:
      return "qualification_stalled";
    case LiveCalibrationEndReason::COMPLETED: return "completed";
    case LiveCalibrationEndReason::STEP_REJECTED: return "step_rejected";
    case LiveCalibrationEndReason::RENEWAL_REJECTED:
      return "renewal_rejected";
    case LiveCalibrationEndReason::NONE: return "none";
    case LiveCalibrationEndReason::UNKNOWN:
    default:
      return "unknown";
  }
}

LiveCalibrationEndReason liveCalibrationEndReason(const char* reason) {
  if (reason == nullptr || strcmp(reason, "none") == 0) {
    return LiveCalibrationEndReason::NONE;
  }
  if (strcmp(reason, "stopped") == 0) return LiveCalibrationEndReason::STOPPED;
  if (strcmp(reason, "fault") == 0) return LiveCalibrationEndReason::FAULT;
  if (strcmp(reason, "telemetry_stale") == 0) {
    return LiveCalibrationEndReason::TELEMETRY_STALE;
  }
  if (strcmp(reason, "qualification_stalled") == 0) {
    return LiveCalibrationEndReason::QUALIFICATION_STALLED;
  }
  if (strcmp(reason, "completed") == 0) {
    return LiveCalibrationEndReason::COMPLETED;
  }
  if (strcmp(reason, "step_rejected") == 0) {
    return LiveCalibrationEndReason::STEP_REJECTED;
  }
  if (strcmp(reason, "renewal_rejected") == 0) {
    return LiveCalibrationEndReason::RENEWAL_REJECTED;
  }
  return LiveCalibrationEndReason::UNKNOWN;
}

LiveCalibrationSettleState liveCalibrationSettleState(
    uint32_t elapsedSec) {
  if (!calibrationActive) return LiveCalibrationSettleState::CHECKING;
  if (elapsedSec < calibrationMinDwellMs / 1000U) {
    return LiveCalibrationSettleState::MINIMUM_DWELL;
  }
  if (!calibrationSettleDetector.transitionObserved()) {
    return LiveCalibrationSettleState::WAITING_FOR_TRANSITION;
  }
  return calibrationStepSettled()
      ? LiveCalibrationSettleState::SETTLED
      : LiveCalibrationSettleState::CHECKING;
}
// Reset reasons of the most recent boots, newest first, persisted in the diagnostics
// namespace at boot (an idle-time NVS write). The current boot's reason only says how
// the previous run ended; the ring makes a session of repeated resets visible after the
// next power cycle, where a single-boot reset_reason cannot attribute repeated reboots.
constexpr size_t kBootHistoryCapacity = 8;
// The last crash recorded in the core-dump flash partition (CONFIG_ESP_COREDUMP_ENABLE_TO_FLASH),
// summarised once in setup() before networking or actuation start and never written again, so
// status readers on any task see an immutable value. It makes the backtrace of a watchdog reset or
// panic visible over HTTP without serial access.
struct StoredCrashSummary {
  bool present;
  bool corrupted;
  char task[17];
  uint32_t pc;
  uint8_t depth;
  uint32_t backtrace[16];
  char elfSha256[17];
  // True when the dump's ELF hash is the running image's; false for a crash of an earlier build.
  bool currentBuild;
};
StoredCrashSummary storedCrash = {};
// ESP-IDF's PSRAM minimum has been observed reading 0 a minute after boot with 1.9 MB free, so
// the firmware keeps its own sampled low-water and counts failed allocations to say what happened.
portMUX_TYPE heapDiagnosticsMux = portMUX_INITIALIZER_UNLOCKED;
uint32_t psramLowWaterBytes = UINT32_MAX;
uint32_t psramLowWaterAtMs = 0;
uint32_t failedAllocationCount = 0;
uint32_t lastFailedAllocationBytes = 0;
uint32_t lastFailedAllocationCaps = 0;
uint32_t lastFailedAllocationAtMs = 0;
// Runs inside the allocator's failure path, possibly on any task: no allocation, no logging.
void recordFailedAllocation(size_t size, uint32_t caps, const char*) {
  const uint32_t nowMs = static_cast<uint32_t>(esp_timer_get_time() / 1000);
  portENTER_CRITICAL_SAFE(&heapDiagnosticsMux);
  failedAllocationCount++;
  lastFailedAllocationBytes = static_cast<uint32_t>(size);
  lastFailedAllocationCaps = caps;
  lastFailedAllocationAtMs = nowMs;
  portEXIT_CRITICAL_SAFE(&heapDiagnosticsMux);
}
void samplePsramLowWater(uint32_t nowMs) {
  const uint32_t freeBytes = static_cast<uint32_t>(heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
  portENTER_CRITICAL(&heapDiagnosticsMux);
  if (freeBytes < psramLowWaterBytes) {
    psramLowWaterBytes = freeBytes;
    psramLowWaterAtMs = nowMs;
  }
  portEXIT_CRITICAL(&heapDiagnosticsMux);
}
struct BootHistoryEntry {
  uint32_t bootId;
  uint8_t resetReason;
};
// The asynchronous WebSocket server runs in an ESP-IDF HTTP task. The Arduino loop publishes this
// compact DTO so that task never reaches into actuator locks or loop-owned program state.
struct LiveStatusSnapshot {
  sr800::ActuatorSnapshot actuator;
  float thermocoupleC;
  float coldJunctionC;
  uint32_t calibrationStepIndex;
  uint32_t calibrationStepCount;
  uint32_t calibrationLogId;
  uint32_t calibrationStepElapsedSec;
  uint32_t manualSinceMs;
  uint32_t thermalLogCount;
  uint32_t thermalLogId;
  ThermalLogSource thermalLogSource;
  bool thermalLogActive;
  bool manualConflictLatched;
  uint8_t calibrationCurrentFanDeci;
  uint8_t calibrationCurrentHeatDeci;
  uint8_t calibrationCompletedStepCount;
  LiveCalibrationSettleState calibrationSettleState;
  LiveCalibrationEndReason calibrationEndReason;
  LiveCalibrationCompletedStep
      calibrationCompletedSteps[kCalibrationCompletedEventCount];
  bool calibrationActive;
  bool manualActive;
  // The roast essentials, so a live client can render the run without polling
  // the full status document. Everything here is a plain scalar copied under
  // the same mux; the WebSocket task never reaches into program state.
  uint32_t roastElapsedSec;
  uint32_t bootId;
  uint32_t streamSeq;
  uint32_t roastSessionId;
  uint32_t roastPlanRevision;
  uint32_t roastStartedEpoch;
  char roastName[kRoastNameBytes + 1];
  uint64_t stateRevision;
  uint32_t lastCommandId;
  uint16_t lastCommandStatus;
  uint32_t roastZoneIndex;
  uint32_t roastZoneCount;
  float roastTargetC;
  float roastAmbientC;
  float roastBatchMassG;
  bool roastActive;
  bool roastJourney;
  bool roastSaturated;
  bool roastHoldover;
  RoastMode roastMode;
  // Per-tick Journey executor progress. Browsers defer the full status
  // document for as long as anything actuates, so this compact snapshot is the
  // ONLY status transport during a roast: everything the cockpit renders per
  // tick - the zone tuple (entry, nominal duration, endpoint), the live
  // correction, the solver's own levels, the holdover clock, per-zone
  // attainment offsets, and how the roast ended - must ride here, published
  // atomically with the zone index so the tuple can never mix two zones.
  uint32_t roastZoneEntrySec;
  uint32_t roastZoneNominalSec;
  float roastZoneEndC;
  float roastCorrectionTotal;
  float roastIntegral;
  float roastSolvedFan;
  float roastSolvedHeat;
  uint32_t roastHoldoverMs;
  uint16_t roastZoneAttainedSec[sr800::kMaxJourneyZones];
  char roastEndReason[24];

  // Full-status fields are copied into the same immutable publication. Native
  // network tasks never read controller globals or LittleFS directly.
  bool sensorConfigured;
  bool temperatureValid;
  float thermocoupleOffsetC;
  uint8_t sensorFaultStatus;
  uint32_t sensorSampleAgeMs;
  bool calibrationReady;
  uint32_t calibrationStableForMs;
  char calibrationReadiness[24];
  uint32_t calibrationMaxStepSeconds;
  uint32_t calibrationMinStepSeconds;
  uint32_t calibrationSettleSeconds;
  float calibrationSettleBandC;
  uint32_t calibrationStartedEpoch;
  uint32_t calibrationCompletedEpoch;
  bool thermalLogUnsaved;
  bool recordingAvailable;
  uint32_t thermalLogIntervalMs;
  uint32_t manualFanMilli;
  uint32_t manualHeatMilli;
  uint32_t manualInstructionAgeMs;
  char manualEndReason[24];
  bool logArchiveMounted;
  bool logArchiveNeedsFormat;
  uint32_t logArchiveCount;
  uint32_t logArchiveLostLogs;
  bool dataStoreMounted;
  uint32_t dataStoreUsedBytes;
  uint32_t dataStoreRunCount;
  uint32_t dataStoreRunBytes;
  uint32_t storageTotalBytes;
  bool appliedCalibrationPresent;
  float heaterGain;
  float fanCooling;
  float coolingFan;
  float lossPerMin;
  char calibrationFitId[48];
  uint32_t calibrationAppliedEpoch;
  bool restoreActive;
  bool restoreIncomplete;
  uint32_t restoreExpiresInMs;
  bool clockSynced;
  bool stationConnected;
  int32_t stationRssiDbm;
  uint32_t wifiDisconnectCount;
  uint32_t wifiPollReconnectAttemptCount;
  uint32_t wifiGotIpCount;
  uint32_t wifiLastDisconnectMs;
  uint32_t wifiLastGotIpMs;
  uint8_t wifiLastDisconnectReason;
  bool actuationWifiAwake;
  bool wifiSleepEnabled;
  uint32_t appUsedBytes;
  uint32_t appSlotBytes;
  esp_reset_reason_t resetReason;
  uint8_t bootHistoryCount;
  BootHistoryEntry bootHistory[kBootHistoryCapacity];
  uint32_t uptimeMs;
  uint32_t freeHeapBytes;
  uint32_t minimumFreeHeapBytes;
  uint32_t largestFreeHeapBlockBytes;
  uint32_t freePsramBytes;
  uint32_t minimumFreePsramBytes;
  uint32_t largestFreePsramBlockBytes;
  uint32_t lastLoopGapMs;
  uint32_t maximumLoopGapMs;
  uint32_t lastArchivePersistMs;
  uint32_t maximumArchivePersistMs;
  uint32_t archivePersistCount;
};
portMUX_TYPE liveStatusMux = portMUX_INITIALIZER_UNLOCKED;
LiveStatusSnapshot liveStatusSnapshot = {};
uint32_t liveStatusLastPublishMs = 0;
uint32_t cachedAppUsedBytes = 0;
uint32_t lastNetworkCommandId = 0;
uint32_t cachedAppSlotBytes = 0;
uint16_t lastNetworkCommandStatus = 0;

temperature_sensor_handle_t chipTemperatureSensor = nullptr;
bool signalInterruptsAttached = false;
bool stationConfigured = false;
bool mdnsStarted = false;
bool apActive = false;
bool actuationWifiAwake = false;
String stationSsid;
uint32_t lastReconnectAttemptMs = 0;
uint32_t lastApStartAttemptMs = 0;
uint32_t stationConnectedSinceMs = 0;
uint32_t stationDisconnectedSinceMs = 0;
portMUX_TYPE wifiEventMux = portMUX_INITIALIZER_UNLOCKED;
uint32_t wifiDisconnectCount = 0;
uint32_t wifiPollReconnectAttemptCount = 0;
uint32_t wifiGotIpCount = 0;
uint32_t wifiLastDisconnectMs = 0;
uint32_t wifiLastGotIpMs = 0;
uint8_t wifiLastDisconnectReason = 0;
uint32_t bootCount = 0;
BootHistoryEntry bootHistory[kBootHistoryCapacity] = {};
uint8_t bootHistoryCount = 0;
esp_reset_reason_t bootResetReason = ESP_RST_UNKNOWN;

volatile bool updateStarted = false;
volatile bool updateFinished = false;
volatile bool otaHandleActive = false;
esp_ota_handle_t otaHandle = 0;
const esp_partition_t* otaTargetPartition = nullptr;
esp_err_t otaError = ESP_OK;
size_t otaBytesWritten = 0;
// Written by the OTA handler task only while admission is GRANTED and read by loopTask only
// while admission is IDLE — temporally exclusive, but volatile keeps the cross-task intent
// explicit and the worst stale read is one redundant idempotent revalidation call.
volatile bool otaImageValidated = false;
volatile bool otaBootPartitionSelected = false;
volatile bool otaRestartPending = false;
uint32_t otaRestartRequestedMs = 0;
portMUX_TYPE otaStateMux = portMUX_INITIALIZER_UNLOCKED;
enum class OtaAdmissionState : uint8_t {
  IDLE = 0, REQUESTED, GRANTING, GRANTED, DENIED, RELEASE_REQUESTED, COMMITTED,
};
volatile OtaAdmissionState otaAdmissionState = OtaAdmissionState::IDLE;
bool otaHealthResponseServed = false;

struct OtaAttemptDiagnostics {
  bool attempted = false;
  uint32_t declaredBytes = 0;
  uint32_t receivedBytes = 0;
  uint32_t targetOffset = 0;
  esp_err_t error = ESP_OK;
  bool readbackComplete = false;
  bool readbackMatched = false;
  char receivedSha256[65] = {};
  char flashSha256[65] = {};
};

OtaAttemptDiagnostics otaLastAttempt;

OtaAttemptDiagnostics copyOtaAttemptDiagnostics() {
  portENTER_CRITICAL(&otaStateMux);
  const OtaAttemptDiagnostics snapshot = otaLastAttempt;
  portEXIT_CRITICAL(&otaStateMux);
  return snapshot;
}

void publishOtaAttemptDiagnostics(const OtaAttemptDiagnostics& diagnostics) {
  portENTER_CRITICAL(&otaStateMux);
  otaLastAttempt = diagnostics;
  portEXIT_CRITICAL(&otaStateMux);
}

void markOtaHealthResponseServed() {
  portENTER_CRITICAL(&otaStateMux);
  otaHealthResponseServed = true;
  portEXIT_CRITICAL(&otaStateMux);
}

bool copyOtaHealthResponseServed() {
  portENTER_CRITICAL(&otaStateMux);
  const bool served = otaHealthResponseServed;
  portEXIT_CRITICAL(&otaStateMux);
  return served;
}

bool max31856Configured = false;
float maxThermocoupleRawC = NAN;
float maxThermocoupleC = NAN;
float maxColdJunctionC = NAN;
uint8_t maxFaultStatus = 0xFF;
uint32_t maxLastSampleMs = 0;

bool thermocoupleFreshValid(uint32_t nowMs, uint32_t maximumAgeMs) {
  return max31856Configured && maxFaultStatus == 0 &&
      !isnan(maxThermocoupleC) && maxLastSampleMs != 0 &&
      nowMs - maxLastSampleMs < maximumAgeMs;
}

bool heatStartTemperatureHealthy(uint32_t nowMs,
                                 uint32_t maximumAgeMs = 1000U) {
  return thermocoupleFreshValid(nowMs, maximumAgeMs) &&
      maxThermocoupleC < kOvertempDisableC;
}

struct Max31856FaultReason {
  uint8_t mask;
  const char* name;
};

constexpr Max31856FaultReason kMax31856FaultReasons[] = {
    {0x80U, "cold_junction_range"},
    {0x40U, "thermocouple_range"},
    {0x20U, "cold_junction_high"},
    {0x10U, "cold_junction_low"},
    {0x08U, "thermocouple_high"},
    {0x04U, "thermocouple_low"},
    {0x02U, "over_under_voltage"},
    {0x01U, "open_circuit"},
};

void formatMax31856FaultReasonsJson(uint8_t status, bool configured,
                                    char* buffer, size_t capacity) {
  if (buffer == nullptr || capacity < 3) return;
  size_t used = 0;
  buffer[used++] = '[';
  if (!configured) {
    const int length = snprintf(buffer + used, capacity - used, "\"not_configured\"");
    if (length > 0 && static_cast<size_t>(length) < capacity - used) used += static_cast<size_t>(length);
  } else {
    bool first = true;
    for (const Max31856FaultReason& reason : kMax31856FaultReasons) {
      if ((status & reason.mask) == 0) continue;
      const int length = snprintf(buffer + used, capacity - used,
                                  "%s\"%s\"", first ? "" : ",", reason.name);
      if (length <= 0 || static_cast<size_t>(length) >= capacity - used) break;
      used += static_cast<size_t>(length);
      first = false;
    }
  }
  if (used + 2 > capacity) used = 0;
  buffer[used++] = ']';
  buffer[used] = 0;
}
uint32_t maxLastConfigureAttemptMs = 0;
sr800::runtime::SustainedCondition overtemperatureCondition;
sr800::SensorFaultQualifier maxSensorFaultQualifier;
sr800::CalibrationReadiness calibrationReadiness;

void recordCalibrationCompletedStep(uint32_t nowUs, const char* outcome) {
  if (calibrationCompletedEventUsed >= kCalibrationCompletedEventCount) {
    memmove(calibrationCompletedEvents, calibrationCompletedEvents + 1,
            (kCalibrationCompletedEventCount - 1) *
                sizeof(CalibrationCompletedEvent));
    calibrationCompletedEventUsed = kCalibrationCompletedEventCount - 1;
  }
  CalibrationCompletedEvent& event =
      calibrationCompletedEvents[calibrationCompletedEventUsed++];
  event.index = static_cast<uint8_t>(calibrationStepIndex);
  const uint32_t elapsed = (nowUs - calibrationStepStartedUs) / 1000000U;
  event.elapsedSec = static_cast<uint16_t>(elapsed > UINT16_MAX ? UINT16_MAX : elapsed);
  const uint32_t fanDeci =
      (calibrationStepFanMilli[calibrationStepIndex] + 50U) / 100U;
  const uint32_t heatDeci =
      (calibrationHeatMilli[calibrationStepIndex] + 50U) / 100U;
  event.fanDeci = static_cast<uint8_t>(fanDeci > 100U ? 100U : fanDeci);
  event.heatDeci = static_cast<uint8_t>(heatDeci > 100U ? 100U : heatDeci);
  const uint32_t nowMs = millis();
  const bool temperatureValid = thermocoupleFreshValid(nowMs, 1000U);
  event.temperatureC = temperatureValid ? maxThermocoupleC : NAN;
  event.outcome = outcome;
}


uint8_t IRAM_ATTR readAllLevels() {
  uint8_t levels = 0;
  for (size_t index = 0; index < kChannelCount; ++index) {
    levels |= static_cast<uint8_t>(gpio_get_level(kPins[index]) << index);
  }
  return levels;
}

void ARDUINO_ISR_ATTR onAnyEdge() {
  const uint32_t nowUs = micros();
  const uint8_t levels = readAllLevels();

  portENTER_CRITICAL_ISR(&captureMux);
  const uint8_t changed = static_cast<uint8_t>((levels ^ lastLevels) & 0x0F);
  if (changed == 0) {
    portEXIT_CRITICAL_ISR(&captureMux);
    return;
  }

  seenHighMask |= levels;
  seenLowMask |= static_cast<uint8_t>((~levels) & 0x0F);

  for (size_t index = 0; index < kChannelCount; ++index) {
    const uint8_t mask = static_cast<uint8_t>(1U << index);
    if ((changed & mask) == 0) continue;

    const uint32_t durationUs = nowUs - lastEdgeUs[index];
    const bool wasHigh = (lastLevels & mask) != 0;
    if (wasHigh) {
      fallCount[index] = fallCount[index] + 1;
      lastHighUs[index] = durationUs;
      if (durationUs < minHighUs[index]) minHighUs[index] = durationUs;
      if (durationUs > maxHighUs[index]) maxHighUs[index] = durationUs;
    } else {
      riseCount[index] = riseCount[index] + 1;
      lastLowUs[index] = durationUs;
      if (durationUs < minLowUs[index]) minLowUs[index] = durationUs;
      if (durationUs > maxLowUs[index]) maxLowUs[index] = durationUs;
    }
    lastEdgeUs[index] = nowUs;
  }

  if (captureEnabled) {
    const uint32_t sequence = eventCount + 1;
    const size_t bufferIndex = sequence - 1;
    eventBuffer[bufferIndex].atUs = nowUs;
    eventBuffer[bufferIndex].precedingGapUs = nowUs - lastEventUs;
    eventBuffer[bufferIndex].changedMask = changed;
    eventBuffer[bufferIndex].levels = levels;
    eventBuffer[bufferIndex].sequence = sequence;
    lastEventUs = nowUs;
    eventCount = sequence;

    if (sequence >= kEventCapacity) {
      captureEnabled = false;
      captureComplete = true;
      captureStopReason = kStopEventLimit;
    }
  }

  lastLevels = levels;
  portEXIT_CRITICAL_ISR(&captureMux);
}

void ARDUINO_ISR_ATTR onChannel2Edge() {
  onAnyEdge();

  const uint32_t nowUs = micros();
  bool shouldLatchConflict = false;
  portENTER_CRITICAL_ISR(&captureMux);
  if (factoryFanLastRiseUs == 0 ||
      nowUs - factoryFanLastRiseUs > kFactoryFanMaximumGapUs) {
    factoryFanWindowStartUs = nowUs;
    factoryFanPulseCount = 1;
  } else {
    factoryFanPulseCount = factoryFanPulseCount + 1;
  }
  factoryFanLastRiseUs = nowUs;

  if (!manualConflictLatched &&
      factoryFanPulseCount >= 2 &&
      nowUs - factoryFanWindowStartUs >= kFactoryFanDetectionSpanUs) {
    manualConflictLatched = true;
    fanTestActive = false;
    shouldLatchConflict = true;
  }
  portEXIT_CRITICAL_ISR(&captureMux);

  if (shouldLatchConflict) {
    heaterProofPhase = HeaterProofPhase::IDLE;
    actuator.latchManualConflict();
  }
}

void ARDUINO_ISR_ATTR onMcpwmZeroCross(void*, uint32_t nowUs) {
  actuator.onZeroCross(nowUs);
  onAnyEdge();
}

void ARDUINO_ISR_ATTR onMcpwmZeroCrossDiscontinuity(
    void*, uint32_t nowUs) {
  actuator.onZeroCrossDiscontinuity(nowUs);
}

const char* zeroCrossRejectReasonName(uint8_t reason) {
  switch (static_cast<sr800::ZeroCrossRejectReason>(reason)) {
    case sr800::ZeroCrossRejectReason::NONE: return "none";
    case sr800::ZeroCrossRejectReason::TOO_LONG: return "too_long";
    default: return "unknown";
  }
}

bool enterActuationWifiAwakeMode() {
  if (actuationWifiAwake) return true;
  if (WiFi.getSleep() != WIFI_PS_NONE) {
    if (!WiFi.setSleep(false)) return false;
    // Outputs are still off. Let the radio complete the power-state change
    // before the first zero-cross-synchronized pulse is requested.
    delay(50);
  }
  actuationWifiAwake = true;
  return true;
}

bool waitForActuationStartTiming(const char*& rejection) {
  const uint32_t startedMs = millis();
  do {
    const sr800::PhaseSchedulerSnapshot schedulerState =
        phaseScheduler.snapshot();
    if (!schedulerState.initialized || schedulerState.faulted) {
      rejection = "The zero-cross timing scheduler is unavailable.";
      return false;
    }
    const sr800::ActuatorSnapshot actuatorState =
        actuator.snapshot(micros());
    if (schedulerState.zeroCrossQualified &&
        actuatorState.zeroCrossAvailable &&
        actuatorState.lastZeroCrossAgeUs <= kZeroCrossTimeoutUs) {
      return true;
    }
    // Outputs are still low. Yield to the runtime while the ISR observes the
    // required consecutive mains edges; this is normally about 50 ms.
    delay(1);
  } while (millis() - startedMs < kActuationStartTimingWaitMs);

  rejection =
      "Stable zero-cross timing did not return after storage preparation.";
  return false;
}

void exitActuationWifiAwakeMode() {
  // This mains-powered controller keeps the station radio awake even while
  // outputs are idle. Idle power-save has caused an otherwise healthy
  // association to become unreachable until a power cycle.
  actuationWifiAwake = false;
}

/*
 * The post-stop cooling tail. Requirement: a roast-ending Stop runs Fan 10 /
 * Heat 0 for 10 seconds, and that tail never blocks manual controls.
 *
 * A Stop that interrupts an ACTIVE ROAST leaves a stationary bean mass against
 * a still-hot element and plate; an instantly-dead fan lets residual heat
 * scorch the beans. So the roast EXECUTOR follows such a Stop with Fan 10 /
 * Heat 0 for ten seconds, then turns both outputs off. This is an executor-authored instruction like any other: the
 * actuator core's audited "Heat-off creates no cooling debt, timer, or forced
 * fan" contract is untouched. The tail never blocks anything — any newly
 * accepted instruction (a manual set, a new start, a second Stop) preempts it
 * immediately, and the roast's recording closure and end_reason are unaffected
 * by it: the tail is post-record, like the machine's own cooling.
 */
constexpr uint32_t kPostStopCoolingTailMs = 10000;
constexpr uint32_t kPostStopCoolingFanMilli = 10000;
bool postStopCoolingActive = false;
uint32_t postStopCoolingEndMs = 0;

// A newly accepted instruction owns the actuator from here on; the tail only
// stands down its deadline and never touches the successor's outputs.
void releasePostStopCoolingTail() {
  postStopCoolingActive = false;
  postStopCoolingEndMs = 0;
}

// A new program start must find idle outputs, so the tail is ended — not
// waited out — before the start's own gates run.
void preemptPostStopCoolingTail(uint32_t nowUs) {
  if (!postStopCoolingActive) return;
  releasePostStopCoolingTail();
  actuator.stop(nowUs);
}

// Fan-only, so no thermal gate and no lease is involved; a rejection simply
// leaves the outputs off exactly as every stop did before the tail existed.
void beginPostStopCoolingTail(uint32_t nowUs) {
  (void)nowUs;  // the actuator gets a fresh micros(), see serviceDiagnosticTests
  const char* rejection = nullptr;
  if (actuator.request(kPostStopCoolingFanMilli, 0, micros(), rejection)) {
    postStopCoolingActive = true;
    postStopCoolingEndMs = millis() + kPostStopCoolingTailMs;
  }
}

bool stopDiagnosticTest() {
  portENTER_CRITICAL(&captureMux);
  fanTestActive = false;
  portEXIT_CRITICAL(&captureMux);
  if (calibrationActive) {
    calibrationActive = false;
    calibrationEndReason = "stopped";
  }
  if (manualActive) {
    manualActive = false;
    manualEndReason = "stopped";
  }
  heaterProofPhase = HeaterProofPhase::IDLE;
  const bool roastWasActive = roastActive;
  if (roastActive) finishRoast(micros(), "stopped");
  actuator.stop(micros());
  // Stop means all outputs off, including an overtemperature cooldown.
  actuator.cancelOvertempCooldown(micros());
  // A repeated Stop during a cooling tail means genuinely off, now.
  releasePostStopCoolingTail();
  // Only a Stop that interrupted an active roast earns the cooling tail;
  // stopping a test, a calibration, or an idle machine turns outputs off as
  // it always has.
  if (roastWasActive) beginPostStopCoolingTail(micros());
  return finalizeEndedRoastRecordingForStop();
}

constexpr char kStorageBusyStartRejection[] =
    "Controller storage is busy; retry the start when the current transfer finishes.";

bool isStorageBusyStartRejection(const char* rejection) {
  return rejection != nullptr &&
         strcmp(rejection, kStorageBusyStartRejection) == 0;
}

void sendActuationStartRejection(const char* rejection,
                                 const char* fallback) {
  const bool storageBusy = isStorageBusyStartRejection(rejection);
  if (nativeCommandResponse != nullptr) {
    nativeCommandResponse->retryStorageBusy = storageBusy;
  }
  String response = F("{\"ok\":false");
  if (storageBusy) response += F(",\"code\":\"storage_busy\"");
  response += F(",\"message\":\"");
  response += rejection == nullptr ? fallback : rejection;
  response += F("\"}");
  sendRequestResponse(storageBusy ? 503 : 409, "application/json", response);
}

bool startFanTest(uint32_t durationMs, uint32_t levelMilli,
                  const char*& rejection) {
  // A newly accepted start preempts the post-stop cooling tail immediately.
  preemptPostStopCoolingTail(micros());
  if (heaterProofPhase != HeaterProofPhase::IDLE || roastActive ||
      actuator.outputsActive()) {
    rejection = "Another actuator operation is active.";
    return false;
  }
  StorageMutationGuard storage(true, true);
  if (!storage) {
    rejection = kStorageBusyStartRejection;
    return false;
  }
  // A fan test mid-decay would destroy the passive tail the loss fit needs

  // while recording into a log labeled with the PREVIOUS run's source. Close
  // and persist that log first, exactly as the proof and calibration paths do.

  if (!takeOverPriorRecordingForNewEpisode(rejection)) {
    return false;
  }
  if (!enterActuationWifiAwakeMode()) {
    rejection = "Wi-Fi awake mode could not be enabled.";
    return false;
  }
  if (!waitForActuationStartTiming(rejection)) {
    exitActuationWifiAwakeMode();
    return false;
  }
  const uint32_t nowUs = micros();
  phaseScheduler.beginTimingLog();
  if (!actuator.request(levelMilli, 0, micros(), rejection)) {
    phaseScheduler.endTimingLog();
    exitActuationWifiAwakeMode();
    return false;
  }

  const sr800::PhaseSchedulerSnapshot schedulerState =
      phaseScheduler.snapshot();
  portENTER_CRITICAL(&captureMux);
  fanTestEndUs = nowUs + durationMs * 1000U;
  fanTestLevelMilli = levelMilli;
  fanTestStartPulseCount = schedulerState.fanPulsesEmitted;
  fanTestActive = true;
  portEXIT_CRITICAL(&captureMux);
  return true;
}

bool startHeaterProof(uint32_t durationMs, uint32_t fanLevelMilli,
                       uint32_t heatLevelMilli, const char*& rejection) {
  if (thermalLog == nullptr) {
    rejection = "External recording memory is unavailable.";
    return false;
  }
  // A newly accepted start preempts the post-stop cooling tail immediately.
  preemptPostStopCoolingTail(micros());
  if (fanTestActive || heaterProofPhase != HeaterProofPhase::IDLE ||
      roastActive || actuator.outputsActive()) {
    rejection = "Another actuator operation is active.";
    return false;
  }

  StorageMutationGuard storage(true, true);
  if (!storage) {
    rejection = kStorageBusyStartRejection;
    return false;
  }
  if (!takeOverPriorRecordingForNewEpisode(rejection)) {
    return false;
  }
  startThermalLog(ThermalLogSource::PROOF);
  if (!enterActuationWifiAwakeMode()) {
    rejection = "Wi-Fi awake mode could not be enabled.";
    rollbackThermalLogStart();
    return false;
  }
  if (!waitForActuationStartTiming(rejection)) {
    rollbackThermalLogStart();
    exitActuationWifiAwakeMode();
    return false;
  }
  const uint32_t nowUs = micros();
  phaseScheduler.beginTimingLog();
  if (!actuator.request(fanLevelMilli, heatLevelMilli, micros(), rejection,
                        durationMs * 1000U)) {
    phaseScheduler.endTimingLog();
    rollbackThermalLogStart();
    exitActuationWifiAwakeMode();
    return false;
  }
  const sr800::PhaseSchedulerSnapshot schedulerState = phaseScheduler.snapshot();
  heaterProofDurationMs = durationMs;
  heaterProofFanLevelMilli = fanLevelMilli;
  heaterProofHeatLevelMilli = heatLevelMilli;
  heaterProofDeadlineUs = 0;
  heaterProofStartPulseCount = schedulerState.heaterPulsesEmitted;
  heaterProofQualificationStartedUs = nowUs;
  heaterProofPhase = HeaterProofPhase::FAN_QUALIFICATION;
  return true;
}

bool startCalibration(const uint32_t* fanMilli, const uint32_t* heatMilli,
                      size_t stepCount, uint32_t maximumStepSeconds,
                      uint32_t minDwellSeconds, uint8_t settleSeconds,
                      float settleBandC, const char*& rejection) {
  if (thermalLog == nullptr) {
    rejection = "External recording memory is unavailable.";
    return false;
  }
  // A newly accepted start preempts the post-stop cooling tail immediately.
  preemptPostStopCoolingTail(micros());
  if (fanTestActive || heaterProofPhase != HeaterProofPhase::IDLE ||
      calibrationActive || roastActive ||
      actuator.outputsActive()) {
    rejection = "Another actuator operation is active.";
    return false;
  }

  StorageMutationGuard storage(true, true);
  if (!storage) {
    rejection = kStorageBusyStartRejection;
    return false;
  }
  // Persist the PREVIOUS episode while its own captured plan is still intact.

  // Replacing calibrationArchivePlan before this point would relabel an unsaved
  // prior calibration with the program about to start.
  if (!takeOverPriorRecordingForNewEpisode(rejection)) {
    return false;
  }
  if (!captureCalibrationArchivePlan(
          fanMilli, heatMilli, stepCount, maximumStepSeconds,
          minDwellSeconds, settleSeconds, settleBandC)) {
    rejection = "The calibration program could not be encoded into recording provenance.";
    return false;
  }
  startThermalLog(ThermalLogSource::CALIBRATION);
  calibrationStableLogId = thermalLogReservedId;
  if (!enterActuationWifiAwakeMode()) {
    rejection = "Wi-Fi awake mode could not be enabled.";
    rollbackThermalLogStart();
    calibrationStableLogId = 0;
    return false;
  }
  if (!waitForActuationStartTiming(rejection)) {
    rollbackThermalLogStart();
    calibrationStableLogId = 0;
    exitActuationWifiAwakeMode();
    return false;
  }
  const uint32_t nowUs = micros();
  if (!actuator.request(fanMilli[0], heatMilli[0], micros(), rejection,
                        heatMilli[0] > 0 ? kHeaterProofMaximumMs * 1000U
                                         : 0)) {
    rollbackThermalLogStart();
    calibrationStableLogId = 0;
    exitActuationWifiAwakeMode();
    return false;
  }
  for (size_t index = 0; index < kCalibrationMaxSteps; ++index) {
    calibrationStepFanMilli[index] = index < stepCount ? fanMilli[index] : 0;
    calibrationHeatMilli[index] = index < stepCount ? heatMilli[index] : 0;
  }
  calibrationStepCount = stepCount;
  calibrationStepIndex = 0;
  calibrationStepRequestPending = false;
  calibrationStepMs = maximumStepSeconds * 1000U;
  calibrationMinDwellMs =
      (minDwellSeconds > maximumStepSeconds ? maximumStepSeconds
                                            : minDwellSeconds) * 1000U;
  calibrationSettleSeconds = settleSeconds;
  calibrationSettleBandC = settleBandC;
  calibrationHeatObserved = false;
  calibrationStepStartedUs = nowUs;
  calibrationStepDeadlineArmed = heatMilli[0] == 0;
  calibrationStepEndUs = calibrationStepDeadlineArmed
      ? nowUs + calibrationStepMs * 1000U : 0;
  calibrationLastRenewUs = nowUs;
  calibrationRenewals = 0;
  calibrationEndReason = "none";
  calibrationLastAdvance = "none";
  calibrationCompletedEventUsed = 0;
  calibrationStartedEpoch = 0;
  calibrationCompletedEpoch = 0;
  resetCalibrationSettle();
  calibrationActive = true;
  const time_t calibrationNow = time(nullptr);
  calibrationStartedEpoch = calibrationNow > 1600000000
      ? static_cast<uint32_t>(calibrationNow) : 0;
  return true;
}

// Transient actuator refusals. The audited actuator core refuses a request while
// the last zero-cross is more than 100 ms old, even though it deliberately rides
// a 250 ms recovery grace before latching ZERO_CROSS_LOST; and it refuses Heat
// while thermal status is UNKNOWN, which one invalid MAX31856 sample sets for
// 250 ms, well before the 3-sample/750 ms sensor-fault qualifier. Neither is a
// fault. A renewal or step boundary that lands on one keeps the previous
// command and retries on a later loop pass instead of ending the program. The
// retry window is bounded, so a persisting problem still ends it; any latched
// actuator fault is never treated as transient; and the 30 s ISR heat lease and
// the 1 s thermal-stale trip remain the independent backstops.
// Both strings are the core's own rejection texts (sr800_actuator.cpp).
constexpr char kZeroCrossWaitRejection[] = "Zero-cross timing is unavailable.";
constexpr char kThermalTelemetryRejection[] =
    "Fresh fault-free thermocouple telemetry is required.";
constexpr uint32_t kTransientRejectionRetryMs = 2000;

struct TransientRejectionRetry {
  bool pending = false;
  uint32_t sinceMs = 0;
  uint32_t lastMs = 0;
};
TransientRejectionRetry roastRejectionRetry;
TransientRejectionRetry calibrationRejectionRetry;
TransientRejectionRetry manualRejectionRetry;

bool transientActuatorRejection(const char* rejection) {
  if (rejection == nullptr) return false;
  const sr800::ActuatorSnapshot current = actuator.snapshot(micros());
  if (current.fault != sr800::ActuatorFault::NONE) return false;
  if (strcmp(rejection, kZeroCrossWaitRejection) == 0) return true;
  return strcmp(rejection, kThermalTelemetryRejection) == 0 &&
      current.thermalSafetyStatus == sr800::ThermalSafetyStatus::UNKNOWN;
}

// True: skip this pass, keep the previous command, and retry. False: the
// refusal is real (or has persisted past the window) and the program ends.
bool retryTransientRejection(TransientRejectionRetry& retry,
                             const char* rejection) {
  const uint32_t nowMs = millis();
  if (!transientActuatorRejection(rejection)) {
    retry.pending = false;
    return false;
  }
  // A window left over from an unrelated earlier episode never carries over.
  if (!retry.pending || nowMs - retry.lastMs > kTransientRejectionRetryMs) {
    retry.pending = true;
    retry.sinceMs = nowMs;
  }
  retry.lastMs = nowMs;
  if (nowMs - retry.sinceMs < kTransientRejectionRetryMs) return true;
  retry.pending = false;
  return false;
}

void clearTransientRejection(TransientRejectionRetry& retry) {
  retry.pending = false;
}

// The program is over. Outputs stop immediately. The recording layer may keep
// capturing its passive fan-off decay tail independently of actuation.
bool finishRoast(uint32_t nowUs, const char* endReason) {
  markRoastEnded(endReason);
  actuator.stop(nowUs);
  roastCommandHeatMilli = 0;
  roastCommandFanMilli = 0;
  roastCommandHeat = 0.0;
  roastCommandFan = 0.0;
  return finalizeEndedRoastRecordingForStop();
}

bool finalizeEndedRoastRecordingForStop() {
  portENTER_CRITICAL(&thermalLogMux);
  if (!thermalLogUnsaved) {
    portEXIT_CRITICAL(&thermalLogMux);
    return true;
  }
  // Shared Stop can also end a proof or calibration. Those captures retain
  // their passive tail and have not been saved yet, so never acknowledge them
  // as durable merely because this roast-specific finalizer has no work to do.
  if (thermalLogSource != ThermalLogSource::ROAST) {
    portEXIT_CRITICAL(&thermalLogMux);
    return false;
  }
  // Timed and journey programs intentionally keep their passive-decay tail;
  // the Stop acknowledgement must describe that archive as pending.
  if (roastMode != RoastMode::MANUAL) {
    portEXIT_CRITICAL(&thermalLogMux);
    return false;
  }
  // Stop is the complete capture boundary for an operator-steered roast. Close
  // it immediately; the controller archive service performs the flash commit
  // after this timing-sensitive command returns. Until that succeeds, Stop
  // reports the recording as pending and the next-episode gate preserves the
  // RAM recording instead of discarding it.
  thermalLogPassiveTailComplete = true;
  thermalLogActive = false;
  portEXIT_CRITICAL(&thermalLogMux);
  // Durability is acknowledged only after the storage worker commits it.
  return false;
}

// TIMED: explicit steps on exact durations. A Heat step's clock does not start
// until Heat is actually effective, so a step is the dwell that was asked for
// rather than the dwell minus Fan qualification - the same rule calibration
// uses, and the reason a stalled qualification is caught rather than waited out.
void serviceTimedRoast(uint32_t nowUs, const sr800::ActuatorSnapshot& state) {
  roastElapsedSec = (millis() - roastStartedMs) / 1000U;
  const uint32_t stepFan = roastStepFanMilli[roastStepIndex];
  const uint32_t stepHeat = roastStepHeatMilli[roastStepIndex];

  if (stepHeat > 0 && state.effectiveHeatMilli > 0 && !roastHeatObserved) {
    roastHeatObserved = true;
    roastStepEndUs = nowUs + roastStepDwellRemainingSec * 1000000U;
    roastStepDeadlineArmed = true;
  }
  if (stepHeat > 0 && !roastHeatObserved &&
      nowUs - roastStepStartedUs > kCalibrationQualifyStallUs) {
    finishRoast(nowUs, "qualification_stalled");
    return;
  }

  const bool stepDone = roastStepDeadlineArmed &&
      static_cast<int32_t>(nowUs - roastStepEndUs) >= 0;
  if (stepDone) {
    const size_t nextIndex = roastStepIndex + 1;
    if (nextIndex >= roastStepCount) {
      roastStepIndex = nextIndex;
      roastHeatObserved = false;
      roastStepDeadlineArmed = false;
      finishRoast(nowUs, "completed");
      return;
    }
    const uint32_t nextFan = roastStepFanMilli[nextIndex];
    const uint32_t nextHeat = roastStepHeatMilli[nextIndex];
    const char* rejection = nullptr;
    if (!actuator.request(nextFan, nextHeat, micros(), rejection,
                          nextHeat > 0 ? kHeaterProofMaximumMs * 1000U : 0)) {
      // A transient refusal leaves the step boundary uncommitted: the previous
      // step's command keeps running and the boundary retries next pass.
      if (retryTransientRejection(roastRejectionRetry, rejection)) return;
      roastStepIndex = nextIndex;
      roastHeatObserved = false;
      roastStepDeadlineArmed = false;
      finishRoast(nowUs, "step_rejected");
      return;
    }
    clearTransientRejection(roastRejectionRetry);
    roastStepIndex = nextIndex;
    roastHeatObserved = false;
    roastStepDeadlineArmed = false;
    roastCommandFanMilli = nextFan;
    roastCommandHeatMilli = nextHeat;
    roastCommandFan = nextFan / 1000.0;
    roastCommandHeat = nextHeat / 1000.0;
    roastStepStartedUs = nowUs;
    roastStepDwellRemainingSec = roastStepSeconds[roastStepIndex];
    roastStepDeadlineArmed = nextHeat == 0;
    roastStepEndUs = roastStepDeadlineArmed
        ? nowUs + roastStepDwellRemainingSec * 1000000U : 0;
    roastLastRenewUs = nowUs;
    return;
  }

  if (stepHeat > 0 && state.effectiveHeatMilli > 0 &&
      nowUs - roastLastRenewUs >= kCalibrationRenewIntervalUs) {
    // Renewing the 30 s lease keeps the zero-cross ISR bound as the authority:
    // a dead loop lets Heat expire hands-off within 30 s, browser or no browser.
    const char* rejection = nullptr;
    if (actuator.request(stepFan, stepHeat, micros(), rejection,
                         kHeaterProofMaximumMs * 1000U)) {
      clearTransientRejection(roastRejectionRetry);
      roastRenewals++;
      roastLastRenewUs = nowUs;
    } else if (!retryTransientRejection(roastRejectionRetry, rejection)) {
      finishRoast(nowUs, "renewal_rejected");
    }
  }
}

// MANUAL ROAST: the operator chooses each instruction, but the controller owns
// its lifetime. The same 30-minute whole-instruction deadline used by the
// diagnostic Manual page bounds both Fan-only and Heat-bearing instructions;
// the actuator's shorter Heat lease remains the independent dead-loop backstop.
void serviceManualRoast(uint32_t nowUs,
                        const sr800::ActuatorSnapshot& state) {
  const uint32_t nowMs = millis();
  roastElapsedSec = (nowMs - roastStartedMs) / 1000U;
  if (sr800::runtime::instructionExpired(
          nowMs, roastLastInstructionMs, kManualInstructionLeaseMs)) {
    finishRoast(nowUs, "instruction_expired");
    return;
  }
  if (roastCommandHeatMilli > 0 && state.effectiveHeatMilli > 0 &&
      nowUs - roastLastRenewUs >= kCalibrationRenewIntervalUs) {
    const char* rejection = nullptr;
    if (actuator.request(roastCommandFanMilli, roastCommandHeatMilli, micros(),
                         rejection, kHeaterProofMaximumMs * 1000U)) {
      clearTransientRejection(roastRejectionRetry);
      roastRenewals++;
      roastLastRenewUs = nowUs;
    } else if (!retryTransientRejection(roastRejectionRetry, rejection)) {
      finishRoast(nowUs, "renewal_rejected");
    }
  }
}

// JOURNEY: one control tick per second through the ported law. Everything about
// what to command lives in `sr800_journey_control.cpp` and is pinned by the
// cross-language vectors; everything here is about turning that answer into a
// leased actuator request and knowing when the roast is over.
void serviceJourneyRoast(uint32_t nowUs, const sr800::ActuatorSnapshot& state,
                         bool forceTick = false) {
  const uint32_t nowMs = millis();
  if (!forceTick && nowMs - roastLastTickMs < kRoastControlIntervalMs) return;
  roastLastTickMs = nowMs;

  const double elapsedSec = (nowMs - roastStartedMs) / 1000.0;
  roastElapsedSec = static_cast<uint32_t>(elapsedSec);

  // What counts as a measurement. Anything else is a holdover, not a zero.
  const bool sampleValid = thermocoupleFreshValid(nowMs, kRoastSampleFreshnessMs);

  sr800::JourneyStepInput input;
  input.plan.zones = roastZones;
  input.plan.zoneCount = roastZoneCount;
  input.elapsedSec = elapsedSec;
  input.beanTempC = sampleValid ? static_cast<double>(maxThermocoupleC) : NAN;
  input.ambientC = roastAmbientC;
  input.batchMassG = roastBatchMassG;
  input.calibration = roastCalibration;

  const sr800::JourneyStepResult step =
      sr800::journeyControlStep(roastControlState, input);
  roastControlState = step.state;
  roastTargetC = step.command.goalC;
  roastCorrectionTotal = step.correction.totalRatePerMin;
  roastIntegral = step.correction.integralRatePerMin;
  roastHoldover = step.correction.holdover;
  roastSaturated = step.correction.saturated;
  roastCommandFan = step.command.fan;
  roastCommandHeat = step.command.heat;

  // A zone the anchor has left was attained at this tick. The loop covers an
  // overshoot that cleared several endpoints at once, which the control law
  // explicitly allows.
  if (step.zoneAdvanced) {
    const uint16_t attainedAt = elapsedSec >= kRoastZoneNotAttained
        ? static_cast<uint16_t>(kRoastZoneNotAttained - 1)
        : static_cast<uint16_t>(elapsedSec);
    for (size_t index = 0; index < step.zoneIndex &&
                           index < sr800::kMaxJourneyZones; ++index) {
      if (roastZoneAttainedSec[index] == kRoastZoneNotAttained) {
        roastZoneAttainedSec[index] = attainedAt;
      }
    }
  }

  // A dropout is survivable for a while - the step runs feed-forward against
  // the plan with the integral frozen - and then it is simply a lost probe.
  if (roastHeatContinuity.sensorLost(
          step.correction.holdover, nowMs, kRoastHoldoverLimitMs)) {
    // End the roast immediately rather than leaving an unwatched heater
    // running out its remaining lease.
    finishRoast(nowUs, "sensor_lost");
    return;
  }

  // The journey is done when the FINAL zone is attained. A trailing cooling
  // zone is attained by falling to its endpoint, so this covers it too.
  if (step.zoneIndex + 1 >= roastZoneCount && step.zoneCompleted) {
    if (step.zoneIndex < sr800::kMaxJourneyZones &&
        roastZoneAttainedSec[step.zoneIndex] == kRoastZoneNotAttained) {
      roastZoneAttainedSec[step.zoneIndex] = elapsedSec >= kRoastZoneNotAttained
          ? static_cast<uint16_t>(kRoastZoneNotAttained - 1)
          : static_cast<uint16_t>(elapsedSec);
    }
    finishRoast(nowUs, "completed");
    return;
  }

  const uint32_t heatMilli = roastLevelToMilli(step.command.heat);
  // The control law already folds the heat-on Fan 1.0 rule into its solve;
  // this executor-level lift keeps the invariant unconditional at the request.
  const uint32_t fanMilli =
      heatOnFanFloorMilli(roastLevelToMilli(step.command.fan), heatMilli);
  const char* rejection = nullptr;
  if (actuator.request(fanMilli, heatMilli, micros(), rejection,
                       heatMilli > 0 ? kHeaterProofMaximumMs * 1000U : 0)) {
    clearTransientRejection(roastRejectionRetry);
    const sr800::ActuatorSnapshot accepted = actuator.snapshot(nowUs);
    roastHeatObserved = heatMilli == 0 || accepted.effectiveHeatMilli > 0;
    roastCommandFanMilli = fanMilli;
    roastCommandHeatMilli = heatMilli;
    roastLastRenewUs = nowUs;
    if (heatMilli > 0) roastRenewals++;
  } else if (!step.correction.holdover &&
             !retryTransientRejection(roastRejectionRetry, rejection)) {
    // A zero-cross gap the actuator is still riding through (or a one-sample
    // thermal UNKNOWN) skips this tick and keeps the previous command; the
    // actuator's own grace and fault latch decide whether it is a real loss.
    finishRoast(nowUs, "command_rejected");
    return;
  }
  // Under holdover a rejected Heat request is expected rather than exceptional:
  // the actuator's own thermal gate is refusing Heat for the same reason the
  // step is running blind. The standing lease expires on its own and the
  // holdover budget above decides when the roast is over.

  // Heat that is asked for but never becomes effective is a stalled Fan
  // qualification, not a slow roast. Thermal holdover owns sensor-gated Heat.
  if (roastHeatContinuity.qualificationStalled(
          state.thermalSafetyStatus == sr800::ThermalSafetyStatus::HEALTHY,
          step.correction.holdover, heatMilli > 0,
          state.effectiveHeatMilli > 0, nowMs,
          kCalibrationQualifyStallUs / 1000U)) {
    finishRoast(nowUs, "qualification_stalled");
  }
}

// A calibration step boundary whose actuator request met a transient refusal:
// the completed step is already recorded, and the next step's request retries
// here on later passes while the previous step's command keeps running.
void serviceCalibrationStepRequest(uint32_t nowUs) {
  const uint32_t nextHeat = calibrationHeatMilli[calibrationStepIndex];
  const uint32_t nextFan = calibrationStepFanMilli[calibrationStepIndex];
  const char* rejection = nullptr;
  if (!actuator.request(nextFan, nextHeat, micros(), rejection,
                        nextHeat > 0 ? kHeaterProofMaximumMs * 1000U : 0)) {
    if (retryTransientRejection(calibrationRejectionRetry, rejection)) {
      calibrationStepRequestPending = true;
      return;
    }
    calibrationStepRequestPending = false;
    calibrationActive = false;
    calibrationEndReason = "step_rejected";
    actuator.stop(nowUs);
    return;
  }
  clearTransientRejection(calibrationRejectionRetry);
  calibrationStepRequestPending = false;
  calibrationStepStartedUs = nowUs;
  calibrationStepDeadlineArmed = nextHeat == 0;
  calibrationStepEndUs = calibrationStepDeadlineArmed
      ? nowUs + calibrationStepMs * 1000U : 0;
  calibrationLastRenewUs = nowUs;
}

void serviceDiagnosticTests(uint32_t nowUs) {
  // Fresh micros() at the actuator call: the resumed-ZC ISR stamps its own
  // micros(), and an earlier-captured "now" would wrap the unsigned
  // qualification difference.
  actuator.service(micros());

  bool fanExpired = false;
  portENTER_CRITICAL(&captureMux);
  if (fanTestActive && static_cast<int32_t>(nowUs - fanTestEndUs) >= 0 &&
      gpio_get_level(kFanOutputPin) == 0) {
    fanTestActive = false;
    fanExpired = true;
  }
  portEXIT_CRITICAL(&captureMux);
  if (fanExpired) actuator.stop(nowUs);

  // The post-stop cooling tail retires itself: ten seconds elapsed, or the
  // outputs were already taken away by a fault or a successor instruction.
  if (postStopCoolingActive &&
      (static_cast<int32_t>(millis() - postStopCoolingEndMs) >= 0 ||
       !actuator.outputsActive())) {
    releasePostStopCoolingTail();
    actuator.stop(nowUs);
  }

  sr800::ActuatorSnapshot state = actuator.snapshot(nowUs);
  if (roastActive && roastMode == RoastMode::MANUAL &&
      roastCommandHeatMilli > 0 && state.effectiveHeatMilli > 0) {
    roastHeatObserved = true;
  }
  if (manualActive && manualHeatMilli > 0 &&
      state.effectiveHeatMilli > 0) {
    manualHeatObserved = true;
  }
  const bool thermalStaleFault =
      state.fault == sr800::ActuatorFault::THERMAL_STALE;
  const bool actuationAbortFault =
      thermalStaleFault ||
      state.fault == sr800::ActuatorFault::THERMAL_SENSOR ||
      state.fault == sr800::ActuatorFault::OVERTEMPERATURE ||
      state.fault == sr800::ActuatorFault::ZERO_CROSS_LOST;
  if (state.fault != sr800::ActuatorFault::NONE && !actuationAbortFault) {
    heaterProofPhase = HeaterProofPhase::IDLE;
    if (calibrationActive) {
      calibrationActive = false;
      calibrationEndReason = "fault";
    }
    if (manualActive) {
      manualActive = false;
      manualEndReason = "fault";
    }
    if (roastActive) {
      finishRoast(nowUs, "fault");
    }
    phaseScheduler.endTimingLog();
    exitActuationWifiAwakeMode();
    return;
  }

  // Once requested Heat has been observed effective, a fault-free drop to zero
  // means the ISR lease elapsed before loop renewed it. End the owning workflow
  // explicitly instead of silently continuing with Heat permanently off.
  if (state.fault == sr800::ActuatorFault::NONE) {
    const bool thermalHealthy =
        state.thermalSafetyStatus == sr800::ThermalSafetyStatus::HEALTHY;
    if (calibrationActive &&
        sr800::runtime::heatLeaseExpired(
            thermalHealthy, state.zeroCrossAvailable,
            calibrationHeatMilli[calibrationStepIndex] > 0,
            calibrationHeatObserved, state.requestedHeatMilli > 0,
            state.effectiveHeatMilli > 0)) {
      calibrationActive = false;
      calibrationEndReason = "heat_lease_expired";
      actuator.stop(nowUs);
    }
    if (roastActive && sr800::runtime::heatLeaseExpired(
                           thermalHealthy, state.zeroCrossAvailable,
                           roastCommandHeatMilli > 0, roastHeatObserved,
                           state.requestedHeatMilli > 0,
                           state.effectiveHeatMilli > 0)) {
      finishRoast(nowUs, "heat_lease_expired");
    }
    if (manualActive && sr800::runtime::heatLeaseExpired(
                            thermalHealthy, state.zeroCrossAvailable,
                            manualHeatMilli > 0, manualHeatObserved,
                            state.requestedHeatMilli > 0,
                            state.effectiveHeatMilli > 0)) {
      manualActive = false;
      manualEndReason = "heat_lease_expired";
      actuator.stop(nowUs);
    }
  }

  if (heaterProofPhase == HeaterProofPhase::FAN_QUALIFICATION) {
    if (actuationAbortFault) {
      // The actuator already cut both outputs; without this the phase would
      // stay in qualification and block every idle-gated flash write.
      heaterProofPhase = HeaterProofPhase::IDLE;
    } else if (state.effectiveHeatMilli > 0) {
      heaterProofDeadlineUs = nowUs + heaterProofDurationMs * 1000U;
      heaterProofPhase = HeaterProofPhase::HEATING;
    } else if (static_cast<int32_t>(nowUs - heaterProofQualificationStartedUs) >
               static_cast<int32_t>(kCalibrationQualifyStallUs)) {
      // The same qualification stall bound the calibration and timed paths use.
      actuator.stop(nowUs);
      heaterProofPhase = HeaterProofPhase::IDLE;
    }
  } else if (heaterProofPhase == HeaterProofPhase::HEATING) {
    if (state.effectiveHeatMilli == 0 || actuationAbortFault) {
      heaterProofPhase = HeaterProofPhase::IDLE;
    } else if (static_cast<int32_t>(
                   nowUs - (heaterProofDeadlineUs +
                            kHeatDeadlineLoopGraceUs)) >= 0) {
      // The zero-cross ISR heat deadline is the authority and stops both outputs.
      // This loop stop is only a backstop for an ISR that failed to act; its
      // grace avoids racing the shared deadline.
      actuator.stop(nowUs);
      heaterProofPhase = HeaterProofPhase::IDLE;
    }
  }

  if (calibrationActive) {
    const uint32_t stepHeat = calibrationHeatMilli[calibrationStepIndex];
    const uint32_t stepFan = calibrationStepFanMilli[calibrationStepIndex];
    if (actuationAbortFault) {
      calibrationStepRequestPending = false;
      calibrationActive = false;
      calibrationEndReason = thermalStaleFault ? "telemetry_stale" : "fault";
    } else if (calibrationStepRequestPending) {
      serviceCalibrationStepRequest(nowUs);
    } else {
      if (stepHeat > 0 && state.effectiveHeatMilli > 0 &&
          !calibrationHeatObserved) {
        calibrationHeatObserved = true;
        calibrationStepEndUs = nowUs + calibrationStepMs * 1000U;
        calibrationStepDeadlineArmed = true;
      }
      const bool stepRunning = stepHeat == 0 || calibrationHeatObserved;
      if (stepRunning && !isnan(maxThermocoupleC)) {
        const uint32_t nowMs = millis();
        if (calibrationSettleLastMs == 0 ||
            nowMs - calibrationSettleLastMs >= 1000U) {
          calibrationSettleDetector.observe(maxThermocoupleC);
          calibrationSettleLastMs = nowMs;
        }
      }
      const bool stepTimed = calibrationStepDeadlineArmed &&
          static_cast<int32_t>(nowUs - calibrationStepEndUs) >= 0;
      const uint32_t dwellStartUs =
          stepHeat > 0 && calibrationHeatObserved
              ? calibrationStepEndUs - calibrationStepMs * 1000U
              : calibrationStepStartedUs;
      const bool dwellMet = stepRunning &&
          nowUs - dwellStartUs >= calibrationMinDwellMs * 1000U;
      const bool stepSettled = dwellMet && calibrationStepSettled();
      if (stepHeat > 0 && !calibrationHeatObserved &&
          nowUs - calibrationStepStartedUs > kCalibrationQualifyStallUs) {
        calibrationActive = false;
        calibrationEndReason = "qualification_stalled";
        actuator.stop(nowUs);
      } else if (stepTimed || stepSettled) {
        calibrationLastAdvance = stepSettled ? "settled" : "capped";
        recordCalibrationCompletedStep(nowUs, calibrationLastAdvance);
        calibrationStepIndex++;
        calibrationHeatObserved = false;
        calibrationStepDeadlineArmed = false;
        resetCalibrationSettle();
        if (calibrationStepIndex >= calibrationStepCount) {
          calibrationActive = false;
          calibrationEndReason = "completed";
          const time_t completedNow = time(nullptr);
          calibrationCompletedEpoch = completedNow > 1600000000
              ? static_cast<uint32_t>(completedNow) : 0;
          actuator.stop(nowUs);
        } else {
          serviceCalibrationStepRequest(nowUs);
        }
      } else if (stepHeat > 0 && state.effectiveHeatMilli > 0 &&
                 nowUs - calibrationLastRenewUs >=
                     kCalibrationRenewIntervalUs) {
        // Renewing the 30 s lease keeps the zero-cross ISR bound as the
        // authority; a dead loop lets Heat expire hands-off within 30 s.
        const char* rejection = nullptr;
        if (actuator.request(stepFan, stepHeat, micros(), rejection,
                             kHeaterProofMaximumMs * 1000U)) {
          clearTransientRejection(calibrationRejectionRetry);
          calibrationRenewals++;
          calibrationLastRenewUs = nowUs;
        } else if (!retryTransientRejection(calibrationRejectionRetry,
                                            rejection)) {
          calibrationActive = false;
          calibrationEndReason = "renewal_rejected";
          actuator.stop(nowUs);
        }
      }
    }
  }

  if (roastActive) {
    if (actuationAbortFault) {
      finishRoast(nowUs, thermalStaleFault ? "telemetry_stale" : "fault");
    } else if (roastMode != RoastMode::MANUAL &&
               (millis() - roastStartedMs) / 1000U > roastEnvelopeSec) {
      // The device-enforced runtime envelope. Zone advancement is attainment-
      // gated, so an unreachable endpoint would otherwise hold its zone — and
      // renew Heat — forever. The browser's feasibility preflight is advice;
      // this is the firmware boundary: twice the plan's own nominal duration
      // plus margin, then all outputs off, no exceptions.
      finishRoast(nowUs, "envelope_timeout");
    } else if (roastMode == RoastMode::TIMED) {
      serviceTimedRoast(nowUs, state);
    } else if (roastMode == RoastMode::JOURNEY) {
      serviceJourneyRoast(nowUs, state);
    } else {
      serviceManualRoast(nowUs, state);
    }
  }

  if (manualActive) {
    if (actuationAbortFault) {
      manualActive = false;
      manualEndReason = thermalStaleFault ? "telemetry_stale" : "fault";
    } else if (sr800::runtime::instructionExpired(
                   millis(), manualLastInstructionMs,
                   kManualInstructionLeaseMs)) {
      // The instruction has run its 30 minutes without being renewed by a new
      // one. Nothing about the client matters here - the browser may have been
      // closed for 29 of those minutes - only that no fresh instruction has
      // arrived. The WHOLE instruction expires, fan included: a fan-only
      // setting is an instruction too, and a session that lingered would keep
      // blocking programs and holding Wi-Fi awake indefinitely. Expiry is an
      // immediate full stop.
      manualActive = false;
      manualEndReason = "instruction_expired";
      actuator.stop(nowUs);
    } else if (manualHeatMilli > 0 && state.effectiveHeatMilli > 0 &&
               nowUs - manualLastRenewUs >= kCalibrationRenewIntervalUs) {
      const char* rejection = nullptr;
      if (actuator.request(manualFanMilli, manualHeatMilli, micros(), rejection,
                           kHeaterProofMaximumMs * 1000U)) {
        clearTransientRejection(manualRejectionRetry);
        manualLastRenewUs = nowUs;
      } else if (!retryTransientRejection(manualRejectionRetry, rejection)) {
        manualActive = false;
        manualEndReason = "renewal_rejected";
        actuator.stop(nowUs);
      }
    }
  }

  // A controller scheduling lapse aborts the operation and Heat immediately,
  // but it is not evidence of a broken probe. Clear that one recoverable fault
  // only after every owner has observed the abort and this loop has published
  // a fresh HEALTHY sensor sample.
  if (state.fault == sr800::ActuatorFault::THERMAL_STALE &&
      !fanTestActive && heaterProofPhase == HeaterProofPhase::IDLE &&
      !calibrationActive && !manualActive &&
      !roastActive &&
      !actuator.outputsActive()) {
    actuator.clearThermalStaleFault(nowUs);
  }

  if (!fanTestActive && heaterProofPhase == HeaterProofPhase::IDLE &&
      !calibrationActive && !manualActive && !roastActive &&
      !actuator.outputsActive()) {
    phaseScheduler.endTimingLog();
    exitActuationWifiAwakeMode();
  }
}
void detachSignalInterrupts() {
  if (!signalInterruptsAttached) return;
  for (size_t index = 0; index < kChannelCount; ++index) {
    detachInterrupt(digitalPinToInterrupt(static_cast<uint8_t>(kPins[index])));
  }
  signalInterruptsAttached = false;
}

void attachSignalInterrupts() {
  if (signalInterruptsAttached) return;
  attachInterrupt(digitalPinToInterrupt(static_cast<uint8_t>(kPins[2])), onChannel2Edge, RISING);
  signalInterruptsAttached = true;
}

void resetAndArmCapture() {
  detachSignalInterrupts();
  const uint32_t nowUs = micros();
  const uint8_t levels = readAllLevels();

  portENTER_CRITICAL(&captureMux);
  eventCount = 0;
  lastEventUs = nowUs;
  lastLevels = levels;
  seenHighMask = levels;
  seenLowMask = static_cast<uint8_t>((~levels) & 0x0F);
  captureEnabled = true;
  captureComplete = false;
  captureStopReason = kStopNone;
  for (size_t index = 0; index < kChannelCount; ++index) {
    lastEdgeUs[index] = nowUs;
    riseCount[index] = 0;
    fallCount[index] = 0;
    lastHighUs[index] = 0;
    minHighUs[index] = UINT32_MAX;
    maxHighUs[index] = 0;
    lastLowUs[index] = 0;
    minLowUs[index] = UINT32_MAX;
    maxLowUs[index] = 0;
  }
  portEXIT_CRITICAL(&captureMux);
  attachSignalInterrupts();
}

void freezeCapture() {
  portENTER_CRITICAL(&captureMux);
  if (captureEnabled) {
    captureEnabled = false;
    captureComplete = true;
    captureStopReason = kStopManual;
  }
  portEXIT_CRITICAL(&captureMux);
}

bool copyEvent(uint32_t sequence, EdgeEvent& destination) {
  if (sequence == 0 || sequence > kEventCapacity) return false;
  const size_t index = sequence - 1;
  portENTER_CRITICAL(&captureMux);
  const bool valid = eventBuffer[index].sequence == sequence;
  if (valid) {
    destination.sequence = eventBuffer[index].sequence;
    destination.atUs = eventBuffer[index].atUs;
    destination.precedingGapUs = eventBuffer[index].precedingGapUs;
    destination.changedMask = eventBuffer[index].changedMask;
    destination.levels = eventBuffer[index].levels;
  }
  portEXIT_CRITICAL(&captureMux);
  return valid;
}

const char* resetReasonName(esp_reset_reason_t reason) {
  switch (reason) {
    case ESP_RST_POWERON: return "power_on";
    case ESP_RST_EXT: return "external_pin";
    case ESP_RST_SW: return "software";
    case ESP_RST_PANIC: return "panic";
    case ESP_RST_INT_WDT: return "interrupt_watchdog";
    case ESP_RST_TASK_WDT: return "task_watchdog";
    case ESP_RST_WDT: return "other_watchdog";
    case ESP_RST_DEEPSLEEP: return "deep_sleep";
    case ESP_RST_BROWNOUT: return "brownout";
    case ESP_RST_SDIO: return "sdio";
    default: return "unknown";
  }
}

uint32_t readUintArg(const char* name, uint32_t fallback,
                     uint32_t minimum, uint32_t maximum) {
  if (!requestHasArg(name)) return fallback;
  const long parsed = requestArg(name).toInt();
  if (parsed < static_cast<long>(minimum)) return minimum;
  if (parsed > static_cast<long>(maximum)) return maximum;
  return static_cast<uint32_t>(parsed);
}

bool parseRequiredUint32Arg(const char* name, uint32_t& out) {
  if (!requestHasArg(name)) return false;
  const String raw = requestArg(name);
  if (raw.length() == 0) return false;
  uint32_t value = 0;
  for (size_t index = 0; index < raw.length(); ++index) {
    const char c = raw[index];
    if (c < '0' || c > '9') return false;
    const uint32_t digit = static_cast<uint8_t>(c - '0');
    if (value > (UINT32_MAX - digit) / 10U) return false;
    value = value * 10U + digit;
  }
  if (value == 0) return false;
  out = value;
  return true;
}

bool parseLevelArg(const char* name, uint32_t& levelMilli,
                   bool& clampedToMinimum) {
  if (!requestHasArg(name)) return false;
  const String raw = requestArg(name);
  char* end = nullptr;
  const double parsed = strtod(raw.c_str(), &end);
  while (end != nullptr && *end == ' ') ++end;
  if (end == raw.c_str() || end == nullptr || *end != '\0' ||
      isnan(parsed) || isinf(parsed) || parsed < 0.0 || parsed > 10.0) {
    return false;
  }
  if (parsed == 0.0) {
    levelMilli = 0;
    clampedToMinimum = false;
    return true;
  }
  clampedToMinimum = parsed < 0.1;
  const double bounded = clampedToMinimum ? 0.1 : parsed;
  levelMilli = static_cast<uint32_t>(lround(bounded * 1000.0));
  if (levelMilli < kFanLevelMinimumMilli) {
    levelMilli = kFanLevelMinimumMilli;
  }
  if (levelMilli > kFanLevelMaximumMilli) {
    levelMilli = kFanLevelMaximumMilli;
  }
  return true;
}

bool parseLevelToken(const String& piece, uint32_t& milli,
                     bool allowZero) {
  char* end = nullptr;
  const double parsed = strtod(piece.c_str(), &end);
  if (end == piece.c_str() || end == nullptr || *end != '\0' ||
      isnan(parsed) || parsed < 0.0 || parsed > 10.0) {
    return false;
  }
  if (parsed == 0.0) {
    if (!allowZero) return false;
    milli = 0;
    return true;
  }
  milli = static_cast<uint32_t>(
      lround((parsed < 0.1 ? 0.1 : parsed) * 1000.0));
  if (milli < kFanLevelMinimumMilli) milli = kFanLevelMinimumMilli;
  if (milli > kFanLevelMaximumMilli) milli = kFanLevelMaximumMilli;
  return true;
}

// steps=F:H,F:H,... one fan:heat pair per step. Fan 0 is allowed only with
// heat 0 (a passive-decay step).
bool parseStepPairsArg(const char* name, uint32_t* fans, uint32_t* heats,
                       size_t& count) {
  if (!requestHasArg(name)) return false;
  const String raw = requestArg(name);
  count = 0;
  int start = 0;
  while (start <= static_cast<int>(raw.length())) {
    const int comma = raw.indexOf(',', start);
    String piece = comma < 0 ? raw.substring(start)
                             : raw.substring(start, comma);
    piece.trim();
    const int colon = piece.indexOf(':');
    if (piece.length() == 0 || colon <= 0 ||
        colon >= static_cast<int>(piece.length()) - 1) {
      return false;
    }
    String fanPiece = piece.substring(0, colon);
    String heatPiece = piece.substring(colon + 1);
    fanPiece.trim();
    heatPiece.trim();
    uint32_t fanMilli = 0;
    uint32_t heatMilli = 0;
    if (count >= kCalibrationMaxSteps ||
        !parseLevelToken(fanPiece, fanMilli, true) ||
        !parseLevelToken(heatPiece, heatMilli, true) ||
        (fanMilli == 0 && heatMilli > 0)) {
      return false;
    }
    // Heat on means Fan 1.0 or higher.
    fans[count] = heatOnFanFloorMilli(fanMilli, heatMilli);
    heats[count] = heatMilli;
    count++;
    if (comma < 0) break;
    start = comma + 1;
  }
  return count > 0;
}

bool parseHeatLevelsArg(const char* name, uint32_t* levels, size_t& count) {
  if (!requestHasArg(name)) return false;
  const String raw = requestArg(name);
  count = 0;
  int start = 0;
  while (start <= static_cast<int>(raw.length())) {
    const int comma = raw.indexOf(',', start);
    String piece = comma < 0 ? raw.substring(start)
                             : raw.substring(start, comma);
    piece.trim();
    if (piece.length() == 0) return false;
    char* end = nullptr;
    const double parsed = strtod(piece.c_str(), &end);
    if (end == piece.c_str() || end == nullptr || *end != '\0' ||
        isnan(parsed) || parsed < 0.0 || parsed > 10.0) {
      return false;
    }
    if (count >= kCalibrationMaxSteps) return false;
    uint32_t milli = 0;
    if (parsed > 0.0) {
      milli = static_cast<uint32_t>(
          lround((parsed < 0.1 ? 0.1 : parsed) * 1000.0));
      if (milli < kFanLevelMinimumMilli) milli = kFanLevelMinimumMilli;
      if (milli > kFanLevelMaximumMilli) milli = kFanLevelMaximumMilli;
    }
    levels[count++] = milli;
    if (comma < 0) break;
    start = comma + 1;
  }
  return count > 0;
}

// steps=F:H:SECONDS,... one triple per timed step. Fan 0 is allowed only with
// heat 0 (a passive-decay step), the same rule the calibration parser applies.
bool parseRoastStepsArg(const char* name, uint32_t* fans, uint32_t* heats,
                        uint32_t* seconds, size_t& count) {
  if (!requestHasArg(name)) return false;
  const String raw = requestArg(name);
  count = 0;
  int start = 0;
  while (start <= static_cast<int>(raw.length())) {
    const int comma = raw.indexOf(',', start);
    String piece = comma < 0 ? raw.substring(start)
                             : raw.substring(start, comma);
    piece.trim();
    const int firstColon = piece.indexOf(':');
    const int secondColon = firstColon < 0
        ? -1 : piece.indexOf(':', firstColon + 1);
    if (piece.length() == 0 || firstColon <= 0 || secondColon <= firstColon + 1 ||
        secondColon >= static_cast<int>(piece.length()) - 1) {
      return false;
    }
    String fanPiece = piece.substring(0, firstColon);
    String heatPiece = piece.substring(firstColon + 1, secondColon);
    String secondsPiece = piece.substring(secondColon + 1);
    fanPiece.trim();
    heatPiece.trim();
    secondsPiece.trim();
    uint32_t fanMilli = 0;
    uint32_t heatMilli = 0;
    if (count >= kRoastMaxSteps ||
        !parseLevelToken(fanPiece, fanMilli, true) ||
        !parseLevelToken(heatPiece, heatMilli, true) ||
        (fanMilli == 0 && heatMilli > 0)) {
      return false;
    }
    char* end = nullptr;
    const unsigned long stepSeconds =
        strtoul(secondsPiece.c_str(), &end, 10);
    if (end == secondsPiece.c_str() || end == nullptr || *end != '\0' ||
        stepSeconds < kRoastStepMinimumS || stepSeconds > kRoastStepMaximumS) {
      return false;
    }
    // Heat on means Fan 1.0 or higher: an old
    // profile's lower fan is lifted at execution, never refused.
    fans[count] = heatOnFanFloorMilli(fanMilli, heatMilli);
    heats[count] = heatMilli;
    seconds[count] = static_cast<uint32_t>(stepSeconds);
    count++;
    if (comma < 0) break;
    start = comma + 1;
  }
  return count > 0;
}

bool parseZoneNumber(const String& field, double& value) {
  if (field.length() == 0) return false;
  char* end = nullptr;
  value = strtod(field.c_str(), &end);
  return end != field.c_str() && end != nullptr && *end == '\0' &&
         !isnan(value) && !isinf(value);
}

// zones=endC:duration:fanMin:fanMax:heatMin:heatMax;... one zone per group.
// Semicolons separate zones because a zone already spends every colon it has.
//
// `duration` is nominal seconds, or `r<rate>` for a rate in C per minute, from
// which the nominal seconds are derived: |endC - startC| / rate x 60. Both
// spellings produce the same zone; the rate form exists because that is how a
// roast profile is usually written down, and a rate on a HOLD zone is
// meaningless (there is no temperature to cover) so it is refused.
//
// A zone's START temperature is never authored: zone 0 starts at the roast's
// declared `start` and every later zone starts where the one before it ended,
// which is the same relinking the profile editor does. That is what keeps the
// anchored in-zone target free of steps at a boundary.
bool parseRoastZonesArg(const char* name, double startC,
                        sr800::JourneyZone* zones, size_t& count) {
  if (!requestHasArg(name)) return false;
  const String raw = requestArg(name);
  count = 0;
  double previousEndC = startC;
  int start = 0;
  while (start <= static_cast<int>(raw.length())) {
    const int separator = raw.indexOf(';', start);
    String piece = separator < 0 ? raw.substring(start)
                                 : raw.substring(start, separator);
    piece.trim();
    if (piece.length() == 0) return false;
    if (count >= sr800::kMaxJourneyZones) return false;

    String fields[6];
    int cursor = 0;
    for (size_t index = 0; index < 6; ++index) {
      const int colon = piece.indexOf(':', cursor);
      const bool last = index == 5;
      if ((last && colon >= 0) || (!last && colon < 0)) return false;
      fields[index] = last ? piece.substring(cursor)
                           : piece.substring(cursor, colon);
      fields[index].trim();
      cursor = colon + 1;
    }

    sr800::JourneyZone& zone = zones[count];
    zone.startC = previousEndC;
    if (!parseZoneNumber(fields[0], zone.endC) ||
        !parseZoneNumber(fields[2], zone.fanMin) ||
        !parseZoneNumber(fields[3], zone.fanMax) ||
        !parseZoneNumber(fields[4], zone.heatMin) ||
        !parseZoneNumber(fields[5], zone.heatMax)) {
      return false;
    }

    const bool rateForm =
        fields[1].length() > 1 &&
        (fields[1].charAt(0) == 'r' || fields[1].charAt(0) == 'R');
    double duration = 0.0;
    if (rateForm) {
      double ratePerMin = 0.0;
      const double spanC = fabs(zone.endC - zone.startC);
      if (!parseZoneNumber(fields[1].substring(1), ratePerMin) ||
          ratePerMin <= 0.0 || spanC < sr800::kZoneHoldEpsilonC) {
        return false;
      }
      duration = (spanC / ratePerMin) * 60.0;
    } else if (!parseZoneNumber(fields[1], duration)) {
      return false;
    }
    zone.durationSec = duration;

    if (zone.endC < 0.0 || zone.endC > 300.0 ||
        zone.durationSec < kRoastZoneMinimumS ||
        zone.durationSec > kRoastZoneMaximumS ||
        zone.fanMin < 0.0 || zone.fanMax > 10.0 || zone.fanMin > zone.fanMax ||
        zone.heatMin < 0.0 || zone.heatMax > 10.0 ||
        zone.heatMin > zone.heatMax) {
      return false;
    }
    // A zone with no airflow at all cannot be commanded: the actuator's own
    // floor would lift it anyway, so refuse it at the door rather than run a
    // plan the roaster will silently rewrite.
    if (zone.fanMax <= 0.0) return false;
    previousEndC = zone.endC;
    count++;
    if (separator < 0) break;
    start = separator + 1;
  }
  return count > 0;
}

// The roast name is echoed inside JSON string literals and written into a fixed
// archive field, so it is sanitized exactly like the calibration fit id.
void sanitizeRoastName(const String& requested, char* out, size_t capacity) {
  strlcpy(out, requested.c_str(), capacity);
  for (char* c = out; *c != '\0'; ++c) {
    const unsigned char value = static_cast<unsigned char>(*c);
    if (!isalnum(value) && *c != '.' && *c != '_' && *c != ':' && *c != '-' &&
        *c != ' ') {
      *c = '-';
    }
  }
}

void scrubString(String& value) {
  for (size_t index = 0; index < value.length(); ++index) {
    value.setCharAt(index, '\0');
  }
  value = String();
}

bool saveNetworkCredentials(const String& ssid, const String& password) {
  Preferences preferences;
  if (!preferences.begin(kPreferencesNamespace, false)) return false;
  const size_t ssidBytes = preferences.putString("ssid", ssid);
  const size_t passwordBytes = preferences.putString("pass", password);
  preferences.end();
  return ssidBytes == ssid.length() &&
         (password.isEmpty() || passwordBytes == password.length());
}

template <typename Output>
void appendUint64Decimal(Output& out, uint64_t value) {
  char decimal[24];
  snprintf(decimal, sizeof(decimal), "%llu", static_cast<unsigned long long>(value));
  out += decimal;
}

void loadRuntimeContract() {
  Preferences store;
  if (!store.begin(kRuntimeNamespace, true)) return;
  stateRevision = store.getULong64("state_rev", sr800::runtime::kFirstRevision);
  if (stateRevision == 0) stateRevision = sr800::runtime::kFirstRevision;
  const float storedOffset = store.getFloat("tc_offset", kThermocoupleOffsetDefaultC);
  thermocoupleOffsetC = sr800::runtime::thermocoupleOffsetAllowed(storedOffset)
      ? storedOffset : kThermocoupleOffsetDefaultC;
  restoreLease.incomplete = store.getBool("restore", false);
  restoreLease.dirty = restoreLease.incomplete && store.getBool("restore_dirty", false);
  store.end();
}

// Counts every manifest-visible filesystem change, including restore-lease writes that
// defer the state revision to commit. The manifest cache is keyed by this, not by the revision.
uint32_t manifestMutationCount = 0;
void noteManifestMutation() {
  portENTER_CRITICAL(&stateRevisionMux);
  manifestMutationCount++;
  portEXIT_CRITICAL(&stateRevisionMux);
}
uint32_t currentManifestMutationCount() {
  portENTER_CRITICAL(&stateRevisionMux);
  const uint32_t snapshot = manifestMutationCount;
  portEXIT_CRITICAL(&stateRevisionMux);
  return snapshot;
}

uint64_t currentStateRevision() {
  portENTER_CRITICAL(&stateRevisionMux);
  const uint64_t snapshot = stateRevision;
  portEXIT_CRITICAL(&stateRevisionMux);
  return snapshot;
}

void advanceStateRevision() {
  portENTER_CRITICAL(&stateRevisionMux);
  stateRevision = sr800::runtime::nextRevision(stateRevision);
  manifestMutationCount++;
  const uint64_t next = stateRevision;
  portEXIT_CRITICAL(&stateRevisionMux);
  Preferences store;
  if (store.begin(kRuntimeNamespace, false)) {
    store.putULong64("state_rev", next);
    store.end();
  }
}

bool saveThermocoupleOffset(float offsetC) {
  Preferences store;
  if (!store.begin(kRuntimeNamespace, false)) return false;
  const size_t stored = store.putFloat("tc_offset", offsetC);
  store.end();
  return stored == sizeof(float);
}

void persistRestoreMarker(bool pending, bool dirty = false) {
  Preferences store;
  if (store.begin(kRuntimeNamespace, false)) {
    store.putBool("restore", pending);
    store.putBool("restore_dirty", pending && dirty);
    store.end();
  }
}

void markRestoreDirty() {
  noteManifestMutation();
  if (!restoreLease.incomplete || restoreLease.dirty) return;
  restoreLease.dirty = true;
  persistRestoreMarker(true, true);
}

void refreshRestoreLease() {
  if (restoreLease.active && !sr800::runtime::deadlinePending(millis(), restoreLease.expiresAtMs)) {
    restoreLease.active = false;
    restoreLease.incomplete = true;
  }
}

bool restoreTokenMatchesRequest() {
  refreshRestoreLease();
  uint32_t token = 0;
  return requestHasArg("restore_token") && parseRequiredUint32Arg("restore_token", token) &&
         sr800::runtime::restoreLeaseValid(restoreLease, millis(), token);
}

bool rejectMutationDuringRestore(bool allowMatchingRestoreToken = false) {
  refreshRestoreLease();
  if (!restoreLease.active && !restoreLease.incomplete) return false;
  if (allowMatchingRestoreToken && restoreTokenMatchesRequest()) return false;
  sendRequestResponse(423, "application/json",
              "{\"ok\":false,\"message\":\"Restore maintenance is active or incomplete; only reads and Stop are available.\"}");
  return true;
}

void handleRestoreBegin() {
  StorageMutationGuard nvsMutation;
  if (!requestHasArg("confirm") || requestArg("confirm") != "BEGIN_RESTORE") {
    sendRequestResponse(409, "application/json", "{\"ok\":false,\"message\":\"confirm=BEGIN_RESTORE is required\"}");
    return;
  }
  if (!nvsMutationAllowed() || !nvsMutation) {
    sendRequestResponse(409, "application/json", "{\"ok\":false,\"message\":\"Restore requires a fully idle roaster with no firmware update active.\"}");
    return;
  }
  const bool wasIncomplete = restoreLease.incomplete;
  restoreLease.token = esp_random();
  if (restoreLease.token == 0) restoreLease.token = 1;
  restoreLease.expiresAtMs = millis() + sr800::runtime::kRestoreLeaseMs;
  restoreLease.active = true;
  restoreLease.incomplete = true;
  if (!wasIncomplete) restoreLease.dirty = false;
  persistRestoreMarker(true, restoreLease.dirty);
  String json = F("{\"ok\":true,\"restore_token\":\""); json += restoreLease.token;
  json += F("\",\"expires_in_ms\":"); json += sr800::runtime::kRestoreLeaseMs;
  json += F(",\"state_rev\":\""); appendUint64Decimal(json, currentStateRevision()); json += F("\"}");
  sendRequestResponse(200, "application/json", json);
}

void handleRestoreCommit() {
  StorageMutationGuard nvsMutation;
  if (!restoreTokenMatchesRequest()) {
    sendRequestResponse(409, "application/json", "{\"ok\":false,\"message\":\"restore_token does not identify the active restore lease\"}");
    return;
  }
  if (!nvsMutationAllowed() || !nvsMutation) {
    sendRequestResponse(409, "application/json",
                "{\"ok\":false,\"message\":\"Restore commit waits for a fully idle roaster and no firmware update.\"}");
    return;
  }
  restoreLease = sr800::runtime::RestoreLease{};
  persistRestoreMarker(false);
  advanceStateRevision();
  String json = F("{\"ok\":true,\"committed\":true,\"state_rev\":\"");
  appendUint64Decimal(json, currentStateRevision()); json += F("\"}");
  sendRequestResponse(200, "application/json", json);
}

void handleRestoreAbort() {
  StorageMutationGuard nvsMutation;
  const bool recoveryAbort = restoreLease.incomplete && !restoreLease.active &&
      requestHasArg("confirm") && requestArg("confirm") == "ABORT_RESTORE";
  if (!recoveryAbort && !restoreTokenMatchesRequest()) {
    sendRequestResponse(409, "application/json", "{\"ok\":false,\"message\":\"restore_token or confirm=ABORT_RESTORE is required\"}");
    return;
  }
  if (!sr800::runtime::restoreAbortAllowed(restoreLease)) {
    sendRequestResponse(409, "application/json",
                "{\"ok\":false,\"incomplete\":true,\"dirty\":true,\"message\":\"Restore already changed device storage. Resume it and commit; abort cannot recover the previous library.\"}");
    return;
  }
  if (!nvsMutationAllowed() || !nvsMutation) {
    sendRequestResponse(409, "application/json",
                "{\"ok\":false,\"message\":\"Restore abort waits for a fully idle roaster and no firmware update.\"}");
    return;
  }
  restoreLease = sr800::runtime::RestoreLease{};
  persistRestoreMarker(false);
  String json = F("{\"ok\":true,\"aborted\":true,\"state_rev\":\"");
  appendUint64Decimal(json, currentStateRevision()); json += F("\"}");
  sendRequestResponse(200, "application/json", json);
}

void handleThermocoupleOffset() {
  StorageMutationGuard nvsMutation;
  if (rejectMutationDuringRestore()) return;
  if (!requestHasArg("confirm") || requestArg("confirm") != "SET_THERMOCOUPLE_OFFSET") {
    sendRequestResponse(409, "application/json", "{\"ok\":false,\"message\":\"confirm=SET_THERMOCOUPLE_OFFSET is required\"}");
    return;
  }
  if (!nvsMutationAllowed() || !nvsMutation) {
    sendRequestResponse(409, "application/json", "{\"ok\":false,\"message\":\"Thermocouple offset changes require a fully idle roaster with no firmware update active.\"}");
    return;
  }
  float offsetC = 0.0f;
  const String rawOffset = requestHasArg("offset_c") ? requestArg("offset_c") : String();
  char* offsetEnd = nullptr;
  offsetC = strtof(rawOffset.c_str(), &offsetEnd);
  if (offsetEnd == rawOffset.c_str() || *offsetEnd != '\0' ||
      !isfinite(offsetC) || !sr800::runtime::thermocoupleOffsetAllowed(offsetC)) {
    sendRequestResponse(400, "application/json", "{\"ok\":false,\"message\":\"offset_c must be from -25.0 through 25.0 C\"}");
    return;
  }
  if (!saveThermocoupleOffset(offsetC)) {
    sendRequestResponse(500, "application/json", "{\"ok\":false,\"message\":\"Thermocouple offset storage failed\"}");
    return;
  }
  thermocoupleOffsetC = offsetC;
  advanceStateRevision();
  String json = F("{\"ok\":true,\"thermocouple_offset_c\":"); json += String(thermocoupleOffsetC, 2);
  json += F(",\"state_rev\":\""); appendUint64Decimal(json, currentStateRevision()); json += F("\"}");
  sendRequestResponse(200, "application/json", json);
}

bool loadNetworkCredentials(String& ssid, String& password) {
  Preferences preferences;
  if (!preferences.begin(kPreferencesNamespace, true)) return false;
  ssid = preferences.getString("ssid", "");
  password = preferences.getString("pass", "");
  preferences.end();
  return !ssid.isEmpty();
}

void startStationConnection(const String& ssid, String& password) {
  stationSsid = ssid;
  stationConfigured = true;
  lastReconnectAttemptMs = millis();
  WiFi.disconnect(false, false);
  WiFi.begin(stationSsid.c_str(), password.c_str());
  scrubString(password);
}

void connectToStoredNetwork() {
  String ssid;
  String password;
  if (!loadNetworkCredentials(ssid, password)) {
    stationConfigured = false;
    return;
  }
  startStationConnection(ssid, password);
}

bool startRecoveryAccessPoint() {
  if (apActive) return true;
  lastApStartAttemptMs = millis();
  WiFi.mode(WIFI_AP_STA);
  apActive = WiFi.softAP(kApName, kApPassword);
  return apActive;
}

void stopRecoveryAccessPoint() {
  if (apActive && WiFi.softAPdisconnect(true)) {
    apActive = false;
    WiFi.mode(WIFI_STA);
  }
}

void onWiFiEvent(arduino_event_id_t event, arduino_event_info_t info) {
  const bool gotIp = event == ARDUINO_EVENT_WIFI_STA_GOT_IP;
  const uint32_t now = millis();
  portENTER_CRITICAL(&wifiEventMux);
  if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
    wifiDisconnectCount++;
    wifiLastDisconnectMs = now;
    wifiLastDisconnectReason = info.wifi_sta_disconnected.reason;
  } else if (gotIp) {
    wifiGotIpCount++;
    wifiLastGotIpMs = now;
  }
  portEXIT_CRITICAL(&wifiEventMux);
  if (gotIp) {
    const String address = WiFi.localIP().toString();
    Serial.printf("Wi-Fi connected: %s\n", address.c_str());
  }
}

void maintainStationConnection() {
  static wl_status_t previousStatus = WL_NO_SHIELD;
  const wl_status_t status = WiFi.status();
  const uint32_t now = millis();
  const bool outputsActive = actuator.outputsActive();

  if (status == WL_CONNECTED) {
    if (previousStatus != WL_CONNECTED) {
      stationConnectedSinceMs = now;
      stationDisconnectedSinceMs = 0;
    }
    if (!mdnsStarted) {
      mdnsStarted = MDNS.begin(kHostName);
      if (mdnsStarted) MDNS.addService("http", "tcp", 80);
    }
    if (apActive && stationConnectedSinceMs != 0 &&
        now - stationConnectedSinceMs >= kApShutdownDelayMs) {
      stopRecoveryAccessPoint();
    }
  } else {
    stationConnectedSinceMs = 0;
    if (previousStatus == WL_CONNECTED) stationDisconnectedSinceMs = now;
    if (mdnsStarted) {
      MDNS.end();
      mdnsStarted = false;
    }
    if (stationConfigured &&
        now - lastReconnectAttemptMs >= kReconnectIntervalMs) {
      lastReconnectAttemptMs = now;
      portENTER_CRITICAL(&wifiEventMux);
      wifiPollReconnectAttemptCount++;
      portEXIT_CRITICAL(&wifiEventMux);
      WiFi.reconnect();
    }
    // Station recovery must continue during a roast, calibration, or manual
    // command. Starting the recovery AP changes Wi-Fi mode, however, so defer
    // that broader topology change until synchronized outputs are idle.
    const bool recoveryApDue = !stationConfigured ||
        (stationDisconnectedSinceMs != 0 &&
         now - stationDisconnectedSinceMs >= kApRecoveryDelayMs);
    if (!outputsActive && !apActive && recoveryApDue &&
        now - lastApStartAttemptMs >= kReconnectIntervalMs) {
      startRecoveryAccessPoint();
    }
  }
  previousStatus = status;
}

template <typename Output>
void appendDuration(Output& json, uint32_t value) {
  if (value == UINT32_MAX) json += F("null");
  else json += value;
}


void maxWriteRegister(uint8_t address, uint8_t value) {
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE1));
  gpio_set_level(kMaxCsPin, 0);
  SPI.transfer(static_cast<uint8_t>(address | 0x80));
  SPI.transfer(value);
  gpio_set_level(kMaxCsPin, 1);
  SPI.endTransaction();
}

void maxReadRegisters(uint8_t address, uint8_t* destination, size_t count) {
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE1));
  gpio_set_level(kMaxCsPin, 0);
  SPI.transfer(static_cast<uint8_t>(address & 0x7F));
  for (size_t index = 0; index < count; ++index) {
    destination[index] = SPI.transfer(0x00);
  }
  gpio_set_level(kMaxCsPin, 1);
  SPI.endTransaction();
}

uint8_t maxReadRegister(uint8_t address) {
  uint8_t value = 0;
  maxReadRegisters(address, &value, 1);
  return value;
}

bool configureMax31856() {
  maxLastConfigureAttemptMs = millis();
  maxWriteRegister(0x02, 0x00);  // Unmask all fault sources.
  maxWriteRegister(0x09, 0x00);  // No cold-junction offset.
  maxWriteRegister(0x01, 0x03);  // One sample average, K-type.
  maxWriteRegister(0x00, 0x90);  // Continuous, open-circuit check, 60 Hz.

  const uint8_t cr0 = maxReadRegister(0x00);
  const uint8_t cr1 = maxReadRegister(0x01);
  max31856Configured =
      (cr0 & 0x91) == 0x90 && (cr1 & 0x0F) == 0x03;
  if (!max31856Configured) {
    maxThermocoupleRawC = NAN;
    maxThermocoupleC = NAN;
    maxColdJunctionC = NAN;
    maxFaultStatus = 0xFF;
  }
  return max31856Configured;
}

void sampleMax31856() {
  const uint32_t nowMs = millis();
  if (!max31856Configured) {
    if (maxLastSampleMs == 0 ||
        nowMs - maxLastSampleMs >= kMaxSampleIntervalMs) {
      maxLastSampleMs = nowMs;
      maxFaultStatus = 0xFF;
      const bool qualified =
          maxSensorFaultQualifier.observe(false, maxFaultStatus, nowMs);
      calibrationReadiness.observe(false, NAN, nowMs);
      actuator.updateThermalSafety(
          qualified ? sr800::ThermalSafetyStatus::SENSOR_FAULT
                    : sr800::ThermalSafetyStatus::UNKNOWN,
          micros());
    }
    if (nowMs - maxLastConfigureAttemptMs >= 2000U) configureMax31856();
    return;
  }
  if (nowMs - maxLastSampleMs < kMaxSampleIntervalMs) return;

  uint8_t thermocoupleBytes[3];
  maxReadRegisters(0x0C, thermocoupleBytes, 3);
  int32_t thermocoupleRaw =
      (static_cast<int32_t>(thermocoupleBytes[0]) << 16) |
      (static_cast<int32_t>(thermocoupleBytes[1]) << 8) |
      thermocoupleBytes[2];
  if ((thermocoupleRaw & 0x800000) != 0) {
    thermocoupleRaw |= static_cast<int32_t>(0xFF000000);
  }
  thermocoupleRaw >>= 5;
  maxThermocoupleRawC = thermocoupleRaw * 0.0078125f;
  maxThermocoupleC = maxThermocoupleRawC + thermocoupleOffsetC;

  uint8_t coldJunctionBytes[2];
  maxReadRegisters(0x0A, coldJunctionBytes, 2);
  const int16_t coldJunctionRaw = static_cast<int16_t>(
      (static_cast<uint16_t>(coldJunctionBytes[0]) << 8) |
      coldJunctionBytes[1]);
  maxColdJunctionC = coldJunctionRaw / 256.0f;
  maxFaultStatus = maxReadRegister(0x0F);
  maxLastSampleMs = nowMs;
  const bool valid = maxFaultStatus == 0 && !isnan(maxThermocoupleC);
  // MAX31856 SR bits 7, 5 and 4 are cold-junction range/high/low faults.
  // An open thermocouple alone does not erase an otherwise useful ambient.
  const bool coldJunctionValid = (maxFaultStatus & 0xB0U) == 0 &&
      !isnan(maxColdJunctionC);
  const bool sensorFaultQualified =
      maxSensorFaultQualifier.observe(valid, maxFaultStatus, nowMs);
  calibrationReadiness.observe(valid, maxThermocoupleC, nowMs);
  const bool overtempSustained = overtemperatureCondition.observe(
      valid && maxThermocoupleC >= kOvertempDisableC,
      nowMs, kOvertempSustainMs);
  actuator.updateThermalSafety(
      overtempSustained
          ? sr800::ThermalSafetyStatus::OVERTEMPERATURE
          : sensorFaultQualified
              ? sr800::ThermalSafetyStatus::SENSOR_FAULT
              : valid ? sr800::ThermalSafetyStatus::HEALTHY
                      : sr800::ThermalSafetyStatus::UNKNOWN,
      micros());

  const sr800::ActuatorSnapshot thermalState = actuator.snapshot(micros());
  portENTER_CRITICAL(&thermalLogMux);
  if (thermalLog != nullptr && thermalLogActive &&
      (thermalLogLastSampleMs == 0 ||
       nowMs - thermalLogLastSampleMs >= thermalLogIntervalMs)) {
    ThermalSample& sample = thermalLog[thermalLogCount];
    sample.tMs = nowMs - thermalLogStartMs;
    // A finite register value is not a valid reading when MAX31856 reports a
    // fault. Keep the cold-junction channel independent: an open thermocouple
    // can still leave a useful ambient reading.
    sample.thermocoupleDeci = !valid
        ? INT16_MIN
        : static_cast<int16_t>(lroundf(maxThermocoupleC * 10.0f));
    sample.coldJunctionDeci = !coldJunctionValid
        ? INT16_MIN
        : static_cast<int16_t>(lroundf(maxColdJunctionC * 10.0f));
    sample.fanMilli = static_cast<uint16_t>(thermalState.effectiveFanMilli);
    sample.heatMilli = static_cast<uint16_t>(thermalState.effectiveHeatMilli);
    thermalLogCount++;
    thermalLogLastSampleMs = nowMs;
    if (thermalLogCount >= kThermalLogCapacity) thermalLogActive = false;
  }
  portEXIT_CRITICAL(&thermalLogMux);
}
bool actuatorFullyIdle() {
  return !fanTestActive && heaterProofPhase == HeaterProofPhase::IDLE &&
         !calibrationActive && !manualActive &&
         !roastActive && !actuator.outputsActive();
}

bool nvsMutationAllowed() {
  // NVS disables the external-memory cache. It is admitted only at the same
  // fully-idle boundary as other flash writes, and never while OTA owns flash.
  return actuatorFullyIdle() && !otaReservesPort80();
}

uint32_t logArchiveCount = 0;

// Applied calibration coefficients live in device NVS so the device — not any
// one browser profile — is the source of truth Crackle reads them back from.
// The firmware stores and serves them; it does not use them for control.
constexpr char kCalibrationNamespace[] = "crackle-cal";
struct AppliedCalibration {
  bool present = false;
  float heaterGain = 0.0f;
  float fanCooling = 0.0f;
  float coolingFan = 0.0f;
  float lossPerMin = 0.0f;
  char fitId[48] = {0};
  uint32_t appliedEpoch = 0;
};
AppliedCalibration appliedCalibration;

// Physically plausible coefficient ranges, deliberately generous: the point is
// to reject zeros, garbage, and sign errors — a journey inverting a model with
// no heater authority saturates heat at the zone maximum, which "present" alone
// cannot catch. Enforced at apply, at NVS load, and at journey start.
bool plausibleCalibration(const AppliedCalibration& cal) {
  return cal.present &&
         // Gain and loss are coupled; gain / loss determines steady-state
         // authority. Reject zero/sign errors without imposing a standalone
         // lower bound that valid low-loss measurements can fall below.
         cal.heaterGain >= 0.1f && cal.heaterGain <= 500.0f &&
         cal.fanCooling >= 0.5f && cal.fanCooling <= 200.0f &&
         cal.coolingFan >= 1.0f && cal.coolingFan <= 300.0f &&
         cal.lossPerMin >= 0.005f && cal.lossPerMin <= 2.0f;
}

bool readAppliedCalibration(AppliedCalibration& loaded) {
  Preferences store;
  if (!store.begin(kCalibrationNamespace, true)) return false;
  loaded = AppliedCalibration{};
  loaded.present = store.getBool("present", false);
  loaded.heaterGain = store.getFloat("gain", 0.0f);
  loaded.fanCooling = store.getFloat("fancool", 0.0f);
  loaded.coolingFan = store.getFloat("coolfan", 0.0f);
  loaded.lossPerMin = store.getFloat("loss", 0.0f);
  String fitId = store.getString("fitid", "");
  strlcpy(loaded.fitId, fitId.c_str(), sizeof(loaded.fitId));
  loaded.appliedEpoch = store.getUInt("epoch", 0);
  store.end();
  return true;
}

void adoptAppliedCalibration(const AppliedCalibration& loaded) {
  // Stored values a past image accepted are re-checked on the way in: an
  // implausible set is treated as absent rather than trusted into a journey.
  if (!loaded.present || !plausibleCalibration(loaded)) {
    appliedCalibration = AppliedCalibration{};
  } else {
    appliedCalibration = loaded;
  }
}

void loadAppliedCalibration() {
  AppliedCalibration loaded;
  // A failed read leaves the last known RAM state alone. On boot that state is
  // absent; after a failed write it is the prior value, which is safer than
  // claiming an unverified candidate.
  if (readAppliedCalibration(loaded)) adoptAppliedCalibration(loaded);
}

bool sameAppliedCalibration(const AppliedCalibration& left,
                            const AppliedCalibration& right) {
  return left.present == right.present &&
         left.heaterGain == right.heaterGain &&
         left.fanCooling == right.fanCooling &&
         left.coolingFan == right.coolingFan &&
         left.lossPerMin == right.lossPerMin &&
         strcmp(left.fitId, right.fitId) == 0 &&
         left.appliedEpoch == right.appliedEpoch;
}

bool saveAppliedCalibration(const AppliedCalibration& candidate) {
  Preferences store;
  if (!store.begin(kCalibrationNamespace, false)) return false;

  // Invalidate first. Until this marker is durably false, RAM continues to
  // represent the prior verified value. Once it lands, every later failure is
  // fail-closed: RAM is absent and a reboot also sees the false marker.
  const bool invalidated =
      store.putBool("present", false) == sizeof(bool);
  if (!invalidated) {
    store.end();
    return false;
  }
  appliedCalibration = AppliedCalibration{};

  // Clear is marker-only. Old payload bytes are harmless while present=false,
  // and avoiding six irrelevant writes makes the destructive operation both
  // smaller and easier to verify.
  if (!candidate.present) {
    store.end();
    AppliedCalibration stored;
    return readAppliedCalibration(stored) && !stored.present;
  }

  bool written = store.putFloat("gain", candidate.heaterGain) == sizeof(float);
  if (written) {
    written =
        store.putFloat("fancool", candidate.fanCooling) == sizeof(float);
  }
  if (written) {
    written =
        store.putFloat("coolfan", candidate.coolingFan) == sizeof(float);
  }
  if (written) {
    written = store.putFloat("loss", candidate.lossPerMin) == sizeof(float);
  }
  if (written) {
    written = store.putString("fitid", candidate.fitId) ==
        strlen(candidate.fitId);
  }
  if (written) {
    written =
        store.putUInt("epoch", candidate.appliedEpoch) == sizeof(uint32_t);
  }
  // The validity marker is the final commit and is never attempted after a
  // failed payload write.
  if (written) {
    written = store.putBool("present", true) == sizeof(bool);
  }
  store.end();
  if (!written) return false;

  AppliedCalibration stored;
  if (readAppliedCalibration(stored) &&
      sameAppliedCalibration(stored, candidate)) {
    appliedCalibration = candidate;
    return true;
  }

  // The final marker may have landed even though exact readback failed. Make a
  // best-effort second invalidation so a reboot does not trust an unverified
  // value. True rollback of the prior calibration would require dual NVS slots;
  // this single-slot format deliberately prefers safe absence.
  Preferences invalidator;
  if (invalidator.begin(kCalibrationNamespace, false)) {
    invalidator.putBool("present", false);
    invalidator.end();
  }
  appliedCalibration = AppliedCalibration{};
  return false;
}
// The batch the stored coefficients describe. The fit is always taken against
// the 225 g reference the browser's model uses, and the inversion scales any
// other mass against it, so the reference travels with the coefficients rather
// than being asked for per roast.
constexpr double kRoastReferenceBatchMassG = 225.0;
// With no cold-junction reading at all there is no honest ambient to use, so
// fall back to the same 24.5 C the browser's model defaults to and say so.
constexpr double kRoastFallbackAmbientC = 24.5;

// Stage and launch a roast program. Every mode-specific field is written before
// the first actuator request is issued, and NOTHING is marked active until that
// request has been accepted - a rejected start must leave the device exactly as
// it found it.
bool startRoast(RoastMode mode, const char* name,
                const uint32_t* stepFans, const uint32_t* stepHeats,
                const uint32_t* stepSeconds, size_t stepCount,
                const sr800::JourneyZone* zones, size_t zoneCount,
                double batchMassG, double ambientC, bool recordThermalLog,
                const char*& rejection) {
  if (thermalLog == nullptr) {
    rejection = "External recording memory is unavailable.";
    return false;
  }
  // A newly accepted start preempts the post-stop cooling tail immediately.
  preemptPostStopCoolingTail(micros());
  if (fanTestActive || heaterProofPhase != HeaterProofPhase::IDLE ||
      calibrationActive || manualActive ||
      roastActive || actuator.outputsActive()) {
    rejection = "Another actuator operation is active.";
    return false;
  }
  StorageMutationGuard storage(true, true);
  if (!storage) {
    rejection = kStorageBusyStartRejection;
    return false;
  }
  // Close and persist the previous episode's log now, while outputs are still

  // idle: a flash write during actuation stalls the MCPWM capture callbacks.

  if (!takeOverPriorRecordingForNewEpisode(rejection)) {
    return false;
  }
  if (!enterActuationWifiAwakeMode()) {
    rejection = "Wi-Fi awake mode could not be enabled.";
    return false;
  }

  roastMode = mode;
  memset(roastName, 0, sizeof(roastName));
  strlcpy(roastName, name, sizeof(roastName));
  roastStepCount = 0;
  roastStepIndex = 0;
  roastHeatObserved = false;
  roastZoneCount = 0;
  roastControlState = sr800::initialJourneyControlState();
  roastAmbientC = ambientC;
  roastBatchMassG = batchMassG;
  roastTargetC = 0.0;
  roastCorrectionTotal = 0.0;
  roastIntegral = 0.0;
  roastCommandFan = 0.0;
  roastCommandHeat = 0.0;
  roastCommandFanMilli = 0;
  roastCommandHeatMilli = 0;
  roastHoldover = false;
  roastSaturated = false;
  roastHeatContinuity.reset();
  roastElapsedSec = 0;
  roastStopSec = 0;
  roastRenewals = 0;
  for (size_t index = 0; index < sr800::kMaxJourneyZones; ++index) {
    roastZoneAttainedSec[index] = kRoastZoneNotAttained;
  }

  uint32_t firstFanMilli = 0;
  uint32_t firstHeatMilli = 0;
  if (mode == RoastMode::TIMED) {
    for (size_t index = 0; index < kRoastMaxSteps; ++index) {
      roastStepFanMilli[index] = index < stepCount ? stepFans[index] : 0;
      roastStepHeatMilli[index] = index < stepCount ? stepHeats[index] : 0;
      roastStepSeconds[index] = index < stepCount ? stepSeconds[index] : 0;
    }
    roastStepCount = stepCount;
    firstFanMilli = roastStepFanMilli[0];
    firstHeatMilli = roastStepHeatMilli[0];
  } else if (mode == RoastMode::JOURNEY) {
    for (size_t index = 0;
         index < zoneCount && index < sr800::kMaxJourneyZones; ++index) {
      roastZones[index] = zones[index];
    }
    roastZoneCount = zoneCount;
    roastCalibration.heaterGainCPerMinAt10 = appliedCalibration.heaterGain;
    roastCalibration.fanCoolingCPerMinAt10 = appliedCalibration.fanCooling;
    roastCalibration.coolingFanCPerMinAt10 = appliedCalibration.coolingFan;
    roastCalibration.thermalLossPerMinPerC = appliedCalibration.lossPerMin;
    roastCalibration.referenceBatchMassG = kRoastReferenceBatchMassG;

    sr800::JourneyPlan plan;
    plan.zones = roastZones;
    plan.zoneCount = roastZoneCount;
    // The opening command is the same feed-forward solve the 1 Hz tick makes,
    // taken at t = 0 so the roaster does not spend its first second idle.
    const double openingC = isnan(maxThermocoupleC)
        ? roastZones[0].startC : static_cast<double>(maxThermocoupleC);
    const sr800::JourneyCommand first = sr800::journeyCommand(
        plan, 0.0, openingC, roastAmbientC, roastBatchMassG, roastCalibration,
        0.0, 0, 0.0);
    firstFanMilli = roastLevelToMilli(first.fan);
    firstHeatMilli = roastLevelToMilli(first.heat);
    roastCommandFan = first.fan;
    roastCommandHeat = first.heat;
    roastTargetC = first.goalC;
  } else {
    // Manual start passes its initial instruction through the first step slots;
    // it is not a timed step and has no duration or autonomous advance.
    firstFanMilli = stepFans[0];
    firstHeatMilli = stepHeats[0];
    roastCommandFan = firstFanMilli / 1000.0;
    roastCommandHeat = firstHeatMilli / 1000.0;
  }

  // Reserve the archive identity and immutable plan while outputs are still
  // idle. nextLogArchiveId writes NVS, which must never start after actuation.
  roastCommandFanMilli = firstFanMilli;
  roastCommandHeatMilli = firstHeatMilli;
  startThermalLog(ThermalLogSource::ROAST,
                  recordThermalLog ? kThermalLogIntervalMs
                                   : kCompactRoastLogIntervalMs);
  captureInitialRoastArchivePlan();
  roastEndReason = "none";
  // Flash cannot be touched after the actuator accepts the command. Commit a
  // valid plan-only archive first so power loss during the roast or passive
  // tail still leaves an authoritative occurrence. A synchronous
  // request rejection removes it below.
  if (!persistProvisionalRoastArchive()) {
    rejection = "The roast occurrence could not be committed to storage.";
    rollbackThermalLogStart();
    roastArchivePlanValid = false;
    exitActuationWifiAwakeMode();
    return false;
  }

  if (!waitForActuationStartTiming(rejection)) {
    roastMode = RoastMode::NONE;
    roastZoneCount = 0;
    roastStepCount = 0;
    discardProvisionalRoastArchive();
    rollbackThermalLogStart();
    roastArchivePlanValid = false;
    exitActuationWifiAwakeMode();
    return false;
  }

  // Start clocks are captured only after storage work and timing
  // requalification, so elapsed time begins with the accepted command.
  const uint32_t nowUs = micros();
  const uint32_t nowMs = millis();
  const char* requestRejection = nullptr;
  if (!actuator.request(firstFanMilli, firstHeatMilli, nowUs, requestRejection,
                        firstHeatMilli > 0 ? kHeaterProofMaximumMs * 1000U
                                           : 0)) {
    rejection = requestRejection;
    roastMode = RoastMode::NONE;
    roastZoneCount = 0;
    roastStepCount = 0;
    // The actuator rejected the start while outputs are still idle. Remove the
    // provisional file so a failed request is not retained as an occurrence.
    discardProvisionalRoastArchive();
    rollbackThermalLogStart();
    roastArchivePlanValid = false;
    exitActuationWifiAwakeMode();
    return false;
  }

  const sr800::ActuatorSnapshot acceptedStart = actuator.snapshot(nowUs);
  roastHeatObserved = firstHeatMilli == 0 ||
      acceptedStart.effectiveHeatMilli > 0;
  roastStepStartedUs = nowUs;
  roastStepDwellRemainingSec = mode == RoastMode::TIMED ? roastStepSeconds[0] : 0;
  roastStepDeadlineArmed = mode == RoastMode::TIMED && firstHeatMilli == 0;
  roastStepEndUs = roastStepDeadlineArmed
      ? nowUs + roastStepDwellRemainingSec * 1000000U : 0;
  roastLastRenewUs = nowUs;
  roastLastInstructionMs = mode == RoastMode::MANUAL ? nowMs : 0;
  roastStartedMs = nowMs;
  roastLastTickMs = nowMs;
  const time_t nowEpoch = time(nullptr);
  roastStartEpoch =
      nowEpoch > 1600000000 ? static_cast<uint32_t>(nowEpoch) : 0;
  double plannedTotalSec = 0.0;
  if (mode == RoastMode::TIMED) {
    for (size_t index = 0; index < stepCount; ++index) {
      plannedTotalSec += stepSeconds[index];
    }
  } else if (mode == RoastMode::JOURNEY) {
    for (size_t index = 0; index < zoneCount; ++index) {
      plannedTotalSec += zones[index].durationSec;
    }
  }
  roastEnvelopeSec =
      mode == RoastMode::MANUAL
          ? 0U
          : static_cast<uint32_t>(plannedTotalSec * 2.0) +
                kRoastEnvelopeMarginSec;
  roastEndReason = "none";
  roastSessionCounter++;
  if (roastSessionCounter == 0) roastSessionCounter = 1;
  roastSessionId = roastSessionCounter;
  roastActive = true;
  return true;
}

void logArchivePath(char* out, size_t length, uint32_t logId) {
  snprintf(out, length, "%s/%lu.crk", kLogArchiveDir,
           static_cast<unsigned long>(logId));
}

// Filename stem -> log id; returns 0 (never a valid id) on a foreign name.
uint32_t logArchiveIdFromName(const char* name) {
  const char* base = strrchr(name, '/');
  base = base == nullptr ? name : base + 1;
  char* end = nullptr;
  const unsigned long value = strtoul(base, &end, 10);
  if (end == base || strcmp(end, ".crk") != 0) return 0;
  return static_cast<uint32_t>(value);
}

uint32_t countArchivedLogs() {
  uint32_t count = 0;
  File dir = LittleFS.open(kLogArchiveDir);
  if (!dir || !dir.isDirectory()) return 0;
  for (File entry = dir.openNextFile(); entry; entry = dir.openNextFile()) {
    if (!entry.isDirectory() && logArchiveIdFromName(entry.name()) != 0) {
      count++;
    }
    pacedYield();
  }
  return count;
}

const char* storageFailureStageName(StorageFailureStage stage) {
  switch (stage) {
    case StorageFailureStage::PARTITION_MISSING: return "partition_missing";
    case StorageFailureStage::LAYOUT_MISMATCH: return "layout_mismatch";
    case StorageFailureStage::MARKER_WRITE: return "marker_write";
    case StorageFailureStage::MOUNT: return "mount";
    case StorageFailureStage::FORMAT: return "format";
    case StorageFailureStage::PROBE_DEST_OPEN: return "probe_dest_open";
    case StorageFailureStage::PROBE_DEST_WRITE: return "probe_dest_write";
    case StorageFailureStage::PROBE_TEMP_OPEN: return "probe_temp_open";
    case StorageFailureStage::PROBE_TEMP_WRITE: return "probe_temp_write";
    case StorageFailureStage::PROBE_RENAME: return "probe_rename";
    case StorageFailureStage::PROBE_VERIFY: return "probe_verify";
    case StorageFailureStage::LOG_DIRECTORY: return "log_directory";
    case StorageFailureStage::DATA_DIRECTORY: return "data_directory";
    case StorageFailureStage::ARCHIVE_WRITE: return "archive_write";
    case StorageFailureStage::ARCHIVE_RENAME: return "archive_rename";
    case StorageFailureStage::DOCUMENT_WRITE: return "document_write";
    case StorageFailureStage::DOCUMENT_RENAME: return "document_rename";
    default: return "none";
  }
}

void recordStorageFailure(StorageFailureStage stage) {
  storageFailureStage = stage;
  storageFailureFreeHeapBytes = ESP.getFreeHeap();
  storageFailureMinFreeHeapBytes = ESP.getMinFreeHeap();
  storageFailureLargestBlockBytes = ESP.getMaxAllocHeap();
  if (stage != StorageFailureStage::NONE) storageWriteFailures++;
}


class StorageRequestGuard {
 public:
  StorageRequestGuard() {
    if (otaReservesPort80()) return;
    const TaskHandle_t current = xTaskGetCurrentTaskHandle();
    const uint32_t nowMs = millis();
    // Match StorageMutationGuard's storage-then-OTA lock order.
    portENTER_CRITICAL(&storageMutationMux);
    if (otaReservesPort80()) {
      portEXIT_CRITICAL(&storageMutationMux);
      return;
    }
    const bool mutationPriorityActive =
        storageMutationPriorityActive &&
        sr800::runtime::deadlinePending(
            nowMs, storageMutationPriorityUntilMs);
    if (!mutationPriorityActive) {
      storageMutationPriorityActive = false;
      storageMutationPriorityUntilMs = 0;
    }
    acquired_ = !storageRequestActive && !storageMutationActive &&
                !mutationPriorityActive;
    if (acquired_) {
      storageRequestActive = true;
      storageRequestOwner = current;
    }
    portEXIT_CRITICAL(&storageMutationMux);
  }
  ~StorageRequestGuard() {
    if (!acquired_) return;
    portENTER_CRITICAL(&storageMutationMux);
    storageRequestOwner = nullptr;
    storageRequestActive = false;
    portEXIT_CRITICAL(&storageMutationMux);
  }
  explicit operator bool() const { return acquired_; }

 private:
  bool acquired_ = false;
};

bool currentArchiveLayout(sr800::storage::Layout& out) {
  const esp_partition_t* partition = esp_partition_find_first(
      ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_SPIFFS, "spiffs");
  if (partition == nullptr) return false;
  out.offset = partition->address;
  out.size = partition->size;
  out.formatVersion = sr800::storage::kFilesystemFormatVersion;
  storageExpectedOffset = out.offset;
  storageExpectedSize = out.size;
  return true;
}

bool archivePartitionAppearsErased() {
  const esp_partition_t* partition = esp_partition_find_first(
      ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_SPIFFS, "spiffs");
  if (partition == nullptr) return false;
  uint8_t bytes[256];
  for (size_t offset = 0; offset < partition->size; offset += sizeof(bytes)) {
    const size_t remaining = partition->size - offset;
    const size_t count = remaining < sizeof(bytes) ? remaining : sizeof(bytes);
    if (esp_partition_read(partition, offset, bytes, count) != ESP_OK) {
      return false;
    }
    for (size_t index = 0; index < count; ++index) {
      if (bytes[index] != 0xFFU) return false;
    }
  }
  return true;
}

sr800::storage::Marker archiveFilesystemMarker() {
  sr800::storage::Marker marker = {};
  storageMarkerPresent = false;
  storageStoredOffset = 0;
  storageStoredSize = 0;
  storageStoredFormatVersion = 0;
  Preferences diagnostics;
  if (!diagnostics.begin(kDiagnosticsNamespace, true)) return marker;
  marker.initialized = diagnostics.getBool("fsinit", false);
  marker.hasLayout = marker.initialized && diagnostics.isKey("fsaddr") &&
      diagnostics.isKey("fssize") && diagnostics.isKey("fsver");
  if (marker.hasLayout) {
    marker.layout.offset = diagnostics.getUInt("fsaddr", 0);
    marker.layout.size = diagnostics.getUInt("fssize", 0);
    marker.layout.formatVersion = diagnostics.getUShort("fsver", 0);
  }
  diagnostics.end();
  storageMarkerPresent = marker.initialized;
  storageStoredOffset = marker.layout.offset;
  storageStoredSize = marker.layout.size;
  storageStoredFormatVersion = marker.layout.formatVersion;
  return marker;
}

bool setArchiveFilesystemMarker(const sr800::storage::Layout& layout) {
  Preferences diagnostics;
  if (!diagnostics.begin(kDiagnosticsNamespace, false)) {
    recordStorageFailure(StorageFailureStage::MARKER_WRITE);
    return false;
  }
  // Mark initialized first. If a later geometry write fails, the next boot
  // sees an initialized-but-incomplete marker and fails closed, never FRESH.
  const bool written = diagnostics.putBool("fsinit", true) == 1 &&
      diagnostics.putUInt("fsaddr", layout.offset) == sizeof(uint32_t) &&
      diagnostics.putUInt("fssize", layout.size) == sizeof(uint32_t) &&
      diagnostics.putUShort("fsver", layout.formatVersion) == sizeof(uint16_t);
  diagnostics.end();
  if (!written) {
    recordStorageFailure(StorageFailureStage::MARKER_WRITE);
    return false;
  }

  // Preferences writes are not accepted on return value alone. Reopen the
  // namespace read-only and require the exact geometry/version to round-trip
  // before RAM or filesystem health can be declared current.
  const sr800::storage::Marker verified = archiveFilesystemMarker();
  if (!verified.initialized || !verified.hasLayout ||
      !sr800::storage::sameLayout(verified.layout, layout)) {
    recordStorageFailure(StorageFailureStage::MARKER_WRITE);
    return false;
  }
  return true;
}

bool probeArchiveFilesystem() {
  constexpr char kProbeTempPath[] = "/storage-probe.tmp";
  constexpr char kProbeDestinationPath[] = "/storage-probe.ok";
  constexpr uint8_t kOldBytes[] = {0x4F, 0x4C, 0x44};
  constexpr uint8_t kNewBytes[] = {0x43, 0x52, 0x4B, 0x31};
  LittleFS.remove(kProbeTempPath);
  LittleFS.remove(kProbeDestinationPath);

  File destination = LittleFS.open(kProbeDestinationPath, "w");
  if (!destination) {
    recordStorageFailure(StorageFailureStage::PROBE_DEST_OPEN);
    return false;
  }
  bool ok = destination.write(kOldBytes, sizeof(kOldBytes)) == sizeof(kOldBytes);
  destination.close();
  if (!ok) {
    recordStorageFailure(StorageFailureStage::PROBE_DEST_WRITE);
    LittleFS.remove(kProbeDestinationPath);
    return false;
  }

  File temporary = LittleFS.open(kProbeTempPath, "w");
  if (!temporary) {
    recordStorageFailure(StorageFailureStage::PROBE_TEMP_OPEN);
    LittleFS.remove(kProbeDestinationPath);
    return false;
  }
  ok = temporary.write(kNewBytes, sizeof(kNewBytes)) == sizeof(kNewBytes);
  // ESP32's VFS File::size() uses stat(), while File::write() is stdio-buffered.
  // Flush first or a successful small write can still report the old on-disk
  // size and falsely condemn a freshly formatted LittleFS volume.
  if (ok) temporary.flush();
  if (ok) ok = temporary.size() == sizeof(kNewBytes);
  temporary.close();
  if (!ok) {
    recordStorageFailure(StorageFailureStage::PROBE_TEMP_WRITE);
    LittleFS.remove(kProbeTempPath);
    LittleFS.remove(kProbeDestinationPath);
    return false;
  }
  if (!LittleFS.rename(kProbeTempPath, kProbeDestinationPath)) {
    recordStorageFailure(StorageFailureStage::PROBE_RENAME);
    LittleFS.remove(kProbeTempPath);
    LittleFS.remove(kProbeDestinationPath);
    return false;
  }

  File verified = LittleFS.open(kProbeDestinationPath, "r");
  uint8_t bytes[sizeof(kNewBytes)] = {};
  ok = verified && verified.size() == sizeof(kNewBytes) &&
      verified.read(bytes, sizeof(bytes)) == sizeof(bytes) &&
      memcmp(bytes, kNewBytes, sizeof(bytes)) == 0;
  if (verified) verified.close();
  LittleFS.remove(kProbeDestinationPath);
  if (!ok) {
    recordStorageFailure(StorageFailureStage::PROBE_VERIFY);
    return false;
  }
  storageFailureStage = StorageFailureStage::NONE;
  return true;
}

// ---------------------------------------------------------------------------
// On-device document store: the storage layer.
//
// The user's app data — roast metadata, bean lots, profiles, calibration fits
// — lives HERE, on the controller, not in any browser's local storage. A phone
// and a PC both read this store, so they see identical state; the web app is a
// cache over it. Telemetry is not here: the 1 Hz sample series stays in the
// recordings archive under /logs. These are the small metadata documents that
// describe those recordings and everything around them.
//
// The firmware never parses a stored document. It owns a 16-byte envelope and
// nothing else; the bytes after the envelope are the client's business. That is
// what lets the web schema evolve without a firmware release.
//
// Same volume as the recordings archive, therefore the same rule: FLASH WRITES
// ONLY WHILE THE ACTUATOR IS FULLY IDLE. Reads are always allowed.
constexpr char kDataDir[] = "/data";
constexpr char kDataRunsDir[] = "/data/runs";
constexpr char kDataTempPath[] = "/data/pending.tmp";
constexpr size_t kMaxListedRuns = 400;
constexpr size_t kManifestPageEntries = 64;

struct StoredDocInfo {
  bool exists = false;
  // True only when the envelope decoded AND the file size agrees with the
  // length it declares. A half-written or corrupted document is never reported
  // as an empty one.
  bool readable = false;
  uint32_t docVersion = 0;
  uint32_t payloadBytes = 0;
  uint32_t fileBytes = 0;
};

struct DataCollectionSummary {
  bool present = false;
  uint32_t version = 0;
  uint32_t bytes = 0;
};

bool dataStoreMounted = false;
uint32_t dataStoreUsedBytes = 0;
uint32_t dataStoreRunCount = 0;
uint32_t dataStoreRunBytes = 0;
DataCollectionSummary
    dataCollectionSummary[sr800::docstore::kCollectionCount];

// Describe an already-open file. Used while walking a directory so no second
// handle is opened inside the iteration.
StoredDocInfo describeOpenDoc(File& file) {
  StoredDocInfo info;
  info.exists = true;
  info.fileBytes = static_cast<uint32_t>(file.size());
  uint8_t prefixBytes[sr800::docstore::kPrefixBytes];
  if (file.read(prefixBytes, sizeof(prefixBytes)) != sizeof(prefixBytes)) {
    return info;
  }
  sr800::docstore::Prefix prefix;
  if (!sr800::docstore::decodePrefix(prefixBytes, prefix)) return info;
  if (info.fileBytes !=
      static_cast<uint32_t>(sr800::docstore::kPrefixBytes) +
          prefix.byteLength) {
    return info;
  }
  info.readable = true;
  info.docVersion = prefix.docVersion;
  info.payloadBytes = prefix.byteLength;
  return info;
}

StoredDocInfo readStoredDoc(const char* path) {
  StoredDocInfo info;
  File file = LittleFS.open(path, "r");
  if (!file) return info;
  if (file.isDirectory()) {
    file.close();
    return info;
  }
  info = describeOpenDoc(file);
  file.close();
  return info;
}

// Cached so /api/status never has to walk the tree. Recomputed at mount and
// after every successful write or delete — the only things that change it.
void refreshDataStoreStats() {
  for (size_t index = 0; index < sr800::docstore::kCollectionCount; ++index) {
    dataCollectionSummary[index] = DataCollectionSummary{};
  }
  dataStoreUsedBytes = 0;
  dataStoreRunCount = 0;
  dataStoreRunBytes = 0;
  if (!dataStoreMounted) return;

  char path[sr800::docstore::kMaxPathBytes];
  for (size_t index = 0; index < sr800::docstore::kCollectionCount; ++index) {
    const auto collection = static_cast<sr800::docstore::Collection>(index);
    if (!sr800::docstore::collectionPath(path, sizeof(path), collection)) {
      continue;
    }
    const StoredDocInfo info = readStoredDoc(path);
    if (!info.exists) continue;
    dataCollectionSummary[index].present = true;
    dataCollectionSummary[index].version = info.docVersion;
    dataCollectionSummary[index].bytes = info.payloadBytes;
  }

  // used_bytes is the on-disk footprint of the whole /data tree, strays and
  // envelopes included — it is a capacity number, not a sum of payloads.
  File root = LittleFS.open(kDataDir);
  if (root && root.isDirectory()) {
    for (File entry = root.openNextFile(); entry;
         entry = root.openNextFile()) {
      pacedYield();
      if (entry.isDirectory()) continue;
      dataStoreUsedBytes += static_cast<uint32_t>(entry.size());
    }
  }
  File runs = LittleFS.open(kDataRunsDir);
  if (runs && runs.isDirectory()) {
    for (File entry = runs.openNextFile(); entry;
         entry = runs.openNextFile()) {
      pacedYield();
      if (entry.isDirectory()) continue;
      dataStoreUsedBytes += static_cast<uint32_t>(entry.size());
      char id[sr800::docstore::kRunIdMaxChars + 1];
      if (!sr800::docstore::runIdFromFileName(entry.name(), id, sizeof(id))) {
        continue;
      }
      const StoredDocInfo info = describeOpenDoc(entry);
      if (!info.readable) continue;
      dataStoreRunCount++;
      dataStoreRunBytes += info.payloadBytes;
    }
  }
}

// A save or delete changes exactly one document, so the cached figures move by that document's
// before/after envelope instead of a whole-tree walk that opened every run document (a measured
// 1.02 s for a 1.1 KB save, growing with the library, and the browser saves the staged run record
// immediately before Start). Mirrors refreshDataStoreStats:
// used bytes sum file sizes; runs count readable run documents; a collection is present when its
// file exists.
void applyStoredDocDelta(const char* path, const StoredDocInfo& before,
                         const StoredDocInfo& after) {
  const int64_t used = static_cast<int64_t>(dataStoreUsedBytes) +
      static_cast<int64_t>(after.exists ? after.fileBytes : 0) -
      static_cast<int64_t>(before.exists ? before.fileBytes : 0);
  dataStoreUsedBytes = used > 0 ? static_cast<uint32_t>(used) : 0;
  const size_t runsPrefix = strlen(kDataRunsDir);
  if (strncmp(path, kDataRunsDir, runsPrefix) == 0 && path[runsPrefix] == '/') {
    const int64_t count = static_cast<int64_t>(dataStoreRunCount) +
        (after.readable ? 1 : 0) - (before.readable ? 1 : 0);
    const int64_t bytes = static_cast<int64_t>(dataStoreRunBytes) +
        static_cast<int64_t>(after.readable ? after.payloadBytes : 0) -
        static_cast<int64_t>(before.readable ? before.payloadBytes : 0);
    dataStoreRunCount = count > 0 ? static_cast<uint32_t>(count) : 0;
    dataStoreRunBytes = bytes > 0 ? static_cast<uint32_t>(bytes) : 0;
    return;
  }
  char collectionPath[sr800::docstore::kMaxPathBytes];
  for (size_t index = 0; index < sr800::docstore::kCollectionCount; ++index) {
    if (!sr800::docstore::collectionPath(
            collectionPath, sizeof(collectionPath),
            static_cast<sr800::docstore::Collection>(index)) ||
        strcmp(collectionPath, path) != 0) {
      continue;
    }
    dataCollectionSummary[index] = DataCollectionSummary{};
    if (after.exists) {
      dataCollectionSummary[index].present = true;
      dataCollectionSummary[index].version = after.docVersion;
      dataCollectionSummary[index].bytes = after.payloadBytes;
    }
    return;
  }
}

// The store rides the archive's volume, so it is ready exactly when the archive
// is mounted. Called from the mount path and after an operator-confirmed format.
void prepareDataStore() {
  dataStoreMounted = false;
  if (logArchiveMounted) {
    const bool dataDirectoryReady = LittleFS.exists(kDataDir) ||
        LittleFS.mkdir(kDataDir);
    const bool runsDirectoryReady = dataDirectoryReady &&
        (LittleFS.exists(kDataRunsDir) || LittleFS.mkdir(kDataRunsDir));
    // A stale temp file is a document write that lost power mid-stream. The
    // real document was never touched; discard the remnant.
    LittleFS.remove(kDataTempPath);
    dataStoreMounted = dataDirectoryReady && runsDirectoryReady &&
        LittleFS.exists(kDataDir) && LittleFS.exists(kDataRunsDir);
    if (!dataStoreMounted) {
      recordStorageFailure(StorageFailureStage::DATA_DIRECTORY);
    }
  }
  refreshDataStoreStats();
}

// Temp file plus rename, exactly like the archive's persist: power loss during
// a document write can never leave a truncated file under the document's real
// name. Only ever called with the actuator fully idle.
//
// The sequence itself — and specifically what it does when a step fails — lives
// in the pure layer as `replaceDocument`, so the failure paths are host-tested
// rather than reasoned about. These three callbacks are the filesystem half.
struct DocWriteRequest {
  const char* path;
  uint32_t docVersion;
  const String* payload;
};

bool docWriteTemp(void* context) {
  const DocWriteRequest& request = *static_cast<DocWriteRequest*>(context);
  const String& payload = *request.payload;
  LittleFS.remove(kDataTempPath);
  File file = LittleFS.open(kDataTempPath, "w");
  if (!file) return false;
  sr800::docstore::Prefix prefix;
  prefix.prefixVersion = sr800::docstore::kPrefixVersion;
  prefix.reserved = 0;
  prefix.docVersion = request.docVersion;
  prefix.byteLength = static_cast<uint32_t>(payload.length());
  uint8_t prefixBytes[sr800::docstore::kPrefixBytes];
  sr800::docstore::encodePrefix(prefix, prefixBytes);
  bool ok =
      file.write(prefixBytes, sizeof(prefixBytes)) == sizeof(prefixBytes);
  const uint8_t* bytes = reinterpret_cast<const uint8_t*>(payload.c_str());
  size_t remaining = payload.length();
  size_t offset = 0;
  while (ok && remaining > 0) {
    const size_t chunk = remaining > 1024 ? 1024 : remaining;
    ok = file.write(bytes + offset, chunk) == chunk;
    offset += chunk;
    remaining -= chunk;
    pacedYield();
  }
  if (ok) file.flush();
  if (ok) {
    ok = file.size() == sr800::docstore::kPrefixBytes + payload.length();
  }
  file.close();
  return ok;
}

// littlefs implements rename with POSIX replace semantics: the destination is
// replaced atomically and is never unlinked first. There is no fallback here,
// deliberately: deleting the existing document and retrying into the hole
// would let a second failure destroy the only copy of data the user already
// had, in service of a write that failed anyway.
bool docRenameOver(void* context) {
  const DocWriteRequest& request = *static_cast<DocWriteRequest*>(context);
  return LittleFS.rename(kDataTempPath, request.path);
}

void docRemoveTemp(void*) { LittleFS.remove(kDataTempPath); }

bool writeStoredDoc(const char* path, uint32_t docVersion,
                    const String& payload) {
  StorageMutationGuard mutation;
  if (!mutation) return false;
  DocWriteRequest request;
  request.path = path;
  request.docVersion = docVersion;
  request.payload = &payload;
  sr800::docstore::ReplaceCallbacks callbacks;
  callbacks.writeTemp = &docWriteTemp;
  callbacks.renameOver = &docRenameOver;
  callbacks.removeTemp = &docRemoveTemp;
  callbacks.context = &request;
  const sr800::docstore::ReplaceOutcome outcome =
      sr800::docstore::replaceDocument(callbacks);
  if (outcome == sr800::docstore::ReplaceOutcome::WRITE_FAILED) {
    recordStorageFailure(StorageFailureStage::DOCUMENT_WRITE);
  } else if (outcome == sr800::docstore::ReplaceOutcome::RENAME_FAILED) {
    recordStorageFailure(StorageFailureStage::DOCUMENT_RENAME);
  }
  return outcome == sr800::docstore::ReplaceOutcome::OK;
}

bool mountLogArchive() {
  StorageMutationGuard mutation;
  if (!mutation) return false;

  sr800::storage::Layout currentLayout = {};
  if (!currentArchiveLayout(currentLayout)) {
    recordStorageFailure(StorageFailureStage::PARTITION_MISSING);
    logArchiveNeedsFormat = true;
    prepareDataStore();
    return false;
  }
  const sr800::storage::Marker marker = archiveFilesystemMarker();
  const sr800::storage::LayoutVerdict layoutVerdict =
      sr800::storage::classifyLayout(marker, currentLayout);
  if (layoutVerdict == sr800::storage::LayoutVerdict::REQUIRES_FORMAT) {
    // An initialized filesystem with no geometry marker is from an older
    // image; a changed offset/size can expose unrelated bytes that happen to
    // mount. Never treat either case as healthy or silently erase it.
    recordStorageFailure(StorageFailureStage::LAYOUT_MISMATCH);
    logArchiveNeedsFormat = true;
    prepareDataStore();
    return false;
  }

  // The data partition is labeled "spiffs" but carries LittleFS. A genuinely
  // fresh layout may auto-format once. Any initialized layout fails closed and
  // waits for the explicit operator-confirmed format endpoint.
  bool mounted = LittleFS.begin(false, "/littlefs", 10, "spiffs") ||
                 LittleFS.begin(false, "/littlefs", 10, "spiffs");
  if (!mounted && layoutVerdict == sr800::storage::LayoutVerdict::FRESH &&
      archivePartitionAppearsErased()) {
    // NVS can fail independently of flash. Auto-format only an entirely erased
    // partition, so a real LittleFS volume can never be erased merely because
    // its marker could not be read or written.
    mounted = LittleFS.begin(true, "/littlefs", 10, "spiffs");
  }
  if (!mounted) {
    recordStorageFailure(StorageFailureStage::MOUNT);
    logArchiveNeedsFormat = true;
    prepareDataStore();
    return false;
  }
  if (!probeArchiveFilesystem()) {
    LittleFS.end();
    logArchiveNeedsFormat = true;
    logArchiveMounted = false;
    prepareDataStore();
    return false;
  }
  if (!LittleFS.exists(kLogArchiveDir) && !LittleFS.mkdir(kLogArchiveDir)) {
    recordStorageFailure(StorageFailureStage::LOG_DIRECTORY);
    LittleFS.end();
    logArchiveNeedsFormat = true;
    logArchiveMounted = false;
    prepareDataStore();
    return false;
  }
  LittleFS.remove(kLogArchiveTempPath);
  logArchiveMounted = true;
  logArchiveCount = countArchivedLogs();
  prepareDataStore();
  if (!dataStoreMounted) {
    if (storageFailureStage == StorageFailureStage::NONE) {
      recordStorageFailure(StorageFailureStage::DATA_DIRECTORY);
    }
    LittleFS.end();
    logArchiveNeedsFormat = true;
    logArchiveMounted = false;
    prepareDataStore();
    return false;
  }
  if (!setArchiveFilesystemMarker(currentLayout)) {
    LittleFS.end();
    logArchiveMounted = false;
    logArchiveNeedsFormat = true;
    prepareDataStore();
    return false;
  }
  storageFailureStage = StorageFailureStage::NONE;
  logArchiveNeedsFormat = false;
  return true;
}

// Explicit, operator-confirmed recovery for a corrupted archive filesystem. The
// only path that may destroy stored logs on a previously initialized volume.
void handleLogsFormat() {
  if (rejectMutationDuringRestore(true)) return;
  const bool restoreWrite = restoreTokenMatchesRequest();
  if (!requestHasArg("confirm") || requestArg("confirm") != "FORMAT_LOGS") {
    sendRequestResponse(409, "application/json",
                "{\"ok\":false,\"message\":\"Format confirmation is required.\"}");
    return;
  }
  if (!actuatorFullyIdle()) {
    sendRequestResponse(409, "application/json",
                "{\"ok\":false,\"message\":\"Formatting waits until actuation finishes.\"}");
    return;
  }
  const ThermalLogStateSnapshot recording = copyThermalLogState();
  if (recording.active || recording.unsaved) {
    sendRequestResponse(409, "application/json",
                "{\"ok\":false,\"message\":\"Formatting waits until the active or unsaved recording is finalized.\"}");
    return;
  }
  StorageMutationGuard mutation;
  if (!mutation) {
    sendRequestResponse(503, "application/json",
                "{\"ok\":false,\"message\":\"Another storage operation is still finishing.\"}");
    return;
  }
  sr800::storage::Layout currentLayout = {};
  if (!currentArchiveLayout(currentLayout)) {
    recordStorageFailure(StorageFailureStage::PARTITION_MISSING);
    logArchiveNeedsFormat = true;
    sendRequestResponse(500, "application/json",
                "{\"ok\":false,\"message\":\"The storage partition is missing from this firmware layout.\"}");
    return;
  }
  // This endpoint promises erasure, not merely "format if mount fails". Arduino's
  // LittleFS.begin(true) preserves any mountable filesystem, so explicitly
  // unmount and format the named partition before mounting the empty result.
  if (logArchiveMounted) {
    LittleFS.end();
    logArchiveMounted = false;
  }
  if (restoreWrite) markRestoreDirty();
  if (esp_littlefs_format("spiffs") != ESP_OK) {
    recordStorageFailure(StorageFailureStage::FORMAT);
    logArchiveNeedsFormat = true;
    prepareDataStore();
    sendRequestResponse(500, "application/json",
                "{\"ok\":false,\"message\":\"The storage partition could not be formatted.\"}");
    return;
  }
  const bool mounted = LittleFS.begin(false, "/littlefs", 10, "spiffs");
  if (!mounted) {
    recordStorageFailure(StorageFailureStage::MOUNT);
    logArchiveNeedsFormat = true;
    prepareDataStore();
    sendRequestResponse(500, "application/json",
                "{\"ok\":false,\"message\":\"The formatted filesystem could not be mounted.\"}");
    return;
  }
  if (!probeArchiveFilesystem()) {
    LittleFS.end();
    logArchiveNeedsFormat = true;
    prepareDataStore();
    sendRequestResponse(500, "application/json",
                "{\"ok\":false,\"message\":\"The formatted filesystem failed its write and rename health check.\"}");
    return;
  }
  if (!LittleFS.exists(kLogArchiveDir) && !LittleFS.mkdir(kLogArchiveDir)) {
    recordStorageFailure(StorageFailureStage::LOG_DIRECTORY);
    LittleFS.end();
    logArchiveNeedsFormat = true;
    prepareDataStore();
    sendRequestResponse(500, "application/json",
                "{\"ok\":false,\"message\":\"The recordings directory could not be created.\"}");
    return;
  }
  logArchiveMounted = true;
  logArchiveCount = 0;
  prepareDataStore();
  if (!dataStoreMounted) {
    LittleFS.end();
    logArchiveMounted = false;
    logArchiveNeedsFormat = true;
    prepareDataStore();
    sendRequestResponse(500, "application/json",
                "{\"ok\":false,\"message\":\"The app-data directories could not be created.\"}");
    return;
  }
  if (!setArchiveFilesystemMarker(currentLayout)) {
    LittleFS.end();
    logArchiveMounted = false;
    logArchiveNeedsFormat = true;
    prepareDataStore();
    sendRequestResponse(500, "application/json",
                "{\"ok\":false,\"message\":\"The filesystem was formatted, but its layout marker could not be verified. Storage remains unavailable.\"}");
    return;
  }
  storageFailureStage = StorageFailureStage::NONE;
  logArchiveNeedsFormat = false;
  if (!restoreWrite) advanceStateRevision();
  String response = F("{\"ok\":true,\"mounted\":true,\"data_store_erased\":true,\"state_rev\":\"");
  appendUint64Decimal(response, currentStateRevision());
  response += F("\"}");
  sendRequestResponse(200, "application/json", response);
}

constexpr uint32_t kMaxLogArchiveId = UINT32_MAX - 1U;

// How many issued-id steps ago `logId` is, on the valid 1..UINT32_MAX-1 ring.
// Zero is newest. This keeps chronology intact after the sequence wraps.
uint32_t logArchiveAge(uint32_t logId, uint32_t newestId) {
  if (logId == 0 || newestId == 0 || logId > kMaxLogArchiveId ||
      newestId > kMaxLogArchiveId) {
    return UINT32_MAX;
  }
  return newestId >= logId
      ? newestId - logId
      : (kMaxLogArchiveId - logId) + newestId;
}

uint32_t storedLogArchiveSequence() {
  Preferences diagnostics;
  if (!diagnostics.begin(kDiagnosticsNamespace, true)) return 0;
  const uint32_t stored = diagnostics.getUInt("logseq", 0);
  diagnostics.end();
  // Images predating the reserved-ceiling policy could have persisted MAX.
  return stored > kMaxLogArchiveId ? kMaxLogArchiveId : stored;
}

uint32_t nextLogArchiveId() {
  Preferences diagnostics;
  const bool preferencesOpen = diagnostics.begin(kDiagnosticsNamespace, false);
  const uint32_t previous = preferencesOpen
      ? diagnostics.getUInt("logseq", 0) : 0;
  // UINT32_MAX is reserved: advancing it wraps to zero, and recording zero is
  // deliberately not listable or fetchable. At rollover, search the finite set
  // of files actually on the volume and reuse the first positive hole.
  uint32_t candidate = previous >= kMaxLogArchiveId ? 1U : previous + 1U;
  const uint32_t first = candidate;
  do {
    char path[32];
    logArchivePath(path, sizeof(path), candidate);
    if (!LittleFS.exists(path)) {
      if (preferencesOpen) {
        diagnostics.putUInt("logseq", candidate);
        diagnostics.end();
      }
      return candidate;
    }
    candidate = candidate >= kMaxLogArchiveId ? 1U : candidate + 1U;
  } while (candidate != first);
  if (preferencesOpen) diagnostics.end();
  return 0;
}

// A single delete advances the manifest revision itself. The retention sweep
// passes advanceRevision=false and advances it ONCE after the sweep, so one
// Start that deletes many recordings commits NVS once, not once per file.
bool deleteArchivedLog(uint32_t logId, bool advanceRevision = true) {
  char path[32];
  logArchivePath(path, sizeof(path), logId);
  if (!LittleFS.exists(path)) return false;
  const bool removed = LittleFS.remove(path);
  if (removed) {
    if (logArchiveCount > 0) logArchiveCount--;
    // An idle-tail delete can target the provisional file. Mark it absent so
    // finalization recreates it and restores the archive count correctly.
    if (thermalLogProvisionalPersisted && logId == thermalLogReservedId) {
      thermalLogProvisionalPersisted = false;
    }
    // Deletion changes the manifest immediately, including retention sweeps
    // that may precede a later failed persist.
    if (advanceRevision) advanceStateRevision();
  }
  return removed;
}

// Delete oldest logs until the new file fits with headroom to spare. Age is
// measured backwards from the just-issued id on the valid-id ring, so after
// 4294967294 -> 1 the new low id is not mistaken for the oldest recording.
//
// This sweep enumerates ONLY /logs and deletes only /logs/<id>.crk. The
// document store's /data tree is never a deletion candidate here: a recording
// must never be able to erase the user's roast metadata, bean lots, profiles,
// or calibration fits. The free-space target stays volume-wide because the
// space really is shared and the archive still has to fit on the disk; what
// keeps /data from being the reason this sweep ever has work to do is the
// document store's write floor — the reserve below PLUS a whole worst-case
// recording — derived once in sr800_volume_budget.h.
bool enforceLogArchiveRetention(size_t bytesNeeded, uint32_t protectedId) {
  const size_t totalBytes = LittleFS.totalBytes();
  const size_t usedBytes = LittleFS.usedBytes();
  if (totalBytes == 0 || usedBytes > totalBytes ||
      totalBytes > UINT32_MAX || usedBytes > UINT32_MAX ||
      bytesNeeded > UINT32_MAX) {
    return false;
  }
  const uint64_t required = static_cast<uint64_t>(usedBytes) + bytesNeeded +
      kLogArchiveReserveBytes;
  if (required <= totalBytes) return true;

  // The planner can authorize at most 64 deletions. Keep the 65 oldest
  // candidates while enumerating so it can also prove when a 65th deletion
  // would be required, without allocating based on directory contents.
  constexpr size_t kCandidateCapacity =
      sr800::retention::kMaxPlannedDeletions + 1;
  sr800::retention::Archive candidates[kCandidateCapacity] = {};
  size_t candidateCount = 0;
  File dir = LittleFS.open(kLogArchiveDir);
  if (!dir || !dir.isDirectory()) return false;
  for (File entry = dir.openNextFile(); entry;
       entry = dir.openNextFile()) {
    pacedYield();
    const uint32_t logId = logArchiveIdFromName(entry.name());
    const size_t entryBytes = entry.size();
    if (logId == 0 || logId == protectedId || entryBytes == 0 ||
        entryBytes > UINT32_MAX) {
      continue;
    }
    const sr800::retention::Archive candidate = {
        logId, static_cast<uint32_t>(entryBytes),
        logArchiveAge(logId, protectedId)};
    if (candidateCount < kCandidateCapacity) {
      candidates[candidateCount++] = candidate;
      continue;
    }

    size_t youngest = 0;
    for (size_t index = 1; index < candidateCount; ++index) {
      if (candidates[index].age < candidates[youngest].age ||
          (candidates[index].age == candidates[youngest].age &&
           candidates[index].id > candidates[youngest].id)) {
        youngest = index;
      }
    }
    if (candidate.age > candidates[youngest].age ||
        (candidate.age == candidates[youngest].age &&
         candidate.id < candidates[youngest].id)) {
      candidates[youngest] = candidate;
    }
  }
  dir.close();

  const sr800::retention::Plan plan = sr800::retention::planLogRetention(
      static_cast<uint32_t>(totalBytes), static_cast<uint32_t>(usedBytes),
      static_cast<uint32_t>(bytesNeeded), kLogArchiveReserveBytes,
      protectedId, candidates, candidateCount);
  if (plan.verdict == sr800::retention::Verdict::IMPOSSIBLE) return false;
  bool deletedAny = false;
  bool sweepComplete = true;
  for (uint8_t index = 0; index < plan.count; ++index) {
    if (!deleteArchivedLog(plan.ids[index], false)) {
      sweepComplete = false;
      break;
    }
    deletedAny = true;
  }
  // One manifest revision for the whole sweep, published even when a later
  // delete or the persist that follows fails.
  if (deletedAny) advanceStateRevision();
  if (!sweepComplete) return false;

  return static_cast<uint64_t>(LittleFS.usedBytes()) + bytesNeeded +
      kLogArchiveReserveBytes <= LittleFS.totalBytes();
}

// Commit a valid plan-only archive before the first actuator command. This is
// deliberately a complete v4 file, not a private sidecar: after a reboot the
// normal list/fetch/export paths expose a zero-sample roast whose end reason is
// `none`, making an interrupted run explicit. Finalization atomically replaces
// the same id with the sampled archive.
// The commit must precede the actuator request. A power loss in that tiny
// interval can therefore retain an attempted-but-not-accepted zero-sample
// record; ordinary synchronous rejection removes it before returning.
bool persistProvisionalRoastArchive() {
  if (!logArchiveMounted || !actuatorFullyIdle() ||
      thermalLogSource != ThermalLogSource::ROAST ||
      thermalLogReservedId == 0 || !roastArchivePlanValid) {
    return false;
  }

  uint8_t planPayload[sr800::logcodec::kMaxPlanEnvelopeBytes];
  const size_t planBytes = sr800::logcodec::encodePlanProvenance(
      roastArchivePlan, planPayload, sizeof(planPayload));
  if (planBytes == 0) return false;

  LogArchiveHeader header = {};
  header.magic = kLogArchiveMagic;
  header.roastEndReason = 0;  // `none`: run has no durable end yet
  header.version = kLogArchiveVersion;
  header.source = static_cast<uint8_t>(ThermalLogSource::ROAST);
  header.logId = thermalLogReservedId;
  header.boot = bootCount;
  const time_t nowEpoch = time(nullptr);
  header.startEpoch = nowEpoch > 1600000000
      ? static_cast<uint32_t>(nowEpoch) : 0;
  header.durationMs = 0;
  header.sampleCount = 0;
  header.intervalMs = thermalLogIntervalMs;
  memcpy(header.name, roastName, strnlen(roastName, sizeof(header.name)));
  header.zoneCount = roastMode == RoastMode::JOURNEY
      ? static_cast<uint8_t>(roastZoneCount) : 0;
  header.roastMode = static_cast<uint8_t>(roastMode);
  header.batchMassG = static_cast<uint16_t>(roastBatchMassG);
  for (size_t index = 0; index < sr800::kMaxJourneyZones; ++index) {
    header.zoneAttainedSec[index] = kRoastZoneNotAttained;
  }
  header.codec = sr800::logcodec::kCodecDeltaVarintPlan;
  header.encodedBytes = static_cast<uint32_t>(planBytes);
  fillArchiveProvenance(header);
  header.crc32 = sr800::logcodec::crc32Finish(
      sr800::logcodec::crc32Update(
          archiveIntegrityCrcBegin(header), planPayload, planBytes));

  StorageMutationGuard mutation;
  if (!mutation) return false;
  if (LittleFS.exists(kLogArchiveTempPath) &&
      (!LittleFS.remove(kLogArchiveTempPath) ||
       LittleFS.exists(kLogArchiveTempPath))) {
    recordStorageFailure(StorageFailureStage::ARCHIVE_WRITE);
    return false;
  }
  if (!enforceLogArchiveRetention(sizeof(header) + planBytes, header.logId)) {
    recordStorageFailure(StorageFailureStage::ARCHIVE_WRITE);
    return false;
  }
  File file = LittleFS.open(kLogArchiveTempPath, "w");
  if (!file) {
    recordStorageFailure(StorageFailureStage::ARCHIVE_WRITE);
    return false;
  }
  bool ok = file.write(reinterpret_cast<const uint8_t*>(&header),
                       sizeof(header)) == sizeof(header);
  if (ok) ok = file.write(planPayload, planBytes) == planBytes;
  if (ok) file.flush();
  if (ok) ok = file.size() == sizeof(header) + planBytes;
  file.close();
  char path[32];
  logArchivePath(path, sizeof(path), header.logId);
  const bool renameAttempted = ok;
  if (ok) ok = LittleFS.rename(kLogArchiveTempPath, path);
  if (!ok) {
    recordStorageFailure(renameAttempted
        ? StorageFailureStage::ARCHIVE_RENAME
        : StorageFailureStage::ARCHIVE_WRITE);
    LittleFS.remove(kLogArchiveTempPath);
    return false;
  }

  thermalLogProvisionalPersisted = true;
  logArchiveCount++;
  advanceStateRevision();
  return true;
}

void discardProvisionalRoastArchive() {
  if (!thermalLogProvisionalPersisted || thermalLogReservedId == 0) return;
  StorageMutationGuard mutation;
  if (!mutation) return;
  char path[32];
  logArchivePath(path, sizeof(path), thermalLogReservedId);
  if (LittleFS.remove(path)) {
    if (logArchiveCount > 0) logArchiveCount--;
    advanceStateRevision();
  }
  thermalLogProvisionalPersisted = false;
}
class FrozenThermalLogClaim {
 public:
  FrozenThermalLogClaim() {
    portENTER_CRITICAL(&thermalLogMux);
    acquired_ = sr800::recording::canClaimPersistence(
        thermalLogActive, thermalLogUnsaved, thermalLogPersistenceClaimed);
    if (acquired_) thermalLogPersistenceClaimed = true;
    portEXIT_CRITICAL(&thermalLogMux);
  }

  ~FrozenThermalLogClaim() {
    release(false, false);
  }

  explicit operator bool() const { return acquired_; }

  void discardSubminimum() { release(true, false); }
  void markPersisted() { release(true, true); }

 private:
  void release(bool clearUnsaved, bool clearProvisional) {
    if (!acquired_) return;
    portENTER_CRITICAL(&thermalLogMux);
    if (clearUnsaved) thermalLogUnsaved = false;
    if (clearProvisional) thermalLogProvisionalPersisted = false;
    thermalLogPersistenceClaimed = false;
    acquired_ = false;
    portEXIT_CRITICAL(&thermalLogMux);
  }

  bool acquired_ = false;
};

// Persist the unsaved in-RAM thermal log to flash. Only ever called with the
// actuator fully idle: flash writes stall the MCPWM capture callbacks for tens
// of milliseconds, which the zero-cross observation gate would read as an
// outage if actuation were live.
void persistUnsavedThermalLog(bool force = false) {
  if (!logArchiveMounted) return;
  if (!actuatorFullyIdle()) return;
  StorageMutationGuard mutation;
  if (!mutation) return;
  FrozenThermalLogClaim claim;
  if (!claim) return;
  // Failed attempts back off 30 s so a sick filesystem is not hammered every
  // loop pass — except when a new episode is about to overwrite the RAM log,
  // which is the last chance this data has.
  if (!force &&
      static_cast<int32_t>(millis() - thermalLogPersistNotBeforeMs) < 0) {
    return;
  }
  ThermalArchivePersistTimer persistTimer;
  thermalLogPersistNotBeforeMs = millis() + 30000U;
  if (thermalLogCount < minimumArchivedSamples(thermalLogSource) &&
      !terminalRoastArchiveNeedsReplacement()) {
    claim.discardSubminimum();
    return;
  }

  LogArchiveHeader header = {};
  header.magic = kLogArchiveMagic;
  header.version = kLogArchiveVersion;
  header.source = static_cast<uint8_t>(thermalLogSource);
  header.logId = thermalLogReservedId != 0 ? thermalLogReservedId
                                            : nextLogArchiveId();
  if (header.logId == 0) {
    if (thermalLogPersistAttempts < kLogPersistMaxAttempts) {
      thermalLogPersistAttempts++;
    }
    return;
  }
  header.boot = bootCount;
  const time_t nowEpoch = time(nullptr);
  const uint32_t elapsedMs = millis() - thermalLogStartMs;
  header.startEpoch = nowEpoch > 1600000000
      ? static_cast<uint32_t>(nowEpoch - elapsedMs / 1000U) : 0;
  header.durationMs =
      thermalLogCount > 0 ? thermalLog[thermalLogCount - 1].tMs : 0;
  header.sampleCount = thermalLogCount;
  header.intervalMs = thermalLogIntervalMs;
  // Version 2 identity. A roast carries its name and, for a journey, the second
  // each zone endpoint was actually attained at - the one number the post-roast
  // review cannot reconstruct from the temperature series alone, because
  // attainment is what moved the plan's time axis. `roastName` and the offsets
  // still hold the FINISHED roast here: this runs either from the idle watcher
  // or from the next episode's start, before that episode overwrites them.
  header.zoneCount = 0;
  header.roastMode = 0;
  for (size_t index = 0; index < sr800::kMaxJourneyZones; ++index) {
    header.zoneAttainedSec[index] = kRoastZoneNotAttained;
  }
  if (thermalLogSource == ThermalLogSource::ROAST) {
    header.roastMode = static_cast<uint8_t>(roastMode);
    memcpy(header.name, roastName,
           strnlen(roastName, sizeof(header.name)));
    header.batchMassG = static_cast<uint16_t>(roastBatchMassG);
    header.roastStopSecBytes[0] = static_cast<uint8_t>(roastStopSec & 0xFFU);
    header.roastStopSecBytes[1] = static_cast<uint8_t>(roastStopSec >> 8);
    header.roastEndReason = roastEndReasonCode(roastEndReason);
    if (roastMode == RoastMode::JOURNEY) {
      header.zoneCount = static_cast<uint8_t>(roastZoneCount);
      for (size_t index = 0; index < sr800::kMaxJourneyZones; ++index) {
        header.zoneAttainedSec[index] = roastZoneAttainedSec[index];
      }
    }
  }

  // Version 4 identity and payload description. The encoder runs three bounded
  // passes - measure, checksum, write - rather than
  // buffering ~9 KB of encoded stream in RAM or writing a placeholder header
  // and seeking back over it. The encoding is deterministic, this only ever
  // runs with the actuator idle, and 4800 samples of varint work is nothing
  // next to the flash erase that follows it.
  uint8_t archivePlanPayload[sr800::logcodec::kMaxPlanEnvelopeBytes];
  const sr800::logcodec::PlanProvenance* archivePlan =
      thermalLogSource == ThermalLogSource::ROAST && roastArchivePlanValid
          ? &roastArchivePlan
          : thermalLogSource == ThermalLogSource::CALIBRATION &&
                calibrationArchivePlanValid
              ? &calibrationArchivePlan : nullptr;
  const size_t archivePlanBytes = archivePlan == nullptr ? 0
      : sr800::logcodec::encodePlanProvenance(
            *archivePlan, archivePlanPayload, sizeof(archivePlanPayload));
  header.codec = archivePlanBytes > 0
      ? sr800::logcodec::kCodecDeltaVarintPlan
      : sr800::logcodec::kCodecDeltaVarint;
  {
    sr800::logcodec::Encoder encoder;
    sr800::logcodec::encodeBegin(encoder);
    uint8_t frame[sr800::logcodec::kMaxEncodedSampleBytes];
    uint32_t encoded = static_cast<uint32_t>(archivePlanBytes);
    for (uint32_t index = 0; index < thermalLogCount; ++index) {
      encoded += static_cast<uint32_t>(sr800::logcodec::encodeSample(
          encoder, toCodecSample(thermalLog[index]), frame));
      if ((index & 0xFF) == 0) pacedYield();
    }
    header.encodedBytes = encoded;
  }
  fillArchiveProvenance(header);
  {
    sr800::logcodec::Encoder encoder;
    sr800::logcodec::encodeBegin(encoder);
    uint8_t frame[sr800::logcodec::kMaxEncodedSampleBytes];
    uint32_t crc = archiveIntegrityCrcBegin(header);
    if (archivePlanBytes > 0) {
      crc = sr800::logcodec::crc32Update(
          crc, archivePlanPayload, archivePlanBytes);
    }
    for (uint32_t index = 0; index < thermalLogCount; ++index) {
      const size_t written = sr800::logcodec::encodeSample(
          encoder, toCodecSample(thermalLog[index]), frame);
      crc = sr800::logcodec::crc32Update(crc, frame, written);
      if ((index & 0xFF) == 0) pacedYield();
    }
    header.crc32 = sr800::logcodec::crc32Finish(crc);
  }

  const size_t payloadBytes = sizeof(header) + header.encodedBytes;
  if (LittleFS.exists(kLogArchiveTempPath) &&
      (!LittleFS.remove(kLogArchiveTempPath) ||
       LittleFS.exists(kLogArchiveTempPath))) {
    recordStorageFailure(StorageFailureStage::ARCHIVE_WRITE);
    return;
  }
  if (!enforceLogArchiveRetention(payloadBytes, header.logId)) {
    recordStorageFailure(StorageFailureStage::ARCHIVE_WRITE);
    return;
  }

  // Write to a temp name and rename into place so a power loss mid-write can
  // never leave a truncated file under a real log id — the stale temp is
  // discarded at the next mount instead. On failure the log stays unsaved for
  // Retry on the idle-service backoff without discarding the RAM copy. A new
  // recordable episode is refused while a meaningful recording remains here.
  if (thermalLogPersistAttempts < kLogPersistMaxAttempts) {
    thermalLogPersistAttempts++;
  }
  File file = LittleFS.open(kLogArchiveTempPath, "w");
  if (!file) {
    recordStorageFailure(StorageFailureStage::ARCHIVE_WRITE);
    return;
  }
  bool ok = file.write(reinterpret_cast<const uint8_t*>(&header),
                       sizeof(header)) == sizeof(header);
  if (ok && archivePlanBytes > 0) {
    ok = file.write(archivePlanPayload, archivePlanBytes) == archivePlanBytes;
  }
  {
    // Second encoder pass, straight into the file through a small buffer. It
    // must reproduce the first pass byte for byte, and the size check below is
    // what proves it did: a mismatch fails the persist rather than leaving a
    // file whose stored CRC describes bytes that are not in it.
    sr800::logcodec::Encoder encoder;
    sr800::logcodec::encodeBegin(encoder);
    uint8_t buffer[512];
    size_t filled = 0;
    for (uint32_t index = 0; ok && index < thermalLogCount; ++index) {
      filled += sr800::logcodec::encodeSample(
          encoder, toCodecSample(thermalLog[index]), buffer + filled);
      if (filled + sr800::logcodec::kMaxEncodedSampleBytes > sizeof(buffer)) {
        ok = file.write(buffer, filled) == filled;
        filled = 0;
        pacedYield();
      }
    }
    if (ok && filled > 0) ok = file.write(buffer, filled) == filled;
  }
  if (ok) file.flush();
  if (ok) ok = file.size() == payloadBytes;
  file.close();
  char path[32];
  logArchivePath(path, sizeof(path), header.logId);
  const bool renameAttempted = ok;
  if (ok) ok = LittleFS.rename(kLogArchiveTempPath, path);
  if (!ok) {
    recordStorageFailure(renameAttempted
        ? StorageFailureStage::ARCHIVE_RENAME
        : StorageFailureStage::ARCHIVE_WRITE);
    LittleFS.remove(kLogArchiveTempPath);
    return;
  }
  if (!thermalLogProvisionalPersisted) logArchiveCount++;
  claim.markPersisted();
  // The atomic replacement changes the manifest-visible recording from its
  // durable plan-only form to the completed sampled archive.
  advanceStateRevision();
}

// A new actuation episode is beginning: close out and persist whatever the
// previous episode left in RAM. Called from start handlers BEFORE the actuator
// request is issued, so the flash stall lands while outputs are still idle.
bool finalizeThermalLogForNewEpisode() {
  if (!actuatorFullyIdle()) return false;
  portENTER_CRITICAL(&thermalLogMux);
  if (thermalLogActive) thermalLogActive = false;
  // The dedicated storage task owns the final flash write. A new episode is
  // refused until that worker has committed the prior recording. A
  // below-minimum episode is discarded atomically here so its stale unsaved
  // flag cannot cross the handoff into the next recording.
  const bool meaningful = meaningfulUnsavedThermalLog();
  if (sr800::recording::discardSubminimumAtHandoff(
          thermalLogUnsaved, meaningful, thermalLogPersistenceClaimed)) {
    thermalLogUnsaved = false;
  }
  const bool pending = sr800::recording::persistenceBlocksNewEpisode(
      meaningful, thermalLogPersistenceClaimed);
  portEXIT_CRITICAL(&thermalLogMux);
  return !pending;
}

// Idle watcher: a manual roast closes at the operator's Stop boundary. Other
// roast programs and calibration evidence remain open for kLogIdleFinalizeMs —
// long enough to capture the heat-soak rebound and a clean stretch of passive
// decay. Persist any closed unsaved log the moment the
// actuator is idle (covers the buffer-full-during-run case too).
void serviceThermalCaptureLifecycle(uint32_t nowMs) {
  if (!actuatorFullyIdle()) {
    actuatorIdleSinceMs = nowMs;
    return;
  }
  portENTER_CRITICAL(&thermalLogMux);
  const bool manualRoastEnded = thermalLogActive && thermalLogUnsaved &&
      thermalLogSource == ThermalLogSource::ROAST &&
      roastMode == RoastMode::MANUAL && !roastActive;
  const bool passiveTailElapsed = thermalLogActive && thermalLogUnsaved &&
      nowMs - actuatorIdleSinceMs >= kLogIdleFinalizeMs;
  if (manualRoastEnded || passiveTailElapsed) {
    thermalLogPassiveTailComplete = true;
    thermalLogActive = false;
  }
  portEXIT_CRITICAL(&thermalLogMux);
}

void serviceThermalArchive() {
  if (!actuatorFullyIdle()) return;
  persistUnsavedThermalLog();
}

void serviceNativeStorage() {
  // Automatic archive finalization writes LittleFS even when no HTTP storage
  // request is active. Advertise that ownership so the controller cannot
  // begin actuation during the flash-cache blackout.
  StorageRequestGuard storage;
  if (!storage) return;
  serviceThermalArchive();
}

constexpr char kPriorRecordingUnsavedRejection[] =
    "The previous recording could not be saved; new actuation is blocked so it is not overwritten.";

// An accepted Start or Manual set TAKES OVER from the post-stop cooling tail
// and from the previous episode's still-open recording (the tail never blocks
// a new instruction). The caller has already preempted the tail and holds the
// StorageMutationGuard, so the outputs are idle and flash writes are allowed:
// close the prior log and, if it is still unsaved, persist it synchronously
// right here instead of refusing and waiting for the storage task. A genuine persistence failure still refuses, with that reason.
bool takeOverPriorRecordingForNewEpisode(const char*& rejection) {
  if (!actuatorFullyIdle()) {
    rejection = "Another actuator operation is active.";
    return false;
  }
  if (finalizeThermalLogForNewEpisode()) return true;
  persistUnsavedThermalLog(true);
  if (finalizeThermalLogForNewEpisode()) return true;
  rejection = !logArchiveMounted
      ? "The previous recording could not be saved because the recording library is not mounted; new actuation is blocked so it is not overwritten."
      : kPriorRecordingUnsavedRejection;
  return false;
}
// ---------------------------------------------------------------------------
bool sendBoundedResponse(int statusCode, const char* contentType,
                         const String& body,
                         const char* extraHeaderName = nullptr,
                         const char* extraHeaderValue = nullptr);
// On-device document store: the HTTP layer.
//
// Reads are always allowed. Every write and delete is idle-gated exactly like
// /api/logs/delete, because a flash program/erase blacks out the MCPWM capture
// callbacks and the zero-cross observation gate would read that as an outage.

bool dataStoreAvailable() {
  if (dataStoreMounted) return true;
  sendBoundedResponse(503, "application/json",
                      "{\"ok\":false,\"message\":\"Document storage is not mounted.\"}");
  return false;
}

bool dataStoreIdleGate() {
  if (!actuatorFullyIdle()) {
    sendBoundedResponse(409, "application/json",
                        "{\"ok\":false,\"message\":\"Document storage waits until actuation finishes.\"}");
    return false;
  }
  ThermalLogStateSnapshot recording = copyThermalLogState();
  if (recording.active && recording.unsaved) {
    sendBoundedResponse(409, "application/json",
                        "{\"ok\":false,\"message\":\"Document storage waits for the current thermal recording to finish.\"}");
    return false;
  }
  // Archive evidence wins the shared flash volume. Finish that atomic rename
  // before allocating or writing an HTTP document body.
  if (recording.unsaved) persistUnsavedThermalLog(true);
  recording = copyThermalLogState();
  if (recording.unsaved) {
    sendBoundedResponse(503, "application/json",
                        "{\"ok\":false,\"message\":\"The pending thermal recording could not be saved, so the document write was not attempted.\"}");
    return false;
  }
  if (storageMutationActive) {
    sendBoundedResponse(503, "application/json",
                        "{\"ok\":false,\"message\":\"Another storage operation is still finishing.\"}");
    return false;
  }
  return true;
}

// The native storage task is the only writer of bulk HTTP response bodies. One
// fixed chunk buffer is therefore sufficient regardless of library size.
constexpr size_t kHttpChunkBytes = 4096U;
static char httpChunkBuffer[kHttpChunkBytes];
// This is a renewable no-progress lease for incoming uploads, never a total
// request lifetime. ESP-IDF applies its own bounded per-send socket timeout.
constexpr uint32_t kHttpIdleNoProgressBudgetMs = 10000U;

// CA-F04 made the mutable current-RAM CSV the one read surface that waited for
// capture freeze, with a retryable 409. That refusal starved a browser joining
// mid-roast of every sample recorded before it arrived, so the wait is replaced
// by a consistent snapshot: samples are append-only under thermalLogMux, so a
// count fenced once names a stable prefix even while the loopTask sampler keeps
// appending behind it. A frozen buffer keeps its direct read; only the
// still-mutable states need the fenced chunk copy in the handler. Flash
// persistence keeps its idle-only gate untouched - this is purely a RAM read.
bool mutableThermalCsvSnapshot(ThermalLogStateSnapshot& recording) {
  recording = copyThermalLogState();
  return !sr800::recording::canReadFrozenBuffer(
      recording.active, recording.persistenceClaimed);
}

bool sendBoundedResponse(int statusCode, const char* contentType,
                         const String& body, const char* extraHeaderName,
                         const char* extraHeaderValue) {
  if (nativeStorageRequest != nullptr && extraHeaderName != nullptr &&
      extraHeaderValue != nullptr) {
    httpd_resp_set_hdr(nativeStorageRequest, extraHeaderName, extraHeaderValue);
  }
  if (nativeStorageRequest == nullptr && nativeCommandResponse == nullptr) {
    return false;
  }
  sendRequestResponse(statusCode, contentType, body);
  return true;
}

class HttpResponseWriter {
 public:
  void begin(const char* contentType = "application/json",
             const char* contentDisposition = nullptr,
             const char* cacheControl = nullptr) {
    if (nativeStorageRequest == nullptr) {
      ok_ = false;
      return;
    }
    httpd_resp_set_type(nativeStorageRequest, contentType);
    httpd_resp_set_hdr(nativeStorageRequest, "Cache-Control",
                       cacheControl == nullptr ? "no-store" : cacheControl);
    if (contentDisposition != nullptr) {
      httpd_resp_set_hdr(nativeStorageRequest, "Content-Disposition",
                         contentDisposition);
    }
    started_ = true;
  }

  bool ok() const { return ok_; }

  HttpResponseWriter& operator+=(const String& value) {
    appendBytes(value.c_str(), value.length());
    return *this;
  }
  HttpResponseWriter& operator+=(const char* value) {
    if (value != nullptr) appendBytes(value, strlen(value));
    return *this;
  }
  HttpResponseWriter& operator+=(const __FlashStringHelper* value) {
    const char* bytes = reinterpret_cast<const char*>(value);
    appendBytes(bytes, strlen(bytes));
    return *this;
  }
  HttpResponseWriter& operator+=(char value) {
    appendBytes(&value, 1);
    return *this;
  }
  template <typename Number,
            typename std::enable_if<std::is_integral<Number>::value,
                                    int>::type = 0>
  HttpResponseWriter& operator+=(Number value) {
    char decimal[32];
    if (std::is_signed<Number>::value) {
      snprintf(decimal, sizeof(decimal), "%lld", static_cast<long long>(value));
    } else {
      snprintf(decimal, sizeof(decimal), "%llu",
               static_cast<unsigned long long>(value));
    }
    appendBytes(decimal, strlen(decimal));
    return *this;
  }

  void finish() {
    flush();
    if (started_ && ok_) {
      ok_ = httpd_resp_send_chunk(nativeStorageRequest, nullptr, 0) == ESP_OK;
    }
  }

 private:
  void appendBytes(const char* value, size_t length) {
    while (ok_ && length > 0) {
      const size_t available = sizeof(httpChunkBuffer) - used_;
      if (available == 0) {
        flush();
        continue;
      }
      const size_t take = std::min(length, available);
      memcpy(httpChunkBuffer + used_, value, take);
      used_ += take;
      value += take;
      length -= take;
    }
  }
  void flush() {
    if (!started_ || !ok_ || used_ == 0) return;
    ok_ = httpd_resp_send_chunk(nativeStorageRequest, httpChunkBuffer,
                                 used_) == ESP_OK;
    used_ = 0;
  }

  size_t used_ = 0;
  bool started_ = false;
  bool ok_ = true;
};
void handleEvents() {
  if (actuator.outputsActive()) {
    sendRequestResponse(200, "application/json",
        "{\"events\":[],\"suspended_during_actuation\":true}");
    return;
  }
  const uint32_t limit = readUintArg("limit", 200, 1, 512);
  uint32_t newest = 0;
  portENTER_CRITICAL(&captureMux);
  newest = eventCount;
  portEXIT_CRITICAL(&captureMux);
  const uint32_t count = limit < newest ? limit : newest;
  const uint32_t first = count == 0 ? 0 : newest - count + 1;

  HttpResponseWriter response;
  response.begin();
  response += F("{\"events\":[");
  bool wroteOne = false;
  for (uint32_t sequence = first;
       sequence != 0 && sequence <= newest; ++sequence) {
    if (!response.ok()) break;
    EdgeEvent event;
    if (!copyEvent(sequence, event)) continue;
    if (wroteOne) response += ',';
    wroteOne = true;
    char row[180];
    snprintf(
        row, sizeof(row),
        "{\"seq\":%lu,\"us\":%lu,\"gap_us\":%lu,\"changed_mask\":%u,\"levels\":%u,\"ch0\":%u,\"ch1\":%u,\"ch2\":%u,\"ch3\":%u}",
        static_cast<unsigned long>(event.sequence),
        static_cast<unsigned long>(event.atUs),
        static_cast<unsigned long>(event.precedingGapUs),
        event.changedMask, event.levels,
        event.levels & 0x01 ? 1 : 0,
        event.levels & 0x02 ? 1 : 0,
        event.levels & 0x04 ? 1 : 0,
        event.levels & 0x08 ? 1 : 0);
    response += row;
  }
  response += F("]}");
  response.finish();
}

void handleCaptureCsv() {
  if (actuator.outputsActive()) {
    sendRequestResponse(
        409, "text/plain",
        "Edge CSV is available after actuation completes.");
    return;
  }
  uint32_t newest = 0;
  portENTER_CRITICAL(&captureMux);
  newest = eventCount;
  portEXIT_CRITICAL(&captureMux);

  HttpResponseWriter response;
  response.begin(
      "text/csv",
      "attachment; filename=sr800-power-stage-capture.csv");
  response += F("sequence,time_us,preceding_gap_us,changed_mask,levels_mask,ch0_gpio3_fan_output,ch1_gpio4_heater_output,ch2_gpio5_pic_fan_monitor,ch3_gpio6_zero_cross\n");
  char row[150];
  for (uint32_t sequence = 1; sequence <= newest; ++sequence) {
    if (!response.ok()) break;
    EdgeEvent event;
    if (!copyEvent(sequence, event)) continue;
    snprintf(
        row, sizeof(row), "%lu,%lu,%lu,0x%02X,0x%02X,%u,%u,%u,%u\n",
        static_cast<unsigned long>(event.sequence),
        static_cast<unsigned long>(event.atUs),
        static_cast<unsigned long>(event.precedingGapUs),
        event.changedMask, event.levels,
        event.levels & 0x01 ? 1 : 0,
        event.levels & 0x02 ? 1 : 0,
        event.levels & 0x04 ? 1 : 0,
        event.levels & 0x08 ? 1 : 0);
    response += row;
  }
  response.finish();
}

void handleTimingCsv() {
  if (actuator.outputsActive() ||
      heaterProofPhase != HeaterProofPhase::IDLE) {
    sendRequestResponse(
        409, "text/plain",
        "Timing CSV is available after actuation completes.");
    return;
  }

  const sr800::PhaseSchedulerSnapshot state = phaseScheduler.snapshot();
  char filename[96];
  snprintf(filename, sizeof(filename),
           "attachment; filename=sr800-phase-timing-%s.csv",
           kFirmwareVersion);
  HttpResponseWriter response;
  response.begin("text/csv", filename);
  response += F("sequence,zero_cross_index,channel,planned_delay_us,actual_delay_us,lateness_us,pulse_width_us,outcome,flags\n");
  char row[180];
  for (uint32_t sequence = 1;
       sequence <= state.timingLogRecords; ++sequence) {
    if (!response.ok()) break;
    sr800::PhaseTimingRecord record = {};
    if (!phaseScheduler.copyTimingRecord(sequence, record)) continue;
    const char* channel = record.channelMask == 0x01
        ? "fan"
        : (record.channelMask == 0x02 ? "heater" : "unknown");
    const char* outcome = "missed_unknown";
    if ((record.flags & sr800::PHASE_TIMING_EMITTED) != 0) {
      outcome = (record.flags & sr800::PHASE_TIMING_LATE) != 0
          ? "emitted_late" : "emitted";
    } else if ((record.flags & sr800::PHASE_TIMING_EARLY) != 0) {
      outcome = "missed_early";
    } else if ((record.flags & sr800::PHASE_TIMING_STALE) != 0) {
      outcome = "missed_stale";
    }
    const int32_t latenessUs =
        static_cast<int32_t>(record.actualDelayUs) -
        static_cast<int32_t>(record.plannedDelayUs);
    snprintf(
        row, sizeof(row),
        "%lu,%u,%s,%u,%u,%ld,%lu,%s,0x%02X\n",
        static_cast<unsigned long>(sequence),
        record.zeroCrossIndex, channel,
        record.plannedDelayUs, record.actualDelayUs,
        static_cast<long>(latenessUs),
        static_cast<unsigned long>(record.actualPulseWidthUs),
        outcome, record.flags);
    response += row;
  }
  response.finish();
}
// A chunked file stream that came up short of the file's known size must not
// end with a clean zero-length terminator: a truncated backup would look like a
// complete 200. It is simply left unterminated; the async request is completed
// by the storage worker as usual, and the client sees an incomplete body (its
// own request timeout ends the transfer as a failure).
//
// The session is deliberately not forced closed here with
// httpd_sess_trigger_close. Closing, from the storage worker, a session that
// still has an async request in flight is not a documented use of the async
// request API, and it is associated with task-watchdog resets (core 0 idle
// starved for 5 s) under post-roast browser activity.
void abortStorageStream() {}

// Streams the payload verbatim with its version in a header. The firmware has
// no opinion about the bytes it is handing back.
void serveStoredDocument(const char* path) {
  const StoredDocInfo info = readStoredDoc(path);
  if (!info.exists) {
    sendRequestResponse(404, "application/json",
        "{\"ok\":false,\"message\":\"No document is stored there.\"}");
    return;
  }
  if (!info.readable) {
    sendBoundedResponse(500, "application/json",
        "{\"ok\":false,\"message\":\"The stored document is unreadable. Delete it, or store it again with base=0.\"}",
        "X-Doc-Version", "0");
    return;
  }
  File file = LittleFS.open(path, "r");
  if (!file || !file.seek(sr800::docstore::kPrefixBytes)) {
    if (file) file.close();
    sendRequestResponse(500, "application/json",
        "{\"ok\":false,\"message\":\"The stored document could not be opened.\"}");
    return;
  }
  char version[16];
  snprintf(version, sizeof(version), "%lu",
           static_cast<unsigned long>(info.docVersion));
  httpd_resp_set_type(nativeStorageRequest, "application/json");
  httpd_resp_set_hdr(nativeStorageRequest, "Cache-Control", "no-store");
  httpd_resp_set_hdr(nativeStorageRequest, "X-Doc-Version", version);
  uint32_t remaining = info.payloadBytes;
  while (remaining > 0) {
    const size_t chunk = std::min(sizeof(httpChunkBuffer),
                                  static_cast<size_t>(remaining));
    const size_t read = file.read(
        reinterpret_cast<uint8_t*>(httpChunkBuffer), chunk);
    if (read == 0 || httpd_resp_send_chunk(
            nativeStorageRequest, httpChunkBuffer, read) != ESP_OK) {
      // Short read or dead socket: no clean terminator, close the session.
      file.close();
      abortStorageStream();
      return;
    }
    remaining -= static_cast<uint32_t>(read);
  }
  file.close();
  httpd_resp_send_chunk(nativeStorageRequest, nullptr, 0);
}
void storeDocumentRequest(const char* path, uint32_t maxPayloadBytes) {
  if (!requestHasArg("base")) {
    sendBoundedResponse(400, "application/json",
                        "{\"ok\":false,\"message\":\"base=<expected version> is required; base=0 creates.\"}");
    return;
  }
  uint32_t baseVersion = 0;
  if (!sr800::docstore::parseBaseVersion(requestArg("base").c_str(),
                                         baseVersion)) {
    sendBoundedResponse(400, "application/json",
                        "{\"ok\":false,\"message\":\"base must be an unsigned decimal version.\"}");
    return;
  }
  if (!dataStoreIdleGate()) return;
  // The native storage worker materializes one size-capped JSON document body.
  // Return-value elision avoids another local copy.
  const String payload = requestArg("plain");
  if (payload.length() > maxPayloadBytes) {
    String tooLarge = F("{\"ok\":false,\"message\":\"The document exceeds the ");
    tooLarge += maxPayloadBytes / 1024U;
    tooLarge += F(" KB limit for this document.\"}");
    sendBoundedResponse(413, "application/json", tooLarge);
    return;
  }

  const StoredDocInfo info = readStoredDoc(path);
  uint32_t nextVersion = 0;
  const sr800::docstore::WriteVerdict verdict = sr800::docstore::evaluateWrite(
      info.exists, info.docVersion, baseVersion,
      static_cast<uint32_t>(payload.length()), maxPayloadBytes,
      static_cast<uint32_t>(LittleFS.totalBytes()),
      static_cast<uint32_t>(LittleFS.usedBytes()), nextVersion);
  if (verdict == sr800::docstore::WriteVerdict::TOO_LARGE) {
    sendBoundedResponse(413, "application/json",
                        "{\"ok\":false,\"message\":\"The document exceeds its size limit.\"}");
    return;
  }
  if (verdict == sr800::docstore::WriteVerdict::CONFLICT) {
    // The losing writer is told the current version so it can refetch, rebase,
    // and try again. Nothing stored has been touched.
    String conflict = F("{\"ok\":false,\"conflict\":true,\"version\":");
    conflict += info.exists ? info.docVersion : 0U;
    conflict += F("}");
    sendBoundedResponse(409, "application/json", conflict);
    return;
  }
  if (verdict == sr800::docstore::WriteVerdict::NO_ROOM) {
    // The floor is the archive's working reserve PLUS a whole worst-case
    // recording, so an accepted document write can never be the reason the next
    // persist prunes a stored roast. See sr800_volume_budget.h.
    sendBoundedResponse(507, "application/json",
                        "{\"ok\":false,\"message\":\"Storing this document would leave the volume under the 214 KB reserved for the next recording. Delete recordings or documents first.\"}");
    return;
  }
  if (!writeStoredDoc(path, nextVersion, payload)) {
    // Whatever failed, it failed before anything replaced the stored document:
    // the previous version is still on the volume and still readable.
    sendBoundedResponse(500, "application/json",
                        "{\"ok\":false,\"message\":\"The document could not be written. The previously stored version is unchanged.\"}");
    return;
  }
  // One envelope read of the document just written, not a walk of the whole tree.
  applyStoredDocDelta(path, info, readStoredDoc(path));
  // A matching lease can expire while a flash write is in progress. Once the
  // request passed the mutation gate, an incomplete lease still owns the
  // mutation even if its active timeout elapsed before this success boundary.
  refreshRestoreLease();
  if (restoreLease.incomplete) markRestoreDirty();
  else advanceStateRevision();
  String response = F("{\"ok\":true,\"version\":");
  response += nextVersion;
  response += F(",\"state_rev\":\"");
  appendUint64Decimal(response, currentStateRevision());
  response += F("\"}");
  sendBoundedResponse(200, "application/json", response);
}

// The collection name arrives as a path segment; anything outside the four
// known names is a 400, never a filesystem lookup.
bool resolveCollectionPath(const String& name, char* path, size_t capacity) {
  sr800::docstore::Collection collection;
  if (!sr800::docstore::collectionFromName(name.c_str(), collection)) {
    return false;
  }
  return sr800::docstore::collectionPath(path, capacity, collection);
}

void sendUnknownCollection() {
  sendRequestResponse(400, "application/json",
              "{\"ok\":false,\"message\":\"Unknown collection. Use profiles, beans, calibrations, or meta.\"}");
}

void sendInvalidRunId() {
  sendRequestResponse(400, "application/json",
              "{\"ok\":false,\"message\":\"A run id is 1-24 characters of A-Z a-z 0-9 . _ - and may not be all dots.\"}");
}

void handleDataCollectionGet() {
  if (!dataStoreAvailable()) return;
  char path[sr800::docstore::kMaxPathBytes];
  if (!resolveCollectionPath(requestPathArg(0), path, sizeof(path))) {
    sendUnknownCollection();
    return;
  }
  serveStoredDocument(path);
}

void handleDataCollectionPost() {
  if (rejectMutationDuringRestore(true)) return;
  if (!dataStoreAvailable()) return;
  char path[sr800::docstore::kMaxPathBytes];
  if (!resolveCollectionPath(requestPathArg(0), path, sizeof(path))) {
    sendUnknownCollection();
    return;
  }
  storeDocumentRequest(path, sr800::docstore::kCollectionMaxPayloadBytes);
}

void handleDataRunGet() {
  if (!dataStoreAvailable()) return;
  char path[sr800::docstore::kMaxPathBytes];
  if (!sr800::docstore::runPath(path, sizeof(path),
                                requestPathArg(0).c_str())) {
    sendInvalidRunId();
    return;
  }
  serveStoredDocument(path);
}

void handleDataRunPost() {
  if (rejectMutationDuringRestore(true)) return;
  if (!dataStoreAvailable()) return;
  char path[sr800::docstore::kMaxPathBytes];
  if (!sr800::docstore::runPath(path, sizeof(path),
                                requestPathArg(0).c_str())) {
    sendInvalidRunId();
    return;
  }
  storeDocumentRequest(path, sr800::docstore::kRunMaxPayloadBytes);
}

// Directory enumeration plus envelopes. No payload is opened, let alone parsed.
void handleDataRunsIndex() {
  if (!dataStoreAvailable()) return;
  HttpResponseWriter response;
  response.begin();
  response += F("{\"ok\":true,\"runs\":[");
  File dir = LittleFS.open(kDataRunsDir);
  bool first = true;
  size_t listed = 0;
  if (dir && dir.isDirectory()) {
    for (File entry = dir.openNextFile(); entry && listed < kMaxListedRuns;
         entry = dir.openNextFile()) {
      if (!response.ok()) break;
      if (entry.isDirectory()) continue;
      char id[sr800::docstore::kRunIdMaxChars + 1];
      if (!sr800::docstore::runIdFromFileName(entry.name(), id, sizeof(id))) {
        continue;
      }
      const StoredDocInfo info = describeOpenDoc(entry);
      if (!info.readable) continue;
      String row = first ? F("") : F(",");
      first = false;
      row += F("{\"id\":\"");
      row += id;  // already restricted to [A-Za-z0-9._-] by runIdFromFileName
      row += F("\",\"bytes\":");
      row += info.payloadBytes;
      row += F(",\"version\":");
      row += info.docVersion;
      row += F("}");
      response += row;
      listed++;
      pacedYield();
    }
  }
  String tail = F("],\"total\":");
  tail += dataStoreRunCount;
  tail += F(",\"truncated\":");
  tail += listed < dataStoreRunCount ? F("true}") : F("false}");
  response += tail;
  response.finish();
}


// A revision-fenced, paginated inventory of every controller-owned document
// and recording. The browser uses this as its authoritative reconciliation
// surface, so all four collections are named on every page, including absent
// ones as null. The cursor is deliberately opaque outside this handler.
//
// Directory entries are cached in fixed PSRAM arrays keyed by the state revision, so repeated
// reads between mutations do no filesystem work and memory stays bounded by the cache capacity.
struct ManifestRunEntry {
  char id[sr800::docstore::kRunIdMaxChars + 1];
  uint32_t payloadBytes;
  uint32_t docVersion;
};
struct ManifestLogEntry {
  uint32_t id;
  uint32_t bytes;
};
// Far above what the 896 KB shared volume can hold; entries beyond it are simply not listed.
constexpr size_t kManifestCacheCapacity = 512;
// Owned by the crackle-store task, the only caller of handleDataManifest; PSRAM, allocated once.
ManifestRunEntry* manifestRuns = nullptr;
ManifestLogEntry* manifestLogs = nullptr;
size_t manifestRunCount = 0;
size_t manifestLogCount = 0;
bool manifestCacheValid = false;
uint64_t manifestCacheRevision = 0;
uint32_t manifestCacheMutations = 0;

bool loadManifestEntries() {
  if (manifestRuns == nullptr) {
    manifestRuns = static_cast<ManifestRunEntry*>(heap_caps_calloc(
        kManifestCacheCapacity, sizeof(ManifestRunEntry), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    manifestLogs = static_cast<ManifestLogEntry*>(heap_caps_calloc(
        kManifestCacheCapacity, sizeof(ManifestLogEntry), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (manifestRuns == nullptr || manifestLogs == nullptr) {
      heap_caps_free(manifestRuns);
      heap_caps_free(manifestLogs);
      manifestRuns = nullptr;
      manifestLogs = nullptr;
      manifestRunCount = manifestLogCount = 0;
      return false;
    }
  }
  const uint64_t revision = currentStateRevision();
  const uint32_t mutations = currentManifestMutationCount();
  if (manifestCacheValid && manifestCacheMutations == mutations) return true;
  size_t runCount = 0;
  size_t logCount = 0;
  File runs = LittleFS.open(kDataRunsDir);
  if (runs && runs.isDirectory()) {
    for (File entry = runs.openNextFile(); entry && runCount < kManifestCacheCapacity;
         entry = runs.openNextFile()) {
      pacedYield();
      if (entry.isDirectory()) continue;
      ManifestRunEntry& run = manifestRuns[runCount];
      if (!sr800::docstore::runIdFromFileName(entry.name(), run.id, sizeof(run.id))) continue;
      const StoredDocInfo info = describeOpenDoc(entry);
      if (!info.readable) continue;
      run.payloadBytes = info.payloadBytes;
      run.docVersion = info.docVersion;
      runCount++;
    }
  }
  runs.close();
  File logs = LittleFS.open(kLogArchiveDir);
  if (logs && logs.isDirectory()) {
    for (File entry = logs.openNextFile(); entry && logCount < kManifestCacheCapacity;
         entry = logs.openNextFile()) {
      pacedYield();
      if (entry.isDirectory()) continue;
      const uint32_t id = logArchiveIdFromName(entry.name());
      if (id == 0) continue;
      manifestLogs[logCount].id = id;
      manifestLogs[logCount].bytes = static_cast<uint32_t>(entry.size());
      logCount++;
    }
  }
  logs.close();
  manifestRunCount = runCount;
  manifestLogCount = logCount;
  // Kept only if nothing changed the library while it was being walked.
  manifestCacheRevision = revision;
  manifestCacheMutations = mutations;
  manifestCacheValid = currentManifestMutationCount() == mutations;
  return true;
}

void handleDataManifest() {
  if (!dataStoreAvailable()) return;

  uint32_t offset = 0;
  if (requestHasArg("cursor")) {
    const String cursor = requestArg("cursor");
    if (!cursor.startsWith("m:") || cursor.length() <= 2) {
      sendRequestResponse(400, "application/json",
                  "{\"ok\":false,\"message\":\"cursor is not a valid manifest cursor\"}");
      return;
    }
    uint64_t parsed = 0;
    if (!sr800::runtime::decimalUint64(cursor.c_str() + 2,
                                      cursor.length() - 2, parsed) ||
        parsed > UINT32_MAX) {
      sendRequestResponse(400, "application/json",
                  "{\"ok\":false,\"message\":\"cursor is not a valid manifest cursor\"}");
      return;
    }
    offset = static_cast<uint32_t>(parsed);
  }

  // Run descriptors and the recording list come from a cache keyed by the state revision: the
  // directory walk costs 1.3-4.6 s of storage-worker time per request and the app requests the
  // manifest on every revision signal. Every manifest-changing mutation advances
  // the revision or, inside a restore lease, marks it dirty; both count as a manifest mutation, so
  // the walk runs only after one.
  if (!loadManifestEntries()) {
    sendBoundedResponse(503, "application/json",
        "{\"ok\":false,\"message\":\"The manifest cache could not be allocated. Retry shortly.\"}",
        "Retry-After", "1");
    return;
  }
  const uint32_t totalEntries = static_cast<uint32_t>(manifestRunCount + manifestLogCount);
  if (offset > totalEntries) {
    sendRequestResponse(400, "application/json",
                "{\"ok\":false,\"message\":\"cursor is outside the manifest\"}");
    return;
  }

  HttpResponseWriter response;
  response.begin();
  String head = F("{\"state_rev\":\"");
  // The revision the listed entries were read at: if the library changed mid-walk, clients see an
  // older revision than status and read again rather than trusting stale entries.
  appendUint64Decimal(head, manifestCacheRevision);
  head += F("\",\"boot_id\":\"");
  head += bootCount;
  head += F("\",\"collections\":{");
  for (size_t index = 0; index < sr800::docstore::kCollectionCount; ++index) {
    if (index != 0) head += ',';
    head += '"';
    head += sr800::docstore::collectionName(
        static_cast<sr800::docstore::Collection>(index));
    head += F("\":");
    if (!dataCollectionSummary[index].present) {
      head += F("null");
    } else {
      head += F("{\"bytes\":");
      head += dataCollectionSummary[index].bytes;
      head += F(",\"version\":");
      head += dataCollectionSummary[index].version;
      head += '}';
    }
  }
  head += F("},\"runs\":[");
  response += head;

  uint32_t visited = 0;
  size_t emitted = 0;
  bool firstRun = true;
  for (size_t index = 0; index < manifestRunCount; ++index) {
    if (!response.ok()) break;
    if (visited++ < offset) continue;
    if (emitted >= kManifestPageEntries) break;
    const ManifestRunEntry& run = manifestRuns[index];
    String row = firstRun ? F("") : F(",");
    firstRun = false;
    row += F("{\"id\":\"");
    row += run.id;  // restricted to [A-Za-z0-9._-] by runIdFromFileName
    row += F("\",\"bytes\":");
    row += run.payloadBytes;
    row += F(",\"version\":");
    row += run.docVersion;
    row += '}';
    response += row;
    emitted++;
  }
  response += F("],\"logs\":[");
  bool firstLog = true;
  for (size_t index = 0; index < manifestLogCount; ++index) {
    if (!response.ok()) break;
    if (visited++ < offset) continue;
    if (emitted >= kManifestPageEntries) break;
    String row = firstLog ? F("") : F(",");
    firstLog = false;
    row += F("{\"id\":\"");
    row += manifestLogs[index].id;
    row += F("\",\"bytes\":");
    row += manifestLogs[index].bytes;
    row += '}';
    response += row;
    emitted++;
  }
  String tail = F("]");
  const uint32_t nextOffset = offset + static_cast<uint32_t>(emitted);
  if (nextOffset < totalEntries) {
    tail += F(",\"next_cursor\":\"m:");
    tail += nextOffset;
    tail += '"';
  }
  refreshRestoreLease();
  tail += F(",\"restore_maintenance\":{\"active\":");
  tail += restoreLease.active ? F("true") : F("false");
  tail += F(",\"incomplete\":");
  tail += restoreLease.incomplete ? F("true") : F("false");
  tail += F(",\"dirty\":");
  tail += restoreLease.dirty ? F("true") : F("false");
  tail += F(",\"expires_in_ms\":");
  tail += restoreLease.active &&
                  sr800::runtime::deadlinePending(millis(),
                                                  restoreLease.expiresAtMs)
              ? restoreLease.expiresAtMs - millis()
              : 0U;
  tail += F("}}");
  response += tail;
  response.finish();
}

void handleDataDelete() {
  if (rejectMutationDuringRestore(true)) return;
  if (!requestHasArg("confirm") || requestArg("confirm") != "DELETE_DATA") {
    sendRequestResponse(409, "application/json",
                "{\"ok\":false,\"message\":\"Delete confirmation is required.\"}");
    return;
  }
  if (!dataStoreAvailable()) return;
  const String target = requestArg("target");
  char path[sr800::docstore::kMaxPathBytes];
  bool resolved = false;
  if (target.startsWith("runs/")) {
    resolved = sr800::docstore::runPath(path, sizeof(path),
                                        target.c_str() + 5);
  } else {
    resolved = resolveCollectionPath(target, path, sizeof(path));
  }
  if (!resolved) {
    sendRequestResponse(400, "application/json",
                "{\"ok\":false,\"message\":\"target must be a collection name or runs/<id>.\"}");
    return;
  }
  uint32_t baseVersion = 0;
  if (!requestHasArg("base") ||
      !sr800::docstore::parseBaseVersion(requestArg("base").c_str(),
                                         baseVersion)) {
    sendRequestResponse(400, "application/json",
                "{\"ok\":false,\"message\":\"base must be an unsigned decimal version.\"}");
    return;
  }
  if (!dataStoreIdleGate()) return;
  const bool exists = LittleFS.exists(path);
  const StoredDocInfo info = readStoredDoc(path);
  const uint32_t currentVersion = info.readable ? info.docVersion : 0u;
  const sr800::docstore::DeleteVerdict verdict =
      sr800::docstore::evaluateDelete(exists, currentVersion, baseVersion);
  if (verdict == sr800::docstore::DeleteVerdict::CONFLICT) {
    String response = F("{\"ok\":false,\"conflict\":true,\"version\":");
    response += currentVersion;
    response += F("}");
    sendRequestResponse(409, "application/json", response);
    return;
  }
  if (verdict == sr800::docstore::DeleteVerdict::NOT_FOUND) {
    sendRequestResponse(404, "application/json",
                "{\"ok\":false,\"message\":\"No document is stored there.\"}");
    return;
  }
  const sr800::docstore::RemoveVerdict removed =
      sr800::docstore::evaluateRemove(true, LittleFS.remove(path));
  if (removed == sr800::docstore::RemoveVerdict::FAILED) {
    sendRequestResponse(500, "application/json",
                "{\"ok\":false,\"message\":\"The stored document could not be removed.\"}");
    return;
  }

  applyStoredDocDelta(path, info, StoredDocInfo{});
  // `target` passed the same character rules the store enforces, so it is safe
  // inside a JSON string literal without further scrubbing.
  String response = F("{\"ok\":true,\"deleted\":\"");
  response += target;
  // A matching lease can expire while a flash write is in progress. Once the
  // request passed the mutation gate, an incomplete lease still owns the
  // mutation even if its active timeout elapsed before this success boundary.
  refreshRestoreLease();
  if (restoreLease.incomplete) markRestoreDirty();
  else advanceStateRevision();
  response += F("\",\"version\":0,\"state_rev\":\"");
  appendUint64Decimal(response, currentStateRevision());
  response += F("\"}");
  sendRequestResponse(200, "application/json", response);
}

const char* heaterProofPhaseName(HeaterProofPhase phase) {
  switch (phase) {
    case HeaterProofPhase::IDLE: return "idle";
    case HeaterProofPhase::FAN_QUALIFICATION: return "fan_qualification";
    case HeaterProofPhase::HEATING: return "heating";
    default: return "unknown";
  }
}

// Publish a fresh immutable source frequently; the 1 Hz transport can copy it without doing work in
// the HTTP task. The dedicated mux protects only this small copy and never nests with actuator state.
void publishNetworkSnapshot(bool force = false) {
  const uint32_t nowMs = millis();
  if (!force && nowMs - liveStatusLastPublishMs < 100U) return;
  LiveStatusSnapshot next = {};
  const uint32_t nowUs = micros();
  next.actuator = actuator.snapshot(nowUs);
  next.thermocoupleC = maxThermocoupleC;
  next.coldJunctionC = maxColdJunctionC;
  next.calibrationStepIndex = static_cast<uint32_t>(calibrationStepIndex);
  next.calibrationStepCount = static_cast<uint32_t>(calibrationStepCount);
  next.calibrationLogId = calibrationStableLogId;
  const bool calibrationStepValid =
      calibrationActive && calibrationStepIndex < calibrationStepCount;
  next.calibrationStepElapsedSec = calibrationActive
      ? (nowUs - calibrationStepStartedUs) / 1000000U : 0U;
  next.calibrationCurrentFanDeci = calibrationStepValid
      ? static_cast<uint8_t>((calibrationStepFanMilli[calibrationStepIndex] + 50U) / 100U)
      : 0U;
  next.calibrationCurrentHeatDeci = calibrationStepValid
      ? static_cast<uint8_t>((calibrationHeatMilli[calibrationStepIndex] + 50U) / 100U)
      : 0U;
  next.calibrationSettleState =
      liveCalibrationSettleState(next.calibrationStepElapsedSec);
  next.calibrationEndReason = liveCalibrationEndReason(calibrationEndReason);
  const size_t completedCount = calibrationCompletedEventUsed >
      kCalibrationCompletedEventCount ? kCalibrationCompletedEventCount
                                      : calibrationCompletedEventUsed;
  next.calibrationCompletedStepCount = static_cast<uint8_t>(completedCount);
  for (size_t index = 0; index < completedCount; ++index) {
    const CalibrationCompletedEvent& source = calibrationCompletedEvents[index];
    LiveCalibrationCompletedStep& destination =
        next.calibrationCompletedSteps[index];
    destination.index = source.index;
    destination.fanDeci = source.fanDeci;
    destination.heatDeci = source.heatDeci;
    destination.elapsedSec = source.elapsedSec;
    destination.temperatureC = source.temperatureC;
    destination.outcome = source.outcome != nullptr &&
            strcmp(source.outcome, "settled") == 0
        ? LiveCalibrationOutcome::SETTLED
        : source.outcome != nullptr && strcmp(source.outcome, "capped") == 0
            ? LiveCalibrationOutcome::CAPPED
            : LiveCalibrationOutcome::UNKNOWN;
  }
  next.manualSinceMs = manualActive ? nowMs - manualSinceMs : 0U;
  portENTER_CRITICAL(&thermalLogMux);
  next.thermalLogCount = thermalLogCount;
  next.thermalLogId = thermalLogReservedId;
  next.thermalLogSource = thermalLogSource;
  next.thermalLogActive = thermalLogActive;
  next.thermalLogUnsaved = thermalLogUnsaved;
  next.thermalLogIntervalMs = thermalLogIntervalMs;
  portEXIT_CRITICAL(&thermalLogMux);
  next.calibrationActive = calibrationActive;
  next.manualConflictLatched = manualConflictLatched;
  next.manualActive = manualActive;
  next.roastActive = roastActive;
  next.roastJourney = roastMode == RoastMode::JOURNEY;
  next.roastElapsedSec = roastActive ? (nowMs - roastStartedMs) / 1000U
                                     : roastElapsedSec;
  next.roastSaturated = roastSaturated;
  next.roastHoldover = roastHoldover;
  next.roastMode = roastMode;
  next.roastStartedEpoch = roastStartEpoch;
  strlcpy(next.roastName, roastName, sizeof(next.roastName));
  next.roastAmbientC = static_cast<float>(roastAmbientC);
  next.roastBatchMassG = static_cast<float>(roastBatchMassG);
  next.roastZoneIndex =
      static_cast<uint32_t>(roastControlState.zoneIndex);
  next.roastZoneCount = static_cast<uint32_t>(roastZoneCount);
  next.roastTargetC = static_cast<float>(roastTargetC);
  // The per-tick Journey progress tuple, read from the SAME executor state the
  // control law advances (`roastControlState`), never from a cached copy: if
  // the executor moves, the very next publication reports the move.
  const bool journeyZoneValid = roastMode == RoastMode::JOURNEY &&
      roastControlState.zoneIndex < roastZoneCount;
  next.roastZoneEntrySec = roastControlState.zoneEntrySec > 0.0
      ? static_cast<uint32_t>(roastControlState.zoneEntrySec) : 0U;
  next.roastZoneNominalSec = journeyZoneValid && roastZones[roastControlState.zoneIndex].durationSec > 0.0
      ? static_cast<uint32_t>(roastZones[roastControlState.zoneIndex].durationSec)
      : 0U;
  next.roastZoneEndC = journeyZoneValid
      ? static_cast<float>(roastZones[roastControlState.zoneIndex].endC) : NAN;
  next.roastCorrectionTotal = static_cast<float>(roastCorrectionTotal);
  next.roastIntegral = static_cast<float>(roastIntegral);
  next.roastSolvedFan = static_cast<float>(roastCommandFan);
  next.roastSolvedHeat = static_cast<float>(roastCommandHeat);
  next.roastHoldoverMs = roastHeatContinuity.holdoverActive
      ? nowMs - roastHeatContinuity.holdoverSinceMs : 0U;
  for (size_t index = 0; index < sr800::kMaxJourneyZones; ++index) {
    next.roastZoneAttainedSec[index] = roastZoneAttainedSec[index];
  }
  strlcpy(next.roastEndReason, roastEndReason, sizeof(next.roastEndReason));
  liveStreamSequence = sr800::runtime::nextSequence(liveStreamSequence);
  next.bootId = bootCount;
  next.streamSeq = liveStreamSequence;
  next.roastSessionId = roastSessionId;
  next.roastPlanRevision = roastPlanRevision;
  next.stateRevision = currentStateRevision();
  next.lastCommandId = lastNetworkCommandId;
  next.lastCommandStatus = lastNetworkCommandStatus;
  next.sensorConfigured = max31856Configured;
  next.thermocoupleOffsetC = thermocoupleOffsetC;
  next.temperatureValid = thermocoupleFreshValid(nowMs, 2000U);
  next.sensorFaultStatus = maxFaultStatus;
  next.sensorSampleAgeMs =
      maxLastSampleMs == 0 ? UINT32_MAX : nowMs - maxLastSampleMs;
  next.calibrationReady =
      calibrationReadiness.ready(nowMs) &&
      !maxSensorFaultQualifier.qualified();
  next.calibrationStableForMs = calibrationReadiness.stableForMs(nowMs);
  strlcpy(next.calibrationReadiness,
      maxSensorFaultQualifier.qualified()
          ? "sensor_fault_latched"
          : sr800::CalibrationReadiness::reasonName(
                calibrationReadiness.reason()),
      sizeof(next.calibrationReadiness));
  next.calibrationMaxStepSeconds = calibrationStepMs / 1000U;
  next.calibrationMinStepSeconds = calibrationMinDwellMs / 1000U;
  next.calibrationSettleSeconds = calibrationSettleSeconds;
  next.calibrationSettleBandC = calibrationSettleBandC;
  next.calibrationStartedEpoch = calibrationStartedEpoch;
  next.calibrationCompletedEpoch = calibrationCompletedEpoch;
  next.recordingAvailable = thermalLog != nullptr;
  next.manualFanMilli = manualFanMilli;
  next.manualHeatMilli = manualHeatMilli;
  next.manualInstructionAgeMs =
      manualActive ? nowMs - manualLastInstructionMs : 0U;
  strlcpy(next.manualEndReason, manualEndReason,
          sizeof(next.manualEndReason));
  next.logArchiveMounted = logArchiveMounted;
  next.logArchiveNeedsFormat = logArchiveNeedsFormat;
  next.logArchiveCount = logArchiveCount;
  next.logArchiveLostLogs = logArchiveLostLogs;
  next.dataStoreMounted = dataStoreMounted;
  next.dataStoreUsedBytes = dataStoreUsedBytes;
  next.dataStoreRunCount = dataStoreRunCount;
  next.dataStoreRunBytes = dataStoreRunBytes;
  next.storageTotalBytes = storageExpectedSize;
  next.appliedCalibrationPresent = appliedCalibration.present;
  next.heaterGain = appliedCalibration.heaterGain;
  next.fanCooling = appliedCalibration.fanCooling;
  next.coolingFan = appliedCalibration.coolingFan;
  next.lossPerMin = appliedCalibration.lossPerMin;
  strlcpy(next.calibrationFitId, appliedCalibration.fitId,
          sizeof(next.calibrationFitId));
  next.calibrationAppliedEpoch = appliedCalibration.appliedEpoch;
  refreshRestoreLease();
  next.restoreActive = restoreLease.active;
  next.restoreIncomplete = restoreLease.incomplete;
  next.restoreExpiresInMs =
      restoreLease.active &&
      sr800::runtime::deadlinePending(nowMs, restoreLease.expiresAtMs)
          ? restoreLease.expiresAtMs - nowMs : 0U;
  next.clockSynced = time(nullptr) > 1600000000;
  next.stationConnected = WiFi.status() == WL_CONNECTED;
  next.stationRssiDbm = next.stationConnected ? WiFi.RSSI() : 0;
  portENTER_CRITICAL(&wifiEventMux);
  next.wifiDisconnectCount = wifiDisconnectCount;
  next.wifiPollReconnectAttemptCount = wifiPollReconnectAttemptCount;
  next.wifiGotIpCount = wifiGotIpCount;
  next.wifiLastDisconnectMs = wifiLastDisconnectMs;
  next.wifiLastGotIpMs = wifiLastGotIpMs;
  next.wifiLastDisconnectReason = wifiLastDisconnectReason;
  portEXIT_CRITICAL(&wifiEventMux);
  next.actuationWifiAwake = actuationWifiAwake;
  next.wifiSleepEnabled = WiFi.getSleep() != WIFI_PS_NONE;
  next.appUsedBytes = cachedAppUsedBytes;
  next.appSlotBytes = cachedAppSlotBytes;
  next.resetReason = bootResetReason;
  next.bootHistoryCount = bootHistoryCount;
  memcpy(next.bootHistory, bootHistory, sizeof(next.bootHistory));
  next.uptimeMs = nowMs;
  next.freeHeapBytes = ESP.getFreeHeap();
  next.minimumFreeHeapBytes = ESP.getMinFreeHeap();
  next.largestFreeHeapBlockBytes = ESP.getMaxAllocHeap();
  next.freePsramBytes = ESP.getFreePsram();
  next.minimumFreePsramBytes = ESP.getMinFreePsram();
  samplePsramLowWater(nowMs);
  next.largestFreePsramBlockBytes = ESP.getMaxAllocPsram();
  next.lastLoopGapMs = lastLoopGapMs;
  next.maximumLoopGapMs = maximumLoopGapMs;
  next.lastArchivePersistMs = lastThermalArchivePersistMs;
  next.maximumArchivePersistMs = maximumThermalArchivePersistMs;
  next.archivePersistCount = thermalArchivePersistCount;
  portENTER_CRITICAL(&liveStatusMux);
  liveStatusSnapshot = next;
  portEXIT_CRITICAL(&liveStatusMux);
  liveStatusLastPublishMs = nowMs;
}

LiveStatusSnapshot copyLiveStatusSnapshot() {
  LiveStatusSnapshot copy = {};
  portENTER_CRITICAL(&liveStatusMux);
  copy = liveStatusSnapshot;
  portEXIT_CRITICAL(&liveStatusMux);
  return copy;
}

// JSON has no NaN or Infinity (JSON.parse rejects both). Every float emitted as
// a JSON number goes through here, and a non-finite value becomes null.
const char* jsonNumber(char* out, size_t size, const char* format,
                       double value) {
  if (!isfinite(value)) {
    strlcpy(out, "null", size);
  } else {
    snprintf(out, size, format, value);
  }
  return out;
}

// One compact live payload feeds both the WebSocket stream and the HTTP fallback.
size_t buildLiveStatusJson(char* buffer, size_t capacity) {
  const LiveStatusSnapshot source = copyLiveStatusSnapshot();
  const sr800::ActuatorSnapshot& live = source.actuator;
  char thermocouple[20];
  char coldJunction[20];
  if (!isfinite(source.thermocoupleC)) strcpy(thermocouple, "null");
  else snprintf(thermocouple, sizeof(thermocouple), "%.2f", source.thermocoupleC);
  if (!isfinite(source.coldJunctionC)) strcpy(coldJunction, "null");
  else snprintf(coldJunction, sizeof(coldJunction), "%.2f", source.coldJunctionC);
  char roastTarget[20];
  if (!source.roastJourney || !isfinite(source.roastTargetC)) {
    strcpy(roastTarget, "null");
  } else {
    snprintf(roastTarget, sizeof(roastTarget), "%.2f", source.roastTargetC);
  }
  // The rest of the Journey tuple keeps the same null discipline: a value that
  // only a journey has is null for every other mode, never a fake zero.
  char roastZoneEnd[20];
  char roastCorrection[20];
  char roastIntegralText[20];
  if (!source.roastJourney || !isfinite(source.roastZoneEndC)) {
    strcpy(roastZoneEnd, "null");
  } else {
    snprintf(roastZoneEnd, sizeof(roastZoneEnd), "%.2f", source.roastZoneEndC);
  }
  if (!source.roastJourney) {
    strcpy(roastCorrection, "null");
    strcpy(roastIntegralText, "null");
  } else {
    jsonNumber(roastCorrection, sizeof(roastCorrection), "%.2f",
               source.roastCorrectionTotal);
    jsonNumber(roastIntegralText, sizeof(roastIntegralText), "%.2f",
               source.roastIntegral);
  }
  char roastBatchText[20];
  char roastAmbientText[20];
  char roastSolvedFanText[20];
  char roastSolvedHeatText[20];
  jsonNumber(roastBatchText, sizeof(roastBatchText), "%.1f",
             source.roastBatchMassG);
  jsonNumber(roastAmbientText, sizeof(roastAmbientText), "%.2f",
             source.roastAmbientC);
  jsonNumber(roastSolvedFanText, sizeof(roastSolvedFanText), "%.2f",
             source.roastSolvedFan);
  jsonNumber(roastSolvedHeatText, sizeof(roastSolvedHeatText), "%.2f",
             source.roastSolvedHeat);
  char calibrationId[16];
  if (source.calibrationLogId == 0) calibrationId[0] = '\0';
  else snprintf(calibrationId, sizeof(calibrationId), "%lu",
                static_cast<unsigned long>(source.calibrationLogId));
  char logId[16];
  if (source.thermalLogId == 0) logId[0] = '\0';
  else snprintf(logId, sizeof(logId), "%lu",
                static_cast<unsigned long>(source.thermalLogId));
  char stableDeviceId[sr800::logcodec::kArchiveDeviceIdBytes];
  formatStableDeviceId(stableDeviceId, sizeof(stableDeviceId));

  const int prefixLength = snprintf(
      buffer, capacity,
      "{\"firmware_version\":\"%s\",\"roaster\":{\"device_id\":\"%s\","
      "\"model_id\":\"%s\",\"display_name\":\"%s\",\"simulated\":false},"
      "\"capabilities\":{\"api_version\":\"diagnostic-v1\","
      "\"diagnostic_tests\":true,\"manual_roast\":true},"
      "\"manual_conflict_latched\":%s,"
      "\"boot_id\":\"%lu\",\"state_rev\":\"%llu\",\"stream_seq\":%lu,"
      "\"roast_session_id\":%lu,\"plan_rev\":%lu,"
      "\"tc_c\":%s,\"cj_c\":%s,\"fan\":%.1f,\"heat\":%.1f,"
      "\"fan_req\":%.1f,\"heat_req\":%.1f,\"mode\":\"%s\",\"fault\":\"%s\","
      "\"cal_active\":%s,\"cal_step\":%lu,"
      "\"cal_count\":%lu,\"cal_id\":\"%s\",\"manual_active\":%s,\"manual_since_ms\":%lu,"
      "\"log_samples\":%lu,\"log_active\":%s,\"log_id\":\"%s\",\"log_source\":\"%s\","
      "\"roast_active\":%s,\"roast_journey\":%s,\"roast_mode\":\"%s\","
      "\"roast_saturated\":%s,\"roast_holdover\":%s,"
      "\"roast_name\":\"%s\",\"roast_started_epoch\":%lu,"
      "\"roast_batch_g\":%s,\"roast_ambient_c\":%s,"
      "\"roast_elapsed_s\":%lu,\"roast_zone\":%lu,\"roast_zones\":%lu,"
      "\"roast_target_c\":%s,\"roast_zone_entry_s\":%lu,"
      "\"roast_zone_nominal_s\":%lu,\"roast_zone_end_c\":%s,"
      "\"roast_correction\":%s,\"roast_integral\":%s,"
      "\"roast_solved_fan\":%s,\"roast_solved_heat\":%s,"
      "\"roast_holdover_ms\":%lu,\"roast_end\":\"%s\","
      "\"cal_fan\":%.1f,\"cal_heat\":%.1f,"
      "\"cal_elapsed_s\":%lu,\"cal_settle\":\"%s\",\"cal_end\":\"%s\",\"cal_done\":[",
      kFirmwareVersion, stableDeviceId, kRoasterModelId, kRoasterDisplayName,
      source.manualConflictLatched ? "true" : "false",
      static_cast<unsigned long>(source.bootId),
      static_cast<unsigned long long>(source.stateRevision),
      static_cast<unsigned long>(source.streamSeq),
      static_cast<unsigned long>(source.roastSessionId),
      static_cast<unsigned long>(source.roastPlanRevision),
      thermocouple, coldJunction,
      live.effectiveFanMilli / 1000.0f, live.effectiveHeatMilli / 1000.0f,
      live.requestedFanMilli / 1000.0f, live.requestedHeatMilli / 1000.0f,
      sr800::Actuator::modeName(live.mode), sr800::Actuator::faultName(live.fault),
      source.calibrationActive ? "true" : "false",
      static_cast<unsigned long>(source.calibrationStepIndex),
      static_cast<unsigned long>(source.calibrationStepCount),
      calibrationId,
      source.manualActive ? "true" : "false",
      static_cast<unsigned long>(source.manualSinceMs),
      static_cast<unsigned long>(source.thermalLogCount),
      source.thermalLogActive ? "true" : "false",
      logId,
      thermalLogSourceName(source.thermalLogSource),
      source.roastActive ? "true" : "false",
      source.roastJourney ? "true" : "false",
      roastModeName(source.roastMode),
      source.roastSaturated ? "true" : "false",
      source.roastHoldover ? "true" : "false",
      source.roastName,
      static_cast<unsigned long>(source.roastStartedEpoch),
      roastBatchText,
      roastAmbientText,
      static_cast<unsigned long>(source.roastElapsedSec),
      static_cast<unsigned long>(source.roastZoneIndex),
      static_cast<unsigned long>(source.roastZoneCount),
      roastTarget,
      static_cast<unsigned long>(source.roastZoneEntrySec),
      static_cast<unsigned long>(source.roastZoneNominalSec),
      roastZoneEnd,
      roastCorrection,
      roastIntegralText,
      roastSolvedFanText,
      roastSolvedHeatText,
      static_cast<unsigned long>(source.roastHoldoverMs),
      source.roastEndReason,
      source.calibrationCurrentFanDeci / 10.0f,
      source.calibrationCurrentHeatDeci / 10.0f,
      static_cast<unsigned long>(source.calibrationStepElapsedSec),
      liveCalibrationSettleStateName(source.calibrationSettleState),
      liveCalibrationEndReasonName(source.calibrationEndReason));
  if (prefixLength <= 0 || static_cast<size_t>(prefixLength) >= capacity) {
    return 0;
  }
  size_t used = static_cast<size_t>(prefixLength);
  const size_t completedCount = source.calibrationCompletedStepCount >
      kCalibrationCompletedEventCount ? kCalibrationCompletedEventCount
                                      : source.calibrationCompletedStepCount;
  for (size_t index = 0; index < completedCount; ++index) {
    const LiveCalibrationCompletedStep& event =
        source.calibrationCompletedSteps[index];
    char temperature[20];
    if (!isfinite(event.temperatureC)) strcpy(temperature, "null");
    else snprintf(temperature, sizeof(temperature), "%.2f", event.temperatureC);
    const int eventLength = snprintf(
        buffer + used, capacity - used,
        "%s{\"index\":%u,\"fan\":%.1f,\"heat\":%.1f,"
        "\"elapsed_sec\":%u,\"temperature_c\":%s,\"outcome\":\"%s\"}",
        index == 0 ? "" : ",", event.index, event.fanDeci / 10.0f,
        event.heatDeci / 10.0f, event.elapsedSec, temperature,
        liveCalibrationOutcomeName(event.outcome));
    if (eventLength <= 0 ||
        static_cast<size_t>(eventLength) >= capacity - used) {
      return 0;
    }
    used += static_cast<size_t>(eventLength);
  }
  // Per-zone attainment offsets, exactly as the archive header reports them:
  // null is "this endpoint was never reached", and the array is empty for
  // anything that is not a journey (a journey is the only mode with zones).
  const int attainedOpen = snprintf(buffer + used, capacity - used,
                                    "],\"roast_zones_done\":[");
  if (attainedOpen <= 0 ||
      static_cast<size_t>(attainedOpen) >= capacity - used) {
    return 0;
  }
  used += static_cast<size_t>(attainedOpen);
  const size_t attainedCount = source.roastZoneCount > sr800::kMaxJourneyZones
      ? sr800::kMaxJourneyZones : source.roastZoneCount;
  for (size_t index = 0; index < attainedCount; ++index) {
    int attainedLength;
    if (source.roastZoneAttainedSec[index] == kRoastZoneNotAttained) {
      attainedLength = snprintf(buffer + used, capacity - used, "%snull",
                                index == 0 ? "" : ",");
    } else {
      attainedLength = snprintf(
          buffer + used, capacity - used, "%s%u", index == 0 ? "" : ",",
          static_cast<unsigned>(source.roastZoneAttainedSec[index]));
    }
    if (attainedLength <= 0 ||
        static_cast<size_t>(attainedLength) >= capacity - used) {
      return 0;
    }
    used += static_cast<size_t>(attainedLength);
  }
  const int suffixLength = snprintf(buffer + used, capacity - used, "]}");
  if (suffixLength <= 0 ||
      static_cast<size_t>(suffixLength) >= capacity - used) {
    return 0;
  }
  return used + static_cast<size_t>(suffixLength);
}

size_t buildControllerStatusJson(char* buffer, size_t capacity) {
  const LiveStatusSnapshot source = copyLiveStatusSnapshot();
  const OtaAttemptDiagnostics otaDiagnostics = copyOtaAttemptDiagnostics();
  const sr800::ActuatorSnapshot& live = source.actuator;
  size_t used = 0;
  const auto append = [&](const char* format, auto... values) {
    if (used >= capacity) return false;
    const int length = snprintf(
        buffer + used, capacity - used, format, values...);
    if (length <= 0 ||
        static_cast<size_t>(length) >= capacity - used) return false;
    used += static_cast<size_t>(length);
    return true;
  };

  char stableDeviceId[sr800::logcodec::kArchiveDeviceIdBytes];
  formatStableDeviceId(stableDeviceId, sizeof(stableDeviceId));
  char thermocouple[20];
  char coldJunction[20];
  char roastTarget[20];
  char maxFaultReasons[256];
  formatMax31856FaultReasonsJson(source.sensorFaultStatus,
                                 source.sensorConfigured, maxFaultReasons, sizeof(maxFaultReasons));
  if (!source.temperatureValid || !isfinite(source.thermocoupleC)) {
    strcpy(thermocouple, "null");
  } else {
    snprintf(thermocouple, sizeof(thermocouple), "%.2f",
             source.thermocoupleC);
  }
  if (!isfinite(source.coldJunctionC)) strcpy(coldJunction, "null");
  else snprintf(coldJunction, sizeof(coldJunction), "%.2f",
                source.coldJunctionC);
  if (!source.roastJourney || !isfinite(source.roastTargetC)) {
    strcpy(roastTarget, "null");
  } else {
    snprintf(roastTarget, sizeof(roastTarget), "%.2f",
             source.roastTargetC);
  }
  // Journey-only members of the roast block share target_c's null discipline.
  char roastZoneEnd[20];
  char roastCorrection[20];
  char roastIntegralText[20];
  if (!source.roastJourney || !isfinite(source.roastZoneEndC)) {
    strcpy(roastZoneEnd, "null");
  } else {
    snprintf(roastZoneEnd, sizeof(roastZoneEnd), "%.2f",
             source.roastZoneEndC);
  }
  if (!source.roastJourney) {
    strcpy(roastCorrection, "null");
    strcpy(roastIntegralText, "null");
  } else {
    jsonNumber(roastCorrection, sizeof(roastCorrection), "%.2f",
               source.roastCorrectionTotal);
    jsonNumber(roastIntegralText, sizeof(roastIntegralText), "%.2f",
               source.roastIntegral);
  }
  // Every remaining float-valued JSON number, null when non-finite.
  char offsetText[20];
  char settleBandText[20];
  char solvedFanText[20];
  char solvedHeatText[20];
  char ambientText[20];
  char batchMassText[20];
  jsonNumber(offsetText, sizeof(offsetText), "%.2f",
             source.thermocoupleOffsetC);
  jsonNumber(settleBandText, sizeof(settleBandText), "%.1f",
             source.calibrationSettleBandC);
  jsonNumber(solvedFanText, sizeof(solvedFanText), "%.3f",
             source.roastSolvedFan);
  jsonNumber(solvedHeatText, sizeof(solvedHeatText), "%.3f",
             source.roastSolvedHeat);
  jsonNumber(ambientText, sizeof(ambientText), "%.2f", source.roastAmbientC);
  jsonNumber(batchMassText, sizeof(batchMassText), "%.1f",
             source.roastBatchMassG);
  const char* lifecycle = source.manualConflictLatched
      ? "MANUAL_LOCKOUT"
      : live.fault != sr800::ActuatorFault::NONE
          ? "FAULT"
          : source.calibrationActive || source.manualActive ||
                source.roastActive ||
                live.mode != sr800::ActuatorMode::IDLE
              ? "RUNNING" : "STANDBY";
  const uint32_t freeAppBytes =
      source.appSlotBytes > source.appUsedBytes
          ? source.appSlotBytes - source.appUsedBytes : 0U;
  const uint32_t freeStorageBytes =
      source.storageTotalBytes > source.dataStoreUsedBytes
          ? source.storageTotalBytes - source.dataStoreUsedBytes : 0U;

  char storageLowWaterRoute[48];
  sr800::network::storageStackLowWaterRoute(storageLowWaterRoute, sizeof(storageLowWaterRoute));
  uint32_t storageSlowestMs = 0;
  uint32_t storageOverOneSecond = 0;
  char storageSlowestRoute[48];
  sr800::network::storageSlowestRequest(storageSlowestMs, storageOverOneSecond,
                                        storageSlowestRoute, sizeof(storageSlowestRoute));
  if (!append(
      R"json({"firmware_version":"%s","web_bundle_version":"%s","roaster":{"device_id":"%s","model_id":"%s","display_name":"%s","simulated":false},"capabilities":{"api_version":"diagnostic-v1","diagnostic_tests":true,"manual_roast":true},"boot_id":"%lu","state_rev":"%llu","last_request_id":%lu,"last_request_status":%u,"lifecycle":"%s","manual_conflict_latched":%s,"thermocouple_offset_c":%s,"ota_slot_bytes":%lu,"app_used_bytes":%lu,"app_free_bytes":%lu,"spiffs_reserved_bytes":%lu,"controller_history_enabled":false,"controller_history_used_bytes":0,"live_websocket_available":true,"live_websocket_port":%u,"live_websocket_client_count":%lu,"live_websocket_client_capacity":%lu,"live_websocket_broadcast_count":%lu,"live_websocket_send_failure_count":%lu,"live_websocket_queue_failure_count":0,"live_websocket_stack_low_water_bytes":%lu,"http_rejected_request_count":%lu,"http_worker_failure_count":%lu,"http_worker_stack_low_water_bytes":%lu,"http_asset_worker_stack_low_water_bytes":%lu,"http_command_worker_stack_low_water_bytes":%lu,"storage_worker_stack_low_water_bytes":%lu,"storage_worker_stack_low_water_route":"%s","storage_request_slowest_ms":%lu,"storage_request_slowest_route":"%s","storage_requests_over_1s":%lu,)json",
      kFirmwareVersion, sr800::crackle::kCrackleBundleVersion,
      stableDeviceId, kRoasterModelId, kRoasterDisplayName,
      static_cast<unsigned long>(source.bootId),
      static_cast<unsigned long long>(source.stateRevision),
      static_cast<unsigned long>(source.lastCommandId),
      static_cast<unsigned>(source.lastCommandStatus), lifecycle,
      source.manualConflictLatched ? "true" : "false",
      offsetText,
      static_cast<unsigned long>(source.appSlotBytes),
      static_cast<unsigned long>(source.appUsedBytes),
      static_cast<unsigned long>(freeAppBytes),
      static_cast<unsigned long>(source.storageTotalBytes),
      static_cast<unsigned>(kNativeHttpPort),
      static_cast<unsigned long>(sr800::network::liveSubscriberCount()),
      static_cast<unsigned long>(sr800::network::liveSubscriberCapacity()),
      static_cast<unsigned long>(sr800::network::liveSnapshotCount() +
                                 sr800::network::liveDeltaCount()),
      static_cast<unsigned long>(sr800::network::liveSendFailureCount()),
      static_cast<unsigned long>(
          sr800::network::livePublisherStackLowWaterBytes()),
      static_cast<unsigned long>(sr800::network::httpRejectedRequestCount()),
      static_cast<unsigned long>(sr800::network::httpWorkerFailureCount()),
      static_cast<unsigned long>(sr800::network::httpStackLowWaterBytes()),
      static_cast<unsigned long>(sr800::network::assetWorkerStackLowWaterBytes()),
      static_cast<unsigned long>(sr800::network::commandWorkerStackLowWaterBytes()),
      static_cast<unsigned long>(
          sr800::network::storageStackLowWaterBytes()),
      storageLowWaterRoute,
      static_cast<unsigned long>(storageSlowestMs), storageSlowestRoute,
      static_cast<unsigned long>(storageOverOneSecond))) {
    return 0;
  }
  if (!append(
      R"json("ota_handler_stack_low_water_bytes":%lu,"ota_last_attempt":{"attempted":%s,"declared_bytes":%lu,"received_bytes":%lu,"target_offset":%lu,"error":"%s","readback_complete":%s,"readback_match":%s,"received_sha256":"%s","flash_sha256":"%s"},)json",
      static_cast<unsigned long>(
          sr800::network::otaHandlerStackLowWaterBytes()),
      otaDiagnostics.attempted ? "true" : "false",
      static_cast<unsigned long>(otaDiagnostics.declaredBytes),
      static_cast<unsigned long>(otaDiagnostics.receivedBytes),
      static_cast<unsigned long>(otaDiagnostics.targetOffset),
      esp_err_to_name(otaDiagnostics.error),
      otaDiagnostics.readbackComplete ? "true" : "false",
      otaDiagnostics.readbackMatched ? "true" : "false",
      otaDiagnostics.receivedSha256,
      otaDiagnostics.flashSha256)) {
    return 0;
  }

  if (!append(
      R"json("system":{"reset_reason":"%s","uptime_ms":%lu,"heap_free_bytes":%lu,"heap_minimum_free_bytes":%lu,"heap_largest_free_block_bytes":%lu,"psram_free_bytes":%lu,"psram_minimum_free_bytes":%lu,"psram_largest_free_block_bytes":%lu,"loop_last_gap_ms":%lu,"loop_maximum_gap_ms":%lu,"archive_persist_last_ms":%lu,"archive_persist_maximum_ms":%lu,"archive_persist_count":%lu,"boot_history":[)json",
      resetReasonName(source.resetReason),
      static_cast<unsigned long>(source.uptimeMs),
      static_cast<unsigned long>(source.freeHeapBytes),
      static_cast<unsigned long>(source.minimumFreeHeapBytes),
      static_cast<unsigned long>(source.largestFreeHeapBlockBytes),
      static_cast<unsigned long>(source.freePsramBytes),
      static_cast<unsigned long>(source.minimumFreePsramBytes),
      static_cast<unsigned long>(source.largestFreePsramBlockBytes),
      static_cast<unsigned long>(source.lastLoopGapMs),
      static_cast<unsigned long>(source.maximumLoopGapMs),
      static_cast<unsigned long>(source.lastArchivePersistMs),
      static_cast<unsigned long>(source.maximumArchivePersistMs),
      static_cast<unsigned long>(source.archivePersistCount))) {
    return 0;
  }
  for (uint8_t index = 0; index < source.bootHistoryCount &&
                          index < kBootHistoryCapacity; ++index) {
    if (!append(index == 0 ? R"json({"boot":%lu,"reset_reason":"%s"})json"
                           : R"json(,{"boot":%lu,"reset_reason":"%s"})json",
                static_cast<unsigned long>(source.bootHistory[index].bootId),
                resetReasonName(static_cast<esp_reset_reason_t>(
                    source.bootHistory[index].resetReason)))) {
      return 0;
    }
  }
  if (!append("%s", "]")) return 0;
  {
    portENTER_CRITICAL(&heapDiagnosticsMux);
    const uint32_t lowWater = psramLowWaterBytes;
    const uint32_t lowWaterAt = psramLowWaterAtMs;
    const uint32_t failed = failedAllocationCount;
    const uint32_t failedBytes = lastFailedAllocationBytes;
    const uint32_t failedCaps = lastFailedAllocationCaps;
    const uint32_t failedAt = lastFailedAllocationAtMs;
    portEXIT_CRITICAL(&heapDiagnosticsMux);
    if (!append(R"json(,"psram_low_water_bytes":%lu,"psram_low_water_at_ms":%lu,"failed_allocations":%lu,"last_failed_allocation":{"bytes":%lu,"caps":%lu,"at_ms":%lu})json",
                static_cast<unsigned long>(lowWater == UINT32_MAX ? 0 : lowWater),
                static_cast<unsigned long>(lowWaterAt), static_cast<unsigned long>(failed),
                static_cast<unsigned long>(failedBytes), static_cast<unsigned long>(failedCaps),
                static_cast<unsigned long>(failedAt))) {
      return 0;
    }
  }
  // The last crash the core-dump partition holds, read once at boot. Null when
  // there is none. Its program counters decode against the ELF whose SHA-256
  // prefix is given, which may be an EARLIER build than the one running.
  if (!storedCrash.present) {
    if (!append("%s", R"json(,"stored_crash":null)json")) return 0;
  } else {
    if (!append(R"json(,"stored_crash":{"task":"%s","pc":"0x%08lx","corrupted":%s,"elf_sha256":"%s","current_build":%s,"backtrace":[)json",
                storedCrash.task, static_cast<unsigned long>(storedCrash.pc),
                storedCrash.corrupted ? "true" : "false", storedCrash.elfSha256,
                storedCrash.currentBuild ? "true" : "false")) {
      return 0;
    }
    for (uint8_t index = 0; index < storedCrash.depth; ++index) {
      if (!append(index == 0 ? R"json("0x%08lx")json" : R"json(,"0x%08lx")json",
                  static_cast<unsigned long>(storedCrash.backtrace[index]))) {
        return 0;
      }
    }
    if (!append("%s", "]}")) return 0;
  }
  if (!append("%s", "},")) return 0;

  if (!append(
      R"json("actuator":{"mode":"%s","fault":"%s","requested_fan":%.3f,"requested_heat":%.3f,"effective_fan":%.3f,"effective_heat":%.3f,"overtemp_limit_c":%.1f,"overtemp_cooldown_remaining_ms":%lu},"max31856":{"configured":%s,"temperature_valid":%s,"thermocouple_c":%s,"cold_junction_c":%s,"fault_status":%u,"fault_reasons":%s,"sample_age_ms":)json",
      sr800::Actuator::modeName(live.mode),
      sr800::Actuator::faultName(live.fault),
      live.requestedFanMilli / 1000.0f,
      live.requestedHeatMilli / 1000.0f,
      live.effectiveFanMilli / 1000.0f,
      live.effectiveHeatMilli / 1000.0f,
      static_cast<double>(kOvertempDisableC),
      static_cast<unsigned long>(live.overtempCooldownRemainingMs),
      source.sensorConfigured ? "true" : "false",
      source.temperatureValid ? "true" : "false",
      thermocouple, coldJunction, source.sensorFaultStatus,
      maxFaultReasons)) return 0;
  if (source.sensorSampleAgeMs == UINT32_MAX) {
    if (!append("null")) return 0;
  } else if (!append("%lu",
             static_cast<unsigned long>(source.sensorSampleAgeMs))) {
    return 0;
  }
  if (!append(
      R"json(},"calibration_ready":%s,"calibration_readiness":"%s","calibration_stable_for_ms":%lu,"calibration":{"active":%s,"step_index":%lu,"step_count":%lu,"current_fan_level":%.1f,"current_heat_level":%.1f,"max_step_seconds":%lu,"min_step_seconds":%lu,"settle_seconds":%lu,"settle_band_c":%s,"step_elapsed_sec":%lu,"settle_state":"%s","log_id":"%lu","started_epoch":%lu,"completed_epoch":%lu,"completed_steps":[)json",
      source.calibrationReady ? "true" : "false",
      source.calibrationReadiness,
      static_cast<unsigned long>(source.calibrationStableForMs),
      source.calibrationActive ? "true" : "false",
      static_cast<unsigned long>(source.calibrationStepIndex),
      static_cast<unsigned long>(source.calibrationStepCount),
      source.calibrationCurrentFanDeci / 10.0f,
      source.calibrationCurrentHeatDeci / 10.0f,
      static_cast<unsigned long>(source.calibrationMaxStepSeconds),
      static_cast<unsigned long>(source.calibrationMinStepSeconds),
      static_cast<unsigned long>(source.calibrationSettleSeconds),
      settleBandText,
      static_cast<unsigned long>(source.calibrationStepElapsedSec),
      liveCalibrationSettleStateName(source.calibrationSettleState),
      static_cast<unsigned long>(source.calibrationLogId),
      static_cast<unsigned long>(source.calibrationStartedEpoch),
      static_cast<unsigned long>(source.calibrationCompletedEpoch))) return 0;
  const size_t completedCount = source.calibrationCompletedStepCount >
      kCalibrationCompletedEventCount ? kCalibrationCompletedEventCount
                                      : source.calibrationCompletedStepCount;
  for (size_t index = 0; index < completedCount; ++index) {
    const LiveCalibrationCompletedStep& event =
        source.calibrationCompletedSteps[index];
    char temperature[20];
    if (!isfinite(event.temperatureC)) strcpy(temperature, "null");
    else snprintf(temperature, sizeof(temperature), "%.2f",
                  event.temperatureC);
    if (!append(
        R"json(%s{"index":%u,"fan":%.1f,"heat":%.1f,"elapsed_sec":%u,"temperature_c":%s,"outcome":"%s"})json",
        index == 0 ? "" : ",", event.index,
        event.fanDeci / 10.0f, event.heatDeci / 10.0f,
        event.elapsedSec, temperature,
        liveCalibrationOutcomeName(event.outcome))) return 0;
  }
  if (!append(
      R"json(],"end_reason":"%s"},"thermal_log":{"available":%s,"active":%s,"samples":%lu,"capacity":%lu,"interval_ms":%lu,"source":"%s","log_id":"%lu","unsaved":%s,"download":"/thermal.csv"},"manual":{"active":%s,"fan_level":%.3f,"heat_level":%.3f,"since_ms":%lu,"end_reason":"%s","instruction_age_ms":%lu,"instruction_limit_ms":%lu},)json",
      liveCalibrationEndReasonName(source.calibrationEndReason),
      source.recordingAvailable ? "true" : "false",
      source.thermalLogActive ? "true" : "false",
      static_cast<unsigned long>(source.thermalLogCount),
      static_cast<unsigned long>(kThermalLogCapacity),
      static_cast<unsigned long>(source.thermalLogIntervalMs),
      thermalLogSourceName(source.thermalLogSource),
      static_cast<unsigned long>(source.thermalLogId),
      source.thermalLogUnsaved ? "true" : "false",
      source.manualActive ? "true" : "false",
      source.manualFanMilli / 1000.0f,
      source.manualHeatMilli / 1000.0f,
      static_cast<unsigned long>(source.manualSinceMs),
      source.manualEndReason,
      static_cast<unsigned long>(source.manualInstructionAgeMs),
      static_cast<unsigned long>(kManualInstructionLeaseMs))) return 0;
  // The roast block carries the same per-tick Journey progress tuple as the
  // compact live stream, from the same immutable snapshot: zone entry/elapsed/
  // nominal/endpoint, the solver's own answer beside what was commanded, the
  // live correction, the holdover clock, and per-zone attainment offsets.
  const uint32_t zoneElapsedSec =
      source.roastElapsedSec > source.roastZoneEntrySec
          ? source.roastElapsedSec - source.roastZoneEntrySec : 0U;
  if (!append(
      R"json("roast":{"active":%s,"mode":"%s","name":"%s","session_id":"%lu","plan_rev":%lu,"elapsed_sec":%lu,"started_epoch":%lu,"zone_index":%lu,"zone_count":%lu,"zone_entry_sec":%lu,"zone_elapsed_sec":%lu,"zone_nominal_sec":%lu,"zone_end_c":%s,"target_c":%s,"commanded_fan":%.3f,"commanded_heat":%.3f,"solved_fan":%s,"solved_heat":%s,"correction_total":%s,"integral":%s,"saturated":%s,"holdover":%s,"holdover_ms":%lu,"holdover_limit_ms":%lu,"ambient_c":%s,"batch_mass_g":%s,"end_reason":"%s","zone_attained_sec":[)json",
      source.roastActive ? "true" : "false",
      roastModeName(source.roastMode), source.roastName,
      static_cast<unsigned long>(source.roastSessionId),
      static_cast<unsigned long>(source.roastPlanRevision),
      static_cast<unsigned long>(source.roastElapsedSec),
      static_cast<unsigned long>(source.roastStartedEpoch),
      static_cast<unsigned long>(source.roastZoneIndex),
      static_cast<unsigned long>(source.roastZoneCount),
      static_cast<unsigned long>(source.roastZoneEntrySec),
      static_cast<unsigned long>(zoneElapsedSec),
      static_cast<unsigned long>(source.roastZoneNominalSec),
      roastZoneEnd,
      roastTarget,
      source.actuator.effectiveFanMilli / 1000.0f,
      source.actuator.effectiveHeatMilli / 1000.0f,
      solvedFanText,
      solvedHeatText,
      roastCorrection,
      roastIntegralText,
      source.roastSaturated ? "true" : "false",
      source.roastHoldover ? "true" : "false",
      static_cast<unsigned long>(source.roastHoldoverMs),
      static_cast<unsigned long>(kRoastHoldoverLimitMs),
      ambientText, batchMassText,
      source.roastEndReason)) return 0;
  const size_t statusAttainedCount =
      source.roastZoneCount > sr800::kMaxJourneyZones
          ? sr800::kMaxJourneyZones : source.roastZoneCount;
  for (size_t index = 0; index < statusAttainedCount; ++index) {
    const bool attained =
        source.roastZoneAttainedSec[index] != kRoastZoneNotAttained;
    if (attained
            ? !append("%s%u", index == 0 ? "" : ",",
                      static_cast<unsigned>(source.roastZoneAttainedSec[index]))
            : !append("%snull", index == 0 ? "" : ",")) {
      return 0;
    }
  }
  if (!append(
      R"json(]},"log_archive":{"mounted":%s,"count":%lu,"total_bytes":%lu,"clock_synced":%s,"lost_logs":%lu,"needs_format":%s,"health":"%s","list":"/api/logs"},"data_store":{"mounted":%s,"used_bytes":%lu,"total_bytes":%lu,"free_bytes":%lu,"write_floor_bytes":%lu,"collections":{},"runs":{"count":%lu,"bytes":%lu}},)json",
      source.logArchiveMounted ? "true" : "false",
      static_cast<unsigned long>(source.logArchiveCount),
      static_cast<unsigned long>(source.storageTotalBytes),
      source.clockSynced ? "true" : "false",
      static_cast<unsigned long>(source.logArchiveLostLogs),
      source.logArchiveNeedsFormat ? "true" : "false",
      source.logArchiveMounted ? "healthy"
          : source.logArchiveNeedsFormat ? "needs_format" : "unavailable",
      source.dataStoreMounted ? "true" : "false",
      static_cast<unsigned long>(source.dataStoreUsedBytes),
      static_cast<unsigned long>(source.storageTotalBytes),
      static_cast<unsigned long>(freeStorageBytes),
      static_cast<unsigned long>(sr800::docstore::kVolumeFloorBytes),
      static_cast<unsigned long>(source.dataStoreRunCount),
      static_cast<unsigned long>(source.dataStoreRunBytes))) return 0;
  if (!append(
      R"json("applied_calibration":{"present":%s)json",
      source.appliedCalibrationPresent ? "true" : "false")) return 0;
  if (source.appliedCalibrationPresent) {
    char heaterGainText[24];
    char fanCoolingText[24];
    char coolingFanText[24];
    char lossPerMinText[24];
    jsonNumber(heaterGainText, sizeof(heaterGainText), "%.3f",
               source.heaterGain);
    jsonNumber(fanCoolingText, sizeof(fanCoolingText), "%.3f",
               source.fanCooling);
    jsonNumber(coolingFanText, sizeof(coolingFanText), "%.3f",
               source.coolingFan);
    jsonNumber(lossPerMinText, sizeof(lossPerMinText), "%.4f",
               source.lossPerMin);
    if (!append(
            R"json(,"heater_gain":%s,"fan_cooling":%s,"cooling_fan":%s,"loss_per_min":%s,"fit_id":"%s","applied_epoch":%lu)json",
            heaterGainText, fanCoolingText, coolingFanText, lossPerMinText,
            source.calibrationFitId,
            static_cast<unsigned long>(source.calibrationAppliedEpoch))) {
      return 0;
    }
  }
  if (!append(
      R"json(},"restore_maintenance":{"active":%s,"incomplete":%s,"expires_in_ms":%lu},"station_connected":%s,"station_rssi_dbm":)json",
      source.restoreActive ? "true" : "false",
      source.restoreIncomplete ? "true" : "false",
      static_cast<unsigned long>(source.restoreExpiresInMs),
      source.stationConnected ? "true" : "false")) return 0;
  if (source.stationConnected) {
    if (!append("%ld", static_cast<long>(source.stationRssiDbm))) return 0;
  } else if (!append("null")) {
    return 0;
  }
  if (!append(
      R"json(,"wifi_disconnect_count":%lu,"wifi_poll_reconnect_attempt_count":%lu,"wifi_got_ip_count":%lu,"wifi_last_disconnect_reason":%u,"wifi_last_disconnect_ms":%lu,"wifi_last_got_ip_ms":%lu,"actuation_wifi_awake":%s,"wifi_sleep_enabled":%s,"hostname":"%s.local"})json",
      static_cast<unsigned long>(source.wifiDisconnectCount),
      static_cast<unsigned long>(source.wifiPollReconnectAttemptCount),
      static_cast<unsigned long>(source.wifiGotIpCount),
      static_cast<unsigned>(source.wifiLastDisconnectReason),
      static_cast<unsigned long>(source.wifiLastDisconnectMs),
      static_cast<unsigned long>(source.wifiLastGotIpMs),
      source.actuationWifiAwake ? "true" : "false",
      source.wifiSleepEnabled ? "true" : "false", kHostName)) return 0;
  return used;
}

bool startCrackleHttpServer() {
  sr800::network::HttpServerConfig config;
  config.port = kNativeHttpPort;
  config.controlPort = kNativeHttpShadowControlPort;
  config.assets[0] = {
      "/", sr800::crackle::kIndexContentType, "no-cache",
      sr800::crackle::kIndexGz, sr800::crackle::kIndexGzLength, true};
  config.assets[1] = {
      sr800::crackle::kScriptPath, sr800::crackle::kScriptContentType,
      "public, max-age=31536000, immutable",
      sr800::crackle::kScriptGz, sr800::crackle::kScriptGzLength, true};
  config.assets[2] = {
      sr800::crackle::kStylePath, sr800::crackle::kStyleContentType,
      "public, max-age=31536000, immutable",
      sr800::crackle::kStyleGz, sr800::crackle::kStyleGzLength, true};
  config.assets[3] = {
      "/probe", "text/html; charset=utf-8", "no-cache",
      reinterpret_cast<const uint8_t*>(kPage), sizeof(kPage) - 1, false};
  config.assets[4] = {
      "/update", "text/html; charset=utf-8", "no-cache",
      reinterpret_cast<const uint8_t*>(kUpdatePage),
      sizeof(kUpdatePage) - 1, false};
  config.buildLiveJson = buildLiveStatusJson;
  config.buildStatusJson = buildControllerStatusJson;
  config.handleStorageRequest = handleNativeStorageRequest;
  config.serviceStorage = serviceNativeStorage;
  config.healthResponseServed = markOtaHealthResponseServed;

  config.handleOtaVersion = handleOtaVersion;
  config.handleOtaUpload = handleRawOtaUpload;
  return sr800::network::beginHttpServer(config);
}

void formatCentiColumn(char* column, size_t length, int16_t value) {
  if (value == INT16_MIN) {
    column[0] = '\0';
    return;
  }
  snprintf(column, length, "%.2f", value / 100.0);
}

void formatThermalCsvRow(char* row, size_t length,
                         const sr800::logcodec::RawSample& sample) {
  char thermocouple[16];
  char coldJunction[16];
  formatCentiColumn(thermocouple, sizeof(thermocouple),
                    sample.thermocoupleCenti);
  formatCentiColumn(coldJunction, sizeof(coldJunction),
                    sample.coldJunctionCenti);
  snprintf(row, length, "%lu,%s,%s,%.3f,%.3f\n",
           static_cast<unsigned long>(sample.tMs),
           thermocouple, coldJunction,
           sample.fanMilli / 1000.0, sample.heatMilli / 1000.0);
}

// The delta-codec row (v3/v4): the columns are identical, and every value prints at
// EXACTLY the precision the file holds — one decimal. Not two: a trailing digit
// the archive does not store would claim a precision that is not there, and
// every consumer downstream would believe it. Not zero either: the passive
// decay tail moves a fraction of a degree per second, and printing "187" for a
// sample that stored 187.4 would hand the loss/tau fit a staircase. A reader
// live safety/status keeps the unquantized float separately from this recording.
void formatDeciColumn(char* column, size_t length, bool valid, int16_t value) {
  if (!valid) {
    column[0] = '\0';
    return;
  }
  snprintf(column, length, "%.1f", value / 10.0);
}

void formatThermalCsvRow(char* row, size_t length,
                         const sr800::logcodec::Sample& sample) {
  char thermocouple[16];
  char coldJunction[16];
  formatDeciColumn(thermocouple, sizeof(thermocouple),
                   sample.thermocoupleValid, sample.thermocoupleDeci);
  formatDeciColumn(coldJunction, sizeof(coldJunction),
                   sample.coldJunctionValid, sample.coldJunctionDeci);
  snprintf(row, length, "%lu,%s,%s,%.1f,%.1f\n",
           static_cast<unsigned long>(sample.tMs),
           thermocouple, coldJunction,
           sample.fanDeci / 10.0, sample.heatDeci / 10.0);
}

void handleThermalCsv() {
  ThermalLogStateSnapshot recording;
  const bool mutableRead = mutableThermalCsvSnapshot(recording);
  char filename[96];
  snprintf(filename, sizeof(filename),
           "attachment; filename=crackle-thermal-%s.csv", kFirmwareVersion);
  HttpResponseWriter response;
  response.begin("text/csv", filename, "no-store");
  response += F("t_ms,thermocouple_c,cold_junction_c,effective_fan,effective_heat\n");
  char row[96];
  if (!mutableRead) {
    for (uint32_t index = 0; index < recording.sampleCount; ++index) {
      if (!response.ok()) break;
      formatThermalCsvRow(row, sizeof(row), toCodecSample(thermalLog[index]));
      response += row;
      if ((index & 0x3F) == 0) pacedYield();
    }
    response.finish();
    return;
  }
  // An active capture is served as the fenced prefix, copied out in bounded
  // chunks under short critical sections: the loopTask sampler appends every
  // 250 ms and must never wait behind a socket send, so the mux is never held
  // across a response write. The native storage task is the only bulk-response
  // writer, so one static chunk buffer is sufficient and the 12 KB task stack
  // never carries it.
  constexpr uint32_t kThermalCsvChunkSamples = 64;
  static ThermalSample thermalCsvChunk[kThermalCsvChunkSamples];
  for (uint32_t index = 0; index < recording.sampleCount && response.ok();) {
    const uint32_t take = recording.sampleCount - index < kThermalCsvChunkSamples
        ? recording.sampleCount - index : kThermalCsvChunkSamples;
    portENTER_CRITICAL(&thermalLogMux);
    // A stop+start can hand the buffer to a new episode mid-read. End the CSV
    // at the rows already written rather than splicing two recordings.
    const bool sameEpisode = thermalLogReservedId == recording.reservedId;
    if (sameEpisode) {
      memcpy(thermalCsvChunk, &thermalLog[index],
             take * sizeof(ThermalSample));
    }
    portEXIT_CRITICAL(&thermalLogMux);
    if (!sameEpisode) break;
    for (uint32_t offset = 0; offset < take && response.ok(); ++offset) {
      formatThermalCsvRow(row, sizeof(row), toCodecSample(thermalCsvChunk[offset]));
      response += row;
    }
    index += take;
    pacedYield();
  }
  response.finish();
}

// Accepts only provenance-bearing v4 archives and leaves the file positioned
// at the first payload byte. Older files fail closed and remain quarantined.
bool readLogArchiveHeader(File& file, LogArchiveHeader& header) {
  header = LogArchiveHeader{};
  if (file.read(reinterpret_cast<uint8_t*>(&header), sizeof(header)) !=
      static_cast<int>(sizeof(header))) {
    return false;
  }
  int16_t archivedOffsetCenti = 0;
  if (header.magic != kLogArchiveMagic ||
      header.version != kLogArchiveVersion ||
      header.sampleCount > kThermalLogCapacity ||
      header.zoneCount > sr800::kMaxJourneyZones ||
      header.originLogId == 0 || header.sourceDeviceId[0] == '\0' ||
      header.sourceModelId[0] == '\0' ||
      header.sourceDisplayName[0] == '\0' ||
      header.sourceFirmwareVersion[0] == '\0' ||
      !archiveThermocoupleOffset(header, archivedOffsetCenti) ||
      header.provenanceCrc32 != sr800::logcodec::crc32Finish(
          sr800::logcodec::crc32Update(
              sr800::logcodec::kCrc32Init,
              reinterpret_cast<const uint8_t*>(&header) +
                  sr800::logcodec::kArchiveOffsetSourceDeviceId,
              sr800::logcodec::kArchiveOffsetProvenanceCrc32 -
                  sr800::logcodec::kArchiveOffsetSourceDeviceId))) {
    return false;
  }
  if (header.codec != sr800::logcodec::kCodecRaw &&
      header.codec != sr800::logcodec::kCodecDeltaVarint &&
      header.codec != sr800::logcodec::kCodecDeltaVarintPlan) {
    return false;
  }
  if (header.codec == sr800::logcodec::kCodecRaw &&
      header.encodedBytes !=
          header.sampleCount * static_cast<uint32_t>(sizeof(ThermalSample))) {
    return false;
  }
  return file.size() == sizeof(header) + header.encodedBytes;
}
// Rebuilding the recordings list re-reads every archive header and scans the whole volume for used
// bytes - 1.3-4.0 s of storage-worker time that delays Start's storage lock. The validated headers,
// quarantined ids, and volume figures are cached in PSRAM against the manifest mutation counter, which every archive write, delete, retention sweep,
// format, and restore-lease write bumps. Owned by the crackle-store task, the only caller.
constexpr size_t kLogListMaxListed = 160;
struct LogListEntry {
  LogArchiveHeader header;
  uint32_t fileBytes;
};
LogListEntry* logListEntries = nullptr;
uint32_t* logListQuarantined = nullptr;
size_t logListCount = 0;
size_t logListQuarantinedCount = 0;
uint32_t logListTotalBytes = 0;
uint32_t logListUsedBytes = 0;
bool logListCacheValid = false;
uint32_t logListCacheMutations = 0;

bool loadLogListEntries() {
  if (logListEntries == nullptr) {
    logListEntries = static_cast<LogListEntry*>(heap_caps_calloc(
        kLogListMaxListed, sizeof(LogListEntry), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    logListQuarantined = static_cast<uint32_t*>(heap_caps_calloc(
        kLogListMaxListed, sizeof(uint32_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (logListEntries == nullptr || logListQuarantined == nullptr) {
      heap_caps_free(logListEntries);
      heap_caps_free(logListQuarantined);
      logListEntries = nullptr;
      logListQuarantined = nullptr;
      return false;
    }
  }
  const uint32_t mutations = currentManifestMutationCount();
  if (logListCacheValid && logListCacheMutations == mutations) return true;
  // Collect ids first, then serve newest-first regardless of directory order.
  // `logseq` is the last issued id; comparing ring age preserves chronology
  // after 4294967294 wraps to 1.
  static uint32_t ids[kLogListMaxListed];
  size_t count = 0;
  File dir = LittleFS.open(kLogArchiveDir);
  if (dir && dir.isDirectory()) {
    for (File entry = dir.openNextFile(); entry;
         entry = dir.openNextFile()) {
      const uint32_t logId = logArchiveIdFromName(entry.name());
      if (logId != 0 && count < kLogListMaxListed) ids[count++] = logId;
      pacedYield();
    }
  }
  dir.close();
  const uint32_t newestId = storedLogArchiveSequence();
  if (newestId == 0) {
    // Preferences unavailable or no recording issued yet: retain the legacy,
    // deterministic ordering rather than guessing a wrap point.
    std::sort(ids, ids + count,
              [](uint32_t a, uint32_t b) { return a > b; });
  } else {
    std::sort(ids, ids + count, [newestId](uint32_t a, uint32_t b) {
      return logArchiveAge(a, newestId) < logArchiveAge(b, newestId);
    });
  }
  size_t listed = 0;
  size_t quarantined = 0;
  char path[32];
  for (size_t index = 0; index < count; ++index) {
    logArchivePath(path, sizeof(path), ids[index]);
    File file = LittleFS.open(path, "r");
    if (!file) continue;
    LogListEntry& slot = logListEntries[listed];
    slot.fileBytes = static_cast<uint32_t>(file.size());
    const bool valid = readLogArchiveHeader(file, slot.header);
    file.close();
    if (valid) listed++;
    else logListQuarantined[quarantined++] = ids[index];
    pacedYield();
  }
  logListCount = listed;
  logListQuarantinedCount = quarantined;
  logListTotalBytes = static_cast<uint32_t>(LittleFS.totalBytes());
  logListUsedBytes = static_cast<uint32_t>(LittleFS.usedBytes());
  // Kept only if nothing changed the archive while it was being read.
  logListCacheMutations = mutations;
  logListCacheValid = currentManifestMutationCount() == mutations;
  return true;
}

void handleLogsList() {
  if (!logArchiveMounted) {
    sendRequestResponse(503, "application/json",
                "{\"ok\":false,\"message\":\"Log storage is not mounted.\"}");
    return;
  }
  if (!loadLogListEntries()) {
    sendBoundedResponse(503, "application/json",
        "{\"ok\":false,\"message\":\"The recordings list cache could not be allocated. Retry shortly.\"}",
        "Retry-After", "1");
    return;
  }

  bool currentActive = false;
  bool currentUnsaved = false;
  uint32_t currentSamples = 0;
  uint32_t currentIntervalMs = 0;
  uint32_t currentLogId = 0;
  ThermalLogSource currentSource = ThermalLogSource::NONE;
  portENTER_CRITICAL(&thermalLogMux);
  currentActive = thermalLogActive;
  currentUnsaved = thermalLogUnsaved;
  currentSamples = thermalLogCount;
  currentIntervalMs = thermalLogIntervalMs;
  currentLogId = thermalLogReservedId;
  currentSource = thermalLogSource;
  portEXIT_CRITICAL(&thermalLogMux);

  char currentDeviceId[sr800::logcodec::kArchiveDeviceIdBytes];
  formatStableDeviceId(currentDeviceId, sizeof(currentDeviceId));
  HttpResponseWriter response;
  response.begin();
  String json = F("{\"ok\":true,\"total_bytes\":");
  json += logListTotalBytes;
  json += F(",\"used_bytes\":");
  json += logListUsedBytes;
  json += F(",\"current\":{\"active\":");
  json += currentActive ? F("true") : F("false");
  json += F(",\"unsaved\":");
  json += currentUnsaved ? F("true") : F("false");
  json += F(",\"samples\":");
  json += currentSamples;
  json += F(",\"interval_ms\":");
  json += currentIntervalMs;
  json += F(",\"source\":\"");
  json += thermalLogSourceName(currentSource);
  json += F("\",\"recorded_on\":{\"deviceId\":\"");
  json += currentDeviceId;
  json += F("\",\"modelId\":\"");
  json += kRoasterModelId;
  json += F("\",\"displayNameAtCapture\":\"");
  json += kRoasterDisplayName;
  json += F("\",\"simulated\":false,\"firmwareVersion\":\"");
  json += kFirmwareVersion;
  json += F("\",\"identitySource\":\"roaster\"},\"recording_origin\":{\"deviceId\":\"");
  json += currentDeviceId;
  json += F("\",\"logId\":\"");
  json += currentLogId;
  json += F("\"},\"storage_address\":null},\"logs\":[");
  response += json;
  bool first = true;
  for (size_t index = 0; index < logListCount; ++index) {
    if (!response.ok()) break;
    // A copy: the text fields are sanitized in place below.
    LogArchiveHeader header = logListEntries[index].header;
    const uint32_t fileBytes = logListEntries[index].fileBytes;
    String entry = first ? F("") : F(",");
    first = false;
    entry += F("{\"id\":");
    entry += header.logId;
    entry += F(",\"boot\":");
    entry += header.boot;
    entry += F(",\"start_epoch\":");
    entry += header.startEpoch;
    entry += F(",\"duration_ms\":");
    entry += header.durationMs;
    entry += F(",\"samples\":");
    entry += header.sampleCount;
    entry += F(",\"interval_ms\":");
    entry += header.intervalMs;
    entry += F(",\"source\":\"");
    entry += thermalLogSourceName(
        static_cast<ThermalLogSource>(header.source));
    // `bytes` is the file as it actually sits on the volume - compressed, for a
    // v4 recording. Nothing here infers a size from the sample count, and no
    // client should either: from version 3 on there is no fixed stride.
    entry += F("\",\"bytes\":");
    entry += static_cast<uint32_t>(fileBytes);
    entry += F(",\"payload_bytes\":");
    entry += header.encodedBytes;
    entry += F(",\"codec\":");
    entry += header.codec;
    entry += F(",\"version\":");
    entry += header.version;
    auto safeArchiveText = [](char* value, size_t capacity) {
      value[capacity - 1] = '\0';
      for (char* cursor = value; *cursor != '\0'; ++cursor) {
        const unsigned char byte = static_cast<unsigned char>(*cursor);
        if (byte < 0x20 || byte > 0x7E || *cursor == '"' || *cursor == '\\') {
          *cursor = '-';
        }
      }
    };
    safeArchiveText(header.sourceDeviceId, sizeof(header.sourceDeviceId));
    safeArchiveText(header.sourceModelId, sizeof(header.sourceModelId));
    safeArchiveText(header.sourceDisplayName, sizeof(header.sourceDisplayName));
    safeArchiveText(header.sourceFirmwareVersion,
                    sizeof(header.sourceFirmwareVersion));
    entry += F(",\"recorded_on\":{\"deviceId\":\"");
    entry += header.sourceDeviceId;
    entry += F("\",\"modelId\":\"");
    entry += header.sourceModelId;
    entry += F("\",\"displayNameAtCapture\":\"");
    entry += header.sourceDisplayName;
    entry += F("\",\"simulated\":");
    entry += (header.provenanceFlags &
              sr800::logcodec::kArchiveProvenanceSimulated) != 0
        ? F("true") : F("false");
    entry += F(",\"firmwareVersion\":\"");
    entry += header.sourceFirmwareVersion;
    int16_t archivedOffsetCenti = 0;
    archiveThermocoupleOffset(header, archivedOffsetCenti);
    entry += F("\",\"identitySource\":\"roaster\"},\"thermocouple_offset_c\":");
    entry += String(archivedOffsetCenti / 100.0f, 2);
    entry += F(",\"recording_origin\":{\"deviceId\":\"");
    entry += header.sourceDeviceId;
    entry += F("\",\"logId\":\"");
    entry += header.originLogId;
    entry += F("\"},\"storage_address\":{\"deviceId\":\"");
    entry += currentDeviceId;
    entry += F("\",\"logId\":\"");
    entry += header.logId;
    entry += F("\"}");
    if (header.version >= 2) {
      char safeName[kRoastNameBytes + 1] = {0};
      memcpy(safeName, header.name, sizeof(header.name));
      // A stored name was sanitized on the way in, but a file could have been
      // written by any image; re-sanitize before it lands inside a JSON string.
      for (char* c = safeName; *c != '\0'; ++c) {
        const unsigned char value = static_cast<unsigned char>(*c);
        if (!isalnum(value) && *c != '.' && *c != '_' && *c != ':' &&
            *c != '-' && *c != ' ') {
          *c = '-';
        }
      }
      entry += F(",\"name\":\"");
      entry += safeName;
      entry += F("\",\"batch_mass_g\":");
      entry += header.batchMassG;
      entry += F(",\"zone_count\":");
      entry += header.zoneCount;
      if (header.source == static_cast<uint8_t>(ThermalLogSource::ROAST)) {
        // `roastMode` was the v2 reserved byte on older recordings. Infer the
        // two historical modes when it is zero; new manual recordings carry an
        // explicit 3 and can never be mistaken for an empty timed program.
        RoastMode archivedMode = static_cast<RoastMode>(header.roastMode);
        if (archivedMode != RoastMode::TIMED &&
            archivedMode != RoastMode::JOURNEY &&
            archivedMode != RoastMode::MANUAL) {
          archivedMode = header.zoneCount > 0 ? RoastMode::JOURNEY
                                              : RoastMode::TIMED;
        }
        entry += F(",\"roast_mode\":\"");
        entry += roastModeName(archivedMode);
        entry += '"';
        const char* archivedEnd = header.version >= 3
            ? roastEndReasonFromCode(header.roastEndReason) : nullptr;
        if (archivedEnd != nullptr) {
          const uint16_t stopSec =
              static_cast<uint16_t>(header.roastStopSecBytes[0]) |
              (static_cast<uint16_t>(header.roastStopSecBytes[1]) << 8);
          entry += F(",\"roast_stop_sec\":");
          entry += stopSec;
          entry += F(",\"roast_end_reason\":\"");
          entry += archivedEnd;
          entry += '"';
        }
        entry += F(",\"passive_tail_complete\":");
        entry += (header.provenanceFlags &
                  sr800::logcodec::kArchivePassiveTailIncomplete) == 0
            ? F("true") : F("false");
      }
      if (header.zoneCount > 0) {
        entry += F(",\"zone_attained_sec\":[");
        for (uint8_t zone = 0; zone < header.zoneCount; ++zone) {
          if (zone != 0) entry += ',';
          if (header.zoneAttainedSec[zone] == kRoastZoneNotAttained) {
            entry += F("null");
          } else {
            entry += header.zoneAttainedSec[zone];
          }
        }
        entry += ']';
      }
    }
    entry += F(",\"download\":\"/logs/");
    entry += header.logId;
    entry += F(".csv\"}");
    response += entry;
    pacedYield();
  }
  response += F("],\"quarantined\":[");
  for (size_t index = 0; index < logListQuarantinedCount; ++index) {
    if (!response.ok()) break;
    if (index != 0) response += ',';
    String quarantined = F("{\"reason\":\"missing_recording_provenance\",\"storage_address\":{\"deviceId\":\"");
    quarantined += currentDeviceId;
    quarantined += F("\",\"logId\":\"");
    quarantined += logListQuarantined[index];
    quarantined += F("\"},\"download\":\"/logs/");
    quarantined += logListQuarantined[index];
    quarantined += F(".crk\"}");
    response += quarantined;
  }
  response += F("]}");
  response.finish();
}

// The stored file, byte for byte, with nothing interpreted — not the header,
// not even the checksum the CSV route refuses to serve without. This is the
// BACKUP path, and a backup's whole job is to hand back exactly what is on the
// volume. A recording that has gone bad in flash is still the user's, and a
// byte-exact copy of it is the only form in which it can be looked at, argued
// with, or repaired off-device; a route that answered 500 here would make a
// damaged recording unrecoverable in the name of not serving a damaged
// recording. `/logs/<id>.csv` is where a recording is checked before anyone
// reads numbers off it, and `POST /api/logs/restore` is the strict end of this
// same pipe — a file that fails validation there was already broken here.
void serveArchiveFileRaw(File& file, unsigned long logId) {
  char filename[72];
  snprintf(filename, sizeof(filename),
           "attachment; filename=crackle-log-%lu.crk", logId);
  httpd_resp_set_type(nativeStorageRequest, "application/octet-stream");
  httpd_resp_set_hdr(nativeStorageRequest, "Cache-Control", "no-store");
  httpd_resp_set_hdr(nativeStorageRequest, "Content-Disposition", filename);
  const size_t expectedBytes = file.size();
  size_t sentBytes = 0;
  while (sentBytes < expectedBytes) {
    const int got = file.read(reinterpret_cast<uint8_t*>(httpChunkBuffer),
                              sizeof(httpChunkBuffer));
    if (got <= 0) break;
    if (httpd_resp_send_chunk(nativeStorageRequest, httpChunkBuffer,
                              static_cast<size_t>(got)) != ESP_OK) {
      file.close();
      abortStorageStream();
      return;
    }
    sentBytes += static_cast<size_t>(got);
  }
  file.close();
  if (sentBytes != expectedBytes) {
    // A short read must never look like a complete backup.
    abortStorageStream();
    return;
  }
  httpd_resp_send_chunk(nativeStorageRequest, nullptr, 0);
}
// One route serves both representations of a recording. The suffix chooses:
// `.csv` is the decoded, checksum-verified, human-and-spreadsheet form, `.crk`
// is the stored file itself. A second `server.on` would have had to repeat the
// mount check, the id parse and the 404 to say the same thing.
void handleLogFetch() {
  if (!logArchiveMounted) {
    sendRequestResponse(503, "text/plain", "Log storage is not mounted.");
    return;
  }
  const String name = requestPathArg(0);
  char* end = nullptr;
  const unsigned long logId = strtoul(name.c_str(), &end, 10);
  const bool wantsRawFile = end != name.c_str() && strcmp(end, ".crk") == 0;
  if (end == name.c_str() || logId == 0 ||
      (!wantsRawFile && strcmp(end, ".csv") != 0)) {
    sendRequestResponse(404, "text/plain", "Not found");
    return;
  }
  char path[32];
  logArchivePath(path, sizeof(path), static_cast<uint32_t>(logId));
  File file = LittleFS.open(path, "r");
  if (!file) {
    sendRequestResponse(404, "text/plain", "Not found");
    return;
  }
  if (wantsRawFile) {
    serveArchiveFileRaw(file, logId);
    return;
  }
  LogArchiveHeader header;
  if (!readLogArchiveHeader(file, header)) {
    file.close();
    sendRequestResponse(500, "text/plain", "Archived log is unreadable.");
    return;
  }
  const size_t payloadStart = file.position();

  // Verify the whole payload before a single row leaves the device. A flipped
  // bit in a compressed stream is not a slightly-wrong reading the way it is in
  // a raw one - the deltas after it are all wrong too - so a damaged recording
  // has to read as damaged, never as a roast that behaved strangely. The extra
  // read costs ~9 KB; serving a fabricated curve costs the user's trust in
  // every other recording on the device.
  uint8_t buffer[256];
  if (header.version >= 3) {
    uint32_t crc = archiveIntegrityCrcBegin(header);
    uint32_t remaining = header.encodedBytes;
    while (remaining > 0) {
      const size_t want =
          remaining > sizeof(buffer) ? sizeof(buffer) : remaining;
      const int got = file.read(buffer, want);
      if (got <= 0) break;
      crc = sr800::logcodec::crc32Update(crc, buffer, static_cast<size_t>(got));
      remaining -= static_cast<uint32_t>(got);
      pacedYield();
    }
    if (remaining != 0 ||
        sr800::logcodec::crc32Finish(crc) != header.crc32) {
      file.close();
      sendRequestResponse(500, "text/plain",
                  "Archived log failed its checksum and was not served.");
      return;
    }
    // Rewinding is not optional: without it the decode below would read past
    // the payload and serve nothing at all, so a failed seek is an error and
    // not a silently empty CSV.
    if (!file.seek(payloadStart)) {
      file.close();
      sendRequestResponse(500, "text/plain", "Archived log could not be rewound.");
      return;
    }
  }

  uint32_t samplePayloadBytes = header.encodedBytes;
  if (header.codec == sr800::logcodec::kCodecDeltaVarintPlan) {
    uint8_t prefix[7] = {};
    if (file.read(prefix, sizeof(prefix)) != static_cast<int>(sizeof(prefix))) {
      file.close();
      sendRequestResponse(500, "text/plain", "Archived roast plan is truncated.");
      return;
    }
    const size_t declared = static_cast<size_t>(prefix[5]) |
        (static_cast<size_t>(prefix[6]) << 8);
    if (declared < sizeof(prefix) ||
        declared > sr800::logcodec::kMaxPlanEnvelopeBytes ||
        declared > header.encodedBytes ||
        !file.seek(payloadStart)) {
      file.close();
      sendRequestResponse(500, "text/plain", "Archived roast plan is invalid.");
      return;
    }
    uint8_t planPayload[sr800::logcodec::kMaxPlanEnvelopeBytes];
    if (file.read(planPayload, declared) != static_cast<int>(declared)) {
      file.close();
      sendRequestResponse(500, "text/plain", "Archived roast plan is truncated.");
      return;
    }
    size_t consumedPlanBytes = 0;
    if (!sr800::logcodec::validatePlanEnvelope(
            planPayload, declared, consumedPlanBytes) ||
        consumedPlanBytes != declared) {
      file.close();
      sendRequestResponse(500, "text/plain", "Archived roast plan is invalid.");
      return;
    }
    samplePayloadBytes -= static_cast<uint32_t>(declared);
  }

  char filename[64];
  snprintf(filename, sizeof(filename),
           "attachment; filename=crackle-log-%lu.csv", logId);
  HttpResponseWriter response;
  response.begin("text/csv", filename);
  response += F("t_ms,thermocouple_c,cold_junction_c,effective_fan,effective_heat\n");
  char row[96];
  if (header.codec == sr800::logcodec::kCodecRaw) {
    // The reserved v4 raw codec uses fixed-stride records in centi-degrees,
    // printed exactly as they were stored.
    for (uint32_t index = 0;
         index < header.sampleCount && response.ok(); ++index) {
      if (file.read(buffer, sr800::logcodec::kRawSampleBytes) !=
          static_cast<int>(sr800::logcodec::kRawSampleBytes)) {
        break;
      }
      sr800::logcodec::RawSample sample;
      if (!sr800::logcodec::decodeRawSample(
              buffer, sr800::logcodec::kRawSampleBytes, sample)) {
        break;
      }
      formatThermalCsvRow(row, sizeof(row), sample);
      response += row;
      if ((index & 0x3F) == 0) pacedYield();
    }
  } else {
    // Version 4 delta payload: decoded one sample at a time out of a 256-byte
    // window, so a recording of any length is served without holding it in RAM.
    sr800::logcodec::Decoder decoder;
    sr800::logcodec::decodeBegin(decoder);
    size_t filled = 0;
    size_t offset = 0;
    uint32_t payloadRead = 0;
    uint32_t emitted = 0;
    while (emitted < header.sampleCount && response.ok()) {
      sr800::logcodec::Sample sample;
      size_t consumed = 0;
      const sr800::logcodec::DecodeStatus status =
          sr800::logcodec::decodeSample(decoder, buffer + offset,
                                        filled - offset, consumed, sample);
      if (status == sr800::logcodec::DecodeStatus::OK) {
        offset += consumed;
        formatThermalCsvRow(row, sizeof(row), sample);
        response += row;
        emitted++;
        if ((emitted & 0x3F) == 0) pacedYield();
        continue;
      }
      if (status != sr800::logcodec::DecodeStatus::NEED_MORE) break;
      if (offset > 0) {
        memmove(buffer, buffer + offset, filled - offset);
        filled -= offset;
        offset = 0;
      }
      uint32_t want = static_cast<uint32_t>(sizeof(buffer) - filled);
      if (want > samplePayloadBytes - payloadRead) {
        want = samplePayloadBytes - payloadRead;
      }
      if (want == 0) break;
      const int got = file.read(buffer + filled, want);
      if (got <= 0) break;
      filled += static_cast<size_t>(got);
      payloadRead += static_cast<uint32_t>(got);
    }
  }
  file.close();
  response.finish();
}

void handleLogDelete() {
  if (rejectMutationDuringRestore()) return;
  if (!requestHasArg("confirm") || requestArg("confirm") != "DELETE_LOG") {
    sendRequestResponse(409, "application/json",
                "{\"ok\":false,\"message\":\"Delete confirmation is required.\"}");
    return;
  }
  if (!logArchiveMounted) {
    sendRequestResponse(503, "application/json",
                "{\"ok\":false,\"message\":\"Log storage is not mounted.\"}");
    return;
  }
  uint32_t logId = 0;
  if (!parseRequiredUint32Arg("id", logId) || logId > kMaxLogArchiveId) {
    sendRequestResponse(400, "application/json",
                "{\"ok\":false,\"message\":\"id must be a decimal recording id from 1 through 4294967294.\"}");
    return;
  }
  // Deletion is a flash operation; refuse while actuation could be stalled.
  if (!actuatorFullyIdle()) {
    sendRequestResponse(409, "application/json",
                "{\"ok\":false,\"message\":\"Log deletion waits until actuation finishes.\"}");
    return;
  }
  char path[32];
  logArchivePath(path, sizeof(path), logId);
  const bool exists = LittleFS.exists(path);
  const sr800::docstore::RemoveVerdict removed = sr800::docstore::evaluateRemove(
      exists, exists && deleteArchivedLog(logId));
  if (removed == sr800::docstore::RemoveVerdict::NOT_FOUND) {
    sendRequestResponse(404, "application/json",
                "{\"ok\":false,\"message\":\"No archived log has that id.\"}");
    return;
  }
  if (removed == sr800::docstore::RemoveVerdict::FAILED) {
    sendRequestResponse(500, "application/json",
                "{\"ok\":false,\"message\":\"The archived log could not be removed.\"}");
    return;
  }

  String response = F("{\"ok\":true,\"deleted\":");
  response += logId;
  response += F(",\"count\":");
  response += logArchiveCount;
  response += F(",\"state_rev\":\"");
  appendUint64Decimal(response, currentStateRevision());
  response += F("\"}");
  sendRequestResponse(200, "application/json", response);
}

// ---------------------------------------------------------------------------
// POST /api/logs/restore — the other half of backup/restore.
//
// `GET /logs/<id>.crk` lets a browser take the archive off the device; this is
// how it comes back. The native storage worker streams the raw request body
// directly to the ordinary temp path; the completed file is then validated
// through a 256-byte read window before the atomic rename. The request never
// exists as a file-sized String.
//
// RESTORE WINS. An id that already holds a recording is overwritten, with no
// conflict token and no version dance. The document store is optimistic because
// two browsers edit the same document; a restore is not an edit, it is the
// operator replaying an archive they already hold, and a restore that stopped to
// ask about each collision would not be a restore. `confirm=RESTORE_LOG` is
// what makes that deliberate — nothing here is reachable by accident.
//
// AND IT NEVER PRUNES. The persist path sweeps oldest-first to make room
// because a finished roast has nowhere else to go. A restore that swept would
// be deleting recordings out of the very backup it is restoring, in an order
// the operator never chose. So the archive's working reserve is a REFUSAL here
// (507) and not a sweep, and the client decides what to give up.
enum class LogRestoreUploadPhase : uint8_t {
  EMPTY, RECEIVING, READY, ERROR, FAILED
};

struct LogRestoreUploadState {
  LogRestoreUploadPhase phase = LogRestoreUploadPhase::EMPTY;
  File file;
  uint16_t httpStatus = 400;
  const char* check = nullptr;
  String message;
  uint32_t logId = 0;
  uint32_t bytes = 0;
  uint32_t volumeUsed = 0;
  uint32_t volumeTotal = 0;
  bool replacing = false;
  bool autoAllocate = false;
};

LogRestoreUploadState logRestoreUpload;

void clearLogRestoreUpload(bool removeTemp) {
  if (logRestoreUpload.file) logRestoreUpload.file.close();
  if (removeTemp && logArchiveMounted) LittleFS.remove(kLogArchiveTempPath);
  logRestoreUpload.phase = LogRestoreUploadPhase::EMPTY;
  logRestoreUpload.httpStatus = 400;
  logRestoreUpload.check = nullptr;
  logRestoreUpload.message = String();
  logRestoreUpload.logId = 0;
  logRestoreUpload.bytes = 0;
  logRestoreUpload.volumeUsed = 0;
  logRestoreUpload.volumeTotal = 0;
  logRestoreUpload.replacing = false;
  logRestoreUpload.autoAllocate = false;
}

void failLogRestoreUpload(uint16_t status, const char* check,
                          const String& message) {
  if (logRestoreUpload.file) logRestoreUpload.file.close();
  if (logArchiveMounted) LittleFS.remove(kLogArchiveTempPath);
  logRestoreUpload.phase = LogRestoreUploadPhase::ERROR;
  logRestoreUpload.httpStatus = status;
  logRestoreUpload.check = check;
  logRestoreUpload.message = message;
}

bool parseLogRestoreId(const String& raw, uint32_t& out) {
  if (raw.length() == 0 || raw[0] == '0') return false;
  uint32_t value = 0;
  for (size_t index = 0; index < raw.length(); ++index) {
    const char c = raw[index];
    if (c < '0' || c > '9') return false;
    const uint32_t digit = static_cast<uint8_t>(c - '0');
    if (value > (UINT32_MAX - digit) / 10U) return false;
    value = value * 10U + digit;
  }
  // UINT32_MAX is reserved so the next locally recorded roast can never wrap
  // to hidden id zero. UINT32_MAX - 1 remains restorable; allocation wraps and
  // searches for a free positive id after it.
  if (value > kMaxLogArchiveId) return false;
  out = value;
  return true;
}

// Assign a restored archive a location on THIS roaster without rewriting who
// made the recording. Version 4 deliberately separates `logId` (the local
// storage address) from `originLogId` plus source identity (immutable
// provenance). Only the local id and the whole-file checksum may change here.
bool remapRestoredArchiveAddress(uint32_t destinationLogId) {
  File source = LittleFS.open(kLogArchiveTempPath, "r");
  if (!source) return false;

  LogArchiveHeader header = {};
  if (source.read(reinterpret_cast<uint8_t*>(&header), sizeof(header)) !=
      sizeof(header)) {
    source.close();
    return false;
  }
  header.logId = destinationLogId;

  uint32_t crc = archiveIntegrityCrcBegin(header);
  uint8_t buffer[256];
  uint32_t remaining =
      logRestoreUpload.bytes - static_cast<uint32_t>(sizeof(header));
  while (remaining > 0) {
    size_t want = remaining;
    if (want > sizeof(buffer)) want = sizeof(buffer);
    const int got = source.read(buffer, want);
    if (got != static_cast<int>(want)) {
      source.close();
      return false;
    }
    crc = sr800::logcodec::crc32Update(crc, buffer, want);
    remaining -= static_cast<uint32_t>(want);
    pacedYield();
  }
  source.close();
  header.crc32 = sr800::logcodec::crc32Finish(crc);

  File destination = LittleFS.open(kLogArchiveTempPath, "r+");
  if (!destination) return false;
  const bool written =
      destination.seek(0) &&
      destination.write(reinterpret_cast<const uint8_t*>(&header),
                        sizeof(header)) == sizeof(header);
  destination.flush();
  destination.close();
  return written;
}

size_t readLogRestoreFile(void* context, size_t offset, uint8_t* out,
                          size_t length) {
  File& file = *static_cast<File*>(context);
  if (!file.seek(offset)) return 0;
  const int got = file.read(out, length);
  if (got > 0) pacedYield();
  return got > 0 ? static_cast<size_t>(got) : 0;
}

void handleLogRestore() {
  // The upload callback already sent the maintenance-lease refusal.
  if (logRestoreUpload.phase == LogRestoreUploadPhase::FAILED) {
    clearLogRestoreUpload(true);
    return;
  }
  if (logRestoreUpload.phase == LogRestoreUploadPhase::ERROR) {
    String response = F("{\"ok\":false");
    if (logRestoreUpload.check != nullptr) {
      response += F(",\"check\":\"");
      response += logRestoreUpload.check;
      response += '"';
    }
    response += F(",\"message\":\"");
    response += logRestoreUpload.message;
    response += F("\"}");
    const uint16_t status = logRestoreUpload.httpStatus;
    clearLogRestoreUpload(true);
    sendRequestResponse(status, "application/json", response);
    return;
  }
  if (logRestoreUpload.phase != LogRestoreUploadPhase::READY) {
    clearLogRestoreUpload(true);
    sendRequestResponse(400, "application/json",
                "{\"ok\":false,\"check\":\"upload\",\"message\":\"Upload exactly one recording file.\"}");
    return;
  }

  File file = LittleFS.open(kLogArchiveTempPath, "r");
  if (!file) {
    clearLogRestoreUpload(true);
    sendRequestResponse(500, "application/json",
                "{\"ok\":false,\"message\":\"The uploaded recording could not be reopened. Nothing stored was changed.\"}");
    return;
  }
  sr800::logcodec::ArchiveSummary summary;
  const sr800::logcodec::ArchiveVerdict verdict =
      sr800::logcodec::validateArchiveReader(
          &readLogRestoreFile, &file, logRestoreUpload.bytes,
          kThermalLogCapacity, summary);
  file.close();
  if (verdict != sr800::logcodec::ArchiveVerdict::OK) {
    String message = F("{\"ok\":false,\"check\":\"");
    message += sr800::logcodec::archiveVerdictName(verdict);
    message += F("\",\"message\":\"Rejected: ");
    message += sr800::logcodec::archiveVerdictReason(verdict);
    message += F(".\"}");
    clearLogRestoreUpload(true);
    sendRequestResponse(400, "application/json", message);
    return;
  }
  if (logRestoreUpload.autoAllocate) {
    const uint32_t originLogId = summary.originLogId;
    const uint32_t destinationLogId = nextLogArchiveId();
    if (destinationLogId == 0) {
      clearLogRestoreUpload(true);
      sendRequestResponse(
          507, "application/json",
          "{\"ok\":false,\"check\":\"id\",\"message\":\"No recording id is available on this roaster.\"}");
      return;
    }
    logRestoreUpload.logId = destinationLogId;
    if (!remapRestoredArchiveAddress(destinationLogId)) {
      clearLogRestoreUpload(true);
      sendRequestResponse(
          500, "application/json",
          "{\"ok\":false,\"message\":\"The recording could not be assigned a local storage address. Nothing stored was changed.\"}");
      return;
    }

    // Re-run the same complete validator after the header rewrite. This proves
    // both the rewritten file CRC and the invariant that origin provenance was
    // not changed while assigning the local storage address.
    File remapped = LittleFS.open(kLogArchiveTempPath, "r");
    sr800::logcodec::ArchiveSummary remappedSummary;
    const sr800::logcodec::ArchiveVerdict remappedVerdict =
        remapped
            ? sr800::logcodec::validateArchiveReader(
                  &readLogRestoreFile, &remapped, logRestoreUpload.bytes,
                  kThermalLogCapacity, remappedSummary)
            : sr800::logcodec::ArchiveVerdict::TRUNCATED_HEADER;
    if (remapped) remapped.close();
    if (remappedVerdict != sr800::logcodec::ArchiveVerdict::OK ||
        remappedSummary.logId != destinationLogId ||
        remappedSummary.originLogId != originLogId) {
      clearLogRestoreUpload(true);
      sendRequestResponse(
          500, "application/json",
          "{\"ok\":false,\"message\":\"The recording failed verification after assigning its local storage address. Nothing stored was changed.\"}");
      return;
    }
    summary = remappedSummary;
  } else if (summary.logId != logRestoreUpload.logId) {
    // `/api/logs` lists a recording under the id in its HEADER and builds its
    // download links from it, so a file stored under a name its header
    // disagrees with would list an entry whose own download 404s.
    String message =
        F("{\"ok\":false,\"check\":\"log_id\",\"message\":\"The recording's header carries id ");
    message += summary.logId;
    message += F(", not the id it is being restored under.\"}");
    clearLogRestoreUpload(true);
    sendRequestResponse(400, "application/json", message);
    return;
  }

  char path[32];
  logArchivePath(path, sizeof(path), logRestoreUpload.logId);
  if (!LittleFS.rename(kLogArchiveTempPath, path)) {
    clearLogRestoreUpload(true);
    sendRequestResponse(500, "application/json",
                "{\"ok\":false,\"message\":\"The recording could not be written. Nothing stored was changed.\"}");
    return;
  }
  if (!logRestoreUpload.replacing) logArchiveCount++;
  // A full restore lease advances once at commit. A standalone recording
  // restore has no later boundary, so its manifest-visible change advances now.
  // A matching lease can expire while a flash write is in progress. Once the
  // request passed the mutation gate, an incomplete lease still owns the
  // mutation even if its active timeout elapsed before this success boundary.
  refreshRestoreLease();
  if (restoreLease.incomplete) markRestoreDirty();
  else advanceStateRevision();

  // A future recording must never collide with a restored one. `logseq` holds
  // the last id ISSUED and `nextLogArchiveId` takes logseq + 1, so lifting it
  // to the restored id is exactly enough and never more. It only ever rises:
  // restoring an old recording onto a device that has since gone further must
  // not rewind the counter and hand out ids that already exist.
  uint32_t logSequence = 0;
  Preferences diagnostics;
  if (diagnostics.begin(kDiagnosticsNamespace, false)) {
    logSequence = diagnostics.getUInt("logseq", 0);
    if (logRestoreUpload.logId > logSequence) {
      diagnostics.putUInt("logseq", logRestoreUpload.logId);
      logSequence = logRestoreUpload.logId;
    }
    diagnostics.end();
  }

  String response = F("{\"ok\":true,\"id\":");
  response += logRestoreUpload.logId;
  response += F(",\"bytes\":");
  response += logRestoreUpload.bytes;
  response += F(",\"version\":");
  response += summary.version;
  response += F(",\"samples\":");
  response += summary.sampleCount;
  response += F(",\"replaced\":");
  response += logRestoreUpload.replacing ? F("true") : F("false");
  response += F(",\"count\":");
  response += logArchiveCount;
  response += F(",\"logseq\":");
  response += logSequence;
  response += F(",\"recorded_on\":{\"deviceId\":\"");
  response += summary.sourceDeviceId;
  response += F("\",\"modelId\":\"");
  response += summary.sourceModelId;
  response += F("\",\"displayNameAtCapture\":\"");
  response += summary.sourceDisplayName;
  response += F("\",\"simulated\":");
  response += summary.simulated ? F("true") : F("false");
  response += F(",\"firmwareVersion\":\"");
  response += summary.sourceFirmwareVersion;
  response += F("\",\"identitySource\":\"roaster\"},\"thermocouple_offset_c\":");
  response += String(summary.thermocoupleOffsetCenti / 100.0f, 2);
  response += F(",\"recording_origin\":{\"deviceId\":\"");
  response += summary.sourceDeviceId;
  response += F("\",\"logId\":\"");
  response += summary.originLogId;
  response += F("\"},\"storage_address\":{\"deviceId\":\"");
  char currentDeviceId[32] = {};
  formatStableDeviceId(currentDeviceId, sizeof(currentDeviceId));
  response += currentDeviceId;
  response += F("\",\"logId\":\"");
  response += logRestoreUpload.logId;
  response += F("\"}");
  response += F("}");
  clearLogRestoreUpload(false);
  sendRequestResponse(200, "application/json", response);
}

// A no-progress budget alone would let a client that trickles a byte every few
// seconds hold the single storage worker - and Start's storage lock - for hours. A whole document
// (at most 12 KB) normally arrives in well under a second; a recording restore in seconds.
constexpr uint32_t kDocumentBodyDeadlineMs = 15000;
constexpr uint32_t kRecordingUploadDeadlineMs = 120000;

bool receiveNativeStorageBody(size_t maximumBytes) {
  nativeStorageBody = String();
  if (nativeStorageRequest == nullptr) return false;
  const size_t length = nativeStorageRequest->content_len;
  if (length > maximumBytes) {
    sendRequestResponse(413, "application/json",
        "{\"ok\":false,\"message\":\"The request body exceeds this document's fixed limit.\"}");
    return false;
  }
  if (!nativeStorageBody.reserve(length + 1)) {
    sendRequestResponse(503, "application/json",
        "{\"ok\":false,\"message\":\"There is not enough working memory for this document.\"}");
    return false;
  }
  char chunk[1024];
  size_t received = 0;
  const uint32_t startedMs = millis();
  uint32_t lastProgressMs = startedMs;
  while (received < length) {
    if (millis() - startedMs > kDocumentBodyDeadlineMs) {
      sendRequestResponse(408, "application/json",
          "{\"ok\":false,\"message\":\"The request body took too long to arrive.\"}");
      return false;
    }
    const size_t wanted = std::min(sizeof(chunk), length - received);
    const int result = httpd_req_recv(nativeStorageRequest, chunk, wanted);
    if (result == HTTPD_SOCK_ERR_TIMEOUT) {
      if (millis() - lastProgressMs < kHttpIdleNoProgressBudgetMs) continue;
      sendRequestResponse(408, "application/json",
          "{\"ok\":false,\"message\":\"The request body stopped making progress.\"}");
      return false;
    }
    if (result <= 0) {
      sendRequestResponse(400, "application/json",
          "{\"ok\":false,\"message\":\"The request body was interrupted.\"}");
      return false;
    }
    nativeStorageBody.concat(chunk, static_cast<unsigned>(result));
    received += static_cast<size_t>(result);
    lastProgressMs = millis();
  }
  return true;
}

void handleNativeLogRestore() {
  if (!nativeRequestHasRawContentType(nativeStorageRequest)) {
    sendRequestResponse(415, "application/json",
        "{\"ok\":false,\"check\":\"upload\",\"message\":\"Content-Type must be application/octet-stream.\"}");
    return;
  }
  if (rejectMutationDuringRestore(true)) return;
  if (!requestHasArg("confirm") || requestArg("confirm") != "RESTORE_LOG") {
    sendRequestResponse(409, "application/json",
        "{\"ok\":false,\"message\":\"Restore confirmation is required.\"}");
    return;
  }
  if (!logArchiveMounted) {
    sendRequestResponse(503, "application/json",
        "{\"ok\":false,\"message\":\"Log storage is not mounted.\"}");
    return;
  }
  if (!actuatorFullyIdle()) {
    sendRequestResponse(409, "application/json",
        "{\"ok\":false,\"message\":\"Recording restore waits until actuation finishes.\"}");
    return;
  }
  const String requestedId = requestArg("id");
  const bool autoAllocate = requestedId == "auto";
  uint32_t parsedId = 0;
  if (!autoAllocate && !parseLogRestoreId(requestedId, parsedId)) {
    sendRequestResponse(400, "application/json",
        "{\"ok\":false,\"check\":\"id\",\"message\":\"id must be auto or a positive decimal recording id below 4294967295.\"}");
    return;
  }
  if (!autoAllocate) {
    // The id reserved by the recording being captured (or still waiting to be
    // saved) belongs to that recording: a restore there would be overwritten
    // by, or would overwrite, the live episode's final archive.
    const ThermalLogStateSnapshot recording = copyThermalLogState();
    if (recording.reservedId != 0 && parsedId == recording.reservedId &&
        (recording.active || recording.unsaved ||
         recording.persistenceClaimed)) {
      sendRequestResponse(409, "application/json",
          "{\"ok\":false,\"check\":\"id\",\"message\":\"That recording id belongs to the recording currently being captured or saved. Restore with id=auto or another id.\"}");
      return;
    }
  }
  if (nativeStorageRequest->content_len == 0 ||
      nativeStorageRequest->content_len > sr800::volume::kMaxIncomingLogBytes) {
    sendRequestResponse(413, "application/json",
        "{\"ok\":false,\"check\":\"size\",\"message\":\"The recording is empty or exceeds the fixed restore limit.\"}");
    return;
  }

  clearLogRestoreUpload(true);
  logRestoreUpload.logId = parsedId;
  logRestoreUpload.autoAllocate = autoAllocate;
  if (!autoAllocate) {
    char path[32];
    logArchivePath(path, sizeof(path), parsedId);
    logRestoreUpload.replacing = LittleFS.exists(path);
  }
  logRestoreUpload.volumeUsed = static_cast<uint32_t>(LittleFS.usedBytes());
  logRestoreUpload.volumeTotal = static_cast<uint32_t>(LittleFS.totalBytes());
  const uint64_t projected = static_cast<uint64_t>(logRestoreUpload.volumeUsed) +
      nativeStorageRequest->content_len + kLogArchiveReserveBytes;
  if (projected > logRestoreUpload.volumeTotal) {
    sendRequestResponse(507, "application/json",
        "{\"ok\":false,\"message\":\"Restoring this recording would consume the archive reserve.\"}");
    return;
  }

  LittleFS.remove(kLogArchiveTempPath);
  logRestoreUpload.file = LittleFS.open(kLogArchiveTempPath, "w");
  if (!logRestoreUpload.file) {
    sendRequestResponse(500, "application/json",
        "{\"ok\":false,\"message\":\"The recording temporary file could not be opened.\"}");
    return;
  }
  logRestoreUpload.phase = LogRestoreUploadPhase::RECEIVING;
  uint8_t chunk[2048];
  const uint32_t uploadStartedMs = millis();
  uint32_t lastProgressMs = uploadStartedMs;
  while (logRestoreUpload.bytes < nativeStorageRequest->content_len) {
    if (millis() - uploadStartedMs > kRecordingUploadDeadlineMs) {
      clearLogRestoreUpload(true);
      sendRequestResponse(408, "application/json",
          "{\"ok\":false,\"message\":\"The recording upload took too long to arrive.\"}");
      return;
    }
    const size_t wanted = std::min(
        sizeof(chunk), static_cast<size_t>(nativeStorageRequest->content_len -
                                          logRestoreUpload.bytes));
    const int result = httpd_req_recv(nativeStorageRequest,
        reinterpret_cast<char*>(chunk), wanted);
    if (result == HTTPD_SOCK_ERR_TIMEOUT) {
      if (millis() - lastProgressMs < kHttpIdleNoProgressBudgetMs) continue;
      clearLogRestoreUpload(true);
      sendRequestResponse(408, "application/json",
          "{\"ok\":false,\"message\":\"The recording upload stopped making progress.\"}");
      return;
    }
    if (result <= 0 || logRestoreUpload.file.write(
            chunk, static_cast<size_t>(result)) != static_cast<size_t>(result)) {
      clearLogRestoreUpload(true);
      sendRequestResponse(400, "application/json",
          "{\"ok\":false,\"message\":\"The recording upload was interrupted.\"}");
      return;
    }
    logRestoreUpload.bytes += static_cast<uint32_t>(result);
    lastProgressMs = millis();
  }
  logRestoreUpload.file.flush();
  logRestoreUpload.file.close();
  logRestoreUpload.phase = LogRestoreUploadPhase::READY;
  handleLogRestore();
}

esp_err_t handleNativeStorageRequest(httpd_req_t* request) {
  if (request == nullptr || request->uri == nullptr) return ESP_FAIL;
  nativeStorageRequest = request;
  nativeStorageBody = String();
  StorageRequestGuard requestGuard;
  if (!requestGuard) {
    httpd_resp_set_hdr(nativeStorageRequest, "Retry-After", "1");
    sendRequestResponse(503, "application/json",
        "{\"ok\":false,\"message\":\"Controller storage is already in use. Retry shortly.\"}");
    nativeStorageRequest = nullptr;
    return ESP_OK;
  }
  char requestPath[128] = {};
  const size_t pathLength = strcspn(request->uri, "?");
  if (pathLength == 0 || pathLength >= sizeof(requestPath)) {
    sendRequestResponse(414, "application/json",
        "{\"ok\":false,\"message\":\"The storage request path is too long.\"}");
    nativeStorageRequest = nullptr;
    return ESP_OK;
  }
  memcpy(requestPath, request->uri, pathLength);
  requestPath[pathLength] = 0;
  const char* uri = requestPath;
  bool handled = true;
  if (request->method == HTTP_GET) {
    if (strcmp(uri, "/api/data/manifest") == 0) handleDataManifest();
    else if (strcmp(uri, "/api/data/runs") == 0) handleDataRunsIndex();
    else if (strncmp(uri, "/api/data/runs/", 15) == 0) handleDataRunGet();
    else if (strncmp(uri, "/api/data/", 10) == 0) handleDataCollectionGet();
    else if (strcmp(uri, "/api/logs") == 0) handleLogsList();
    else if (strncmp(uri, "/logs/", 6) == 0) handleLogFetch();
    else if (strcmp(uri, "/api/events") == 0) handleEvents();
    else if (strcmp(uri, "/capture.csv") == 0) handleCaptureCsv();
    else if (strcmp(uri, "/timing.csv") == 0) handleTimingCsv();
    else if (strcmp(uri, "/thermal.csv") == 0) handleThermalCsv();
    else handled = false;
  } else if (request->method == HTTP_POST) {
    if (strcmp(uri, "/api/data/delete") == 0) handleDataDelete();
    else if (strncmp(uri, "/api/data/runs/", 15) == 0) {
      if (receiveNativeStorageBody(sr800::docstore::kRunMaxPayloadBytes)) {
        handleDataRunPost();
      }
    } else if (strncmp(uri, "/api/data/", 10) == 0) {
      if (receiveNativeStorageBody(sr800::docstore::kCollectionMaxPayloadBytes)) {
        handleDataCollectionPost();
      }
    } else if (strcmp(uri, "/api/logs/delete") == 0) handleLogDelete();
    else if (strcmp(uri, "/api/logs/format") == 0) handleLogsFormat();
    else if (strcmp(uri, "/api/logs/restore") == 0) handleNativeLogRestore();
    else handled = false;
  } else {
    handled = false;
  }
  if (!handled) {
    sendRequestResponse(404, "application/json",
        "{\"ok\":false,\"message\":\"No storage route matches this request.\"}");
  }
  nativeStorageBody = String();
  nativeStorageRequest = nullptr;
  return ESP_OK;
}
bool parseFiniteFloatArg(const char* name, float& out) {
  if (!requestHasArg(name)) return false;
  const String raw = requestArg(name);
  char* end = nullptr;
  const float value = strtof(raw.c_str(), &end);
  if (end == raw.c_str() || *end != '\0') return false;
  if (!isfinite(value) || value < 0.0f || value > 1000.0f) return false;
  out = value;
  return true;
}

void handleCalibrationApply() {
  if (rejectMutationDuringRestore(true)) return;
  if (!requestHasArg("confirm") ||
      requestArg("confirm") != "APPLY_CALIBRATION") {
    sendRequestResponse(409, "application/json",
                "{\"ok\":false,\"message\":\"Calibration-apply confirmation is required.\"}");
    return;
  }
  // Hold storage ownership across the NVS write; checking without ownership
  // would leave a race with the dedicated storage task on the other core.
  StorageMutationGuard nvsMutation;
  if (!nvsMutationAllowed() || !nvsMutation) {
    sendRequestResponse(409, "application/json",
                "{\"ok\":false,\"message\":\"Calibration apply requires a fully idle roaster with no firmware update active.\"}");
    return;
  }
  if (requestHasArg("clear") && requestArg("clear") == "true") {
    const AppliedCalibration cleared;
    if (!saveAppliedCalibration(cleared)) {
      sendRequestResponse(500, "application/json",
                  "{\"ok\":false,\"message\":\"Calibration storage failed.\"}");
      return;
    }
    refreshRestoreLease();
    if (restoreLease.incomplete) markRestoreDirty();
    else advanceStateRevision();
    String response = F("{\"ok\":true,\"applied\":false,\"state_rev\":\"");
    appendUint64Decimal(response, currentStateRevision());
    response += F("\"}");
    sendRequestResponse(200, "application/json", response);
    return;
  }
  AppliedCalibration next;
  if (!parseFiniteFloatArg("heater_gain", next.heaterGain) ||
      !parseFiniteFloatArg("fan_cooling", next.fanCooling) ||
      !parseFiniteFloatArg("cooling_fan", next.coolingFan) ||
      !parseFiniteFloatArg("loss_per_min", next.lossPerMin)) {
    sendRequestResponse(400, "application/json",
                "{\"ok\":false,\"message\":\"heater_gain, fan_cooling, cooling_fan, and loss_per_min must be finite non-negative decimals.\"}");
    return;
  }
  strlcpy(next.fitId, requestArg("fit_id").c_str(), sizeof(next.fitId));
  // The fit id is echoed inside JSON string literals; keep it to safe chars.
  for (char* c = next.fitId; *c != '\0'; ++c) {
    if (!isalnum(static_cast<unsigned char>(*c)) && *c != '.' && *c != '_' &&
        *c != ':' && *c != '-') {
      *c = '-';
    }
  }
  const time_t nowEpoch = time(nullptr);
  next.appliedEpoch =
      nowEpoch > 1600000000 ? static_cast<uint32_t>(nowEpoch) : 0;
  next.present = true;
  if (!plausibleCalibration(next)) {
    sendRequestResponse(400, "application/json",
                "{\"ok\":false,\"message\":\"Those coefficients are outside physically plausible ranges (heater_gain 0.1-500, fan_cooling 0.5-200, cooling_fan 1-300, loss_per_min 0.005-2). A journey would invert a model with no real authority.\"}");
    return;
  }
  if (!saveAppliedCalibration(next)) {
    sendRequestResponse(500, "application/json",
                "{\"ok\":false,\"message\":\"Calibration storage failed.\"}");
    return;
  }
  // A matching lease can expire while a flash write is in progress. Once the
  // request passed the mutation gate, an incomplete lease still owns the
  // mutation even if its active timeout elapsed before this success boundary.
  refreshRestoreLease();
  if (restoreLease.incomplete) markRestoreDirty();
  else advanceStateRevision();
  String response = F("{\"ok\":true,\"applied\":true,\"state_rev\":\"");
  appendUint64Decimal(response, currentStateRevision());
  response += F("\"}");
  sendRequestResponse(200, "application/json", response);
}

// POST /api/roast/start - either a whole autonomous plan handed to the device,
// or the first instruction of an operator-controlled manual roast. Timed and
// journey modes need no browser after 202. Manual remains safe without one but,
// by definition, needs an operator client for its next adjustment or Stop.
void handleRoastStart() {
  if (rejectMutationDuringRestore()) return;
  if (manualConflictLatched) {
    sendRequestResponse(423, "application/json",
                "{\"ok\":false,\"message\":\"ESP actuation is disabled until the roaster is power-cycled.\"}");
    return;
  }
  if (!requestHasArg("confirm") || requestArg("confirm") != "START_ROAST") {
    sendRequestResponse(409, "application/json",
                "{\"ok\":false,\"message\":\"Roast-start confirmation is required.\"}");
    return;
  }
  const String mode = requestHasArg("mode") ? requestArg("mode") : String();
  if (mode != "timed" && mode != "journey" && mode != "manual") {
    sendRequestResponse(400, "application/json",
                "{\"ok\":false,\"message\":\"mode must be timed, journey, or manual.\"}");
    return;
  }

  char name[kRoastNameBytes + 1] = {0};
  sanitizeRoastName(requestHasArg("name") ? requestArg("name") : String("roast"),
                    name, sizeof(name));
  if (name[0] == '\0') strlcpy(name, "roast", sizeof(name));
  const uint32_t massG = readUintArg("mass", 225, kRoastMassMinimumG,
                                     kRoastMassMaximumG);

  uint32_t stepFans[kRoastMaxSteps] = {};
  uint32_t stepHeats[kRoastMaxSteps] = {};
  uint32_t stepSeconds[kRoastMaxSteps] = {};
  size_t stepCount = 0;
  sr800::JourneyZone zones[sr800::kMaxJourneyZones] = {};
  size_t zoneCount = 0;
  bool needsHeat = false;
  double startC = 0.0;

  if (mode == "timed") {
    if (!parseRoastStepsArg("steps", stepFans, stepHeats, stepSeconds,
                            stepCount)) {
      sendRequestResponse(400, "application/json",
                  "{\"ok\":false,\"message\":\"steps must be 1 to 24 comma-separated fan:heat:seconds triples, levels 0.0 through 10.0, seconds 1 through 1800, fan 0 only with heat 0.\"}");
      return;
    }
    for (size_t index = 0; index < stepCount; ++index) {
      if (stepHeats[index] > 0) needsHeat = true;
    }
  } else if (mode == "journey") {
    // Journey mode inverts the thermal model, and the model is the applied
    // calibration. Without it there is nothing to invert and the honest answer
    // is to refuse rather than to roast against a guess.
    if (!plausibleCalibration(appliedCalibration)) {
      sendRequestResponse(409, "application/json",
                  "{\"ok\":false,\"message\":\"A journey roast needs plausible applied calibration coefficients. Fit and apply a calibration first, or run the roast in timed mode.\"}");
      return;
    }
    float requestedStartC = 0.0f;
    startC = parseFiniteFloatArg("start", requestedStartC)
        ? static_cast<double>(requestedStartC)
        : (isnan(maxThermocoupleC) ? 25.0
                                   : static_cast<double>(maxThermocoupleC));
    if (!parseRoastZonesArg("zones", startC, zones, zoneCount)) {
      sendRequestResponse(400, "application/json",
                  "{\"ok\":false,\"message\":\"zones must be 1 to 12 semicolon-separated groups of endC:duration:fanMin:fanMax:heatMin:heatMax, duration in seconds (5 to 1800) or r<C-per-minute>, levels 0.0 through 10.0.\"}");
      return;
    }
    for (size_t index = 0; index < zoneCount; ++index) {
      if (zones[index].heatMax > 0.0) needsHeat = true;
    }
  } else {
    bool fanClamped = false;
    bool heatClamped = false;
    if (!parseLevelArg("fan", stepFans[0], fanClamped) ||
        !parseLevelArg("heat", stepHeats[0], heatClamped) ||
        stepFans[0] == 0) {
      sendRequestResponse(400, "application/json",
                  "{\"ok\":false,\"message\":\"A manual roast needs fan from 0.1 through 10.0 and heat from 0.0 through 10.0.\"}");
      return;
    }
    // Heat on means Fan 1.0 or higher.
    stepFans[0] = heatOnFanFloorMilli(stepFans[0], stepHeats[0]);
    needsHeat = stepHeats[0] > 0;
  }

  if (needsHeat) {
    const bool temperatureHealthy = heatStartTemperatureHealthy(millis());
    if (!temperatureHealthy) {
      sendRequestResponse(409, "application/json",
                  "{\"ok\":false,\"message\":\"Fresh fault-free thermocouple telemetry is required to start a roast that uses heat.\"}");
      return;
    }
  }

  // Ambient is the cold-junction temperature at the moment the roast starts:
  // the board's own reading of the room, taken once so the plan's passive-loss
  // term does not wander with the board warming up inside the roaster.
  const double ambientC = isnan(maxColdJunctionC)
      ? kRoastFallbackAmbientC : static_cast<double>(maxColdJunctionC);

  const bool recordThermalLog =
      !requestHasArg("record") || requestArg("record") != "0";
  const char* rejection = nullptr;
  const RoastMode requestedMode = mode == "timed"
      ? RoastMode::TIMED
      : mode == "journey" ? RoastMode::JOURNEY : RoastMode::MANUAL;
  if (!startRoast(requestedMode,
                  name, stepFans, stepHeats, stepSeconds, stepCount,
                  zones, zoneCount, static_cast<double>(massG), ambientC,
                  recordThermalLog, rejection)) {
    sendActuationStartRejection(rejection, "Roast could not start.");
    return;
  }

  roastPlanRevision = 1;
  if (roastMode == RoastMode::MANUAL) {
    const sr800::ActuatorSnapshot accepted = actuator.snapshot(micros());
    if (!stageManualRoastArchiveChange(
            0, roastPlanRevision, roastCommandFanMilli, roastCommandHeatMilli,
            accepted.effectiveFanMilli, accepted.effectiveHeatMilli)) {
      finishRoast(micros(), "command_rejected");
      sendRequestResponse(500, "application/json",
                  "{\"ok\":false,\"message\":\"The roast started safely but its initial instruction could not be archived, so Heat was stopped.\"}");
      return;
    }
  }
  memset(roastProfileId, 0, sizeof(roastProfileId));
  if (requestHasArg("profile_id")) {
    strlcpy(roastProfileId, requestArg("profile_id").c_str(), sizeof(roastProfileId));
    for (char* c = roastProfileId; *c != '\0'; ++c) {
      if (!isalnum(static_cast<unsigned char>(*c)) && *c != '.' && *c != '_' &&
          *c != ':' && *c != '-') *c = '-';
    }
  }
  roastProfileRevision = 0;
  if (requestHasArg("profile_revision")) {
    parseRequiredUint32Arg("profile_revision", roastProfileRevision);
  }

  String response = F("{\"ok\":true,\"roast_active\":true,\"mode\":\"");
  response += roastModeName(roastMode);
  response += F("\",\"name\":\"");
  response += roastName;
  response += F("\",\"batch_mass_g\":");
  response += massG;
  response += F(",\"ambient_c\":");
  response += String(ambientC, 2);
  response += F(",\"ambient_source\":\"");
  response += isnan(maxColdJunctionC) ? F("fallback") : F("cold_junction");
  response += F("\",\"steps\":");
  response += static_cast<uint32_t>(stepCount);
  response += F(",\"zones\":");
  response += static_cast<uint32_t>(zoneCount);
  response += F(",\"started_epoch\":");
  response += roastStartEpoch;
  response += F(",\"session_id\":");
  response += roastSessionId;
  response += F(",\"plan_rev\":");
  response += roastPlanRevision;
  response += F(",\"profile_id\":\"");
  response += roastProfileId;
  response += F("\",\"profile_revision\":");
  response += roastProfileRevision;
  response += F(",\"log_id\":\"");
  if (thermalLogReservedId != 0) response += thermalLogReservedId;
  response += F("\",\"state_rev\":\"");
  appendUint64Decimal(response, currentStateRevision());
  response += F("\",\"boot\":");
  response += bootCount;
  response += F(",\"elapsed_sec\":0");
  response += F(",\"thermal_log_interval_ms\":");
  response += thermalLogIntervalMs;
  if (roastMode == RoastMode::JOURNEY) {
    response += F(",\"start_c\":");
    response += String(startC, 2);
    response += F(",\"coefficients\":{\"heater_gain\":");
    response += String(roastCalibration.heaterGainCPerMinAt10, 3);
    response += F(",\"fan_cooling\":");
    response += String(roastCalibration.fanCoolingCPerMinAt10, 3);
    response += F(",\"cooling_fan\":");
    response += String(roastCalibration.coolingFanCPerMinAt10, 3);
    response += F(",\"loss_per_min\":");
    response += String(roastCalibration.thermalLossPerMinPerC, 4);
    response += F(",\"reference_batch_mass_g\":");
    response += static_cast<uint32_t>(kRoastReferenceBatchMassG);
    response += F(",\"fit_id\":\"");
    response += appliedCalibration.fitId;
    response += F("\"}");
  } else if (roastMode == RoastMode::MANUAL) {
    const sr800::ActuatorSnapshot accepted = actuator.snapshot(micros());
    response += F(",\"fan_level\":");
    response += String(roastCommandFanMilli / 1000.0f, 3);
    response += F(",\"heat_level\":");
    response += String(roastCommandHeatMilli / 1000.0f, 3);
    response += F(",\"accepted_fan\":");
    response += String(roastCommandFanMilli / 1000.0f, 3);
    response += F(",\"accepted_heat\":");
    response += String(roastCommandHeatMilli / 1000.0f, 3);
    response += F(",\"effective_fan\":");
    response += String(accepted.effectiveFanMilli / 1000.0f, 3);
    response += F(",\"effective_heat\":");
    response += String(accepted.effectiveHeatMilli / 1000.0f, 3);
    response += F(",\"instruction_limit_ms\":");
    response += kManualInstructionLeaseMs;
  }
  response += F("}");
  sendRequestResponse(202, "application/json", response);
}

void sendActiveRoastPlan(int statusCode = 200,
                         bool includeImmediateTransition = false,
                         bool immediateTransition = false) {
  String json;
  json.reserve(sr800::network::kCommandResponseBytes);
  json += F("{\"ok\":true,\"active\":");
  json += roastActive ? F("true") : F("false");
  json += F(",\"boot_id\":\"");
  json += bootCount;
  json += F("\",\"session_id\":");
  json += roastSessionId;
  json += F(",\"plan_rev\":");
  json += roastPlanRevision;
  json += F(",\"mode\":\"");
  json += roastModeName(roastMode);
  json += F("\",\"profile_id\":\"");
  json += roastProfileId;
  json += F("\",\"profile_revision\":");
  json += roastProfileRevision;
  json += F(",\"name\":\"");
  json += roastName;
  json += F("\",\"batch_mass_g\":");
  json += String(roastBatchMassG, 1);
  json += F(",\"start_c\":");
  if (roastZoneCount > 0) json += String(roastZones[0].startC, 2);
  else json += F("null");
  json += F(",\"steps\":[");
  for (size_t index = 0; index < roastStepCount; ++index) {
    if (index != 0) json += ',';
    json += F("{\"fan\":");
    json += String(roastStepFanMilli[index] / 1000.0f, 3);
    json += F(",\"heat\":");
    json += String(roastStepHeatMilli[index] / 1000.0f, 3);
    json += F(",\"duration_sec\":");
    json += roastStepSeconds[index];
    json += '}';
  }
  json += F("],\"zones\":[");
  for (size_t index = 0; index < roastZoneCount; ++index) {
    if (index != 0) json += ',';
    const sr800::JourneyZone& zone = roastZones[index];
    json += F("{\"start_c\":"); json += String(zone.startC, 2);
    json += F(",\"end_c\":"); json += String(zone.endC, 2);
    json += F(",\"duration_sec\":"); json += String(zone.durationSec, 1);
    json += F(",\"fan_min\":"); json += String(zone.fanMin, 3);
    json += F(",\"fan_max\":"); json += String(zone.fanMax, 3);
    json += F(",\"heat_min\":"); json += String(zone.heatMin, 3);
    json += F(",\"heat_max\":"); json += String(zone.heatMax, 3);
    json += '}';
  }
  json += ']';
  if (roastMode == RoastMode::JOURNEY && roastArchivePlanValid &&
      roastArchivePlan.mode == sr800::logcodec::PlanMode::JOURNEY) {
    json += F(",\"initial_zones\":[");
    for (uint8_t index = 0; index < roastArchivePlan.itemCount; ++index) {
      if (index != 0) json += ',';
      const sr800::logcodec::PlanItem& zone = roastArchivePlan.items[index];
      json += F("{\"start_c\":"); json += String(zone.startDeci / 10.0f, 1);
      json += F(",\"end_c\":"); json += String(zone.endDeci / 10.0f, 1);
      json += F(",\"duration_sec\":"); json += zone.durationSec;
      json += F(",\"fan_min\":"); json += String(zone.fanMinDeci / 10.0f, 1);
      json += F(",\"fan_max\":"); json += String(zone.fanMaxDeci / 10.0f, 1);
      json += F(",\"heat_min\":"); json += String(zone.heatMinDeci / 10.0f, 1);
      json += F(",\"heat_max\":"); json += String(zone.heatMaxDeci / 10.0f, 1);
      json += '}';
    }
    json += ']';
  }
  if (includeImmediateTransition) {
    json += F(",\"immediate_transition\":");
    json += immediateTransition ? F("true") : F("false");
  }
  json += '}';
  sendRequestResponse(statusCode, "application/json", json);
}

void handleRoastActivePlanGet() {
  sendActiveRoastPlan();
}

void handleRoastActivePlanPatch() {
  if (rejectMutationDuringRestore()) return;
  if (!requestHasArg("confirm") || requestArg("confirm") != "PATCH_ROAST_PLAN") {
    sendRequestResponse(409, "application/json",
                "{\"ok\":false,\"message\":\"confirm=PATCH_ROAST_PLAN is required\"}");
    return;
  }
  if (!roastActive || (roastMode != RoastMode::JOURNEY && roastMode != RoastMode::TIMED)) {
    sendRequestResponse(409, "application/json",
                "{\"ok\":false,\"message\":\"No editable profiled roast is active.\"}");
    return;
  }
  uint32_t expectedSession = 0;
  uint32_t expectedPlanRevision = 0;
  if (!parseRequiredUint32Arg("expected_session", expectedSession) ||
      expectedSession != roastSessionId ||
      !parseRequiredUint32Arg("expected_plan_rev", expectedPlanRevision) ||
      expectedPlanRevision != roastPlanRevision) {
    String conflict = F("{\"ok\":false,\"message\":\"The active roast plan changed.\",\"session_id\":");
    conflict += roastSessionId;
    conflict += F(",\"plan_rev\":");
    conflict += roastPlanRevision;
    conflict += '}';
    sendRequestResponse(409, "application/json", conflict);
    return;
  }

  if (roastMode == RoastMode::TIMED) {
    uint32_t stepIndex = 0;
    uint32_t durationSec = 0;
    uint32_t fanMilli = 0;
    uint32_t heatMilli = 0;
    if (!parseRequiredUint32Arg("step_index", stepIndex) ||
        !parseRequiredUint32Arg("duration_sec", durationSec) ||
        !requestHasArg("fan") || !requestHasArg("heat") ||
        !parseLevelToken(requestArg("fan"), fanMilli, true) ||
        !parseLevelToken(requestArg("heat"), heatMilli, true) ||
        (fanMilli == 0 && heatMilli > 0) ||
        stepIndex < roastStepIndex || stepIndex > roastStepCount ||
        stepIndex >= kRoastMaxSteps || durationSec < kRoastStepMinimumS ||
        durationSec > kRoastStepMaximumS) {
      sendRequestResponse(400, "application/json",
                  "{\"ok\":false,\"message\":\"The timed step is outside its safe bounds or is already complete.\"}");
      return;
    }
    // Heat on means Fan 1.0 or higher.
    fanMilli = heatOnFanFloorMilli(fanMilli, heatMilli);
    uint32_t elapsedInStep = 0;
    if (stepIndex == roastStepIndex && roastStepDeadlineArmed) {
      const int32_t remainingUs = static_cast<int32_t>(roastStepEndUs - micros());
      const uint32_t remainingSec = remainingUs > 0
          ? static_cast<uint32_t>((remainingUs + 999999) / 1000000) : 0;
      elapsedInStep = roastStepSeconds[roastStepIndex] > remainingSec
          ? roastStepSeconds[roastStepIndex] - remainingSec : 0;
    }
    if (stepIndex == roastStepIndex && durationSec < elapsedInStep + 5U) {
      sendRequestResponse(400, "application/json",
                  "{\"ok\":false,\"message\":\"The current step must retain at least five seconds.\"}");
      return;
    }
    const uint32_t nextPlanRevision = sr800::runtime::nextSequence(roastPlanRevision);
    if (thermalLogSource == ThermalLogSource::ROAST && thermalLogUnsaved &&
        !stageTimedRoastArchiveChange(stepIndex, fanMilli, heatMilli, durationSec,
                                      roastElapsedSec, nextPlanRevision)) {
      sendRequestResponse(409, "application/json",
                  "{\"ok\":false,\"message\":\"This edit would exceed the recording's bounded plan-history space.\"}");
      return;
    }
    if (stepIndex == roastStepIndex) {
      const char* rejection = nullptr;
      const uint32_t nowUs = micros();
      if (!actuator.request(fanMilli, heatMilli, nowUs, rejection,
                            heatMilli > 0 ? kHeaterProofMaximumMs * 1000U : 0)) {
        if (thermalLogSource == ThermalLogSource::ROAST && thermalLogUnsaved &&
            roastArchivePlan.journalCount > 0) roastArchivePlan.journalCount--;
        sendRequestResponse(409, "application/json",
                    "{\"ok\":false,\"message\":\"The actuator refused the current step.\"}");
        return;
      }
      roastCommandFanMilli = fanMilli;
      roastCommandHeatMilli = heatMilli;
      roastCommandFan = fanMilli / 1000.0;
      roastCommandHeat = heatMilli / 1000.0;
      roastStepDwellRemainingSec = durationSec - elapsedInStep;
      const sr800::ActuatorSnapshot accepted = actuator.snapshot(nowUs);
      roastHeatObserved = heatMilli == 0 || accepted.effectiveHeatMilli > 0;
      roastStepDeadlineArmed = roastHeatObserved;
      roastStepEndUs = roastStepDeadlineArmed
          ? nowUs + roastStepDwellRemainingSec * 1000000U : 0;
      roastStepStartedUs = nowUs;
    }
    roastStepFanMilli[stepIndex] = fanMilli;
    roastStepHeatMilli[stepIndex] = heatMilli;
    roastStepSeconds[stepIndex] = durationSec;
    if (stepIndex == roastStepCount) roastStepCount++;
    roastPlanRevision = nextPlanRevision;
    uint32_t totalSec = 0;
    for (size_t index = 0; index < roastStepCount; ++index) totalSec += roastStepSeconds[index];
    roastEnvelopeSec = totalSec * 2U + kRoastEnvelopeMarginSec;
    sendActiveRoastPlan(202);
    return;
  }

  sr800::JourneyZone proposed[sr800::kMaxJourneyZones] = {};
  size_t proposedCount = 0;
  if (!parseRoastZonesArg("zones", roastZones[0].startC, proposed, proposedCount)) {
    sendRequestResponse(400, "application/json",
                "{\"ok\":false,\"message\":\"zones is not a valid bounded journey plan\"}");
    return;
  }
  const size_t current = roastControlState.zoneIndex;
  if (current >= roastZoneCount || proposedCount <= current) {
    sendRequestResponse(400, "application/json",
                "{\"ok\":false,\"message\":\"The patched plan must retain the active zone.\"}");
    return;
  }
  for (size_t index = 0; index < current; ++index) {
    const sr800::JourneyZone& old = roastZones[index];
    const sr800::JourneyZone& next = proposed[index];
    if (fabs(old.startC - next.startC) > 0.001 || fabs(old.endC - next.endC) > 0.001 ||
        fabs(old.durationSec - next.durationSec) > 0.001 ||
        fabs(old.fanMin - next.fanMin) > 0.001 || fabs(old.fanMax - next.fanMax) > 0.001 ||
        fabs(old.heatMin - next.heatMin) > 0.001 || fabs(old.heatMax - next.heatMax) > 0.001) {
      sendRequestResponse(409, "application/json",
                  "{\"ok\":false,\"message\":\"Completed zones are immutable.\"}");
      return;
    }
  }

  const double zoneElapsed = roastElapsedSec >= roastControlState.zoneEntrySec
      ? roastElapsedSec - roastControlState.zoneEntrySec : 0.0;
  sr800::runtime::JourneyPatchInput check;
  check.expectedSession = expectedSession;
  check.activeSession = roastSessionId;
  check.expectedPlanRevision = expectedPlanRevision;
  check.activePlanRevision = roastPlanRevision;
  check.immutableStartC = roastZones[current].startC;
  check.previousEndC = roastZones[current].endC;
  check.proposedEndC = proposed[current].endC;
  check.elapsedInZoneSec = zoneElapsed;
  check.proposedDurationSec = proposed[current].durationSec;
  check.temperatureC = maxThermocoupleC;
  check.allowImmediateTransition = requestHasArg("allow_immediate_transition") &&
      requestArg("allow_immediate_transition") == "1";
  const sr800::runtime::JourneyPatchVerdict verdict =
      sr800::runtime::validateJourneyPatch(check);
  if (verdict != sr800::runtime::JourneyPatchVerdict::ACCEPT &&
      verdict != sr800::runtime::JourneyPatchVerdict::ACCEPT_AND_ADVANCE) {
    const bool needsConfirm = verdict ==
        sr800::runtime::JourneyPatchVerdict::IMMEDIATE_TRANSITION_REQUIRES_CONFIRMATION;
    String refusal = F("{\"ok\":false,\"message\":\"");
    refusal += needsConfirm
        ? F("The new endpoint has already been crossed; explicitly allow the immediate transition.")
        : F("The active-zone patch is not safe from its immutable entry state.");
    refusal += F("\",\"requires_immediate_transition\":");
    refusal += needsConfirm ? F("true") : F("false");
    refusal += F(",\"plan_rev\":"); refusal += roastPlanRevision; refusal += '}';
    sendRequestResponse(needsConfirm ? 409 : 400, "application/json", refusal);
    return;
  }
  const uint32_t nextPlanRevision =
      sr800::runtime::nextSequence(roastPlanRevision);
  if (thermalLogSource == ThermalLogSource::ROAST && thermalLogUnsaved &&
      !stageRoastArchivePlanChange(proposed, proposedCount, roastElapsedSec,
                                   nextPlanRevision)) {
    sendRequestResponse(409, "application/json",
                "{\"ok\":false,\"message\":\"This edit would exceed the recording's bounded plan-history space.\"}");
    return;
  }
  for (size_t index = 0; index < proposedCount; ++index) roastZones[index] = proposed[index];
  roastZoneCount = proposedCount;
  roastPlanRevision = nextPlanRevision;
  double totalSec = 0.0;
  for (size_t index = 0; index < roastZoneCount; ++index) totalSec += roastZones[index].durationSec;
  roastEnvelopeSec = static_cast<uint32_t>(totalSec * 2.0) + kRoastEnvelopeMarginSec;
  const bool immediateTransition = verdict ==
      sr800::runtime::JourneyPatchVerdict::ACCEPT_AND_ADVANCE;
  if (immediateTransition) {
    const uint32_t nowUs = micros();
    serviceJourneyRoast(nowUs, actuator.snapshot(nowUs), true);
  }
  sendActiveRoastPlan(202, true, immediateTransition);
}

// POST /api/roast/set - one operator instruction during a MANUAL roast. This
// endpoint cannot start a session and cannot control a timed/journey program;
// those two properties keep a stale page from taking ownership accidentally.
void handleRoastSet() {
  if (rejectMutationDuringRestore()) return;
  if (manualConflictLatched) {
    sendRequestResponse(423, "application/json",
                "{\"ok\":false,\"message\":\"ESP actuation is disabled until the roaster is power-cycled.\"}");
    return;
  }
  if (!requestHasArg("confirm") ||
      requestArg("confirm") != "CONTROL_ROAST") {
    sendRequestResponse(409, "application/json",
                "{\"ok\":false,\"message\":\"Manual-roast control confirmation is required.\"}");
    return;
  }
  if (!roastActive || roastMode != RoastMode::MANUAL) {
    sendRequestResponse(409, "application/json",
                "{\"ok\":false,\"message\":\"No manual roast is active.\"}");
    return;
  }
  uint32_t expectedSession = 0;
  if (!parseRequiredUint32Arg("expected_session", expectedSession) ||
      expectedSession != roastSessionId) {
    String response =
        F("{\"ok\":false,\"message\":\"expected_session must match the active manual roast.\",\"session_id\":");
    response += roastSessionId;
    response += F("}");
    sendRequestResponse(409, "application/json", response);
    return;
  }

  uint32_t fanMilli = 0;
  uint32_t heatMilli = 0;
  bool fanClamped = false;
  bool heatClamped = false;
  if (!parseLevelArg("fan", fanMilli, fanClamped) ||
      !parseLevelArg("heat", heatMilli, heatClamped) || fanMilli == 0) {
    sendRequestResponse(400, "application/json",
                "{\"ok\":false,\"message\":\"Fan must be 0.1 through 10.0 and heat 0.0 through 10.0; use Stop to end the roast.\"}");
    return;
  }
  // Heat on means Fan 1.0 or higher.
  fanMilli = heatOnFanFloorMilli(fanMilli, heatMilli);
  if (heatMilli > 0) {
    const bool temperatureHealthy = heatStartTemperatureHealthy(millis());
    if (!temperatureHealthy) {
      sendRequestResponse(409, "application/json",
                  "{\"ok\":false,\"message\":\"Fresh fault-free thermocouple telemetry is required for heat.\"}");
      return;
    }
  }

  const uint32_t elapsedSec = (millis() - roastStartedMs) / 1000U;
  // The recording journal never gates the actuator: the operator must always
  // be able to change (and especially lower) Heat. A full journal only means
  // this instruction is not journaled; see roastArchiveJournalTruncated.
  const uint32_t nextPlanRevision =
      sr800::runtime::nextSequence(roastPlanRevision);
  const uint32_t nowUs = micros();
  const char* rejection = nullptr;
  if (!actuator.request(fanMilli, heatMilli, nowUs, rejection,
                        heatMilli > 0 ? kHeaterProofMaximumMs * 1000U : 0)) {
    String response = F("{\"ok\":false,\"message\":\"");
    response += rejection == nullptr ? "Manual roast request was rejected."
                                     : rejection;
    response += F("\"}");
    sendRequestResponse(409, "application/json", response);
    return;
  }

  roastCommandFanMilli = fanMilli;
  roastCommandHeatMilli = heatMilli;
  roastCommandFan = fanMilli / 1000.0;
  roastCommandHeat = heatMilli / 1000.0;
  roastLastRenewUs = nowUs;
  // Every accepted instruction, even an identical one, renews the whole
  // instruction lease. This mirrors diagnostic Manual exactly.
  roastLastInstructionMs = millis();
  const sr800::ActuatorSnapshot accepted = actuator.snapshot(micros());
  roastHeatObserved = heatMilli == 0 || accepted.effectiveHeatMilli > 0;
  if (!stageManualRoastArchiveChange(
          elapsedSec, nextPlanRevision, fanMilli, heatMilli,
          accepted.effectiveFanMilli, accepted.effectiveHeatMilli)) {
    // The instruction stands; only its journal entry is dropped.
    roastArchiveJournalTruncated = true;
  }
  roastPlanRevision = nextPlanRevision;
  String response = F("{\"ok\":true,\"roast_active\":true,\"mode\":\"manual\",\"name\":\"");
  response += roastName;
  response += F("\",\"boot\":");
  response += bootCount;
  response += F(",\"started_epoch\":");
  response += roastStartEpoch;
  response += F(",\"session_id\":");
  response += roastSessionId;
  response += F(",\"elapsed_sec\":");
  response += elapsedSec;
  response += F(",\"plan_rev\":");
  response += roastPlanRevision;
  response += F(",\"fan_level\":");
  response += String(fanMilli / 1000.0f, 3);
  response += F(",\"heat_level\":");
  response += String(heatMilli / 1000.0f, 3);
  response += F(",\"accepted_fan\":");
  response += String(fanMilli / 1000.0f, 3);
  response += F(",\"accepted_heat\":");
  response += String(heatMilli / 1000.0f, 3);
  response += F(",\"effective_fan\":");
  response += String(accepted.effectiveFanMilli / 1000.0f, 3);
  response += F(",\"effective_heat\":");
  response += String(accepted.effectiveHeatMilli / 1000.0f, 3);
  response += F(",\"instruction_age_ms\":0,\"instruction_limit_ms\":");
  response += kManualInstructionLeaseMs;
  response += F(",\"journal_truncated\":");
  response += roastArchiveJournalTruncated ? F("true") : F("false");
  response += F("}");
  sendRequestResponse(202, "application/json", response);
}

void handleWifiConfiguration() {
  StorageMutationGuard nvsMutation;
  if (!nvsMutationAllowed() || !nvsMutation) {
    sendRequestResponse(409, "application/json",
                "{\"ok\":false,\"message\":\"Network settings require a fully idle roaster with no firmware update active.\"}");
    return;
  }
  if (!requestHasArg("ssid") || !requestHasArg("password")) {
    sendRequestResponse(400, "application/json",
                "{\"ok\":false,\"message\":\"Wi-Fi name and password are required.\"}");
    return;
  }
  const String ssid = requestArg("ssid");
  String password = requestArg("password");
  if (ssid.isEmpty() || ssid.length() > 32 ||
      ((!password.isEmpty() && password.length() < 8) ||
       password.length() > 63)) {
    scrubString(password);
    sendRequestResponse(400, "application/json",
                "{\"ok\":false,\"message\":\"Invalid Wi-Fi name or password length.\"}");
    return;
  }
  if (!saveNetworkCredentials(ssid, password)) {
    scrubString(password);
    sendRequestResponse(500, "application/json",
                "{\"ok\":false,\"message\":\"Could not save network settings.\"}");
    return;
  }
  startStationConnection(ssid, password);
  sendRequestResponse(
      202, "application/json",
      "{\"ok\":true,\"message\":\"Settings saved. Waiting for the LAN connection...\"}");
}

constexpr size_t kOtaPreflightBytes =
    sizeof(esp_image_header_t) + sizeof(esp_image_segment_header_t) +
    sizeof(esp_app_desc_t);
static_assert(kOtaPreflightBytes <= kOtaReceiveChunkBytes,
              "OTA preflight must fit the internal receive buffer");

void otaDigestToHex(const uint8_t digest[32], char hex[65]) {
  static constexpr char digits[] = "0123456789abcdef";
  for (size_t index = 0; index < 32; ++index) {
    hex[index * 2] = digits[digest[index] >> 4];
    hex[index * 2 + 1] = digits[digest[index] & 0x0f];
  }
  hex[64] = 0;
}

class OtaSha256 {
 public:
  OtaSha256() {
    mbedtls_sha256_init(&context_);
    ready_ = mbedtls_sha256_starts(&context_, 0) == 0;
  }
  ~OtaSha256() { mbedtls_sha256_free(&context_); }
  bool ready() const { return ready_; }
  bool update(const uint8_t* bytes, size_t length) {
    return ready_ && !finished_ &&
        mbedtls_sha256_update(&context_, bytes, length) == 0;
  }
  bool finish(uint8_t digest[32]) {
    if (!ready_ || finished_ || digest == nullptr) return false;
    finished_ = true;
    return mbedtls_sha256_finish(&context_, digest) == 0;
  }

 private:
  mbedtls_sha256_context context_ = {};
  bool ready_ = false;
  bool finished_ = false;
};

bool otaDigestsEqual(const uint8_t left[32], const uint8_t right[32]) {
  uint8_t difference = 0;
  for (size_t index = 0; index < 32; ++index) {
    difference |= left[index] ^ right[index];
  }
  return difference == 0;
}

bool validOtaApplicationPrefix(const uint8_t* bytes, size_t length) {
  if (bytes == nullptr || length < kOtaPreflightBytes) return false;
  esp_image_header_t header = {};
  esp_image_segment_header_t firstSegment = {};
  esp_app_desc_t descriptor = {};
  memcpy(&header, bytes, sizeof(header));
  memcpy(&firstSegment, bytes + sizeof(header), sizeof(firstSegment));
  memcpy(&descriptor,
         bytes + sizeof(esp_image_header_t) +
             sizeof(esp_image_segment_header_t),
         sizeof(descriptor));
  return header.magic == ESP_IMAGE_HEADER_MAGIC &&
      header.segment_count > 0 &&
      header.segment_count <= ESP_IMAGE_MAX_SEGMENTS &&
      header.chip_id == ESP_CHIP_ID_ESP32S3 &&
      header.hash_appended == 1 &&
      firstSegment.data_len >= sizeof(esp_app_desc_t) &&
      descriptor.magic_word == ESP_APP_DESC_MAGIC_WORD;
}

esp_err_t hashOtaPartition(const esp_partition_t* partition, size_t length,
                           uint8_t* scratch, size_t scratchBytes,
                           uint8_t digest[32]) {
  if (partition == nullptr || scratch == nullptr || scratchBytes == 0 ||
      digest == nullptr || length > partition->size) {
    return ESP_ERR_INVALID_ARG;
  }
  mbedtls_sha256_context context;
  mbedtls_sha256_init(&context);
  if (mbedtls_sha256_starts(&context, 0) != 0) {
    mbedtls_sha256_free(&context);
    return ESP_FAIL;
  }
  size_t offset = 0;
  while (offset < length) {
    const size_t count = std::min(scratchBytes, length - offset);
    const esp_err_t readResult =
        esp_partition_read(partition, offset, scratch, count);
    if (readResult != ESP_OK ||
        mbedtls_sha256_update(&context, scratch, count) != 0) {
      mbedtls_sha256_free(&context);
      return readResult == ESP_OK ? ESP_FAIL : readResult;
    }
    offset += count;
  }
  const int finishResult = mbedtls_sha256_finish(&context, digest);
  mbedtls_sha256_free(&context);
  return finishResult == 0 ? ESP_OK : ESP_FAIL;
}

bool requestOtaAdmission() {
  bool claimed = false;
  portENTER_CRITICAL(&otaStateMux);
  if (otaAdmissionState == OtaAdmissionState::IDLE && !otaRestartPending) {
    otaAdmissionState = OtaAdmissionState::REQUESTED;
    claimed = true;
  }
  portEXIT_CRITICAL(&otaStateMux);
  return claimed;
}

OtaAdmissionState copyOtaAdmissionState() {
  portENTER_CRITICAL(&otaStateMux);
  const OtaAdmissionState state = otaAdmissionState;
  portEXIT_CRITICAL(&otaStateMux);
  return state;
}

bool otaReservesPort80() {
  return copyOtaAdmissionState() != OtaAdmissionState::IDLE;
}

bool waitForOtaAdmission() {
  const uint32_t startedMs = millis();
  while (millis() - startedMs < kOtaAdmissionWaitMs) {
    const OtaAdmissionState state = copyOtaAdmissionState();
    if (state == OtaAdmissionState::GRANTED) return true;
    if (state == OtaAdmissionState::DENIED) {
      portENTER_CRITICAL(&otaStateMux);
      if (otaAdmissionState == OtaAdmissionState::DENIED) {
        otaAdmissionState = OtaAdmissionState::IDLE;
      }
      portEXIT_CRITICAL(&otaStateMux);
      return false;
    }
    vTaskDelay(pdMS_TO_TICKS(1));
  }
  portENTER_CRITICAL(&otaStateMux);
  if (otaAdmissionState == OtaAdmissionState::REQUESTED ||
      otaAdmissionState == OtaAdmissionState::GRANTING ||
      otaAdmissionState == OtaAdmissionState::GRANTED) {
    otaAdmissionState = OtaAdmissionState::RELEASE_REQUESTED;
  }
  portEXIT_CRITICAL(&otaStateMux);
  return false;
}

void requestOtaRelease() {
  portENTER_CRITICAL(&otaStateMux);
  if (otaAdmissionState != OtaAdmissionState::COMMITTED) {
    otaAdmissionState = OtaAdmissionState::RELEASE_REQUESTED;
  }
  portEXIT_CRITICAL(&otaStateMux);
}

// loop() alone grants and releases OTA admission after the HTTP handler asks.
void serviceOtaAdmission() {
  OtaAdmissionState state = copyOtaAdmissionState();
  if (state == OtaAdmissionState::RELEASE_REQUESTED) {
    attachSignalInterrupts();
    portENTER_CRITICAL(&otaStateMux);
    if (otaAdmissionState == OtaAdmissionState::RELEASE_REQUESTED) {
      otaAdmissionState = OtaAdmissionState::IDLE;
    }
    portEXIT_CRITICAL(&otaStateMux);
    return;
  }
  if (state != OtaAdmissionState::REQUESTED) return;
  const ThermalLogStateSnapshot recording = copyThermalLogState();
  const bool controllerBusy =
      !actuatorFullyIdle() || recording.active || recording.unsaved;
  // Storage admission re-checks OTA while holding storageMutationMux. Take
  // the same storage-then-OTA order and decide both ownership states atomically.
  portENTER_CRITICAL(&storageMutationMux);
  portENTER_CRITICAL(&otaStateMux);
  if (otaAdmissionState == OtaAdmissionState::REQUESTED) {
    if (controllerBusy || storageMutationActive || storageRequestActive) {
      otaAdmissionState = OtaAdmissionState::DENIED;
    } else {
      otaAdmissionState = OtaAdmissionState::GRANTING;
    }
  }
  state = otaAdmissionState;
  portEXIT_CRITICAL(&otaStateMux);
  portEXIT_CRITICAL(&storageMutationMux);
  if (state == OtaAdmissionState::DENIED) return;
  if (state != OtaAdmissionState::GRANTING) return;
  freezeCapture();
  detachSignalInterrupts();
  portENTER_CRITICAL(&otaStateMux);
  if (otaAdmissionState == OtaAdmissionState::GRANTING) {
    otaAdmissionState = OtaAdmissionState::GRANTED;
  }
  portEXIT_CRITICAL(&otaStateMux);
}
esp_err_t sendOtaJson(httpd_req_t* request, const char* status,
                      const char* code, const char* message,
                      esp_err_t detail = ESP_OK,
                      bool includeDiagnostics = false) {
  char body[768];
  if (detail == ESP_OK) {
    snprintf(body, sizeof(body),
             "{\"ok\":false,\"code\":\"%s\",\"message\":\"%s\"}",
             code, message);
  } else if (includeDiagnostics) {
    const OtaAttemptDiagnostics diagnostics = copyOtaAttemptDiagnostics();
    snprintf(body, sizeof(body),
             "{\"ok\":false,\"code\":\"%s\",\"message\":\"%s\","
             "\"detail\":\"%s\",\"declared_bytes\":%lu,"
             "\"received_bytes\":%lu,\"target_offset\":%lu,"
             "\"received_sha256\":\"%s\",\"flash_sha256\":\"%s\","
             "\"readback_complete\":%s,\"readback_match\":%s}",
             code, message, esp_err_to_name(detail),
             static_cast<unsigned long>(diagnostics.declaredBytes),
             static_cast<unsigned long>(diagnostics.receivedBytes),
             static_cast<unsigned long>(diagnostics.targetOffset),
             diagnostics.receivedSha256, diagnostics.flashSha256,
             diagnostics.readbackComplete ? "true" : "false",
             diagnostics.readbackMatched ? "true" : "false");
  } else {
    snprintf(body, sizeof(body),
             "{\"ok\":false,\"code\":\"%s\",\"message\":\"%s\","
             "\"detail\":\"%s\"}",
             code, message, esp_err_to_name(detail));
  }
  httpd_resp_set_status(request, status);
  httpd_resp_set_type(request, "application/json");
  httpd_resp_set_hdr(request, "Cache-Control", "no-store");
  httpd_resp_set_hdr(request, "Connection", "close");
  const esp_err_t responseResult = httpd_resp_sendstr(request, body);
  // OTA errors can leave request bytes unread. Returning failure makes ESP-IDF
  // close this session after the best-effort JSON response instead of parsing
  // remaining firmware bytes as another keep-alive request.
  return responseResult == ESP_OK ? ESP_FAIL : responseResult;
}

void resetFailedOtaAttempt(esp_err_t error) {
  if (otaHandleActive) {
    esp_ota_abort(otaHandle);
    otaHandleActive = false;
  }
  otaError = error;
  updateStarted = false;
  updateFinished = false;
  otaBytesWritten = 0;
  otaTargetPartition = nullptr;
  otaBootPartitionSelected = false;
  requestOtaRelease();
}

esp_err_t failOtaUpload(httpd_req_t* request, const char* status,
                        const char* code, const char* message,
                        esp_err_t error,
                        const OtaAttemptDiagnostics* diagnostics = nullptr) {
  if (diagnostics != nullptr) {
    OtaAttemptDiagnostics completed = *diagnostics;
    completed.error = error;
    publishOtaAttemptDiagnostics(completed);
  }
  resetFailedOtaAttempt(error);
  return sendOtaJson(request, status, code, message, error,
                     diagnostics != nullptr);
}

bool otaRequestHasRawContentType(httpd_req_t* request) {
  return nativeRequestHasRawContentType(request);
}

esp_err_t handleOtaVersion(httpd_req_t* request) {
  char body[96];
  snprintf(body, sizeof(body),
           "{\"firmware_version\":\"%s\",\"ota_path\":\"/update\"}",
           kFirmwareVersion);
  httpd_resp_set_type(request, "application/json");
  httpd_resp_set_hdr(request, "Cache-Control", "no-store");
  return httpd_resp_sendstr(request, body);
}


esp_err_t handleRawOtaUpload(httpd_req_t* request) {
  if (!otaRequestHasRawContentType(request)) {
    return sendOtaJson(
        request, "415 Unsupported Media Type", "raw_binary_required",
        "Send the firmware file itself as application/octet-stream.");
  }
  if (!requestOtaAdmission()) {
    return sendOtaJson(
        request, "409 Conflict", "update_in_progress",
        "A firmware update is already active or committed for restart.");
  }
  if (!waitForOtaAdmission()) {
    return sendOtaJson(
        request, "409 Conflict", "roaster_not_idle",
        "Wait for controls, recordings, storage writes, and page downloads to finish before updating.");
  }
  otaTargetPartition = esp_ota_get_next_update_partition(nullptr);
  const size_t contentLength = request->content_len;
  OtaAttemptDiagnostics attempt;
  attempt.attempted = true;
  attempt.declaredBytes = static_cast<uint32_t>(contentLength);
  attempt.targetOffset = otaTargetPartition == nullptr
      ? 0U : otaTargetPartition->address;
  publishOtaAttemptDiagnostics(attempt);
  if (otaTargetPartition == nullptr) {
    return failOtaUpload(
        request, "500 Internal Server Error", "ota_partition_missing",
        "No inactive application partition is available.", ESP_ERR_NOT_FOUND,
        &attempt);
  }
  if (contentLength < 1024U || contentLength > otaTargetPartition->size) {
    return failOtaUpload(
        request, "413 Payload Too Large", "invalid_image_size",
        "The declared image size does not fit the inactive application partition.",
        ESP_ERR_INVALID_SIZE, &attempt);
  }

  updateStarted = false;
  updateFinished = false;
  otaHandleActive = false;
  otaBytesWritten = 0;
  otaBootPartitionSelected = false;
  otaRestartPending = false;
  otaRestartRequestedMs = 0;
  otaError = ESP_OK;

  uint8_t chunk[kOtaReceiveChunkBytes];
  uint8_t preflight[kOtaPreflightBytes] = {};
  size_t preflightUsed = 0;
  OtaSha256 receivedHasher;
  if (!receivedHasher.ready()) {
    return failOtaUpload(
        request, "500 Internal Server Error", "ota_hash_init_failed",
        "The firmware integrity check could not be initialized.", ESP_FAIL,
        &attempt);
  }
  size_t remaining = contentLength;
  uint32_t lastProgressMs = millis();

  // A TCP receive may legally return only part of the first segment. Buffer and
  // validate the complete fixed prefix before erasing or writing the inactive
  // partition; every received byte is counted and hashed exactly once.
  while (preflightUsed < sizeof(preflight)) {
    const int received = httpd_req_recv(
        request, reinterpret_cast<char*>(preflight + preflightUsed),
        sizeof(preflight) - preflightUsed);
    if (received == HTTPD_SOCK_ERR_TIMEOUT) {
      if (millis() - lastProgressMs < kOtaReceiveNoProgressMs) continue;
      return failOtaUpload(
          request, "408 Request Timeout", "upload_stalled",
          "No firmware bytes arrived for 30 seconds.", ESP_ERR_TIMEOUT,
          &attempt);
    }
    if (received <= 0) {
      return failOtaUpload(
          request, "400 Bad Request", "upload_interrupted",
          "The upload connection closed before the complete image arrived.",
          ESP_ERR_INVALID_RESPONSE, &attempt);
    }
    lastProgressMs = millis();
    const size_t receivedSize = static_cast<size_t>(received);
    attempt.receivedBytes += static_cast<uint32_t>(receivedSize);
    if (!receivedHasher.update(preflight + preflightUsed, receivedSize)) {
      return failOtaUpload(
          request, "500 Internal Server Error", "ota_hash_update_failed",
          "The received firmware could not be integrity checked.", ESP_FAIL,
          &attempt);
    }
    preflightUsed += receivedSize;
    remaining -= receivedSize;
  }
  if (!validOtaApplicationPrefix(preflight, sizeof(preflight))) {
    return failOtaUpload(
        request, "422 Unprocessable Content", "invalid_application_image",
        "Choose the versioned Crackle ESP32-S3 application OTA image.",
        ESP_ERR_OTA_VALIDATE_FAILED, &attempt);
  }

  const esp_partition_t* runningPartition = esp_ota_get_running_partition();
  esp_ota_img_states_t runningState = ESP_OTA_IMG_UNDEFINED;
  if (runningPartition != nullptr &&
      esp_ota_get_state_partition(runningPartition, &runningState) == ESP_OK &&
      runningState == ESP_OTA_IMG_PENDING_VERIFY) {
    otaError = esp_ota_mark_app_valid_cancel_rollback();
    if (otaError != ESP_OK) {
      return failOtaUpload(
          request, "500 Internal Server Error", "current_image_not_validated",
          "The current image could not be committed before starting an update.",
          otaError, &attempt);
    }
    otaImageValidated = true;
  }

  otaError = esp_ota_begin(otaTargetPartition, contentLength, &otaHandle);
  if (otaError != ESP_OK) {
    return failOtaUpload(
        request, "500 Internal Server Error", "ota_begin_failed",
        "The inactive application partition could not be prepared.",
        otaError, &attempt);
  }
  otaHandleActive = true;
  updateStarted = true;
  otaError = esp_ota_write(otaHandle, preflight, sizeof(preflight));
  if (otaError != ESP_OK) {
    return failOtaUpload(
        request, "500 Internal Server Error", "ota_write_failed",
        "Writing the firmware image failed; the current firmware remains selected.",
        otaError, &attempt);
  }
  otaBytesWritten = sizeof(preflight);

  while (remaining > 0) {
    const size_t wanted = std::min(remaining, sizeof(chunk));
    const int received = httpd_req_recv(
        request, reinterpret_cast<char*>(chunk), wanted);
    if (received == HTTPD_SOCK_ERR_TIMEOUT) {
      if (millis() - lastProgressMs < kOtaReceiveNoProgressMs) continue;
      return failOtaUpload(
          request, "408 Request Timeout", "upload_stalled",
          "No firmware bytes arrived for 30 seconds.", ESP_ERR_TIMEOUT,
          &attempt);
    }
    if (received <= 0) {
      return failOtaUpload(
          request, "400 Bad Request", "upload_interrupted",
          "The upload connection closed before the complete image arrived.",
          ESP_ERR_INVALID_RESPONSE, &attempt);
    }
    lastProgressMs = millis();
    const size_t receivedSize = static_cast<size_t>(received);
    attempt.receivedBytes += static_cast<uint32_t>(receivedSize);
    if (!receivedHasher.update(chunk, receivedSize)) {
      return failOtaUpload(
          request, "500 Internal Server Error", "ota_hash_update_failed",
          "The received firmware could not be integrity checked.", ESP_FAIL,
          &attempt);
    }
    otaError = esp_ota_write(otaHandle, chunk, receivedSize);
    if (otaError != ESP_OK) {
      return failOtaUpload(
          request, "500 Internal Server Error", "ota_write_failed",
          "Writing the firmware image failed; the current firmware remains selected.",
          otaError, &attempt);
    }
    otaBytesWritten += receivedSize;
    remaining -= receivedSize;
  }

  if (!otaHandleActive || otaBytesWritten != contentLength) {
    return failOtaUpload(
        request, "400 Bad Request", "image_length_mismatch",
        "The received byte count did not match Content-Length.",
        ESP_ERR_INVALID_SIZE, &attempt);
  }
  uint8_t receivedDigest[32] = {};
  uint8_t flashDigest[32] = {};
  if (!receivedHasher.finish(receivedDigest)) {
    return failOtaUpload(
        request, "500 Internal Server Error", "ota_hash_finish_failed",
        "The received firmware integrity check could not be completed.",
        ESP_FAIL, &attempt);
  }
  otaDigestToHex(receivedDigest, attempt.receivedSha256);
  otaError = esp_ota_end(otaHandle);
  otaHandleActive = false;
  const esp_err_t validationResult = otaError;
  const esp_err_t readbackResult = hashOtaPartition(
      otaTargetPartition, contentLength, chunk, sizeof(chunk), flashDigest);
  if (readbackResult != ESP_OK) {
    return failOtaUpload(
        request, "500 Internal Server Error", "ota_readback_failed",
        "The inactive application partition could not be read back.",
        readbackResult, &attempt);
  }
  attempt.readbackComplete = true;
  otaDigestToHex(flashDigest, attempt.flashSha256);
  attempt.readbackMatched = otaDigestsEqual(receivedDigest, flashDigest);
  publishOtaAttemptDiagnostics(attempt);
  if (!attempt.readbackMatched) {
    return failOtaUpload(
        request, "422 Unprocessable Content", "ota_flash_readback_mismatch",
        "The bytes in flash differ from the bytes received; the current firmware remains selected.",
        ESP_ERR_INVALID_CRC, &attempt);
  }
  if (validationResult != ESP_OK) {
    return failOtaUpload(
        request, "422 Unprocessable Content", "image_validation_failed",
        "The complete image failed ESP structural and checksum validation.",
        validationResult, &attempt);
  }

  otaError = esp_ota_set_boot_partition(otaTargetPartition);
  if (otaError != ESP_OK) {
    return failOtaUpload(
        request, "500 Internal Server Error", "boot_selection_failed",
        "The image was written but could not be selected for the next boot.",
        otaError, &attempt);
  }

  otaBootPartitionSelected = true;
  updateFinished = true;
  static constexpr char response[] =
      "{\"ok\":true,\"message\":\"Image received and structurally verified. "
      "Restarting into the new firmware...\"}";
  httpd_resp_set_type(request, "application/json");
  httpd_resp_set_hdr(request, "Cache-Control", "no-store");
  const esp_err_t responseResult = httpd_resp_send(
      request, response, sizeof(response) - 1);

  // Boot selection is the commit point. Reboot is device-owned and scheduled
  // after the response attempt, even if the browser vanished meanwhile.
  portENTER_CRITICAL(&otaStateMux);
  otaRestartRequestedMs = millis();
  otaRestartPending = true;
  otaAdmissionState = OtaAdmissionState::COMMITTED;
  portEXIT_CRITICAL(&otaStateMux);
  return responseResult;
}

void serviceOtaRestart() {
  if (!otaRestartPending ||
      millis() - otaRestartRequestedMs < 750U) return;
  ESP.restart();
}

void setNetworkCommandResponse(sr800::network::CommandResponse& response,
                               int status, const char* body) {
  response.status = status;
  strlcpy(response.contentType, "application/json",
          sizeof(response.contentType));
  if (body == nullptr) body = "";
  response.bodyLength = std::min(strlen(body), sizeof(response.body) - 1);
  memcpy(response.body, body, response.bodyLength);
  response.body[response.bodyLength] = 0;
  response.stateRevision = currentStateRevision();
}

void handleCaptureClear() {
    if (otaReservesPort80()) {
      sendRequestResponse(409, "application/json",
                  "{\"ok\":false,\"message\":\"Capture cannot be reset while a firmware update is active.\"}");
      return;
    }
    if (actuator.outputsActive()) {
      sendRequestResponse(409, "application/json",
                  "{\"ok\":false,\"message\":\"Capture cannot be reset while outputs are active.\"}");
      return;
    }
    resetAndArmCapture();
    sendRequestResponse(200, "application/json", "{\"ok\":true,\"armed\":true}");
}

void handleCaptureFreeze() {
    freezeCapture();
    sendRequestResponse(200, "application/json", "{\"ok\":true,\"armed\":false}");
}

void handleFanTestStart() {
    if (rejectMutationDuringRestore()) return;
    if (manualConflictLatched) {
      sendRequestResponse(
          423, "application/json",
          "{\"ok\":false,\"message\":\"ESP actuation is disabled until the roaster is power-cycled.\"}");
      return;
    }
    if (!requestHasArg("confirm") ||
        requestArg("confirm") != "FOUR_DASHES") {
      sendRequestResponse(
          409, "application/json",
          "{\"ok\":false,\"message\":\"Four-dash confirmation is required.\"}");
      return;
    }
    const uint32_t durationMs =
        readUintArg("duration_ms", kFanTestDefaultMs, 250,
                    kFanTestMaximumMs);
    uint32_t levelMilli = 0;
    bool clampedToMinimum = false;
    if (!parseLevelArg("level", levelMilli, clampedToMinimum)) {
      sendRequestResponse(
          400, "application/json",
          "{\"ok\":false,\"message\":\"Level must be 0.0 or a decimal from 0.1 through 10.0.\"}");
      return;
    }
    if (levelMilli == 0) {
      stopDiagnosticTest();
      sendRequestResponse(
          200, "application/json",
          "{\"ok\":true,\"fan_test_active\":false,\"fan_test_level\":0.0}");
      return;
    }

    const char* rejection = nullptr;
    if (!startFanTest(durationMs, levelMilli, rejection)) {
      sendActuationStartRejection(rejection, "Fan test could not start.");
      return;
    }
    const sr800::ActuatorSnapshot state = actuator.snapshot(micros());
    String response =
        String(F("{\"ok\":true,\"fan_test_active\":true,\"fan_test_level\":")) +
        String(levelMilli / 1000.0f, 3) +
        F(",\"pulse_width_us\":") + state.pulseWidthUs +
        F(",\"start_delay_us\":") + state.fanStartDelayUs +
        F(",\"settled_delay_us\":") + state.fanSettledDelayUs +
        F(",\"clamped_to_minimum\":") +
        (clampedToMinimum ? F("true") : F("false")) + F("}");
    sendRequestResponse(202, "application/json", response);
}

void handleFanTestStop() {
    stopDiagnosticTest();
    sendRequestResponse(
        200, "application/json",
        "{\"ok\":true,\"fan_test_active\":false,\"heater_off\":true}");
}

void handleHeaterProofStart() {
    if (rejectMutationDuringRestore()) return;
    if (!requestHasArg("confirm") ||
        requestArg("confirm") != "FOUR_DASHES_HEAT_TEST") {
      sendRequestResponse(409, "application/json",
                  "{\"ok\":false,\"message\":\"Four-dash heat-test confirmation is required.\"}");
      return;
    }
    const bool temperatureHealthy = heatStartTemperatureHealthy(millis());
    if (!temperatureHealthy) {
      sendRequestResponse(409, "application/json",
                  "{\"ok\":false,\"message\":\"Fresh fault-free thermocouple telemetry is required for this diagnostic.\"}");
      return;
    }
    const uint32_t durationMs =
        readUintArg("duration_ms", kHeaterProofDefaultMs, 1000,
                    kHeaterProofDiagnosticMaximumMs);
    uint32_t fanLevelMilli = 0;
    uint32_t heatLevelMilli = 0;
    bool fanClamped = false;
    bool heatClamped = false;
    if (!parseLevelArg("fan_level", fanLevelMilli, fanClamped) ||
        !parseLevelArg("heat_level", heatLevelMilli, heatClamped)) {
      sendRequestResponse(
          400, "application/json",
          "{\"ok\":false,\"message\":\"Fan and heat levels must be decimals from 0.0 through 10.0.\"}");
      return;
    }
    if (heatLevelMilli == 0) {
      stopDiagnosticTest();
      sendRequestResponse(
          200, "application/json",
          "{\"ok\":true,\"heater_proof_phase\":\"idle\",\"heater_off\":true}");
      return;
    }
    // Heat on means Fan 1.0 or higher.
    fanLevelMilli = heatOnFanFloorMilli(fanLevelMilli, heatLevelMilli);
    const char* rejection = nullptr;
    if (!startHeaterProof(durationMs, fanLevelMilli, heatLevelMilli,
                          rejection)) {
      sendActuationStartRejection(rejection,
                                  "Heater proof could not start.");
      return;
    }
    String response =
        String(F("{\"ok\":true,\"heater_proof_phase\":\"fan_qualification\",\"requested_fan_level\":")) +
        String(fanLevelMilli / 1000.0f, 3) +
        F(",\"requested_heat_level\":") +
        String(heatLevelMilli / 1000.0f, 3) +
        F(",\"fan_lead_ms\":500,\"heat_duration_ms\":") +
        durationMs +
        F(",\"pulse_width_us\":100,\"fan_clamped_to_minimum\":") +
        (fanClamped ? F("true") : F("false")) +
        F(",\"heat_clamped_to_minimum\":") +
        (heatClamped ? F("true") : F("false")) + F("}");
    sendRequestResponse(202, "application/json", response);
}

void handleHeaterProofStop() {
    stopDiagnosticTest();
    sendRequestResponse(200, "application/json",
                "{\"ok\":true,\"heater_off\":true}");
}

void handleCalibrationStart() {
    if (rejectMutationDuringRestore()) return;
    if (manualConflictLatched) {
      sendRequestResponse(423, "application/json",
                  "{\"ok\":false,\"message\":\"ESP actuation is disabled until the roaster is power-cycled.\"}");
      return;
    }
    if (!requestHasArg("confirm") ||
        requestArg("confirm") != "FOUR_DASHES_CALIBRATION") {
      sendRequestResponse(409, "application/json",
                  "{\"ok\":false,\"message\":\"Four-dash calibration confirmation is required.\"}");
      return;
    }
    uint32_t fanLevels[kCalibrationMaxSteps] = {};
    uint32_t heatLevels[kCalibrationMaxSteps] = {};
    size_t stepCount = 0;
    if (requestHasArg("fans") && requestHasArg("heats")) {
      // Baseline air-temperature grid, serpentine order: for each fan (list
      // order; descending recommended), traverse the heat list ascending on
      // even groups and descending on odd ones, so each fan change happens at
      // the shared endpoint heat and no recovery cool-downs are needed. Every
      // transition is itself a measurement: heat steps at constant fan,
      // fan steps at constant heat, up-transitions in one group and
      // down-transitions in the next.
      uint32_t gridFans[kCalibrationMaxSteps] = {};
      uint32_t gridHeats[kCalibrationMaxSteps] = {};
      size_t fanCount = 0;
      size_t heatCount = 0;
      bool gridValid = parseHeatLevelsArg("fans", gridFans, fanCount) &&
                       parseHeatLevelsArg("heats", gridHeats, heatCount) &&
                       fanCount >= 1 && fanCount <= kCalibrationMaxGridFans &&
                       heatCount >= 1 && heatCount <= kCalibrationMaxGridHeats;
      for (size_t index = 0; gridValid && index < fanCount; ++index) {
        if (gridFans[index] == 0) gridValid = false;
      }
      for (size_t index = 0; gridValid && index < heatCount; ++index) {
        if (gridHeats[index] == 0) gridValid = false;
      }
      if (!gridValid) {
        sendRequestResponse(400, "application/json",
                    "{\"ok\":false,\"message\":\"Baseline grid needs fans (1-6 nonzero levels) and heats (1-7 nonzero levels).\"}");
        return;
      }
      for (size_t fanIndex = 0; fanIndex < fanCount; ++fanIndex) {
        const bool descending = (fanIndex % 2) == 1;
        for (size_t heatIndex = 0; heatIndex < heatCount; ++heatIndex) {
          const size_t pick = descending
              ? heatCount - 1 - heatIndex : heatIndex;
          fanLevels[stepCount] = gridFans[fanIndex];
          heatLevels[stepCount] = gridHeats[pick];
          stepCount++;
        }
      }
    } else if (requestHasArg("steps")) {
      if (!parseStepPairsArg("steps", fanLevels, heatLevels, stepCount)) {
        sendRequestResponse(400, "application/json",
                    "{\"ok\":false,\"message\":\"steps must be 1 to 12 comma-separated fan:heat pairs, levels 0.0 through 10.0, fan 0 only with heat 0.\"}");
        return;
      }
    } else {
      uint32_t fanLevelMilli = 0;
      bool fanClamped = false;
      if (!parseLevelArg("fan_level", fanLevelMilli, fanClamped) ||
          fanLevelMilli == 0) {
        sendRequestResponse(400, "application/json",
                    "{\"ok\":false,\"message\":\"Calibration requires steps=fan:heat,... or a fan level from 0.1 through 10.0.\"}");
        return;
      }
      if (!parseHeatLevelsArg("heat_levels", heatLevels, stepCount)) {
        sendRequestResponse(400, "application/json",
                    "{\"ok\":false,\"message\":\"heat_levels must be 1 to 12 comma-separated decimals from 0.0 through 10.0.\"}");
        return;
      }
      for (size_t index = 0; index < stepCount; ++index) {
        fanLevels[index] = fanLevelMilli;
      }
    }
    const uint32_t stepSeconds = readUintArg(
        "step_seconds", kCalibrationStepDefaultS, kCalibrationStepMinimumS,
        kCalibrationStepMaximumS);
    const uint32_t minDwellSeconds = readUintArg(
        "min_step_seconds", kCalibrationMinDwellDefaultS, 5, 120);
    const uint32_t settleSeconds = readUintArg(
        "settle_seconds", kCalibrationSettleSecondsDefault, 2,
        kCalibrationSettleSecondsMaximum);
    const uint32_t settleBandTenths = readUintArg(
        "settle_band_tenths_c",
        static_cast<uint32_t>(kCalibrationSettleBandDefaultC * 10.0f),
        2, 100);
    bool anyHeat = false;
    for (size_t index = 0; index < stepCount; ++index) {
      // Heat on means Fan 1.0 or higher, whichever
      // of the three authoring forms produced the pair.
      fanLevels[index] =
          heatOnFanFloorMilli(fanLevels[index], heatLevels[index]);
      if (heatLevels[index] > 0) anyHeat = true;
    }
    if (anyHeat) {
      const uint32_t readinessNowMs = millis();
      const bool calibrationReady =
          thermocoupleFreshValid(readinessNowMs, 1000U) &&
          !maxSensorFaultQualifier.qualified() &&
          calibrationReadiness.ready(readinessNowMs);
      if (!calibrationReady) {
        String response = F("{\"ok\":false,\"message\":\"Calibration requires a fresh, fault-free thermocouple reading.\",\"calibration_readiness\":\"");
        if (maxSensorFaultQualifier.qualified()) {
          response += F("sensor_fault_latched");
        } else {
          response += sr800::CalibrationReadiness::reasonName(
              calibrationReadiness.reason());
        }
        response += F("\",\"stable_for_ms\":");
        response += calibrationReadiness.stableForMs(readinessNowMs);
        response += F("}");
        sendRequestResponse(409, "application/json", response);
        return;
      }
    }
    const char* rejection = nullptr;
    if (!startCalibration(fanLevels, heatLevels, stepCount, stepSeconds,
                          minDwellSeconds,
                          static_cast<uint8_t>(settleSeconds),
                          settleBandTenths / 10.0f, rejection)) {
      sendActuationStartRejection(rejection,
                                  "Calibration could not start.");
      return;
    }
    String response =
        String(F("{\"ok\":true,\"calibration_active\":true,\"steps\":")) +
        stepCount +
        F(",\"max_step_seconds\":") + stepSeconds +
        F(",\"settle_seconds\":") + settleSeconds +
        F(",\"settle_band_c\":") + String(settleBandTenths / 10.0f, 1) +
        F(",\"thermal_log_interval_ms\":") + kThermalLogIntervalMs + F("}");
    sendRequestResponse(202, "application/json", response);
}

void handleCalibrationStop() {
    stopDiagnosticTest();
    sendRequestResponse(200, "application/json",
                "{\"ok\":true,\"calibration_active\":false,\"heater_off\":true}");
}

bool commandMayStartOrChangeActuation(const char* uri) {
  if (uri == nullptr) return false;
  return strcmp(uri, "/api/fan-test/start") == 0 ||
      strcmp(uri, "/api/heater-proof/start") == 0 ||
      strcmp(uri, "/api/calibration/start") == 0 ||
      strcmp(uri, "/api/manual/set") == 0 ||
      strcmp(uri, "/api/roast/start") == 0 ||
      strcmp(uri, "/api/roast/set") == 0 ||
      strcmp(uri, "/api/roast/active-plan") == 0;
}

void serviceNetworkCommandMailbox() {
  sr800::network::CommandSlot* slot =
      sr800::network::takeForController();
  if (slot == nullptr) return;
  const sr800::network::CommandRequest& command =
      sr800::network::request(slot);
  const char* form = command.formUrlEncoded
      ? reinterpret_cast<const char*>(command.body) : nullptr;
  const sr800::network::QueryArgs args(
      form == nullptr ? command.query : form,
      form == nullptr ? nullptr : command.query);
  // Static storage avoids placing the fixed 4 KiB response on loopTask's stack.
  static sr800::network::CommandResponse response;
  response = {};

  // Stop is the strongest user intent. A storage-busy start may have been
  // sleeping on a network worker or queued behind the reserved Stop slot. If
  // Stop was admitted after that command first entered the lane, reject it
  // before any controller handler or actuator side effect can run.
  if (command.method == sr800::network::CommandMethod::POST &&
      commandMayStartOrChangeActuation(command.uri) &&
      command.stopGeneration !=
          sr800::network::stopGenerationSnapshot()) {
    setNetworkCommandResponse(response, 409,
        R"json({"ok":false,"code":"start_cancelled_by_stop","message":"This pending control command was cancelled because Stop was requested."})json");
    lastNetworkCommandId = command.id;
    lastNetworkCommandStatus = static_cast<uint16_t>(response.status);
    sr800::network::completeFromController(slot, response);
    return;
  }

  const auto runControllerHandler = [&](void (*handler)()) {
    bindNativeCommandRequest(&command, &response);
    handler();
    releaseNativeCommandRequest();
    if (response.bodyLength == 0) {
      setNetworkCommandResponse(response, 500,
          R"json({"ok":false,"message":"The controller handler returned no response."})json");
    }
  };

  const auto finishStopped = [&](const char* workflow) {
    const bool recordingSaved = stopDiagnosticTest();
    const sr800::ActuatorSnapshot stopped = actuator.snapshot(micros());
    const int length = snprintf(
        response.body, sizeof(response.body),
        R"json({"ok":true,"workflow":"%s","request_id":%lu,"state_rev":%llu,"effective_fan":%.3f,"effective_heat":%.3f,"mode":"%s","fault":"%s","recording_saved":%s,"recording_pending":%s})json",
        workflow, static_cast<unsigned long>(command.id),
        static_cast<unsigned long long>(currentStateRevision()),
        stopped.effectiveFanMilli / 1000.0f,
        stopped.effectiveHeatMilli / 1000.0f,
        sr800::Actuator::modeName(stopped.mode),
        sr800::Actuator::faultName(stopped.fault),
        recordingSaved ? "true" : "false",
        recordingSaved ? "false" : "true");
    if (length <= 0 || static_cast<size_t>(length) >= sizeof(response.body)) {
      setNetworkCommandResponse(response, 500,
          R"json({"ok":false,"message":"Stop response overflow."})json");
      return;
    }
    response.status = 200;
    strlcpy(response.contentType, "application/json",
            sizeof(response.contentType));
    response.bodyLength = static_cast<size_t>(length);
    response.stateRevision = currentStateRevision();
  };

  if (command.method == sr800::network::CommandMethod::GET &&
      strcmp(command.uri, "/api/roast/active-plan") == 0) {
    runControllerHandler(handleRoastActivePlanGet);
  } else if (command.method != sr800::network::CommandMethod::POST) {
    setNetworkCommandResponse(response, 405,
        R"json({"ok":false,"message":"This route requires POST."})json");
  } else if (strcmp(command.uri, "/api/stop") == 0) {
    finishStopped("all");
  } else if (strcmp(command.uri, "/api/manual/stop") == 0) {
    finishStopped("manual");
  } else if (strcmp(command.uri, "/api/calibration/stop") == 0) {
    finishStopped("calibration");
  } else if (strcmp(command.uri, "/api/fan-test/stop") == 0) {
    finishStopped("fan_test");
  } else if (strcmp(command.uri, "/api/heater-proof/stop") == 0) {
    finishStopped("heater_proof");
  } else if (strcmp(command.uri, "/api/clear") == 0) {
    runControllerHandler(handleCaptureClear);
  } else if (strcmp(command.uri, "/api/freeze") == 0) {
    runControllerHandler(handleCaptureFreeze);
  } else if (strcmp(command.uri, "/api/fan-test/start") == 0) {
    runControllerHandler(handleFanTestStart);
  } else if (strcmp(command.uri, "/api/heater-proof/start") == 0) {
    runControllerHandler(handleHeaterProofStart);
  } else if (strcmp(command.uri, "/api/calibration/start") == 0) {
    runControllerHandler(handleCalibrationStart);
  } else if (strcmp(command.uri, "/api/manual/set") == 0) {
    refreshRestoreLease();
    if (restoreLease.active || restoreLease.incomplete) {
      setNetworkCommandResponse(response, 423,
          R"json({"ok":false,"message":"Restore maintenance is active or incomplete; only reads and Stop are available."})json");
    } else if (manualConflictLatched) {
      setNetworkCommandResponse(response, 423,
          R"json({"ok":false,"message":"ESP actuation is disabled until the roaster is power-cycled."})json");
    } else if (!args.equals("confirm", "MANUAL_CONTROL")) {
      setNetworkCommandResponse(response, 409,
          R"json({"ok":false,"message":"Manual-control confirmation is required."})json");
    } else if (fanTestActive ||
               heaterProofPhase != HeaterProofPhase::IDLE ||
               calibrationActive || roastActive) {
      setNetworkCommandResponse(response, 409,
          R"json({"ok":false,"message":"A test, calibration, or roast program is active."})json");
    } else {
      uint32_t fanMilli = 0;
      uint32_t heatMilli = 0;
      if (!args.levelMilli("fan", fanMilli) ||
          !args.levelMilli("heat", heatMilli)) {
        setNetworkCommandResponse(response, 400,
            R"json({"ok":false,"message":"fan and heat must be decimals from 0.0 through 10.0."})json");
      } else {
        if (fanMilli > 0 && fanMilli < kFanLevelMinimumMilli) {
          fanMilli = kFanLevelMinimumMilli;
        }
        if (heatMilli > 0 && heatMilli < kFanLevelMinimumMilli) {
          heatMilli = kFanLevelMinimumMilli;
        }
        // Heat on means Fan 1.0 or higher.
        fanMilli = heatOnFanFloorMilli(fanMilli, heatMilli);
        if (fanMilli == 0 && heatMilli == 0) {
          finishStopped("manual");
        } else {
          const bool temperatureHealthy =
              heatMilli == 0 || heatStartTemperatureHealthy(millis());
          if (!temperatureHealthy) {
            setNetworkCommandResponse(response, 409,
                R"json({"ok":false,"message":"Fresh fault-free thermocouple telemetry is required for heat."})json");
          } else {
            const bool wasActive = manualActive;
            StorageMutationGuard storage(!wasActive, !wasActive);
            // A new manual instruction takes over from the post-stop cooling
            // tail (the tail never blocks manual controls): with
            // the storage guard held, stand the tail down, then save the prior
            // recording synchronously while outputs are idle. Only a genuine
            // failure to save it refuses.
            const char* takeOverRejection = nullptr;
            bool tookOver = true;
            if (storage && !wasActive) {
              preemptPostStopCoolingTail(micros());
              tookOver = takeOverPriorRecordingForNewEpisode(takeOverRejection);
            }
            if (!storage) {
              setNetworkCommandResponse(response, 503,
                  R"json({"ok":false,"code":"storage_busy","message":"Controller storage is busy; retry this manual start after the current library request finishes."})json");
              response.retryStorageBusy = true;
            } else if (!tookOver) {
              char message[256] = {};
              snprintf(message, sizeof(message),
                  R"json({"ok":false,"message":"%s"})json",
                  takeOverRejection == nullptr
                      ? kPriorRecordingUnsavedRejection : takeOverRejection);
              setNetworkCommandResponse(response, 503, message);
            } else if (!wasActive && !enterActuationWifiAwakeMode()) {
              setNetworkCommandResponse(response, 409,
                  R"json({"ok":false,"message":"Wi-Fi awake mode could not be enabled."})json");
            } else {
              const char* rejection = nullptr;
              bool accepted = true;
              if (!wasActive) {
                accepted = waitForActuationStartTiming(rejection);
                if (!accepted) exitActuationWifiAwakeMode();
              }
              const uint32_t nowUs = micros();
              if (accepted) {
                accepted = actuator.request(
                    fanMilli, heatMilli, nowUs, rejection,
                    heatMilli > 0 ? kHeaterProofMaximumMs * 1000U : 0);
                if (!accepted && !wasActive) exitActuationWifiAwakeMode();
              }
              if (!accepted) {
                char message[240] = {};
                snprintf(message, sizeof(message),
                    R"json({"ok":false,"message":"%s"})json",
                    rejection == nullptr
                        ? "Manual request was rejected." : rejection);
                setNetworkCommandResponse(response, 409, message);
              } else {
                // The accepted instruction replaced any post-stop cooling
                // tail at the actuator; its deadline stands down with it.
                releasePostStopCoolingTail();
                manualActive = true;
                manualFanMilli = fanMilli;
                manualHeatMilli = heatMilli;
                manualSinceMs = millis();
                manualLastRenewUs = nowUs;
                manualLastInstructionMs = millis();
                manualEndReason = "none";
                const sr800::ActuatorSnapshot acceptedState =
                    actuator.snapshot(nowUs);
                manualHeatObserved = heatMilli == 0 ||
                    acceptedState.effectiveHeatMilli > 0;
                const int length = snprintf(
                    response.body, sizeof(response.body),
                    R"json({"ok":true,"request_id":%lu,"state_rev":%llu,"manual_active":true,"fan_level":%.3f,"heat_level":%.3f,"effective_fan":%.3f,"effective_heat":%.3f,"boot_id":%lu})json",
                    static_cast<unsigned long>(command.id),
                    static_cast<unsigned long long>(currentStateRevision()),
                    fanMilli / 1000.0f, heatMilli / 1000.0f,
                    acceptedState.effectiveFanMilli / 1000.0f,
                    acceptedState.effectiveHeatMilli / 1000.0f,
                    static_cast<unsigned long>(bootCount));
                if (length > 0 &&
                    static_cast<size_t>(length) < sizeof(response.body)) {
                  response.status = 202;
                  strlcpy(response.contentType, "application/json",
                          sizeof(response.contentType));
                  response.bodyLength = static_cast<size_t>(length);
                  response.stateRevision = currentStateRevision();
                } else {
                  setNetworkCommandResponse(response, 500,
                      R"json({"ok":false,"message":"Manual response overflow."})json");
                }
              }
            }
          }
        }
      }
    }
  } else if (strcmp(command.uri, "/api/roast/stop") == 0) {
    // A Stop NEVER refuses to stop. expected_session is advisory: a missing or
    // stale value (a second tab, a reload mid-roast) still ends the active
    // roast, and the mismatch is reported as session_mismatch so the client can
    // reconcile which session it actually stopped.
    const bool wasActive = roastActive;
    bool recordingSaved = true;
    uint32_t expectedSession = 0;
    const bool sessionSupplied = args.has("expected_session");
    const bool sessionMatches = sessionSupplied &&
        args.uint32("expected_session", expectedSession) &&
        expectedSession == roastSessionId;
    const bool sessionMismatch =
        (roastMode == RoastMode::MANUAL && wasActive && !sessionMatches) ||
        (sessionSupplied && !sessionMatches);
    {
      recordingSaved = wasActive
          ? finishRoast(micros(), "stopped")
          : finalizeEndedRoastRecordingForStop();
      if (wasActive) {
        // The post-stop cooling tail: Fan 10 / Heat 0 for 10 s.
        beginPostStopCoolingTail(micros());
      } else {
        // A repeated Stop during the tail means genuinely off, now.
        preemptPostStopCoolingTail(micros());
      }
      const sr800::ActuatorSnapshot stopped = actuator.snapshot(micros());
      const int length = snprintf(
          response.body, sizeof(response.body),
          R"json({"ok":true,"request_id":%lu,"state_rev":%llu,"roast_active":false,"was_active":%s,"session_id":%lu,"session_mismatch":%s,"elapsed_sec":%lu,"heater_off":%s,"effective_fan":%.3f,"effective_heat":%.3f,"end_reason":"%s","recording_saved":%s,"recording_pending":%s})json",
          static_cast<unsigned long>(command.id),
          static_cast<unsigned long long>(currentStateRevision()),
          wasActive ? "true" : "false",
          static_cast<unsigned long>(roastSessionId),
          sessionMismatch ? "true" : "false",
          static_cast<unsigned long>(roastElapsedSec),
          stopped.effectiveHeatMilli == 0 ? "true" : "false",
          stopped.effectiveFanMilli / 1000.0f,
          stopped.effectiveHeatMilli / 1000.0f,
          roastEndReason,
          recordingSaved ? "true" : "false",
          recordingSaved ? "false" : "true");
      if (length > 0 && static_cast<size_t>(length) < sizeof(response.body)) {
        response.status = 200;
        strlcpy(response.contentType, "application/json",
                sizeof(response.contentType));
        response.bodyLength = static_cast<size_t>(length);
        response.stateRevision = currentStateRevision();
      } else {
        setNetworkCommandResponse(response, 500,
            R"json({"ok":false,"message":"Roast stop response overflow."})json");
      }
    }
  } else if (strcmp(command.uri, "/api/roast/start") == 0) {
    runControllerHandler(handleRoastStart);
  } else if (strcmp(command.uri, "/api/roast/active-plan") == 0) {
    runControllerHandler(handleRoastActivePlanPatch);
  } else if (strcmp(command.uri, "/api/roast/set") == 0) {
    runControllerHandler(handleRoastSet);
  } else if (strcmp(command.uri, "/api/restore/begin") == 0) {
    runControllerHandler(handleRestoreBegin);
  } else if (strcmp(command.uri, "/api/restore/commit") == 0) {
    runControllerHandler(handleRestoreCommit);
  } else if (strcmp(command.uri, "/api/restore/abort") == 0) {
    runControllerHandler(handleRestoreAbort);
  } else if (strcmp(
                 command.uri,
                 "/api/settings/thermocouple-offset") == 0) {
    runControllerHandler(handleThermocoupleOffset);
  } else if (strcmp(command.uri, "/api/wifi") == 0) {
    runControllerHandler(handleWifiConfiguration);
  } else if (strcmp(command.uri, "/api/calibration/apply") == 0) {
    runControllerHandler(handleCalibrationApply);
  } else {
    setNetworkCommandResponse(response, 501,
        R"json({"ok":false,"message":"This command has not migrated to the native mailbox yet."})json");
  }
  // Status publishes the last completed request independently of its HTTP
  // acknowledgement. A client whose response was lost can reconcile exactly
  // once without repeating an already committed mutation.
  lastNetworkCommandId = command.id;
  lastNetworkCommandStatus = static_cast<uint16_t>(response.status);
  sr800::network::completeFromController(slot, response);
}

// Rollback protection only works while this image stays unvalidated. Validate
// once the image has proven it can serve HTTP or hold the station link.
void maybeValidateOtaImage() {
  if (otaImageValidated) return;

  bool healthy = copyOtaHealthResponseServed();
  if (!healthy && sr800::network::otaUptimeFallbackAllowed(
          WiFi.status() == WL_CONNECTED,
          sr800::network::httpServerRunning(),
          millis(),
          kOtaValidationUptimeMs)) {
    const sr800::PhaseSchedulerSnapshot schedulerState =
        phaseScheduler.snapshot();
    healthy = schedulerState.initialized && !schedulerState.faulted;
  }
  if (!healthy) return;

  // A failed flash-state update must remain pending and be retried. Setting the
  // local latch after a failure would silently defeat rollback protection.
  if (esp_ota_mark_app_valid_cancel_rollback() == ESP_OK) {
    otaImageValidated = true;
  }
}

}  // namespace

void readStoredCrashSummary() {
  storedCrash = {};
  if (esp_core_dump_image_check() != ESP_OK) return;
  static esp_core_dump_summary_t summary;
  memset(&summary, 0, sizeof(summary));
  if (esp_core_dump_get_summary(&summary) != ESP_OK) return;
  storedCrash.present = true;
  storedCrash.pc = summary.exc_pc;
  storedCrash.corrupted = summary.exc_bt_info.corrupted;
  const uint32_t depth = summary.exc_bt_info.depth;
  storedCrash.depth = static_cast<uint8_t>(depth > 16 ? 16 : depth);
  for (uint8_t index = 0; index < storedCrash.depth; ++index) {
    storedCrash.backtrace[index] = summary.exc_bt_info.bt[index];
  }
  // Task names and the ELF hash are ASCII, but a corrupt dump is not trusted: anything
  // that could break the JSON string is replaced.
  for (size_t index = 0; index < sizeof(storedCrash.task) - 1 && summary.exc_task[index]; ++index) {
    const char c = summary.exc_task[index];
    storedCrash.task[index] = (c >= 0x20 && c < 0x7f && c != '"' && c != '\\') ? c : '?';
  }
  for (size_t index = 0; index < sizeof(storedCrash.elfSha256) - 1 && summary.app_elf_sha256[index]; ++index) {
    const char c = static_cast<char>(summary.app_elf_sha256[index]);
    storedCrash.elfSha256[index] = ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) ? c : '?';
  }
  char running[65] = {};
  esp_app_get_elf_sha256(running, sizeof(running));
  const size_t compared = strlen(storedCrash.elfSha256);
  storedCrash.currentBuild = compared > 0 && strncmp(running, storedCrash.elfSha256, compared) == 0;
}

void setup() {
  actuator.begin();
  phaseScheduler.setZeroCrossHandler(onMcpwmZeroCross, nullptr);
  phaseScheduler.setZeroCrossDiscontinuityHandler(
      onMcpwmZeroCrossDiscontinuity, nullptr);
  if (!phaseScheduler.begin()) {
    actuator.latchPulseSchedulerFailure();
  } else {
    actuator.setPulseScheduler(
        sr800::McpwmPhaseScheduler::scheduleHook,
        sr800::McpwmPhaseScheduler::cancelHook,
        &phaseScheduler);
  }
  pinMode(static_cast<uint8_t>(kMaxCsPin), OUTPUT);
  gpio_set_level(kMaxCsPin, 1);

  Serial.begin(115200);
  delay(300);

  bootResetReason = esp_reset_reason();
  Preferences diagnostics;
  if (diagnostics.begin(kDiagnosticsNamespace, false)) {
    bootCount = diagnostics.getUInt("boots", 0) + 1;
    diagnostics.putUInt("boots", bootCount);
    // Prepend this boot to the persisted reset-reason ring (newest first).
    BootHistoryEntry stored[kBootHistoryCapacity] = {};
    const size_t storedBytes =
        diagnostics.getBytes("bh", stored, sizeof(stored));
    const size_t storedCount =
        std::min(storedBytes / sizeof(BootHistoryEntry), kBootHistoryCapacity - 1);
    bootHistory[0].bootId = bootCount;
    bootHistory[0].resetReason = static_cast<uint8_t>(bootResetReason);
    for (size_t index = 0; index < storedCount; ++index) {
      bootHistory[index + 1] = stored[index];
    }
    bootHistoryCount = static_cast<uint8_t>(storedCount + 1);
    diagnostics.putBytes("bh", bootHistory,
                         bootHistoryCount * sizeof(BootHistoryEntry));
    diagnostics.end();
  }
  readStoredCrashSummary();
  heap_caps_register_failed_alloc_callback(recordFailedAllocation);

  // The release requires the board's populated 2 MB PSRAM for recording and
  // native-network worker stacks. Missing PSRAM leaves the actuator loop safe
  // and retries network startup every 30 seconds, but recording, the web UI,
  // and network Stop remain unavailable; the physical Stop path is independent.
  // A recording allocation failure is still reported explicitly.
  thermalLog = static_cast<ThermalSample*>(heap_caps_calloc(
      kThermalLogCapacity, sizeof(ThermalSample),
      MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (thermalLog == nullptr) {
    Serial.println("FAULT: recording PSRAM unavailable; recording disabled");
  }
  loadRuntimeContract();
  mountLogArchive();
  loadAppliedCalibration();
  // SNTP stamps archived logs with wall-clock start times whenever the
  // station link is up; logs recorded before the first sync carry epoch 0.
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");

  temperature_sensor_config_t temperatureConfig =
      TEMPERATURE_SENSOR_CONFIG_DEFAULT(20, 100);
  esp_err_t temperatureResult =
      temperature_sensor_install(
          &temperatureConfig, &chipTemperatureSensor);
  if (temperatureResult == ESP_OK) {
    temperatureResult =
        temperature_sensor_enable(chipTemperatureSensor);
  }
  if (temperatureResult != ESP_OK) {
    if (chipTemperatureSensor != nullptr) {
      temperature_sensor_uninstall(chipTemperatureSensor);
      chipTemperatureSensor = nullptr;
    }
  }

  pinMode(static_cast<uint8_t>(kPins[2]), INPUT);
  pinMode(static_cast<uint8_t>(kPins[3]), INPUT);
  pinMode(static_cast<uint8_t>(kMaxFaultPin), INPUT_PULLUP);
  pinMode(static_cast<uint8_t>(kMaxDrdyPin), INPUT_PULLUP);
  SPI.begin(static_cast<int8_t>(kMaxSckPin),
            static_cast<int8_t>(kMaxMisoPin),
            static_cast<int8_t>(kMaxMosiPin),
            static_cast<int8_t>(kMaxCsPin));
  configureMax31856();

  // Credentials live in our Preferences namespace. Keep Arduino Wi-Fi from
  // making avoidable SDK credential writes while timing-sensitive code runs.
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.onEvent(onWiFiEvent);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);
  WiFi.setHostname(kHostName);
  connectToStoredNetwork();
  if (stationConfigured) {
    stationDisconnectedSinceMs = millis();
  } else {
    startRecoveryAccessPoint();
  }

  // Arduino's ESP.getSketchSize() calls esp_image_verify(), whose bootloader
  // mapping is process-global and cannot overlap esp_ota_end() validation.
  // Application size is immutable for this boot, so resolve it exactly once
  // before networking or concurrent status publication starts.
  cachedAppUsedBytes = ESP.getSketchSize();
  const esp_partition_t* runningPartition = esp_ota_get_running_partition();
  cachedAppSlotBytes =
      runningPartition == nullptr ? 0U : runningPartition->size;
  publishNetworkSnapshot(true);
  // One native service owns port 80, WebSocket subscriptions, bulk storage,
  // and raw OTA. Browser sockets never run inside loop().
  lastHttpServerStartAttemptMs = millis() - kHttpServerRetryIntervalMs;
  resetAndArmCapture();

  Serial.println();
  Serial.println("Crackle controller ready");
  Serial.println("GPIO3 Fan and GPIO4 Heat use synchronized hardware 100 us pulses.");
  Serial.println("GPIO5 monitors factory fan; GPIO6 is zero-cross.");
  Serial.println("MAX31856 SPI uses GPIO7 through GPIO12.");
  Serial.println("Never attach computer USB or serial while roaster mains is present.");
}

void loop() {
  const uint32_t loopEntryMs = millis();
  if (lastLoopEntryMs != 0) {
    lastLoopGapMs = loopEntryMs - lastLoopEntryMs;
    maximumLoopGapMs = std::max(maximumLoopGapMs, lastLoopGapMs);
  }
  lastLoopEntryMs = loopEntryMs;
  sampleMax31856();
  serviceThermalCaptureLifecycle(loopEntryMs);
  serviceNetworkCommandMailbox();
  serviceOtaRestart();
  serviceDiagnosticTests(micros());
  publishNetworkSnapshot();
  maintainStationConnection();
  const bool networkReady = WiFi.status() == WL_CONNECTED || apActive;
  if (networkReady &&
      !sr800::network::httpServerRunning() &&
      loopEntryMs - lastHttpServerStartAttemptMs >= kHttpServerRetryIntervalMs) {
    lastHttpServerStartAttemptMs = loopEntryMs;
    if (startCrackleHttpServer()) {
      Serial.println("Native HTTP service started");
    } else {
      Serial.printf("FAULT: native HTTP service retry failed: %s\n",
                    sr800::network::httpServerStartFailure());
    }
  }
  serviceOtaAdmission();
  // OTA metadata belongs to one task at a time. The raw uploader validates the
  // currently running image before esp_ota_begin; loop validation resumes only
  // after a denied or failed admission has been released.
  if (!otaReservesPort80()) maybeValidateOtaImage();
  delay(1);
}
