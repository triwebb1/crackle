# Fan 8 Blinking Capture Analysis

## Observation

- Firmware: `2026-07-23.4`.
- Physical display: `893.0`, with Fan 8 selected and blinking.
- The Fan value changed from 9 to 8 before capture and took effect immediately.
- The roaster was not running, and the selected field continued blinking rather than timing out.
- Raw capture: `sr800-capture-fan8-blinking.csv`.
- Completion status: `sr800-capture-fan8-blinking.status.json`.
- Raw CSV SHA-256: `a2bdc85cb99f998454ac261c7713e5b2fdff6b6c53545a0d94c7ffdc7c862967`.

The CSV is preserved unchanged and contains 2,048 complete eight-clock groups. The capture stopped normally at `event_limit`.

## Timing And Quality

| Metric | Result |
| --- | ---: |
| Complete byte events | 2,048 |
| Captured clock edges before stop | 17,152 |
| Incomplete groups reported | 242 |
| Capture stop reason | `event_limit` |
| Capture span | 4.495020 s |
| Median complete-event interval | 2,016 us |
| Nominal digit-slot rate | 496.03 Hz |
| Nominal four-digit frame rate | 124.01 Hz |
| Long event intervals over 2,500 us | 87 |
| Estimated omitted digit slots | 184 |
| Rows where A differs from B | 13 / 2,048 (0.635%) |
| Rows where CLR is low | 0 |

Timing reconstruction advances phase by `round(delta_us / 2016)`. After rejecting A/B mismatches, the expected Fan-8 blink frame explains 1,975 of 2,035 rows exactly (97.052%). Another 53 rows are one bit away and seven are two bits away.

## Recovered Frame And Blink

| Digit phase | Meaning | Expected byte or envelope | Exact rows |
| ---: | --- | --- | ---: |
| 0 | Fan 8, selected | `0x80` alternating with `0xFF` | 494 / 512 |
| 1 | Power 9 | stable `0x90` | 492 / 509 |
| 2 | Timer `3.` | stable `0x30` | 498 / 508 |
| 3 | Timer `0` | stable `0xC0` | 491 / 506 |

Phase 0 contains 228 exact `0x80` samples and 266 exact `0xFF` samples. Only phase 0 has sustained blank intervals. This directly promotes the conventional active-low encoding for digit 8 (`0x80`) from inferred to observed.

The median transition-to-transition half-period is 0.491904 s. The full blink period is 0.983808 s, matching the prior Fan-9 selection capture.

## Corrected State Semantics

1. In the observed non-running state, selection blinking persists; inactivity does not automatically clear the selected field.
2. A changed value is effective immediately when its nonblank glyph changes. Fan 8 therefore remains the retained effective value throughout every `0xFF` blink-off interval.
3. The display decoder can publish `fan = 8`, `edit_selection = FAN`, and `blink_mask = 0b0001` simultaneously.
4. Selection-exit behavior must be characterized independently in non-running, Heating, and Cooling modes. A universal Edit inactivity timeout must not be assumed.
5. Power and Timer remain continuously decodable while Fan is selected.

## Next Captures

Without starting a roast, select Power without rotating it and capture its blink mask. Then separately select Timer without rotating it and capture its blink mask. These observations will map all three selection envelopes before any Heating or Cooling transition.