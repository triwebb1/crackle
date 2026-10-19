# Controller integration

This is the normative browser/controller protocol beneath the
[product specification](../../docs/product-spec.md). Firmware-side detail (routes, status fields,
storage, and the executor) is in [`firmware/crackle/README.md`](../../firmware/crackle/README.md);
the transport design is in [`docs/network-architecture.md`](../../docs/network-architecture.md).

The firmware serves everything from one native ESP-IDF HTTP/WebSocket service on port 80. Two general
workers handle immutable status/live reads and ordinary commands; assets, LittleFS, raw OTA, and Stop
each have an isolated bounded lane. The control loop owns mutable state through two mailbox slots
plus a reserved Stop slot. Same-origin `/ws/live` publishes a coherent snapshot followed by
sequence-fenced deltas at no more than 1 Hz; at most four subscribers keep four of the eight server
sockets free for HTTP.

A roast is a **device-resident program**, a sibling of the calibration program built from the same
parts: it owns and renews its own 30 s Heat leases, ends on a fault exactly as calibration does, and
sits above the audited hardware-timed actuator boundary. Heat-off creates no actuator cooling debt;
any Fan-only process cooling is explicitly owned by a workflow.

The browser proposes a plan or operator instruction, starts, watches, may request a safe journey edit
or manual level change, and can always Stop. The roaster validates every proposal, publishes the
accepted revision, and remains the source of truth. Timed and journey execution never depend on the
browser coming back.

---

## The instruction lease, and why no client-liveness rule belongs anywhere

One rule covers every path that can command the machine. **An instruction is good for at most 30
minutes, and a new instruction - the same levels repeated or different ones - resets the clock.**
Nothing else resets it; in particular, nothing about a browser being open resets it.

| | **Timed / journey roast** | **Manual instruction (Controls or manual roast)** |
| --- | --- | --- |
| Who owns accepted state | The device | The device, after validating the operator's instruction |
| A browser that disappears | Irrelevant - the point of the feature | Irrelevant; the instruction deadline still bounds Heat |
| What ends unattended heat | Runtime envelope (2x nominal + 600 s) | 30 min after the last accepted set; `end_reason: instruction_expired` |

Manual is the one path where the 30-minute lifetime is enforced by an explicit timer, because its
next instruction comes from a person. Journey re-instructs the actuator every second and timed
execution renews at five-second intervals, so automated plans satisfy the shorter actuator lease by
construction. The diagnostic Controls path uses `/api/manual/set`; a manual roast uses
`/api/roast/start` and session-fenced `/api/roast/set`.

**Why there is no client keepalive.** A keepalive (Heat released after some seconds of browser
silence, with the page re-posting the applied levels to prevent it) makes closing a browser cut the
heat, treating an ordinary deliberate action as an emergency, and it puts a safety property in
JavaScript on whatever device happens to be watching rather than in the firmware.
`src/domain/manualControl.ts` implements no such timer; Controls states the lease in one line.

---

## The browser's controller surface

The production controller surface is exactly 26 paths, by explicit allow-list in
`src/controller/fetchSurface.test.ts`. Local development adds Vite-only routes that are absent from
production firmware and bundles: the confirmed `/api/dev/power-cycle` recovery route,
`/api/dev/probe`, and `/api/dev/live-drop`, which severs every live WebSocket subscriber so the
reconnect-and-resync path can be exercised on demand (Settings > Advanced > Drop live stream). The
same test asserts that `fetch(` appears in `src/controller/client.ts` and nowhere else, and that no
path is composed from a bare template literal.

The allow-list holds **strings, not methods**; the Method column says how each is used.
`/logs/<id>.csv` and `/logs/<id>.crk` are the one allow-listed prefix `/logs/`, listed twice because
they are two representations of the same resource. The executable test, not this prose, is the count
authority.

One `HttpControllerClient` owns HTTP, WebSocket, documents, archives, backup/restore, and commands.
Its configured origin is resolved consistently for every request; the live WebSocket is same-origin
at `/ws/live` and follows the page's scheme, host, and port. Production uses the controller serving
the page. Local development adds explicit mock and physical-proxy targets behind the same origin.
Crackle preflights status and simulated/physical kind, binds a target-specific cache to the observed
device identity, blocks a switch during active/cooling/restore/pending-write/working-overlay states,
and then performs a full-page handoff.

Bulk transfer deliberately uses HTTP streaming, not the live WebSocket. WebSocket frames share one
ordered TCP stream, so a long recording response could delay a current-state or Stop-visible frame
unless the app also implemented prioritization and backpressure. The firmware instead streams
generated JSON/CSV, documents, and raw recordings through bounded HTTP workers and stops abandoned
work after its renewable no-progress lease. Each browser serializes controller-sized storage work
through one per-target FIFO, buffers the response body before releasing that lane, and waits up to
15 seconds through explicit `503 + Retry-After` pre-admission refusals. Firmware keeps one storage
worker but accepts three queued request records, so two browsers are queued instead of one seeing an
avoidable empty catalog. Local IndexedDB operations may still run concurrently.

