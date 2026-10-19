# AGENTS.md

Instructions for coding agents working in this repository. Crackle is ESP32-S3 firmware
(`firmware/crackle/`) plus a Preact/TypeScript web app (`web/`) that together replace the control
electronics' role in a Fresh Roast SR800 coffee roaster. The firmware runs roasts and owns all
durable data; the browser plans, watches, and edits.

## Start here

Read the authority for the area you're changing:

| Area | Read |
| --- | --- |
| Behavior contract | [`docs/product-spec.md`](docs/product-spec.md) |
| Safety invariants | [`firmware/safety-policy.md`](firmware/safety-policy.md) (normative, non-configurable) |
| Structure and ownership | [`docs/architecture.md`](docs/architecture.md), [`docs/network-architecture.md`](docs/network-architecture.md) |
| Firmware API, storage, build | [`firmware/crackle/README.md`](firmware/crackle/README.md) |
| Browser/device contract | [`web/docs/controller-integration.md`](web/docs/controller-integration.md) |
| Control law and calibration | [`docs/control-and-calibration.md`](docs/control-and-calibration.md) |
| Why things are the way they are | [`docs/design-decisions.md`](docs/design-decisions.md) |

Code and tests are the authority for what is implemented. If a doc disagrees with the code, check
which one is wrong; don't silently pick one.

## Hard boundaries

- **Mains isolation.** The controller shares the roaster's potentially mains-referenced logic
  ground. Never ask anyone to connect computer USB, serial, or a grounded instrument while roaster
  mains is present. Serial work requires mains **and** the controller's charger disconnected.
- **No hardware actions without explicit request.** Do not flash, OTA-upload, erase, format,
  repartition, or restore controller storage unless the operator asks for that specific action and,
  for serial work, confirms power isolation. Read-only `GET` requests to `crackle.local` are fine.
- **Safety policy is not negotiable.** Never weaken a rule in `firmware/safety-policy.md`. In
  particular: Stop stays reachable past every gate; no client-liveness safety, no browser-owned
  roast ticks, no mandatory post-Heat cooling; every Heat-off-to-positive transition gets a fresh
  500 ms Fan qualification; Heat on means Fan ≥ 1.0 at the command layer (core backstop 0.1);
  at Heat-off the requested Fan, including 0, is authoritative immediately.
- **The actuator core is the only path to the outputs.** Programs call `actuator.request()`; they
  never touch GPIO or compute phase delays. Changes to `sr800_actuator.*` or
  `sr800_mcpwm_phase_scheduler.*` need a native test and a physical check before release.
- **Git hygiene.** Preserve uncommitted user work; never use destructive resets or checkouts. Commit
  in meaningful, verified groups, not per edit.

## Source-of-truth rules

- The controller owns durable data and active state; the browser owns only visible unsaved drafts.
  A browser commit advances only after a revision-checked device acknowledgement; busy or stale
  means fail closed, never queue a later surprise.
- Firmware stores documents as opaque versioned bytes; TypeScript owns their schemas.
- Recording identity is producer device plus origin log ID. Never attach evidence by a bare storage
  address.
- A view renders complete data or an explicit loading state with its reason. Only live roast surfaces
  render incrementally.
- The journey law in `web/src/domain/journeyControl.ts` is the oracle; `sr800_journey_control.*` is
  its port. Change both together and regenerate the vectors; the port matches the oracle, never the
  reverse.
- The mock controller (`web/dev/`) matches firmware refusal and persistence behavior, but its plant
  deliberately differs from the controller's model.

## Firmware rules learned the hard way

Full list and reasons: [firmware README → Rules for maintainers](firmware/crackle/README.md#rules-for-maintainers).
The ones that cause silent field failures:

- Never call `ESP.getSketchSize()` at runtime (races OTA finalization). Size is cached in `setup()`.
- Never write `delay(0);` in long loops; use `pacedYield()` (never inside a critical section).
- Request bindings stay `static __thread`. Never `httpd_sess_trigger_close` another task's request.
- Flash writes only while the actuator is idle. Every manifest-visible write advances the state
  revision or marks restore dirty.
- State whether each new allocation may live in PSRAM; internal SRAM runs out first.

## Validation

Run the smallest set that can falsify the change while iterating; run the full set once when the
change settles. Selection table: [`docs/testing.md`](docs/testing.md#choosing-what-to-run).

```bash
npm --prefix web exec vitest -- run <files>                      # focused web tests
npm --prefix web run lint                                        # Biome (npm run format to fix)
npm --prefix web test && npm --prefix web run build             # full web suite + type/build
cd firmware/crackle/tests && for t in *_contract_test.py; do python "$t" || exit 1; done
cd firmware/crackle/tests && bash run-native-tests.sh            # 14 native suites (g++)
```

- Web changes that ship: `npm --prefix web run embed` (build, then `firmware/crackle/tools/embed-crackle.mjs`),
  and commit `firmware/crackle/crackle/crackle_bundle.h`. Never embed the development seed.
- Comment- or doc-only changes must leave a rebuilt `crackle_bundle.h` byte-identical.
- Firmware compile: ESP32 Arduino core **3.3.10**, FQBN
  `esp32:esp32:waveshare_esp32_s3_zero:PartitionScheme=custom,PSRAM=enabled,EraseFlash=none`,
  `-Os`; the image must stay below 1,572,864 bytes. Compile once per settled change, not per edit.
- Python source contracts are tripwires, not behavioral proof. Host success is not a hardware claim:
  never state that a build is physically validated unless the operator reports it.
- Never verify by running the mock in real time; step virtual time or use `CRACKLE_MOCK_SPEED`.

## Releasing

Version format: firmware `2026-07-26.NNN` (`kFirmwareVersion`), web `0.10.N` (`web/package.json`).
Never reuse a version for different bytes. A release is a pushed tag `v<firmware>`: the
[release workflow](.github/workflows/release.yml) reruns CI, builds, validates, and publishes the
GitHub Release (OTA image, first-install package, debug symbols, `SHA256SUMS.txt`, notes from the
changelog). Steps are in the [firmware README](firmware/crackle/README.md#releasing). In the same
commit as the version bump, update every public version reference: `README.md` (Status),
`firmware/crackle/README.md`, `web/README.md`, `docs/product-spec.md` (status line), and add the
`CHANGELOG.md` section that becomes the release notes. `python .github/scripts/release.py check`
must pass.

## Writing for this repo

- State rules and their technical reasons in the present tense. Keep the lesson, not the story:
  "`delay(0)` never yields to IDLE, so long loops call `pacedYield()`". How a rule was discovered
  belongs in the commit message, not in comments or docs.
- A version reference belongs in code only where behavior depends on it for compatibility.
- Match the surrounding code's comment density and idiom. Preserve each file's line endings.
- If a change intentionally alters a contract, update its document in the same commit.
