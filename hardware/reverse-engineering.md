# Reverse engineering the SR800

How the Fresh Roast SR800's control electronics were studied, and how that evidence chose the
interface Crackle uses today. The goal was full software control of fan and heater, with three
constraints that ruled out the easy routes:

- **Non-destructive.** The UI board stays installed. Its rotary encoder and printed control face
  make removal destructive, so every measurement was made in place, from photographs, visible IC
  pins, and accessible solder joints.
- **Factory controls keep working.** Nothing is cut and the factory firmware is not replaced.
  With the controller unpowered or idle, the roaster behaves exactly as shipped.
- **The logic domain is hazardous.** The factory low-voltage logic shares a reference with a
  mains-powered power stage, and no complete isolation path is visible. Every instrument attached
  to it is treated as potentially mains-referenced: battery-powered, enclosed, wireless, and never
  connected to a computer while the roaster is plugged in.

The raw captures behind every number here are in [`../data/captures/`](../data/captures/README.md).

## 1. Teardown

![SR800 internal board stack](images/sr800-board-stack.jpg)

Photographs of both board stacks established the topology ([board teardown](board-teardown.md)):

| Block | Finding |
| --- | --- |
| UI controller | `U3B` is a Microchip **PIC16F690-I/SO** (20-pin SOIC). |
| Display driver | `U2B` is a TI **74HC164** serial-in/parallel-out shift register: eight outputs for seven segments plus decimal point. |
| Digit multiplex | Four SOT-23 transistors `Q2B`–`Q5B` beside the display traces drive four digits. |
| Power board | Mains spades (`L`/`N`), heatsinked TO-220 power switches (`Q1A`/`Q2A`), a 0.1 µF / 400 V film capacitor, an optocoupler-style package (`U1A`), and a six-pad low-voltage interconnect beside `12V` / `GND` silkscreen. |
| Controls | Five electrical actions: encoder A/B, encoder push, Run/Cool, On/Off. |

That left five candidate control points, each with a different cost:

| Approach | What it would take | Outcome |
| --- | --- | --- |
| Front-panel emulation | Optocoupler "presses" on five contacts, plus decoding the display to confirm each press | Workable but slow and stateful: blink-mode navigation, timer bounds, and the stock Cooling sequence all stand between a command and its effect. Kept as a fallback only. |
| Display snooping | Passive capture of the 74HC164 bus | Gives state, not control. Built first, because it was safe and taught the factory state machine. |
| PIC firmware dump (ICSP) | Programmer on VDD/MCLR/ICSPCLK/ICSPDAT | Stops the running firmware; a read-only dump is the only use, and code protection may block it. Not pursued. |
| Harness protocol | Decode traffic between UI and power boards | Turned out to be discrete trigger lines, not a protocol (below). |
| **Direct power-stage control** | Reproduce the PIC's fan/heater trigger commands downstream of the PIC | **Selected.** Deterministic, low latency, and invisible to the factory firmware. |

## 2. A passive display sniffer

The first instrument was a spare ESP32-S3-Zero running [`firmware/sniffer`](../firmware/sniffer/README.md),
wired input-only to the 74HC164's clock, both serial-data inputs, and its clear pin through
20 kΩ / 33 kΩ dividers (5 V logic → ~3.1 V). It ran from a non-charging battery inside a
non-conductive enclosure and served captures over Wi-Fi.

```text
U2B signal pin ---- 20 kΩ ----+---- ESP32 GPIO        (input only, never driven)
                              |
                            33 kΩ
                              |
U2B pin 7 (GND) --------------+---- ESP32 GND         (battery-powered ESP32)
```

Ten captures decoded the display completely ([display interface](display-interface.md)):

- Segment bytes are **active-low**, A = `0x01` … G = `0x40`, decimal point = `0x80`. A stable
  `993.0` decodes as `90 90 30 C0`; four dashes are `BF BF BF BF`.
- One digit slot every ~2.017 ms gives a ~124 Hz full-display refresh. The clear line never frames
  transfers, so digit phase is recovered from slot timing and voted across frames.
- The two serial inputs are factory-tied; sampling both gives a free integrity check (98.7 % byte
  agreement under software capture, which is why the decoder votes rather than trusting single frames).
- **Edit mode** blinks a whole field against blank (`0xFF`) with a 0.492 s half-period; **running**
  toggles only the decimal point of the timer digit; **Cooling** shows `C` / `C.` (`0xC6` / `0x46`).

The sniffer's decoder (with host-side replay tests against the captured CSVs) reports Standby,
Heating, Cooling, Edit selection, and the Fan / Power / Timer values with a confidence score. The
work established the stock state machine in detail, and also showed that driving the roaster
through its panel would mean steering a modal UI blind between display confirmations. That pushed
the search downstream, toward the signals the PIC sends to the power board.