| Path | Method | Why |
| --- | --- | --- |
| `/api/status` | GET | Observation and the contract document. Read at initialization and explicit reconciliation points, not on a routine timer; built from an immutable snapshot and available during outputs and recording tails. |
| `/api/live` | GET | Compact observation fallback, probed at 1 Hz after 8 s without a fresh WebSocket frame. |
| `/ws/live` | WebSocket | One initial compact snapshot followed by sequence-fenced top-level deltas at no more than 1 Hz. |
| `/api/calibration/start` | POST | Diagnostic calibration program. |
| `/api/calibration/stop` | POST | Aborts it and turns both outputs off. |
| `/api/calibration/apply` | POST | Stores fitted coefficients fail-closed: invalidate first, verify every field, mark present last, then require exact readback. |
| `/api/manual/set` | POST | Applies Fan and Heat; also resets the 30-minute instruction lease. |
| `/api/manual/stop` | POST | Stops diagnostic Controls output without preflight and reports any roast recording as saved or pending. |
| `/api/stop` | POST | Workflow-agnostic Stop, sent without a status preflight; reports any active recording as saved or pending. When it interrupts an active roast, Heat is off immediately and the executor runs a ten-second Fan 10 / Heat 0 cooling tail before the outputs go idle; any newer instruction, including a second Stop, preempts the tail. During an active manual roast, the web workflow treats its acknowledgement as a stopped, retained roast and reconciles History. |
| `/api/logs` | GET | The device log index. |
| `/api/logs/delete` | POST | Deletes one stored recording. |
| `/logs/<id>.csv` | GET | One stored recording, decoded into the `/thermal.csv` format. |
| `/logs/<id>.crk` | GET | One stored recording, as the file on the volume. Same prefix; the suffix picks. |
| `/thermal.csv` | GET | Read-only snapshot of the current RAM recording. While recording is active it serves the consistent already-recorded prefix (samples are append-only), so a browser joining mid-roast can hydrate the earlier curve. |
| `/api/roast/start` | POST | Hands over a timed/journey plan or the first manual instruction. |
| `/api/roast/active-plan` | GET / POST | Reconstructs the exact retained plan, or safely patches an active journey with session/revision fencing. |
| `/api/roast/set` | POST | Applies a matching manual-roast instruction and resets its device-owned deadline. |
| `/api/roast/stop` | POST | Stops the roast and is never refused; a stale `expected_session` is reported as `session_mismatch`. Success reports whether the terminal recording is saved or pending retry. |
| `/api/settings/thermocouple-offset` | POST | Persists the idle-gated -25..25 °C sensor correction on the roaster and advances `state_rev`. |
| `/api/data/manifest` | GET | Revision-fenced authoritative inventory: all four collection slots plus 64 combined run/recording entries per opaque cursor page. |
| `/api/data/` | GET / POST | The document store. Parent of the four collections, the run index, and `runs/<id>`. |
| `/api/data/delete` | POST | Removes one document. `target=` plus `confirm=DELETE_DATA`. |
| `/api/logs/format` | POST | Erases the whole volume - recordings AND `/data`. `confirm=FORMAT_LOGS`. |
| `/api/logs/restore` | POST | Puts one recording back. `id=auto` allocates a local address while preserving its v4 producer origin; a positive numeric id requests that exact address. Requires `confirm=RESTORE_LOG` and one raw `application/octet-stream` body, streamed to a temporary file, validated, then atomically renamed. |
| `/api/restore/begin` | POST | Opens or resumes device-wide restore maintenance and returns its token. |
| `/api/restore/commit` | POST | Commits the matching lease and publishes its final authoritative revision. |
| `/api/restore/abort` | POST | Aborts only while the lease is clean; dirty partial restores must resume and commit. |

Every Stop route uses the reserved Stop lane. Raw recording round-trip needed exactly two new paths:
`/logs/` was already the parent of the per-recording fetch, so serving the raw file needed no new
address, and the suffix chooses between decoded CSV and stored bytes. The restore transaction adds
three fixed begin/commit/abort routes so incomplete device-wide maintenance is explicit.

**Roast execution uses explicit, reviewable commands rather than a per-tick channel.** Start hands the
plan to the controller, Stop requests a safe end, Set applies operator changes during a manual roast,
and active-plan GET/POST reconstructs or deliberately edits a running journey. Firmware validates
session and plan revisions, owns every accepted plan, and records accepted edits; browser
disconnection never becomes a control event.

Active-plan GET returns the retained plan even across the final edge. POST requires
`PATCH_ROAST_PLAN`, matching `expected_session`/`expected_plan_rev`, a complete proposed zone list,
immutable completed zones, unchanged active-zone direction, and at least five seconds remaining.
Crossing the edited endpoint requires `allow_immediate_transition=1`. The accepted edit advances
`plan_rev` and is appended to the recording's bounded codec-2 provenance journal. GET also returns
`initial_zones` from the immutable archived start plan, so a reconnecting browser can show a
field-by-field initial-to-final review without reconstructing device truth. Manual-roast Set likewise
requires the matching session and returns accepted/effective levels; a slider position is never
authority until that acknowledgement arrives.

The thermocouple correction is device state, not browser math. Settings writes `offset_c` (-25
through 25 °C) only while idle with `SET_THERMOCOUPLE_OFFSET`; firmware persists it in NVS, applies it
before safety/control/logging, reports `thermocouple_offset_c`, and advances `state_rev`. Every v4
archive CRC-protects the signed correction used at capture, so later setting changes cannot silently
change the meaning of older evidence.

---

## `POST /api/roast/start`

Form-encoded query arguments, serialized by `src/domain/roastProgram.ts`, which mirrors every bound
the firmware checks so a request the firmware would refuse never leaves the browser.

| Argument | Modes | Meaning |
| --- | --- | --- |
| `confirm` | all | Exactly `START_ROAST`. |
| `mode` | all | `timed`, `journey`, or `manual`. |
| `name` | all | Up to 32 **bytes**, sanitized to `[A-Za-z0-9._:- ]`. |
| `mass` | all | 20-2000 g, integer. Only journey mode uses it for inversion. |
| `profile_id`, `profile_revision` | all | Exact committed device profile identity, when one was selected. |
| `steps` | timed | 1-24 `fan:heat:seconds`, comma separated. |
| `zones` | journey | 1-12 `endC:duration:fanMin:fanMax:heatMin:heatMax`, semicolon separated. |
| `start` | journey | The journey's start temperature in C. |
| `fan`, `heat` | manual | Initial instruction; fan 0.1-10, heat 0-10. |
| `record` | all | `0` selects the compact 10-second archive; absent/other selects detailed 1-second samples. Both preserve the authoritative occurrence, initial plan, and accepted instruction journal. The Roast page preselects detailed. |

Every heat-carrying pair is subject to the command-layer rule that Heat on means Fan `1.0` or higher:
the browser and firmware lift a lower Fan to `1.0` rather than refusing an older profile.

**Timed**: each point is held for its authored duration; when the final point ends, both outputs stop.

```text
steps=8.2:4.6:135,7.8:5.8:150,7.2:7:145,6.4:8.1:140,5.8:7.4:45,9:0:90
```

**Journey**: zone start temperatures are never authored. Zone 0 starts at `start` and every later
zone starts where the one before it ended, the same relinking the profile editor does. Durations are
always sent as explicit seconds rather than the `r<rate>` form, because a derived duration the
firmware then range-checks is one more place two implementations could diverge.

