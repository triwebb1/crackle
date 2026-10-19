# Safety checklist

Run this checklist after installation, after any hardware rework, and before trusting a new
firmware build with a roast. It verifies the electrical boundary and the firmware invariants in
[the safety policy](../firmware/safety-policy.md) on the real machine.

## Power off: wiring

- [ ] Roaster mains, controller supply, and computer USB are all disconnected before soldering or
      continuity tests.
- [ ] No ESP32 GPIO is wired directly to U3B pin 11 or pin 12.
- [ ] Nothing pulls U3B pin 4 low (it is RA3 in this PIC configuration, not reset).
- [ ] PC817 package marks and pins 1–4 match the purchased part's datasheet.
- [ ] Each PC817 pin 3 goes to its factory transistor's emitter (logic ground).
- [ ] Each PC817 pin 4 goes to the matching transistor's collector/output pad, not to the +12 V rail.
- [ ] GPIO3 and GPIO4 each have a 33 kΩ pull-down to ESP ground (measure ≈ 33 kΩ).
- [ ] Neither unpowered PC817 collector–emitter path conducts.
- [ ] GPIO5 and GPIO6 each use a complete 20 kΩ / 33 kΩ divider.
- [ ] MAX31856 `VIN` is on ESP `3V3`; module `3Vo` is unconnected; SPI and `DRDY`/`FLT` match the
      [pin map](installation.md#pin-map).
- [ ] Probe sheath-to-`T+` and sheath-to-`T-` resistance is measured and recorded.
- [ ] Wiring is strain-relieved, insulated, and cannot reach mains, moving, or hot parts.

## Power and access

- [ ] The dedicated isolated charger is the only controller supply.
- [ ] U3B pin 1 and every factory 5 V point remain disconnected from ESP `5V`.
- [ ] ESP `GND` connects to U3B pin 20 as the signal reference.
- [ ] No 12 V connection reaches ESP `5V`, `3V3`, or a GPIO.
- [ ] **No computer USB, serial adapter, programmer, oscilloscope, or grounded instrument is
      connected while mains is present.**
- [ ] The controller and its wiring are inside the enclosure and inaccessible during operation.

## Power on: status

With the factory display at four dashes (Standby):

- [ ] `/api/status` reports the expected firmware version, `actuator.fault` = `none`, and
      `manual_conflict_latched` = `false` after a power cycle.
- [ ] Zero-cross is qualified and healthy.
- [ ] The MAX31856 reports configured, no fault, and plausible hot- and cold-junction readings.
- [ ] Warming the probe tip makes the reading rise.
- [ ] Controller uptime is stable and the factory display brightness is undisturbed.
- [ ] Factory display and controls are unaffected by controller Wi-Fi activity.

## Actuation

- [ ] Fan 0.1 and Fan 10 each start cleanly (no rough pulsing or missed-cycle sound) and stop on
      command; PC817 outputs return open.
- [ ] Heat waits for 500 ms of established fan after every Heat-off-to-positive transition.
- [ ] A request for Heat with Fan below 1.0 is lifted to Fan 1.0.
- [ ] Every Stop path removes Heat immediately; at Heat-off the requested Fan takes effect
      immediately, including Fan 0. No hidden cooling timer appears.
- [ ] Stop remains reachable while a library transfer or recording download is in progress.

## Interlocks and faults

- [ ] Running the factory fan for longer than 50 ms while the controller is active shows the red
      `DISABLED` banner and latches `manual_conflict_latched`.
- [ ] While latched, every actuation request is refused until power is cycled; factory controls
      still work.
- [ ] If a thermocouple dropout can be reproduced safely, Heat is held off during the dropout and a
      sustained loss ends the operation with `sensor_lost`.
- [ ] A brief zero-cross disturbance does not end an operation; a sustained loss fails low and
      reports its reason.

## Soak

- [ ] A complete roast runs to completion with the browser closed, and its recording appears in
      History afterwards.
- [ ] Two browsers (for example a phone and a PC) can load the app together during a roast; both
      show the live trace, and Stop works from either.
- [ ] Settings → Advanced shows no worker failures, plausible live-subscriber counts, and non-zero
      stack low-water values after the soak.
- [ ] `/update` remains reachable and reports the installed version.
