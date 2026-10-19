# Firmware .24 Fan 10 Interrupted Run

- Source firmware: `2026-07-26.24`
- Requested test: Fan `10.0`, 100 us pulse, three-second maximum
- Observed behavior: Fan ran for about one second, stopped, and later tests were rejected until restart
- Raw records: `146`
- Raw SHA-256: `e69434a4aaedde8527237cff3e11e5cbdcd7367e45529dbc2d4b84dd262c9354`

## Waveform Result

The 146 captured Fan pulses are internally exact: every command emitted, sequence indices are contiguous, pulse width is exactly `100 us`, and absolute phase error is at most `1 us`. The analyzer reports `FAIL` only because the interrupted run did not reach the 300-record proof minimum.

## Interruption Result

Status latched `zero_cross_lost` in the actuator and faulted the scheduler after one rejected active interval. Legacy GPIO6 telemetry recorded a maximum low observation of `57,923 us`, while the stream subsequently returned to normal approximately 7.9/8.76 ms intervals. Firmware `.24` could not distinguish a physical GPIO6 dropout from a delayed MCPWM capture callback, and its permanent-latch response converted either case into a stopped roast.

## Disposition

Firmware `.25` keeps the proven hardware-comparator pulse path but adds:

- bounded capture-gap recovery while the 12 ms MCPWM period parks fail-low;
- retention and automatic resumption of the active roast command when verified timing returns;
- a 100 ms observation timeout and 250 ms Heat-side recovery bound;
- Heat-off plus mandatory cooling after a sustained outage;
- rejected interval/reason and independent PCNT physical-edge-delta telemetry.

The Fan 10 proof must be repeated on `.25` before Heat is armed.