```text
zones=150:210:5:9:3:8;175:120:5:9:3:9;196:135:4:8:4:9;210:120:4:8:3:9;40:180:3:10:0:0&start=24.8
```

**The name is sanitized before it is sent**, over bytes rather than characters, because the
firmware's limit is 32 bytes and its substitution is per byte. That keeps the echoed display name
byte-identical to what went out. Recording joins do not depend on that label: they use the archive's
immutable producer-device/origin-id key, while profile association uses a committed profile
id/revision where the plan carried one and otherwise requires an exact, unambiguous sanitized-name
match.

### Every refusal, in plain language

`roastStartFailure` maps the documented statuses. The controller's own message is preserved: when the
actuator refuses an opening request, the firmware passes the actuator's words through, and those are
the most specific explanation available.

| Status | Reads as |
| --- | --- |
| `423` | ESP actuation is latched off after a manual-control conflict; only a power cycle clears it. |
| `409` + calibration | A journey roast needs applied coefficients. Fit and apply one, or run it timed. |
| `409` + thermocouple | No fresh, fault-free reading below the overheat limit (260 C by default), so a plan using heat is refused. |
| `409` + confirm | The browser and that firmware disagree about the roast contract. |
| `409` otherwise | Busy: a fan test, heater proof, calibration pass, manual session, or unfinished roast. |
| `400` | The plan serializes outside the ranges the controller accepts. |
| no answer | It is **unknown** whether the roast started. The staged run record is kept and the outcome reconciled from status before any retry. |

---

## The pre-start gate and model prediction warning

`roastPreflight` mirrors the firmware's real admission gates, so malformed plans, missing applied
coefficients, stale or invalid probe data, faults, or another active owner disable Start with a
specific reason. Model feasibility is different: it is a prediction from fitted coefficients, not a
device admission or safety rule, so it is shown as **Prediction to review - Start remains
available**. Preflight also warns when a journey's final zone or a timed profile's final step ends
with the heater on (`ENDS_HEATING_WARNING`, `TIMED_ENDS_HEATING_WARNING`), because automatic endings
stop both outputs with no synthesized cooling.

The warning names the zone, complete Fan/Heat ranges, modelled steady-state ceiling, and replay RMS
when the applied fit matches a saved snapshot. Batch mass scales the complete net thermal rate: more
mass changes the modelled approach time, not the fixed-input equilibrium. A reachability ceiling is
therefore never lowered merely because the requested batch is heavier than a source batch.

Matching raw calibration evidence is stronger than a fitted ceiling. If a source roast already
attained the endpoint while Fan and Heat were inside the zone's authored ranges, preflight records
that measured lower bound and does not warn that the same endpoint is unreachable.

The controller never silently advances past an unattained endpoint. Firmware owns the finite
boundary: every automated roast stops all outputs at twice the plan's nominal duration plus ten
minutes and records `envelope_timeout`. The browser warning cannot shorten, extend, or replace that
envelope.

Journey's feed-forward baseline solves the calibrated thermal balance for the zone's slope and
selects the greatest Fan whose required Heat remains available. Feedback corrections move the pair
from that baseline Heat first: Heat changes at the baseline Fan, and Fan moves only for what Heat
cannot deliver at its band edge. The correction is PI on position error plus a lag-compensated rate
term (the trailing 10 s RoR extrapolated 10 s ahead, lead clamped to ±10 °C/min), bounded to
+15 °C/min heating and -12 °C/min cooling with the integral clamped to ±8 and held during cooling
zones. The circulation policy that bounds the solve: Fan 10 through 130 °C, which wins over a lower
authored Fan maximum; above 130 °C, only the zone's authored `fanMin` and the Heat-on Fan `1.0` rule;
Fan 10 / Heat 0 in cooling. Fan follows the solver's output immediately at every tick. There is no
mass-scaled Fan floor and no reduction rate limit: bed circulation depends on bean density and
volume in ways the controller cannot measure, so the zone's `fanMin` is the authored circulation
control. The full derivation is in [`docs/control-and-calibration.md`](../../docs/control-and-calibration.md).

**Feasibility is solved against the coefficients the device will invert**, read from
`status.applied_calibration`, not the app's own set. The roast is solved on the controller, so the
app's set would answer a question nobody asked. If the two sets differ, that is a **warning**, never
a blocker: the controller's set still runs the roast.

---

## Watching a roast that is not yours

`GET /api/status` carries a `roast` object, running or not. **Its presence is the feature detection**
for the executor, exactly as `log_archive` is for the archive; firmware without it keeps a
deliberately impossible Start path.

While `roast.active`, **the device is the single source of truth**. The Roast page reports mode, name,
zone index and count, in-zone elapsed against nominal, the anchored target, commanded and solved
levels, the PI correction and its integral, holdover against its 30 s budget, the frozen ambient, and
the batch mass, all from device state. The browser's own `liveJourneyControl` fold is withdrawn while
the device executes: two rival readings of one roast is exactly the class of bug the "one control
law" rule exists to prevent.

The 1 Hz snapshot begins with `boot_id`, string `state_rev`, monotonic `stream_seq`,
`roast_session_id`, and `plan_rev`, then carries compact telemetry and the executor's whole per-tick
progress tuple: `roast_zone_entry_s`, `roast_zone_nominal_s`, `roast_zone_end_c`, `roast_correction`,
`roast_integral`, `roast_solved_fan`/`roast_solved_heat`, `roast_holdover_ms`, `roast_end`, and the
per-zone attainment array `roast_zones_done`, published atomically with `roast_zone` from the same
state the control law advances. That matters because full status is deferred for as long as anything
actuates: during a roast this stream is the only transport for cockpit progress, and
`mergeLiveSnapshot` trusts the self-coherent tuple without waiting for a status poll. For firmware
that streams a zone index without its entry tuple, the merge freezes the zone tuple at the last
status document's values rather than mixing two zones' timestamps.

The browser accepts frames only into the matching boot/session/plan. Forward sequence gaps are
expected because snapshot publication and WebSocket delivery have different cadences. A duplicate
frame is ignored because it proves socket activity but not fresh device state; a reorder or reboot
degrades telemetry authority. Freshness timing:

