# Power-Stage Transition: Fan 9 / Power 9, Run To Cooling To On/Off

## Conditions

- Firmware: `2026-07-24.4`
- Initial setting: Fan 9 / Power 9
- Sequence: Clear and arm; Run; approximately four seconds; Run/Cool; approximately four seconds; On/Off; manual Freeze
- CSV span: 10.719364 s from first captured trigger
- Captured events: 3,626 of 4,096

## Definitive Channel Assignment

U3B pin 11 / CH0 / GPIO3 is the heater command.
U3B pin 12 / CH1 / GPIO4 is the fan command.

The final pin-11 heater pulse falls at 6.458181 s. Pin 12 continues firing on
the next half-cycle and throughout the remaining 4.261183 s. This exactly
matches the observed Cooling behavior: heater zero, fan retained at the
displayed setting.

## Transition Behavior

There is no deliberate quiet interval between Heating and Cooling. The heater
simply receives no further trigger after 6.458181 s; the fan pulse train
continues immediately.

| Segment | Pin 11 heater | Pin 12 fan |
| --- | --- | --- |
| Heating | Active every available mains half-cycle | Active every available mains half-cycle |
| Cooling | Off | Active every available mains half-cycle |

Median pulse width changes from approximately 11 us during Heating to 9 us for
the surviving fan command during Cooling. This is probably PIC instruction or
scheduling detail rather than a different fan setting, because the physical fan
setting remains 9 and the cadence is retained.

The CSV ends while pin 12 is still active. The On/Off press therefore does not
establish a fan-off edge in this recording. Either On/Off does not cancel an
active Cooling cycle, or Freeze followed before a response was captured. No
additional capture is needed for load-channel identification.

## Phase-Control Interpretation

The measured `pin12 - pin11` interval is not the reference used by the power
stage. Both outputs are independently delayed from the then-unseen AC zero crossing.
The relative interval is only what can be calculated with the current probe
set.

A short gate pulse turns on a triac or related device for the remainder of the
current AC half-cycle. The device turns off naturally at the next current zero
crossing. Earlier trigger delay passes more of the sine wave and later delay
passes less. The approximately constant 9-13 us pulse widths are therefore
gate commands; their absolute timing from zero crossing sets fan or heater
power.

## Later Resolution

A subsequent idle candidate capture identifies U3B pin 17 as the continuous
zero-cross reference. New endpoint captures with pin 17 in the same event stream
will provide the absolute firing angles that this fixture could not measure.

## Source Integrity

SHA-256:
`7CCD43DD45759003F35E4E642238AB0750D446728E58F6F63AD43414BDBB9C7F`

