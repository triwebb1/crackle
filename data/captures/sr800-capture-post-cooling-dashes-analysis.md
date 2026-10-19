# Post-Cooling Four-Dash Capture Analysis

## Observation

- Operator-observed natural completion sequence: `C.1` changes to `C.0`, then promptly to four solid dashes.
- This capture was taken after the transition and contains the settled four-dash display.
- Raw capture: `sr800-capture-post-cooling-dashes.csv`.
- Raw CSV SHA-256: `acafe0971aff0ae32b40125805607eb67ba68ee56bfed679971b30842c365440`.
- Matching `/api/status` was not supplied.

The CSV is preserved unchanged and contains 2,048 complete eight-clock groups.

## Timing And Quality

| Metric | Result |
| --- | ---: |
| Capture span | 4.454033 s |
| Median complete-event interval | 2,017 us |
| Long intervals over 2,500 us | 65 |
| Estimated omitted digit slots | 163 |
| Rows where A differs from B | 25 / 2,048 (1.221%) |
| Rows where CLR is low | 0 |
| Exact dash rows after mismatch rejection | 1,919 / 2,023 (94.859%) |

Of the remaining matched rows, 94 are one bit from `0xBF`, eight are two bits away, and two are three bits away. The dominant byte is decisively the known active-low dash glyph `0xBF`.

## Recovered Frame

All four display phases are the same dash glyph:

```text
[0xBF, 0xBF, 0xBF, 0xBF] = ----
```

No `C`, `C.`, or trailing zero remains in this 4.454-second file. It is a stable post-transition capture rather than the transition itself.

## State Consequences

- Natural Cooling completion follows the operator-observed sequence `C.1 -> C.0 -> fan stops -> ----`.
- Four solid dashes are the same display signature previously captured for factory Standby.
- After dash consensus, the display decoder may move the base mode from `COOLING` to `STANDBY`.
- During any intermediate `C.0` or mixed frame, firmware remains `COOLING` or `UNKNOWN` and issues no command.
- The operator separately confirmed that the physical fan stops at completion. This is behavioral evidence paired with the capture, not an inference from display bytes.