| Without a fresh frame | Browser action |
| --- | --- |
| 8 s | Probe compact HTTP live state (`/api/live`) at 1 Hz; a probe outstanding for 8 s is abandoned |
| 12 s | Reconnect the socket |
| 15 s | Gate mutations; Stop stays available |
| 20 s (visible page) | Replace the socket again, at most this often |

A page that becomes visible, is restored from the back-forward cache, comes back online, or regains
focus while its newest frame is older than 4 s replaces its socket and probes `/api/live` immediately.
`subscribeLive` returns a `LiveSubscription` whose `reconnect()` replaces the socket without waiting
for `onclose`, which a mobile browser may never deliver after a screen lock.

Live controls unlock after fresh status and any required active plan are current; they do **not**
wait for catalog storage or a manifest that cannot mount. Library mutations remain separately gated
on mounted storage and current catalog state. Fields absent from the live DTO remain status-owned.

The header heartbeat presents accepted-report freshness without changing transport authority. An
accepted fresh WebSocket frame, compact HTTP live snapshot, or reconciled full status flashes the lamp
solid green. It rests translucent green through 3 seconds, becomes yellow after 3 seconds, and red
after 5 seconds or on disconnect. Rejected duplicate/reordered frames do not refresh it. The lamp is
presentation only: firmware never consumes it, and it is not a client keepalive, Heat lease, safety
input, or reason to alter a device-owned roast.

Manual-roast planned steps remain browser presentation until explicitly applied. Rows carry an
absolute elapsed time and the next row's countdown derives from device-reported roast elapsed time.
Reaching zero only produces a **Due now** state; it never schedules a browser-owned command or changes
the device's instruction lease.

A `state_rev` change observed during actuation, cooling, or recording is remembered, but manifest
reconciliation is deferred and coalesced until idle, so synchronous LittleFS inventory work never
competes with the actuator loop or thermal recording. Full status is not a routine heartbeat; it owns
capabilities and durable metadata, while accepted merged live telemetry owns freshness for mutation
gates. A gate keyed to the age of the last full-status fetch would go stale during a healthy 1 Hz
stream.

Full status also owns the optional `system` diagnostic block: reset reason and recent boot history,
uptime, current/minimum/largest heap and PSRAM, worker stack reserves, last/maximum loop gap,
archive-persist timing, slowest storage request, station RSSI, and Wi-Fi disconnect count.
`max31856.fault_reasons` decodes status-register bits into stable names such as `open_circuit`;
clients retain the raw bitfield too. Settings Advanced renders the operator-relevant subset. These
fields are observational and never replace the freshness, qualification, overtemperature, or
actuator gates. When the roaster reports -78 dBm or weaker, the app shows a weak-signal notice,
because packet loss at that level makes live status stall.

Stop is inside the running panel rather than in an actions column, so it is present on every route
into that screen, including for a browser that arrived halfway through a roast it never started. Like
`stopManual`, it is sent with no preflight; the always-visible header Stop uses the same route. Stop
controls that would end an active roast arm on the first tap and fire on the second, self-disarming,
in place, never a dialog; non-roast stops are single-tap. If a manual roast is active, an acknowledged
Stop is a normal completion boundary: the browser preserves the working run, waits for the
authoritative archive when necessary, and reconciles it into History rather than labelling the
session aborted.

On reconnect, the browser fetches the exact active plan and uses `thermal_log.log_id` to hydrate the
curve. It prefers the matching archived `/logs/<id>.csv`; whenever the recording is still in RAM -
active or stopped-but-unarchived - it falls back to `/thermal.csv`, which serves the consistent
already-recorded prefix, and live samples extend the curve from there.

That join-time read is keyed to the session and runs once. A browser that was already watching and
missed part of the stream for the same session re-reads the recording prefix and merges it by roaster
second (`domain/liveTraceResync.ts`). The triggers are the WebSocket reconnecting after it had been
up, the page becoming visible again or being restored from the back-forward cache, a hole of more than
three frames in the per-boot sequence, and a jump of more than three seconds of roaster clock between
two consecutively accepted samples. The roaster's sample wins every second it covers; browser-only
seconds survive. The read is bounded to one in flight with a two-second minimum spacing and doubling
backoff on failure, and the ordinary GET retry honours `503 + Retry-After` underneath it. Browser
samples are stamped with `roast_elapsed_s` and the recording is rebased onto its first sample, so both
series are whole roaster seconds. While the roaster executes a roast, the Roast page draws only that
roast's device-keyed trace, never a session record this browser still holds; once the roaster is idle,
the completed archive record (cooling tail included) replaces the display-only live buffer. If a live
journey was edited, the Save/Discard decision is keyed to the device boot/session/plan revision and
remains available across reload and the final edge; either choice starts from the roaster-retained
plan, never from an uncommitted browser reconstruction.

`end_reason` is mapped exhaustively in `ROAST_END_REASONS`: `completed`, `stopped`, `fault`,
`telemetry_stale`, `sensor_lost`, `qualification_stalled`, `step_rejected`, `renewal_rejected`,
`command_rejected`, `envelope_timeout`, `instruction_expired`, and `heat_lease_expired`. `none` is
the idle sentinel and is parsed away. The protective ones read as protection rather than as failure.

---

## The library lives on the controller

Profiles, bean lots, roast records, calibration passes, and fits live under `/data` on the same
LittleFS volume as the recordings archive, so every browser sees the same library. **The device is
the source of truth and the browser is a cache over it.**

`src/data/deviceStore.ts` is the layer every screen talks to. It keeps the repository's verbs, and
`src/data/repository.ts` serves as the IndexedDB mirror and as the whole implementation on firmware
that has no store.

**The firmware never parses a document.** It owns a 16-byte `CDOC` envelope - magic, prefix version,
document version, payload length - and returns every other byte exactly as it arrived. So
`src/data/documentSerializer.ts` is the entire schema, and a schema change needs no firmware release.

### Feature detection, boot, and who wins

