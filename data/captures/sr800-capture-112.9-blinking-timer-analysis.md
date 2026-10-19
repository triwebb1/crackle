# 1-1-2.9 Timer Blink Capture Analysis

## Observation

- Physical display: Fan 1, Power 1, Timer `2.9`, with Timer selected and blinking.
- Raw capture: `sr800-capture-112.9-blinking-timer.csv`.
- Raw CSV SHA-256: `1fcf77be2267ae7a9b5101ef004afc78a631ac36b6d97c600f42c3821e4f84ed`.
- Matching `/api/status` was not supplied.

The CSV is preserved unchanged and contains 2,048 complete eight-clock groups.

## Timing And Quality

| Metric | Result |
| --- | ---: |
| Capture span | 4.568351 s |
| Median complete-event interval | 2,017 us |
| Long intervals over 2,500 us | 86 |
| Estimated omitted digit slots | 220 |
| Rows where A differs from B | 26 / 2,048 (1.270%) |
| Rows where CLR is low | 0 |
| Exact phase-aligned rows after mismatch rejection | 1,926 / 2,022 (95.252%) |

## Recovered Frame

| Phase | Meaning | Byte or envelope | Exact rows |
| ---: | --- | --- | ---: |
| 0 | Fan 1 | stable `0xF9` | 475 / 502 |
| 1 | Power 1 | stable `0xF9` | 480 / 507 |
| 2 | Timer whole digit `2.` | `0x24` alternating with `0xFF` | 480 / 506 |
| 3 | Timer tenths digit `9` | `0x90` alternating with `0xFF` | 491 / 507 |

Both Timer phases blank together at the established 0.491904 s half-period. This directly observes digit 1 as `0xF9` and digit 2 with decimal point as `0x24`. Plain digit 2 remains strongly inferred as `0xA4`.

## Decoder Consequences

- `2.9` confirms the fixed-point formula `whole + tenths / 10`.
- Timer Edit is identified by complete-field alternation between `[0x24, 0x90]` and `[0xFF, 0xFF]`.
- Fan and Power remain visible and independently decodable while Timer is selected.