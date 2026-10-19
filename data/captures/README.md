# SR800 signal captures

Raw evidence from reverse-engineering the SR800's display bus and power stage, the hardware-timing
proofs behind Crackle's actuator, and one sample roast recording. Each entry names the build that
produced it; a finding describes what that capture showed, not necessarily present behaviour.
Current behaviour is documented in [`firmware/actuator-core.md`](../../firmware/actuator-core.md),
[`firmware/safety-policy.md`](../../firmware/safety-policy.md),
[`hardware/display-interface.md`](../../hardware/display-interface.md), and
[`hardware/power-stage-interface.md`](../../hardware/power-stage-interface.md).

> **Safety.** All captures were taken with the ESP32 powered from an isolated, non-charging battery
> pack. The ESP32 shares the factory logic ground, which is potentially mains-referenced: never attach
> computer USB, serial, or grounded instruments to it while roaster mains is present. See
> [`hardware/safety-checklist.md`](../../hardware/safety-checklist.md).

## Conventions

- One action per capture file. Raw files are never edited after decoding begins; each raw file's
  SHA-256 is listed below so it can be verified.
- `*.status.json` is the capture firmware's completion snapshot (stop reason, edge counts, levels).
  The station IP address in these snapshots is redacted to `192.168.x.x`; nothing else is changed.
- `*-analysis.md` is the decoding record for the capture of the same name.
- Display captures come from the passive sniffer ([`firmware/sniffer`](../../firmware/sniffer/README.md))
  build `2026-07-23.4`; power-stage captures from sniffer build `2026-07-24.4`. Phase-timing captures
  come from the controller timing builds named in each file. Those are internal development builds
  that predate the first published release.

## Display bus

The factory UI board drives its four-digit display through a 74HC164 shift register. These captures
decode the byte stream into glyphs, digit phases, and blink semantics.

| Capture | Raw SHA-256 |
| --- | --- |
| `sr800-capture-four-dash-baseline.csv` | `7a9706f5e69c48ff67b722ca89ca5996ff8d781cb4b87658f57c814e0209b518` |
| `sr800-capture-993.0.csv` | `7ac6d6b89bd1ef974e3870e6e1e04e94987559c3285390d5aad6080abaeed928` |
| `sr800-capture-fan-blink.csv` | `5d5ccad2efcf21ceda2db6ff9bfea19d2b8a1c18a5359beb3cd15f46e66b2d07` |
| `sr800-capture-fan8-blinking.csv` | `a2bdc85cb99f998454ac261c7713e5b2fdff6b6c53545a0d94c7ffdc7c862967` |
| `sr800-capture-power9-blink.csv` | `267cf2c07455ee8c200d7218ad7446f9adab9a0e2947787029afd9c246c2fe95` |
| `sr800-capture-timer3.0-blink.csv` | `d5bda7f166acf0972edd0f9d5d07e0a8b2478b99f6e950f9f5a058ac1b614675` |
| `sr800-capture-112.9-blinking-timer.csv` | `1fcf77be2267ae7a9b5101ef004afc78a631ac36b6d97c600f42c3821e4f84ed` |
| `sr800-capture-1-1-0.4-running.csv` | `2fd32defc8fb7b90fae2e76874fa46b6faf013526bcaa03f1d25e0fe422d377c` |
| `sr800-capture-11C.3-cooling.csv` | `f5c82cdb0e248114ab581ca58f03636d3821b1e4384edd0e051effee18c2c03d` |
| `sr800-capture-post-cooling-dashes.csv` | `acafe0971aff0ae32b40125805607eb67ba68ee56bfed679971b30842c365440` |

### Four-dash baseline

Files: `sr800-capture-four-dash-baseline.csv`, `.status.json`, `-analysis.md`.

Establishes `0xFF` as the probable blank, `0xBF` as the dash pattern, and a nominal 2.017 ms
digit-slot cadence. Read the analysis before assigning any other observed byte to a glyph.

### Stable 993.0