`data_store` in `/api/status` is the signal, exactly as `log_archive` is for recordings and `roast` is
for the executor. On the first status carrying it, the layer attaches through
`GET /api/data/manifest`. Every page carries string `state_rev` and `boot_id`, all four collection
slots, and at most 64 combined run and recording entries. The browser follows opaque `next_cursor`
values and fetches only documents whose versions changed. A changed revision or boot, repeated cursor,
or restore-maintenance marker discards the partial read; **the controller's copy replaces the cache**
only after a stable fence.

On firmware **without** `data_store`, nothing on `/api/data` is requested. The app runs on IndexedDB
alone, and Settings says history is browser-local.

### Writes: version-checked and acknowledged

Every write posts the `base` version it was built on. A browser's storage reads and acknowledged
document writes share the target FIFO above; safety, control, and Stop remain independent.

| Answer | What it means | What the app does |
| --- | --- | --- |
| `409` **with** `conflict: true` | Another browser wrote first | Refetch, **replay the mutation** on the fresh document, retry once, then surface |
| `409` **without** it | The firmware's idle gate: actuation or cooling is running | Keep the edit uncommitted and visible; retry when idle |
| `503` **with** `Retry-After` | The bounded storage FIFO is temporarily full before side effects | Wait in the browser FIFO and retry within the 15-second budget; if exhausted, keep the draft and surface busy |
| `503` **without** `Retry-After` / unreachable | Storage is unavailable or the connection ended | Stay readable from the working copy; do not claim acknowledgement |
| `413` / `507` | Too large / volume floor | Surface it to the operator |

A whole-record save (`commitRevisioned(..., subject)`) refuses to replay over the same record changed
elsewhere, and archive reconciliation rebases onto the current record (`saveReconciledRun`) so it
keeps operator edits made while it ran. Document bodies must arrive within 15 s and recording restore
bodies within 120 s, or the firmware abandons the upload and releases the storage guard.

History measurements and notes add a stricter human commit boundary: editing changes only the row's
visible draft, and **Save changes** submits one batched patch. Failure retains the draft and exact
error until the operator explicitly chooses **Try save again**; there is no debounce, background
retry, or unmount flush.

**A mutation is a function, not a payload.** The conflict path rests on this: "save a final weight"
replayed onto a document where another browser saved a tasting note produces a roast carrying both,
where resending finished bytes would have destroyed one of them. It is also why
`updateRun(id, patch)` exists beside `saveRun(run)`: a whole-record save cannot rebase into anything
better than last-write-wins.

Ordinary profile, bean, roast, calibration, import, and delete actions use `commitRevisioned` and
require device acknowledgement; nothing is scheduled to fire later. The older queue machinery remains
only for explicit whole-library adoption (and the development reseed): it waits for the idle gate,
replays every queued mutation for a document after a conflict refetch, and coalesces repeated edits
to one document into one POST.

### What a document holds

| Document | Holds |
| --- | --- |
| `profiles` | Profiles, plus the newest few revisions per profile |
| `beans` | Bean lots, plus the newest few revisions per lot |
| `calibrations` | The calibration record, named calibrations, and passes with their samples |
| `meta` | The imported-recording ledger, the newest Controls history rows, and `lastExportedAt` |
| `runs/<id>` | One roast: metadata, a bounded fallback curve, and a reference to its controller recording |

A collection is capped at 12 KB and a run at 8 KB by firmware, while the browser targets 8 KB and 6 KB.
It minifies the JSON schema, zlib-compresses it, and Base64-wraps the result as a NUL-safe ASCII
`CRKZ1` payload. Serializers shed the most expendable content until the soft target is met - oldest
revisions, oldest Controls rows, sample density, display curves of the oldest calibration snapshots
(never the newest three or the applied one) - and record what they shed. The browser keeps at most 40
edit revisions per profile in IndexedDB; the controller payload keeps at most the newest six per
profile and fewer when needed to meet the target. A profile and its revision are saved in one
acknowledged document write, and a content-identical Save performs no write.

A roast document carries `recordingId` plus a bounded fallback curve. `/logs/<id>.crk` is the
authoritative occurrence archive while it exists: compact samples every 10 seconds, detailed every
second. Both carry the same initial plan and accepted instruction journal, independent TC/CJ missing
states, effective outputs, and capture-time probe correction. Calibration recordings instead carry
the exact accepted test steps and settle policy. The fallback keeps History useful after automatic or
explicit recording cleanup.

On attach, a browser reads the archive index once per state revision (every archive change advances
it), downloads `/logs/<id>.crk`, validates its header and CRC, and hydrates only when the archive's
immutable producer device/origin id matches the document. Accepted samples are cached in IndexedDB by
recording identity (`hydratedRecording:<key>`, pruned through `hydratedRecordingIndex`), so later
page loads reuse them instead of downloading again. A mutable storage address is never accepted as
evidence identity. Even-stride downsampling always preserves both ends of the fallback.

### Tenths of a degree on disk

Mirroring what the firmware does to archived recordings, and centralised in one module
(`diskTemperatureC` / `diskLevel` in `src/data/documentSerializer.ts`) so it cannot be half-applied:

| | On disk |
| --- | --- |
| Peak temperature, stored sample readings, settled mesh temperatures, rise over ambient, ambient | **tenths of a degree**, half away from zero |
| Fitted coefficients, R², τ, fit RMS | full precision - regression output, not measurements |
| Authored profile setpoints and zone endpoints | full precision - authored intent |
| Fan and heat levels, rate of rise | one decimal - the step the controller can command |

Whole degrees would be too coarse: the passive decay tail changes sub-degree over many samples and is
the most fit-critical stretch of a recording, and at whole-degree resolution a 0.1 °C/s decay becomes
a staircase of ten-second flats. Hundredths would be noise.

Live safety, control, and status retain the fresh floating-point sensor reading. The bounded RAM
recording and both CSV/archive representations use the same 0.1 °C measurement precision, avoiding
both false hundredths and int16 centi-degree overflow.

### Adoption

The first time a browser meets a `data_store` controller whose store is empty while the cache holds
something, Settings offers one button with counts on it. Runs push as individual documents;
collections push whole. It is offered once and never taken automatically: an empty controller is
either a new controller or a wiped one, and only the operator knows which.

### Deleting, and why it is never deferred

