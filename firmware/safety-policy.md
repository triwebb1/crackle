# Actuator safety policy

These rules are firmware invariants. Profiles, browser controls, API requests, and stored settings
may request safer behavior but cannot weaken, bypass, or shorten them. This document is normative
for safety; product context is in [the product specification](../docs/product-spec.md), and endpoint
contracts are in [`crackle/README.md`](crackle/README.md).

This document is the full current safety envelope. It separates:

1. **The hardware-timed core**: waveform mapping and fail-low scheduling in `sr800_actuator.*` and
   `sr800_mcpwm_phase_scheduler.*`, audited against hardware captures.
2. **Policy in that core**, set from observed hardware behavior: the factory Fan-1 endpoint is
   allowed at every positive Heat level, Heat-off creates no Fan hold or cooling debt, and transient
   sensor faults are qualified before latching.
3. **The layers above it**: program, storage, and endpoint bounds that cannot weaken core rules.

Verified against `crackle.ino`, `sr800_actuator.*`, and `sr800_mcpwm_phase_scheduler.*`. A short
zero-cross outage clears logical Heat and requires a fresh 500 ms Fan qualification, actuator starts
complete log and NVS work before requesting outputs, and an aborted OTA upload restores the
factory-conflict interrupt.

## Part 1: hardware-timed actuator core

### Effective versus requested values

The controller tracks requested and effective Fan and Power separately. When a request violates a
floor, firmware raises the effective Fan command and reports an explicit safety override. It does not
silently run the unsafe pair.

### Heater requires established fan

Whenever requested Power changes from 0 to a nonzero level, start a fresh qualification interval:

1. Apply the minimum Fan floor for that Power level.
2. If the fan was stopped, enter `FAN_STARTUP` and begin the calibrated startup envelope.
3. Keep the heater physically disabled for at least 500 ms of uninterrupted fan command activity.
4. Enable heater triggers only after the 500 ms interval and all ordinary fault gates pass. If a
   validated temperature channel is configured as a safety input, its telemetry must also be valid.

Prior Fan-only runtime is not credited: every transition from Heat off to positive Heat waits the
fresh 500 ms even when Fan was already running. A Fan command that falls below the required floor or
a qualified zero-cross interruption resets the timer. Raising Heat restarts qualification only if it
raises the required Fan floor above the currently effective Fan command.

### Minimum fan while heating

The valid actuator domain is `0.0` or any decimal from `0.1` through `10.0`. Values above zero and
below `0.1` clamp to the factory level-1 endpoint.

| Effective Heat | Minimum effective Fan |
| ---: | ---: |
| 0.0 | 0.0; with Heat off, the requested Fan is authoritative |
| 0.1 through 10.0 | 0.1, captured factory Fan 1 |

A higher Heat-dependent core floor (Fan-2 equivalent `1.338` above Heat `7.525`) is deliberately
absent: on the installed machine, stock Fan 1 with high Heat reached a higher chamber equilibrium
than a forced Fan 1.338, so the extra floor was neither stock parity nor necessary for the heater's
airflow prerequisite. The 500 ms uninterrupted fan qualification is unchanged. An insufficient
request is still raised to `0.1`, reported as a constraint, and the firmware remains the authority
for the effective value.

**If Heat is on, Fan must be 1.0 or higher, on every command path, always.** That rule is enforced
at the **command layer** (Part 2): every parser and request site that forms a Fan/Heat pair lifts a
heat-carrying fan below `1.0` up to `1.0` (`kHeatOnFanMinimumMilli`), and the browser mirrors the
same lift before sending. The audited actuator-core table above is deliberately unchanged: its `0.1`
qualification floor remains the deeper hardware-audited backstop beneath the command rule.

### Heat-off has no mandatory fan hold

When Heat ceases to be effective, the actuator creates **no** cooling debt, timer, forced airflow, or
action blocker. (The overtemperature cooldown is the one exception, and only after the overheat
limit trips.) Heat turns off immediately and the requested Fan becomes authoritative immediately,
including Fan `0`.

