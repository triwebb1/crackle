#pragma once

#include <Arduino.h>
#include "driver/gpio.h"
#include "driver/gpio_filter.h"
#include "driver/mcpwm_cap.h"
#include "driver/mcpwm_cmpr.h"
#include "driver/mcpwm_gen.h"
#include "driver/mcpwm_oper.h"
#include "driver/mcpwm_sync.h"
#include "driver/mcpwm_timer.h"
#include "driver/pulse_cnt.h"
#include "sr800_capture_time.h"
#include "sr800_phase_scheduler.h"
#include "sr800_zero_cross_qualifier.h"

namespace sr800 {

using ZeroCrossHandler = void (*)(void* context, uint32_t nowUs);
using ZeroCrossDiscontinuityHandler =
    void (*)(void* context, uint32_t nowUs);

class McpwmPhaseScheduler {
 public:
  McpwmPhaseScheduler(gpio_num_t fanPin, gpio_num_t heaterPin,
                         gpio_num_t zeroCrossPin);

  void setZeroCrossHandler(ZeroCrossHandler handler, void* context);
  void setZeroCrossDiscontinuityHandler(
      ZeroCrossDiscontinuityHandler handler, void* context);
  bool begin();
  bool IRAM_ATTR schedule(const PhasePulsePlan& plan);
  void IRAM_ATTR cancel();
  void beginTimingLog();
  void endTimingLog();
  bool copyTimingRecord(
      uint32_t sequence, PhaseTimingRecord& destination) const;
  PhaseSchedulerSnapshot snapshot() const;

  static bool IRAM_ATTR scheduleHook(
      void* context, const PhasePulsePlan& plan);
  static void IRAM_ATTR cancelHook(void* context);

 private:
  static bool IRAM_ATTR zeroCrossCaptureCallback(
      mcpwm_cap_channel_handle_t channel,
      const mcpwm_capture_event_data_t* eventData,
      void* context);
  static bool IRAM_ATTR fanRiseCaptureCallback(
      mcpwm_cap_channel_handle_t channel,
      const mcpwm_capture_event_data_t* eventData,
      void* context);
  static bool IRAM_ATTR fanFallCaptureCallback(
      mcpwm_cap_channel_handle_t channel,
      const mcpwm_capture_event_data_t* eventData,
      void* context);
  static bool IRAM_ATTR heaterRiseCaptureCallback(
      mcpwm_cap_channel_handle_t channel,
      const mcpwm_capture_event_data_t* eventData,
      void* context);
  static bool IRAM_ATTR heaterFallCaptureCallback(
      mcpwm_cap_channel_handle_t channel,
      const mcpwm_capture_event_data_t* eventData,
      void* context);

  void IRAM_ATTR handleZeroCross(
      uint32_t captureValue, mcpwm_capture_edge_t edge);
  void IRAM_ATTR handleFanRise(uint32_t captureValue);
  void IRAM_ATTR handleFanFall(uint32_t captureValue);
  void IRAM_ATTR handleHeaterRise(uint32_t captureValue);
  void IRAM_ATTR handleHeaterFall(uint32_t captureValue);
  void IRAM_ATTR tryCompleteCapturedPulse(bool heater);
  void IRAM_ATTR forceOutputsLow();
  void IRAM_ATTR forceFanLow();
  void IRAM_ATTR forceHeaterLow();
  void IRAM_ATTR releaseCommittedOutputs();
  void IRAM_ATTR abortForZeroCrossDiscontinuity();
  bool setupOutputTimer();
  bool setupCaptureTimers();
  bool setupZeroCrossCounter();
  bool setupZeroCrossFilter();
  bool setupFailed();

