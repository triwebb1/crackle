# Firmware 2026-07-25.17 Fan 3.0 Timing Review

## Result

`REVIEW`; Heat testing remains withheld.

- Records: 360
- Emitted: 360
- Missed: 0
- Log drops: 0
- Alarm failures: 0
- Late over 50 us: 63
- Mean lateness: 24.29 us
- p50: 3 us
- p95: 125 us
- p99: 126 us
- Maximum: 247 us
- Declared pulse widths other than 100 us: 0
- Callbacks within 4 us: 285

## A/B Against Firmware .16

Keeping Wi-Fi fully awake during bounded actuation did not materially change the distribution:

| Metric | .16 | .17 |
|---|---:|---:|
| Records | 359 | 360 |
| Within 4 us | 288 | 285 |
| Over 50 us | 60 | 63 |
| p95 | 125 us | 125 us |
| p99 | 147 us | 126 us |
| Maximum | 348 us | 247 us |
| Adjacent late pairs | 25 | 24 |

The lower `.17` maximum is ordinary sample variation; the unchanged p95, late count, and burst structure reject Wi-Fi modem sleep as the cause. The repeated `124-126 us` shelf remains characteristic of callback dispatch being held behind another same-or-higher-priority interrupt or critical interval. GPTimer priority is already the highest level supported by the driver (`3`).

## Decision

The continuously running absolute-deadline GPTimer design is logically correct and never accumulates drift, but a callback-driven output edge cannot satisfy the project's deterministic timing gate on this Arduino/ESP-IDF runtime. Further tuning of Wi-Fi, MAX31856 sampling, or main-loop work cannot prove a hard bound against unrelated interrupt masking.

The next backend will use ESP32-S3 MCPWM hardware:

1. GPIO6 positive edges synchronize a 1 MHz MCPWM operator timer.
2. MCPWM capture hardware timestamps both GPIO6 polarities.
3. The capture callback computes comparator positions from the latched edge timestamp and loads Fan/Heat start/end compares while at least the minimum lead time remains.
4. MCPWM comparators, not an ISR callback, create each exact `100 us` GPIO3/GPIO4 pulse.
5. Additional MCPWM capture channels timestamp the generated outputs in hardware for acceptance evidence.
6. Any compare that cannot be loaded before a conservative lead-time guard is omitted safe-low and latches the scheduler fault; Heat remains unavailable in the first Fan-only proof.

## Reproduction

```powershell
firmware/crackle/tools/analyze-timing.ps1 data/captures/sr800-phase-timing-2026-07-25.17.csv
```

Raw SHA-256: `17c6eb1ead276078ff7c4c48e519ceea57194618c9ca0111748742c26d030c7a`.