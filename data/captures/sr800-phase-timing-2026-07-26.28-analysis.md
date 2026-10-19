# Fan 10.0 Continuity Proof — Firmware 2026-07-26.28

Status: **PASS**. First fully clean Fan 10.0 proof since the chatter investigation began, and the validating evidence for the `.28` chatter-tolerant observation policy.

## Run

Four consecutive 3-second Fan `10.0` proofs on firmware `2026-07-26.28` (boot 339). Operator reported continuous fan sound with no dips or blips on every run. Both downloaded CSVs (runs 1 and 4) pass the analyzer identically; across the whole boot: 1,434 pulses emitted, 6 chatter events ignored harmlessly, `invalid_zero_cross_count=0`, `coasted_zero_cross_count=0`, zero idle rejects, 14,374 valid intervals.

## Analyzer result

`firmware/crackle/tools/analyze-mcpwm-timing.ps1`: waveform quality PASS. 359 records, 359 emitted, 0 missed, 0 sequence gaps, 0 index gaps, phase p99 absolute error `0 us`, every width exactly `100 us`.

## Status evidence

- `fan_audit`: records 359 = expected 359, rises 359, falls 359, pair errors 0, index errors 0, `valid=true`.
- `audit_window_invalid=0`, `audit_window_coasted=0`, `audit_window_ignored=2`.
- The two ignored events are the chatter signature exactly as diagnosed: last ignored interval `7 us` with physical edge delta `2` — a real electrical edge pair at a zero-cross transition, counted by PCNT, discarded by the observer, costing nothing.
- `invalid_zero_cross_count=0` and `zero_cross_idle_rejected_count=0` for the entire boot; `missed=0`, `dropped=0`, `late=0`, maximum lateness `2 us`.
- GPIO6 channel diagnostics: maximum low interval `7937 us`, maximum high `8785 us` — no observation gaps at all, versus 39–75 ms maxima on every `.26`/`.27` run.

## Interpretation

The `.26`/`.27` fan blips were dropout-and-recovery events caused by comparator chatter poisoning edge-polarity bookkeeping in the software observer, never by output timing (all prior runs also showed 0–1 us pulse error). `.28` removed polarity as a validity signal, classifies observations by hardware-timestamped interval plus PCNT delta only, discards sub-6 ms chatter without touching outputs or qualification, and arms sync polarity from the pin level. This run shows chatter occurring (twice) and being absorbed with zero effect on output continuity.

## Gate consequence

The clean-run gate for arming Heat on `.28` is satisfied. Next step per the `.28` release README: low-Heat proof (Fan `3.0`, Heat `0.1`, 10 s) with fresh thermocouple telemetry, then examine `heater_audit` and the dual-channel timing CSV.

## Low-Heat Proof Result (same boot, later)

Fan `3.0` / Heat `0.1` for 10 s, full automatic Cooling, return to idle. Operator observed working heat with no noise or flicker; the audible Fan slowdown at Cooling start is the designed peak-heat-scaled cooling floor (Fan `3.0` drops to the `0.1` floor for about 2 s after a Heat `0.1` peak).

- `heater_audit`: 1,198/1,198 records, zero pair/index errors, `valid=true`. First hardware-audited Heater run, flawless.
- Both channels: every pulse exactly `100 us`, p99 phase error `1 us`; `audit_window_invalid=0`, `audit_window_coasted=0`, `audit_window_ignored=0`.
- `fan_audit`: 1,497/1,498, exactly one index gap at index 24304 — the first half-cycle after the last Heater record (24303). Diagnosed as the diagnostic loop's Heat deadline racing the ISR deadline and full-canceling the plan; fixed in `2026-07-26.29`, which demotes the loop deadline to a 500 ms-overdue backstop. From `.29` on, Heat proofs must show both audits valid with zero gaps.
