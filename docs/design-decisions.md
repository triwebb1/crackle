# Design decisions

The significant choices behind Crackle's current shape: what was tried, what the evidence showed,
and the rule that resulted. Each entry is written so the rule can be applied to new work.

## Hardware interface

### Drive the power stage, not the front panel

**Considered:** emulating the encoder and buttons through optocouplers and decoding the display to
confirm each action. **Problem:** the stock UI is modal (blinking edit fields, bounded timers, a
fixed Cooling sequence), so every command is a navigation with no reliable acknowledgement.
**Decision:** reproduce the PIC's trigger outputs downstream, with PC817 open collectors in parallel
with the factory command transistors. The factory board keeps working, the interface defaults open
on reset, and control is deterministic. See [reverse engineering](../hardware/reverse-engineering.md).

### A shared ground is not isolation

The factory 5 V rail could not power the ESP32: repeated boot-count jumps and rhythmic display
dimming were supply collapse, not firmware. The controller runs from a dedicated isolated charger,
but it still shares factory logic ground as a signal reference. **Rule:** no grounded USB, serial,
programmer, or oscilloscope while mains is present. Over-the-air updates make that rule practical.

### Generate timing in hardware and audit it independently

Timer callbacks emitted every pulse yet showed a repeatable 125 µs latency shelf, and disabling
Wi-Fi sleep did not move it. Raising the lateness threshold would have hidden the error rather than
fixed it. MCPWM comparators synchronized to the zero cross now raise and lower every pulse in
hardware (0–2 µs measured phase error), and a PCNT counter provides an independent physical edge
index. **Rule:** a capture path that can coalesce or drop callbacks must never be the only proof
that a waveform was complete.

### Classify zero-cross edges by interval, not polarity

The zero-cross comparator chatters (edges 2–7 µs apart) at real transitions, and capture callbacks
coalesce under a burst, so a callback's reported polarity can belong to a chatter edge.
Polarity-alternation checks caused false aborts heard as fan "blips". Edges are now classified only
by hardware-timestamped interval: below 6 ms is ignored, 6–11 ms is valid, and longer gaps coast
(≤ 100 ms) or fail low. Coasting exists because flash operations black out callbacks for up to
~58 ms without any physical signal loss.

## Safety policy

### Keep the safety rules few and universal

Early builds carried growing post-heat fan obligations (forced cooling timers, cooling "debt").
They were not stock behavior, they produced surprising Fan 10 spikes, and they blocked unrelated
actions. The policy converged on a small set that holds on every command path:

- Positive Heat requires established Fan; every Heat-off-to-positive transition starts a fresh
  500 ms fan qualification, even if the fan was already running.
- Heat on means Fan ≥ 1.0 at the command layer (a lower request is lifted, never refused); the
  actuator core keeps a deeper Fan ≥ 0.1 backstop.
- At Heat-off the requested Fan is authoritative immediately, including zero. No hidden airflow.
- Thermal faults qualify over three consecutive invalid samples; an independent 1 s freshness
  check removes Heat if updates stop; a reading at or above the 260 °C overheat limit for 1 s cuts
  Heat, latches, and runs a Fan 10 cooldown.

A roast-ending Stop is the one place the executor adds airflow: a 10 s Fan 10 / Heat 0 tail so
stationary beans cannot scorch on a hot element. Any new command preempts it, and it never follows
a fault or an envelope breach, where the safety policy forbids synthesized airflow. The one
fault-owned airflow is the overheat cooldown, which lives in the actuator core rather than the
executor, so no workflow can skip it and only an operator Stop can end it early.

### No client-liveness rule

A browser keepalive once guarded manual heat. It made closing a tab an emergency and put a safety
property in JavaScript. It was replaced by firmware leases: a renewable 30 s heat lease enforced in
the zero-cross ISR (it survives a stalled loop), and a 30-minute instruction lease that any new
command renews. Device-run programs renew locally. **Rule:** safety never depends on a client.

## Execution and data ownership

### The roaster runs the roast

The first web design had the browser stepping the roast. That conflicts with the basic requirement
that a phone may sleep or leave. Complete plans are now handed to an on-device executor; boot ID,
roast session ID, and plan revision fence live edits; the browser renders device truth and never
advances a tick.

### One control law, two languages, generated proof

The journey controller must run in the browser (previews, simulation, what-if editing) and on the
device (execution). It is written once in TypeScript as the oracle, ported to C++, and verified by
generated vectors replayed through both implementations. **Rule:** the port must match the oracle,
never the reverse; regenerate the vectors whenever the law changes.

### The controller is the database

Browser-local profiles and history gave a phone and a PC different views of the same roaster. The
library moved to LittleFS as opaque, versioned documents: the firmware stores bytes and versions,
TypeScript owns the schemas, and revision checks serialize concurrent editors. The browser keeps a
mirror only as a cache.

The same lesson applied again at a smaller scale. Setup values with no field in the recording
header (starting volume, ambient temperature, bean selection) were once kept in the starting
browser's local storage and merged after the roast. Every other browser saw a partial record until
that one reconciled. Now the browser writes the complete run record to the device before Start, as
a fail-closed precondition, and reconciliation completes that shared record in place. **Rule:** a
browser-side stash of durable facts is a partial-record generator, however carefully it merges
later.

### All-or-nothing rendering