  static constexpr uint32_t kTimerResolutionHz = 1000000;
  static constexpr uint32_t kTimerPeriodUs = 12000;
  static constexpr uint32_t kLatestSafePulseEndUs = 6500;
  static constexpr uint32_t kTimingToleranceUs = 5;
  static constexpr uint32_t kPulseWidthToleranceUs = 1;
  static constexpr uint32_t kMinimumZeroCrossIntervalUs = 6000;
  static constexpr uint32_t kMaximumZeroCrossIntervalUs = 11000;
  static constexpr uint32_t kMaximumCoastIntervalUs = 100000;
  static constexpr uint32_t kNominalHalfCycleUs = 8333;
  static constexpr uint8_t kRequiredQualificationIntervals = 6;
  static constexpr uint32_t kMinimumAuditRecords = 300;
  // The timing log is the one large internal-SRAM object in the firmware (10 bytes
  // per record, ISR-written, so it cannot live in PSRAM). It is enabled only for the
  // bounded fan test (<= 3 s) and heater proof (<= kHeaterProofDiagnosticMaximumMs,
  // 15 s), which log at most two channels x 120 zero-crossings per second = 3,600
  // records. 4,000 keeps a margin above that. A 10,000-record (100 KB) log left the
  // Wi-Fi driver and HTTP server about 44 KB of internal heap, which a phone's page
  // load was measured draining to under 1 KB.
  static constexpr uint32_t kTimingLogCapacity = 4000;

  const gpio_num_t fanPin_;
  const gpio_num_t heaterPin_;
  const gpio_num_t zeroCrossPin_;
  mutable portMUX_TYPE mux_ = portMUX_INITIALIZER_UNLOCKED;

  mcpwm_timer_handle_t outputTimer_ = nullptr;
  mcpwm_oper_handle_t fanOperator_ = nullptr;
  mcpwm_oper_handle_t heaterOperator_ = nullptr;
  mcpwm_cmpr_handle_t fanStartComparator_ = nullptr;
  mcpwm_cmpr_handle_t fanEndComparator_ = nullptr;
  mcpwm_cmpr_handle_t heaterStartComparator_ = nullptr;
  mcpwm_cmpr_handle_t heaterEndComparator_ = nullptr;
  mcpwm_gen_handle_t fanGenerator_ = nullptr;
  mcpwm_gen_handle_t heaterGenerator_ = nullptr;
  mcpwm_sync_handle_t zeroCrossSync_ = nullptr;
  gpio_glitch_filter_handle_t zeroCrossGlitchFilter_ = nullptr;
  mcpwm_cap_timer_handle_t riseCaptureTimer_ = nullptr;
  mcpwm_cap_channel_handle_t zeroCrossCapture_ = nullptr;
  mcpwm_cap_channel_handle_t fanRiseCapture_ = nullptr;
  mcpwm_cap_channel_handle_t heaterRiseCapture_ = nullptr;
  mcpwm_cap_timer_handle_t fallCaptureTimer_ = nullptr;
  mcpwm_cap_channel_handle_t auditZeroCrossCapture_ = nullptr;
  mcpwm_cap_channel_handle_t fanFallCapture_ = nullptr;
  mcpwm_cap_channel_handle_t heaterFallCapture_ = nullptr;
  pcnt_unit_handle_t zeroCrossCounter_ = nullptr;
  pcnt_channel_handle_t zeroCrossCounterChannel_ = nullptr;

  ZeroCrossHandler zeroCrossHandler_ = nullptr;
  void* zeroCrossContext_ = nullptr;
  ZeroCrossDiscontinuityHandler zeroCrossDiscontinuityHandler_ = nullptr;
  void* zeroCrossDiscontinuityContext_ = nullptr;

