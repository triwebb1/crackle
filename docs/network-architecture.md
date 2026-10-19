# Network architecture

This document describes how Crackle's network face is structured so that it stays responsive when
browsers sleep, disappear, refresh concurrently, or download large files, without ever affecting the
control loop. The endpoint reference is in [`firmware/crackle/README.md`](../firmware/crackle/README.md);
the safety rules are in [`firmware/safety-policy.md`](../firmware/safety-policy.md).

## Outcome

No browser-owned socket may run inside the actuator/control loop. The roaster remains the source of
truth for durable data and active state; a browser that goes away mid-roast changes nothing on the
device, and a browser that returns reconciles from authoritative state.

## Ownership and execution lanes

- **Core 1 control loop.** `loop()` owns the actuator, programs, sensor decisions, and all mutable
  controller state.
- **Core 0 HTTP service.** One native ESP-IDF `esp_http_server` owns port 80: TCP sessions, parsing,
  response framing, keep-alive, and WebSocket upgrades.
- **Two general workers** serve immutable live/status reads and ordinary commands. Each has its own
  preallocated 12 KiB status buffer rather than a large stack local.
- **One asset worker** with five bounded, PSRAM-first asset jobs absorbs a simultaneous phone and PC
  cold load and isolates a slow page download from status, commands, Stop, storage, and OTA.
- **Stop has a reserved mailbox slot**, queue, and dedicated higher-priority worker. Ordinary
  commands cannot consume that capacity. Every Stop-class route (`/api/stop` and each per-mode
  `…/stop`) uses this lane.
- **A single storage worker** owns all network-facing LittleFS document and archive operations and
  terminal recording finalization. It holds three fixed request records behind a three-entry FIFO;
  a full FIFO answers `503` with `Retry-After: 1`. Boot mount/health checks and the idle
  pre-actuation plan precommit are the two explicit exceptions, and both finish before outputs
  start.
- **A live publisher** runs at a fixed cadence, independent of connected browsers and of every HTTP
  worker queue.
