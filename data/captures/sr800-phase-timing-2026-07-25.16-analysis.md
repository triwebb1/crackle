# Firmware 2026-07-25.16 Fan 3.0 Timing Review

## Result

`REVIEW`; Heat testing remains withheld.

- Records: 359
- Emitted: 359
- Missed: 0
- Log drops: 0
- Alarm failures: 0
- Late over 50 us: 60
- Mean lateness: 24.01 us
- p50: 3 us
- p95: 125 us
- p99: 147 us
- Maximum: 348 us
- Declared pulse widths other than 100 us: 0

## Interpretation

The continuously running absolute-deadline scheduler fixed the `.15` timer-reference defect: 289 of 359 callbacks arrived within `4 us`, every command emitted, and no error accumulated between half-cycles. The remaining timing error is callback dispatch latency after the correct hardware alarm deadline.

Thirty-four records landed exactly `125 us` late, with isolated `325 us` and `348 us` interruptions. The bursts are consistent with a higher-priority or cache-disabled interval, and this Arduino/ESP-IDF build does not configure GPTimer callbacks as cache-safe. Firmware `.17` therefore performs one controlled A/B: Wi-Fi modem sleep is disabled only during bounded actuation, then restored after outputs and mandatory Cooling are idle. No phase mapping or actuator safety behavior changes.

The factory capture is not a license to ignore this result. Its timestamp logger observed settled Fan-9 phase spans of `132-142 us` and heater spans of `104-115 us`, but that passive software logger had its own interrupt latency and missed narrow pulses. The project keeps the stricter gate until the source of ESP callback latency is separated.

## Reproduction

```powershell
firmware/crackle/tools/analyze-timing.ps1 data/captures/sr800-phase-timing-2026-07-25.16.csv
```

Raw SHA-256: `caf6262779f694ee428a774ead552522ffa94eb2ab95e169c78426056d56de60`.
