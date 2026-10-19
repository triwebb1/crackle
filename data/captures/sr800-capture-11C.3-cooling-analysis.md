# 1-1-C.3 Cooling Capture Analysis

## Observation

- Physical display: Fan 1, Power 1, factory Cooling `C.3`.
- Raw capture: `sr800-capture-11C.3-cooling.csv`.
- Raw CSV SHA-256: `f5c82cdb0e248114ab581ca58f03636d3821b1e4384edd0e051effee18c2c03d`.
- Matching `/api/status` was not supplied.

The CSV is preserved unchanged and contains 2,048 complete eight-clock groups. It captures stable Cooling, not the preceding timer-zero transition.

## Timing And Quality

| Metric | Result |
| --- | ---: |
| Capture span | 4.834152 s |
| Median complete-event interval | 2,016 us |
| Long intervals over 2,500 us | 139 |
| Estimated omitted digit slots | 352 |
| Rows where A differs from B | 26 / 2,048 (1.270%) |
| Rows where CLR is low | 0 |
| Exact phase-aligned rows after mismatch rejection | 1,916 / 2,022 (94.758%) |

## Recovered Cooling Frame

| Phase | Meaning | Observed behavior | Exact rows |
| ---: | --- | --- | ---: |
| 0 | Fan 1 | stable `0xF9` | 485 / 514 |
| 1 | Power 1 | stable `0xF9` | 474 / 503 |
| 2 | Cooling `C` | `0x46` / `0xC6` decimal-point heartbeat | 469 / 494 |
| 3 | Cooling value 3 | stable `0xB0` | 488 / 511 |

`C` is directly observed as `0xC6`; `C.` is `0x46`. As in running mode, only the phase-2 decimal-point bit toggles, at approximately the established 0.492 s half-cycle. The trailing 3 remains continuously visible.

## State Consequences

- A confidence-qualified phase-2 `C` immediately identifies `COOLING`; it is not an ordinary numeric Timer value.
- The complete Cooling display is `[fan, power, C/C., cooling_value]`.
- Cooling decimal-point heartbeat is distinct from Timer Edit because neither Cooling glyph is `0xFF`.
- The retained Fan and Power values remain observable during Cooling, but they are not evidence of current actuator output; Cooling mode overrides their operational meaning.
- `C.3` is a safety-critical state signature. Automatic Timer editing and any generic synchronization routine remain forbidden while it is present.
- Separate `C.2` and `C.1` captures are unnecessary because the `C` prefix and trailing digit encoding are already known. Natural Cooling completion remains behaviorally important.