Files: `sr800-capture-993.0.csv`, `.status.json`, `-analysis.md`.

Establishes the left-to-right cycle `0x90 0x90 0x30 0xC0` for `993.0`, confirms the active-low
decimal-point mask `0x80`, and recovers four digit phases with 96.729 % exact agreement.

### Fan selection blink

Files: `sr800-capture-fan-blink.csv`, `.status.json`, `-analysis.md`.

Fan selection alternates only display phase 0 between Fan 9 (`0x90`) and blank (`0xFF`). The
measured half-period is approximately 0.491904 s, a 0.983808 s full blink period.

### Fan 8 selection blink

Files: `sr800-capture-fan8-blinking.csv`, `.status.json`, `-analysis.md`.

Directly observes digit 8 as `0x80`, confirms that a Fan change applies immediately, and reproduces
the 0.491904 s half-period. Selection blinking persists while the roaster is not running.

### Power 9 selection blink

Files: `sr800-capture-power9-blink.csv`, `.status.json`, `-analysis.md`.

Maps Power selection to phase 1 (`blink_mask = 0b0010`) and reproduces the 0.491904 s half-period.

### Timer 3.0 selection blink

Files: `sr800-capture-timer3.0-blink.csv`, `.status.json`, `-analysis.md`.

Maps Timer selection to phases 2 and 3 together (`blink_mask = 0b1100`) and confirms Timer as one
fixed-point `X.X` minute value.

### 1-1-2.9 timer selection blink

Files: `sr800-capture-112.9-blinking-timer.csv`, `-analysis.md` (no status snapshot).

Directly observes Fan/Power digit 1 (`0xF9`) and Timer `2.9` as `[0x24, 0x90]`, with both Timer
phases blanking together during Edit.

### 1-1-0.4 running

Files: `sr800-capture-1-1-0.4-running.csv`, `-analysis.md` (no status snapshot).

Observes the countdown from `0.4` to `0.3`, confirms digits 4 (`0x99`) and 3 (`0xB0`), and identifies
a phase-2 decimal-point heartbeat while running.

### 1-1-C.3 cooling

Files: `sr800-capture-11C.3-cooling.csv`, `-analysis.md` (no status snapshot).

Confirms the Cooling signature `[fan, power, C/C., cooling_value]` with `C = 0xC6` and `C. = 0x46`,
and a decimal-point heartbeat distinct from Edit blanking.

### Post-cooling four dashes

Files: `sr800-capture-post-cooling-dashes.csv`, `-analysis.md` (no status snapshot).

The natural completion sequence, observed at the roaster, is `C.1 -> C.0 -> fan stops -> ----`. The
capture contains the settled `[0xBF, 0xBF, 0xBF, 0xBF]` frame and confirms the return to the Standby
display signature; the fan stop itself is direct observation, not inferred from display bytes.

## Power stage

The factory PIC (U3B) drives the TRIAC power stage through narrow trigger pulses. These captures
identify the heater and fan command pins and the mains zero-cross reference that Crackle's actuator
reproduces. [`power-stage-capture-plan.md`](power-stage-capture-plan.md) is the plan the fixtures were
taken under; its planned file names differ from the files actually recorded.