## 3. Finding the power-stage commands

Trace following on the UI board found four PIC pins (8, 9, 11, 12) routed to the six-pad
interconnect. Their peripheral names on the datasheet (SPI, EUSART) suggested a bus; the
captures showed something simpler. The same sniffer hardware, re-pointed at those pins, captured
fixtures at Fan 1 / Power 1, Fan 9 / Power 1, and Fan 9 / Power 9 through startup, Heating, and
Cooling ([power-stage interface](power-stage-interface.md)).

| PIC pin | Role | Evidence |
| ---: | --- | --- |
| 11 | **Heater command** | 11–13 µs positive trigger pulses, one per mains half-cycle; disappear the instant Cooling begins. |
| 12 | **Fan command** | Same pulse shape; continue through Cooling. |
| 17 | **Zero-cross reference** | Continuous ~60.03 Hz square wave: one edge per mains half-cycle (~120 edges/s). |
| 10 | Display digit select | ~124 Hz, not mains-synchronous. |
| 8, 9 | Unused in every observed state | Pin 8's single burst was threshold noise. |

The key finding: **output level is encoded by firing phase, not pulse width.** These are TRIAC
gate triggers for classic phase-angle control. Measured relative to the pin-17 edge:

| State | Trigger delay after zero cross |
| --- | ---: |
| Power 9 (heater), settled | ≈ 0.80 ms |
| Power 1 (heater) | ≈ 2.82 ms |
| Fan 9, Heating | ≈ 1.48 ms |
| Fan 9, Cooling | ≈ 1.95 ms |
| Fan 9 soft start | 2.14 → 1.48 ms over ≈ 0.5 s |

Run/Cool removes heater triggers immediately while fan triggers continue without a gap, then the
fan settles to a gentler Cooling phase about 110 ms later.

## 4. Why not just drive the PIC pins

The obvious next step, holding the PIC in reset and driving pins 11/12 directly, failed in an
instructive way:

1. Pulling U3B pin 4 (MCLR) low through 1.5 kΩ did **not** reset the PIC. The display kept
   refreshing; only the On/Off button stopped responding. The PIC16F690's configuration word can
   turn MCLR into the ordinary RA3 input, and this firmware does exactly that.
2. A bounded 3-second static-high test into pin 12 measured ~0.13 V on the net, but the full 3.3 V
   with the wire disconnected. The output was fine; the running PIC was sinking it. This was
   contention, not a missing enable.

Lifting a PIC leg, erasing the PIC, or cutting traces would all have worked electrically, and all
were rejected because they break the factory controls. A powered measurement then found a better
node: downstream of each PIC pin, a factory transistor's collector idles at about **+12 V** and is
pulled low on each trigger pulse. The power board's command inputs are **active-low,
open-collector**.

That makes the interface trivial and safe: put an optocoupler output **in parallel** with each
factory transistor.

```text
            factory side                          controller side
  +12 V command node (idle high)
          │
          ├────────── PC817 pin 4 (collector)     PC817 pin 1 (LED anode) ── 470 Ω ── ESP GPIO3/4
  factory │                                       PC817 pin 2 (LED cathode) ───────── ESP GND
  transistor
          ├────────── PC817 pin 3 (emitter)
          │
     logic GND
```

With the ESP output low, unpowered, or in reset, the PC817 is open and the roaster is stock. With
it high, the PC817 duplicates the factory transistor's pull-down. Overlapping pulses cannot fight
(both only pull low); the earlier trigger simply wins, so the controller watches pin 12 to detect
manual use (below).

## 5. Power: the factory rail was not enough

Powering the ESP32 from the factory 5 V logic rail produced hundreds of boot attempts and visibly
dimmed the display in rhythm with them: the rail could not carry the ESP32's load. The ESP
runs from a **dedicated isolated 5 V USB charger** and shares factory logic ground only as a signal
reference. Because of that shared ground, the PC817s are an open-collector interface, not a
galvanic barrier, and the no-computer-USB-with-mains rule applies to the installed controller
permanently.

## 6. Reproducing the waveform in hardware

Firing a TRIAC at a precise phase every 8.33 ms sounds easy. It took several rounds of
instrumented captures, each disproving a plausible design:

| Design | Measured result |
| --- | --- |
| GPTimer alarm callback | All pulses emitted, but p99 lateness 128 µs, max 285 µs, and an exact 125 µs latency "shelf". |
| Continuously running absolute-deadline GPTimer | Accumulated phase error gone; the 125 µs shelf remained (p99 147 µs). |
| Same, Wi-Fi modem sleep disabled | Distribution unchanged, so Wi-Fi sleep was not the cause. |
| **MCPWM comparators synchronized to zero cross** | **Hardware raises and lowers every 100 µs pulse. 359 of 359 pulses reconciled against independent rise/fall captures and PCNT edge indices; phase error −1…0 µs.** |

