# First Baseline Air Map Attempt — Firmware 2026-07-26.35, Crackle 0.4.1

Status: **INVALID as a baseline; preserved as the diagnostic dataset that drove the `.36`/0.5.0 fixes.**

## Run

First real baseline air map after the probe's permanent relocation to bean-bed height. Serpentine grid fans `1,4,7,10` x heats `1,5,10` with operator-chosen settle `+/-5 C` for 3 s, minimum dwell 10 s, step cap 30 s. Twelve steps completed in roughly 2.5 minutes (306 log samples), every step ending `settled`. Stored in Crackle as the run of 2026-07-26 21:28 (12 steps / 306 samples).

## Result Table (as ingested)

| Fan \ Heat | 1 | 5 | 10 |
| ---: | ---: | ---: | ---: |
| 10 | 147 | 149 | 147 |
| 7 | 140 | 140 | 143 |
| 4 | 138 | 131 | 115 |
| 1 | 37 | 64 | — |

Reported taus 3-8 s; fitted "gain" NEGATIVE (-2.6 C per heat unit, R2 0.977 at fan 4); ambient 32 C; peak 149.2 C.

## Why It Is Invalid

- The fan-4 row DECREASES with heat — physically impossible for true steady states. Fan 4 ran as a descending serpentine group (heat 10 first), and the whole group was one continuous thermal climb: the readings track elapsed time, not settings.
- The settle window's range bound implies a slope bound of `2*band/window`; at `+/-5 C` over 3 s anything rising slower than ~3.3 C/s passes as settled, and chamber air rises 2-3 C/s mid-transient. Every step ended ~13 s in against a plant time constant near one minute. The 3-8 s "taus" are truncation artifacts.
- The missing `1:10` point is the Fan floor working as designed: Heat >= 7.525 forces Fan >= 1.3375, so the step ran at effectively `1.34:10` and the declared-level matcher dropped it.
- The passive-decay tail was destroyed by a firmware defect: the completed program left its final Fan request (10.0) running indefinitely, so no fan-off decay exists and the thermal-loss coefficient is not derivable from this run.

## Salvage

- Forced-cooling tau approximately **94 s at Fan 10** (fitted from the stuck-fan tail) — a usable data point.
- The dataset itself is the regression evidence behind three fixes: the `.36` calibration completion watcher (auto-stop after Cooling), the retuned settle defaults (`+/-1.5 C` over 15 s, 20 s dwell, 180 s cap, window limit 30 s), and Crackle's always-fit analysis rule (three-parameter exponential fit preferred over the tail snapshot on every step, disagreement marked extrapolated with R2, floored points reported at effective coordinates, non-monotonic rows flagged suspect).

## Disposition

Do not stage coefficients from this run. Re-run the baseline on firmware `.36` with Crackle 0.5.0 defaults; that run becomes baseline pass 1.
