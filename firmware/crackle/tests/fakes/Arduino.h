#pragma once
#include <cstdint>
#include <climits>
#define IRAM_ATTR
#define OUTPUT 1
using portMUX_TYPE = int;
#define portMUX_INITIALIZER_UNLOCKED 0
#define portENTER_CRITICAL(x) ((void)0)
#define portEXIT_CRITICAL(x) ((void)0)
#define portENTER_CRITICAL_ISR(x) ((void)0)
#define portEXIT_CRITICAL_ISR(x) ((void)0)
#define portENTER_CRITICAL_SAFE(x) ((void)0)
#define portEXIT_CRITICAL_SAFE(x) ((void)0)
inline void pinMode(uint8_t, int) {}
inline uint32_t getCpuFrequencyMhz() { return 240; }