| Capture | Raw SHA-256 |
| --- | --- |
| `sr800-power-stage-capture-powered-on-no-buttons.csv` | `c70bd8419594642b8dc44c3657b979ac2523b388006599e0364a873c608fc07c` |
| `sr800-power-stage-capture-onoff-no-run.csv` | `b2a6a33478e54c570a18f275274e2efc750f41da3ecb51d14a07453bfad5ed47` |
| `sr800-power-stage-capture-turn-on-fan1-power1.csv` | `5a2305fe4039036e264cc4f808b8e3ce1fdb47c6146df7882b20defd28592c98` |
| `sr800-power-stage-capture-turn-on-fan9-power1.csv` | `d166d3060dd7438031653c5023653ccfdcd8602c30c90c7b1c36cb08efebd355` |
| `sr800-power-stage-capture-turn-on-fan9-power9.csv` | `d1ee413e5e8eac3e8bebad51629f53b7ce2f88462c54cceb1ddfd3a33b0d64c7` |
| `sr800-power-stage-capture-fan9-power9-run-cool-off.csv` | `7ccd43dd45759003f35e4e642238ab0750d446728e58f6f63ad43414bdbb9c7f` |
| `sr800-power-stage-capture-8-to-10_9-to-17-on-1s.csv` | `63258dd388dedd7a138ff8e0121c323a6691bb7b059b9aaa4ff6ff2bd23109df` |
| `sr800-power-stage-capture-pin17-fan9-power9-run-cool.csv` | `0e4d82f0887b97f3cab6d401754959c18e8c568d91843ae283b3c9fa4f4731bb` |

### Mains applied, no buttons

Files: `sr800-power-stage-capture-powered-on-no-buttons.csv`, `-analysis.md`.

A clean power-up and idle signature: U3B pins 8 and 9 rise once and stay high, pins 11 and 12 stay
low, and there is no recurring edge activity in Standby.

### On/Off without Run

Files: `sr800-power-stage-capture-onoff-no-run.csv` (header only), `-analysis.md`.

Pressing On/Off alone produces no edge on pins 8, 9, 11, or 12. UI activation does not use these
interconnect lines, supporting their role at the power-stage boundary rather than the display bus.

### Run at the setting endpoints

Files: `sr800-power-stage-capture-turn-on-fan1-power1.csv` with `-analysis.md`;
`sr800-power-stage-capture-turn-on-fan9-power1.csv` and `-turn-on-fan9-power9.csv`, analysed together
in [`power-stage-endpoint-comparison-analysis.md`](power-stage-endpoint-comparison-analysis.md).

Only pins 11 and 12 switch after Run: narrow (about 11–13 µs) positive pulses, one per mains
half-cycle, synchronized to 60 Hz. Setting is encoded by trigger phase, not pulse width. Changing Fan
1 to 9 moves the relative phase by about 2,984 µs and Power 1 to 9 by about 2,060 µs, proving
independent phase control. The fan command has a repeatable startup ramp of about 0.5 s before it
settles. A 256 ms burst of irregular transitions on pin 8 is classified as electrical noise.

### Run to Cooling to On/Off

Files: `sr800-power-stage-capture-fan9-power9-run-cool-off.csv`, `.status.json`, `-analysis.md`.

Definitively assigns pin 11 to the heater and pin 12 to the fan: at Cooling entry the heater trigger
stops while the fan trigger continues on the next half-cycle, with no quiet interval. The file ends
with the fan still firing, so it does not establish a fan-off edge for On/Off.

### Idle zero-cross discovery

Files: `sr800-power-stage-capture-8-to-10_9-to-17-on-1s.csv`, `.status.json`, `-analysis.md`.

Identifies U3B pin 17 as the continuous mains zero-cross reference: about 120.3 edges/s, each
polarity repeating at 60.03 Hz. Pin 10 is an approximately 124.02 Hz waveform consistent with an
active-low display digit select. The CSV's static CH2/CH3 labels are stale; the physical mapping is
pin 10 and pin 17.

### Pin-17-correlated run to Cooling

Files: `sr800-power-stage-capture-pin17-fan9-power9-run-cool.csv`, `.status.json`, `-analysis.md`.

Confirms pin 17 as the zero-cross reference: 652 cleanly alternating edges, every heater and fan
trigger following exactly one preceding pin-17 edge in a narrow, state-dependent delay band, through
Heating and Cooling. Also shows distinct Fan 9 startup, Heating, and Cooling firing phases.

## Phase-timing proofs

