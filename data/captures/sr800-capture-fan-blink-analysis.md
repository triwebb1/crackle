# Fan Selection Blink Capture Analysis

## Observation

- Firmware: `2026-07-23.4`.
- Physical display: `993.0`, with Fan 9 selected and blinking.
- No value was changed during the capture.
- Raw capture: `sr800-capture-fan-blink.csv`.
- Completion status: `sr800-capture-fan-blink.status.json`.
- Raw CSV SHA-256: `5d5ccad2efcf21ceda2db6ff9bfea19d2b8a1c18a5359beb3cd15f46e66b2d07`.

The CSV is preserved unchanged and contains 2,048 complete eight-clock groups. The capture stopped normally at `event_limit`.

## Timing And Quality

| Metric | Result |
| --- | ---: |
| Complete byte events | 2,048 |
| Captured clock edges before stop | 17,564 |
| Incomplete groups reported | 380 |
| Capture stop reason | `event_limit` |
| Capture span | 4.691366 s |
| Median complete-event interval | 2,017 us |
| Nominal digit-slot rate | 496.03 Hz |
| Nominal four-digit frame rate | 124.01 Hz |
| Long event intervals over 2,500 us | 113 |
| Estimated omitted digit slots | 281 |
| Rows where A differs from B | 9 / 2,048 (0.439%) |
| Rows where CLR is low | 0 |

Timing reconstruction advances phase by `round(delta_us / 2016)`. After rejecting A/B mismatches, the expected blink-aware frame explains 1,949 of 2,039 rows exactly (95.586%). Another 80 rows are one bit away and 10 are two bits away.

## Recovered Blink

The phase-aligned display is:

| Digit phase | Meaning | Expected byte or envelope | Exact rows |
| ---: | --- | --- | ---: |
| 0 | Fan 9, selected | `0x90` alternating with `0xFF` | 481 / 506 |
| 1 | Power 9 | stable `0x90` | 485 / 507 |
| 2 | Timer `3.` | stable `0x30` | 497 / 517 |
| 3 | Timer `0` | stable `0xC0` | 486 / 509 |

Only phase 0 contains sustained `0xFF` intervals. It contains 201 exact `0x90` samples and 280 exact `0xFF` samples; the other phases retain their normal glyphs.

The detected phase-0 runs alternate cleanly:

| Run | Value | First observed time | Last observed time |
| ---: | --- | ---: | ---: |
| 1 | `0x90` | 0.002011 s | 0.219656 s |
| 2 | `0xFF` | 0.227717 s | 0.711362 s |
| 3 | `0x90` | 0.743605 s | 1.203072 s |
| 4 | `0xFF` | 1.211133 s | 1.694778 s |
| 5 | `0x90` | 1.702839 s | 2.186476 s |
| 6 | `0xFF` | 2.202598 s | 2.678176 s |
| 7 | `0x90` | 2.686236 s | 3.169878 s |
| 8 | `0xFF` | 3.177938 s | 3.661581 s |
| 9 | `0x90` | 3.669642 s | 4.153293 s |
| 10 | `0xFF` | 4.161354 s | 4.645012 s |
| 11 | `0x90` | 4.653073 s | capture end |

The median transition-to-transition half-period is 0.491904 s. The resulting full blink period is 0.983808 s, or approximately 1.016 Hz, with approximately equal on and off intervals.

## State And Decoder Consequences

1. Phase 0 is the Fan field.
2. Fan selection is observable as phase 0 alternating between its effective glyph and `0xFF`.
3. `0xFF` during a coherent blink-off interval does not erase Fan 9.
4. A full blink detector should require repeated phase-aligned on/off runs near the measured 0.492 s half-period.
5. Stable phases 1 through 3 remain available while Fan blinks, so Power and Timer can still be decoded.
6. The blink remains active at capture end. Later Fan-8 evidence and direct observation establish that selection blinking persists while the roaster is not running.

## Next Capture

The subsequent Fan-8 capture changes the retained phase-0 glyph to `0x80` while preserving the same persistent blink envelope.