A cascade delete destroys roast documents and their recordings with no undo. A deferred one would fire
at an unannounced later moment, possibly after the operator changed their mind or onto a library
another browser had since changed.

So `deleteRunsNow(ids)` calls `deleteDocument` directly, one id at a time, and
`cascadeBlockedReason` refuses the whole operation up front unless the controller is reachable, idle,
and its recording list has been read:

| State | What the panel says |
| --- | --- |
| No `data_store` | "This controller has no document store, so there is nothing on it to delete." |
| Unreachable / offline | "...needs it reachable, and this is never queued - try again when it is back." |
| Active actuator owner | "The controller defers every flash write until actuation finishes." |

A document the device refuses is **reported**, not retried, and the working copy loses only what the
device confirmed gone, so a partial failure leaves the browser telling the truth.

**The order inside a cascade is not arbitrary.** The imported-recordings ledger in `meta` is marked
first:

1. `markDeviceLogsImported(recordingOriginKeys)` - compound producer-device/origin-id keys, additive
   and idempotent.
2. `deleteRunsNow(runIds)` - the run documents, via `POST /api/data/delete`.
3. `POST /api/logs/delete` per local storage address, only for addresses this device still holds.
4. The profile or bean lot itself, last, since until then it still describes those roasts.

If step 2 or 3 fails halfway, step 1 has already guaranteed that archive reconciliation cannot
re-import a surviving recording as a new roast. **A half-finished delete must never resurrect what it
already removed.** This is also why the ledger is never pruned when a recording is deleted: it must
keep saying "this one was handled" long after the device copy is gone.

### Deleting a profile or a bean lot does not delete its roasts

Every run document embeds its own snapshot of the profile and bean lot it ran with, so a roast whose
profile has been deleted still opens, charts, and compares; it lists as unlinked. The impact panels on
Profiles and Beans therefore offer **two** operations: delete the recipe (nothing historical is lost),
or delete it *and* its roasts and their recordings (typed confirmation of the entity's name, with
counts, bytes, and date range stated first). `cascadePlan` in `src/domain/storage.ts` builds the
second as pure logic, and excludes any recording the controller no longer holds, since a delete for
one of those would answer `404` and read as a failure.

### Backup: the whole library as a zip

One button in Settings assembles `crackle-backup-<date>.zip`:

```text
manifest.json                    what this file is, when it was made, and what is in it
collections/<name>.json          the four stored collection documents, verbatim
runs/<id>.json                   one per roast record, verbatim
recordings/<id>.crk              the archive file, raw bytes, exactly as the volume holds it
config/applied-calibration.json  the coefficient set the roaster is running on
```

**A recording is in the file as bytes.** Decoded CSV is a rendering of a recording - re-rounded,
stripped of its header and checksum - and a rendering cannot be put back. `GET /logs/<id>.crk`
interprets nothing on the way out, and the backup keeps that: header, payload, and CRC, byte for byte.
A recording that has gone bad in flash can still be examined or repaired off-device from a byte-exact
copy.

**A document is in the file as the payload the roaster stores.** The same string goes back to
`POST /api/data/<name>?base=0`. A backup that re-encoded its contents would capture what one build of
the app thinks the schema is; this captures what the roaster actually held.

Recordings are fetched **sequentially per browser target** because archives share one deliberately
serialized storage worker on the ESP32. The device's three-record FIFO absorbs brief cross-browser
bursts; command, Stop, live, asset, and OTA lanes remain independent. Explicit busy responses are
waited and retried within the bounded browser budget rather than converted into an empty list. A
recording that will not read is named in `missingRecordings` with its reason rather than silently
absent from a file the operator will trust. The timestamp is stored in the `meta` document as
`lastExportedAt`, so every browser gives the same answer to "is there an off-roaster copy".

The container is hand-rolled, STORE method, no compression (`src/data/zipFile.ts`). A backup format is
the wrong place to acquire a dependency, and deflate would buy almost nothing: a `.crk` is already a
delta-varint stream the device compressed about 2.4x, and controller documents are already compressed
`CRKZ1` payloads. Entries carry a fixed 1980-01-01 stamp, so the same library backs up to the same
bytes twice.

### Restore: the roaster becomes what the file says

Restore completely replaces everything on the device; that is its defined behavior. When
`/api/status` reports `log_archive.needs_format=true`, Settings also shows a direct **Format storage**
action with explicit destructive confirmation; it is not shown for healthy storage. The firmware
formats before mounting and checks every write, flush, size, rename, and read-back. Calibration Start
remains blocked unless recording storage is mounted, because a baseline must become durable
roaster-held evidence.

One **Restore** file picker, a validated summary, and a final confirmation. The sequence:

1. **Read the whole file first.** Unzip, verify every entry's CRC, read the manifest, parse every
   document. Backup schema v4 carries the source device/model identity and applied-calibration
   provenance. A known model mismatch is refused before erasure; a same-model replacement unit gets an
   explicit calibration warning. A file that will not read has then cost nothing; the same discovery
   one step later would have cost the volume.
2. **Require idle.** The button states its reason and is unavailable while a roast is running or a
   recording is still finalizing; the firmware refuses the erase too.
3. **Open or resume restore maintenance** with `POST /api/restore/begin`; every mutation carries the
   returned opaque token.
4. **`POST /api/logs/format`** - one call, both trees.
5. **Collections at `base=0`**, which after a format is the only base that can be right.
6. **Recordings, one at a time**, as a raw `application/octet-stream` body with `id=auto`, with a
   progress line naming each. The destination allocates a local storage address while the v4 producer
   origin remains immutable. The storage worker streams request chunks to a temporary file and
   validates through a 256-byte file window before atomic rename.
7. **Run documents**, after their recordings, so a roast record never points at a recording that is
   not there yet.
8. **The applied calibration**, through `/api/calibration/apply`, or a clear when the backup records
   that the roaster had none.
9. **Commit restore maintenance** with `POST /api/restore/commit`; a restore with a failed document
   write does not commit.

Then the app reloads its world from the roaster through the ordinary boot path.

