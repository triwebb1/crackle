# Crackle firmware

Crackle is the controller firmware for a Fresh Roast SR800 roaster, running on a Waveshare
ESP32-S3-Zero. It drives the fan and heater through the factory power stage, reads a MAX31856
thermocouple, executes roasts and calibration programs on the device, keeps a compressed archive of
thermal recordings, stores the browser app's library, and serves that app same-origin from flash.

This is the firmware, API, and storage reference. Current versions: firmware `2026-07-26.129`
(`kFirmwareVersion`), embedded web app `0.10.71`.

| Topic | Document |
| --- | --- |
| Non-configurable safety rules | [`../safety-policy.md`](../safety-policy.md) |
| Hardware-timed actuator boundary | [`../actuator-core.md`](../actuator-core.md) |
| Network lanes, sockets, and OTA ownership | [`../../docs/network-architecture.md`](../../docs/network-architecture.md) |
| Journey control law and calibration model | [`../../docs/control-and-calibration.md`](../../docs/control-and-calibration.md) |
| Browser side of this API | [`../../web/docs/controller-integration.md`](../../web/docs/controller-integration.md) |
| Wiring and first power-up | [`../../hardware/installation.md`](../../hardware/installation.md) |

> **Electrical isolation.** The ESP32 shares the roaster's factory logic ground, which is
> potentially mains-referenced. Never attach computer USB, a serial adapter, or a grounded
> instrument to the controller while roaster mains is present. Normal updates use OTA over Wi-Fi.

## Overview

- **The roaster runs the roast.** `POST /api/roast/start` hands over the whole plan; the browser
  may then go away. Modes: TIMED steps, temperature-gated JOURNEY zones driven by a
  vector-verified C++ control law, and operator-directed MANUAL instructions.
- **The roaster holds the library.** An opaque-bytes document store under `/data` holds profiles,
  bean lots, calibrations, and roast records, so every browser sees the same data.
- **The roaster keeps the recordings.** A delta-varint archive under `/logs` costs about 5 bytes
  per sample. Calibration and automatic roasts keep a 3-minute passive-decay tail; a Manual Roast
  closes at the operator's Stop.
- **Recordings leave and come back byte-exact** through `GET /logs/<id>.crk` and
  `POST /api/logs/restore`.
- **One safety envelope covers every command path**: a fresh 500 ms Fan qualification on every
  Heat-off-to-positive transition, Fan 1.0 whenever Heat is on, immediate Heat-off with no hidden
  Fan hold, qualified sensor faults, a 30-second ISR Heat lease, a 30-minute instruction lease, and
  a runtime envelope for automated programs.

Core 1 runs `loop()`: the actuator, programs, sensor decisions, and all mutable controller state.
Core 0 runs one native ESP-IDF HTTP server on port 80 with bounded workers for commands, Stop,
assets, storage, and live publication. No browser socket is read or written from `loop()`; requests
reach the control loop only through a bounded command mailbox. See
[`docs/network-architecture.md`](../../docs/network-architecture.md).

## Source layout

All firmware source is in `firmware/crackle/crackle/`. The `sr800_*` modules keep hardware and
filesystem access out of their logic, so the host tests compile them unchanged on a desktop compiler
against minimal fakes of `Arduino.h` and the ESP-IDF headers they include.

