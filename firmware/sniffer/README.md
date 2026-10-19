# SR800 display sniffer

`sr800_sniffer` is the passive, input-only firmware used to reverse-engineer the SR800 control
board's display bus. It observes four pins of `U2B`, the TI 74HC164 shift register on the SR800 UI
board, captures the serial byte stream, and decodes the live display state. It never configures an
SR800-connected GPIO as an output and cannot press controls or change roaster operation.

The captures it produced, and their analyses, are in [`data/captures/`](../../data/captures/README.md);
the protocol findings are in [`hardware/display-interface.md`](../../hardware/display-interface.md).

## Required parts

- Waveshare ESP32-S3-Zero.
- 4 × 20 kΩ and 4 × 33 kΩ resistors, 1/8 W or 1/4 W. Measured values within about 5% are fine.
- Fine insulated wire and heat-shrink.
- A USB battery pack that is not charging during capture and has verified always-on output. Some
  packs shut down after about a minute at the sniffer's low current.
- A nonconductive enclosure large enough for the ESP32, divider board, battery, and exposed joints.

## Safety boundary

Once ESP32 GND is connected to U2B pin 7, the ESP32, USB cable, battery pack, divider board, and
every exposed joint must be treated as **potentially mains-referenced**: the factory logic ground is
not isolated from mains.

During a powered-roaster capture:

- The battery pack is not charging.
- Nothing is connected to a PC, charger, oscilloscope, programmer, or USB analyzer.
- The sniffer is enclosed before the roaster is plugged in.
- Do not touch the sniffer, battery, wires, or SR800 internals.
- Unplug the roaster before opening the enclosure or changing wiring.

USB flashing happens only with the roaster unplugged from mains for the entire USB session.

## Wiring

Identify U2B pin 1 by its molded dot. SOIC pins count counterclockwise viewed from the top of the
package. With U2B horizontal and the dot at the lower left (the PIC is toward the lower edge):

```text
             14  13  12  11  10   9   8
            +--------------------------+
            |           U2B            |
          o +--------------------------+
              1   2   3   4   5   6   7
```

Pin 1 is the lower-left leg beside the dot, pin 7 the lower-right leg, pin 8 the upper-right leg
directly above pin 7, and pin 9 the next upper leg to its left.

| SR800 source | Series resistor | ESP32 junction | Shunt resistor |
| --- | --- | --- | --- |
| U2B pin 8, CLK | 20 kΩ | GPIO4 | 33 kΩ from the GPIO4 junction to U2B pin 7 |
| U2B pin 1, serial A | 20 kΩ | GPIO5 | 33 kΩ from the GPIO5 junction to U2B pin 7 |
| U2B pin 2, serial B | 20 kΩ | GPIO6 | 33 kΩ from the GPIO6 junction to U2B pin 7 |
| U2B pin 9, active-low CLR | 20 kΩ | GPIO7 | 33 kΩ from the GPIO7 junction to U2B pin 7 |
| U2B pin 7, factory GND | none | ESP32 GND | Common lower end of all four 33 kΩ resistors |

Each signal channel is a divider:

```text
U2B signal pin ---- 20 kΩ ----+---- ESP32 GPIO
                               |
                             33 kΩ
                               |
U2B pin 7 ---------------------+---- ESP32 GND
```

The divider produces about 3.1 V from a 5.0 V factory logic high, and about 3.4 V at the PIC16F690's
5.5 V maximum operating supply.

Do not connect U2B pin 14, ESP32 `3V3`, or ESP32 `5V` to each other. The ESP32 is powered only
through USB-C from the isolated battery pack.

### Assembling the divider harness

1. On a small piece of perfboard, make a common ground rail. Solder a wire from U2B pin 7 to the rail
   and another from the rail to an ESP32 `GND` pad.
2. Connect one end of all four 33 kΩ resistors to the rail.
3. For each channel, make a three-way solder junction: one 20 kΩ lead (whose other end goes to the
   U2B pin), one 33 kΩ lead, and one wire to the ESP32 GPIO pad. Resistors are not directional.

The ESP32-S3-Zero `5V` and `GND` silkscreen labels are easy to misread. Before applying power, use
continuity mode to verify that U2B pin 7 and the common ends of all four 33 kΩ resistors connect to
an actual ESP32 `GND` pad. A `5V` connection turns the pull-downs into pull-ups and invalidates every
reading.

## Build and flash

The sketch is in `firmware/sniffer/sr800_sniffer/` and builds with `arduino-cli` and the Espressif
ESP32 Arduino core 3.x. Its sketch-local `partitions.csv` provides two 1.25 MiB OTA application
slots.

```powershell
arduino-cli compile `
  --fqbn 'esp32:esp32:waveshare_esp32_s3_zero:PartitionScheme=custom,EraseFlash=none' `
  --build-path build/sniffer `
  firmware/sniffer/sr800_sniffer
```

The first install is over USB:

1. **Unplug the roaster from mains** and disconnect the ESP32 battery. A soldered harness may stay
   installed, but mains must stay unplugged for the entire USB session.
2. Hold the ESP32 `BOOT` button while connecting USB-C to the computer, then release it.
3. Upload with `arduino-cli upload --fqbn <same FQBN> --port <port> --input-dir build/sniffer`, then
   press RESET. The native USB port may re-enumerate under a new name.
4. At 115200 baud the serial console reports `SR800 sniffer ready` and `192.168.4.1`.
5. Before any SR800 connection, join the `SR800-Sniffer` access point (password `freshroast`) and
   open `http://192.168.4.1`.
