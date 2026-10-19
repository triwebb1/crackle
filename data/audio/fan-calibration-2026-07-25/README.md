# Fan acoustic calibration (2026-07-25)

Phone recordings used to check the ESP fan drive against the factory controller, using the blower's
dominant tone as a relative speed proxy. The result fixed the upper end of Crackle's Fan scale; the
current mapping is described in [`firmware/actuator-core.md`](../../../firmware/actuator-core.md).

## Files

| Path | Contents |
| --- | --- |
| `raw/manual-1.m4a`, `manual-5.m4a`, `manual-9.m4a` | Factory controller at Fan 1, 5, 9 (Heating at Power 1) |
| `raw/esp-0.1.m4a`, `esp-1.0.m4a`, `esp-5.0.m4a`, `esp-8.9.m4a`, `esp-10.0.m4a` | ESP drive at raw commands 0.1, 1.0, 5.0, 8.9, 10.0 (fan only) |
| `raw/SHA256SUMS.txt` | SHA-256 of every original recording; verify with `sha256sum -c SHA256SUMS.txt` |
| `analysis/fan-tone-summary.csv` | Dominant tone per recording |
| `analysis/analysis.json`, `analysis/steady-analysis.json` | Per-recording intervals, band levels, steady-window tones and prominences |
| `analysis/fan-tone-calibration.png` | Tone versus setting for both controllers |
| `analysis/spectrograms.png`, `analysis/esp-8.9-spectrogram.png` | Spectrograms with the active and steady analysis windows marked (all recordings; ESP 8.9 alone) |
| `analysis/steady-psd-overlays.png` | Overlaid steady-state power spectra |

## Conditions

Eight recordings compare factory Fan 1, 5, and 9 with ESP commands 0.1, 1.0, 5.0, 8.9, and 10.0.
Every factory recording was made while Heating at Power 1, not in Cooling. The ESP recordings used
build `2026-07-24.11`, which could not energize the heater, so they are fan-only. ESP levels are that
build's raw command scale.

## Method

- Decode each 48 kHz stereo AAC recording to 48 kHz mono floating-point audio.
- Exclude startup and shutdown transients.
- Compute Hann-windowed Welch power spectra over the steady interval.
- Track the strongest persistent narrow fan tone between 500 Hz and 5 kHz.
- Use tone frequency as a relative rotational-speed proxy. Phone gain and amplitude are not used,
  because automatic gain control makes them incomparable.

The tracked tone rises smoothly through startup in every recording, so it is very likely fan or
blade-pass related. Its ratio is useful for relative speed; it is not an absolute RPM or airflow
measurement without blade count and an airflow calibration.

## Results

| Condition | Dominant fan tone | Position within ESP 0.1-to-10 tone span |
| --- | ---: | ---: |
| Factory Fan 1, Power 1 | 889.16 Hz | approximately 0 % |
| ESP 0.1 | 895.02 Hz | 0 % reference |
| ESP 1.0 | 1483.89 Hz | 25.8 % |
| Factory Fan 5, Power 1 | 2488.77 Hz | 70.0 % |
| ESP 5.0 | 2676.27 Hz | 78.2 % |
| ESP 8.9 | 3052.73 Hz | 95.0 % |
| Factory Fan 9, Power 1 | 3062.99 Hz | 95.2 % |
| ESP 10.0 | 3172.85 Hz | 100 % reference |

Pairwise tone ratios:

| Pair | Ratio | Difference |
| --- | ---: | --- |
| ESP 0.1 / Factory Fan 1 | `1.0066` | about 0.7 % faster |
| ESP 5.0 / Factory Fan 5 | `1.0753` | about 7.5 % faster; not expected to match, because ESP 5.0 interpolates electrical input power between the endpoints rather than reproducing factory setting 5 |
| ESP 8.9 / Factory Fan 9 | `0.9967` | about 0.34 % slower |
| ESP 10.0 / Factory Fan 9 | `1.0359` | about 3.6 % faster |

## Interpretation

1. The reconstructed low endpoint matches factory Fan 1 within about 1 %.
2. ESP `8.9` matches factory Fan 9 within 0.34 %, although the phone was repositioned before that
   recording. Microphone position changes amplitude and harmonic prominence but does not materially
   move a persistent tone's frequency. This justifies `8.9` as the no-heat speed ceiling.
3. Input-power interpolation is not a linear speed scale: ESP `5.0` reaches 82.6 % of the
   `0.1`-to-`8.9` acoustic span, whose midpoint is about 1974 Hz rather than 2676 Hz.
4. The factory settings are themselves nonlinear: factory Fan 5 sits at about 74 % of the factory
   Fan 1-to-9 tone span.
5. A midpoint in this tone is a midpoint in rotational speed, not proven half airflow. For a fixed fan
   on the same system curve airflow often tracks speed, but chamber restriction, bean load, pressure,
   slip, and motor behaviour move the operating point. Airflow claims need a repeatable airflow,
   pressure, or bean-loft measurement.

## Calibration decisions

- Keep factory-style zero-cross-synchronized phase control and the measured startup ramp.
- Cap the Fan scale at the raw `8.9` point that matches factory Fan 9; public Fan 10 maps to it.
- Treat the public Fan scale as an estimated speed scale until direct airflow evidence exists.
- A speed-linearized map would place public Fan `5.0` near 1974 Hz; the shipped map remains
  input-power interpolation.
- No further phone recording is needed for endpoint proof.
