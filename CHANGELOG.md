# Changelog

Firmware versions are `2026-07-26.NNN`: a fixed date prefix, then a build number that increases with
every build and is never reused, so published releases skip the numbers of unreleased builds. Web app versions follow
`web/package.json`. Each firmware release embeds exactly one web app version, and each release is the
tag `v<firmware version>`.

## 2026-07-26.129 / web 0.10.71

**Web app**

- Calibration fits heating-mode airflow (Fan cooling while heating) from the loaded roasts whenever
  they vary Fan at a constant Heat and the fit is stable, instead of always taking it from the
  empty-chamber baseline. An empty chamber reads that term several times weaker than a bean bed,
  so the Journey law, which inverts it to choose Fan, moved Fan far harder than the roaster needed:
  near the start of a slower final zone, a small correction swung Fan across its whole band and
  the bean temperature dipped. The baseline still pins heat-off cooling, and still pins
  heating-mode airflow for roasts that cannot resolve it. Refit and apply the calibration to use
  the corrected term; the Journey control law is unchanged.

## 2026-07-26.128 / web 0.10.70

First public release.

**Firmware (ESP32-S3)**

- Hardware-timed fan and heater phase control through the SR800's factory power stage, with fan
  qualification before heat, heat-on airflow floors, a sensor-freshness latch, a manual-use
  interlock, and firmware leases.
- A 260 °C overheat limit (a build-time constant): Heat off and locked out, then a Fan 10 cooldown
  that only Stop can end early.
- Device-run Timed, temperature-Journey, and Manual roasts that continue with no browser connected.
- On-device library (profiles, bean lots, calibrations, roast records) and compact binary roast
  recordings, with whole-library backup and restore.
- Native ESP-IDF network service with bounded lanes, a WebSocket live stream, and A/B OTA updates.

**Web app**

- Roast desk with a live chart, the plan the controller is following, and the levels it solves each
  second; phone-first layout down to 320 px.
- Profile workshop for timed and temperature-journey profiles, with simulation against the applied
  calibration.
- History with recorded curves, bean and profile, measurements, notes, and a 1–10 score.
- Bean lots, calibration from recorded roasts, a roast reference, and settings with diagnostics.
- New roasters start with two profiles: **Espresso Express**, a fast temperature journey to a dark
  espresso roast, and **Espresso Express (timed)**, a lighter espresso on a fixed schedule for
  150–200 g batches.
