# Pin-17-Correlated Fan 9 / Power 9 Run-To-Cooling Capture

## Conditions

- Firmware: `2026-07-24.4`
- Factory settings: Fan 9 / Power 9
- Sequence: idle; Run; approximately 2.4 s Heating; Run/Cool; approximately 2.0 s Cooling; Freeze
- CH0 / GPIO3: U3B pin 11, heater command
- CH1 / GPIO4: U3B pin 12, fan command
- CH2 / GPIO5: U3B pin 10, probable display digit select
- CH3 / GPIO6: U3B pin 17, zero-cross reference
- CSV span: 5.434854 s
- Captured events: 3,559 of 4,096; manually frozen

Firmware `2026-07-24.4` has stale static CSV labels for CH2 and CH3. The
physical mapping above is authoritative.

## Conclusion

This capture confirms U3B pin 17 as the factory zero-cross reference. It is not
merely a nearby 60 Hz signal:

- All 652 captured pin-17 edges alternate polarity correctly.
- No pin-17 interval is missing, duplicated, or outside 7.899-8.768 ms.
- Same-polarity periods are 16.650-16.692 ms, approximately 60 Hz.
- Every accepted heater and fan trigger follows exactly one preceding pin-17
  edge in a narrow, state-dependent delay band.
- Pin 17 continues unchanged through the Heating-to-Cooling transition while
  heater triggers stop and fan triggers continue.

Pins 17, 11, and 12 therefore provide the three signals needed to derive and
later reproduce factory phase control: zero-cross, heater trigger, and fan
trigger.

## Timeline

| Event | Time from CSV start |
| --- | ---: |
| First heater trigger | 1.007611 s |
| First fan trigger | 1.008950 s |
| Last heater trigger | 3.416377 s |
| First Cooling fan trigger with delay >= 1.8 ms | 3.526252 s |
| Last captured fan trigger | 5.434845 s |

The factory starts heater and fan in the same AC half-cycle; heater leads fan by
1.339 ms. The project's separate 500 ms fan-before-heater rule is therefore a
new safety policy, not copied factory behavior.

## Pin 17 Timing

| Measurement | Result |
| --- | ---: |
| Captured edges | 652 |
| Alternation errors | 0 |
| High interval | 8,733-8,768 us; 8,750 us median |
| Low interval | 7,899-7,937 us; 7,922 us median |
| Same-polarity period | 16,650-16,692 us; 16,672 us median |

The duty asymmetry is stable. Reproduction should schedule from each observed
pin-17 edge rather than synthesizing an independent 60 Hz clock. Rising and
falling edge delays remain separately measurable.

## Heater Command: Pin 11

- 283 positive pulses captured.
- Pulse width: 7-19 us; 12 us median.
- After pin 17 transitions low: 800-915 us; 812 us median.
- After pin 17 transitions high: 793-903 us; 802 us median.
- No heater pulse occurs after the Heating-to-Cooling transition.

Power 9 is therefore a trigger approximately 0.80 ms after each pin-17 edge,
not a PWM duty cycle on pin 11.

## Fan Command: Pin 12

- 498 positive pulses captured.
- Pulse width: 6-13 us; 11 us median.
- Fan startup moves from approximately 2.14 ms delay toward 1.48 ms during the
  first approximately 500 ms. Earlier firing increases delivered fan power.
- Settled Heating delay after pin 17 transitions low: 1,484 us median.
- Settled Heating delay after pin 17 transitions high: 1,475 us median.
- Settled Cooling delay after pin 17 transitions low: 1,961 us median.
- Settled Cooling delay after pin 17 transitions high: 1,953 us median.

Cooling does not simply retain the exact Fan-9 heating waveform. About 109.9 ms
after the last heater trigger, the factory begins moving fan firing later and
settles near 1.95 ms. The display may still show Fan 9, but the underlying
Cooling command is distinct.

## Apparent Missing Narrow Pulses

Within the active spans, the CSV contains heater pulses on 283 of 290 pin-17
opportunities and fan pulses on 498 of 532 opportunities, with no duplicate
pulse assigned to any crossing. Since the command pulses are only 6-19 us wide,
these gaps may be either deliberate factory omissions or narrow-pulse capture
loss. They do not affect channel identity or phase-delay measurement. Do not
copy the apparent omission pattern into active firmware without separate proof.

## Active-Test Gate

Passive identification is complete enough to design a bounded fan-only test.
Active drive still requires a factory-default ownership selector and an
isolated command path. The ESP must never drive pin 12 while the PIC remains
electrically connected to that command net, and pin 11 heater must remain under
factory/off ownership during the first fan test.

## Source Integrity

Raw SHA-256:
`0E4D82F0887B97F3CAB6D401754959C18E8C568D91843AE283B3C9FA4F4731BB`
