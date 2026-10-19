# Power 9 Blink Capture Analysis

## Observation

- Firmware: `2026-07-23.4`.
- Physical display: `893.0`, with Power 9 selected and blinking.
- The capture was armed after selection had already been active. Persistent non-running blinking makes that delay immaterial.
- Raw capture: `sr800-capture-power9-blink.csv`.
- Completion status: `sr800-capture-power9-blink.status.json`.
- Raw CSV SHA-256: `267cf2c07455ee8c200d7218ad7446f9adab9a0e2947787029afd9c246c2fe95`.

The CSV is preserved unchanged and contains 2,048 complete eight-clock groups. The capture stopped normally at `event_limit`.

## Timing And Quality

| Metric | Result |
| --- | ---: |
| Complete byte events | 2,048 |
| Captured clock edges before stop | 17,292 |
| Incomplete groups reported | 315 |
| Capture stop reason | `event_limit` |
| Capture span | 4.454653 s |
| Median complete-event interval | 2,016 us |
| Long event intervals over 2,500 us | 77 |
| Estimated omitted digit slots | 164 |
| Rows where A differs from B | 13 / 2,048 (0.635%) |
| Rows where CLR is low | 0 |

After rejecting A/B mismatches, the phase-aligned Power-blink model explains 1,963 of 2,035 rows exactly (96.462%). Another 70 rows are one bit away and two are two bits away.

## Recovered Selection Mask

| Digit phase | Meaning | Expected byte or envelope | Exact rows |
| ---: | --- | --- | ---: |
| 0 | Fan 8 | stable `0x80` | 499 / 511 |
| 1 | Power 9, selected | `0x90` alternating with `0xFF` | 480 / 509 |
| 2 | Timer `3.` | stable `0x30` | 493 / 505 |
| 3 | Timer `0` | stable `0xC0` | 491 / 510 |

Only phase 1 contains sustained blank intervals. It contains 219 exact `0x90` samples and 261 exact `0xFF` samples. The median blink half-period is 0.491904 s, matching Fan selection.

## Decoder Consequences

1. Power occupies display phase 1.
2. Power selection is `blink_mask = 0b0010`.
3. Fan and the complete Timer value remain decodable while Power blinks.
4. A late capture is valid in the non-running state because selection does not time out.