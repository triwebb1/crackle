"""Source contract for fail-closed applied-calibration persistence.

Preferences/NVS is device-only, so this test pins the mutation ordering and
handler success boundary. Value validation remains exercised by firmware logic.
"""
from pathlib import Path

SOURCE = (
    Path(__file__).parent.parent / "crackle" / "crackle.ino"
).read_text(encoding="utf-8")


def section(start: str, end: str) -> str:
    left = SOURCE.index(start)
    right = SOURCE.index(end, left + len(start))
    return SOURCE[left:right]


reader = section(
    "bool readAppliedCalibration(AppliedCalibration& loaded)",
    "void adoptAppliedCalibration",
)
assert 'store.begin(kCalibrationNamespace, true)' in reader
for key in ("present", "gain", "fancool", "coolfan", "loss", "fitid", "epoch"):
    assert f'"{key}"' in reader, key

adopt = section("void adoptAppliedCalibration", "void loadAppliedCalibration")
assert "!loaded.present || !plausibleCalibration(loaded)" in adopt
assert "appliedCalibration = AppliedCalibration{}" in adopt
assert "appliedCalibration = loaded" in adopt

plausibility = section(
    "bool plausibleCalibration(const AppliedCalibration& cal)",
    "bool readAppliedCalibration",
)
assert "cal.heaterGain >= 0.1f" in plausibility
assert "cal.heaterGain >= 5.0f" not in plausibility

save = section(
    "bool saveAppliedCalibration(const AppliedCalibration& candidate)",
    "// The batch the stored coefficients describe.",
)
invalidate = save.index('store.putBool("present", false)')
clear_branch = save.index("if (!candidate.present)")
clear_verify = save.index("readAppliedCalibration(stored)")
gain = save.index('store.putFloat("gain"')
fan = save.index('store.putFloat("fancool"')
cooling = save.index('store.putFloat("coolfan"')
loss = save.index('store.putFloat("loss"')
fit_id = save.index('store.putString("fitid"')
epoch = save.index('store.putUInt("epoch"')
validate = save.index('store.putBool("present", true)')
verify = save.rindex("readAppliedCalibration(stored)")
exact = save.index("sameAppliedCalibration(stored, candidate)")
adopt_candidate = save.index("appliedCalibration = candidate")
assert invalidate < clear_branch < clear_verify < gain
assert gain < fan < cooling < loss < fit_id < epoch < validate
assert validate < verify < exact < adopt_candidate
assert save.count("== sizeof(") >= 6
assert "strlen(candidate.fitId)" in save
assert "if (!store.begin(kCalibrationNamespace, false)) return false" in save
assert "appliedCalibration = AppliedCalibration{}" in save
assert "True rollback of the prior calibration would require dual NVS slots" in save
same = section("bool sameAppliedCalibration", "bool saveAppliedCalibration")
for field in (
    "present",
    "heaterGain",
    "fanCooling",
    "coolingFan",
    "lossPerMin",
    "fitId",
    "appliedEpoch",
):
    assert field in same, field

handler = section("void handleCalibrationApply()", "// POST /api/roast/start")
assert "nvsMutationAllowed()" in handler
assert "appliedCalibration = next" not in handler
assert "appliedCalibration = AppliedCalibration{}" not in handler
clear_save = handler.index("saveAppliedCalibration(cleared)")
apply_save = handler.index("saveAppliedCalibration(next)")
first_revision = handler.index("advanceStateRevision()")
last_revision = handler.rindex("advanceStateRevision()")
assert clear_save < first_revision
assert apply_save < last_revision
assert handler.count("Calibration storage failed.") == 2

print("firmware applied calibration persistence contract: PASS")