Energy-scaled post-Heat cooling and short fixed Fan holds are deliberately absent. Stock behavior
does not justify a hidden post-Heat override.

A roast, calibration, or profile may explicitly request Fan-only process cooling, including Fan
`10`. That authored command remains ordinary workflow intent; it is not an actuator safety
obligation and does not prevent a later accepted Fan `0` request.

One such workflow command is the **post-stop cooling tail** (Part 2): the roast **executor** follows
a roast-interrupting Stop with a Fan `10` / Heat `0` instruction for ten seconds. It is authored above
the core like any other request. The actuator still creates no cooling debt, timer, or forced airflow
of its own, and the tail yields immediately to any newly accepted instruction.

### Bounded renewable heat lease

Heat always runs under a lease of at most **30 seconds** (`maximumHeatRunUs`, supplied as
`kHeaterProofMaximumMs * 1000`). The lease is enforced **in the zero-cross ISR**, not in `loop()`, so
a dead or stalled main loop lets Heat expire hands-off. The loop-side deadline check is a 500 ms
backstop, not the authority.

Every path that holds Heat renews the lease by issuing a fresh actuator request: the roast executor
does so every 1 s (journey) or every 5 s (timed, within a step), the calibration program every 5 s,
and manual control from its service loop. **Ceasing to renew is how lease-expiry heat-off happens**;
explicit Stop and program Heat-off requests remove Heat immediately. Neither path creates a hidden
Fan command; Fan follows the operator or workflow request.

### Fan startup envelope

Factory captures establish a setting-dependent soft start of approximately 0.5 s. The factory
maximum fan setting (Fan 9) moves from approximately 2.14 ms toward 1.48 ms after pin 17. Crackle's
public Fan `10.0` is acoustically capped at the old raw 8.9 point: it moves from 2.716 ms toward a
settled 2.110 ms delay. Fan `0.1` is inferred from the correlated endpoint captures to move from
approximately 4.635 ms toward 4.460 ms. Intermediate settings interpolate the startup offset while
their settled delay is solved from the linearized phase-input-power target.

The envelope runs entirely inside the mandatory 500 ms fan-before-heater interval and is scheduled by
the MCPWM hardware timer, never by a long interrupt busy-wait.

### Thermal safety protocol

Thermal protection is a firmware-level protocol rather than per-program temperature ceilings:

- Heat may start only with fresh (under 1 s, `kThermalSafetyFreshnessUs`), fault-free MAX31856
  telemetry. A single invalid 250 ms sample becomes `UNKNOWN` and cannot authorize new Heat, but it
  does not latch a running episode off. Three consecutive invalid samples (about 750 ms) qualify a
  `thermal_sensor` fault, remove Heat, and latch until power cycle. If sensor updates stop entirely,
  the independent 1-second ISR freshness fail-safe still removes Heat, records `thermal_stale`, and
  aborts the active operation. Neither path creates generic post-Heat cooling debt. The stale event is
  evidence of controller scheduling starvation, not probe failure, so it clears only after fresh
  `HEALTHY` telemetry returns and every operation owner is idle.
- **The overheat limit.** A present, fault-free bean-probe reading at or above **`260 C`**
  (`kOvertempDisableC`) for at least **1 second** (`kOvertempSustainMs`), while Heat is requested or
  on, latches an `overtemperature` fault:
  - Heat is removed at once and stays locked off until power cycle; every command is refused.
  - The actuator core then runs the **overtemperature cooldown**: Fan 10 (`kOvertempCooldownFanMilli`)
    with Heat 0, until the reading has stayed below the limit for **3 minutes**
    (`kOvertempCooldownMs`); a reading back at or above the limit restarts that clock. Then every
    output is off.
  - Only an operator **Stop** (every Stop route), a manual-control conflict, or a scheduler failure
    ends the cooldown early. Ordinary workflow cleanup cannot.
  - The web app shows a critical banner quoting the limit (`actuator.overtemp_limit_c` in
    `/api/status`) and the cooldown time left.
