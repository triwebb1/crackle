# Power-Stage Capture: On/Off, No Run

## Conditions

- Firmware: `2026-07-24.4`
- Mains already applied.
- Capture armed in four-dash Standby.
- Factory On/Off pressed exactly once.
- Run/Cool and encoder untouched.

## Result

The CSV contains only its header. No edge occurred on U3B pins 8, 9, 11, or
12. Levels remained at the powered idle signature:

```text
U3B pin 11: low
U3B pin 12: low
U3B pin 8:  high
U3B pin 9:  high
```

## Interpretation

Factory UI activation and the editable display state do not use or disturb
these four interconnect lines. This strengthens the hypothesis that they serve
the power-stage boundary rather than the panel/display bus. A Run transition
is the next discriminating capture.
