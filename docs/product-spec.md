# Product specification

Status: normative for the current source tree (firmware `2026-07-26.128`, Crackle web app `0.10.70`).

This specification defines the product the repository builds. The documents linked from each section
are normative in their own scopes; see [Documentation authority](#documentation-authority).

## Product definition

Crackle is a local, single-appliance controller for a modified Fresh Roast SR800. A permanently
installed Waveshare ESP32-S3-Zero:

- drives the existing fan and heater power stages through optocouplers;
- reads zero-cross timing, factory fan activity, and a MAX31856 K-type thermocouple;
- serves the complete browser application from its own flash;
- executes timed, temperature-journey, and manual roasts without a browser remaining connected;
- owns profiles, bean lots, calibrations, roast records, and thermal recordings; and
- provides local backup, restore, diagnostics, calibration, and firmware updates.

Expected deployment is one operator, one installed controller/roaster pair, one trusted LAN, no cloud,
no account, and no sensitive data. Development may expose a mock controller and a physical-roaster
proxy, but routine production UX behaves as one appliance.

## Product principles

1. **The roaster is authoritative.** Durable records, applied calibration, current outputs, active
   plans, faults, and execution state come from the controller. A browser may differ only through a
   visible unsaved working edit.
2. **The browser is not the real-time controller.** Start hands a complete plan to the device.
   Closing a tab, sleeping a phone, losing mDNS, or losing Wi-Fi does not alter an accepted roast.
3. **Safety lives in firmware and hardware-timed code.** JavaScript, HTTP, and client liveness cannot
   authorize or prolong Heat.
4. **Stop remains independent.** Stop does not wait for catalog sync, initiating-browser ownership,
   or an ordinary mutation preflight.
5. **Failure is fail-closed for mutation, not destructive to evidence.** Cached history remains
   readable. Unacknowledged edits stay visibly uncommitted. Identity mismatches are refused.
6. **Preserve the machine and its data.** Ordinary updates use A/B OTA. A partition migration uses an
   explicit serial package that does not erase or write NVS or LittleFS.

## Hardware and electrical contract

- Waveshare ESP32-S3-Zero with 2 MB PSRAM.
- Dedicated isolated 5 V USB charger; the factory 5 V supply is not used or paralleled.
- ESP ground joins factory logic ground as the signal reference, so the controller electronics are
  potentially mains-referenced.
- GPIO3: fan PC817 LED through 470 ohms.
- GPIO4: heater PC817 LED through 470 ohms.
- GPIO5: divided factory fan command, U3B pin 12.
- GPIO6: divided zero-cross reference, U3B pin 17.
- GPIO7-GPIO12: MAX31856 and K-type thermocouple.
- PC817 outputs parallel the factory command-transistor collector/emitter paths. Reset or ESP power
  loss leaves them open.

Exact wiring, the pin map, and the bill of materials are in
[`hardware/installation.md`](../hardware/installation.md). The
[`hardware/safety-checklist.md`](../hardware/safety-checklist.md) is mandatory.

> **Never attach computer USB, serial, a programmer, an oscilloscope, or any other grounded instrument
> while roaster mains is connected.** The ESP shares factory logic ground, which is potentially
> mains-referenced. OTA through `/update` does not require opening the roaster. Serial flashing
> requires mains and the isolated charger to be disconnected before computer USB is attached, and
> computer USB to be disconnected before mains is restored.

## Actuator and safety contract

[`firmware/safety-policy.md`](../firmware/safety-policy.md) is the complete normative policy, and
[`firmware/actuator-core.md`](../firmware/actuator-core.md) describes the audited actuator.

- Fan and Heat accept `0.0`, or finite values from `0.1` through `10.0`.
- **Heat on means Fan `1.0` or higher, on every command path.** The command layer lifts a
  heat-carrying Fan below `1.0` to `1.0` rather than refusing an older profile, and the browser mirrors
  the lift. Fan-only requests keep the `0.1`-`10.0` range. The actuator core's own `0.1`-with-Heat
  qualification floor remains beneath this rule as a backstop.
- Every transition from Heat off to positive Heat starts a fresh 500 ms Fan qualification interval,
  even if Fan was already running.
- Heat-off creates no cooling debt, timer, forced fan level, or action blocker in the actuator core.
  Fan immediately follows the accepted request, including `0`. Process cooling exists only when
  authored: in a profile or calibration program, by direct operator command, or as the executor's
  post-Stop cooling tail. A Stop that interrupts an active roast is followed by an executor-issued
  Fan 10 / Heat 0 instruction for 10 seconds, then outputs off; any newly accepted instruction (a
  manual set, a new start, a second Stop) preempts it immediately. Recording closure and `end_reason`
  are unchanged by the tail.
- Automatic endings (plan completion, faults, envelope expiry) synthesize no airflow, because the
  safety policy forbids output the operator or plan did not request after a fault or envelope breach.
  Preflight warns when a profile ends with the heater on.
- Positive Heat has a renewable lease of at most 30 seconds, enforced in the zero-cross path.
- An instruction expires 30 minutes after the last accepted instruction; expiry stops both outputs and
  ends the session.
- Three consecutive invalid thermocouple samples qualify a sensor fault. Independent one-second
  thermal freshness removes Heat if updates stop.
- A valid reading at or above the overheat limit (260 C, `kOvertempDisableC`, a build-time constant)
  for at least 1 second while Heat is requested or on latches overtemperature until power cycle:
  Heat off at once, then a Fan 10 cooldown until the reading has stayed below the limit for
  3 minutes. Only Stop, a manual-control conflict, or a scheduler failure ends the cooldown early.
- A factory fan pulse train spanning 50 ms latches manual conflict and opens both ESP outputs until
  power cycle.
- Zero-cross qualification, chatter rejection, bounded coast, 100 microsecond gate pulses, and
  fail-low MCPWM timing are owned by the audited actuator/scheduler code.
- Flash writes require every actuator and operation owner to be fully idle. Reads remain available.
- A roast envelope of twice the nominal duration plus 600 seconds bounds unreachable journey targets.
- Journey sensor holdover is bounded to 30 continuous seconds and remains fail-low underneath.
- A zero-cross gap the actuator is riding through, or a thermocouple status of unknown (not a
  qualified fault), keeps the previous command for at most 2 seconds before ending a program.

Do not introduce a client keepalive, browser heartbeat, mandatory post-Heat cooldown timer, or
browser-authored safety override.

## Runtime and network architecture

The firmware runs one native ESP-IDF HTTP/WebSocket service on port 80. Arduino `loop()` owns
actuation and controller state but never parses or writes a browser socket. The design and its
measurements are in [`network-architecture.md`](network-architecture.md); the browser side is in
[`web/docs/controller-integration.md`](../web/docs/controller-integration.md).

- General commands use bounded fixed-capacity mailboxes.
- Stop has a reserved mailbox, queue, and higher-priority worker. Every Stop route uses it, and
  `/api/roast/stop` is never refused.
- Actuator-affecting starts receive brief storage priority over page-owned library reads and retry only
  explicit `storage_busy` refusals known to occur before side effects. Stop increments an admission
  generation; queued or retried commands admitted under an older generation are refused after Stop.
- Five PSRAM-first asset jobs absorb simultaneous cold loads. LittleFS has one isolated storage worker
  behind a three-request FIFO. Each browser serializes its own storage work and honors explicit
  `Retry-After` contention within a bounded window. Document bodies must arrive within 15 seconds and
  recording restore bodies within 120 seconds, or the upload is abandoned and the storage guard
  released.
- Raw OTA runs synchronously in the registered HTTP handler while the fully idle roaster reserves port
  80. OTA admission and both storage guards decide ownership under one storage-then-OTA lock order.
- Up to eight sockets are supported, with HTTP capacity reserved from at most four WebSocket
  subscribers. A newly opened client evicts the least recently served subscriber only after 15 seconds
  without a successful send; four healthy subscribers reject a fifth to prevent reconnect churn.
- `/api/status` and `/api/live` come from immutable snapshots.
- `/ws/live` sends an initial full snapshot, then sequence-fenced top-level deltas no more than once per
  second. Ping payloads are echoed in Pong frames. Reconnect, reboot, reorder, or continuity loss
  requests a fresh snapshot. One missed second is not treated as a disconnect.
- Documents, recordings, backups, restores, assets, and OTA images are HTTP transfers; the ordered live
  stream is not a bulk-file tunnel.
- Immutable application size is read once during setup, before network concurrency, and cached.
  Periodic code must not call Arduino core 3.3.10 `ESP.getSketchSize()`: it performs a full ESP image
  verification through the process-global, non-reentrant `bootloader_mmap`, which can collide with OTA
  finalization.
- Long flash loops call `pacedYield()` (a one-tick sleep per 20 ms of work). `delay(0)` is
  `vTaskDelay(0)`, which never yields to the lower-priority IDLE task the task watchdog monitors, so a
  long manifest or archive walk built on it trips the watchdog.
- Firmware request bindings are task-local (`static __thread`); a storage-worker task never closes an
  HTTP session it does not own.
- Full status reports reset reason and recent boot history, uptime, heap/PSRAM current/minimum/largest
  values, worker stack reserves, failed allocations, loop-gap and archive-persist timing, the slowest
  storage request, station RSSI, Wi-Fi disconnect count, the stored core-dump summary, and decoded
  MAX31856 fault names. These diagnostics never gate actuation.
- Heat-start thermocouple freshness and overtemperature checks share one firmware helper.

## Device authority, library, and recordings

LittleFS is the durable product library. Firmware owns a versioned envelope around opaque documents;
the web app owns document schemas.

- Collections are profiles, bean lots, calibrations, and metadata; roasts are `runs/<id>` documents.
- Committed browser state advances only after revision-checked device acknowledgement.
- The first version conflict refetches device truth and replays the edit once. A second is surfaced.
- A whole-record save refuses to replay over the same record changed elsewhere.
- Profiles and bean lots have a controller-owned sort rank used by every editor and Roast selector.
- A library that has never held a profiles document receives the two default profiles once, in one
  revision-checked write with fixed ids: **Espresso Express** (temperature journey, first) and
  **Espresso Express (timed)**. An emptied library keeps its document, so the defaults never return.
- Deleting a bean or profile preserves historical roasts because each roast embeds its snapshots.
  Cascade deletion is a separate idle-only typed-confirmation workflow.
- Manifest and recording-list responses are served from caches invalidated by every manifest-visible
  mutation; document saves update the reported store totals incrementally from that document's
  before/after envelope.

Thermal recordings use v4 `.crk`: a 220-byte header, CRC-32, delta-varint samples, immutable producer
identity, capture-time thermocouple correction, and program/journal or calibration-policy evidence.

- Every recordable roast reserves a provisional occurrence before actuation.
- A device-executed roast's setup is staged on the roaster at Start, never only in a browser. Before
  the Start command fires, the browser durably writes the complete run record (starting volume,
  ambient, bean lot id and snapshot, mass, name, profile snapshot, outcome `running`) to the document
  store in the same pre-actuation idle window. The write is a fail-closed precondition: a refusal means
  no Start, with the reason shown, and a busy refusal is surfaced rather than blind-retried.
- Archive reconciliation completes that record in place from the recording (linkage, outcome, thermal
  series; header-carried facts such as batch mass win), joined by observed recording identity, by
  sanitized name within 10 seconds of the roaster's start, or by Start boot plus name within 5 minutes
  when exactly one staged record matches. One recording has at most one run record; duplicates are
  folded into the staged record. A staged record from an earlier boot that no recording can complete
  settles as aborted. A non-recorded Controls session stages nothing.
- Detailed recordings use 1-second samples; compact recordings use 10-second samples. Roasts default
  to detailed.
- Manual Roast closes at operator Stop.
- Automatic roast and calibration evidence may retain a 180-second fan-off passive-decay recording
  tail. This records physics and commands no output.
- Immutable `{producer device, origin log id}` is separate from the mutable local storage address.
  Evidence is never hydrated or relinked by bare address.
- Hydration reads the archive index once per state revision, validates the raw `.crk` header and CRC,
  and matches immutable origin before accepting samples. Accepted samples are cached in the browser by
  recording identity, so a recording is downloaded once per browser, not once per page load.
- Retention plans the complete oldest-first deletion set before deleting anything, and deletes
  nothing when the new file cannot fit or would require more than 64 removals.

Whole backup is a zip of device documents, recordings, and applied calibration. Restore validates
every file before maintenance and uses a device-wide begin/commit/abort lease. A dirty partial restore
cannot be advertised as current or casually aborted, and a restore with a failed document write does
not commit. The NVS thermocouple correction is not restored automatically; each recording retains the
correction applied at capture.

## Roast modes

### Timed

An ordered Fan/Heat/duration schedule executes locally. Serialization preserves the final heated dwell
and appends an explicit terminal fan-only/off step when required by the authored format. That step is
workflow intent, not hidden actuator safety.

### Temperature journey

A journey contains up to 12 temperature zones with endpoints, nominal durations, and Fan/Heat bounds.
The device advances by measured attainment. Model inversion plus feedback runs once per second.
Within heating zones, Journey Heat moves by at most 0.25 level per one-second tick in either
direction; cooling zones, a lowered Heat ceiling, Stop, faults, and safety reductions apply immediately. Completed zones are immutable. Current and future zone edits require the
exact boot, session, and plan revision. TypeScript/C++ parity vectors cover mass scaling, holds,
transitions, irregular cadence, and live plan patches.

- **Airflow.** Journey holds Fan 10 through 130 °C, and that floor overrides a lower authored Fan
  maximum. Above 130 °C there is no journey-specific floor: the feed-forward baseline selects the
  greatest airflow whose required Heat can deliver the zone's slope, bounded only by the zone's own
  `fanMin` and the Heat-on Fan `1.0` rule, and Fan follows the solver at every tick. Bed circulation
  depends on bean density and volume in ways the controller cannot measure, so the zone's `fanMin` is
  the authored circulation control. Cooling uses Fan 10 / Heat 0.
- **Feedback.** Corrections move the pair from the baseline Heat first: Heat changes at the baseline
  Fan, and Fan moves only for what Heat cannot deliver at its band edge. The correction is
  `Kp·e + Kr·(slope - predicted RoR) + I`, with Kp 3 °C/min per °C, Kr 0.5 (derivative time 10 s), and
  a 45 s integral time. The predicted RoR is the trailing 10 s RoR extrapolated 10 s ahead, with the
  lead clamped to ±10 °C/min. The total is bounded to +15 °C/min heating and -12 °C/min cooling and the
  integral to ±8, with conditional anti-windup. The integral is held through cooling zones, whose
  Fan 10 / Heat 0 command the correction never reaches, so wound-up error cannot carry into a later
  heating zone.

This is temperature-journey behavior only; it does not alter timed profiles, Manual Roast, Controls,
or the underlying actuator. The derivation is in [`control-and-calibration.md`](control-and-calibration.md).

### Manual Roast

Manual Roast is a normal recordable roast. The operator chooses bean, mass, name, initial levels, and
recording detail. The device logs every accepted instruction and effective output against temperature.
Planned next steps are browser-local elapsed-time rows sorted by roast time; the next row shows a
countdown derived from device-owned elapsed time and becomes visibly due, but never auto-sends. Only
the operator's explicit Apply makes an instruction device-owned evidence. After Stop, the roast is
already in History and may optionally become a timed profile or loaded-roast calibration evidence.

### Controls

Controls applies Fan/Heat without bean, batch, history, or thermal archive. It is for setup and short
diagnostics, cannot run while a roast owns actuation, and cannot accidentally stop another owner.

The shell Stop is always available while outputs are active. Stops that would end an active roast arm
on first activation and fire on the second (self-disarming, in place, never a dialog), because a
single accidental tap must not abort a roast in progress. Non-roast stops remain single-tap, and the
transport Stop command is never preflighted or conditional.

## Calibration and temperature model

The model, fitting method, and evidence rules are specified in
[`control-and-calibration.md`](control-and-calibration.md); the operator workflow is in
[`web/docs/user-workflows.md`](../web/docs/user-workflows.md).

- Corrected thermocouple temperature is the runtime control measurement; raw and corrected evidence
  remain distinguishable.
- Empty-chamber passes measure coarse destination equilibrium and transition timing. Loaded roast data
  is more representative of bean physics.
- The default empty pass is Fan `1,4,7,10` × Heat `1,5,10`, with a 300-second step cap, 20-second
  minimum dwell, 20-second settle window, and 0.2 C settle band.
- Loaded evidence remains permanently tied to its roast and recording identity.
- Recording ambient is estimated from the lowest cold-junction value in the final fifth of the
  evidence, falling back to the coolest reading anywhere, never the potentially heat-soaked first
  restart sample.
- Loaded fitting simulates the complete trace but scores after the opening three-minute bean
  turnaround, whose single-node structural error must not drown the useful later evidence. Roasts
  shorter than the scored interval are declined.
- A selected empty-chamber baseline may pin directly measured airflow cooling while loaded evidence
  supplies heater gain and bean-side thermal loss. Pinned values stay frozen during the loaded search
  so the reported RMS describes exactly the saved set.
- Batch mass normalizes thermal capacity around 225 g: it scales the complete net heating/cooling rate,
  so more mass changes time-to-target but not a fixed Fan/Heat pair's equilibrium. Scaling only heater
  gain is forbidden because it invents a lower attainable temperature for heavier batches.
- Heating, forced-cooling, and passive-output-off modes share one Fan/Heat branch selector across
  replay, preview, fitting, mock plant, and controller inversion. Graduated-cylinder volume and bulk
  density remain recorded covariates and are not treated as solid-bean density.
- Preview is browser-local. Only an explicit, idle, acknowledged **Save and apply** changes device
  coefficients.
- Preview shows the measured versus fitted loaded-roast trace and empty-chamber response maps. It does
  not present single-node equilibrium settle times as loaded-roast predictions. Dashboard timings use
  a practical 2 °C band; a 0.2 °C band would add a constant tau·ln(10) tail to every cell.
- Deterministic multi-start fitting blocks Save/Apply when materially different cooling coefficients
  explain the evidence nearly equally well, and states which fan evidence is missing.
- Coefficient plausibility is checked in the browser, the apply endpoint, NVS load, and journey start.

## Browser requirements

- Responsive from phone through desktop without horizontal page scrolling.
- Phone navigation stays at the top; larger layouts use the persistent shell.
- Routine UX does not expose multi-roaster complexity. Identity appears for provenance, recovery, and
  explicit development target selection.
- Current Fan, Heat, temperature, lifecycle, elapsed time, and Stop remain visible.
- A small header heartbeat reflects accepted device-status freshness: translucent green through 3
  seconds, yellow after 3 seconds, and red after 5 seconds or on disconnect. Every accepted fresh
  report flashes solid green. It is observation only and never a safety or client-liveness input.
- The live socket is replaced when it goes silent, errors, or closes, without waiting for a close
  event; a page that becomes visible, comes back online, or has had no fresh frame for 20 seconds
  reconnects immediately. A weak-Wi-Fi notice appears when the roaster reports -78 dBm or weaker.
- Disabled operations state their reason in plain language.
- Rendering is all-or-nothing per view: no view shows partial data while loading. An expanded History
  record requires its run document, recording linkage, and reconciliation to be settled; otherwise it
  renders "Loading this roast..." with the reason when known. Settings storage says it is reading the
  recording list rather than claiming an empty archive, and cascade deletion waits for that list. A
  browser opened during a roast receives only the live stream until the roaster is idle, so Profiles,
  Beans, and History show "Loading the roaster library" until the library is read. Live
  roast surfaces (chart, readouts) are deliberately incremental: that is streaming, not loading.
- Header Stop during an active manual roast is an operator-requested stopped completion: the recording
  is reconciled into History, not marked aborted.
- Expanded History rows show their stored temperature curve. **Roast again** prefills the recorded
  profile snapshot, bean, starting mass, and starting volume without starting automatically.
- Each roast record may carry a whole-number `score` from 1 to 10. A bean lot's score is derived as the
  mean of its scored roasts, never entered; unscored lots sort after scored ones. At phone width every
  table with hidden columns offers a **Sort by** menu.
- Manual-roast duration ends at the first sample in the final Heat-off suffix. A later Stop remains the
  exact controller-session boundary but does not make the retained cooling or decay tail count as roast
  time.
- History measurements and notes are one explicit draft committed only by **Save changes**. Failed
  acknowledgement retains the draft and requires an operator-initiated retry; there is no autosave loop.
- Calibration build-list removal is non-destructive. Permanent recording deletion is a separately
  labelled, confirmed action.
- Temporary progress or success messages belong beside their initiating control and clear
  automatically.
- Generated roast, recording, and calibration names include local date plus 24-hour hour/minute time.
- Update shows the installed firmware version before file selection and distinguishes upload,
  structural validation, commit, reboot, and failure states.
- Reference includes approximate bean color, temperature, and common roast-style names.
- Destructive actions remain visible on collapsed rows and use scope-appropriate confirmation.
- Offline cached records remain readable but read-only after identity or attach failure.
- The leave prompt is raised only by unsaved work that exists nowhere but the open tab. Device-accepted
  live plan edits are not misrepresented as browser-unsaved work.

## Flash and storage layout

| Region | Offset | Size | Purpose |
| --- | ---: | ---: | --- |
| NVS | `0x9000` | 20 KiB | Wi-Fi, correction, coefficients, counters |
| OTA metadata | `0xE000` | 8 KiB | A/B selection and rollback |
| app0 | `0x10000` | 1,572,864 B | application slot |
| app1 | `0x190000` | 1,572,864 B | application slot |
| LittleFS | `0x310000` | 896 KiB | library and recordings |
| core dump | `0x3F0000` | 64 KiB | crash evidence |

Application binaries, including the embedded web bundle, must stay below the `0x180000` slot size.
Firmware and web compression creates OTA headroom, not recording capacity. Capacity moves between
those regions only through another partition migration. Normal deletion workflows reclaim LittleFS.

Normal OTA accepts the application-only versioned `.bin` at `/update`. Serial release packages
contain the bootloader, partition table, `boot_app0.bin`, and application at explicit offsets with
SHA-256 checks; they contain no merged image and no erase command. See
[`firmware/crackle/README.md`](../firmware/crackle/README.md).

## Development and verification

The test layers, what each proves, and when to run them are in [`testing.md`](testing.md). Build,
contribution, and release conventions are in [`../CONTRIBUTING.md`](../CONTRIBUTING.md). Physical
compiles use `PartitionScheme=custom`, `PSRAM=enabled`, and `EraseFlash=none`; any web change
requires rebuilding and committing the embedded bundle.

## Known limits and deliberate scope decisions

- **No authentication or TLS.** The product assumes a trusted LAN. The browser already treats `401`
  as a sign-in requirement, so authentication can be added in firmware later.
- **No crack or dry-end markers.** Adding them would require a device-owned event and archive API;
  browser-only markers are forbidden by the source-of-truth rule, and no model input may consume a
  human annotation.
- **No factory reset or decommission.** It would combine credential, NVS, and volume destruction and
  requires a separately designed recovery path. `Format storage` exists only when the device reports
  that its volume needs formatting.
- **Not yet implemented:** device event annotations, Artisan CSV export, and configurable
  isolated-LAN NTP. Recordings made without a synced clock carry boot identity and read as "date
  unknown".
- **Unattended manual heat is bounded, not prevented.** A manual instruction keeps heating at its
  levels for up to 30 minutes after the last accepted instruction.
- **No synthesized cooling after automatic endings.** A profile that ends with the heater on ends with
  outputs off; preflight warns about it.
- **No density-to-circulation law.** Volume and bulk density are recorded observations; airflow at
  load is the profile author's `fanMin`.
- **A progressing download serializes the bulk storage lane.** Per-send waits are bounded; command,
  Stop, live, asset, and OTA lanes remain independent.
- **History and Roast keep separate acknowledged-save state machines**, because their lifecycle and
  cardinality differ.
- **A 1 Hz single-user shell render is accepted**; expensive derived work is memoized.
- **Python source contracts pin architecture and wiring.** They are cheap structural checks and are
  never represented as behavioral proof; native C++ suites and web tests execute behavior.

## Documentation authority

When documents disagree:

1. Current code and tests define observed implementation behavior.
2. This specification defines intended product behavior.
3. Within their scopes:
   [`firmware/safety-policy.md`](../firmware/safety-policy.md) owns safety;
   [`firmware/actuator-core.md`](../firmware/actuator-core.md) owns the audited actuator;
   [`firmware/crackle/README.md`](../firmware/crackle/README.md) owns firmware, API, storage, and
   release packaging; [`network-architecture.md`](network-architecture.md) owns the transport;
   [`control-and-calibration.md`](control-and-calibration.md) owns the thermal model, fitting, and
   journey control law; [`web/docs/controller-integration.md`](../web/docs/controller-integration.md)
   owns browser/controller behavior; and [`web/docs/user-workflows.md`](../web/docs/user-workflows.md)
   owns operator workflows.
4. [`hardware/installation.md`](../hardware/installation.md) and
   [`hardware/safety-checklist.md`](../hardware/safety-checklist.md) own physical installation.
5. [`architecture.md`](architecture.md) and [`design-decisions.md`](design-decisions.md) explain the
   system and the reasons behind it; captures under [`data/`](../data/README.md) are evidence.

An intentional contract change must update the relevant normative documents in the same commit.
