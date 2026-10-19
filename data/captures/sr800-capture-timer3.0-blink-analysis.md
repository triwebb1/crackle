# Timer 3.0 Blink Capture Analysis

## Observation

- Firmware: `2026-07-23.4`.
- Physical display: `893.0`, with Timer `3.0` selected and blinking.
- Timer is one fixed-point `X.X` minute value, not two independent settings.
- Raw capture: `sr800-capture-timer3.0-blink.csv`.
- Completion status: `sr800-capture-timer3.0-blink.status.json`.
- Raw CSV SHA-256: `d5bda7f166acf0972edd0f9d5d07e0a8b2478b99f6e950f9f5a058ac1b614675`.

The CSV is preserved unchanged and contains 2,048 complete eight-clock groups. The capture stopped normally at `event_limit`.

## Timing And Quality

| Metric | Result |
| --- | ---: |
| Complete byte events | 2,048 |
| Captured clock edges before stop | 17,292 |
| Incomplete groups reported | 315 |
| Capture stop reason | `event_limit` |
| Capture span | 4.587670 s |
| Median complete-event interval | 2,016 us |
| Long event intervals over 2,500 us | 87 |
| Estimated omitted digit slots | 230 |
| Rows where A differs from B | 15 / 2,048 (0.732%) |
| Rows where CLR is low | 0 |

After rejecting A/B mismatches, the phase-aligned Timer-blink model explains 1,969 of 2,033 rows exactly (96.852%). Another 56 rows are one bit away and eight are two bits away.

## Recovered Selection Mask

| Digit phase | Meaning | Expected byte or envelope | Exact rows |
| ---: | --- | --- | ---: |
| 0 | Fan 8 | stable `0x80` | 504 / 513 |
| 1 | Power 9 | stable `0x90` | 495 / 508 |
| 2 | Timer whole-minute digit `3.` | `0x30` alternating with `0xFF` | 485 / 507 |
| 3 | Timer tenths digit `0` | `0xC0` alternating with `0xFF` | 485 / 505 |

Phases 2 and 3 enter and leave blank together. Their observed transition times are separated by approximately 6.043 ms only because the two digit slots are transmitted sequentially within the refresh cycle. Both phases have the same 0.491904 s median blink half-period.

## Fixed-Point Timer Decode

- Phase 2 is the whole-minute digit and carries the displayed decimal point.
- Phase 3 is the tenths-minute digit.
- Timer minutes decode as `phase2_digit + phase3_digit / 10`.
- `3.0` is directly observed as `[0x30, 0xC0]`.
- A displayed `2.9` is expected to use `[0x24, 0x90]` under the confirmed active-low map, but `0x24` remains inferred until digit `2.` is captured.

## Decoder Consequences

1. Timer selection is `blink_mask = 0b1100`; both Timer phases form one field.
2. During Timer blink-off, the decoder retains the complete last qualified `X.X` value.
3. A blank on only one Timer phase is corruption or a transition until repeated evidence proves otherwise.
4. Fan and Power remain decodable while Timer blinks.