# Firmware .18 Fan 3.0 MCPWM Audit Review

## Result

**FAIL: no waveform records were captured.**

The installed three-second Fan `3.0` test completed without an actuator fault and status reported `359` Fan rising-edge captures, zero Heater pulses, zero missed pulses, zero setup failures, and a steady idle return. However, `/timing.csv` is 108 bytes and contains only the column header. Status likewise reports `timing_log.records=0` and `timing_log.emitted=0`.

## Interpretation

Firmware `.18` used separate MCPWM capture channels for GPIO3 rising and falling edges. The rising path ran, because `fan_pulses_emitted` is incremented only by the GPIO3 rise capture callback. No rise/fall pair reached the record path. Consequently, this run cannot establish actual phase delay, pulse width, or one-pulse-per-zero-cross behavior.

This is an instrumentation failure, not evidence that the hardware comparator output failed: the operator observed the Fan run and the scheduler returned idle without a fault. It is also not acceptable proof of waveform quality.

## Resolution

Firmware `.19` keeps Heat hard-disabled and replaces the two GPIO3 edge channels with one capture channel configured for both edges. It adds per-run `audit_capture_rises`, `audit_capture_falls`, and `audit_pair_errors` counters. Acceptance requires matched rise/fall/record counts, zero pair errors, a populated CSV, consecutive zero-cross indices, phase error within `+/-5 us`, and pulse width `99..101 us`.

## Evidence

- Raw SHA-256: `9f76a5920a39e768b00ffe6b91e6a9f34613e9115b4fd40fc01a946555764580`
- CSV rows: `0` data records
- Status Fan captures: `359`
- Status Heater pulses: `0`
- Status timing records: `0`
- Analyzer result: `Hardware timing CSV contains no pulse records.`