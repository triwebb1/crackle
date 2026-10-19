# Power-Stage Endpoint Comparison

## Fixtures

| Fixture | File | Captured span | Stop reason |
| --- | --- | ---: | --- |
| Fan 1 / Power 1 | `sr800-power-stage-capture-turn-on-fan1-power1.csv` | 5.659592 s | Manual |
| Fan 9 / Power 1 | `sr800-power-stage-capture-turn-on-fan9-power1.csv` | 9.404081 s | Event limit |
| Fan 9 / Power 9 | `sr800-power-stage-capture-turn-on-fan9-power9.csv` | 8.640617 s | Event limit |

Both new captures were armed before Run. The operator pressed On/Off after the run
interval rather than Run/Cool. Neither CSV contains the resulting stop: both
buffers reach 4,096 events while pins 11 and 12 are still issuing pulses.
Therefore these files establish startup and steady-state behavior but not a
measured stop waveform.

## Channel Assignment

U3B pin 11 is the heater command and U3B pin 12 is the fan command. This is
verified by the later Run-to-Cooling fixture: pin 11 stops at Cooling entry
while pin 12 continues, matching the observed zero-heat, retained-fan state.

The median signed phase separation below is `pin12 - pin11` after the first
0.5 s startup interval:

| Fan | Power | Median phase separation |
| ---: | ---: | ---: |
| 1 | 1 | +1,645 us |
| 9 | 1 | -1,339 us |
| 9 | 9 | +721 us |

Changing only Fan 1 to Fan 9 changes the relative phase by approximately
2,984 us. Holding Fan 9 and changing Power 1 to Power 9 changes it by
approximately 2,060 us. These comparisons prove independent phase control but,
without the shared zero-cross reference, do not by themselves identify which
absolute pulse moved. The Run-to-Cooling fixture provides that assignment.

## Waveform Model

Both commands are short positive trigger pulses, normally one per mains
half-cycle:

| Fixture | Pin 11 median width | Pin 12 median width |
| --- | ---: | ---: |
| Fan 1 / Power 1 | 13 us | 11 us |
| Fan 9 / Power 1 | 13 us | 13 us |
| Fan 9 / Power 9 | 13 us | 11 us |

Same-channel intervals alternate around the 8.33 ms half-cycle and sum to an
approximately 16.67 ms / 60 Hz full cycle. Pulse width remains essentially
constant. Fan and Power are therefore encoded primarily by trigger phase, not
pulse width or ordinary high-frequency PWM.

Raw edge counts vary because narrow pulses can coincide closely enough for the
software interrupt logger to miss an edge. Counts are diagnostic, not a load
setting measurement. The stable relative phase clusters are the stronger
evidence.

## Fan Startup

Pin 12, the fan command, has a repeatable startup ramp lasting approximately 0.5 s:

| Fan | Initial phase separation | Settled phase separation | Shift |
| ---: | ---: | ---: | ---: |
| 1 | about +1,818 us | about +1,645 us | -173 us |
| 9, Power 1 | about -769 us | about -1,339 us | -570 us |
| 9, Power 9 | about +1,300 us | about +721 us | -579 us |

The nearly identical Fan 9 shift at both Power settings proves that this is the
pin-12 fan command moving independently of the pin-11 heater setting.
Firmware should model
the factory startup boost/ramp explicitly rather than jumping directly to the
settled phase.

## Pins 8 And 9

Pin 9 remains high and inactive in all three fixtures.

Pin 8 is high and inactive except for a 256 ms burst from 7.291436 s through
7.547650 s in the Fan 9 / Power 9 file. The burst contains 295 irregular
transitions, many only 4-18 us apart, with no coherent mains cadence. It is
classified as electrical noise or a threshold disturbance, not a valid command
or timing waveform. A permanent input needs suitable hysteresis/filtering if
this net is retained.

## What Is Still Required

No more Fan/Power setting captures are required. The endpoint fixtures are
sufficient to assign the channels and establish phase control.

Active ESP control still requires an absolute mains zero-cross or equivalent
timing reference. The present captures only measure the two command pulses
relative to each other; they do not reveal their delay from the AC zero
crossing. Locate the PIC's factory timing input or prove that the downstream
power stage performs synchronization before generating either command.

The later Run-to-Cooling capture verifies heater cutout and retained fan
operation. No additional setting or transition capture is currently required.

## Source Integrity

- Fan 9 / Power 1 SHA-256:
  `D166D3060DD7438031653C5023653CCFDCD8602C30C90C7B1C36CB08EFEBD355`
- Fan 9 / Power 9 SHA-256:
  `D1EE413E5E8EAC3E8BEBAD51629F53B7CE2F88462C54CCEB1DDFD3A33B0D64C7`