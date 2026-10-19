# Firmware .26 Fan 10 Narrow-Glitch Investigation

## Result

**FAIL continuity; PASS emitted-pulse quality.** Both three-second Fan `10.0` captures contain only exact `100 us` pulses with `0-1 us` phase error, but both fail the continuity gate.

- Run 1: 345 records, with seven missing indices after record 16 and nine more near shutdown.
- Run 2: 352 records, with the same seven-index startup gap after record 16.
- Neither capture contains an invalid pulse width, invalid delay, sequence gap, or Heater pulse.

## Correlated Telemetry

Firmware status recorded rejected same-edge GPIO6 observations only `3-7 us` after the prior capture, with raw PCNT physical-edge deltas of `0` or `2`. The repeated startup location and extra raw edges identify a narrow input-edge burst rather than mains frequency drift. Firmware `.26` treated the first narrow edge as a full active discontinuity, forced both outputs low, and then withheld six valid crossings during requalification. That policy explains the audible speed dip followed by a brief recovery on startup or near shutdown.

The MCPWM output timer and comparators are not the defect: all emitted pulses remain exactly `100 us` and within `1 us` of requested phase.

## Disposition

Firmware `.27` contains sub-millisecond GPIO6 bursts for at most one half-cycle without demoting the qualified mains stream. It does not invert sync polarity for the rejected edge, retains the actuation request, and releases only on the next valid crossing. Longer malformed intervals retain strict fail-low behavior. The output audit now uses accepted logical mains cycles; a bounded long callback gap advances that index by estimated elapsed half-cycles, so a real missing output remains visible.

Heat remains withheld until one `.27` Fan `10.0` capture passes the uninterrupted waveform gate.

## Evidence

- Run 1 SHA-256: `461b3c6d54424a4ed75d262bdbc7cc8977a2a72341e32e90a2bd8035d39cd1e3`
- Run 2 SHA-256: `64da06adc7b54390353160ff5791cb7ec06fd8841fed43101a5f3e3239fbcfdd`
- Run 1 analyzer: FAIL only for two output-index gaps; p99 phase error `0 us`; width `100..100 us`.
- Run 2 analyzer: FAIL only for one output-index gap; p99 absolute phase error `1 us`; width `100..100 us`.