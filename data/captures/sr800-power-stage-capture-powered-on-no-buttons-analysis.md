# Power-Stage Capture: Mains Applied, No Buttons

## Conditions

- Firmware: `2026-07-24.4`
- ESP32 powered from isolated battery.
- Factory mains applied.
- Factory controls left in four-dash Standby.
- No button or encoder actions.

## Probe Map

| Channel | ESP32 | Factory PIC |
| --- | ---: | ---: |
| CH0 | GPIO3 | U3B pin 11 |
| CH1 | GPIO4 | U3B pin 12 |
| CH2 | GPIO5 | U3B pin 8 |
| CH3 | GPIO6 | U3B pin 9 |

## Observation

The capture contains two edges:

1. U3B pin 8 rose at `346719642 us`.
2. U3B pin 9 rose `19366 us` later.

Pins 8 and 9 then remained high. Pins 11 and 12 remained low. No recurring
edge activity, PWM, or line-cycle cadence was observed during Standby.

## Interpretation

This is a clean factory-logic power-up/idle signature:

```text
U3B pin 11: low
U3B pin 12: low
U3B pin 8:  high
U3B pin 9:  high
```

The result does not yet identify direction or application role. Pins 8 and 9
could be idle-high outputs or inputs with pull-ups. Pins 11 and 12 could be
idle-low outputs or inputs with pull-downs. Isolated action captures are
required before assigning fan, heater, timing, or status names.