Captures from controller timing builds, each auditing every emitted trigger pulse against the
zero-cross index it was scheduled for. Together they record why the actuator emits pulses from
hardware-timed MCPWM comparators with an independent capture audit rather than from software timer
callbacks. The analysers are [`analyze-timing.ps1`](../../firmware/crackle/tools/analyze-timing.ps1)
and [`analyze-mcpwm-timing.ps1`](../../firmware/crackle/tools/analyze-mcpwm-timing.ps1).

| Capture | Raw SHA-256 |
| --- | --- |
| `sr800-phase-timing-2026-07-25.15.csv` | `6b12810e2a57756033b7edc0aeaf662bfd20cc170f077fc16688f8c0120e7451` |
| `sr800-phase-timing-2026-07-25.16.csv` | `caf6262779f694ee428a774ead552522ffa94eb2ab95e169c78426056d56de60` |
| `sr800-phase-timing-2026-07-25.17.csv` | `17c6eb1ead276078ff7c4c48e519ceea57194618c9ca0111748742c26d030c7a` |
| `sr800-phase-timing-2026-07-25.18.csv` | `9f76a5920a39e768b00ffe6b91e6a9f34613e9115b4fd40fc01a946555764580` |
| `sr800-phase-timing-2026-07-26.24.csv` | `f8bd52aef25c8b7701ed588fccd159357a2aeca9f274da75bc613fd297824b0f` |
| `sr800-phase-timing-2026-07-26.24-fan10-interrupted.csv` | `e69434a4aaedde8527237cff3e11e5cbdcd7367e45529dbc2d4b84dd262c9354` |
| `sr800-phase-timing-2026-07-26.26-fan10-run1.csv` | `461b3c6d54424a4ed75d262bdbc7cc8977a2a72341e32e90a2bd8035d39cd1e3` |
| `sr800-phase-timing-2026-07-26.26-fan10-run2.csv` | `64da06adc7b54390353160ff5791cb7ec06fd8841fed43101a5f3e3239fbcfdd` |

### Build .15: Fan 3.0 callback timing

Files: `sr800-phase-timing-2026-07-25.15.csv`, `-analysis.md`.

All 239 Fan commands were emitted with no misses or log drops, but the run fails the timing-quality
gate: p99 lateness `128 µs`, maximum `285 µs`, and 25 records on an exact `125 µs` shelf. This led to
a continuously running, absolute-deadline GPTimer scheduler.

### Build .16: absolute-deadline scheduler

Files: `sr800-phase-timing-2026-07-25.16.csv`, `-analysis.md`.

All 359 commands were emitted with no misses, drops, or alarm failures, and accumulated phase error is
gone, but callback dispatch still shows the `125 µs` shelf: p99 lateness `147 µs`, maximum `348 µs`.
Heat remained withheld.

### Build .17: Wi-Fi modem-sleep A/B

Files: `sr800-phase-timing-2026-07-25.17.csv`, `-analysis.md`.

Keeping Wi-Fi awake during actuation did not change the callback-latency distribution: p95 stays at
`125 µs`, 63 records exceed `50 µs`, maximum `247 µs`. Modem sleep is ruled out as the cause, which
motivated moving pulse edges into MCPWM comparator hardware.

### Build .18: MCPWM audit instrumentation failure

Files: `sr800-phase-timing-2026-07-25.18.csv` (header only), `-analysis.md`.

The fan ran and the rising-edge capture counted 359 pulses, but separate MCPWM rise and fall capture
channels on the same GPIO produced no paired timestamps, so the CSV holds no timing records. This
proves neither phase nor pulse width; the audit was redesigned around independent rise/fall captures
plus a PCNT count of zero-cross edges.

### Build .24: dual-output MCPWM proof

Files: `sr800-phase-timing-2026-07-26.24.csv`, `-analysis.md`.

The Fan hardware proof passes: 359 planned pulses reconcile exactly with 359 independent rises, falls,
completed records, and PCNT-expected zero-cross indices. Every pulse is `100 µs`, phase error is
`-1..0 µs`, with no misses, gaps, drops, pair or index errors, Heater pulses, or scheduler faults. The
build also safely ignored one idle startup interval before qualifying the zero-cross stream.

