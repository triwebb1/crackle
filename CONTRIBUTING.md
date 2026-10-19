# Contributing

Crackle is a personal project shared as is, without support or any commitment to review issues or
pull requests. If you work on it, in a fork or here, it controls a mains-powered heating appliance,
so a few rules are stricter than usual.

By submitting a contribution, you agree that it is distributed under this repository's
[license](LICENSE) and that the author may also include it in separately licensed commercial
versions.

## Safety boundaries

- Never connect computer USB, a serial adapter, a programmer, or a grounded instrument to an
  installed controller while the roaster is plugged in. Serial work requires roaster mains **and**
  the controller's charger disconnected.
- Do not weaken or bypass a rule in the [safety policy](firmware/safety-policy.md). Changes to the
  actuator core (`sr800_actuator.*`, `sr800_mcpwm_phase_scheduler.*`) need a matching native test
  and a physical check from the [safety checklist](hardware/safety-checklist.md).
- Stop must stay reachable independently of every other gate.
- No safety property may depend on a browser staying connected, and the browser never times a roast.

## Development setup

```bash
cd web
npm ci
npm run dev          # mock controller at http://127.0.0.1:5173/
```

Firmware builds with `arduino-cli` and ESP32 Arduino core 3.3.10; see
[the firmware reference](firmware/crackle/README.md#build-and-verify). The board options
`PartitionScheme=custom`, `PSRAM=enabled`, and `EraseFlash=none` are mandatory.

## Before opening a pull request

Run the tests for the boundary you changed while iterating, then the full set once
([testing](docs/testing.md) has a selection table):

```bash
cd web && npm run lint && npm test && npm run build
cd firmware/crackle/tests && for t in *_contract_test.py; do python "$t" || exit 1; done
cd firmware/crackle/tests && bash run-native-tests.sh
```

- **Web changes that ship to the device:** run `npm --prefix web run embed` (production build, then
  `firmware/crackle/tools/embed-crackle.mjs`) and commit the regenerated
  `firmware/crackle/crackle/crackle_bundle.h`. Never embed the development seed.
- **Journey control law changes:** edit the TypeScript oracle (`web/src/domain/journeyControl.ts`)
  and the C++ port together, regenerate the vectors
  (`cd web && npx vite-node scripts/generate-journey-vectors.ts`), and run
  `journey_control_vector_test`. The port matches the oracle, never the reverse.
- **Storage formats:** firmware treats documents as opaque versioned bytes; TypeScript owns the
  schemas. Recording identity is producer device plus origin log ID, never a bare storage address.
- **Mock controller:** its refusal and persistence behavior must match the firmware's, and its plant
  must keep differing from the controller's model.
- **Versions and releases:** bump `kFirmwareVersion` in `crackle.ino` and `version` in
  `web/package.json` deliberately, never reusing a released version for different bytes, and keep the
  application image below the 1,572,864-byte OTA slot. A release is a `v<firmware>` tag; CI builds
  and publishes it with checksums ([releasing](firmware/crackle/README.md#releasing)).
- **Documentation:** a change that intentionally alters a contract updates its document in the same
  commit.
