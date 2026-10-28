# Crackle web app

Crackle is the browser application for the Crackle roaster controller: a phone-first roast desk for
defining, starting, watching, and reviewing roasts on a modified Fresh Roast SR800. It is a Preact
and TypeScript single-page app built with Vite and tested with Vitest. The production bundle is
gzip-embedded in the controller firmware and served same-origin from the ESP32-S3's flash at
`http://crackle.local/`.

The browser is a cache and an editor, never the controller. The roaster owns durable data, applied
calibration, and roast execution: once Start is acknowledged, the roast continues on the device
whether or not any browser stays connected.

| | |
| --- | --- |
| Version | `0.10.71` (`web/package.json` is the version authority; backup manifests and `crackle_bundle.h` derive from it) |
| Framework | Preact 10, TypeScript 5.9, Vite 6, Vitest 3 |
| Runtime dependencies | `preact`, `preact-render-to-string`, `lucide-preact` (icons), `fflate` (zlib for controller documents) |
| Delivery | Three files (`index.html`, one JS, one CSS), Terser three-pass minified, gzip-embedded in both OTA slots |
| Routing | Hash-based (`#/roast`, `#/history/<runId>`, ...) |

Routing is hash-based because of a controller constraint: the firmware's HTTP server registers `/`,
`/update`, `/api/...`, and `/logs/...` and has no catch-all, so a path-based deep link would return
`404`. Unrecognized routes fall back to Roast (`src/domain/routing.ts`).

Related documents:

- [`docs/controller-integration.md`](docs/controller-integration.md): the normative browser/controller
  protocol.
- [`docs/user-workflows.md`](docs/user-workflows.md): operator workflows and the UI review checklist.
- [`../docs/product-spec.md`](../docs/product-spec.md): the product contract.
- [`../docs/control-and-calibration.md`](../docs/control-and-calibration.md): thermal model, fitting,
  and the journey control law.

## Run locally

```powershell
cd web
npm ci
npm run dev
```

Open `http://127.0.0.1:5173/`. The default target is a full mock controller implemented as Vite
middleware in `web/dev/`. It starts with a deterministic, seeded library: six profiles, seven bean
lots, twelve roast records, revision history, Controls events, empty-chamber calibration passes,
loaded-roast evidence, and four real codec recordings produced by the device simulator. Its
controller-owned state persists in `web/dev/.mock-controller-state.json`; incompatible development
state is discarded rather than migrated. Vite hot-module replacement updates the page as sources
change.

| Command | Target |
| --- | --- |
| `npm run dev` | The mock controller at the same-origin root, plus the configured physical roaster behind `/__crackle/physical/` |
| `npm run dev:device` | The physical roaster directly: `/api`, `/update`, `/logs`, `/thermal.csv`, and `/ws/live` are proxied to it |
| `npm run build` | Type-check (`tsc -b`) and production build into `web/dist/` |
| `npm test` | The full Vitest suite (`src/**/*.test.ts` and `dev/**/*.test.ts`) |
| `npm run size` | Raw, gzip, and Brotli sizes of the production bundle |

The physical roaster defaults to `http://crackle.local`. Set `CRACKLE_CONTROLLER_URL` before starting
Vite when it lives elsewhere. Device mode is selected by the npm script name
(`npm_lifecycle_event`), which works in Windows npm scripts without an extra dependency;
`CRACKLE_CONTROLLER=device` does the same for a direct `npx vite`.

Under `npm run dev`, **Settings > Choose a roaster** switches between the mock and the physical
roaster without restarting Vite. Crackle preflights the candidate's identity and kind, keeps
separate per-target, per-device browser caches, refuses to switch while actuation, restore, a pending
archive, or an unsaved catalog edit is active, and then performs a full-page handoff so no poll,
socket, or write queue from the previous target survives. Production builds use relative paths and
see only the roaster that served the page.

Development-only tools appear in Settings when the page is served by the dev server against the mock:

- **Reset demo data** restores the seeded library.
- **Power-cycle mock roaster** changes the boot identity and discards volatile runtime work while
  keeping documents, recordings, applied calibration, and stable device/model identity. Use it to
  test reconnect recovery or escape an interrupted mock run.
