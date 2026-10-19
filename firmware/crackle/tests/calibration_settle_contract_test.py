from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "crackle"
source = (ROOT / "crackle.ino").read_text(encoding="utf-8")

required = {
    '#include "sr800_calibration_settle.h"': "the firmware compiles the tested detector",
    "constexpr uint32_t kCalibrationStepDefaultS = 300;": "the default step cap is 300 seconds",
    "constexpr uint32_t kCalibrationMinDwellDefaultS = 20;": "the default minimum dwell is 20 seconds",
    "constexpr uint8_t kCalibrationSettleSecondsDefault = 20;": "the default settle window is 20 seconds",
    "constexpr float kCalibrationSettleBandDefaultC = 0.2f;": "the default settle band is 0.2 C",
    "calibrationSettleDetector.reset(": "each command starts with no prior transition evidence",
    "calibrationSettleDetector.observe(maxThermocoupleC);": "valid program samples feed the detector",
    '"waiting_for_transition"': "status distinguishes dead time from plateau checking",
    'R"json(%s{"index":%u,"fan":%.1f,"heat":%.1f,"elapsed_sec":%u,"temperature_c":%s,"outcome":"%s"})json"': "completed-step status carries the corrected temperature",
}

for needle, explanation in required.items():
    assert needle in source, explanation

assert "calibrationSettleRing" not in source, "the dead-time-prone inline range detector must stay removed"
print("calibration settle contract: all checks passed")
