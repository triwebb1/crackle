"""Journey progress is REPORTED every tick, not merely executed.

The failure mode this guards against: the journey executor runs the whole plan
correctly while every progress field a browser renders - elapsed, zone, zone
entry, target, attainments - stays frozen at its start value, because the
per-tick executor outputs never reach the status payloads and browsers defer
the full status document for as long as anything actuates. The class of bug
this pins: the executor advances, the report does not.

Three links make the chain, and each is asserted separately so a break names
itself: the journey service writes its per-tick outputs to the executor
globals; the publisher copies those same globals - not a cache - into the
immutable snapshot on every loop pass; and both payload builders emit every
field of the tuple from that snapshot.
"""
from pathlib import Path

ROOT = Path(__file__).parent.parent
FIRMWARE = (ROOT / "crackle" / "crackle.ino").read_text(encoding="utf-8")

service = FIRMWARE[
    FIRMWARE.index("void serviceJourneyRoast"):
    FIRMWARE.index("void serviceDiagnosticTests")
]
publisher = FIRMWARE[
    FIRMWARE.index("void publishNetworkSnapshot"):
    FIRMWARE.index("LiveStatusSnapshot copyLiveStatusSnapshot")
]
live_builder = FIRMWARE[
    FIRMWARE.index("size_t buildLiveStatusJson"):
    FIRMWARE.index("size_t buildControllerStatusJson")
]
status_builder = FIRMWARE[
    FIRMWARE.index("size_t buildControllerStatusJson"):
    FIRMWARE.index("bool startCrackleHttpServer")
]
loop_body = FIRMWARE[
    FIRMWARE.index("void loop()"):
]

# 1. The journey service writes every per-tick executor output each tick.
for write in (
    "roastElapsedSec =",
    "roastControlState = step.state;",
    "roastTargetC = step.command.goalC;",
    "roastCorrectionTotal = step.correction.totalRatePerMin;",
    "roastIntegral = step.correction.integralRatePerMin;",
    "roastHoldover = step.correction.holdover;",
    "roastCommandFan = step.command.fan;",
    "roastCommandHeat = step.command.heat;",
    "roastZoneAttainedSec[index] = attainedAt;",
):
    assert write in service, write

# 2. The publisher copies the executor's own state - zone index and entry are
#    read from `roastControlState`, the exact struct the control law advances,
#    so a moved executor is reported on the very next publication.
assert "roastControlState.zoneIndex" in publisher
assert "roastControlState.zoneEntrySec" in publisher
for copy in (
    "next.roastElapsedSec",
    "next.roastZoneIndex",
    "next.roastZoneCount",
    "next.roastTargetC",
    "next.roastZoneEntrySec",
    "next.roastZoneNominalSec",
    "next.roastZoneEndC",
    "next.roastCorrectionTotal",
    "next.roastIntegral",
    "next.roastSolvedFan",
    "next.roastSolvedHeat",
    "next.roastHoldoverMs",
    "next.roastZoneAttainedSec[index] = roastZoneAttainedSec[index];",
    "next.roastEndReason",
):
    assert copy in publisher, copy

# 3a. The compact live stream - the ONLY status transport while a roast runs -
#     carries the whole tuple, atomically with the zone index it belongs to.
for field in (
    '\\"roast_elapsed_s\\":',
    '\\"roast_zone\\":',
    '\\"roast_zones\\":',
    '\\"roast_target_c\\":',
    '\\"roast_zone_entry_s\\":',
    '\\"roast_zone_nominal_s\\":',
    '\\"roast_zone_end_c\\":',
    '\\"roast_correction\\":',
    '\\"roast_integral\\":',
    '\\"roast_solved_fan\\":',
    '\\"roast_solved_heat\\":',
    '\\"roast_holdover_ms\\":',
    '\\"roast_end\\":',
    '"],\\"roast_zones_done\\":["',
):
    assert field in live_builder, field

# 3b. The full status document's roast block reports the same tuple for the
#     idle poll that follows the roast (score, import, reconciliation).
for field in (
    '"zone_entry_sec":%lu',
    '"zone_elapsed_sec":%lu',
    '"zone_nominal_sec":%lu',
    '"zone_end_c":%s',
    '"solved_fan":%s',
    '"solved_heat":%s',
    '"correction_total":%s',
    '"integral":%s',
    '"holdover_ms":%lu',
    '"holdover_limit_ms":%lu',
    '"end_reason":"%s"',
    '"zone_attained_sec":[',
):
    assert field in status_builder, field

# Null discipline: journey-only values are null in every other mode, and an
# unattained zone is null, never zero.
assert 'strcpy(roastZoneEnd, "null");' in live_builder
assert 'strcpy(roastCorrection, "null");' in live_builder
assert 'strcpy(roastZoneEnd, "null");' in status_builder
assert "kRoastZoneNotAttained" in live_builder
assert "kRoastZoneNotAttained" in status_builder

# 4. The publisher runs unconditionally in loop(), after the executor tick, so
#    there is no path on which the executor advances and the report does not.
assert loop_body.index("serviceDiagnosticTests(micros());") < \
    loop_body.index("publishNetworkSnapshot();")

print("journey status reporting contract: PASS")