- **Raw OTA** (`POST /update`) is the deliberate listener exception, described under
  [Firmware update (OTA)](#firmware-update-ota).

| Task or object | Stack / size | Memory | Priority |
| --- | --- | --- | --- |
| HTTP daemon | 16 KiB | internal | idle + 5 |
| Stop worker | 12 KiB | PSRAM | idle + 5 |
| Command workers (2) | 12 KiB each | PSRAM | idle + 4 |
| Asset worker | 5 KiB | PSRAM | idle + 3 |
| Storage worker | 16 KiB | internal | idle + 3 |
| Live publisher | 6 KiB | PSRAM | idle + 3 |
| Asset jobs, status payloads, live buffers | | PSRAM first, internal fallback | |
| Task control blocks, queues, Stop and storage job records, synchronization | | internal | |

Flash-writing stacks (HTTP daemon, storage worker) stay in internal RAM, because a flash program or
erase disables the cache that PSRAM access depends on. PSRAM is nevertheless a hard dependency for
the other worker stacks: if it is missing, the actuator loop keeps running safely and network
startup retries every 30 seconds, but the web UI and network Stop are unavailable. Wi-Fi mode is
established before the server allocates its lanes.

## Command boundary

A bounded command mailbox is the only mutation path from the network server to the control loop.
It has two ordinary slots plus the reserved Stop slot, all in internal RAM. Each command carries a
request id, fixed-capacity URI (112 bytes), query (2 KiB), and body (1 KiB), an expected state
revision where required, and a 4 KiB response slot; the response capacity is compile-time checked
against the largest legal active-plan response (24 timed steps, or 12 current plus 12 initial
journey zones). A timeout abandons only the waiting caller.

Form bodies are parsed before the URL query, so credentials never need to appear in a request URL.
Request bindings inside the control loop and storage worker are task-local (`static __thread`), so
a storage request can never read a concurrent command's arguments.

A lost acknowledgement is reconciled from the request id and the authoritative state revision; the
browser never blindly repeats a mutation that may already have committed.

**Start and storage.** Actuator-affecting starts briefly receive priority over the storage lane
(3.5 seconds), and the network layer retries only explicit `storage_busy` refusals that are known to
precede any side effect. Stop advances an admission generation, so a start admitted under an older
generation can never execute from a queue or retry after Stop; it answers
`start_cancelled_by_stop`.

## Live subscription protocol

- `/ws/live` is the subscription channel. A connection receives one complete immutable snapshot and
  its sequence, then top-level JSON deltas from the immediately preceding published snapshot.
- Publication is independent of subscriber count and produces at most one update per second. With
  no subscribers the publisher still builds the same device state.
- Every delta names its base sequence. A browser that lacks the base closes and reconnects for a new
  snapshot. A server-side parse or capacity failure marks every subscriber for a new full snapshot
  before the base advances.
- Each publisher tick reconciles the four subscriber records with ESP-IDF's authoritative list of
  open WebSocket sessions (`httpd_get_client_list`, `httpd_ws_get_fd_info`). This covers upgrades
  whose callback ordering would otherwise leave application bookkeeping stale.
- There is no unbounded per-client queue. A failed send evicts that subscriber. When all four slots
  are occupied, a newly opened browser wins only over a subscriber with no successful send for 15
  seconds; four healthy subscribers reject a fifth rather than entering an eviction/reconnect loop.
- Ping frames receive a Pong carrying the exact payload. Malformed or oversized inbound frames close
  only that subscriber.
- Subscribers are capped at four while the server permits eight open sockets, preserving HTTP
  capacity across overlapping reloads. LRU purge and TCP keep-alive clean up abandoned sessions.
- `/api/live` is the compact coherent HTTP snapshot for initialization and fallback. Browser
  controls tolerate ordinary packet delay; one missed second does not make the roaster stale.

Library documents, recordings, and workflow mutations remain explicit HTTP resources. They are never
multiplexed into the ordered telemetry stream.

## HTTP and transfer behavior

- Listener handlers hand ordinary requests to bounded workers. Raw OTA is the only exception.
- Immutable gzip assets stream directly from flash on the asset lane in 4 KiB chunks. Each socket
  write has a bounded wait; a peer that keeps making progress may take as long as its link needs.
  There is deliberately no arbitrary total lifetime for reads.
- Status is formatted from an immutable controller snapshot and remains available during actuation
  and recording.
- A transient `503` from a bounded queue carries `Retry-After: 1`. The browser consumes that response
  fully and retries once, with short jitter, only for idempotent GETs that carry the header. A second
  refusal stays "busy/unreachable" and is never reclassified as unmounted storage. Mutations are
  never retried blindly; they use request-id and state-revision reconciliation.
- Documents and recordings move as HTTP files and chunks, never as one request per CSV row or as
  WebSocket telemetry. Storage transfers are serialized and use progress-based receive and send
  bounds, plus whole-transfer deadlines on uploads (15 seconds for a document body, 120 seconds for
  a recording) so a trickle cannot hold the storage lane.
- Immutable stored-document, index, manifest, log-list, and archive GETs remain available during
  actuation: reads cause no flash program/erase blackout. `/thermal.csv` serves a fenced,
  consistent prefix of the in-progress recording, copied out in bounded chunks under short critical
  sections. Live state and Stop remain available throughout.
- The manifest and recording listings are cached against a mutation counter, so repeated reads do
  no flash walk. Long flash loops yield with `pacedYield()` (a one-tick sleep after every 20 ms of
  work) so the IDLE task on core 0, which the task watchdog checks, always runs; `delay(0)` is
  `vTaskDelay(0)` and never yields to the lower-priority IDLE task.

## Firmware update (OTA)

`POST /update` takes a raw `application/octet-stream` application image. OTA is handled entirely
inside the registered HTTP handler: the HTTP task owns the request body from receive through
finalized-flash verification, with no cloned request, async handoff, queue, or separate worker. The
control loop still owns OTA admission and state freezing, so the HTTP task never makes a
check-then-act decision from mutable actuator or storage state.

1. **Admission.** OTA requires outputs, recordings, storage requests, and mutations fully idle,
   checked and frozen atomically with storage admission (`409` otherwise). An image larger than the
   inactive slot is refused (`413`).
2. **Preflight.** The complete fixed prefix (image header, first segment header, application
   descriptor) is received and validated for magic, ESP32-S3 chip id, segment count, and appended
   hash before anything is erased or written. A malformed prefix returns `422` and leaves service
   unaffected.
3. **Write.** `esp_ota_begin` / `esp_ota_write` to the inactive A/B slot, hashing every received byte
   with SHA-256. Receive waits are bounded by progress (30 seconds without progress aborts).
4. **Validate.** `esp_ota_end()` validates the complete image. The written slot is then read back
   and its SHA-256 must equal the received SHA-256.
5. **Select.** Only then does `esp_ota_set_boot_partition()` run. Boot selection is last and the
   reboot is device-owned, so a lost browser acknowledgement or any earlier failure leaves the
   running firmware selected. Every failed upload session is closed and the factory-conflict
   interrupt restored.

`/api/status` reports `ota_last_attempt` (declared and received bytes, target offset, error, and
both SHA-256 values) and the handler's stack low-water mark.

While an upload runs on the idle roaster, the handler reserves port 80 until receive, flash
verification, and response finish. The independent control loop continues safely, but HTTP,
WebSocket servicing, and network Stop are unavailable until the handler returns; that is why
admission requires a fully idle roaster.

A newly booted image is marked valid after it serves its first complete `/api/status` or
`/api/live` response, or, without a browser, after 120 seconds with the station associated, the HTTP
server running, and the phase scheduler healthy. Uptime alone never proves an image serves requests.

**Never call `ESP.getSketchSize()` at runtime.** Arduino core 3.3.10 implements it with
`esp_image_verify()`, whose process-global `bootloader_mmap` is non-reentrant. Calling it from the
periodic snapshot publisher races `esp_ota_end()` validation and makes host-valid images fail to
finalize. The immutable application size is cached once in `setup()`, before network or status
concurrency starts, and published from the cache.

**Serial recovery.** A serial package writes the bootloader, partition table, OTA metadata
(`boot_app0.bin`), and application at explicit offsets while leaving NVS and LittleFS untouched. It
contains no merged 4 MB image and no erase command. Serial work requires roaster mains and the
isolated charger to be disconnected; see [`firmware/crackle/README.md`](../firmware/crackle/README.md#serial-flash-recovery-only).

## Capacity and failure rules

- Every socket, subscriber, queue, job, body, query, response, and mailbox count is fixed and
  auditable in source. Exhaustion returns `429` or `503`; it never blocks the control loop.
- Diagnostics expose resource pressure without imposing a watchdog deadline on valid flash work:
  per-worker stack low-water values (the storage worker also names the request that set its
  low-water), rejected-request and worker-failure counters, the slowest storage request and its
  route, live-subscriber occupancy and capacity, heap and PSRAM minima, failed allocations, reset
  reason, an eight-boot reset history, and a stored core-dump summary. Settings shows these under
  Advanced. A slow browser request with a fast handler time is network delay, not the roaster.
- A failed thermal-recording PSRAM allocation reports `thermal_log.available=false`.
  Recording-dependent roast and calibration starts fail clearly, while Fan/Heat diagnostics and Stop
  remain usable; recording capacity is never misreported as a factory-panel conflict.
- Wi-Fi power saving is disabled. Station reconnect is attempted every 5 seconds and continues during
  a roast. The recovery access point starts when no station is configured or after 15 seconds of
  station loss, but only while outputs are idle, because changing Wi-Fi mode is a topology change;
  it shuts down 15 seconds after the station connection is stable. A failed recovery-AP start is
  retried every 5 seconds while outputs are idle. All of this is independent of browser connections.
- Network service startup waits until station or recovery-AP mode is ready and retries a failed
  allocation every 30 seconds without blocking `loop()`. mDNS (`crackle.local`) may advertise port
  80 briefly before a deferred server start succeeds; a persistent start failure remains observable.

## Validation scenarios

Changes to this layer are checked against concurrent PC and phone clients, sleeping clients, stalled
asset and archive downloads, status during actuation, lost command responses, Wi-Fi reconnect, OTA
disconnects, malformed OTA prefixes, and stored-library verification. The burst check cold-loads a
phone and a PC immediately after boot while downloading a stored recording and occupying all four
live subscriber slots. Diagnostics must show bounded refusals, no worker failures, useful stack
reserve, either stale-subscriber replacement or an explicit fifth-client refusal, and continued Stop
and status availability.