- **Drop live stream** severs every live WebSocket subscriber so the reconnect-and-resync path can
  be exercised on demand.
- A probe-availability toggle simulates a missing thermocouple.

These tools and their routes (`/api/dev/power-cycle`, `/api/dev/probe`, `/api/dev/live-drop`) exist
only on the dev server.

## Screens

| Route | Label | Purpose |
| --- | --- | --- |
| `#/roast` | Roast | Setup and live cockpit for timed, journey, and recordable manual roasts |
| `#/history` | History | One row per roast; expanded rows hold the curve, measurements, notes, and actions |
| `#/beans` | Beans | Bean-lot catalog with combo inputs, density calculation, and per-lot roast table |
| `#/profiles` | Profiles | Timed and temperature-journey profile editors with revision history |
| `#/manual` | Controls | Direct Fan/Heat without a bean, batch, or roast record |
| `#/calibrate` | Calibrate | Applied calibration, empty-chamber baselines, building and saving fits |
| `#/reference` | Reference | Roast-color, temperature, and roast-name reference with sources |
| `#/settings` | Settings | Identity, health, storage, backup/restore, probe correction, firmware update, diagnostics |

The shell, navigation, and the header readout (Fan, Heat, temperature, lifecycle, heartbeat lamp,
elapsed time, and Stop) stay mounted across route changes; only the working view is replaced. Desktop
uses persistent side navigation and phone uses compact top navigation.

**Roast** is both setup and cockpit. With nothing running, the setup is the page: bean lot, strategy
or profile, this batch's mass and volume, a name, recording detail (detailed 1-second by default), and
one Start. Before Start it warns about storage retention, a profile that ends with the heater on, and
a weak roaster Wi-Fi signal. During a roast it shows the device-reported plan, zone progress, PI
correction, and the live chart; a manual roast adds a Fan/Heat cockpit and planned steps that count
down from device time but are sent only when the operator presses Apply.

**Profiles** edits timed lanes on a 0.5-level, 5-second snapping chart, and journeys on a chart where
points drag in time and temperature, double-click inserts a zone boundary, and Fan/Heat limits are
draggable bands. A time drag moves a boundary, so the journey keeps its length. Journey profiles
always show a local simulation, recomputed after a 300 ms debounce. Profiles carry no batch mass:
mass belongs to each roast.

Operator-level detail for every screen is in [`docs/user-workflows.md`](docs/user-workflows.md).

## Source layout

```text
web/
├── src/
│   ├── App.tsx           top-level state, connection lifecycle, reconciliation
│   ├── components/       views (RoastView, HistoryView, ...), charts, editors, shared fields
│   ├── controller/       client.ts (the only file that calls fetch), target resolution
│   ├── data/             deviceStore, document serializer, IndexedDB repository, backup/restore, zip
│   └── domain/           pure logic: thermal model, journey control, fitting, preflight, storage math
├── dev/                  mock controller: routes, actuator, plant, live socket, archive, persistence
├── tools/                bundle-size report
└── vite.config.ts        dev targets, proxy, Terser settings, Vitest worker bound
```

Most behavior lives in `src/domain/` as pure functions with their own tests. Components render and
dispatch; they do not own control or persistence rules.

## The controller boundary

### An enforced allow-list

The production network surface is exactly 26 paths, enforced by
`src/controller/fetchSurface.test.ts`. The same test proves that `fetch(` appears only in
`src/controller/client.ts`, that every request passes through the configured target resolver, and
that no path is composed from a bare template literal, so an id-suffixed route cannot become an
unpoliced address.