The accepted design has no ISR in the timing path: one 1 MHz MCPWM timer, synchronized by the
GPIO6 zero-cross capture, with independent Fan and Heat comparators whose shadow registers commit
atomically at sync. A PCNT counter provides an independent physical edge index, so a coalesced or
missed callback can never make an incomplete waveform look complete.

Two further hardware behaviors shaped the zero-cross policy ([safety policy](../firmware/safety-policy.md#zero-cross-observation-and-the-coast-policy)):

- **Flash blackouts.** A flash erase/program stalls the cache and blacks out capture callbacks for
  up to ~58 ms with no physical loss of the mains reference. PCNT deltas distinguish the two (a
  blackout's delta equals the elapsed half-cycles; real loss shows 1). Short gaps now *coast* on
  the retained command; flash writes are only allowed while outputs are idle.
- **Comparator chatter.** The zero-cross input produces bursts of edges 2–7 µs apart at real
  transitions. Harmless to the hardware sync, but callbacks coalesce under a burst, so a
  callback's reported polarity can belong to a chatter edge. Polarity-alternation checks therefore
  caused false aborts (audible fan "blips"); edges are now classified only by hardware-timestamped
  interval (< 6 ms ignored, 6–11 ms valid, longer gaps coast or abort).

The MCPWM period is 12 ms: longer than any valid half-cycle (real intervals alternate around
8.76 / 7.91 ms), so the timer never stops mid-operation, yet both outputs park low within 12 ms if
sync disappears.

PC817 LED pulses of 100 µs were proven reliable at both fan endpoints. The factory's 11–13 µs
pulses do not transfer directly, because the optocoupler adds propagation and storage delay.

## 7. Mapping levels 0–10

Crackle exposes continuous Fan and Heat levels `0.0`–`10.0`. Both map to firing delays by
interpolating **estimated delivered power** between measured factory endpoints, rather than
interpolating delay linearly (phase-angle power is strongly non-linear in delay).

- **Heat** spans factory Power 1 (2,820 µs) to Power 9 (800 µs).
- **Fan** spans a reconstructed factory Fan 1 (4,460 µs) to a ceiling chosen **acoustically**.
  Phone recordings of the blower were analysed for the dominant blade-pass tone (Welch PSD, tracked
  500 Hz–5 kHz) as a relative speed proxy that is immune to microphone gain
  ([analysis](../data/audio/fan-calibration-2026-07-25/README.md)). The controller's low endpoint
  matched factory Fan 1 within 0.7 %, and a raw delay matching factory Fan 9 within 0.34 % became
  public Fan 10.0, so the controller never spins the blower faster than the factory maximum.
- Fan starts follow the factory's ~0.5 s soft start, inside the mandatory 500 ms fan
  qualification that precedes any heat.

## 8. Temperature

The stock roaster has no bean-temperature measurement. Crackle adds a MAX31856 thermocouple
converter (K-type, 60 Hz rejection, open-circuit detection) on SPI. The probe passes through a hole
drilled in the chamber lid and is held by mechanical stops at bean-bed height, clear of the glass
and metal parts, so that during a roast it reads the fluidized beans rather than exhaust air or
the perforated base. Probe placement changes readings materially; recordings made at different
probe positions are not comparable.

## 9. Manual-use interlock

The controller keeps one passive divider on PIC pin 12. A factory fan command is a train of short
pulses 8.33 ms apart; if a train spans 50 ms while the controller is active, the controller drops
both outputs, aborts its program, and latches itself disabled until power is cycled. Every factory
Heating or Cooling state includes fan pulses, so this one channel detects any manual operation.

## What carried over

| Lesson | Where it lives now |
| --- | --- |
| Measure the boundary before choosing an architecture | Every interface decision above cites a capture in `data/captures/`. |
| Prefer a node you can parallel over one you must override | PC817s in parallel with factory transistors; factory controls untouched. |
| A plausible software timer is not a timing proof | MCPWM hardware generation, audited by independent capture and PCNT indexing. |
| Callback evidence can lie; physical counters do not | PCNT edge deltas classify blackouts vs. signal loss. |
| A shared ground is not isolation | Isolated supply, open-collector interface, and the no-USB-with-mains rule. |

## Further reading

- [Board teardown](board-teardown.md): component identification and PIC pin roles.
- [Power-stage interface](power-stage-interface.md): measured signals and the selected interface.
- [Display interface](display-interface.md): the 74HC164 bus decode.
- [Installation](installation.md): building and wiring the controller.
- [Safety policy](../firmware/safety-policy.md): the invariants the firmware enforces on top of this hardware.
