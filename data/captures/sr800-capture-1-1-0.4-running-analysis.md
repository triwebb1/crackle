# 1-1-0.4 Running Capture Analysis

## Observation

- Physical display: Fan 1, Power 1, active Timer near `0.4` minutes.
- The capture contains the countdown transition from `0.4` to `0.3` at approximately 4.180784 s after capture start.
- Raw capture: `sr800-capture-1-1-0.4-running.csv`.
- Raw CSV SHA-256: `2fd32defc8fb7b90fae2e76874fa46b6faf013526bcaa03f1d25e0fe422d377c`.
- Matching `/api/status` was not supplied.

The CSV is preserved unchanged and contains 2,048 complete eight-clock groups.

## Timing And Quality

| Metric | Result |
| --- | ---: |
| Capture span | 4.491074 s |
| Median complete-event interval | 2,016 us |
| Long intervals over 2,500 us | 87 |
| Estimated omitted digit slots | 182 |
| Rows where A differs from B | 15 / 2,048 (0.732%) |
| Rows where CLR is low | 0 |
| Exact phase-aligned rows after mismatch rejection | 1,941 / 2,033 (95.475%) |

## Recovered Running Frame

| Phase | Meaning | Observed behavior | Exact rows |
| ---: | --- | --- | ---: |
| 0 | Fan 1 | stable `0xF9` | 480 / 509 |
| 1 | Power 1 | stable `0xF9` | 478 / 499 |
| 2 | Timer whole digit 0 | `0x40` / `0xC0` decimal-point heartbeat | 490 / 510 |
| 3 | Timer tenths | `0x99` (4), then `0xB0` (3) | 493 / 515 |

Phase 2 never performs an Edit-style full blank. Its segment pattern remains zero while only bit `0x80`, the decimal point, toggles. The heartbeat is approximately one 0.492 s half-cycle, matching the panel blink timer but carrying different semantics.

Phase 3 remains digit 4 (`0x99`) until approximately 4.180784 s, then becomes digit 3 (`0xB0`). This directly observes plain digits 4 and 3.

## State Consequences

- A numeric `X.X` countdown plus phase-2 decimal-point heartbeat is direct evidence of `HEATING`/running operation.
- Edit selection blanks complete glyphs to `0xFF`; running heartbeat changes only the decimal-point bit.
- Numeric changes during running are accepted from repeated phase-3 consensus, not from local timer inference alone.
- This capture does not contain the timer-zero transition into Cooling.