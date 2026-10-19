# Minimal Power-Stage Capture Plan

## Existing fixture

`sr800-power-stage-capture-turn-on-fan1-power1.csv` is the stable minimum
fixture. U3B pins 11 and 12 both produce narrow, mains-synchronized pulses;
pins 8 and 9 remain high.

Only two more captures are required unless their comparison is ambiguous.

## Capture 1: Fan Maximum Plus Start And Stop

Filename:

`sr800-power-stage-capture-start-run-cool-fan9-power1.csv`

Procedure:

1. Set the factory controls to Fan 9, Power 1, with enough Timer to avoid a
   natural transition.
2. Leave the roaster powered but not running.
3. Press **Clear & arm** on the sniffer page.
4. Press the factory **Run/Cool** button to start.
5. Let it run for about four seconds.
6. Press **Run/Cool** again to enter Cooling.
7. Wait about two seconds, press **Freeze**, and download the CSV.
8. Leave the roaster in Cooling.

This one file provides:

- Idle-to-run startup ordering.
- Fan 9 / Power 1 steady behavior.
- The Fan 1-to-9 comparison needed to identify the fan channel.
- Run-to-Cooling behavior, including immediate heater cutout and the cooling
  fan command.
- Any transition activity on pins 8 and 9.

The existing 4,096-event buffer should hold this interval. If it unexpectedly
reaches `event_limit` before the second Run/Cool press, split startup and stop
into separate captures; do not otherwise repeat it.

## Capture 2: Heater Maximum

Filename:

`sr800-power-stage-capture-run-fan9-power9.csv`

Procedure:

1. Set Fan 9 and Power 9.
2. Start the roaster and wait about one second for startup to settle.
3. Press **Clear & arm**.
4. Capture four seconds of steady running.
5. Press **Freeze** and download the CSV.
6. Immediately press the factory **Run/Cool** button and leave the roaster in
   Cooling.

Comparison of Capture 2 with the Fan 9 / Power 1 portion of Capture 1 identifies
the heater channel and its minimum-versus-maximum encoding.

## Analysis From The Three Fixtures

For each active channel, calculate:

- Pulse width minimum, median, maximum, and useful percentiles.
- Same-channel interval distribution and skipped mains opportunities.
- Pulse density per second.
- Relative timing between pins 11 and 12.
- Startup lead/lag and any staged fan startup pattern.
- Heater stop timing and fan behavior after entry to Cooling.
- Any state change on pins 8 or 9.

Pulse width alone is unlikely to encode output level; the observed pulses look
like trigger pulses. Phase and skipped-cycle patterns are the important
comparisons.

## Optional Only If Needed

Do not collect midpoint levels, every integer setting, natural timer expiry, or
Cooling completion unless the three fixtures leave a specific unanswered
question. If endpoint encoding is nonlinear or ambiguous, the first additional
fixtures are Fan 5 / Power 1 and Fan 9 / Power 5.

## Capture Safety

- Do not change wiring while mains is connected.
- During powered tests, run the ESP32 only from its isolated battery.
- Keep USB, chargers, programmers, oscilloscopes, and grounded instruments
  disconnected.
- Never test high Power with low Fan.
## Completion Status

The active-run validation capture is complete. Pin 17 remained a clean,
alternating zero-cross reference while pin 11 heater and pin 12 fan triggers
followed it at tight, state-dependent delays through startup, Heating, and
Cooling.

No additional passive capture is required before the first bounded fan-only
test. That test must use an isolated command path and a hardware ownership
selector that disconnects the PIC from pin 12 before the ESP command is
connected. Pin 11 remains under Factory/off ownership.

Before the first heater-injection test, capture Fan 1 / Power 1 with pin 17 in
the same event stream to establish a conservative low-power heater delay.
Additional intermediate levels remain deferred until they answer a concrete
mapping or control question.