| Group | Paths |
| --- | --- |
| Observation | `GET /api/status`, `GET /api/live`, `/ws/live`, `GET /thermal.csv` |
| Stop | `POST /api/stop`, `POST /api/roast/stop`, `POST /api/manual/stop`, `POST /api/calibration/stop` |
| Roast | `POST /api/roast/start`, `POST /api/roast/set`, `GET`/`POST /api/roast/active-plan` |
| Controls and calibration | `POST /api/manual/set`, `POST /api/calibration/start`, `POST /api/calibration/apply` |
| Recordings | `GET /api/logs`, `POST /api/logs/delete`, `GET /logs/<id>.csv` and `/logs/<id>.crk`, `POST /api/logs/format`, `POST /api/logs/restore` |
| Documents | `GET /api/data/manifest`, `GET`/`POST /api/data/<name>`, `POST /api/data/delete` |
| Restore maintenance | `POST /api/restore/begin`, `/commit`, `/abort` |
| Settings | `POST /api/settings/thermocouple-offset` |

`/logs/<id>.csv` and `/logs/<id>.crk` are one allow-listed prefix: one resource, two
representations, chosen by suffix. The full table with arguments and refusals is in
[`docs/controller-integration.md`](docs/controller-integration.md).

### The roast runs on the controller

A roast is a device-resident program. The browser hands over the complete plan with
`POST /api/roast/start` and, after the acknowledgement, has no privileged role. There is no per-tick
control channel: the only roast commands are Start, Stop, manual-roast Set, and active-plan
read/patch. Journey edits and manual-roast instructions carry the expected session and plan revision;
the firmware validates them, owns the accepted result, and journals it in the recording.
`src/domain/roastProgram.ts` serializes plans, mirrors every bound the firmware checks so a request
the firmware would refuse never leaves the browser, and maps documented refusals and `end_reason`
values to plain language.

Every instruction is good for at most 30 minutes after the last accepted one; closing the browser is
not a control event. There is deliberately no client keepalive: a safety property belongs in
firmware, not in JavaScript on whatever device happens to be watching.

Commands are deliberately asymmetric:

- **Mutations preflight.** Start and Set read current status and fail closed on a fault, a latch,
  stale telemetry, a missing capability, or another active owner, naming the reason beside the
  control. A blocked control is never hidden.
- **Stop never preflights.** It does not wait on a round trip, catalog sync, or ownership; it is
  blocked only by having no controller to send it to.
- **Interrupting a roast takes two taps.** A Stop control that would end an active roast arms on the
  first tap ("Tap again to stop") and fires on the second, disarming itself after a few seconds. It is
  in place on the same button, never a dialog, so an intended stop is two quick taps on one spot.
  Non-roast stops (Controls, calibration) stay single-tap, and the transport request is unchanged.

**Model feasibility is advice, not admission.** `roastPreflight` mirrors the firmware's real gates
(invalid plan, missing applied calibration, probe fault, conflict) and disables Start with a specific
reason. A modelled unreachable zone is shown as a prediction to review; Start remains available. The
firmware owns the finite boundary: twice the nominal duration plus 600 seconds.

**Feature detection reads facts, not claims.** The executor is detected by the presence of
`status.roast`, the document store by `data_store`, and the archive by `log_archive`. When the
controller sends a `capabilities` object, capabilities fail closed. Effective output always comes
from the roaster; `src/domain/actuatorFloors.ts` mirrors the command-layer floors (Fan `0.1` minimum;
Fan `1.0` whenever Heat is positive) only to preview what the device will do.

**Security.** The API is unauthenticated on a trusted LAN by design; actuation is protected by
firmware interlocks. The client already treats HTTP `401` as a sign-in requirement.

## The live readout

`/api/status` is the authoritative contract document, read at initialization and explicit
reconciliation points rather than on a timer. `/ws/live` is the push path: one complete compact
snapshot, then sequence-fenced deltas at no more than 1 Hz. During a roast it carries the executor's
whole per-tick progress tuple atomically, because full status is deferred while anything actuates.
Frames are accepted only into the matching boot, session, and plan revision.