| File | Purpose |
| --- | --- |
| `crackle.ino` | Sketch: setup, `loop()`, programs, storage glue, request handlers, status builders. |
| `crackle_bundle.h` | Generated gzip web bundle (`kCrackleBundleVersion`). Never edit by hand. |
| `partitions.csv` | Flash layout: two 1.5 MiB OTA slots, 896 KiB LittleFS, core-dump region. |
| `sr800_actuator.h`, `.cpp` | Actuator core: Fan/Heat requests, qualification, faults, phase mapping. |
| `sr800_mcpwm_phase_scheduler.h`, `.cpp` | MCPWM zero-cross capture and hardware-timed fail-low output pulses. |
| `sr800_phase_scheduler.h` | Pulse-plan and phase-timing record types. |
| `sr800_zero_cross_qualifier.h` | Interval-only zero-cross classification: qualify, ignore glitches, coast, reject. |
| `sr800_capture_time.h` | Wrap-safe conversion of capture-timer ticks to microseconds. |
| `sr800_sensor_fault_qualifier.h` | Three consecutive 250 ms thermocouple failures before a fault latches. |
| `sr800_calibration_readiness.h` | Calibration start gate: one fresh, valid thermocouple reading. |
| `sr800_calibration_settle.h` | Step settle detection that first requires the command to move temperature. |
| `sr800_journey_control.h`, `.cpp` | C++ port of the browser's Journey control law. |
| `sr800_runtime_contract.h` | Revision sequences, wrap-safe lease ages, restore lease. |
| `sr800_recording_handoff.h` | Cross-core rules for claiming and persisting a frozen recording. |
| `sr800_log_codec.h`, `.cpp` | Recording codec, plan-provenance envelope, archive validator. |
| `sr800_log_retention.h` | Oldest-first retention planner with preflight and a 64-deletion bound. |
| `sr800_volume_budget.h` | The single shared budget for archive reserve and document write floor. |
| `sr800_storage_health.h` | Filesystem geometry marker and mount/probe health decisions. |
| `sr800_doc_store.h`, `.cpp` | Document envelope, identifier rules, version check, atomic replace. |
| `sr800_live_delta.h`, `.cpp` | Top-level JSON merge deltas for the live WebSocket stream. |
| `sr800_network_server.h`, `.cpp` | Native HTTP server, workers, WebSocket subscribers, raw OTA route. |
| `sr800_network_mailbox.h`, `.cpp` | Two normal command slots plus a reserved Stop slot into `loop()`. |
| `sr800_network_policy.h` | Subscriber eviction and OTA-validation fallback policy. |
| `sr800_query_args.h`, `.cpp` | Bounded form/query argument parser (body first, URL as fallback). |
| `sr800_web_pages.h` | Static `/probe` and `/update` pages, kept out of the `.ino` (see [Rules for maintainers](#rules-for-maintainers)). |

`firmware/crackle/tests/` holds the native C++ suites, host `fakes/`, Python source contracts, and
`vectors/journey_control_vectors.json`. `firmware/crackle/tools/` holds `embed-crackle.mjs` and
MCPWM/edge timing analysis scripts.

## Build and verify

Toolchain: `arduino-cli` with the Espressif ESP32 Arduino core **3.3.10**, Node.js 22 (`.nvmrc`; 20 or later works) for the web
build and embedding (see [`../../web/README.md`](../../web/README.md)), any C++17 compiler for
host tests, and Python 3.

### Embed the web app

Every web change is rebuilt and embedded before the firmware is compiled. From the repository root:

```bash
npm --prefix web ci
npm --prefix web run embed     # production build, then tools/embed-crackle.mjs
```

The script reads `web/dist` and `web/package.json`, refuses any output other than exactly three
files (`index.html`, one JS asset, one CSS asset), and writes `crackle/crackle_bundle.h` with the
web version. Output is deterministic. Commit the regenerated header with the web change, and never
embed the development mock seed.

### Compile

```powershell
arduino-cli compile `
  --fqbn 'esp32:esp32:waveshare_esp32_s3_zero:PartitionScheme=custom,PSRAM=enabled,EraseFlash=none' `
  --build-property 'compiler.optimization_flags=-Os' `
  --build-path build/crackle `
  firmware/crackle/crackle
```

All three menu options are mandatory:

| Option | Why |
| --- | --- |
| `PartitionScheme=custom` | Uses the sketch's `partitions.csv` and its 1,572,864-byte app slots. A stock scheme moves the LittleFS partition, so the storage geometry marker no longer matches and storage parks in `needs_format`. |
| `PSRAM=enabled` | Initializes the board's 2 MB PSRAM, which holds recording and payload buffers and the command, Stop, asset, and live-publisher stacks. Without it the actuator loop stays safe and network startup retries every 30 seconds, but the web UI and network Stop are unavailable. |
| `EraseFlash=none` | Prevents an upload from erasing NVS and LittleFS (Wi-Fi credentials, calibration, library, recordings). |

`-Os` keeps the image inside the slot. The application must stay below the `0x180000`
(1,572,864-byte) app slot; check the compile output, and `app_free_bytes` on a running device.

### Host tests

Native suites need no roaster. From `firmware/crackle/tests`, `bash run-native-tests.sh` builds and
runs all fourteen with g++. Any C++17 compiler works for a single suite; each needs `fakes/` and the
sketch folder on the include path, plus the source file listed below:

```bash
out=$(mktemp -d)   # keep binaries out of the repository
g++ -std=c++17 -I fakes -I ../crackle <test>.cpp [../crackle/<dependency>.cpp] -o "$out/test" && "$out/test"
# MSVC: cl /std:c++17 /EHsc /I fakes /I ..\crackle <test>.cpp [..\crackle\<dependency>.cpp]
```

| Suite | Extra source |
| --- | --- |
| `actuator_safety_test.cpp` | `..\crackle\sr800_actuator.cpp` |
| `doc_store_test.cpp` | `..\crackle\sr800_doc_store.cpp` |
| `log_codec_test.cpp` | `..\crackle\sr800_log_codec.cpp` |
| `journey_control_vector_test.cpp` | `..\crackle\sr800_journey_control.cpp` |
| `live_delta_test.cpp` | `..\crackle\sr800_live_delta.cpp` |
| `query_args_test.cpp` | `..\crackle\sr800_query_args.cpp` |
| `calibration_readiness_test.cpp`, `calibration_settle_test.cpp`, `capture_time_test.cpp`, `log_retention_test.cpp`, `runtime_contract_test.cpp`, `sensor_fault_qualifier_test.cpp`, `storage_health_test.cpp`, `zero_cross_qualifier_test.cpp` | none |

The Python files in `tests/` are architecture checks (source contracts): cheap pins that assert a
pattern is present or absent in the source (every Stop route uses the Stop lane; `delay(0);` never
appears). They are not behavioral proof. Each prints `PASS` or raises; run them all from
`firmware/crackle/tests`:

```bash
for t in *_contract_test.py; do python "$t" || exit 1; done
```

Repository-wide test selection is described in [`../../docs/testing.md`](../../docs/testing.md).

## Partition table

| Name | Type | Offset | Size | Holds |
| --- | --- | --- | --- | --- |
| `nvs` | data/nvs | `0x9000` | `0x5000` | Wi-Fi credentials, applied calibration, `logseq`, thermocouple offset, storage marker, boot history. |
| `otadata` | data/ota | `0xE000` | `0x2000` | OTA slot selection. |
| `app0` | app/ota_0 | `0x10000` | `0x180000` | Application slot A (1,572,864 bytes). |
| `app1` | app/ota_1 | `0x190000` | `0x180000` | Application slot B. |
| `spiffs` | data/spiffs | `0x310000` | `0xE0000` | One 896 KiB LittleFS volume: `/logs` and `/data`. |
| `coredump` | data/coredump | `0x3F0000` | `0x10000` | Last crash, summarized in `system.stored_crash`. |

## HTTP API

Unauthenticated, LAN trust (see [Security model](#security-model)). One `esp_http_server` on port 80,
pinned to core 0, allows eight open sockets with keep-alive and LRU purge. Responses are JSON
(`{"ok":…}`) unless noted. A full bounded queue answers `503` with `Retry-After: 1`.

### App and update

| Route | Method | Notes |
| --- | --- | --- |
| `/` | GET | Embedded Crackle app (gzip). |
| `/assets/<hashed>.js`, `/assets/<hashed>.css` | GET | Immutable gzip assets. |
| `/probe` | GET | Standalone diagnostic page. |
| `/update` | GET, POST | Update page; POST takes a raw `application/octet-stream` application image. See [Updating firmware](#updating-firmware). |
| `/api/update/version` | GET | Installed version for the update page. |
| `/api/wifi` | POST | Stores station credentials in NVS. |

### Observation

| Route | Method | Notes |
| --- | --- | --- |
| `/api/status` | GET | Full contract document from an immutable snapshot. Always available. |
| `/api/live` | GET | Compact coherent snapshot; initialization and reconnect fallback. |
| `/ws/live` | WebSocket | One complete snapshot, then sequence-fenced top-level deltas at most once per second. |
| `/api/events` | GET | Edge-capture events. |
| `/capture.csv`, `/timing.csv` | GET | Edge-capture log and MCPWM phase-timing log (4,000 records). |
| `/thermal.csv` | GET | Current RAM recording. During capture it serves the consistent recorded prefix, so a browser joining mid-roast can backfill. |

### Actuation

Every start, set, or configuration mutation carries a confirm token and is refused with `423` while
the manual-control conflict latch is set. Stop routes need no token: Stop must be reachable from any
browser that can reach the controller, and every Stop route uses the reserved Stop lane.

| Route | Method | Confirm token | Notes |
| --- | --- | --- | --- |
| `/api/stop` | POST | none | Workflow-agnostic Stop; Heat off immediately. Interrupting an active roast starts the [post-stop tail](#stop-and-the-post-stop-tail). Reports `recording_saved` / `recording_pending`. |
| `/api/fan-test/start` | POST | `FOUR_DASHES` | `duration_ms` 250–3000 (default 3000), `level`. |
| `/api/fan-test/stop` | POST | none | |
| `/api/heater-proof/start` | POST | `FOUR_DASHES_HEAT_TEST` | `duration_ms` 1000–15000 (default 10000; bounded by the phase-timing log), `fan_level`, `heat_level`. |
| `/api/heater-proof/stop` | POST | none | |
| `/api/calibration/start` | POST | `FOUR_DASHES_CALIBRATION` | `fans=` + `heats=` grid or `steps=fan:heat,…`; `step_seconds` 15–300 (default 300), `min_step_seconds` 5–120 (default 20), `settle_seconds` 2–30 (default 20), `settle_band_tenths_c` 2–100 (default 2). Needs one fresh, valid, fault-free reading; no temperature or stability wait. |
| `/api/calibration/stop` | POST | none | |
| `/api/manual/set` | POST | `MANUAL_CONTROL` | `fan=`, `heat=`. Resets the instruction lease. |
| `/api/manual/stop` | POST | none | Stops diagnostic Manual output. |
| `/api/roast/start` | POST | `START_ROAST` | See [The roast executor](#the-roast-executor). |
| `/api/roast/active-plan` | GET, POST | POST: `PATCH_ROAST_PLAN` | Device-owned plan; POST edits an active timed or journey roast. |
| `/api/roast/set` | POST | `CONTROL_ROAST` | Fan/Heat for the active manual roast; resets its instruction lease. |
| `/api/roast/stop` | POST | none | Never refuses to stop. |
| `/api/clear`, `/api/freeze` | POST | none | Edge-capture arming. |

### Recordings archive

| Route | Method | Notes |
| --- | --- | --- |
| `/api/logs` | GET | Newest-first index plus filesystem stats, at most 160 entries. Cached between mutations. |
| `/logs/<id>.csv` | GET | One recording, decoded. CRC-verified before the first row; a damaged file answers `500`. |
| `/logs/<id>.crk` | GET | The file on the volume, verbatim. |
| `/api/logs/delete` | POST | `id=`, `confirm=DELETE_LOG`. Idle-gated. |
| `/api/logs/restore` | POST | `id=auto` or a positive id, `confirm=RESTORE_LOG`, raw body. Idle-gated. |
| `/api/logs/format` | POST | `confirm=FORMAT_LOGS`. Erases the whole volume, recordings and `/data`. Idle-gated. |

`/logs/<id>.csv` and `/logs/<id>.crk` share one wildcard route; the suffix selects the
representation.

### Documents and restore maintenance

The document routes (`/api/data/manifest`, `/api/data/<collection>`, `/api/data/runs`,
`/api/data/runs/<id>`, `/api/data/delete`) are specified under
[The document store](#endpoints); the restore maintenance routes (`/api/restore/begin`, `commit`,
`abort`) under [Backup and restore](#backup-and-restore).

### Calibration and sensor settings

| Route | Method | Notes |
| --- | --- | --- |
| `/api/calibration/apply` | POST | `confirm=APPLY_CALIBRATION`; `heater_gain`, `fan_cooling`, `cooling_fan`, `loss_per_min`, `fit_id`; `clear=true` erases. Idle- and plausibility-gated. |
| `/api/settings/thermocouple-offset` | POST | `confirm=SET_THERMOCOUPLE_OFFSET`; `offset_c` −25.0 to 25.0 °C. Idle- and restore-gated, stored in NVS, advances `state_rev`. |

The browser's allow-list of this surface is in
[`web/docs/controller-integration.md`](../../web/docs/controller-integration.md), which owns the
client contract; this document owns the device contract.

## `/api/status`

Status is read at initialization and at explicit reconciliation points, not polled continuously.
`buildControllerStatusJson()` formats it from an immutable controller snapshot into a preallocated
12 KiB buffer, so it is available during actuation and recording and never touches LittleFS or
mutable actuator state from the network task. A browser reconciles a response that disappeared after
commit with `last_request_id`, `last_request_status`, and the authoritative revisions. Clients key on
block presence and fields, never on a version string. `state_rev` and `boot_id` are decimal strings
so the 64-bit range is never rounded by JavaScript.

| Area | Fields |
| --- | --- |
| Identity | `firmware_version`, `web_bundle_version`, `roaster` (`device_id`, `model_id`, `display_name`), `capabilities`, `boot_id`, `state_rev`, `last_request_id`, `last_request_status`, `lifecycle`. |
| Safety | `manual_conflict_latched`, `actuator` (mode, fault, requested and effective Fan/Heat, `overtemp_limit_c`, `overtemp_cooldown_remaining_ms`), `max31856` (readings, raw `fault_status`, named `fault_reasons`, sample age), `thermocouple_offset_c`. |
| Programs | `calibration`, `calibration_ready`, `calibration_readiness`, `manual`, `roast`. |
| Recording and storage | `thermal_log`, `log_archive`, `data_store`, `applied_calibration`, `restore_maintenance`. |
| Firmware image | `ota_slot_bytes`, `app_used_bytes`, `app_free_bytes`, `ota_last_attempt` (declared and received bytes, received and flash-readback SHA-256), `ota_handler_stack_low_water_bytes`. |
| Network | `station_connected`, `station_rssi_dbm`, `wifi_disconnect_count` and reconnect counters, `wifi_sleep_enabled`, `actuation_wifi_awake`, `hostname`, `live_websocket_*` counts and capacity. |
| Diagnostics | `http_rejected_request_count`, `http_worker_failure_count`, per-worker stack low-water values, `storage_worker_stack_low_water_route`, `storage_request_slowest_ms` / `_route`, `storage_requests_over_1s`. |
| `system` | Reset reason, uptime, heap and PSRAM current/minimum/largest block, PSRAM low-water and its time, failed allocations, loop gap, archive-persist timing, an eight-entry `boot_history`, and `stored_crash`. |

- **`thermal_log.available`** is false only when recording memory could not be allocated; recording
  workflows then refuse to start while diagnostics and Stop stay usable. **`thermal_log.log_id`** is
  a local storage address, not a global identity (that is producer device id plus origin log id).
- **`manual`** reports `instruction_age_ms` and `instruction_limit_ms` (`1800000`); there is no
  client keepalive field.
- **`log_archive`**: `mounted`, `count`, `total_bytes`, `clock_synced`, `lost_logs`, `needs_format`,
  `health`.
- **`data_store`** is present even when unmounted (`"mounted": false`, zeros): `used_bytes`
  (on-disk, payloads plus 16-byte envelopes), `total_bytes`, `free_bytes`, `write_floor_bytes`
  (derived; never hardcode it), `collections` (`{bytes, version}` per written collection; payload
  bytes), and `runs` (`count`, `bytes`). Totals are computed at mount and then moved by one
  document's delta per write or delete.
- **`applied_calibration.present`** is false unless a plausible coefficient set is stored.
- **`stored_crash`** is `null` or the core-dump summary (task, PC, backtrace, `elf_sha256`) with
  `current_build` saying whether it belongs to the running image; decode the PCs with the ELF of the
  build named by `elf_sha256`.
- **`roast`** is described under [`status.roast`](#statusroast).

## Storage

The recordings archive and the document store share one 896 KiB LittleFS volume (`spiffs`,
`0xE0000` = 917,504 bytes). Their limits come from one set of constants in `sr800_volume_budget.h`;
when the archive reserve and the document floor were chosen independently they drifted apart, and a
metadata write could land inside the archive's reserve and force a retention sweep.

### Volume budget

| Constant | Value | Meaning |
| --- | --- | --- |
| `kLogArchiveReserveBytes` | 98,304 (96 KiB) | Retention sweeps until this much remains free after the incoming recording lands. |
| `kMaxRecordingSamples` | 4,800 | RAM thermal log capacity; the buffer stops accepting at exactly this count. |
| `kLogArchiveHeaderBytes` | 220 | v4 archive header; `sizeof(LogArchiveHeader)` is `static_assert`ed against it. |
| `logcodec::kMaxEncodedSampleBytes` | 25 | Five channels at the 5-byte ceiling of an unsigned LEB128 `u32`. |
| `kMaxIncomingLogBytes` | **121,244** | `220 + 1,024 + 4,800 × 25`: the largest file one persist can produce, and the restore cap. |
| `kDocumentWriteFloorBytes` | **219,548** | `reserve + kMaxIncomingLogBytes`. A document write that would leave less free is refused `507`. |

Retention prunes when `used + incoming + reserve > total`. A document write is accepted only when
`total − used ≥ floor`, and `floor = reserve + kMaxIncomingLogBytes`, so the sweep condition is
false immediately after any accepted document write for every recording the format permits. **A
document can never be the reason a stored recording is deleted.** `tests/doc_store_test.cpp` accepts
a write at the exact edge of the floor and then requires a worst-case recording to fit with nothing
to sweep. Retention enumerates only `/logs` and deletes only `/logs/<id>.crk`.

### Recording format

`sr800_log_codec.{h,cpp}` is a pure module. Codec 1 is a concatenation of sample frames; codec 2,
used for roasts and calibrations, prefixes the same stream with a bounded plan envelope. Each frame
is five zigzagged, delta-coded unsigned LEB128 varints:

| # | Channel | Token | Predictor starts at |
| --- | --- | --- | --- |
| 1 | time | `zigzag(dt − prevDt)`, `dt = tMs − prevTMs` | `prevTMs = 0`, `prevDt = 0` |
| 2 | thermocouple | `0` when missing, else `zigzag(deci − prev) + 1` | `0` |
| 3 | cold junction | `0` when missing, else `zigzag(deci − prev) + 1` | `0` |
| 4 | fan | `zigzag(deci − prev)`, deci = milli / 100 | `0` |
| 5 | heat | `zigzag(deci − prev)`, deci = milli / 100 | `0` |

- Predictors start at zero, so the first sample encodes its absolute value. A temperature predictor
  advances only on a real reading, so a dropout costs one byte; token `0` means missing and every
  real delta maps to 1 or above.
- Time is second-order: a first-order `dt` at 1 Hz costs two bytes every sample, while the residual
  against the previous interval is `0` in steady state and ±5 under jitter. Timestamps are exact to
  the millisecond and no rate is stored.
- Temperatures are deci-degrees, rounded half away from zero. Hundredths are noise at thermocouple
  accuracy; whole degrees turn the slow passive decay tail into a staircase of flats that a fit
  reads as signal. Tenths cost a second byte only for moves above 6.3 °C between samples, and
  `testDecayTailResolution` requires a 0.1 °C/s decay to return one distinct point per second.
- Levels are deci-levels, lossless for every 0.1 step. The 12-byte RAM row uses int16 deci-degrees
  (to 399.9 °C, avoiding the 327.68 °C wrap of centi-degrees). Control and live data use floating
  point; fitted coefficients and authored setpoints keep full precision.

**Plan provenance (codec 2).** The envelope is at most 1,024 bytes and carries the accepted initial
plan: timed (up to 24 steps), journey (up to 12 zones), manual (one starting instruction), or
calibration (up to 48 steps plus dwell, settle window, and settle band). Roasts may add up to 32
accepted edits: a replaced or appended timed step, journey field deltas, or requested and effective
manual Fan/Heat. Revisions must rise, elapsed times cannot move backward, and the 24-step cap holds
after edits. The browser reconstructs the exact accepted program from this envelope.

**Compression.** `tests/log_codec_test.cpp` encodes a synthetic 32-minute roast including the
passive tail and enforces ≤ 6.0 and ≤ 5.2 bytes/sample (the second catches a predictor regression):

```text
synthetic roast: 1920 samples (32 min), 9606 sample bytes, 5.003 bytes/sample
sample stream + v4 header: 9826 B vs 23132 B raw (2.35x)
```

### Archive header

Version 4 (220 bytes) is the only accepted version. It carries `encodedBytes`, a CRC32, codec id,
stop time and reason, and immutable producer identity: device ID, model ID, display name, firmware
version, a simulated flag, the producer-local `originLogId`, and the thermocouple correction already
applied to the recorded temperatures. A provenance CRC protects those fields, and the whole-file CRC
covers metadata, provenance, plan envelope, and samples. Older v1–v3 files have no trustworthy
provenance; `GET /api/logs` quarantines them with a reason and restore refuses them.

`GET /api/logs` reports `recorded_on`, the immutable `recording_origin`, and the current
`storage_address`. The origin survives backup and restore; the address can change when a destination
roaster allocates a free local id. Payload size cannot be inferred from the sample count.

### Persistence and the idle-only flash rule

**Every flash write waits for an idle actuator.** A program or erase suspends the instruction cache
and blacks out the MCPWM capture callbacks (about 58 ms observed). Persists therefore run only when
`actuatorFullyIdle()`: immediately before the next actuation episode's request, or from an idle
watcher after `kLogIdleFinalizeMs` = 3 minutes of quiet. Deletes, restores, document writes, format,
and NVS writes refuse while an actuator-owning workflow runs; immutable reads are always allowed.
The order is `finalize → request`, never `request → persist`, because a persist after
`actuator.request()` would stall capture during Fan qualification and fail the episode it made room
for. The full rule is in [`../safety-policy.md`](../safety-policy.md#flash-writes-only-while-the-actuator-is-idle).

The 3-minute idle window is also the passive decay tail. The first ~30 seconds after the fan stops
are heat-soak rebound, not exponential decay; 3 minutes leaves ~150 seconds of clean decay. A
10-minute tail added 21.9% to every recording to describe an asymptote no fit is sensitive to.

- Recordings are written to `/logs/pending.tmp` and renamed into place, so power loss cannot leave a
  truncated file under a real id. A stale temp is discarded at mount; readers reject any file whose
  size disagrees with its header.
- A failed persist keeps the RAM copy and retries every 30 seconds. A new recordable episode is
  refused while meaningful evidence is unsaved; Stop and Heat-off bypass storage entirely.
  `log_archive.lost_logs` counts any violation of that contract.
- Calibration evidence shorter than 30 samples is discarded; a roast may persist from its first
  sample.
- Log ids are monotonic across boots through the NVS `logseq` counter. `start_epoch` comes from SNTP
  and is `0` ("date unknown", never 1970) before the first sync.
- Retention is preflighted: a fixed-capacity planner protects the recording being finalized,
  chooses the minimum oldest-first set, and refuses without deleting when the file still cannot fit
  or more than 64 removals would be needed. A stale `pending.tmp` must be removed and verified
  absent first, so a failing temp path cannot turn a failed write into lost evidence.
- Every durable write flushes before verifying size: ESP32 `File::write()` is stdio-buffered while
  `File::size()` uses `stat()`.

**Formatting needs a geometry marker or an explicit command.** At boot, firmware compares an NVS
marker (partition offset, size, format version) with the running partition table, then runs a
write, rename-over-existing, and read-back probe. A mismatched marker, mount failure, or failed probe
reports `log_archive.needs_format: true` and never auto-formats. Only a missing marker on an entirely
erased partition initializes itself, so an NVS failure cannot make an existing filesystem look
disposable. `POST /api/logs/format?confirm=FORMAT_LOGS` explicitly formats the named partition,
mounts without auto-format, and writes the marker with exact read-back.

### Capacity

| Case | Budget | Per roast | Fits |
| --- | --- | --- | --- |
| Recordings only | 917,504 − 98,304 = 800 KiB | 9,826 B; ≤ 10,850 B with a maximum plan envelope | about 75–83 |
| Detailed 1 s recordings with run records | 917,504 − 219,548 ≈ 682 KiB | ≈ 14.9–15.9 KB | about 43–46 |
| Compact 10 s recordings with run records | as above | ≈ 7–8 KB (estimate) | roughly 85–95 |

The browser stores documents as ASCII `CRKZ1:<base64(zlib(minified JSON))>`, targeting 8 KB per
collection and 6 KB per run against the 12 KB and 8 KB protocol caps. Every roast has a `.crk`
archive (detailed 1 s by default, or compact 10 s), and its run record keeps a bounded fallback curve
that preserves History after retention removes the file.

## The document store

The firmware never parses a stored document. It owns a 16-byte envelope and returns every byte
after it exactly as it arrived, with no schema, validation, or decompression, so the web schema can
change without a firmware release. The controller enforces only identity, concurrency, and capacity.

| Offset | Size | Envelope field |
| --- | --- | --- |
| 0 | 4 | Magic, ASCII `CDOC` |
| 4 | 2 | Prefix version, little-endian, `1` |
| 6 | 2 | Reserved, `0` |
| 8 | 4 | `docVersion`, little-endian |
| 12 | 4 | Payload length, little-endian |
| 16 | n | Payload, verbatim |

The envelope is encoded byte by byte, not copied from a struct, because it is a wire format. Wrong
magic, a prefix version other than `1`, or a size that disagrees with the declared length makes a
file unreadable, never "empty".

Files: `/data/profiles.json`, `/data/beans.json`, `/data/calibrations.json`, `/data/meta.json`, one
`/data/runs/<id>.json` per roast, and a transient `/data/pending.tmp` discarded at mount.
Collections are exactly those four lower-case names. A run `id` is 1–24 characters of
`[A-Za-z0-9._-]`, not only dots; anything else is `400` before any filesystem lookup.

### Endpoints

A successful document `GET` returns the payload itself; everything else is JSON. `base` is a query
argument on writes.

| Endpoint | Args | Success | Failure |
| --- | --- | --- | --- |
| `GET /api/data/manifest` | optional `cursor=m:<offset>` | `200`: `state_rev`, `boot_id`, the four collections as `null` or `{bytes,version}`, `runs`/`logs` (at most 64 rows per page), optional `next_cursor`, `restore_maintenance` | `503` not mounted · `400` bad cursor |
| `GET /api/data/<collection>` | | `200`, body = payload, `X-Doc-Version: <n>`, `Cache-Control: no-store` | `503` · `400` unknown · `404` never written · `500` unreadable |
| `POST /api/data/<collection>` | `base=`; body | `200 {"ok":true,"version":<new>}` | `503` · `400` unknown or bad `base` · `413` over 12 KB · `409` busy · `409` conflict · `507` floor · `500` write failed |
| `GET /api/data/runs` | | `200 {"ok":true,"runs":[{"id","bytes","version"},…]}`, at most 400 | `503` |
| `GET /api/data/runs/<id>` | | As collection `GET` | `503` · `400` · `404` · `500` |
| `POST /api/data/runs/<id>` | `base=`; body | `200 {"ok":true,"version":<new>}` | As above, cap 8 KB |
| `POST /api/data/delete` | `target=runs/<id>` or `<collection>`, `confirm=DELETE_DATA` | `200 {"ok":true,"deleted":"<target>"}` | `409` confirm · `503` · `400` · `409` busy · `404` |

The manifest is the browser's authoritative reconciliation surface: it repeats the collection slots
on every page and shares a stable `state_rev` across pages until a device mutation advances it. Its
listing, and `/api/logs`, are cached against `manifestMutationCount`, so repeated reads cost no
flash walk. Document bodies have a 15-second whole-transfer deadline (`kDocumentBodyDeadlineMs`) and
recording uploads 120 seconds (`kRecordingUploadDeadlineMs`), so a slow trickle cannot hold the
storage lane.

### Optimistic concurrency

`base` is mandatory and is a strict unsigned decimal (no sign, whitespace, `0x`, or value above
`4294967295`); a malformed `base` is `400`, never silently `0`. `base=0` means "create; must not
exist"; any other `base` must equal the stored `docVersion`. A match stores the document and
advances its version by one (new documents start at `1`). A mismatch touches nothing and returns
`409 {"ok":false,"conflict":true,"version":<current>}`; a `409` without `conflict` is the idle gate or
a missing confirm. Deleting a document resets its version history. An undecodable envelope reads as
version `0`, so `base=0` overwrites it and corruption never requires a format.

Write order: mounted → identity → `base` → size cap → idle gate → version match → volume floor →
write. Malformed requests get `400`/`413` immediately rather than a misleading "busy".

### Atomic replace

A commit writes a temp file and renames it over the real name. **The stored document is never
removed or made unreadable on any path.** A short write removes the partial temp and never attempts
the rename; a refused rename removes the completed temp and leaves the original untouched. Both
answer `500`, "The previously stored version is unchanged." LittleFS `rename` replaces the
destination atomically, so no backup-name sequence is needed, and there is deliberately no
delete-then-retry, which would begin by destroying the good copy. `replaceDocument` takes the
filesystem as callbacks, and `tests/doc_store_test.cpp` drives both failure paths by fault injection.

When the volume is in `needs_format`, every data endpoint answers `503`, reads included. Formatting
destroys the document store too and says so: `{"ok":true,"mounted":true,"data_store_erased":true}`.

## The instruction lease

**An instruction is good for at most 30 minutes; a new instruction, the same levels repeated or
different ones, resets the clock** (`kManualInstructionLeaseMs = 1800000`). Nothing else resets it;
an open browser does not.

- Manual control and manual roasts use an explicit timer reset by each accepted
  `POST /api/manual/set` or `POST /api/roast/set`. Expiry is the same immediate Stop as an operator
  Stop: both outputs off, `end_reason` `instruction_expired`. Fan-only instructions expire too.
- Device-run programs satisfy the rule by construction: journey re-requests every 1 s tick, timed
  Heat steps and calibration renew every 5 s (`kCalibrationRenewIntervalUs`). A timed step may dwell
  the full 1,800 s (`kRoastStepMaximumS`) and stays inside the lease because the program
  re-instructs every 5 seconds, not because 1,800 equals the bound.

This replaces a client keepalive, which put a safety property in browser JavaScript and made closing
the browser cut the heat. No client-liveness rule belongs in this firmware, and the manual timer must
never be copied into a program path. The full rule is in
[`../safety-policy.md`](../safety-policy.md#the-30-minute-instruction-lease).

## The roast executor

A roast runs entirely on the device. After the `202` from `POST /api/roast/start`, timed and journey
roasts need no browser; manual is safe without one but needs an operator client for its next
adjustment or Stop. Every mode owns and renews its own 30-second Heat lease, ends on faults the same
way calibration does, and commands outputs only through the actuator core.

### Modes

- **TIMED**: `fan:heat:seconds` steps run for exactly their durations, with no model or feedback. A
  Heat step's clock starts only once Heat is effective, so the dwell excludes Fan qualification.
- **JOURNEY**: zones with temperature endpoints, driven at 1 Hz by `sr800_journey_control.{h,cpp}`,
  a port of `web/src/domain/journeyControl.ts`: closed-form model inversion plus an in-roast PI with
  a lag-compensated rate term. Zones advance on temperature attainment, never on time. Requires
  plausible applied calibration (`409` otherwise). Fan is 10 through 130 °C, overriding a lower
  authored maximum; above that, the baseline picks the greatest Fan whose required Heat can still
  make the zone's slope, bounded by the zone's `fanMin` and the Heat-on Fan 1.0 rule. Corrections
  spend Heat first, are bounded at +15 / −12 °C/min, and a positive Heat request rises at most 0.25
  level per tick while reductions apply at once. Cooling zones command Fan 10 / Heat 0. See
  [`docs/control-and-calibration.md`](../../docs/control-and-calibration.md).
- **MANUAL**: the operator sets the initial Fan and Heat and changes them with
  `POST /api/roast/set`. The roaster is authoritative for accepted and effective levels and records
  every accepted change.

### Cross-language vector verification

A hand port of a control law diverges silently, so the TypeScript implementation is the oracle.
`web/scripts/generate-journey-vectors.ts` drives the real `journeyControlStep` through twelve
scenarios (including weak heater, windup, plan patches, mass, irregular cadence, the Heat-on Fan
floor, and probe dropout) and records every input and output into
`tests/vectors/journey_control_vectors.json`: 7,304 steps, 29 columns.
`tests/journey_control_vector_test.cpp` replays every step through the C++ port, requires agreement
to 1e-4 on every field, and asserts zone gating and integration guards directly. The observed worst
deviation is the vector's own six-decimal rounding.

**If the test fails, fix the port, never the vector.** Regenerate only when the TypeScript law
changes deliberately: `cd web; npx vite-node scripts/generate-journey-vectors.ts`.

### `POST /api/roast/start`

Form-encoded; `202` on acceptance.

| Argument | Modes | Meaning |
| --- | --- | --- |
| `confirm` | all | Required; exactly `START_ROAST`. |
| `mode` | all | Required; `timed`, `journey`, or `manual`. |
| `name` | all | Up to 32 bytes; characters outside `[A-Za-z0-9._:- ]` become `-`. Default `roast`. |
| `mass` | all | Batch grams, 20–2000, default 225. Journey uses it for inversion. |
| `profile_id`, `profile_revision` | all | Profile identity, echoed in active-plan responses. |
| `steps` | timed | Required; 1–24 comma-separated `fan:heat:seconds`. Levels 0.0–10.0; nonzero below 0.1 lifts to 0.1; a Heat-carrying step's Fan below 1.0 lifts to 1.0 (lifted, never refused). `seconds` 1–1800. Fan 0 only with Heat 0. |
| `zones` | journey | Required; 1–12 semicolon-separated `endC:duration:fanMin:fanMax:heatMin:heatMax`. `endC` 0–300; `duration` nominal seconds (5–1800) or `r<rate>` °C/min; ordered bounds, `fanMax > 0`. |
| `start` | journey | Start temperature °C; defaults to the current reading, or 25. |
| `fan`, `heat` | manual | Required; Fan 0.1–10.0, Heat 0.0–10.0; with Heat on, Fan lifts to at least 1.0. |
| `record` | all | `0` selects the compact 10 s archive; otherwise the detailed 1 s archive. |

Zone start temperatures are never authored: zone 0 starts at `start` and each later zone where the
previous one ended, keeping the anchored target continuous at boundaries.

Start gates, in order: `423` manual conflict latched; `409` bad confirm; `400` unknown mode; `400`
plan or levels out of range; `409` journey without applied calibration; `409` any Heat without fresh
(< 1 s), fault-free telemetry below the overheat limit (`kOvertempDisableC`, 260 °C); `409` another operation active, Wi-Fi awake mode not
entered, or the actuator rejected the opening request (its text is passed through).

Before the first actuator request, `finalizeThermalLogForNewEpisode()` persists the previous log
with outputs idle, then a zero-sample v4 occurrence carrying the immutable plan is written atomically
under the new log id. If that fails, Start fails closed before outputs change; a synchronous actuator
refusal removes it; a successful run replaces it after idle with the sampled archive. A Start or
manual set during a post-stop tail takes over: the prior recording is saved with outputs idle and
the new episode proceeds.

Actuator-affecting starts get brief storage priority (`kActuationStartStoragePriorityMs` = 3,500 ms)
on the single storage lane, and the network layer retries only explicit `storage_busy` refusals that
precede any side effect. Stop advances an admission generation, so a start admitted before a Stop
cannot run from a queue or retry after it (`start_cancelled_by_stop`).

**Ambient** is the cold-junction temperature at Start, sampled once and frozen; the board warms
inside the roaster, and a drifting ambient would bias the passive-loss term.

```json
{"ok":true,"roast_active":true,"mode":"journey","name":"ethiopia-yirg",
 "batch_mass_g":225,"ambient_c":26.31,"ambient_source":"cold_junction",
 "steps":0,"zones":3,"started_epoch":1785000000,"session_id":7,"plan_rev":1,
 "profile_id":"profile-ethiopia","profile_revision":4,"log_id":"42",
 "state_rev":"118","boot":12,"elapsed_sec":0,"thermal_log_interval_ms":1000,"start_c":24.8,
 "coefficients":{"heater_gain":66.0,"fan_cooling":19.0,"cooling_fan":28.0,
                 "loss_per_min":0.17,"reference_batch_mass_g":225,"fit_id":"fit-2026-07-27"}}
```

`ambient_source` is `cold_junction` or `fallback` (24.5 °C). `start_c` and `coefficients` are
journey-only; manual returns requested, accepted, and effective Fan/Heat plus
`instruction_limit_ms`. `session_id`, `plan_rev`, `log_id`, `state_rev`, and `boot` form the
authority tuple a reconnecting browser must match before trusting an asynchronous response.

### `GET|POST /api/roast/active-plan`

GET returns the retained plan and identity: `active`, `boot_id`, `session_id`, `plan_rev`, mode,
profile identity, name, mass, start temperature, timed steps, and journey zones, plus
`initial_zones` reconstructed from the archived start plan. It stays available after the roast ends,
so a reconnecting browser resolves the completed roast instead of trusting a stale local copy.

POST requires `confirm=PATCH_ROAST_PLAN` and matching `expected_session` and `expected_plan_rev`
(`409` with the current pair otherwise).

- **Timed**: `step_index`, `duration_sec`, `fan`, `heat` replace the current or a later step, or
  append one (`step_index` equal to the step count). The current step must keep at least five
  seconds.
- **Journey**: the full proposed `zones` list. Completed zones are immutable. The active zone keeps
  its direction from its entry temperature and must leave at least five seconds beyond the elapsed
  time; if its new endpoint is already crossed, the request needs `allow_immediate_transition=1`.

Accepted edits advance `plan_rev`, take effect immediately, recompute the runtime envelope, and
enter the codec-2 journal. An edit that would overflow the journal is refused unchanged.

### `POST /api/roast/set`

Requires `confirm=CONTROL_ROAST`, the matching `expected_session`, and `fan`/`heat`. Each accepted
instruction advances `plan_rev` and is journaled with elapsed time and requested and effective
levels. The journal never gates the actuator, because the operator must always be able to change,
and especially lower, Heat: once it is full an instruction still takes effect, unjournaled, and the
response reports `journal_truncated: true`. The response carries accepted and effective levels,
`plan_rev`, `state_rev`, and the reset instruction limit.

### Stop and the post-stop tail

`POST /api/roast/stop` never refuses to stop. `expected_session` is advisory; a missing or stale
value still ends the active roast and is reported as `session_mismatch`. Heat stops immediately and
`end_reason` becomes `stopped`.

When a Stop interrupts an active roast (this route or `POST /api/stop`), the executor commands
Fan 10 / Heat 0 for 10 seconds (`kPostStopCoolingTailMs`) so residual element heat does not soak
into a stationary bean mass. Any newly accepted instruction, including a second Stop or manual Fan 0,
preempts it at once, and it does not change `end_reason` or recording closure. Tests, calibrations,
idle stops, and automatic endings get no tail; the safety policy forbids synthesized airflow after
faults and envelope breaches (the overheat latch runs its own core-owned cooldown instead), so a
profile that ends while heating should author its own cooling.
See [`../safety-policy.md`](../safety-policy.md#the-post-stop-cooling-tail).

```json
{"ok":true,"roast_active":false,"heater_off":true,"effective_fan":10.0,"effective_heat":0.0,"end_reason":"stopped"}
```

`recording_saved` / `recording_pending` say whether the terminal archive commit succeeded or is
retained in RAM for retry. Timed and journey recordings stay pending while their passive tail is
open.

### `status.roast`

Fields: `active`, `mode` (`none`, `timed`, `journey`, `manual`), `name`, the `session_id` /
`plan_rev` fence, `elapsed_sec` (frozen at the end), `started_epoch` (`0` if never synced),
`zone_index` / `zone_count` (advancing only by attainment), `zone_entry_sec`, `zone_elapsed_sec`,
`zone_nominal_sec` (compare the last two for overrun), `zone_end_c`, `target_c` (the anchored
in-zone target), `commanded_fan` / `commanded_heat`, `solved_fan` / `solved_heat` (before
quantization), `correction_total` (PI plus rate term, °C/min, clamped +15 / −12), `integral`
(clamped ±8; the model bias a refit consumes), `saturated`, `holdover`, `holdover_ms`,
`holdover_limit_ms` (30,000), `ambient_c`, `batch_mass_g`, `end_reason`, and `zone_attained_sec`
(per zone, the elapsed second its endpoint was attained, or `null`, never zero). Journey-only values
are `null` in other modes.

| `end_reason` | Meaning |
| --- | --- |
| `none` | Running, or never started since boot. |
| `completed` | Timed: every step ran. Journey: final endpoint attained. Both outputs stop. |
| `instruction_expired` | Manual: 30 minutes since the last accepted instruction. |
| `stopped` | An explicit Stop. |
| `fault` | A latched actuator fault (manual conflict, pulse-scheduler failure); outputs down. |
| `telemetry_stale` | Controller temperature updates paused while Heat was effective; the ISR cut Heat. Fresh healthy telemetry permits recovery without a power cycle. |
| `sensor_lost` | Thermocouple invalid or stale for more than 30 continuous seconds. |
| `envelope_timeout` | Runtime envelope breached; Heat off, no actuator cooling debt. |
| `qualification_stalled` | Heat requested but not effective within 10 s. |
| `step_rejected`, `renewal_rejected` | Timed: the actuator rejected the next step or a lease renewal. |
| `command_rejected` | Journey: the actuator rejected a command outside holdover. Under holdover a rejected Heat request is expected; the actuator's thermal gate refuses Heat for the same reason the step is running blind. |

### Faults, holdover, and limits

- **Holdover.** A thermocouple sample older than 900 ms (inside the actuator's 1 s freshness) puts
  the step into holdover: zero correction, frozen integral, feed-forward against the plan's
  temperature rather than a stale reading. After 30 continuous seconds the roast ends `sensor_lost`.
- **Transient tolerance.** A zero-cross gap the actuator rides through, or one bad thermocouple
  sample, does not end a program: a rejected request is retried for up to 2 seconds, with the 1 s
  stale trip and 30 s Heat lease as backstops.
- **Faults** end the program as calibration does: `telemetry_stale` for starvation, otherwise
  `fault` with outputs down. **Completion** turns both outputs off; the recorder may continue its
  fan-off passive tail, which owns no outputs.
- **Runtime envelope.** `2 × the plan's total nominal seconds + 600 s` (`kRoastEnvelopeMarginSec`),
  checked every pass for timed and journey roasts and recomputed after each edit. A journey whose
  endpoint is unreachable never completes by design; the envelope ends it with `envelope_timeout`.
  The browser's feasibility check is a warning, not an admission veto.
- **Coefficient plausibility.** `plausibleCalibration` requires `heater_gain` 0.1–500,
  `fan_cooling` 0.5–200, `cooling_fan` 1–300, `loss_per_min` 0.005–2, enforced at apply (`400`), at
  NVS load (implausible reads as absent), and at journey start (`409`). NVS persistence is
  fail-closed: commit `present=false`, verify every value, commit `present=true` last, and require
  exact read-only read-back before RAM adopts the set. A failed replacement may leave calibration
  absent but never partial.

### Live WebSocket DTO

The live snapshot carries `boot_id`, `state_rev`, stream sequence, program and session identity,
Fan, Heat, temperatures, fault, and recording state; the delta protocol is described in
[`docs/network-architecture.md`](../../docs/network-architecture.md#live-subscription-protocol).
During a roast the browser defers full status, so this stream is the only transport for roast
progress. It therefore carries the executor's whole per-tick journey tuple, published atomically
with `roast_zone` from the same snapshot: `roast_zone_entry_s`, `roast_zone_nominal_s`,
`roast_zone_end_c`, `roast_correction`, `roast_integral`, `roast_solved_fan` / `roast_solved_heat`,
`roast_holdover_ms`, `roast_end`, and `roast_zones_done` (`null` = never attained).

## Backup and restore

Documents round-trip through `GET`/`POST /api/data/…`; recordings through `GET /logs/<id>.crk` and
`POST /api/logs/restore`. The zip is assembled and unpacked in the browser (see
[`web/docs/controller-integration.md`](../../web/docs/controller-integration.md)).

Before formatting, the browser opens a restore maintenance lease (fresh token, 120,000 ms); an
expired lease stays persistently incomplete across reboot. While maintenance is active or
incomplete, unrelated mutations are refused but reads and Stop remain available. The first
destructive or successful restore mutation persists `dirty`; a dirty abort returns `409`, and only
resuming and committing clears it, so a partial restore never pretends the erased library still
exists. Each recording is validated independently; a failure at file N−1 leaves the N−2 before it
exactly as they landed.

| Endpoint | Args | Success | Failure |
| --- | --- | --- | --- |
| `GET /logs/<id>.crk` | | `200`, file verbatim, `application/octet-stream`, `Content-Disposition: attachment; filename=crackle-log-<id>.crk`, `Cache-Control: no-store`, exact `Content-Length` | `503` · `404` |
| `POST /api/logs/restore` | `id=<positive>` or `id=auto`, `confirm=RESTORE_LOG`; raw body | `200`: local `id`, bytes, samples, `count`, `logseq`, `replaced`, `recorded_on`, `recording_origin`, `storage_address` | `415` · `409` confirm · `503` · `400` · `413` over 121,244 bytes · `409` busy · `507` reserve · `500` |
| `POST /api/restore/begin` | `confirm=BEGIN_RESTORE` | `200`: opens or resumes maintenance; fresh `restore_token`, `expires_in_ms: 120000`, `state_rev` | `409` busy |
| `POST /api/restore/commit` | unexpired `restore_token` | `200`: clears maintenance, advances `state_rev` once | `409` invalid or expired |
| `POST /api/restore/abort` | token, or `confirm=ABORT_RESTORE` after expiry | `200` only when not `dirty` | `409` invalid or dirty |

**`GET /logs/<id>.crk` interprets nothing**, not even the checksum the CSV route requires. A
recording damaged in flash is recoverable only as a byte-exact copy; refusing it would make the
damage permanent. Checking happens where numbers are read (`/logs/<id>.csv`) and where bytes are
written back (restore).

**Upload.** Restore takes one length-bounded `application/octet-stream` body; `id`, confirmation, and
maintenance identity stay in query arguments. The storage worker streams chunks to
`/logs/pending.tmp` with no multipart parser, so memory does not scale with recording size. The cap,
`kMaxIncomingLogBytes` = 121,244 bytes, is the number the volume budget reserves; the browser
mirrors it and refuses an over-cap file before uploading.

**Validation.** `validateArchiveReader` in `sr800_log_codec.{h,cpp}` checks the completed temp with a
256-byte window. It is pure because this is the only place the format is checked rather than
produced, and a check that cannot fail in a host test has never been seen to fail. Only v4 restores.
Codec 1 must decode exactly `sampleCount` frames; codec 2 must contain one valid plan envelope and
then exactly `sampleCount` frames. A `400` names the failed `check`:

| `check` | Meaning |
| --- | --- |
| `id` | `id` is not a positive decimal. |
| `upload` | Wrong media type, missing body, incomplete receive, or temp-file failure. |
| `truncated_header` | Shorter than the header its version declares. |
| `bad_magic` | Does not begin with `CRKL`. |
| `bad_version` | Not v4. |
| `sample_count` | More samples than the RAM log could hold. |
| `zone_count` | More journey zones than exist. |
| `bad_codec` | A codec this firmware cannot decode. |
| `size_mismatch` | File length disagrees with the payload length. |
| `crc_mismatch` | Metadata, provenance, or payload fails its checksum. |
| `payload_undecodable` | Checksums correctly but is not a recording. |
| `log_id` | A numeric address disagrees with the header, or a remapped file fails revalidation. |

An over-cap upload is `413` with `check: size`. `payload_undecodable` is why validation is separate
from the serving reader: a CRC only proves the bytes arrived as they left, and a self-consistent
garbage file would otherwise list correctly and serve a truncated CSV forever. `log_id` matters
because `GET /api/logs` lists and links by the header id; a mismatch would list an entry whose own
download `404`s. The header is read by byte offset, never by casting the struct, and `crackle.ino`
`static_assert`s every `offsetof` against the codec's offset constants (plus magic, header sizes,
zone maximum, and raw stride), so the writer and validator cannot drift without failing the build.

**Addressing.** A numeric `id` must match the header and may replace that address. `id=auto`
allocates a free local id, rewrites only the storage-local header id and whole-file CRC, revalidates,
and renames atomically; producer identity and `originLogId` never change. Every refusal removes the
temp and preserves the old destination.

**Restore wins and never prunes.** An existing recording at that id is overwritten without a
conflict token, because restore replays an archive the operator already holds and
`confirm=RESTORE_LOG` makes that deliberate. Restore never sweeps: deleting recordings out of the
backup being restored would be wrong, so the 96 KiB reserve is a `507` refusal. The check
`used + file + reserve > total` is conservative on overwrite because temp and original coexist until
the rename.

**`logseq`.** If a restored id is above the NVS `logseq` counter, `logseq` rises to it; otherwise
restoring onto a formatted device would let the next roast overwrite restored recording `1`.
`nextLogArchiveId` takes `logseq + 1`, so this is exactly enough, and `logseq` only ever rises.

## Updating firmware

### Normal path: OTA

Upload the application-only `.bin` at `http://crackle.local/update`. Never upload a merged,
bootloader, or partition-table image.

1. Confirm the controller is idle: every test, program, and output stopped. OTA requires outputs,
   recordings, storage requests, and mutations fully idle and otherwise returns `409`.
2. Select the versioned application image and check the installed version shown.
3. Keep power connected until upload, verification, slot selection, and the device-owned reboot
   complete. A lost browser acknowledgement is not a reason to power-cycle.
4. Reload `/update` and `/api/status`; both must report the new version. Confirm storage is mounted
   and the library and recordings are intact.

The image goes to the inactive A/B slot. Its fixed prefix is preflighted before anything is written
(`422` if malformed, `413` if oversized), the written slot is read back and must match the received
SHA-256, and boot selection runs last, so any failure leaves the running firmware selected. During
the upload the HTTP handler owns port 80 and network Stop is unavailable, which is why OTA requires a
fully idle roaster. The sequence, and how a new image is marked valid, is in
[`docs/network-architecture.md`](../../docs/network-architecture.md#firmware-update-ota).

### Serial flash (recovery only)

Serial flashing is for a blank board or recovery. **Disconnect roaster mains and the isolated
charger first**, keep them disconnected for the whole USB session, never run Fan or Heat while USB
is attached, and disconnect USB before restoring mains.

A serial package contains the bootloader, partition table, `boot_app0.bin`, and the application,
each with a SHA-256, written at explicit offsets. It has no merged 4 MB image and no erase command,
so NVS and LittleFS are untouched:

```powershell
esptool --chip esp32s3 --port COM3 write-flash `
  0x0 crackle.ino.bootloader.bin `
  0x8000 crackle.ino.partitions.bin `
  0xe000 boot_app0.bin `
  0x10000 crackle.ino.bin
```

`boot_app0.bin` ships with the ESP32 Arduino core (`tools/partitions/boot_app0.bin`). Writing it to
`otadata` selects `app0`, so the new application boots even if the device was running from `app1`.

## Rules for maintainers

These rules encode failures that were expensive to find; several are pinned by the Python contracts.

- **Never call `ESP.getSketchSize()` at runtime.** Arduino core 3.3.10 implements it with
  `esp_image_verify()`, whose process-global `bootloader_mmap` is non-reentrant; a periodic call
  races `esp_ota_end()` validation and makes valid OTA images fail. The size is cached once in
  `setup()` before networking starts.
- **Never write `delay(0);` in a long loop.** It is `vTaskDelay(0)`, which yields only to equal or
  higher priority and never to the IDLE task the task watchdog checks (core 0, 5 seconds). Long
  flash loops call `pacedYield()`, a one-tick sleep after every 20 ms of work, never inside a
  critical section.
- **Request bindings are `static __thread`.** Making them globals lets a storage request read a
  concurrent command's arguments or answer into its response.
- **Never close another task's in-flight async request** with `httpd_sess_trigger_close`.
- **Every manifest-visible write advances the state revision** (`advanceStateRevision()`) or marks
  restore dirty (`markRestoreDirty()`); both bump `manifestMutationCount`, which invalidates the
  cached manifest and log listings.
- **Document saves and deletes adjust data-store totals by delta** (`applyStoredDocDelta`). A full
  walk (`refreshDataStoreStats()`) runs only at mount; it opens every run document and grows with
  the library.
- **Keep JavaScript out of `crackle.ino` string literals.** The Arduino preprocessor inserts forward
  declarations at the first function definition it finds and can mistake `async function` inside a
  raw string for one, corrupting the page. Static pages live in `sr800_web_pages.h`.
- **Flash writes only while the actuator is idle**, always `finalize → request`.
- **The actuator core is the only path to the outputs.** Programs call `actuator.request()`; they
  never write GPIO or compute phase delays.

## Releasing

Releases are built and published by CI from a version tag, so every download traces to tagged source.

1. Bump `kFirmwareVersion` in `crackle.ino` and `version` in `web/package.json`. Never reuse a
   version or replace the bytes published under one.
2. Run `npm --prefix web run embed` and commit the regenerated `crackle_bundle.h`.
3. Add a `## <firmware> / web <web>` section to `CHANGELOG.md` describing the release. Its text
   becomes the release notes.
4. Run the tests for what changed and confirm `python .github/scripts/release.py check` passes
   (CI runs both on every push).
5. Commit, then tag and push:

   ```bash
   git tag -a v2026-07-26.NNN -m "Crackle 2026-07-26.NNN"
   git push origin main --follow-tags
   ```

The [release workflow](../../.github/workflows/release.yml) then runs the full CI suite, checks the
tag against the firmware version, embedded bundle, and changelog, compiles with the exact FQBN
above, requires esptool to report the image checksum and validation hash as valid, and publishes a
GitHub Release with:

| Asset | Contents |
| --- | --- |
| `crackle-<version>-ota.bin` | Application image for `/update` |
| `crackle-<version>-serial.zip` | Bootloader, partition table, `boot_app0.bin`, application, per-file checksums, and `FLASHING.md` with the exact `esptool write-flash` offsets |
| `crackle-<version>-elf.zip` | ELF and map for decoding `system.stored_crash` |
| `SHA256SUMS.txt` | SHA-256 of each asset |

To package locally from an existing build, run
`python .github/scripts/release.py package --build <build dir> --out dist`.

## Security model

The HTTP API is unauthenticated and trusts its LAN: any host that can reach `crackle.local` can read
status, request actuation, change the library, and upload firmware. OTA images are not signed. **Do
not expose the controller to the public internet or an untrusted network segment.**

Actuation is protected by always-on interlocks rather than authentication: confirm tokens, the ISR
Heat lease, thermocouple gating with the 260 °C overheat latch and its Fan 10 cooldown, Fan qualification and
the Heat-on Fan floor, the manual-control conflict latch, and the instruction lease. A caller that
reaches the API cannot bypass them; see [`../safety-policy.md`](../safety-policy.md).

The recovery access point (SSID `Crackle`, fixed password `kApPassword` in source) starts only when
no station is configured or after 15 seconds of station loss, and only while outputs are idle; it
shuts down 15 seconds after the station connection is stable. Change the password in source before
deploying on a shared network.
