# Power-stage interface

The SR800's PIC16F690 commands the blower and heater with short trigger pulses timed against the
mains zero crossing: classic TRIAC phase-angle control. Crackle reproduces those commands
downstream of the PIC, in parallel with the factory driver transistors, so that factory operation
is untouched whenever the controller is idle or unpowered. This page records the measured signals
and the selected interface. [Reverse engineering](reverse-engineering.md) tells how they were found.

## Measured factory signals

All delays are measured from the edge of U3B pin 17. Captures are in
[`../data/captures/`](../data/captures/README.md).

| Signal | Source | Characteristics |
| --- | --- | --- |
| Zero-cross reference | U3B pin 17 | Continuous ~60.03 Hz square wave; each edge marks a mains half-cycle crossing (~120.3 edges/s). Same-polarity edges repeat every 16.658 ms; opposite edges alternate around 8.33 ms. |
| Heater trigger | U3B pin 11 | ~11–13 µs positive pulse once per half-cycle. Removed immediately at Cooling entry. |
| Fan trigger | U3B pin 12 | Same pulse shape. Continues without a gap through Cooling. |
| Digit select | U3B pin 10 | ~124.02 Hz, not mains-synchronous. Not a timing source. |
| Pins 8, 9 | U3B | Inactive in every observed state. |

Level is encoded by **firing phase**, not pulse width:

| Factory state | Trigger delay |
| --- | ---: |
| Power 1 | ≈ 2.82 ms |
| Power 9 | ≈ 0.80 ms |
| Fan 9 (Heating, settled) | ≈ 1.48 ms |
| Fan 9 (Cooling, settled) | ≈ 1.95 ms |
| Fan 9 soft start | 2.14 → 1.48 ms over ≈ 0.5 s |

At Run/Cool, heater triggers stop without a gap in fan triggers; about 110 ms after the last heater
trigger the fan moves toward its Cooling phase.

## Command topology

With the display at four dashes (Standby), each factory command transistor's collector measures
≈ +12 V. A positive PIC pulse turns the transistor on and pulls its collector low. The power board's
fan and heater command inputs are therefore **active-low, open-collector** signals.

Driving the PIC pins themselves does not work: the running PIC actively drives pins 11/12 and sinks
any override (a 3.3 V drive through 470 Ω measured ≈ 0.13 V on the net). U3B pin 4 is configured as
the RA3 input, not MCLR, so the PIC cannot be held in reset either.

## Selected interface

One PC817C phototransistor output is placed in parallel with each factory command transistor:

```text
ESP32 GPIO3 (Fan) ── 470 Ω ──► PC817 #1 LED ──► ESP GND
                                   │
                    collector ─────┴──── emitter
                       │                    │
       fan transistor collector       fan transistor emitter
       (≈ +12 V idle)                 (factory logic GND)

ESP32 GPIO4 (Heat) ── same circuit ── heater transistor (U3B pin 11 channel)
```

| Property | Behavior |
| --- | --- |
| ESP output low, unpowered, or in reset | PC817 open; roaster behaves exactly as stock. 33 kΩ pull-downs hold GPIO3/4 low through boot. |
| ESP output high | PC817 pulls the command node low, duplicating the factory transistor. |
| Overlap with factory pulses | No electrical contention (both only pull low). The earliest trigger wins, so simultaneous factory and controller operation could add power; the manual-use interlock prevents it. |
| Pulse width | 100 µs LED pulse, proven at both fan endpoints. The optocoupler's propagation and storage delay make the factory's 11–13 µs width unsuitable. |
| PC817 rating | 35 V-class collector rating against a 12 V node. |

Two passive inputs complete the interface, each through a 20 kΩ / 33 kΩ divider (5 V → ~3.1 V):

| Input | Source | Purpose |
| --- | --- | --- |
| GPIO6 | U3B pin 17 | Zero-cross timing for the MCPWM pulse generator |
| GPIO5 | U3B pin 12 | Factory-fan monitor for the manual-use interlock |

## Manual-use interlock

A factory fan command is a train of pulses ~8.33 ms apart. When GPIO5 sees a train spanning at least
50 ms, whether or not the controller is running anything, the firmware forces both outputs low,
aborts any active program, and sets `manual_conflict_latched`. The latch has no software clear; it
resets only when the controller loses power. Factory controls keep working throughout because both PC817 outputs are
open. Every factory Heating or Cooling state includes fan pulses, so this single channel detects
any manual operation.

## Isolation boundary

The controller runs from a dedicated isolated 5 V USB supply and shares factory logic ground as its
signal reference. That shared ground makes the PC817s an open-collector interface rather than a
galvanic barrier. The factory logic domain is potentially mains-referenced, so:

- **Never connect computer USB, serial, a programmer, an oscilloscope, or any grounded instrument to
  the installed controller while roaster mains is present.**
- Never connect the factory 5 V rail to the ESP32 `5V` pin, and never connect anything to the `12V`
  rail.

Exact wiring is in [installation](installation.md).

## Considered and rejected

| Option | Why not |
| --- | --- |
| Drive PIC pins 11/12 directly | Contention with the running PIC. |
| Hold the PIC in reset | MCLR is configured as RA3; reset is not available from pin 4. |
| Lift a PIC leg, erase the PIC, or cut traces | Each works electrically but disables the factory controls. |
| Front-panel contact emulation | Slow, modal, and needs display decoding to confirm every action. |
| DC PWM blower drive | A power-stage redesign (rectifier, switch, EMI work) without a demonstrated benefit over phase control for this use. |