- Roasts end near 230 °C, so a working probe never reaches 260 °C in a normal roast. The limit is a
  build-time constant: a builder who needs to roast hotter raises `kOvertempDisableC` in
  `crackle.ino` and builds their own image. Calibration programs, manual control, and roast programs
  have **no temperature ceiling of their own**; this latch is the single thermal limit, and an
  empty-chamber calibration step that reaches it ends the pass. It does not make unattended roasting
  safe: the operator, present at the roaster, remains the first defense against a chaff or bean
  fire, and Stop ends the cooldown if airflow should stop.

### Zero-cross observation and the coast policy

Output pulses are 100 µs hardware gate pulses fired by MCPWM comparators synchronized to the GPIO6
zero-cross reference. The observation policy classifies **by hardware-timestamped interval only**;
edge polarity is deliberately not a validity signal (see the note at the end of this section).

- **Qualification.** Actuation requires 6 clean intervals in the valid band
  (`kRequiredQualificationIntervals = 6`).
- **Valid band**: 6–11 ms (`kMinimumZeroCrossIntervalUs = 6000`,
  `kMaximumZeroCrossIntervalUs = 11000`).
- **Below 6 ms**: ignored noise. It must not touch outputs, qualification, or the interval baseline.
  Counted in `ignored_zero_cross_glitch_count`.
- **Above 11 ms and up to 100 ms** (`kMaximumCoastIntervalUs = 100000`) during actuation: a
  **coast**. The command is retained, output resumes on the returning edge, and the event is counted
  in `coasted_zero_cross_count` only. This exists because a flash program/erase blacks out the
  capture callbacks for tens of milliseconds (~58 ms observed) without any physical loss of the mains
  reference.
- **Worse than that**: abort fail-low. The requested Heat command is retained for bounded recovery,
  but logical/effective Heat is cleared and cannot resume until returning timing establishes a fresh
  500 ms of qualified Fan airflow.
- **Heat-side timing loss persisting 250 ms** (`kZeroCrossRecoveryGraceUs`) latches `zero_cross_lost`
  and keeps Heat off. **Heat never auto-resumes after a latch.**
- **The MCPWM timer period is 12,000 µs** (`kTimerPeriodUs`) with `MCPWM_TIMER_START_STOP_FULL`. It
  exceeds every valid 6–11 ms half-cycle, so the timer never stops mid-operation, and it parks both
  outputs low within 12 ms of sync loss. Setting it to 8,333 µs would be wrong: real intervals
  alternate around 8,760/7,910 µs, so the timer would stop at full on every long half-cycle and
  reintroduce ISR restart latency into pulse phase.
- PCNT supplies a separate physical zero-cross index, so callback coalescing cannot make an
  incomplete waveform appear complete, and PCNT edge-delta telemetry at each rejection distinguishes
  a callback blackout (delta ≈ elapsed half-cycles) from real signal loss (delta = 1).

**Do not reintroduce edge-polarity validity checks or per-glitch output forcing.** GPIO6 comparator
chatter, bursts of extra edges 2–7 µs apart at real transitions, has been measured on the hardware.
It is harmless to the hardware sync and to the outputs (all audited pulses within 0–1 µs), but MCPWM
capture callbacks coalesce under bursts, so a callback's reported polarity can belong to a chatter
edge. Polarity-alternation checks falsely abort on the *next* normal edge and cause audible fan
dropout blips.

### Manual-control conflict latch

U3B pin 12 is a passive factory-fan sensor. A real factory manual Fan command is a train of short
pulses about 8.33 ms apart. A pulse train spanning at least 50 ms forces both ESP outputs low, aborts
the active ESP test or program, latches `manual_conflict_latched`, and rejects all further actuation.

**The latch has no web clear operation.** It resets only when the ESP loses power. Factory manual
controls continue to work throughout, because both PC817 outputs are open while disabled.

