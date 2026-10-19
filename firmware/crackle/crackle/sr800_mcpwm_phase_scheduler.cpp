#include "sr800_mcpwm_phase_scheduler.h"

#include "hal/gpio_ll.h"
#include "hal/mcpwm_ll.h"
#include "hal/pcnt_ll.h"
#include "soc/gpio_struct.h"
#include "soc/mcpwm_struct.h"
#include "soc/pcnt_struct.h"
#include "soc/soc_caps.h"

namespace sr800 {
namespace {
constexpr int kMcpwmGroup = 0;
constexpr int kOutputTimerId = 0;
constexpr int kFanOperatorId = 0;
constexpr int kHeaterOperatorId = 1;
constexpr int kGeneratorId = 0;
constexpr int kStartComparatorId = 0;
constexpr int kEndComparatorId = 1;
constexpr int kZeroCrossSyncId = 0;
constexpr int kZeroCaptureChannelId = 2;
constexpr int kZeroCrossPcntUnitId = 0;
static_assert(SOC_MCPWM_OPERATORS_PER_GROUP >= 2,
              "Fan and Heater require two MCPWM operators");
static_assert(SOC_MCPWM_COMPARATORS_PER_OPERATOR >= 2,
              "Each output requires rise and fall comparators");
static_assert(SOC_MCPWM_CAPTURE_CHANNELS_PER_TIMER >= 3,
              "Each audit group requires Fan/Heater/zero-cross capture");
}  // namespace

McpwmPhaseScheduler::McpwmPhaseScheduler(
    gpio_num_t fanPin, gpio_num_t heaterPin, gpio_num_t zeroCrossPin)
    : fanPin_(fanPin), heaterPin_(heaterPin), zeroCrossPin_(zeroCrossPin) {}

void McpwmPhaseScheduler::setZeroCrossHandler(
    ZeroCrossHandler handler, void* context) {
  portENTER_CRITICAL(&mux_);
  zeroCrossHandler_ = handler;
  zeroCrossContext_ = context;
  portEXIT_CRITICAL(&mux_);
}

void McpwmPhaseScheduler::setZeroCrossDiscontinuityHandler(
    ZeroCrossDiscontinuityHandler handler, void* context) {
  portENTER_CRITICAL(&mux_);
  zeroCrossDiscontinuityHandler_ = handler;
  zeroCrossDiscontinuityContext_ = context;
  portEXIT_CRITICAL(&mux_);
}

bool McpwmPhaseScheduler::setupFailed() {
  setupFailures_++;
  faulted_ = true;
  forceOutputsLow();
  return false;
}

bool McpwmPhaseScheduler::setupZeroCrossFilter() {
  gpio_ll_pin_filter_enable(&GPIO, static_cast<uint32_t>(zeroCrossPin_));
  return true;
}

bool McpwmPhaseScheduler::setupOutputTimer() {
  mcpwm_timer_config_t timerConfig = {};
  timerConfig.group_id = kMcpwmGroup;
  timerConfig.clk_src = MCPWM_TIMER_CLK_SRC_DEFAULT;
  timerConfig.resolution_hz = kTimerResolutionHz;
  timerConfig.count_mode = MCPWM_TIMER_COUNT_MODE_UP;
  timerConfig.period_ticks = kTimerPeriodUs;
  timerConfig.intr_priority = 3;
  if (mcpwm_new_timer(&timerConfig, &outputTimer_) != ESP_OK) return false;

  mcpwm_operator_config_t operatorConfig = {};
  operatorConfig.group_id = kMcpwmGroup;
  operatorConfig.intr_priority = 3;
  if (mcpwm_new_operator(&operatorConfig, &fanOperator_) != ESP_OK ||
      mcpwm_operator_connect_timer(fanOperator_, outputTimer_) != ESP_OK ||
      mcpwm_new_operator(&operatorConfig, &heaterOperator_) != ESP_OK ||
      mcpwm_operator_connect_timer(heaterOperator_, outputTimer_) != ESP_OK) {
    return false;
  }

  mcpwm_comparator_config_t comparatorConfig = {};
  comparatorConfig.flags.update_cmp_on_sync = true;
  if (mcpwm_new_comparator(fanOperator_, &comparatorConfig,
                           &fanStartComparator_) != ESP_OK ||
      mcpwm_new_comparator(fanOperator_, &comparatorConfig,
                           &fanEndComparator_) != ESP_OK ||
      mcpwm_new_comparator(heaterOperator_, &comparatorConfig,
                           &heaterStartComparator_) != ESP_OK ||
      mcpwm_new_comparator(heaterOperator_, &comparatorConfig,
                           &heaterEndComparator_) != ESP_OK) {
    return false;
  }

  mcpwm_generator_config_t fanConfig = {};
  fanConfig.gen_gpio_num = fanPin_;
  fanConfig.flags.io_loop_back = true;
  fanConfig.flags.pull_down = true;
  mcpwm_generator_config_t heaterConfig = fanConfig;
  heaterConfig.gen_gpio_num = heaterPin_;
  if (mcpwm_new_generator(fanOperator_, &fanConfig,
                          &fanGenerator_) != ESP_OK ||
      mcpwm_new_generator(heaterOperator_, &heaterConfig,
                          &heaterGenerator_) != ESP_OK) {
    return false;
  }

  if (mcpwm_generator_set_action_on_compare_event(
          fanGenerator_, MCPWM_GEN_COMPARE_EVENT_ACTION(
              MCPWM_TIMER_DIRECTION_UP, fanStartComparator_,
              MCPWM_GEN_ACTION_HIGH)) != ESP_OK ||
      mcpwm_generator_set_action_on_compare_event(
          fanGenerator_, MCPWM_GEN_COMPARE_EVENT_ACTION(
              MCPWM_TIMER_DIRECTION_UP, fanEndComparator_,
              MCPWM_GEN_ACTION_LOW)) != ESP_OK ||
      mcpwm_generator_set_action_on_timer_event(
          fanGenerator_, MCPWM_GEN_TIMER_EVENT_ACTION(
              MCPWM_TIMER_DIRECTION_UP, MCPWM_TIMER_EVENT_FULL,
              MCPWM_GEN_ACTION_LOW)) != ESP_OK ||
      mcpwm_generator_set_action_on_compare_event(
          heaterGenerator_, MCPWM_GEN_COMPARE_EVENT_ACTION(
              MCPWM_TIMER_DIRECTION_UP, heaterStartComparator_,
              MCPWM_GEN_ACTION_HIGH)) != ESP_OK ||
      mcpwm_generator_set_action_on_compare_event(
          heaterGenerator_, MCPWM_GEN_COMPARE_EVENT_ACTION(
              MCPWM_TIMER_DIRECTION_UP, heaterEndComparator_,
              MCPWM_GEN_ACTION_LOW)) != ESP_OK ||
      mcpwm_generator_set_action_on_timer_event(
          heaterGenerator_, MCPWM_GEN_TIMER_EVENT_ACTION(
              MCPWM_TIMER_DIRECTION_UP, MCPWM_TIMER_EVENT_FULL,
              MCPWM_GEN_ACTION_LOW)) != ESP_OK) {
    return false;
  }

  mcpwm_gpio_sync_src_config_t syncConfig = {};
  syncConfig.group_id = kMcpwmGroup;
  syncConfig.gpio_num = zeroCrossPin_;
  syncConfig.flags.active_neg = gpio_get_level(zeroCrossPin_) != 0;
  syncConfig.flags.pull_down = true;
  if (mcpwm_new_gpio_sync_src(&syncConfig, &zeroCrossSync_) != ESP_OK) {
    return false;
  }
  mcpwm_timer_sync_phase_config_t phaseConfig = {};
  phaseConfig.sync_src = zeroCrossSync_;
  phaseConfig.count_value = 0;
  phaseConfig.direction = MCPWM_TIMER_DIRECTION_UP;
  if (mcpwm_timer_set_phase_on_sync(outputTimer_, &phaseConfig) != ESP_OK ||
      mcpwm_generator_set_action_on_sync_event(
          fanGenerator_, MCPWM_GEN_SYNC_EVENT_ACTION(
              MCPWM_TIMER_DIRECTION_UP, zeroCrossSync_,
              MCPWM_GEN_ACTION_LOW)) != ESP_OK ||
      mcpwm_generator_set_action_on_sync_event(
          heaterGenerator_, MCPWM_GEN_SYNC_EVENT_ACTION(
              MCPWM_TIMER_DIRECTION_UP, zeroCrossSync_,
              MCPWM_GEN_ACTION_LOW)) != ESP_OK ||
      mcpwm_comparator_set_compare_value(
          fanStartComparator_, kTimerPeriodUs - 100U) != ESP_OK ||
      mcpwm_comparator_set_compare_value(
          fanEndComparator_, kTimerPeriodUs - 1U) != ESP_OK ||
      mcpwm_comparator_set_compare_value(
          heaterStartComparator_, kTimerPeriodUs - 100U) != ESP_OK ||
      mcpwm_comparator_set_compare_value(
          heaterEndComparator_, kTimerPeriodUs - 1U) != ESP_OK ||
      mcpwm_generator_set_force_level(fanGenerator_, 0, true) != ESP_OK ||
      mcpwm_generator_set_force_level(heaterGenerator_, 0, true) != ESP_OK ||
      mcpwm_timer_enable(outputTimer_) != ESP_OK ||
      mcpwm_timer_start_stop(outputTimer_,
                             MCPWM_TIMER_START_STOP_FULL) != ESP_OK) {
    return false;
  }
  return true;
}

bool McpwmPhaseScheduler::setupZeroCrossCounter() {
  pcnt_unit_config_t unitConfig = {};
  unitConfig.low_limit = -32768;
  unitConfig.high_limit = 32767;
  if (pcnt_new_unit(&unitConfig, &zeroCrossCounter_) != ESP_OK) return false;
  pcnt_chan_config_t channelConfig = {};
  channelConfig.edge_gpio_num = zeroCrossPin_;
  channelConfig.level_gpio_num = -1;
  if (pcnt_new_channel(zeroCrossCounter_, &channelConfig,
                       &zeroCrossCounterChannel_) != ESP_OK ||
      pcnt_channel_set_edge_action(
          zeroCrossCounterChannel_, PCNT_CHANNEL_EDGE_ACTION_INCREASE,
          PCNT_CHANNEL_EDGE_ACTION_INCREASE) != ESP_OK ||
      pcnt_channel_set_level_action(
          zeroCrossCounterChannel_, PCNT_CHANNEL_LEVEL_ACTION_KEEP,
          PCNT_CHANNEL_LEVEL_ACTION_KEEP) != ESP_OK) {
    return false;
  }
  pcnt_glitch_filter_config_t filterConfig = {};
  filterConfig.max_glitch_ns = 1000;
  return pcnt_unit_set_glitch_filter(zeroCrossCounter_, &filterConfig) == ESP_OK &&
         pcnt_unit_enable(zeroCrossCounter_) == ESP_OK &&
         pcnt_unit_clear_count(zeroCrossCounter_) == ESP_OK &&
         pcnt_unit_start(zeroCrossCounter_) == ESP_OK;
}

bool McpwmPhaseScheduler::setupCaptureTimers() {
  mcpwm_capture_timer_config_t timerConfig = {};
  timerConfig.group_id = 0;
  timerConfig.clk_src = MCPWM_CAPTURE_CLK_SRC_DEFAULT;
  timerConfig.resolution_hz = kTimerResolutionHz;
  if (mcpwm_new_capture_timer(&timerConfig, &riseCaptureTimer_) != ESP_OK) {
    return false;
  }
  uint32_t riseResolutionHz = 0;
  if (mcpwm_capture_timer_get_resolution(
          riseCaptureTimer_, &riseResolutionHz) != ESP_OK ||
      riseResolutionHz < 1000000U ||
      riseResolutionHz % 1000000U != 0) {
    return false;
  }
  riseCaptureTicksPerUs_ = riseResolutionHz / 1000000U;
  mcpwm_capture_channel_config_t fanRiseConfig = {};
  fanRiseConfig.gpio_num = fanPin_;
  fanRiseConfig.intr_priority = 3;
  fanRiseConfig.prescale = 1;
  fanRiseConfig.flags.pos_edge = true;
  fanRiseConfig.flags.io_loop_back = true;
  fanRiseConfig.flags.pull_down = true;
  mcpwm_capture_channel_config_t heaterRiseConfig = fanRiseConfig;
  heaterRiseConfig.gpio_num = heaterPin_;
  mcpwm_capture_channel_config_t zeroConfig = {};
  zeroConfig.gpio_num = zeroCrossPin_;
  zeroConfig.intr_priority = 3;
  zeroConfig.prescale = 1;
  zeroConfig.flags.pos_edge = true;
  zeroConfig.flags.neg_edge = true;
  zeroConfig.flags.pull_down = true;
  if (mcpwm_new_capture_channel(riseCaptureTimer_, &fanRiseConfig,
                                &fanRiseCapture_) != ESP_OK ||
      mcpwm_new_capture_channel(riseCaptureTimer_, &heaterRiseConfig,
                                &heaterRiseCapture_) != ESP_OK ||
      mcpwm_new_capture_channel(riseCaptureTimer_, &zeroConfig,
                                &zeroCrossCapture_) != ESP_OK) {
    return false;
  }
  mcpwm_capture_event_callbacks_t fanRiseCallbacks = {};
  fanRiseCallbacks.on_cap = fanRiseCaptureCallback;
  mcpwm_capture_event_callbacks_t heaterRiseCallbacks = {};
  heaterRiseCallbacks.on_cap = heaterRiseCaptureCallback;
  mcpwm_capture_event_callbacks_t zeroCallbacks = {};
  zeroCallbacks.on_cap = zeroCrossCaptureCallback;
  if (mcpwm_capture_channel_register_event_callbacks(
          fanRiseCapture_, &fanRiseCallbacks, this) != ESP_OK ||
      mcpwm_capture_channel_register_event_callbacks(
          heaterRiseCapture_, &heaterRiseCallbacks, this) != ESP_OK ||
      mcpwm_capture_channel_register_event_callbacks(
          zeroCrossCapture_, &zeroCallbacks, this) != ESP_OK ||
      mcpwm_capture_timer_enable(riseCaptureTimer_) != ESP_OK ||
      mcpwm_capture_channel_enable(fanRiseCapture_) != ESP_OK ||
      mcpwm_capture_channel_enable(heaterRiseCapture_) != ESP_OK ||
      mcpwm_capture_channel_enable(zeroCrossCapture_) != ESP_OK ||
      mcpwm_capture_timer_start(riseCaptureTimer_) != ESP_OK) {
    return false;
  }

  timerConfig.group_id = 1;
  if (mcpwm_new_capture_timer(&timerConfig, &fallCaptureTimer_) != ESP_OK) {
    return false;
  }
  uint32_t fallResolutionHz = 0;
  if (mcpwm_capture_timer_get_resolution(
          fallCaptureTimer_, &fallResolutionHz) != ESP_OK ||
      fallResolutionHz < 1000000U ||
      fallResolutionHz % 1000000U != 0) {
    return false;
  }
  fallCaptureTicksPerUs_ = fallResolutionHz / 1000000U;
  mcpwm_capture_channel_config_t fanFallConfig = fanRiseConfig;
  fanFallConfig.flags.pos_edge = false;
  fanFallConfig.flags.neg_edge = true;
  mcpwm_capture_channel_config_t heaterFallConfig = fanFallConfig;
  heaterFallConfig.gpio_num = heaterPin_;
  if (mcpwm_new_capture_channel(fallCaptureTimer_, &fanFallConfig,
                                &fanFallCapture_) != ESP_OK ||
      mcpwm_new_capture_channel(fallCaptureTimer_, &heaterFallConfig,
                                &heaterFallCapture_) != ESP_OK ||
      mcpwm_new_capture_channel(fallCaptureTimer_, &zeroConfig,
                                &auditZeroCrossCapture_) != ESP_OK) {
    return false;
  }
  mcpwm_capture_event_callbacks_t fanFallCallbacks = {};
  fanFallCallbacks.on_cap = fanFallCaptureCallback;
  mcpwm_capture_event_callbacks_t heaterFallCallbacks = {};
  heaterFallCallbacks.on_cap = heaterFallCaptureCallback;
  if (mcpwm_capture_channel_register_event_callbacks(
          fanFallCapture_, &fanFallCallbacks, this) != ESP_OK ||
      mcpwm_capture_channel_register_event_callbacks(
          heaterFallCapture_, &heaterFallCallbacks, this) != ESP_OK ||
      mcpwm_capture_timer_enable(fallCaptureTimer_) != ESP_OK ||
      mcpwm_capture_channel_enable(fanFallCapture_) != ESP_OK ||
      mcpwm_capture_channel_enable(heaterFallCapture_) != ESP_OK ||
      mcpwm_capture_channel_enable(auditZeroCrossCapture_) != ESP_OK ||
      mcpwm_capture_timer_start(fallCaptureTimer_) != ESP_OK) {
    return false;
  }
  return true;
}

bool McpwmPhaseScheduler::begin() {
  pinMode(static_cast<uint8_t>(fanPin_), OUTPUT);
  pinMode(static_cast<uint8_t>(heaterPin_), OUTPUT);
  gpio_set_level(fanPin_, 0);
  gpio_set_level(heaterPin_, 0);
  if (!setupZeroCrossFilter() || !setupOutputTimer() ||
      !setupZeroCrossCounter() || !setupCaptureTimers()) {
    return setupFailed();
  }
  portENTER_CRITICAL(&mux_);
  initialized_ = true;
  portEXIT_CRITICAL(&mux_);
  return true;
}

bool McpwmPhaseScheduler::scheduleHook(
    void* context, const PhasePulsePlan& plan) {
  return static_cast<McpwmPhaseScheduler*>(context)->schedule(plan);
}
void McpwmPhaseScheduler::cancelHook(void* context) {
  static_cast<McpwmPhaseScheduler*>(context)->cancel();
}

bool McpwmPhaseScheduler::schedule(const PhasePulsePlan& plan) {
  const uint32_t fanEndUs = plan.fanDelayUs + plan.pulseWidthUs;
  const uint32_t heaterEndUs = plan.heaterDelayUs + plan.pulseWidthUs;
  portENTER_CRITICAL_ISR(&mux_);
  if (!initialized_ || faulted_ || !zeroCrossQualifier_.qualified() ||
      (!plan.fanEnabled && !plan.heaterEnabled) ||
      plan.pulseWidthUs == 0 ||
      (plan.fanEnabled && fanEndUs > kLatestSafePulseEndUs) ||
      (plan.heaterEnabled && heaterEndUs > kLatestSafePulseEndUs)) {
    forceOutputsLow();
    active_ = false;
    stagedPlanValid_ = false;
    invalidPlanRejects_++;
    missedPulseCount_++;
    faulted_ = true;
    portEXIT_CRITICAL_ISR(&mux_);
    return false;
  }
  if (plan.fanEnabled) {
    mcpwm_ll_operator_set_compare_value(&MCPWM0, kFanOperatorId,
                                        kStartComparatorId, plan.fanDelayUs);
    mcpwm_ll_operator_set_compare_value(&MCPWM0, kFanOperatorId,
                                        kEndComparatorId, fanEndUs);
  } else {
    forceFanLow();
  }
  if (plan.heaterEnabled) {
    mcpwm_ll_operator_set_compare_value(&MCPWM0, kHeaterOperatorId,
                                        kStartComparatorId, plan.heaterDelayUs);
    mcpwm_ll_operator_set_compare_value(&MCPWM0, kHeaterOperatorId,
                                        kEndComparatorId, heaterEndUs);
  } else {
    forceHeaterLow();
  }
  if (!active_ || (plan.fanEnabled && !activeFanEnabled_) ||
      (plan.heaterEnabled && !activeHeaterEnabled_)) {
    releaseOutputsOnNextSync_ = true;
  }
  stagedFanEnabled_ = plan.fanEnabled;
  stagedHeaterEnabled_ = plan.heaterEnabled;
  stagedFanDelayUs_ = static_cast<uint16_t>(plan.fanDelayUs);
  stagedHeaterDelayUs_ = static_cast<uint16_t>(plan.heaterDelayUs);
  stagedPlanValid_ = true;
  active_ = true;
  plansScheduled_++;
  portEXIT_CRITICAL_ISR(&mux_);
  return true;
}

void McpwmPhaseScheduler::cancel() {
  portENTER_CRITICAL_SAFE(&mux_);
  if (active_) plansCanceled_++;
  if (initialized_) forceOutputsLow();
  active_ = false;
  stagedPlanValid_ = false;
  releaseOutputsOnNextSync_ = false;
  stagedFanEnabled_ = false;
  stagedHeaterEnabled_ = false;
  activeFanEnabled_ = false;
  activeHeaterEnabled_ = false;
  if (timingLogEnabled_) {
    if (pendingFanRise_ || pendingFanFall_) fanAudit_.pairErrors++;
    if (pendingHeaterRise_ || pendingHeaterFall_) heaterAudit_.pairErrors++;
  }
  pendingFanRise_ = pendingFanFall_ = false;
  pendingHeaterRise_ = pendingHeaterFall_ = false;
  portEXIT_CRITICAL_SAFE(&mux_);
  gpio_set_level(fanPin_, 0);
  gpio_set_level(heaterPin_, 0);
}

void McpwmPhaseScheduler::forceFanLow() {
  if (fanGenerator_ != nullptr) {
    mcpwm_ll_gen_set_continue_force_level(
        &MCPWM0, kFanOperatorId, kGeneratorId, 0);
  }
}
void McpwmPhaseScheduler::forceHeaterLow() {
  if (heaterGenerator_ != nullptr) {
    mcpwm_ll_gen_set_continue_force_level(
        &MCPWM0, kHeaterOperatorId, kGeneratorId, 0);
  }
}
void McpwmPhaseScheduler::forceOutputsLow() {
  forceFanLow();
  forceHeaterLow();
  gpio_set_level(fanPin_, 0);
  gpio_set_level(heaterPin_, 0);
}
void McpwmPhaseScheduler::releaseCommittedOutputs() {
  if (activeFanEnabled_) {
    mcpwm_ll_gen_disable_continue_force_action(
        &MCPWM0, kFanOperatorId, kGeneratorId);
  } else {
    forceFanLow();
  }
  if (activeHeaterEnabled_) {
    mcpwm_ll_gen_disable_continue_force_action(
        &MCPWM0, kHeaterOperatorId, kGeneratorId);
  } else {
    forceHeaterLow();
  }
}
void McpwmPhaseScheduler::abortForZeroCrossDiscontinuity() {
  invalidZeroCrossCount_++;
  zeroCrossQualifier_.restartQualification();
  active_ = false;
  stagedPlanValid_ = false;
  releaseOutputsOnNextSync_ = false;
  stagedFanEnabled_ = false;
  stagedHeaterEnabled_ = false;
  activeFanEnabled_ = false;
  activeHeaterEnabled_ = false;
  forceOutputsLow();
}

bool McpwmPhaseScheduler::zeroCrossCaptureCallback(
    mcpwm_cap_channel_handle_t, const mcpwm_capture_event_data_t* eventData,
    void* context) {
  static_cast<McpwmPhaseScheduler*>(context)->handleZeroCross(
      eventData->cap_value, eventData->cap_edge);
  return false;
}
bool McpwmPhaseScheduler::fanRiseCaptureCallback(
    mcpwm_cap_channel_handle_t, const mcpwm_capture_event_data_t* eventData,
    void* context) {
  static_cast<McpwmPhaseScheduler*>(context)->handleFanRise(eventData->cap_value);
  return false;
}
bool McpwmPhaseScheduler::fanFallCaptureCallback(
    mcpwm_cap_channel_handle_t, const mcpwm_capture_event_data_t* eventData,
    void* context) {
  static_cast<McpwmPhaseScheduler*>(context)->handleFanFall(eventData->cap_value);
  return false;
}
bool McpwmPhaseScheduler::heaterRiseCaptureCallback(
    mcpwm_cap_channel_handle_t, const mcpwm_capture_event_data_t* eventData,
    void* context) {
  static_cast<McpwmPhaseScheduler*>(context)->handleHeaterRise(eventData->cap_value);
  return false;
}
bool McpwmPhaseScheduler::heaterFallCaptureCallback(
    mcpwm_cap_channel_handle_t, const mcpwm_capture_event_data_t* eventData,
    void* context) {
  static_cast<McpwmPhaseScheduler*>(context)->handleHeaterFall(eventData->cap_value);
  return false;
}

void McpwmPhaseScheduler::handleZeroCross(
    uint32_t captureValue, mcpwm_capture_edge_t edge) {
  ZeroCrossHandler handler = nullptr;
  void* context = nullptr;
  ZeroCrossDiscontinuityHandler discontinuityHandler = nullptr;
  void* discontinuityContext = nullptr;
  portENTER_CRITICAL_ISR(&mux_);
  // The edge to catch next is always the opposite of the level present now.
  // Arming from the level self-corrects when comparator chatter coalesces
  // callbacks and the reported edge polarity is a chatter edge, not the real
  // transition.
  mcpwm_ll_invert_gpio_sync_input(&MCPWM0, kZeroCrossSyncId,
                                  gpio_get_level(zeroCrossPin_) != 0);
  const uint16_t physicalEdgeCount = static_cast<uint16_t>(
      pcnt_ll_get_count(&PCNT, kZeroCrossPcntUnitId));
  const uint16_t physicalEdgeDelta = haveLastPhysicalEdgeCount_
      ? static_cast<uint16_t>(physicalEdgeCount - lastPhysicalEdgeCount_)
      : 0;
  lastPhysicalEdgeCount_ = physicalEdgeCount;
  haveLastPhysicalEdgeCount_ = true;
  const bool intervalAvailable = haveLastZeroCrossCapture_;
  const uint32_t intervalUs = intervalAvailable
      ? captureDeltaUs(captureValue, lastZeroCrossCaptureValue_,
                       riseCaptureTicksPerUs_)
      : 0;
  const bool actuationActive = active_ || stagedPlanValid_ ||
      activeFanEnabled_ || activeHeaterEnabled_;
  const ZeroCrossObservation observation = zeroCrossQualifier_.observe(
      intervalUs, intervalAvailable, actuationActive);
  if (observation == ZeroCrossObservation::IGNORED_GLITCH) {
    // Pure observation discard: chatter must not move the interval baseline,
    // so the next real edge still measures from the last non-ignored edge, and
    // it must not disturb the outputs or the committed plan.
    lastIgnoredGlitchPhysicalEdgeDelta_ = physicalEdgeDelta;
    portEXIT_CRITICAL_ISR(&mux_);
    return;
  }
  lastZeroCrossCaptureValue_ = captureValue;
  haveLastZeroCrossCapture_ = true;
  if (observation == ZeroCrossObservation::REJECTED_IDLE ||
      observation == ZeroCrossObservation::REJECTED_ACTIVE) {
    lastRejectedPhysicalEdgeDelta_ = physicalEdgeDelta;
  }
  bool accepted = observation == ZeroCrossObservation::ACCEPTED;
  uint16_t logicalAdvance = 1;
  if (observation == ZeroCrossObservation::REJECTED_ACTIVE) {
    const bool boundedLongGap = intervalUs > kMaximumZeroCrossIntervalUs &&
        intervalUs <= kMaximumCoastIntervalUs;
    if (boundedLongGap) {
      coastedZeroCrossCount_++;
      const uint32_t estimatedHalfCycles =
          (intervalUs + kNominalHalfCycleUs / 2U) / kNominalHalfCycleUs;
      logicalAdvance = static_cast<uint16_t>(
          estimatedHalfCycles > 0 ? estimatedHalfCycles : 1U);
      accepted = true;
    } else {
      abortForZeroCrossDiscontinuity();
      discontinuityHandler = zeroCrossDiscontinuityHandler_;
      discontinuityContext = zeroCrossDiscontinuityContext_;
      portEXIT_CRITICAL_ISR(&mux_);
      if (discontinuityHandler != nullptr) {
        discontinuityHandler(discontinuityContext, micros());
      }
      return;
    }
  }
  if (!accepted) {
    forceOutputsLow();
    portEXIT_CRITICAL_ISR(&mux_);
    return;
  }
  mcpwm_ll_timer_set_start_stop_command(&MCPWM0, kOutputTimerId,
                                        MCPWM_TIMER_START_STOP_FULL);
  previousZeroCaptureValue_ = activeZeroCaptureValue_;
  previousZeroCrossIndex_ = activeZeroCrossIndex_;
  previousZeroCrossEdge_ = activeZeroCrossEdge_;
  zeroCrossIndex_ = static_cast<uint16_t>(zeroCrossIndex_ + logicalAdvance);
  activeZeroCaptureValue_ = captureValue;
  activeZeroCrossIndex_ = zeroCrossIndex_;
  activeZeroCrossEdge_ = edge;
  if (stagedPlanValid_) {
    activeFanEnabled_ = stagedFanEnabled_;
    activeHeaterEnabled_ = stagedHeaterEnabled_;
    activeFanDelayUs_ = stagedFanDelayUs_;
    activeHeaterDelayUs_ = stagedHeaterDelayUs_;
    if (releaseOutputsOnNextSync_) {
      releaseCommittedOutputs();
      releaseOutputsOnNextSync_ = false;
    }
  }
  handler = zeroCrossHandler_;
  context = zeroCrossContext_;
  portEXIT_CRITICAL_ISR(&mux_);
  if (handler != nullptr) handler(context, micros());
}

void McpwmPhaseScheduler::handleFanRise(uint32_t captureValue) {
  const uint32_t zeroCapture = mcpwm_ll_capture_get_value(
      &MCPWM0, kZeroCaptureChannelId);
  const uint32_t actualDelay = captureDeltaUs(
      captureValue, zeroCapture, riseCaptureTicksPerUs_);
  portENTER_CRITICAL_ISR(&mux_);
  const uint16_t logicalIndex = activeZeroCrossIndex_;
  fanPulsesEmitted_++;
  if (!timingLogEnabled_) { portEXIT_CRITICAL_ISR(&mux_); return; }
  fanAudit_.captureRises++;
  if (pendingFanRise_) {
    fanAudit_.pairErrors++;
    pendingFanRise_ = pendingFanFall_ = false;
  }
  if (actualDelay > kLatestSafePulseEndUs) {
    fanAudit_.pairErrors++;
    portEXIT_CRITICAL_ISR(&mux_);
    return;
  }
  pendingFanRise_ = true;
  pendingFanRiseZeroCrossIndex_ = logicalIndex;
  pendingFanPlannedDelayUs_ = activeFanDelayUs_;
  pendingFanActualRiseDelayUs_ = static_cast<uint16_t>(actualDelay);
  tryCompleteCapturedPulse(false);
  portEXIT_CRITICAL_ISR(&mux_);
}
void McpwmPhaseScheduler::handleFanFall(uint32_t captureValue) {
  const uint32_t zeroCapture = mcpwm_ll_capture_get_value(
      &MCPWM1, kZeroCaptureChannelId);
  const uint32_t actualDelay = captureDeltaUs(
      captureValue, zeroCapture, fallCaptureTicksPerUs_);
  portENTER_CRITICAL_ISR(&mux_);
  const uint16_t logicalIndex = activeZeroCrossIndex_;
  if (!timingLogEnabled_) { portEXIT_CRITICAL_ISR(&mux_); return; }
  fanAudit_.captureFalls++;
  if (pendingFanFall_) {
    fanAudit_.pairErrors++;
    pendingFanRise_ = pendingFanFall_ = false;
  }
  if (actualDelay > kLatestSafePulseEndUs + 500U) {
    fanAudit_.pairErrors++;
    portEXIT_CRITICAL_ISR(&mux_);
    return;
  }
  pendingFanFall_ = true;
  pendingFanFallZeroCrossIndex_ = logicalIndex;
  pendingFanActualFallDelayUs_ = static_cast<uint16_t>(actualDelay);
  tryCompleteCapturedPulse(false);
  portEXIT_CRITICAL_ISR(&mux_);
}
void McpwmPhaseScheduler::handleHeaterRise(uint32_t captureValue) {
  const uint32_t zeroCapture = mcpwm_ll_capture_get_value(
      &MCPWM0, kZeroCaptureChannelId);
  const uint32_t actualDelay = captureDeltaUs(
      captureValue, zeroCapture, riseCaptureTicksPerUs_);
  portENTER_CRITICAL_ISR(&mux_);
  const uint16_t logicalIndex = activeZeroCrossIndex_;
  heaterPulsesEmitted_++;
  if (!timingLogEnabled_) { portEXIT_CRITICAL_ISR(&mux_); return; }
  heaterAudit_.captureRises++;
  if (pendingHeaterRise_) {
    heaterAudit_.pairErrors++;
    pendingHeaterRise_ = pendingHeaterFall_ = false;
  }
  if (actualDelay > kLatestSafePulseEndUs) {
    heaterAudit_.pairErrors++;
    portEXIT_CRITICAL_ISR(&mux_);
    return;
  }
  pendingHeaterRise_ = true;
  pendingHeaterRiseZeroCrossIndex_ = logicalIndex;
  pendingHeaterPlannedDelayUs_ = activeHeaterDelayUs_;
  pendingHeaterActualRiseDelayUs_ = static_cast<uint16_t>(actualDelay);
  tryCompleteCapturedPulse(true);
  portEXIT_CRITICAL_ISR(&mux_);
}
void McpwmPhaseScheduler::handleHeaterFall(uint32_t captureValue) {
  const uint32_t zeroCapture = mcpwm_ll_capture_get_value(
      &MCPWM1, kZeroCaptureChannelId);
  const uint32_t actualDelay = captureDeltaUs(
      captureValue, zeroCapture, fallCaptureTicksPerUs_);
  portENTER_CRITICAL_ISR(&mux_);
  const uint16_t logicalIndex = activeZeroCrossIndex_;
  if (!timingLogEnabled_) { portEXIT_CRITICAL_ISR(&mux_); return; }
  heaterAudit_.captureFalls++;
  if (pendingHeaterFall_) {
    heaterAudit_.pairErrors++;
    pendingHeaterRise_ = pendingHeaterFall_ = false;
  }
  if (actualDelay > kLatestSafePulseEndUs + 500U) {
    heaterAudit_.pairErrors++;
    portEXIT_CRITICAL_ISR(&mux_);
    return;
  }
  pendingHeaterFall_ = true;
  pendingHeaterFallZeroCrossIndex_ = logicalIndex;
  pendingHeaterActualFallDelayUs_ = static_cast<uint16_t>(actualDelay);
  tryCompleteCapturedPulse(true);
  portEXIT_CRITICAL_ISR(&mux_);
}

void McpwmPhaseScheduler::tryCompleteCapturedPulse(bool heater) {
  const bool risePending = heater ? pendingHeaterRise_ : pendingFanRise_;
  const bool fallPending = heater ? pendingHeaterFall_ : pendingFanFall_;
  if (!risePending || !fallPending) return;
  const uint16_t zeroIndex = heater ? pendingHeaterRiseZeroCrossIndex_
                                    : pendingFanRiseZeroCrossIndex_;
  const uint16_t fallIndex = heater ? pendingHeaterFallZeroCrossIndex_
                                    : pendingFanFallZeroCrossIndex_;
  const uint16_t plannedDelay = heater ? pendingHeaterPlannedDelayUs_
                                       : pendingFanPlannedDelayUs_;
  const uint16_t actualRiseDelay = heater ? pendingHeaterActualRiseDelayUs_
                                          : pendingFanActualRiseDelayUs_;
  const uint16_t actualFallDelay = heater ? pendingHeaterActualFallDelayUs_
                                          : pendingFanActualFallDelayUs_;
  AuditChannel& audit = heater ? heaterAudit_ : fanAudit_;
  if (heater) pendingHeaterRise_ = pendingHeaterFall_ = false;
  else pendingFanRise_ = pendingFanFall_ = false;
  if (fallIndex != zeroIndex || actualFallDelay <= actualRiseDelay) {
    audit.pairErrors++;
    return;
  }
  const uint32_t widthUs = actualFallDelay - actualRiseDelay;
  if (widthUs < 50U || widthUs > 500U) {
    audit.pairErrors++;
    return;
  }
  const uint32_t index = timingLogCount_;
  if (index >= kTimingLogCapacity) {
    timingLogDropped_++;
    return;
  }
  const uint32_t delayErrorUs = actualRiseDelay > plannedDelay
      ? actualRiseDelay - plannedDelay : plannedDelay - actualRiseDelay;
  const uint32_t widthErrorUs = widthUs > 100U ? widthUs - 100U : 100U - widthUs;
  const bool late = delayErrorUs > kTimingToleranceUs ||
                    widthErrorUs > kPulseWidthToleranceUs;
  PhaseTimingRecord& record = timingLog_[index];
  record.zeroCrossIndex = zeroIndex;
  record.plannedDelayUs = plannedDelay;
  record.actualDelayUs = actualRiseDelay;
  record.actualPulseWidthUs = static_cast<uint16_t>(widthUs);
  record.channelMask = heater ? 0x02 : 0x01;
  record.flags = PHASE_TIMING_EMITTED | (late ? PHASE_TIMING_LATE : 0);
  if (audit.records == 0) {
    audit.firstZeroCrossIndex = zeroIndex;
  } else {
    const uint16_t expected = static_cast<uint16_t>(audit.lastZeroCrossIndex + 1U);
    if (zeroIndex != expected) audit.indexErrors++;
  }
  audit.lastZeroCrossIndex = zeroIndex;
  audit.records++;
  timingLogCount_ = index + 1U;
  if (late) timingLogLate_++;
  const uint32_t maximumError = delayErrorUs > widthErrorUs
      ? delayErrorUs : widthErrorUs;
  if (maximumError > timingLogMaximumErrorUs_) {
    timingLogMaximumErrorUs_ = maximumError;
  }
}

void McpwmPhaseScheduler::beginTimingLog() {
  portENTER_CRITICAL(&mux_);
  timingLogEnabled_ = true;
  timingLogCount_ = timingLogDropped_ = timingLogLate_ = 0;
  timingLogMaximumErrorUs_ = 0;
  fanAudit_ = {};
  heaterAudit_ = {};
  logInvalidBaseline_ = invalidZeroCrossCount_;
  logCoastBaseline_ = coastedZeroCrossCount_;
  logIgnoredBaseline_ = zeroCrossQualifier_.ignoredGlitchCount();
  windowInvalid_ = windowCoasted_ = windowIgnored_ = 0;
  pcnt_ll_clear_count(&PCNT, kZeroCrossPcntUnitId);
  haveLastPhysicalEdgeCount_ = false;
  lastPhysicalEdgeCount_ = 0;
  pendingFanRise_ = pendingFanFall_ = false;
  pendingHeaterRise_ = pendingHeaterFall_ = false;
  portEXIT_CRITICAL(&mux_);
}
void McpwmPhaseScheduler::endTimingLog() {
  portENTER_CRITICAL(&mux_);
  if (timingLogEnabled_) {
    if (pendingFanRise_ || pendingFanFall_) fanAudit_.pairErrors++;
    if (pendingHeaterRise_ || pendingHeaterFall_) heaterAudit_.pairErrors++;
  }
  pendingFanRise_ = pendingFanFall_ = false;
  pendingHeaterRise_ = pendingHeaterFall_ = false;
  windowInvalid_ = invalidZeroCrossCount_ - logInvalidBaseline_;
  windowCoasted_ = coastedZeroCrossCount_ - logCoastBaseline_;
  windowIgnored_ =
      zeroCrossQualifier_.ignoredGlitchCount() - logIgnoredBaseline_;
  timingLogEnabled_ = false;
  portEXIT_CRITICAL(&mux_);
}
bool McpwmPhaseScheduler::copyTimingRecord(
    uint32_t sequence, PhaseTimingRecord& destination) const {
  if (sequence == 0 || sequence > kTimingLogCapacity) return false;
  portENTER_CRITICAL(&mux_);
  const bool valid = sequence <= timingLogCount_;
  if (valid) destination = timingLog_[sequence - 1U];
  portEXIT_CRITICAL(&mux_);
  return valid;
}

PhaseSchedulerSnapshot McpwmPhaseScheduler::snapshot() const {
  PhaseSchedulerSnapshot result = {};
  portENTER_CRITICAL(&mux_);
  result.initialized = initialized_;
  result.active = active_;
  result.faulted = faulted_;
  result.plansScheduled = plansScheduled_;
  result.plansCanceled = plansCanceled_;
  result.fanPulsesEmitted = fanPulsesEmitted_;
  result.heaterPulsesEmitted = heaterPulsesEmitted_;
  result.setupFailures = setupFailures_;
  result.invalidPlanRejects = invalidPlanRejects_;
  result.missedPulseCount = missedPulseCount_;
  result.invalidZeroCrossCount = invalidZeroCrossCount_;
  result.coastedZeroCrossCount = coastedZeroCrossCount_;
  result.ignoredZeroCrossGlitchCount =
      zeroCrossQualifier_.ignoredGlitchCount();
  result.zeroCrossQualified = zeroCrossQualifier_.qualified();
  result.zeroCrossConsecutiveValidIntervals =
      zeroCrossQualifier_.consecutiveValidIntervals();
  result.zeroCrossValidIntervalCount =
      zeroCrossQualifier_.validIntervalCount();
  result.zeroCrossIdleRejectedCount =
      zeroCrossQualifier_.idleRejectedCount();
  result.zeroCrossLastIntervalUs = zeroCrossQualifier_.lastIntervalUs();
  result.zeroCrossLastRejectedIntervalUs =
      zeroCrossQualifier_.lastRejectedIntervalUs();
  result.zeroCrossLastRejectedPhysicalEdgeDelta =
      lastRejectedPhysicalEdgeDelta_;
  result.zeroCrossLastRejectReason = static_cast<uint8_t>(
      zeroCrossQualifier_.lastRejectReason());
  result.zeroCrossLastIgnoredGlitchIntervalUs =
      zeroCrossQualifier_.lastIgnoredGlitchIntervalUs();
  result.zeroCrossLastIgnoredGlitchPhysicalEdgeDelta =
      lastIgnoredGlitchPhysicalEdgeDelta_;
  result.timingLogEnabled = timingLogEnabled_;
  result.timingLogRecords = timingLogCount_;
  result.timingLogDropped = timingLogDropped_;
  result.timingLogCapacity = kTimingLogCapacity;
  result.timingLogEmitted = timingLogCount_;
  result.timingLogLate = timingLogLate_;
  result.timingLogMaximumLatenessUs = timingLogMaximumErrorUs_;

  result.fanAuditRecords = fanAudit_.records;
  result.fanAuditCaptureRises = fanAudit_.captureRises;
  result.fanAuditCaptureFalls = fanAudit_.captureFalls;
  result.fanAuditPairErrors = fanAudit_.pairErrors;
  result.fanAuditIndexErrors = fanAudit_.indexErrors;
  result.fanAuditExpectedPulses = fanAudit_.records == 0 ? 0
      : static_cast<uint16_t>(fanAudit_.lastZeroCrossIndex -
                              fanAudit_.firstZeroCrossIndex) + 1U;
  result.fanAuditValid = !timingLogEnabled_ &&
      fanAudit_.records >= kMinimumAuditRecords &&
      result.fanAuditExpectedPulses == fanAudit_.records &&
      fanAudit_.captureRises == fanAudit_.records &&
      fanAudit_.captureFalls == fanAudit_.records &&
      fanAudit_.pairErrors == 0 && fanAudit_.indexErrors == 0 &&
      windowInvalid_ == 0 && windowCoasted_ == 0;

  result.heaterAuditRecords = heaterAudit_.records;
  result.heaterAuditCaptureRises = heaterAudit_.captureRises;
  result.heaterAuditCaptureFalls = heaterAudit_.captureFalls;
  result.heaterAuditPairErrors = heaterAudit_.pairErrors;
  result.heaterAuditIndexErrors = heaterAudit_.indexErrors;
  result.heaterAuditExpectedPulses = heaterAudit_.records == 0 ? 0
      : static_cast<uint16_t>(heaterAudit_.lastZeroCrossIndex -
                              heaterAudit_.firstZeroCrossIndex) + 1U;
  result.heaterAuditValid = !timingLogEnabled_ &&
      heaterAudit_.records >= kMinimumAuditRecords &&
      result.heaterAuditExpectedPulses == heaterAudit_.records &&
      heaterAudit_.captureRises == heaterAudit_.records &&
      heaterAudit_.captureFalls == heaterAudit_.records &&
      heaterAudit_.pairErrors == 0 && heaterAudit_.indexErrors == 0 &&
      windowInvalid_ == 0 && windowCoasted_ == 0;

  result.auditWindowInvalid = windowInvalid_;
  result.auditWindowCoasted = windowCoasted_;
  // Chatter is proven harmless to the emitted pulses, so it is informational
  // only and never fails an audit.
  result.auditWindowIgnored = windowIgnored_;

  result.auditCaptureRises = fanAudit_.captureRises + heaterAudit_.captureRises;
  result.auditCaptureFalls = fanAudit_.captureFalls + heaterAudit_.captureFalls;
  result.auditPairErrors = fanAudit_.pairErrors + heaterAudit_.pairErrors;
  result.auditIndexErrors = fanAudit_.indexErrors + heaterAudit_.indexErrors;
  result.auditExpectedPulses = result.fanAuditExpectedPulses +
                               result.heaterAuditExpectedPulses;
  result.timingLogMissed = missedPulseCount_ + result.auditPairErrors +
                           result.auditIndexErrors;
  result.auditValid = result.fanAuditValid &&
      (heaterAudit_.records == 0 || result.heaterAuditValid) &&
      timingLogDropped_ == 0 && timingLogLate_ == 0 &&
      missedPulseCount_ == 0;
  portEXIT_CRITICAL(&mux_);
  return result;
}
}  // namespace sr800