  volatile bool initialized_ = false;
  volatile bool active_ = false;
  volatile bool faulted_ = false;
  volatile bool stagedPlanValid_ = false;
  volatile bool releaseOutputsOnNextSync_ = false;
  volatile bool stagedFanEnabled_ = false;
  volatile bool stagedHeaterEnabled_ = false;
  volatile bool activeFanEnabled_ = false;
  volatile bool activeHeaterEnabled_ = false;
  volatile uint16_t stagedFanDelayUs_ = 0;
  volatile uint16_t stagedHeaterDelayUs_ = 0;
  volatile uint16_t activeFanDelayUs_ = 0;
  volatile uint16_t activeHeaterDelayUs_ = 0;
  volatile uint16_t activeZeroCrossIndex_ = 0;
  volatile uint32_t activeZeroCaptureValue_ = 0;
  volatile mcpwm_capture_edge_t activeZeroCrossEdge_ = MCPWM_CAP_EDGE_POS;
  volatile uint16_t previousZeroCrossIndex_ = 0;
  volatile uint32_t previousZeroCaptureValue_ = 0;
  volatile mcpwm_capture_edge_t previousZeroCrossEdge_ = MCPWM_CAP_EDGE_NEG;
  volatile uint16_t zeroCrossIndex_ = 0;
  volatile uint32_t lastZeroCrossCaptureValue_ = 0;
  volatile bool haveLastZeroCrossCapture_ = false;
  volatile uint32_t invalidZeroCrossCount_ = 0;
  volatile uint32_t coastedZeroCrossCount_ = 0;
  volatile bool haveLastPhysicalEdgeCount_ = false;
  volatile uint16_t lastPhysicalEdgeCount_ = 0;
  volatile uint16_t lastRejectedPhysicalEdgeDelta_ = 0;
  volatile uint16_t lastIgnoredGlitchPhysicalEdgeDelta_ = 0;
  ZeroCrossQualifier zeroCrossQualifier_{
      kMinimumZeroCrossIntervalUs, kMaximumZeroCrossIntervalUs,
      kRequiredQualificationIntervals};
  uint32_t riseCaptureTicksPerUs_ = 0;
  uint32_t fallCaptureTicksPerUs_ = 0;

  volatile bool pendingFanRise_ = false;
  volatile bool pendingFanFall_ = false;
  volatile uint16_t pendingFanRiseZeroCrossIndex_ = 0;
  volatile uint16_t pendingFanFallZeroCrossIndex_ = 0;
  volatile uint16_t pendingFanPlannedDelayUs_ = 0;
  volatile uint16_t pendingFanActualRiseDelayUs_ = 0;
  volatile uint16_t pendingFanActualFallDelayUs_ = 0;
  volatile bool pendingHeaterRise_ = false;
  volatile bool pendingHeaterFall_ = false;
  volatile uint16_t pendingHeaterRiseZeroCrossIndex_ = 0;
  volatile uint16_t pendingHeaterFallZeroCrossIndex_ = 0;
  volatile uint16_t pendingHeaterPlannedDelayUs_ = 0;
  volatile uint16_t pendingHeaterActualRiseDelayUs_ = 0;
  volatile uint16_t pendingHeaterActualFallDelayUs_ = 0;

  struct AuditChannel {
    volatile uint32_t records = 0;
    volatile uint32_t captureRises = 0;
    volatile uint32_t captureFalls = 0;
    volatile uint32_t pairErrors = 0;
    volatile uint32_t indexErrors = 0;
    volatile uint16_t firstZeroCrossIndex = 0;
    volatile uint16_t lastZeroCrossIndex = 0;
  };
  AuditChannel fanAudit_;
  AuditChannel heaterAudit_;

  volatile uint32_t plansScheduled_ = 0;
  volatile uint32_t plansCanceled_ = 0;
  volatile uint32_t fanPulsesEmitted_ = 0;
  volatile uint32_t heaterPulsesEmitted_ = 0;
  volatile uint32_t setupFailures_ = 0;
  volatile uint32_t invalidPlanRejects_ = 0;
  volatile uint32_t missedPulseCount_ = 0;

  uint32_t logInvalidBaseline_ = 0;
  uint32_t logCoastBaseline_ = 0;
  uint32_t logIgnoredBaseline_ = 0;
  uint32_t windowInvalid_ = 0;
  uint32_t windowCoasted_ = 0;
  uint32_t windowIgnored_ = 0;

  PhaseTimingRecord timingLog_[kTimingLogCapacity] = {};
  volatile bool timingLogEnabled_ = false;
  volatile uint32_t timingLogCount_ = 0;
  volatile uint32_t timingLogDropped_ = 0;
  volatile uint32_t timingLogLate_ = 0;
  volatile uint32_t timingLogMaximumErrorUs_ = 0;
};

}  // namespace sr800
