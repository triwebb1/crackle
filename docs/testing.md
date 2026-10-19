# Testing

Crackle is tested in layers, each aimed at a boundary where a defect would be expensive: the
waveform reaching the power stage, the control law crossing from TypeScript to C++, the bytes of a
recording, and the contract between the browser and the device. All host-side layers run in CI
([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)).

| Layer | Inventory | Runtime | What it protects |
| --- | --- | ---: | --- |
| Lint and formatting (Biome) | `npm run lint` | < 1 s | Correctness, accessibility, and suspicious-code rules; one consistent format. Every disabled rule carries its reason in `web/biome.jsonc` |
| Web unit, render, and mock tests (Vitest) | 130 files, about 2,000 tests | ~20 s | Domain math, data authority and persistence, serialization, UI behavior, mock/firmware parity |
| Firmware native C++ suites | 14 executables, built with `-Werror` and run under AddressSanitizer and UndefinedBehaviorSanitizer | ~60 s incl. compiles | Actuator safety, zero-cross qualifier, archive codec, document store, live deltas, query parsing, journey vectors |
| Firmware architecture checks (Python source contracts) | 23 scripts | ~1 s | Architecture and wiring invariants that are hard to exercise on a host |
| Display decoder replay | 1 executable | < 1 s | The sniffer's decoder against ten real SR800 captures |
| ESP32-S3 image build | 1 compile | ~1–2 min | The physical target compiles and fits its 1.5 MB OTA slot |
| Release consistency | `release.py check`, `release.py check-bundle` | < 1 s | Firmware version, web version, embedded bundle, changelog, and the versions stated in the docs agree (on a tag, the tag too); the embedded web bundle, decompressed, is byte-identical to a fresh build of this source |
| Physical checks | [safety checklist](../hardware/safety-checklist.md) | minutes to hours | RF, electrical, OTA, and thermal behavior; host checks cannot replace these |

## Running the tests

```bash
# Web app
cd web
npm ci
npm run lint           # Biome lint + format check (npm run format fixes formatting)
npm test               # full Vitest suite (four workers)
npm run build          # type check + production build
npx vitest run src/domain/journeyControl.test.ts   # one file while iterating

# Firmware architecture checks
cd firmware/crackle/tests
for t in *_contract_test.py; do python "$t" || exit 1; done

# Firmware native suites (any C++17 compiler; the script uses g++)
bash run-native-tests.sh

# Sniffer decoder replay (from the repository root; the binary goes to a temp directory)
out=$(mktemp -d)
g++ -std=c++17 -I firmware/sniffer/sr800_sniffer firmware/sniffer/tests/decoder_replay_test.cpp -o "$out/replay"
"$out/replay" data/captures
```

On Windows with MSVC, build a native suite from `firmware/crackle/tests` with
`cl /std:c++17 /EHsc /I fakes /I ..\crackle <name>_test.cpp [..\crackle\<dependency>.cpp]`.
`journey_control_vector_test` must run from `firmware/crackle/tests`, because it reads
`vectors/` relative to the working directory.

## Notable techniques

### Cross-language control vectors

The journey control law runs in the browser (previews and simulation) and on the device
(execution). [`web/scripts/generate-journey-vectors.ts`](../web/scripts/generate-journey-vectors.ts)
drives the TypeScript oracle through 12 scenarios (7,304 one-second steps covering zone
transitions, cooling zones, saturation, overshoot recovery, and heavy batches) and records every
input and output. `journey_control_vector_test.cpp` replays the identical inputs through the C++
port and fails on any deviation beyond floating-point tolerance. Changing the law means
regenerating the vectors:

```bash
cd web && npx vite-node scripts/generate-journey-vectors.ts
```

### A deliberately imperfect mock plant

`web/dev/` contains a complete mock controller (HTTP routes, WebSocket live stream, archive,
document store, persistence, power-cycle simulation) backed by a thermal plant. The plant's
parameters intentionally differ from the controller's model, so tests and development runs exercise
feedback and model error instead of validating a perfect twin. Mock refusal and persistence
behavior must match the firmware's; parity tests pin that.

### Hardware fakes for native tests

`firmware/crackle/tests/fakes/` provides minimal `Arduino.h`, GPIO, GPTimer, and ESP-IDF headers,
so the actuator core, qualifiers, and codecs compile unchanged on a desktop compiler. Tests drive
virtual time and synthetic zero-cross streams, including chatter bursts, callback blackouts, and
real loss.

### Architecture checks as tripwires

Some invariants live in wiring rather than logic: every Stop route uses the reserved Stop lane, no
socket is touched from `loop()`, `delay(0)` never appears, request bindings are task-local, and
runtime code never calls `ESP.getSketchSize()`. Python scripts pin these by reading the source.
They are cheap regression tripwires and are never presented as behavioral proof.

### Evidence-based fixtures

Display-decoder tests replay real logic-analyzer captures from [`data/captures/`](../data/captures/README.md),
and one real roast recording (`.crk` plus its CSV export) is kept as a reference for the archive
codec and calibration code.

## Choosing what to run

Run the smallest set that could falsify a change while iterating, then the full set once:

| Change | Run |
| --- | --- |
| Pure domain logic | That module's tests and its direct consumer |
| Component markup or CSS | That component's render/DOM tests; phone-layout tests if responsive behavior changed |
| Controller client or reconciliation | `client.test.ts`, `fetchSurface.test.ts`, the affected store test |
| Mock controller | The affected `web/dev/*.test.ts` plus one parity test |
| Firmware helper | The matching native suite |
| Firmware routes, tasks, storage, OTA | The matching source contracts, plus a native test if the logic can be extracted |
| Journey control law | Domain tests, regenerate vectors, `journey_control_vector_test` |
| Anything shipped to the device | Full web suite, build, embed, all firmware tests, ESP32 compile |