### Fault overrides

Any over-temperature or implausible reading from a configured, validated thermocouple, or any
actuator-timing, ownership, scheduler-setup, or watchdog fault, immediately disables heater triggers.
A fault may disable all actuation, but it never synthesizes a Fan request or creates a post-Heat
cooling hold, with one exception: an `OVERTEMPERATURE` trip runs the core-owned overtemperature
cooldown described under the overheat limit above. If a workflow's already-requested Fan remains permitted during a recoverable timing
condition, that command remains workflow intent rather than fault-authored cooling.

Fault classes: `MANUAL_CONFLICT`, `ZERO_CROSS_LOST`, `PULSE_SCHEDULER_FAILURE`, `THERMAL_SENSOR`,
`OVERTEMPERATURE`, and `THERMAL_STALE`. Only `THERMAL_STALE` has a guarded runtime clear, because it
is a controller-telemetry freshness lapse rather than a qualified sensor fault; every hard latch
still requires a power cycle.

## Part 2: the layers above the core

Each of these bounds a hazard the actuator core structurally cannot see. None of them can shorten,
weaken, or cancel a Part 1 rule.

### The heat-on fan floor

**If Heat is on, Fan must be 1.0 or higher.** The rule is universal: heating still air is never
allowed on any path.

Every command path that forms a Fan/Heat pair (timed-step and calibration-step parsing, manual set,
manual-roast set, live timed-step edits, heater-proof start, roast start, and the journey executor's
own request) lifts a heat-carrying fan below `1.0` to `1.0` (`heatOnFanFloorMilli`). Old profiles are
**lifted at execution, never refused**, and the lift is reported through the same effective-level
surfaces as the `0.1` normalization. Fan-only requests (Heat `0`) are untouched: `0` stays off,
`0.1`–`10` stays valid. The journey control law folds the same floor into its airflow solve and
re-solves Heat for the lifted fan. The actuator core's `0.1` qualification floor (Part 1) is the
unchanged audited backstop beneath this rule.

### The 30-minute instruction lease

**An instruction is good for at most 30 minutes** (`kManualInstructionLeaseMs = 1800000`) through any
path: journey, timed roast, or manual control. **A new instruction, the same levels repeated or
different ones, resets the clock.** Nothing else resets it, and in particular nothing about a
browser being open resets it.

- **Manual control** enforces it with an explicit timer, because manual is the one path whose
  instruction comes from a hand rather than from a program. Every accepted `POST /api/manual/set`
  (and, for a manual roast, `POST /api/roast/set`) resets the clock.
- **Expiry is a full stop, not an output cut.** The whole instruction expires: `end_reason`
  `instruction_expired`, the session ends, and both outputs stop. **Fan-only instructions expire
  too**: a fan-only setting is still an instruction, and a lingering session would block programs
  indefinitely.
- **Expiry calls the same immediate actuator Stop as an explicit operator Stop.** Heat is removed at
  once and the session ends; there is no post-Heat Fan hold. The independent 30-second ISR Heat lease
  remains a fail-safe for a stalled control loop that cannot issue Stop; it is not the normal expiry delay.
- **Device-run programs satisfy the rule by construction**, and are audited rather than given a
  second timer. Worst case measured as the longest a program can hold Heat without issuing a fresh
  `actuator.request`: journey **1 s**, timed **5 s**, calibration **5 s**. A timed step may legally
  dwell the full `kRoastStepMaximumS = 1800` s and stays inside the lease *because the program
  re-instructs every 5 s throughout that dwell*, not because 1800 ≤ 1800.

**A client keepalive is deliberately absent.** Making heat conditional on a browser staying open and
chattering means closing the browser cuts the heat: an ordinary deliberate action treated as an
emergency, and a safety property living in browser JavaScript rather than in the firmware. **No
client-liveness rule of any kind may exist anywhere in this firmware**, and the manual block's
explicit timer must never be copied into a program path.

### The post-stop cooling tail