Freshness is deliberately tolerant: one missed second is not a lost roaster. After 8 s without a
fresh frame the client probes `GET /api/live`, after 12 s it reconnects the socket, and after 15 s it
blocks mutations (Stop stays available). A page that wakes, regains focus, or comes back online with
stale state replaces its socket immediately, without waiting for `onclose`, which a mobile browser may
never deliver after a screen lock. After any discontinuity in the same session,
`src/domain/liveTraceResync.ts` re-reads the recording prefix from `/thermal.csv` and merges it by
roaster second. Exact timings are in
[`docs/controller-integration.md`](docs/controller-integration.md#watching-a-roast-that-is-not-yours).

The header lamp shows report freshness: it flashes solid green on each accepted report, rests green
through 3 s, turns yellow after 3 s, and red after 5 s or on disconnect. It is presentation only; the
firmware never sees it.

Live charts use a fixed `0..250 C` temperature axis and a `0..10` actuator axis. Actual temperature is
yellow, the target is light green, and Fan and Heat are thin dashed traces. Journey targets advance
from measured zone completion and re-anchor each next zone to the previous measured completion,
exactly as the simulation does.

## Data

### The controller is the database

Profiles, bean lots, roast records, calibrations, Controls history, and the imported-recording
ledger live under `/data` on the controller's LittleFS volume. `src/data/deviceStore.ts` is the data
layer every screen uses.

A new roaster starts with two default profiles (`src/domain/defaultProfiles.ts`): **Espresso
Express**, a temperature journey, and **Espresso Express (timed)**. They are installed once, when the
roaster's library has never held a profiles document, and are ordinary profiles afterwards.

The firmware never parses a document: it owns a 16-byte `CDOC` envelope and returns every other byte
exactly as it arrived, so `src/data/documentSerializer.ts` is the entire on-disk schema and a schema
change needs no firmware release. Payloads are zlib-compressed JSON wrapped as ASCII `CRKZ1`, kept
under soft targets (8 KB collections, 6 KB runs) below the firmware's hard caps by shedding the most
expendable content first.

**Measured temperatures are stored in tenths of a degree**, rounded half away from zero
(`diskTemperatureC`). Fitted coefficients, R², tau, RMS, and authored setpoints keep full precision.
Tenths rather than whole degrees, because the passive-decay tail changes by sub-degree amounts over
many samples and is the most fit-critical stretch of a recording; at whole-degree resolution it
becomes a staircase.

### Who wins

- **Attach.** The data layer reads the paginated `/api/data/manifest` behind a stable `state_rev`
  and `boot_id`, then fetches only documents whose versions changed. The device replaces the cache.
  A revision observed during actuation or recording is remembered and reconciled once the roaster is
  idle, so inventory work never competes with the control loop.
- **Writes are revision-checked.** Every save posts the `base` version it was built on. An
  exact-successor acknowledgement promotes the mirrored document locally; anything else triggers full
  reconciliation. A `409` with `conflict: true` refetches the document and replays the mutation once.
  Mutations are functions, not payloads, so a replay onto a document another browser changed
  keeps both edits.
- **Uncommitted stays visible.** A busy refusal, stale revision, or offline controller leaves the
  form as an unsaved working edit. Only a device acknowledgement becomes committed state.
- **Offline is readable.** The last reconciled cache remains available for review; actuation and
  library mutations fail closed until status, any active plan, and the catalog are current.
- **The leave guard is honest.** It is raised only by work that exists nowhere but the open tab:
  catalog drafts, unsaved roast details, queued manual steps, and History edits. A field returned to
  its stored value is clean.

IndexedDB (`crackle-v4:<target>`) is a per-target mirror opened only after a stable controller
identity is observed, so one roaster's data cannot populate another's cache. It also caches hydrated
recording samples by immutable recording identity (`hydratedRecording:<key>`), so a recording is
downloaded once per browser rather than once per page load. On firmware without `data_store` the
IndexedDB repository is the whole implementation, reported as browser-local. The first time a
browser meets an empty controller store while its cache holds data, Settings offers a one-time
**Adopt this browser's data**; it is never automatic.

### Roast records

Before a device roast starts, `src/domain/deviceRoastStart.ts` writes the complete run record
(volume, ambient, bean lot and snapshot, mass, name, profile snapshot, outcome `running`) to the
document store. The write is fail-closed: a refusal, including a busy one, means no Start. When the
recording is archived, `src/domain/deviceRoastImport.ts` completes that record in place, with
header facts such as batch mass winning. A roast with no staged record is reconstructed from the
archive header. Run ids derive from the immutable recording origin (producer device plus origin log
id), never a mutable storage address, and an imported-recording ledger in `meta` makes deliberate
deletions stick across every browser. The join rules are in
[`docs/controller-integration.md`](docs/controller-integration.md#importing-what-the-controller-ran).

### Storage

Settings > Storage is built from the device's own numbers (`data_store`, `log_archive`, and
`GET /api/logs`); the arithmetic is in `src/domain/storage.ts`.

- **One bar for the 896 KiB volume:** recordings, documents, usable free, and reserves. The document
  write floor is `96 KiB archive reserve + 121,244 B worst-case recording = 219,548 B`, read from
  `data_store.write_floor_bytes`. Space obtainable only by refusing a write or pruning a recording is
  not shown as free.
- **Capacity in roasts:** "room for roughly N more recorded roasts", from this roaster's measured
  average recording and run-document sizes.
- **A bounded recording manager:** a ten-row paginated table. Retention deletes nothing when the new
  file cannot fit or would need more than 64 removals, and manual delete is enabled only once a
  compact roast curve or calibration evidence preserves the useful result.

Deleting a profile or bean lot never breaks history, because every run embeds snapshots of the
profile and bean lot it ran with. A cascade (record plus its roasts and recordings) is a separate,
typed-confirmation, idle-only operation that marks the ledger first, so a half-finished delete cannot
resurrect what it removed.

### Backup and restore

**Back up now** writes `crackle-backup-<date>.zip` (`src/data/backupFile.ts`): the four collection
documents and every run document verbatim, every recording as raw `.crk` bytes, the applied
calibration, and a manifest with device identity. Documents go back exactly as the roaster stored
them, so a backup captures what the roaster held rather than what one build of the serializer thinks
the schema is. The zip container (`src/data/zipFile.ts`) is hand-written and dependency-free (STORE,
CRC-32, fixed timestamps, so the same library produces the same bytes), and refuses compressed
entries by name rather than skipping them.

**Restore** (`src/data/backupRestore.ts`) validates the whole file before a destructive confirmation,
then runs a device-wide restore-maintenance lease: format, collections, recordings, runs, applied
calibration, commit. A lease that has mutated anything can only be resumed and committed, so a
partial restore cannot pass for the erased library. **Per-kind export/import**
(`src/data/backupImport.ts`) reuses the format for profiles, bean lots, roasts, or calibrations and
asks one file-wide question about conflicts. The full sequence and its failure rules are in
[`docs/controller-integration.md`](docs/controller-integration.md#backup-the-whole-library-as-a-zip).

## Calibration analysis

The thermal model, the fitting method, and the evidence rules are documented in
[`../docs/control-and-calibration.md`](../docs/control-and-calibration.md). The web app owns all of
that analysis, in hand-written math with no numerical dependency; the firmware only stores and
inverts the applied coefficients.

**Empty-chamber baselines** are controller-owned programs (default Fan `1,4,7,10` × Heat `1,5,10` in
serpentine order). When one ends, both outputs stop and a 180-second fan-off recording tail captures
passive decay without owning any output. Crackle stores evidence only when both `/logs/<id>.csv`
(measurements) and `/logs/<id>.crk` (accepted steps, settle policy, identity, probe correction) are
valid, and adds it as one collapsed, unchecked row that never silently creates or applies a fit.

Step analysis recovers windows from the log (a maximal run at one effective Fan and Heat), fits the
steady-state asymptote on every step by golden-section search over the R² of the log-linearized rise,
fits tau in both directions, regresses gain per Fan group, and splits cooling into forced and passive
tails. Steps are reported as `measured`, `extrapolated`, or `unreliable`, and a Fan row whose steady
state falls by more than 2 C as Heat rises is flagged suspect. The firmware's settle flag is never
trusted as a plateau: with a loose band, serpentine steps "settle" on their transition slope, half
from above and half from below, producing a map in which more Heat reads cooler.
`calibrationCorrectness.test.ts` reproduces that failure and asserts that the fitted analysis
recovers monotonic values from the identical log.

**Loaded-roast fitting** (`src/domain/coefficientFit.ts`) searches the four bean-side coefficients by
open-loop replay of real roasts:

- **Hooke-Jeeves pattern search**, because heater gain and fan cooling are strongly correlated in a
  roast log; coordinate descent zig-zags along that valley and stops at the wrong point with a
  respectable RMS.
- **Excitation and identifiability are measured.** A roast that never moves the fan says nothing
  about fan cooling, and deterministic multi-start fitting blocks Save and apply when materially
  different cooling coefficients explain the evidence nearly equally well.
- **Fingerprints:** each fit stores its input run ids and a hash of the measurements it consumed, so
  a later measurement edit flags it as stale; refitting always saves a new calibration.
- **Replay is open-loop** (`src/domain/modelFit.ts`): seeded once and never re-anchored, so the RMS
  is a hard test rather than a flattering one.

Only **Save and apply**, while the roaster is idle, creates a named snapshot and asks the roaster to
apply that exact set. Without a fit, the app uses a documented estimated starting baseline
(`estimatedBaseline.ts`), and the simulation panel always states whether coefficients are estimated,
fitted, or hand-entered. Crack markers are annotations, never model inputs (`eventPolicy.test.ts`
forbids computational modules from reading them), and density and expansion are recorded covariates
rather than model terms until enough varied roasts exist to fit one.

Current calibration also renders six 11 × 11 Fan-by-Heat **destination maps** (Heating and Cooling ×
Empty, 100 g, 250 g): the mean calculated time to reach and hold a ±2 C band for 20 s at each
destination. Empty maps come from baseline evidence; the loaded maps are labelled applied-model
estimates.

## Journey control

A temperature journey is executed by the firmware with a C++ port of `src/domain/journeyControl.ts`,
held to the TypeScript by shared parity vectors. In summary:

- **Feed-forward:** the plant model `dT/dt = capacity × (4 + heating - airflow - loss × (T - ambient))`
  is solved for the zone's slope, selecting the greatest Fan whose required Heat is available.
- **Feedback:** `Kp·e + Kr·(slope - predicted RoR) + I`, with Kp 3 °C/min per °C, Kr 0.5, a 45 s
  integral time, and the predicted RoR extrapolated 10 s ahead. Corrections move Heat first and Fan
  only for what Heat cannot deliver. The total is bounded to +15 / -12 °C/min and the integral to ±8;
  the integral is held during cooling zones and for 20 s after charge.
- **Airflow:** Fan 10 through 130 °C, then the zone's `fanMin` and the rule that Heat on means Fan
  `1.0` or higher. Cooling is Fan 10 / Heat 0.
- **Progress:** zones advance on measured attainment; overdue endpoints are held, bounded by the
  whole-roast envelope.

The clamps are deliberate: a model wrong enough to need more than 8 °C/min of steady correction
should produce a visibly failing roast, not a quietly rescued one. The evidence, including runs where
the plant and controller use deliberately different coefficients, is in `journeyControl.pi.test.ts`
and the companion `journeyControl.*.test.ts` suites.

## The mock controller

`web/dev/mockController.ts` implements all 26 production paths against the real wire formats, so
every workflow runs without hardware. It reports a stable simulated identity and a distinct
`crackle-sim-sr800` model under the `freshroast-sr800` contract.

- **Archive codec.** `web/dev/crkFile.ts` writes and validates real `.crk` files: the 220-byte v4
  header with immutable producer identity and capture-time probe correction, the plan/journal or
  calibration-policy block, delta-varint samples, and CRC-32. It returns every firmware validation
  verdict (`bad_magic`, `crc_mismatch`, `size_mismatch`, ...) and the same 121,244-byte ceiling.
- **Refusals match firmware.** Idle-only flash writes, `409` conflicts, `503 + Retry-After` busy
  answers, the post-persist busy window, restore maintenance, and the instruction lease behave as
  the firmware documents. `dev/runtimeContract.test.ts` and its neighbors pin this; a mock that drifts
  from the contract is worse than none, because every feature reviewed against it looks finished.
- **The plant deliberately differs from the controller's model.** `web/dev/plant.ts` has two load
  regimes (empty chamber and loaded), a shared slow wall mass that produces the fan-stop rebound,
  probe lag, deterministic noise, and a heater deliberately weaker than the coefficients the app
  inverts. A plant identical to the controller's model would let tests validate a perfect twin. The
  empty-chamber physics is anchored on a measured forced-cooling tau of about 94 s at Fan 10.

The mock ticks against wall-clock time. Automated checks should step virtual time rather than wait
for a live program.

### The development dataset

`src/data/demoDataset.ts` builds the seeded library. It is dev-server only: `richSeedEnabled`
requires `import.meta.env.DEV` and `MODE === 'development'`, and the module is loaded behind a
literal `import.meta.env.DEV` dynamic import, so production builds and Vitest never contain it.
Everything in it is derived: timestamps from one fixed reference instant, revision summaries from the
editor's own differ, roast telemetry from the simulator, and calibration passes from the chamber
model put through the real analysis. A reseed is byte-identical.

## Testing

```powershell
npm --prefix web exec vitest -- run src/domain/journeyControl.test.ts   # focused
npm --prefix web run build                                              # type check + build
npm --prefix web test                                                   # full suite
```

The suite covers domain math, serializers, component rendering, the controller client, and the
mock's conformance to the firmware contract. Vitest runs in the `forks` pool bounded to four workers.
Run focused files while iterating and the full suite once changes settle; see [`../docs/testing.md`](../docs/testing.md) for the project-wide
strategy.

Two testing lessons are encoded in the suite:

- **SVG attributes must be dashed.** Preact writes SVG attributes verbatim, so `textAnchor` reaches
  the DOM as an attribute SVG ignores, while `preact-render-to-string` converts it. Server-rendered
  geometry tests therefore passed while browsers misaligned every axis label. All presentation
  attributes are written dashed (`text-anchor`, `stroke-dasharray`), and geometry tests measure the
  estimated text box rather than the chosen coordinates.
- **Numeric fields keep a text draft.** Parsing on every keystroke destroys `""`, `"1."`, and `"-"`;
  `NumberField` keeps the draft as text, updates on `input`, and re-seeds only when the committed value
  changes. Forms never bind directly to live telemetry, which would overwrite a draft on every frame.

## Building for the firmware

```bash
npm --prefix web run embed     # npm run build, then firmware/crackle/tools/embed-crackle.mjs
```

`embed-crackle.mjs` requires exactly three files in `web/dist` (`index.html` plus one hashed JS and one
hashed CSS), gzip-compresses them into `firmware/crackle/crackle/crackle_bundle.h`, stamps the
version from `web/package.json`, and produces byte-identical output for identical inputs. Commit the
regenerated header with any web change, and bump the version deliberately; a version is never
reused for different bytes.

The development seed can never be embedded: it is excluded from production builds by the
`import.meta.env.DEV` guard above. The bundle lives in both OTA application slots, so compressed
size matters more than build speed; Terser with three passes saves about 5.7 kB gzip over esbuild.

Firmware compilation, partitioning, and OTA packaging are covered in
[`../firmware/crackle/README.md`](../firmware/crackle/README.md).

## Design notes

These are intentional decisions, not a backlog:

- **Bulk transfer uses HTTP, not the live socket**, because WebSocket frames share one ordered TCP
  stream and a long recording would delay state frames.
- **Controls history reconciliation is best effort.** Rows derived from status describe a single
  missed transition, not everything that happened while the tab was closed. Recordable manual roasts
  keep their full device journal.
- **Calibration completion is observed from Calibrate.** Leaving loses nothing; the recording remains
  in the unused-baseline picker by exact id.
- **Journey drag gestures** are tested with coordinate and render contracts rather than a synthetic
  pointer driver.
- **Calibration evidence is never imported from CSV.** CSV is an export of stored evidence; only
  roaster recordings with verified provenance can become evidence.
