# Power-Stage Capture: Run, Fan 1, Power 1

## Conditions

- Firmware: `2026-07-24.4`
- Fan: `1`
- Power: `1`
- Factory Run started from the powered idle state.

## Result

Only U3B pins 11 and 12 switched. U3B pins 8 and 9 remained high.

| PIC pin | ESP channel | Captured rises | Median pulse width | Median adjacent-half-cycle interval |
| ---: | --- | ---: | ---: | ---: |
| 11 | CH0 / GPIO3 | 585 | 13 us | 8712 us |
| 12 | CH1 / GPIO4 | 630 | 11 us | 8677 us |

Consecutive pairs return a full-cycle median of `16670 us`, or approximately
`59.99 Hz`. Alternating half-cycle intervals and longer gaps at integer
multiples of the half-cycle show that both signals are synchronized to mains
and sometimes skip firing opportunities.

The two channels never changed simultaneously. Each normally rests low and
issues a narrow positive pulse. The power-board driver stages may invert this
polarity after the PIC.

## Interpretation

Combined evidence now strongly supports U3B pins 11 and 12 as the two
fan/heater drive commands:

- Their PCB traces lead through the Q7B/Q8B-area transistor/driver circuitry.
- They do not change when On/Off only activates the UI.
- They become active only after Run.
- Their timing is synchronized to the AC line.
- Pins 8 and 9 remain steady high throughout the same run.

Two safe comparison captures will assign the load identities:

1. Fan 9, Power 1, compared with this Fan 1, Power 1 fixture.
2. Fan 9, Power 9, compared with Fan 9, Power 1.
