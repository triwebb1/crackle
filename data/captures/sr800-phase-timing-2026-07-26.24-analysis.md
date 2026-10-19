# Firmware .24 Fan 3.0 Dual-Output MCPWM Audit

## Result

**PASS.** The three-second Fan `3.0` proof produced 359 independently captured physical pulses. Planned records, GPIO3 rises, GPIO3 falls, completed records, and the PCNT-derived expected count all equal 359. There are no sequence gaps, pair errors, index errors, misses, drops, invalid delays, Heater records, or scheduler faults.

The independent analyzer reports phase p99 absolute error of `1 us`. Every pulse is exactly `100 us` wide. Actual minus planned phase is `-1..0 us`. This satisfies the `+/-5 us` phase and `99..101 us` width gates with substantial margin.

## Startup Qualification

The boot observed one shortened idle interval while capture hardware settled. Firmware `.24` counted it in `zero_cross_idle_rejected_count=1`, held both outputs low, then qualified after six consecutive alternating in-range intervals. Before the proof, the stream was qualified with 967 valid intervals and a 7,904 us latest interval. Afterward it remained qualified with 3,554 valid intervals, zero active invalid intervals, and no actuator fault.

## Interpretation

This is the accepted Fan hardware waveform proof for the single-timer, dual-operator MCPWM backend. It establishes deterministic 100 us Fan trigger delivery under the active Wi-Fi and MAX31856 workload. It does not yet prove the GPIO4 Heater channel; the next required evidence is the armed Fan `3.0`, Heat `0.1`, 10-second run including automatic Cooling.

## Evidence

- Raw SHA-256: `f8bd52aef25c8b7701ed588fccd159357a2aeca9f274da75bc613fd297824b0f`
- Records/emitted/expected/rises/falls: `359/359/359/359/359`
- Phase error: `-1..0 us`; p99 absolute `1 us`
- Pulse width: `100..100 us`
- Pair/index/sequence/missed/drop errors: all `0`
- Heater pulses: `0`
- Analyzer result: `MCPWM waveform quality: PASS`