A view either has its complete data set or shows that it is loading, with the reason. An expanded
History record waits for its document, recording link, and reconciliation; the storage page says it
is reading the recording list instead of reporting an empty archive. Only live roast surfaces
render incrementally.

### Recordings are compact binary archives

CSV exports and per-row requests were slow and fragile. `.crk` recordings use a fixed header,
CRC-32, and delta-varint samples (~5 bytes each), and carry immutable producer identity, the plan,
the instruction journal, and the probe correction applied at capture. Recording identity is
`{producer device, origin log ID}`; the storage address is mutable and is never trusted alone to
attach a curve to a record.

## Firmware platform

### A native ESP-IDF server, off the control loop

The Arduino `WebServer` ran inside `loop()`, so one sleeping client blocking a write could starve
the controller. Shorter request deadlines and extra ports for live data and OTA were tried; they
moved the failure around. The fix was structural: one native ESP-IDF service on core 0 with
bounded lanes (commands, Stop, assets, storage, OTA), immutable status snapshots, and a fixed-rate
live publisher. **Rule:** don't solve a blocking-ownership problem with shorter deadlines. Keep
network I/O out of actuation, bound every queue, reserve capacity for Stop, and recover from
authoritative snapshots.

### Never verify the running image at runtime

OTA finalization failed even though the received bytes and the flash readback were byte-identical.
Serial output showed `bootloader_mmap: tried to bootloader_mmap twice`: a status publisher called
`ESP.getSketchSize()`, which Arduino core 3.3.10 implements with `esp_image_verify()`, sharing a
process-global, non-reentrant mapper with `esp_ota_end()`. The application size is now read once
during setup, before any concurrency.

### Long flash work must yield to IDLE

A task-watchdog reset decoded (from the stored core dump and the matching ELF) to a storage-worker
directory walk that took 4.6 s on an idle controller. The loop already called `delay(0)`, but that
is `vTaskDelay(0)`, which never yields to the lower-priority IDLE task the watchdog monitors. Long
flash loops now call `pacedYield()`, a one-tick sleep after each 20 ms of work, and a source
contract forbids `delay(0);`. The listings it walked are now cached against a mutation counter.

### Internal RAM is the scarce resource

With 2 MB of PSRAM available, internal SRAM still runs out first: Wi-Fi buffers, task control
blocks, and the HTTP and storage stacks must stay internal. A page-load burst once drained internal
heap to a few hundred bytes, starving Wi-Fi and producing reconnect cycles. The fixes were to
shrink a diagnostic timing log, move large non-flash worker stacks to PSRAM, and report heap and
stack low-water marks in status. **Rule:** every new allocation states whether it may live in PSRAM.

### Gzip, not WebAssembly

The web payload embeds gzip-compressed (about 0.8 MB of assets to about 0.25 MB). WebAssembly was
rejected as a size strategy: most of the code is UI and DOM logic, and a WASM boundary adds glue
rather than removing it.

## Control and calibration

### Batch mass is thermal capacity

An early model scaled only heater gain by batch mass, so a heavier batch artificially lowered the
equilibrium temperature. Mass now scales the complete net thermal rate: equilibrium at fixed inputs
is mass-invariant, and response time grows with mass.

### Airflow is the profile's job

A 250 g batch scorched on its first automated Journey roast because a low starting Fan did not
fluidize the bed. A mass-dependent fan floor with a slow reduction throttle followed. It produced a
fan sawtooth at zone boundaries, which needed retention logic, which needed more exceptions.
All of it was removed. The firmware keeps two simple rules (Fan 10 below 130 °C and Fan ≥ 1.0
whenever Heat is on), and each zone's `fanMin` expresses the circulation a given batch needs.
**Rule:** prefer one universal invariant plus an explicit profile parameter over an inferred
policy with special cases.

### Refuse a fit that the evidence cannot identify

Calibration fits once returned plausible-looking coefficients from an almost flat error valley: a
heat-soaked ambient reading, the bean turnaround transient, and a single-node model made fan cooling
unidentifiable. The fitter now takes ambient from the coolest late cold-junction reading, simulates
but does not score the opening three minutes of a loaded roast, lets baselines pin heat-off airflow
(and heating-mode airflow only when the loaded roasts cannot resolve it), and compares deterministic
multi-start fits. When the starts disagree, Save and Apply are refused with guidance about what
evidence to add. Model feasibility is a warning, qualified by the applied fit's replay error and by the
temperatures its evidence actually reached, never a Start veto; the device's runtime envelope is the
authority.

## Clients

### Replace dead sockets; don't wait for `onclose`

After a phone lock, iOS may never deliver `onclose` for a socket that died in the background, so a
page could stay stale until reloaded. The live subscription is replaced outright when the page
becomes visible, comes back online, regains focus, or stays stale for 20 s. Weak roaster Wi-Fi
(≤ −78 dBm) is reported in the UI, because packet loss at the roaster looks identical to an app bug.

## Testing

### Test at boundaries; pin architecture cheaply

High-value tests sit at boundaries: the actuator, the zero-cross qualifier, the archive codec, query
parsing, live-delta generation, mock WebSocket framing, restore sequencing, and the cross-language
control vectors. Python source contracts pin wiring and architecture invariants (such as which lane
a route uses, or forbidden calls) for about a second of runtime. They are tripwires, never
described as behavioral proof. Hardware claims require a physical test; host success is not a soak.
See [testing](testing.md).
