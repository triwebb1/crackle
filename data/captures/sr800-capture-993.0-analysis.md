# Stable 993.0 Capture Analysis

## Observation

- Firmware: `2026-07-23.4`.
- Physical display: stable `993.0`.
- Capture was armed after the display reached that state.
- Raw capture: `sr800-capture-993.0.csv`.
- Completion status: `sr800-capture-993.0.status.json`.
- Raw CSV SHA-256: `7ac6d6b89bd1ef974e3870e6e1e04e94987559c3285390d5aad6080abaeed928`.

The CSV is preserved unchanged and contains 2,048 complete eight-clock groups. The capture stopped normally at `event_limit`.

## Timing And Quality

| Metric | Result |
| --- | ---: |
| Complete byte events | 2,048 |
| Captured clock edges before stop | 17,033 |
| Incomplete groups reported | 205 |
| Capture stop reason | `event_limit` |
| Capture span | 4.435299 s |
| Median complete-event interval | 2,016 us |
| Nominal digit-slot rate | 496.03 Hz |
| Nominal four-digit frame rate | 124.01 Hz |
| Long event intervals over 2,500 us | 64 |
| Estimated omitted digit slots | 154 |
| Rows where A differs from B | 10 / 2,048 (0.488%) |
| Rows where CLR is low | 0 |

Timing reconstruction advances the digit phase by `round(delta_us / 2016)`, rather than by one phase per CSV row. This preserves phase across omitted transfers.

The completion snapshot was taken after factory power was removed: all four instantaneous GPIO levels were low, while `clocks_while_clear_low` remained zero. The 144 asynchronous CLR changes therefore include power-down behavior after the byte buffer had already completed and do not imply CLR activity within the captured transfers. The ESP remained healthy at 1,789 seconds uptime, 43.6 C die temperature, and 212,540 bytes free heap without a reset.

## Recovered Four-Digit Cycle

The known physical display selects one timing-aligned rotation decisively:

| Candidate phase offset | Exact expected bytes | Percent |
| ---: | ---: | ---: |
| 0 | 500 | 24.414% |
| 1 | 1,981 | 96.729% |
| 2 | 495 | 24.170% |
| 3 | 0 | 0.000% |

The recovered left-to-right cycle is:

| Digit phase | Physical glyph | Stable byte | Exact rows | Phase confidence |
| ---: | --- | --- | ---: | ---: |
| 0 | `9` | `0x90` | 495 / 510 | 97.059% |
| 1 | `9` | `0x90` | 500 / 513 | 97.466% |
| 2 | `3.` | `0x30` | 495 / 515 | 96.117% |
| 3 | `0` | `0xC0` | 491 / 510 | 96.275% |

Across all phases, 1,981 rows (96.729%) exactly match the expected cycle. Another 58 rows are one bit away and nine rows are two bits away. There are no errors farther than two bits from the phase expectation.

## Confirmed Segment Encoding

The stable cycle agrees exactly with the conventional active-low seven-segment byte map:

| Mask | Segment |
| --- | --- |
| `0x01` | A, top |
| `0x02` | B, upper right |
| `0x04` | C, lower right |
| `0x08` | D, bottom |
| `0x10` | E, lower left |
| `0x20` | F, upper left |
| `0x40` | G, center |
| `0x80` | Decimal point |

A zero bit turns the corresponding segment on. The directly observed glyphs are:

- Blank: `0xFF`.
- Dash: `0xBF`.
- `0`: `0xC0`.
- `9`: `0x90`.
- `3` with decimal point: `0x30`.

Because `0x80` is the active-low decimal-point mask, plain `3` is strongly inferred as `0xB0`, and adding a decimal point is `base_byte & 0x7F`.

## Decoder Consequences

1. Use timing to advance zero, one, or several digit phases when transfers are omitted.
2. Discard A/B-mismatched bytes before voting.
3. Vote independently within each of the four timing phases.
4. Require several consistent four-digit frames before publishing a display change.
5. Keep observed and inferred glyphs distinct until each important state is captured.
6. Preserve the prior stable frame through isolated one- or two-bit errors.
7. Report confidence and fall back to `UNKNOWN` when timing lock or consensus is lost.

The 96.7% phase-aligned exact rate is sufficient to continue state capture with firmware `2026-07-23.4`; a hardware capture redesign is not yet required for display-state decoding. Cooling transitions remain safety-critical and must use longer consensus windows than ordinary numeric updates.

## Next Captures

- One isolated fan-value change while remaining in Edit.
- One isolated power-value change while remaining in Edit.
- One isolated timer change while remaining in Edit.
- Timer zero entering Cooling and stable `C.3`.
- Cooling minute changes and Cooling completion.

Capture stable states separately from the button or encoder transition that produced them.
