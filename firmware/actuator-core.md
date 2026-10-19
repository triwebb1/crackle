# Actuator core

`sr800_actuator.h/.cpp` is the reusable real-time boundary between roast-program logic and the
installed fan/heater interface. Web handlers and the profile runner request intent; only the actuator
core may translate that intent into GPIO commands. The full safety envelope, including the rules
enforced above this boundary, is in [`safety-policy.md`](safety-policy.md).

## Public contract

```cpp
bool request(uint32_t fanMilli, uint32_t heatMilli,
             uint32_t nowUs, const char*& rejection,
             uint32_t heatRunLimitUs = 0);
void stop(uint32_t nowUs);
void service(uint32_t nowUs);
void updateThermalSafety(ThermalSafetyStatus status, uint32_t nowUs);
bool clearThermalStaleFault(uint32_t nowUs);
void onZeroCross(uint32_t nowUs);
void onZeroCrossDiscontinuity(uint32_t nowUs);
void latchManualConflict();
void latchPulseSchedulerFailure();
ActuatorSnapshot snapshot(uint32_t nowUs) const;
bool outputsActive() const;
```

Levels use fixed-point thousandths: `0` is off, `100` is public `0.1`, and `10000` is public `10.0`.
The profile runner must call `request`; it must not write GPIO3 or GPIO4, calculate phase delays, or
reproduce safety policy. `clearThermalStaleFault` clears only the recoverable controller-telemetry
lapse: the caller must first abort its active operation, and the core additionally requires fresh
`HEALTHY` telemetry, so it can never restart old Heat.

## Core-owned invariants

- Outputs initialize low.
- A valid recent zero-cross is required to begin actuation.
- Fan is established continuously for 500 ms before Heat can become effective.
- Positive Heat raises an insufficient Fan request to the required floor.
- Every positive Heat level requires at least the captured factory Fan-1 endpoint, public Fan `0.1`.
- Removing effective Heat creates no actuator cooling debt. Heat turns off immediately and Fan follows
  the current request, including Fan `0`; process cooling exists only when a workflow requests it.
- Stop removes Heat immediately.
- Factory fan activity and zero-cross loss latch outputs off and reject later requests until restart.
- Requested and effective levels remain separate and observable.

The universal rule that Heat on requires Fan `1.0` or higher is enforced at the command layer above
this boundary; the core's `0.1` floor is the audited backstop beneath it.

## Mapping

Fan uses phase-power interpolation between reconstructed factory Fan 1 and the acoustically capped
factory Fan 9 match. The startup delay ramps to its settled delay over 500 ms.

Heat uses phase-power interpolation between the captured factory Power 1 delay (`2820 us`) and
factory Power 9 delay (`800 us`). Public Heat `0.1` and `10.0` are those endpoints. Intermediate
values target a linear fraction of estimated delivered resistive power, not linear temperature rise.

All PC817 LED commands are `100 us`. The command pulse width is separate from the firing delay and
therefore does not encode requested output level.

## State model

`IDLE -> FAN_STARTUP -> FAN_ONLY / HEATING -> IDLE`

`ZERO_CROSS_WAIT` holds a retained request while zero-cross timing is lost: outputs are parked low,
logical Heat is cleared, and Heat cannot resume until returning timing re-establishes 500 ms of
qualified Fan airflow.

`MANUAL_CONFLICT`, `ZERO_CROSS_LOST`, `PULSE_SCHEDULER_FAILURE`, `THERMAL_SENSOR`, and
`OVERTEMPERATURE` move the core to a reboot-only `FAULT` and stop both outputs. `THERMAL_STALE`
also stops both outputs, but has a guarded clear after fresh healthy telemetry and an idle owner.
No fault path creates cooling debt.

## Timing backend

`onZeroCross()` is called from the MCPWM zero-cross capture callback and delegates each half-cycle's
plan to a single 1 MHz MCPWM timer with independent Fan and Heater operators. Shadow compare values
commit atomically at the next hardware sync, and the hardware, not an ISR, raises and lowers each
`100 us` pulse; software observes rather than times the outputs. The timer's 12 ms fail-low period
parks both outputs if synchronization disappears. Cancellation forces both generators low and clears
the staged plan; any scheduler setup failure latches `PULSE_SCHEDULER_FAILURE`.

The scheduler keeps a 4,000-record phase-timing log. After actuation completes, `/timing.csv`
exports it per pulse: channel, planned and hardware-captured actual delay, lateness, pulse width, and
outcome (emitted, emitted late, or missed), which is the basis of the dual-channel capture audit.

## Verification

The waveform mapping and MCPWM fail-low backend are the hardware-audited design. The policy layer on
top of them (the minimum Fan floor, no post-Heat hold, 500 ms requalification after a real timing
outage, and the split between a controller-telemetry lapse and a qualified sensor failure) is
specified in [`safety-policy.md`](safety-policy.md). The roast executor, document store, archive, and
instruction lease all use this boundary rather than writing outputs directly.

`crackle/tests/actuator_safety_test.cpp` compiles the production actuator source against small host
fakes. It covers fan qualification, continuous Heat mapping, endpoint timing, immediate Heat-off
without cooling debt, Fan-1 minimum clamping, manual conflict, zero-cross suspend/resume and the
250 ms Heat grace, post-outage requalification, long outages, ordinary `micros()` wrap, renewable Heat
leases expiring in the zero-cross path, distinct stale-telemetry recovery and qualified sensor
latching, scheduler delegation, and scheduler-failure latching.
`crackle/tests/zero_cross_qualifier_test.cpp` pins the chatter-tolerant observation policy
(interval-only classification, ignored sub-6 ms noise, requalification), and
`crackle/tests/capture_time_test.cpp` pins capture-tick conversion. Build and test commands are in
[`crackle/README.md`](crackle/README.md#host-tests).
