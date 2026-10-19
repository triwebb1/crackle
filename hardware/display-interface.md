# Display interface

The SR800's four-digit display is driven by the PIC16F690 through a TI 74HC164 shift register
(eight outputs: seven segments plus decimal point) and four digit-select transistors. Snooping the
shift register's serial input and clock recovers everything the display shows, from four wires
instead of twelve LED lines. This was the first instrument built during
[reverse engineering](reverse-engineering.md); Crackle itself does not use the display, but the
decode documents the factory state machine. The capture firmware is
[`firmware/sniffer`](../firmware/sniffer/README.md).

## Signals

- 74HC164 serial data (pins 1 and 2) and clock (pin 8).
- Active-low clear (pin 9), captured to check whether it frames transfers (it does not).

Continuity measured on this board confirms U2B pins 1 and 2 are factory-tied together. They are one serial-data node. The first sniffer keeps independent divider taps on both legs as a validation channel; captured A and B should match.

## Four-dash baseline

The sniffer captured 2,048 complete transfers while the display showed four dashes. The raw data and full analysis are under `data/captures/`.

- `0xFF` appears as a coherent ten-refresh startup blank.
- `0xBF` occupies 92.432% of the capture and is the strong dash-pattern candidate.
- The `0x40` mask is the only difference between blank and dash, so that captured bit likely controls the center segment and is active low.
- Median digit-slot interval is 2.017 ms. Four slots imply an approximately 124 Hz full-display refresh.
- CLR stayed high in all complete events and did not frame normal transfers.
- A and B matched in 98.730% of complete bytes, but software capture still produced isolated corrupt bytes and omitted groups.

The passive stream is usable through repetition and confidence filtering, not as a bit-perfect single-frame source.

## Stable 993.0 baseline

The second preserved capture produces a decisive left-to-right four-byte cycle:

| Phase | Display | Byte |
| ---: | --- | --- |
| 0 | `9` | `0x90` |
| 1 | `9` | `0x90` |
| 2 | `3.` | `0x30` |
| 3 | `0` | `0xC0` |

Timing-aware phase recovery matches this cycle in 1,981 of 2,048 complete events (96.729%). A/B disagree in only 10 rows (0.488%). The result confirms the standard active-low segment masks A=`0x01` through G=`0x40`, with decimal point=`0x80`. Plain `3` is therefore `0xB0`; applying the point clears bit `0x80` and produces the observed `0x30`.

The machine-readable observed and provisional map is `hardware/display-glyph-map.json`. Cooling directly observes `C = 0xC6` and `C. = 0x46`.

The temporary harness does not tap digit-select lines. Distinct stable glyphs prove that four phases can be recovered from the approximately 2.016 ms slot cadence. Add digit-select observation only if timing lock proves inadequate during blinking or state transitions.

## Blink and edit semantics

The selected setting blinks during Edit. Encoder rotation takes effect immediately. In the observed non-running state, selection blinking persists without an inactivity timeout.

The decoder uses two time scales:

1. A short frame window decodes the currently visible four glyphs.
2. A longer envelope window detects coherent, periodic alternation between a valid glyph and `0xFF` in one field.

A blink-off interval does not replace the effective value with blank. The decoder retains the last confidence-qualified nonblank glyph, sets the corresponding `blink_mask`, and reports the selected field separately. Fan uses phase 0 (`0b0001`), Power uses phase 1 (`0b0010`), and Timer is one fixed-point `X.X` value spanning phases 2 and 3 (`0b1100`).

Isolated blank or corrupt samples do not constitute blinking. Edit is reported only after repeated phase-aligned on/off runs establish a cadence.

The Fan-9 and Fan-8 selection captures verify this model. Display phase 0 alternates between the retained Fan glyph (`0x90` or `0x80`) and `0xFF`, while phases 1 through 3 remain stable. Both captures measure a median half-period of 0.491904 s and a full period of 0.983808 s. The Fan-8 capture directly observes digit 8 as `0x80`. The decoder should allow timing tolerance for omitted transfers while requiring multiple coherent runs before asserting `edit_selection = FAN`.

The Power-9 capture shows phase 1 alone alternating between `0x90` and `0xFF`. The Timer-3.0 capture shows phases 2 and 3 alternating together between `[0x30, 0xC0]` and `[0xFF, 0xFF]`; their approximately 6.043 ms transition separation is their normal sequential slot timing, not independent blinking. Every selected field uses the same 0.491904 s median half-period.

## Operating heartbeat and mode signatures

Edit selection and operating heartbeat use different byte-level behavior:

| Mode signal | Phase-2 behavior | Other selected phases |
| --- | --- | --- |
| Timer Edit | Complete Timer glyph alternates with `0xFF` | Phase 3 also alternates with `0xFF` |
| Heating/running | Numeric whole-minute glyph remains; only DP bit `0x80` toggles | Tenths remains numeric and counts down |
| Cooling | `C` remains; only DP bit toggles between `0xC6` and `0x46` | Phase 3 carries the Cooling value |

The running `0.4` capture toggles phase 2 between `0xC0` and `0x40` while phase 3 changes from 4 (`0x99`) to 3 (`0xB0`). The Cooling capture toggles phase 2 between `C` (`0xC6`) and `C.` (`0x46`) while phase 3 remains 3 (`0xB0`). The heartbeat half-cycle is approximately 0.492 s.

Decoder precedence is: a confidence-qualified `C` glyph identifies Cooling first; complete-field `0xFF` alternation identifies Edit; numeric Timer with DP-only heartbeat and countdown identifies Heating/running. Isolated DP or glyph errors do not change mode.

Natural Cooling completion is observed as `C.1 -> C.0 -> fan stops -> ----`. A stable four-dash frame is `[0xBF, 0xBF, 0xBF, 0xBF]` and returns the display state to Standby after consensus; the brief `C.0` interval remains Cooling.

## Decode model

1. Shift A and B independently on each captured rising clock edge.
2. Reject complete bytes where A and B disagree.
3. Align the repeating stream into four digit phases and vote over repeated frames.
4. Associate each phase with its stable segment pattern; tolerate isolated omissions without shifting phase permanently.
5. Map only known-state consensus patterns to `0-9`, `C`, decimal point, blank, dash, and other symbols.
6. Preserve raw bytes, decoded frame, confidence, and blink timing.
7. Decode ordinary phases as Fan, Power, Timer whole minutes with decimal point, and Timer tenths; publish Timer as one `X.X` minute value.
8. Interpret the ordinary layout versus Cooling `C.3` only after several consistent frames.
9. Report `UNKNOWN` when framing or glyph confidence is inadequate.

## Electrical isolation

The sniffer's dividers make it part of the potentially mains-referenced factory logic domain. It
runs from a non-charging battery inside a non-conductive enclosure and has no wired connection to
anything else while the roaster is powered. Optocouplers such as the PC817 are too slow for the
serial clock, so a permanent isolated display tap would need high-speed isolators or a small
factory-side decoder MCU; neither is needed by the selected power-stage interface.

## Cooling detection

Cooling is detected by displayed symbols, not merely a local countdown. The verified marker is `C.3` at Cooling entry. Separate `C.2` and `C.1` captures are unnecessary because the `C/C.` prefix identifies Cooling and the trailing digit uses the established numeric glyph map; the editable `C.1`-`C.3` bounds are observed.

The decoder reports both raw frame and interpreted mode so a bad symbol map remains diagnosable.