### Build .24: Fan 10 interrupted run

Files: `sr800-phase-timing-2026-07-26.24-fan10-interrupted.csv`, `-analysis.md`.

Fan `10.0` stopped after 146 audited pulses when one approximately 58 ms zero-cross capture interval
latched the scheduler and actuator. All 146 pulses were exactly `100 µs`, contiguous, and within
`1 µs` of the requested phase; the run fails only the 300-record proof-length gate. A flash-cache
callback blackout is the leading hypothesis, since the core is not configured for cache-safe MCPWM
ISRs. The response was a 12 ms hardware fail-low timer, bounded-gap resumption, and PCNT physical-edge
accounting to separate callback blackout from signal loss.

### Build .26: Fan 10 narrow-glitch failures

Files: `sr800-phase-timing-2026-07-26.26-fan10-run1.csv`, `-run2.csv`,
`sr800-phase-timing-2026-07-26.26-fan10-analysis.md`.

Both captures prove exact emitted pulses (`100 µs`, `0-1 µs` phase error) but fail continuity: each
has the same seven-index startup hole after pulse 16, and run 1 has a nine-index hole near shutdown.
Status correlates the gaps with `3-7 µs` same-edge observations and extra raw PCNT edges, which this
build needlessly turned into six-crossing requalification pauses. The fix contains sub-millisecond
bursts to at most one half-cycle and audits output continuity against accepted mains cycles.

### Build .28: Fan 10 continuity and first low-Heat proof

Files: `sr800-phase-timing-2026-07-26.28-analysis.md` (no CSV preserved here).

Four consecutive 3 s Fan `10.0` proofs pass: 359 of 359 records, zero gaps, every width `100 µs`, p99
phase error `0 µs`. Comparator chatter occurred and was absorbed with no effect on output continuity,
validating the observer that classifies zero-cross edges by hardware-timestamped interval and PCNT
delta rather than by edge polarity. The same analysis records the first hardware-audited Heater run
(Fan `3.0` / Heat `0.1`, 1,198 of 1,198 heater records valid) and one fan index gap traced to a
diagnostic-loop deadline racing the ISR deadline.

## Thermal

### First baseline air map (invalid)

Files: `sr800-thermal-2026-07-26-first-airmap-analysis.md` (no raw file).

The first empty-chamber Fan × Heat map with the probe at bean-bed height is preserved as invalid
because its settle rule (±5 °C held for 3 s) passed mid-transient: every step "settled" in about 13 s,
time constants came back at 3–8 s, and one Fan row decreased with Heat. A defect also left Fan 10
running after the program, destroying the passive-decay tail. It drove the narrow-band settle
defaults, the always-curve-fit analysis rule, and auto-stop after calibration Cooling. One usable
point survives: a forced-cooling time constant of about 94 s at Fan 10.

## Sample roast recording

| File | SHA-256 |
| --- | --- |
| `crackle-2026-08-02-manual-roast-log-28.crk` | `9b20b7f38d5754a856d409dcff3a8d31bcd6ea9d4e8648726a30b8a3cf072be7` |
| `crackle-2026-08-02-manual-roast-log-28.csv` | `24c3dd6623ba521c56902e57cff1c20cea18fefd068c4b3289c4555555c4335c` |

A Manual Roast recorded by Crackle on an SR800, in the controller's compact `.crk` archive format
and as the equivalent 1 Hz CSV (`t_ms, thermocouple_c, cold_junction_c, effective_fan,
effective_heat`; 1,360 samples). Heat runs at levels 5–10 with Fan between 1 and 10 for about 16:47,
followed by a Fan 10 cooling tail to 22:39. Bean temperature crosses 223 °C at 14:53 and peaks at
225.0 °C at 15:52. The log begins at 53.5 °C with the chamber already warm, so it also illustrates
the warm-start case that calibration fitting excludes; see
[`docs/control-and-calibration.md`](../../docs/control-and-calibration.md).
