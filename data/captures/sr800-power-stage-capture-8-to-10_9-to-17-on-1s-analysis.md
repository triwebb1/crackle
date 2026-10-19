# Idle Zero-Cross Candidate Capture

## Conditions

- Firmware: `2026-07-24.4`
- Panel state: powered, idle, four dashes
- CH0 / GPIO3: U3B pin 11, heater command
- CH1 / GPIO4: U3B pin 12, fan command
- CH2 / GPIO5: U3B pin 10, temporary candidate
- CH3 / GPIO6: U3B pin 17, zero-cross candidate
- Captured span: 2.527070 s
- Captured events: 930 of 4,096; manually frozen

The CSV header still says CH2 is pin 8 and CH3 is pin 9 because firmware
`2026-07-24.4` has static labels. The physical mapping above is authoritative
for this capture.

## Result

U3B pin 17 is the factory mains timing reference with high confidence. It is a
continuous, logic-level square wave while the panel is idle. Both transitions
are usable zero-cross markers:

| Measurement | Pin 17 result |
| --- | ---: |
| Captured edges | 304 |
| Total edge rate | approximately 120.3 edges/s |
| Rising-edge period | 16,646-16,669 us; 16,657.675 us average |
| Falling-edge period | 16,649-16,671 us; 16,657.702 us average |
| Same-polarity frequency | approximately 60.03 Hz |
| High duration | 8,736-8,755 us; 8,745.809 us average |
| Low duration | 7,899-7,923 us; 7,911.887 us average |

The duty-cycle asymmetry does not weaken the identification, but it matters for
trigger-delay measurement. Each edge occurs once per AC half-cycle and each
polarity repeats once per full 60 Hz cycle. Rising-edge and falling-edge firing
delays must be analyzed separately; do not average them into one reference.

U3B pin 10 is not the mains reference. It runs independently near 124.02 Hz:

| Measurement | Pin 10 result |
| --- | ---: |
| Captured edges | 628 |
| Same-polarity period | approximately 8,063.2 us |
| Same-polarity frequency | approximately 124.02 Hz |
| High duration | 6,101-6,154 us |
| Low duration | 1,909-1,963 us |

Its approximately 8.063 ms period matches the previously measured four-digit
display frame period, and its approximately 1.941 ms low interval matches one
digit slot. Pin 10 is therefore strongly consistent with an active-low display
digit-select output. It is not needed for fan/heater phase control.

## Consequence

The required passive control references are now identified:

- U3B pin 11: heater trigger output.
- U3B pin 12: fan trigger output.
- U3B pin 17: 120-edge/s zero-cross reference.

The present wiring can capture absolute factory firing delays without another
probe move. CH2 on pin 10 may remain connected and be ignored.

## Source Integrity

Raw SHA-256:
`63258DD388DEDD7A138FF8E0121C323A6691BB7B059B9AAA4FF6FF2BD23109DF`