**Only the format is fatal.** If the volume was not erased, everything after it would be writing at
`base=0` against documents that still exist, so that step throws and nothing else is attempted. Every
other failure is counted, named, and continued past. A refused recording is not blindly retried
inside the same restore; its failure is reported at the end, and the restore can be retried after the
reported condition is corrected. Abort is valid only while the lease is clean. The first destructive
or successful restore mutation sets and persists `dirty`; a dirty abort returns `409` and leaves
incomplete maintenance in place. Resume and commit are then the only way to clear it, so a partially
restored library cannot masquerade as the pre-format state. A failure at item N leaves the items that
succeeded exactly as they landed.

The NVS thermocouple correction is not restored; verify and reapply it in Settings afterward. Each
recording keeps the correction applied at capture.

`log_archive.restore_max_bytes` (121,244) is the feature detection for both endpoints. `log_archive`
itself predates them, so unlike `data_store` the presence of the block proves nothing.

### Per-type export and import, and the one question

Profiles, Bean lots, Roast history, and Saved calibrations each export as a single-type zip - the same
format with a subset of the same entries - so Import reads either kind of file and touches only the
kinds its manifest names. This lets an operator preserve chosen data, restore a backup, and then
import it back. Roast history brings its recordings, because a roast without its curve is not the
roast.

Import compares **by entity id** and has exactly three outcomes:

- absent on the roaster - **added**;
- present and identical - **skipped, silently** (re-importing a just-exported file must not produce a
  question per unchanged record);
- present and different - a **conflict**.

Conflicts get one question for the whole file, asked only when there is something to ask about,
phrased as its two answers (keep the roaster's copies, or keep the file's) rather than as "replace?".
Everything is then applied through the ordinary acknowledged write path; an import remains
uncommitted while the roaster is stale, offline, actuating, or recording and must be retried when it
is current and idle.

Two details that are easy to get wrong:

- **A roast is compared as the document it is stored as.** A controller-recorded roast carries no
  sample series in its document - the curve is in `/logs/<id>.crk` - while the browser's copy has been
  hydrated from that recording. Comparing the hydrated record against the stored document would call
  every device-recorded roast a conflict.
- **Revision rows are history and never conflict.** Two rows with the same id are the same edit, so a
  revision is added when absent and left alone when present.

A recording the file carries and the roaster lacks is restored whichever way the question was
answered: a recording is either on the volume or it is not.

An import never changes the calibration **settings**: they are one object with no id to reconcile by,
and replacing the roaster's tuning as a side effect of importing saved calibrations is the surprise
the one question exists to prevent. Replacing them is a restore, which says so.

---

## Importing what the controller ran

When a roast ends there is a recording on the controller that a given browser may never have seen.
Reconciliation is a reconstruction from evidence, implemented as pure functions in
`src/domain/deviceRoastImport.ts`. It runs on load, on every screen change, and when a roast stops
executing; never while one executes, because its log is still being written and its header is not
final.

**The record already exists, staged on the roaster at Start.** `src/domain/deviceRoastStart.ts`
writes the complete run record - starting volume, ambient, bean lot id and snapshot, mass, name,
profile snapshot, outcome `running` - to the document store *before* the Start command, in the same
pre-actuation idle window the firmware uses for its own provisional occurrence. The write is a
fail-closed precondition: a refusal, including a busy refusal, means no Start, with the reason shown;
the storage-priority retry covers reads, never this mutation. If Start is refused after the write,
the staged record is removed; failing that it is marked aborted; failing even that, the same record id
is reused on retry so duplicates cannot accumulate. A Start whose outcome is unknown keeps its staged
record. A staged record from an earlier boot that no recording can complete is settled as aborted
once the archive is fully listed.

Reconciliation therefore *completes the staged record in place* (`reconcileProfiledArchiveRun`,
`reconcileManualArchiveRun`): recording linkage, outcome, and thermal series, with header-carried
facts such as batch mass winning. The profile is the plan the roaster executed (mid-roast edits included)
under the identity of the saved profile the staged record names, because a recording carries no
profile name of its own. A recording is joined to a staged record by, in order:

1. the exact recording identity the starting browser observed;
2. sanitized name within 10 s of the roaster's start time (closest start wins);
3. the Start boot plus name within 5 minutes, when exactly one staged record matches.

Before writing a standalone reconstruction, reconciliation re-reads the roaster's library. Records
that end up sharing one recording are folded into the staged record, keeping operator values from
either copy, with the keeper saved before the others are deleted. A roast with no staged record
(started outside this app) is synthesized from the header as described below.

**Idempotency has two layers, because they fail differently.**

1. **The run id is derived from the immutable recording origin**: producer device id plus producer log
   id, encoded into a deterministic token. Local log ids are only storage addresses and may change
   during restore. A second import of the same origin writes the same record rather than a duplicate,
   even after address remapping or if the ledger is lost.
2. **Imported recording-origin keys are recorded in the `meta` document, on the controller.** That
   stops the app re-fetching every CSV on every visit and, more importantly, makes a deliberate
   deletion stick. Identity alone would resurrect a deleted roast on the next load. A per-browser
   ledger would let one browser re-import a recording another browser deliberately deleted and push it
   back onto the controller; delete-stickiness is a property of the library, so the ledger is library
   state.

What is reconstructed, and what is declined:

- **Instructions and accepted edits** come from the v4 codec-2 provenance: the immutable initial
  timed, journey, or manual plan plus each accepted journey edit and manual Fan/Heat instruction at its
  device-accepted elapsed time and revision. Zone attainments are controller evidence, but they are
  not used to invent a profile or instructions the archive did not carry. Unprovenanced v1-v3 archives
  fail closed rather than being attributed to the wrong roaster.
- **Samples** are the CSV rows carrying a thermocouple reading. A faulted row is **dropped**, never
  carried as a zero or a NaN: `TelemetrySample.beanTempC` cannot say "missing", and every consumer
  would read a substitute as a measurement.
- **Requested levels are set equal to effective levels**, because the log records effective levels
  only. Inventing a "requested" number would manufacture the exact distinction the archive exists to
  preserve.
- **Zone attainments become annotations**, from the v4 header. They are the one thing a reviewer
  cannot recover from the temperature series: attainment moved the plan's time axis, and where a
  boundary fell is a decision the controller made rather than a feature of the curve.
- **The outcome is derived, never invented.** A journey with an unattained zone did not finish, and
  the header says so.