When a Stop ends an **active roast** (`POST /api/roast/stop`, or the workflow-agnostic
`POST /api/stop` while a roast is running), the roast executor commands **Fan 10 / Heat 0 for
10 seconds** (`kPostStopCoolingTailMs`), then turns both outputs off. The element and drum plate hold
heat after a mid-roast Stop, and a fan that dies instantly leaves that heat soaking into a
stationary bean mass, which can scorch it.

Bounds on the tail, all normative:

- **It is executor-authored, not actuator policy.** The audited core contract above (Heat-off
  creates no cooling debt, timer, or forced fan) is unchanged. The tail is an ordinary Fan-only
  instruction issued after `finishRoast`.
- **It never blocks anything.** Any newly accepted instruction (a manual set, a new program start, a
  second Stop) preempts it immediately; a second Stop or manual Fan `0` yields genuinely-off outputs
  within that one command. It adds no lockout and does not extend the 30-minute instruction lease
  beyond its own ten seconds.
- **It changes nothing about the roast's end.** `end_reason` (`stopped`), recording closure, and
  archive semantics are unaffected; the tail is post-record, like the machine's own cooling.
- **Status stays honest**: during the tail the outputs report active while the roast reports
  inactive. Stopping a test, a calibration, or an idle machine earns no tail.
- **Automatic endings get no tail.** Completion, envelope timeout, and faults end without
  synthesized airflow, consistent with [Fault overrides](#fault-overrides) (an overtemperature trip
  runs its own cooldown instead); a profile that ends while
  heating should author its own cooling, and the browser's pre-start check warns when it does not.

### The runtime envelope

Journey zones advance **only on temperature attainment**, never on a clock. An unreachable endpoint
would therefore hold its zone, and renew Heat, forever. Browser feasibility preflight is advice,
not a boundary.

Every timed and journey roast carries an envelope of **2 × the plan's total nominal seconds + 600 s**
(`kRoastEnvelopeMarginSec = 600`), checked on every service pass and recomputed after every accepted
plan edit. Breaching it ends the roast with `end_reason: envelope_timeout` and Heat off. The bound is
a pure function of the accepted plan, which clients can read from `GET /api/roast/active-plan`.

This, not the instruction lease, is the real outer bound on a device-run program.

### Calibration start readiness

The thermocouple readiness gate is unrelated to Heat-off behavior. `POST /api/calibration/start`
requires one fresh, valid, fault-free thermocouple reading. It imposes no starting-temperature cap
or stability timer: the first programmed destination hold is itself a measured transition and the
ordinary actuator overtemperature and sensor-fault protections remain in force throughout the pass.

### Coefficient plausibility

Stored thermal-model coefficients are **not used for control by the firmware**, but a journey roast
inverts them, and a model with no heater authority inverts into max-heat saturation at the zone
maximum. `present` alone cannot catch that, so `plausibleCalibration` requires:

| Coefficient | Accepted range |
| --- | --- |
| `heater_gain` | 0.1 – 500 |
| `fan_cooling` | 0.5 – 200 |
| `cooling_fan` | 1 – 300 |
| `loss_per_min` | 0.005 – 2 |

Enforced in **three** places: at `POST /api/calibration/apply` (`400`), at **NVS load** (an
implausible stored set, including one written by an older image, reads as *absent*), and at journey
start (`409`). Heater gain is coupled to thermal loss, and their ratio determines steady-state
authority; its 0.1 floor matches the journey solver's numerical authority floor rather than
inventing a separate 5 °C/min physical threshold. The ranges reject zeros, garbage, and sign errors.
The Crackle client mirrors the same ranges before sending.

### Sensor-lost handling in a running roast

A roast treats a thermocouple sample older than **900 ms** (`kRoastSampleFreshnessMs`) as not a
measurement. That sits deliberately **below** the actuator's own 1 s thermal-safety freshness: if the
roast still called a sample fresh after the actuator had stopped doing so, every Heat request in that
window would be rejected as stale telemetry and a recoverable poll hiccup would end the roast.
Holding over first keeps the two gates in the right order.

