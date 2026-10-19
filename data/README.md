# Data

Raw evidence behind the SR800 reverse-engineering, Crackle's actuator timing, and its thermal model.
Raw files are preserved byte-for-byte and listed with SHA-256 checksums; analyses sit beside them.

| Dataset | Contents |
| --- | --- |
| [`captures/`](captures/README.md) | Display-bus sniffer captures, power-stage trigger and zero-cross captures, MCPWM phase-timing proofs, the first air-map analysis, and a sample roast recording (`.crk` and `.csv`) |
| [`audio/fan-calibration-2026-07-25/`](audio/fan-calibration-2026-07-25/README.md) | Phone recordings comparing factory and ESP Fan settings, dominant-tone analysis, spectra, and the resulting fan-scale decisions |

How this evidence was used is described in
[`hardware/reverse-engineering.md`](../hardware/reverse-engineering.md),
[`firmware/actuator-core.md`](../firmware/actuator-core.md), and
[`docs/control-and-calibration.md`](../docs/control-and-calibration.md).

> **Safety.** The sniffer captures were taken with the ESP32 on an isolated battery. Never attach
> computer USB, serial, or grounded instruments to an ESP32 wired into the roaster while roaster mains
> is present; it shares the factory logic ground, which is potentially mains-referenced.