- **`start_epoch` of 0 means the clock never synced**, which is "date unknown" and not 1970; a 1970
  timestamp would sort every unsynced roast before every real one. The import moment is used instead
  (a true upper bound), the run is labelled with its boot number, and its notes say so.
- **The profile is linked by exact, unique sanitized-name match, or not at all.** The controller knows
  only the 32-byte name it was handed. A fuzzy match would attach a roast to the wrong recipe, which is
  worse than none, and two profiles that sanitize to the same name are ambiguous by construction. An
  unmatched import gets an inert placeholder profile and one control in its History row to link it.

---

## Security posture

**The HTTP API is unauthenticated by design.** The controller trusts the home LAN it is attached to:
any host that can reach `crackle.local` can read status and request actuation, including starting and
stopping a roast. Do not expose this device to the public internet or an untrusted network segment.

Actuation is protected by layered always-on interlocks rather than authentication, and a caller that
reaches the API still cannot bypass them: every actuating endpoint requires an explicit confirm token;
Heat runs only under a bounded renewable lease enforced in the zero-cross ISR; thermocouple readings
gate continuously, with a reading at or above the overheat limit (260 C by default, reported as
`actuator.overtemp_limit_c`) for 1 second latching overtemperature and starting a Fan 10 cooldown
(`actuator.overtemp_cooldown_remaining_ms`);
every Heat-off-to-positive transition requires a fresh 500 ms Fan qualification; positive Heat
requires Fan `1.0` at the command layer and Fan `0.1` in the actuator core; and a manual-control
conflict latches ESP actuation off until power cycle. Heat-off creates no cooldown debt or forced
airflow.

**Handing the device a whole roast does not widen that surface; it removes part of it.** A
browser-driven runner would have needed a live command channel held open for twenty minutes, and there
is none. Start and Stop are two ordinary confirm-token requests, and everything between them happens on
the device under the same interlocks as a calibration pass.

The recovery access point uses a fixed password and is brought up only when the station link is down,
so it is not a continuously available second entry point.

Authenticated single-account access is deferred. The web app already treats HTTP `401` as a sign-in
requirement - on the status read, every command, the roast endpoints, and the log downloads - so adding
authentication is a firmware change plus a sign-in screen, not a client rewrite.

---

## Hardware invariants beneath the protocol

These actuator properties are load-bearing for everything above. They are specified in
[`firmware/safety-policy.md`](../../firmware/safety-policy.md) and
[`firmware/actuator-core.md`](../../firmware/actuator-core.md).

1. **The hardware-timed actuator boundary is authoritative.** Every Heat-off-to-positive transition
   starts a fresh 500 ms Fan qualification even if Fan was already running, and an abort-class
   zero-cross outage restarts it. The actuator core requires at least the captured factory Fan-1
   endpoint (public Fan `0.1`) for every positive Heat request; the command layer above it lifts any
   heat-carrying pair to Fan `1.0` before the core sees it. Renewable Heat leases are enforced in the
   zero-cross ISR. When Heat turns off, Fan immediately follows the requested value, including Fan 0;
   no actuator cooling debt, timer, forced airflow, or action blocker is created. Only explicitly
   authored profile/calibration Fan-only steps, direct operator commands, or the executor's ten-second
   post-Stop cooling tail keep Fan running. Automatic endings (completion, faults, envelope breaches)
   synthesize no airflow. The independent 180-second fan-off recording tail owns no output. Sensor
   faults are qualified over consecutive samples, while stale telemetry fails safe independently.
2. **The MCPWM scheduler**: a single 1 MHz timer with a 12000 µs period,
   `MCPWM_TIMER_START_STOP_FULL` hardware fail-low, and shadow compare values committed at the next
   zero-cross sync. The period must exceed every valid 6-11 ms half-cycle; an 8333 µs period would stop
   the timer at full on every long half-cycle (real intervals alternate about 8760/7910 µs) and put ISR
   restart latency into pulse phase.
3. **Zero-cross qualification and the bounded coast policy**: intervals are classified by
   hardware timestamp plus PCNT edge counts, and edge polarity is never a validity signal, because
   comparator chatter makes callback polarity unreliable. This is what lets an unattended roast survive
   a transient observation gap instead of ending mid-batch.
4. **Effective levels are the contract, not commanded ones.** The floors are mirrored in
   `src/domain/actuatorFloors.ts` for the Controls preview and the log matcher alike; any change to the
   floor constants must be paired with a client update.
5. **Status field renames are a silent-failure class the client cannot detect.** Any rename is a
   contract change and must be paired with a client update.

## Deliberately absent

- A busy-waiting gptimer pulse scheduler inside an ISR critical section.
- A browser-resident roast runner with acknowledged per-tick commands and idempotency keys. The plan
  goes to the device once.
- Browser capability claims for roast execution. `autonomousTimedPrograms` and `thermalExecution`
  remain hardcoded `false` in `client.ts`, asserted by the allow-list test; the device executor is
  detected by the presence of `status.roast`, a fact the firmware reports.

## Known limits

1. **Final archive replacement waits for idle.** Before actuation, the roaster atomically writes a
   provisional occurrence containing the stable log identity and immutable starting plan. During the
   episode, the RAM `/thermal.csv` serves the append-only prefix recorded so far. Once recording stops,
   that RAM snapshot remains readable while the finalized compact or detailed archive atomically
   replaces the provisional file; the same `log_id` then resolves through `/logs/<id>.csv`. This
   protects occurrence identity and starting instructions across sudden power loss without adding
   flash writes to the active control loop. When space is tight, retention plans the minimum
   oldest-first deletion set first and deletes nothing if the new file cannot fit or would require
   more than 64 removals.
2. **Batch context exists only for roasts.** `POST /api/roast/start` takes `mass`, the v4 archive
   header carries `batch_mass_g` with the roast name and per-zone attainments, and the bean lot lives
   in the `runs/<id>` document. A calibration recording has no batch context because there was none.
3. **Unattended manual heat is bounded, not prevented.** A manual session left alone keeps heating at
   its commanded levels for the full 30 minutes of its instruction before the lease expires and both
   outputs stop. That is the deliberate trade: the bound is the age of the last instruction rather than
   the liveness of a web page.