6. Disconnect USB and power before soldering or connecting the harness.

### Home Wi-Fi

From `http://192.168.4.1`, enter the home network under Network and press Connect. When
`station_connected` is `true`, the sniffer is reachable at `http://sr800-sniffer.local` (or the
reported `station_ip`). The recovery access point turns off 15 seconds after the home connection is
stable and returns after 15 seconds of LAN loss. Credentials are stored in ESP32 preferences, never
in source, serial output, or status; Forget removes them. Uploads preserve them unless flash erase
is enabled.

### Wireless updates

Later builds install over Wi-Fi with the roaster unplugged and the ESP32 on battery: open
`http://sr800-sniffer.local/update` and upload only the application `.bin` (never a merged,
bootloader, or partition image). The updater writes the inactive slot, validates the complete image
with `esp_ota_end`, and calls `esp_ota_set_boot_partition` only after validation succeeds, so power
or Wi-Fi loss before that commit leaves the running firmware selected. Afterwards,
`ota_running_partition` and `ota_next_partition` in `/api/status` should have exchanged `app0` and
`app1`.

This protects against an interrupted transfer, not against a valid but defective image. Images are
not signed, and the updater has no login beyond access to the home LAN or recovery AP.

## Capture procedure

1. Roaster unplugged, ESP32 unpowered.
2. Connect the five factory-side wires and four divider outputs exactly as listed. Inspect for
   solder bridges, exposed conductor, and strain on U2B legs.
3. Put the sniffer and battery in the nonconductive enclosure, connect the battery, and close it.
4. Plug in and operate the SR800.
5. From a device on the home LAN, open `http://sr800-sniffer.local` (use the recovery AP only when the
   LAN is unavailable).
6. Confirm `firmware_version` matches the source (`2026-07-24.1`), `clock_edge_mode` is `rising`, and
   `signal_interrupts_attached` is `true`.
7. Press **Clear & arm capture**, perform one known SR800 action, then press **Freeze capture**.
8. Confirm the transition counters changed and press **Download CSV**.
9. Capture separate files for startup, one encoder detent each direction, encoder press, On/Off,
   Run/Cool, a timer change, timer zero into `C.3`, and Cooling completion.
10. Unplug the SR800 before opening anything; disconnect the battery only after the roaster is
    unplugged.

## Reading the results

- Byte capture is bounded: it stops after 2,048 byte events or 32,768 rising clock edges.
  `capture_complete` and `capture_stop_reason` say which. Signal diagnostics keep running afterward.
- GPIO4 uses a hardware-qualified rising-edge interrupt. A and B are sampled only at each clock
  rise, exactly when the 74HC164 accepts them, so their change counters describe sampled serial data.
  `diagnostic_clock_falls` is intentionally `null`: classifying both edges by reading a short pulse
  after a `CHANGE` interrupt is unreliable.
- `clock_last_period_us`, `clock_min_period_us`, and `clock_max_period_us` measure the interval
  between qualified rising edges.
- `diagnostic_a_b_disagreements` should stay zero because factory U2B pins 1 and 2 are tied
  together; a nonzero value indicates sampling noise or a wiring problem. `effective_and_hex` is the
  A AND B bitstream the 74HC164 accepts.
- `clock_level`, `a_level`, `b_level`, and `clear_level` are instantaneous snapshots; use
  `diagnostic_clock_rises` to prove clock activity.
- Many `incomplete_groups` means the **Gap us** threshold is too short. Zero clock edges usually
  means wrong clock wiring, inadequate logic-high voltage at the divider, or no display activity.
- `boot_count` and `reset_reason` distinguish power loss, brownout, watchdog, and software failures.

Keep a new CSV in `data/captures/` only when it shows behavior the existing replay fixtures do not.

## Live display decoder

The decoder (`sr800_display_decoder.h`) runs continuously, independent of the bounded raw capture.
`/api/display` returns the interpreted state, effective values, visible bytes, phase lock, frame
confidence, edit selection, freshness, and decoder telemetry.

It rejects A/B disagreements and samples taken while CLR is active, advances digit phase from
measured elapsed slot time, and votes in 120 ms windows. It preserves effective values through
regular blink-off intervals, distinguishes complete-field Edit blinking from the decimal-point-only
operating heartbeat, and requires repeated evidence before declaring `STANDBY`, `HEATING`, or
`COOLING`. Input older than 750 ms becomes `UNKNOWN`. An isolated stable numeric capture can report
Fan, Power, and Timer values while leaving the mode `UNKNOWN`; a heartbeat, Cooling `C/C.`, or
four-dash consensus is required to establish the base mode.

[`tests/decoder_replay_test.cpp`](tests/README.md) compiles the production decoder as ordinary C++
and replays the preserved SR800 captures, checking Standby, stable values, each Edit selection,
Heating, Cooling, stale-input fallback, and A/B-disagreement rejection.

## HTTP routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/` | GET | Capture and diagnostics page. |
| `/api/status` | GET | Raw runtime diagnostics. |
| `/api/display` | GET | Decoded display state. |
| `/api/events` | GET | Captured byte events. |
| `/capture.csv` | GET | Capture download. |
| `/api/clear`, `/api/freeze` | POST | Arm a new bounded capture; stop capture and keep events. |
| `/api/gap` | POST | Set the byte-grouping gap threshold (`us`, default 40). |
| `/api/wifi`, `/api/wifi/forget` | POST | Store or remove home Wi-Fi credentials. |
| `/update` | GET, POST | Firmware update page and application upload. |