Under holdover the control step applies **zero correction**, freezes the integral exactly as it was,
leaves the rate-feedback sample history untouched (a gap longer than 15 s empties it, so no trend is
invented across a dropout), and solves feed-forward against the **plan's** temperature rather than
the last good reading. Substituting the last reading is rejected: a stale temperature drives a
confident and increasingly wrong correction for exactly as long as the dropout lasts.

After **30 continuous seconds** (`kRoastHoldoverLimitMs`) the probe is gone: `end_reason:
sensor_lost`. Heat stops by lease non-renewal; any continuing Fan-only command is explicit workflow
intent.

Independently of any of this, the actuator core's own thermal gate removes Heat when telemetry goes
stale or faulted. It does not create a post-Heat Fan override.

### Flash writes only while the actuator is idle

**Any flash write (a LittleFS persist, a file delete, a rename, an NVS put) suspends the instruction
cache and stalls the MCPWM capture callbacks**, exactly like the blackouts that motivate the coast
policy. A ~58 ms stall is observed in practice.

So every flash write on this device waits for `actuatorFullyIdle()`: no fan test, no heater proof, no
calibration, no manual session, no roast, no finishing watcher, and no live outputs.

- Recording persists run either **immediately before the next actuation episode's request is issued**
  (outputs still idle) or from an idle watcher after 3 minutes of quiet.
- Log deletes, log restores, volume format, document writes, document deletes, and NVS coefficient
  writes all refuse with `409` while an actuator-owning workflow runs or outputs are live.
- **Immutable stored reads are always allowed.** A browser can list, fetch, and render documents and
  finalized archives mid-roast; only committing bytes waits. The current-RAM `/thermal.csv` serves a
  consistent, fenced prefix of the in-progress recording without any flash write.

**The ordering `finalize → request`, never `request → persist`, is load-bearing.** A persist placed
after `actuator.request()` would black out the capture callbacks during fan qualification and fail
the very episode it was making room for.

A meaningful finished recording wins over starting another recordable episode. Firmware first
attempts an idle persist; if the archive remains unsaved, new fan tests, heater proofs, calibrations,
manual sessions, and roasts are refused so the RAM evidence is not overwritten. Stop and Heat-off
remain unconditional and never pass through this storage gate. Failed persists retain the RAM copy
and retry on a bounded backoff; attempt telemetry caps at three. `log_archive.lost_logs` increments
only if a future caller violates this contract and overwrites meaningful unsaved evidence, so such a
regression cannot be lost quietly.

## Firmware tests

1. Request Heat `0.1` from fan-off and prove no heater trigger occurs before 500 ms.
2. Request Heat `10.0` / Fan `0.1` and prove the captured Fan-1 endpoint is accepted after qualification.
3. Interrupt fan command during pre-run and prove the 500 ms timer resets.
4. From Fan `4` / Heat `1`, request Fan `4` / Heat `0` and verify Fan remains `4`; request Fan
   `0` / Heat `0` and verify both outputs stop immediately with no cooling debt or action blocker.
5. Prove later Fan or Heat-off commands cannot create or restart a post-Heat timer.
6. Disconnect the browser after Heat-off and verify no hidden output change occurs.
7. Re-enable Heat and verify the ordinary 500 ms Fan qualification still applies.
8. Trigger each fault class and prove heater-off/fan-safe behavior.
9. Hold a manual session with no further commands and verify it stops itself at 30 minutes with
   `end_reason: instruction_expired` and both outputs off.
10. Start a journey with an unreachable final endpoint and verify `envelope_timeout` at
    `2 × nominal + 600 s`.

Items 1–8 are covered by `crackle/tests/actuator_safety_test.cpp` against the production actuator
source; the zero-cross observation policy is pinned by `crackle/tests/zero_cross_qualifier_test.cpp`.
Items 9 and 10 are device-level behaviors of the layers above the core.
