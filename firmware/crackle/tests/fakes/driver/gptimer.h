#pragma once
#include <cstdint>
#include "esp_err.h"

enum gptimer_clock_source_t { GPTIMER_CLK_SRC_DEFAULT };
enum gptimer_count_direction_t { GPTIMER_COUNT_UP };

struct gptimer_t;
using gptimer_handle_t = gptimer_t*;

struct gptimer_alarm_event_data_t {
  uint64_t count_value;
  uint64_t alarm_value;
};

using gptimer_alarm_cb_t = bool (*)(
    gptimer_handle_t timer,
    const gptimer_alarm_event_data_t* eventData,
    void* context);

struct gptimer_event_callbacks_t {
  gptimer_alarm_cb_t on_alarm;
};

struct gptimer_config_t {
  gptimer_clock_source_t clk_src;
  gptimer_count_direction_t direction;
  uint32_t resolution_hz;
  int intr_priority;
};

struct gptimer_alarm_config_t {
  uint64_t alarm_count;
  uint64_t reload_count;
  struct {
    uint32_t auto_reload_on_alarm : 1;
  } flags;
};

esp_err_t gptimer_new_timer(
    const gptimer_config_t* config,
    gptimer_handle_t* timer);
esp_err_t gptimer_register_event_callbacks(
    gptimer_handle_t timer,
    const gptimer_event_callbacks_t* callbacks,
    void* context);
esp_err_t gptimer_enable(gptimer_handle_t timer);
esp_err_t gptimer_start(gptimer_handle_t timer);
esp_err_t gptimer_set_raw_count(
    gptimer_handle_t timer, uint64_t value);
esp_err_t gptimer_get_raw_count(
    gptimer_handle_t timer, uint64_t* value);
esp_err_t gptimer_set_alarm_action(
    gptimer_handle_t timer,
    const gptimer_alarm_config_t* config);