# Four-Dash Baseline Analysis

## Observation

- Firmware: `2026-07-23.4`.
- Display: factory standby state showing four dashes.
- Action during capture: none.
- Raw capture: `sr800-capture-four-dash-baseline.csv`.
- Completion status: `sr800-capture-four-dash-baseline.status.json`.
- Raw CSV SHA-256: `7a9706f5e69c48ff67b722ca89ca5996ff8d781cb4b87658f57c814e0209b518`.

The CSV is preserved unchanged. It contains 2,048 complete eight-clock groups and stopped normally at the configured event limit.

## Results

| Metric | Result |
| --- | ---: |
| Complete byte events | 2,048 |
| Capture span | 4.427371 s |
| Captured clock edges before stop | 17,050 |
| Incomplete groups reported | 199 |
| Rows with CLR low | 0 |
| Median preceding group gap | 1,971 us |
| Preceding group-gap range | 1,933-2,003 us |
| Median complete-event interval | 2,017 us |
| Long event intervals over 2,500 us | 62 |
| Approximate omitted refresh slots from timing | 150 |
| Rows where A equals B | 2,022 / 2,048 (98.730%) |
| Rows where A differs from B | 26 / 2,048 (1.270%) |
| Disagreeing A/B bits | 31 / 16,384 (0.189%) |

The nominal per-digit refresh interval is about 2.017 ms, or 495.8 digit updates per second. Four digit slots imply an approximately 8.068 ms complete display frame, about 124.0 Hz, assuming the PIC visits one digit per shifted byte.

## Byte Distribution

| Effective byte | Count | Percent | Difference from `0xBF` |
| --- | ---: | ---: | ---: |
| `0xBF` | 1,893 | 92.432% | 0 bits |
| `0x3F` | 22 | 1.074% | 1 bit |
| `0xB7` | 19 | 0.928% | 1 bit |
| `0x9F` | 17 | 0.830% | 1 bit |
| `0xBD` | 17 | 0.830% | 1 bit |
| `0xBB` | 15 | 0.732% | 1 bit |
| `0xFF` | 15 | 0.732% | 1 bit |
| `0xAF` | 12 | 0.586% | 1 bit |
| Other values | 38 | 1.855% | 2-4 bits |

Across the complete file, 1,893 bytes exactly equal `0xBF`; 117 are one bit away, 27 are two bits away, 10 are three bits away, and one is four bits away.

Rows 1-10 are `0xFF`. Row 11 changes to `0xBF`, 24.183 ms after the first captured byte. This coherent ten-refresh startup run is distinct from the isolated later errors.

## Interpretation

- Strong inference: `0xFF` is the all-segments-blank pattern.
- Strong inference: `0xBF` is the dash pattern. Relative to blank, captured bit mask `0x40` is asserted low and therefore likely drives the center segment.
- CLR remained high during every complete transfer. It is not the normal byte-framing signal in this state.
- A 40 us group threshold safely separates the observed short clock periods (3 us minimum and 6 us at the status snapshot) from the roughly 1.97 ms inter-transfer gap.
- The rare non-`0xBF` values must not be added to the glyph table. Most are isolated, differ from the stable byte by only one bit, and occur while the display is visually unchanged.

## Capture Quality

The capture is semantically useful but not bit-perfect. A/B can disagree even though factory U2B pins 1 and 2 are tied, and A/B sometimes agree on an isolated nonmodal value. This is consistent with software ISR latency sampling the serial line after the 74HC164 clock edge, occasionally near the next data transition. Long event intervals separately show that some whole or partial clock groups were missed.

Directly reading the GPIO register may reduce sequential-read skew but cannot by itself remove interrupt latency. Do not treat one sampled byte as authoritative.

## Decoder Requirements

1. Preserve A and B independently.
2. Reject a byte when A differs from B.
3. Learn glyphs only from known, stable physical display states.
4. Align repeating bytes into four digit phases before interpreting a frame.
5. Use temporal voting over repeated complete frames and report confidence.
6. Keep the prior stable frame through isolated corrupt bytes or omitted slots.
7. Enter `UNKNOWN` instead of inventing a glyph when confidence falls below threshold.
8. Require multiple consistent frames before reporting a mode transition, especially `HEATING` or `COOLING`.

## Next Capture

Capture a stable active display such as the observed `993.0` state. Its repeating four-byte sequence should establish digit phase, decimal-point encoding, and patterns for `9`, `3`, and `0`. Preserve the transition separately from the stable-state capture.
