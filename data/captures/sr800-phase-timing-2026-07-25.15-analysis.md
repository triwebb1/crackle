# Firmware 2026-07-25.15 Fan 3.0 Timing Review

## Result

`REVIEW`; Heat testing was withheld.

- Records: 239
- Emitted: 239
- Missed: 0
- Log drops: 0
- Alarm failures: 0
- Late over 50 us: 43
- Mean lateness: 26.04 us
- p50: 4 us
- p95: 125 us
- p99: 128 us
- Maximum: 285 us
- Declared pulse widths other than 100 us: 0

## Interpretation

The run proved that firmware `.15` no longer omitted ordinary late commands, but it did not meet the timing-quality gate. Twenty-five records landed exactly 125 us late, with another two at 128 us and one at 285 us. That shelf is consistent with `gptimer_set_raw_count()` synchronization occurring after setup elapsed time had already been sampled: the timer reference itself moved while the alarm was being armed.

Firmware `.16` removes all per-edge counter resets. Both 1 MHz timers remain running, and each alarm is programmed as an absolute timer count corresponding to the original zero-cross-relative phase. Timer setup can consume lead time but cannot shift the requested deadline.

## Reproduction

Run:

```powershell
firmware/crackle/tools/analyze-timing.ps1 data/captures/sr800-phase-timing-2026-07-25.15.csv
```

Raw SHA-256: `6b12810e2a57756033b7edc0aeaf662bfd20cc170f077fc16688f8c0120e7451`.
