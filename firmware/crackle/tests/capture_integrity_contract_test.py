"""Narrow source contract for the MAX31856 -> RAM log -> CSV capture boundary."""
from pathlib import Path

SOURCE = (Path(__file__).parents[1] / "crackle" / "crackle.ino").read_text(encoding="utf-8")

checks = {
    "thermocouple faults make TC missing": "sample.thermocoupleDeci = !valid",
    "CJ validity is independent and masks CJ-specific bits": "const bool coldJunctionValid = (maxFaultStatus & 0xB0U) == 0",
    "CJ faults make only CJ missing": "sample.coldJunctionDeci = !coldJunctionValid",
    "RAM uses full-range deci degrees": "lroundf(maxThermocoupleC * 10.0f)",
    "live RAM is encoded as already-quantized v4 data": "toCodecSample(thermalLog[index])",
    "TC and CJ CSV columns are formatted independently": "formatDeciColumn(coldJunction, sizeof(coldJunction),\n                   sample.coldJunctionValid, sample.coldJunctionDeci)",
}

missing = [label for label, fragment in checks.items() if fragment not in SOURCE]
if missing:
    raise SystemExit("capture integrity contract missing: " + "; ".join(missing))
calibration_start = SOURCE.index("bool startCalibration(")
calibration_end = SOURCE.index("bool finishRoast", calibration_start)
calibration_body = SOURCE[calibration_start:calibration_end]
if calibration_body.index("takeOverPriorRecordingForNewEpisode(rejection)") > calibration_body.index("captureCalibrationArchivePlan("):
    raise SystemExit("a new calibration plan must not relabel the prior unsaved episode")
if "toRawSample(thermalLog[index])" in SOURCE:
    raise SystemExit("live RAM must not be reinterpreted as legacy int16 centi-degree data")
print("capture integrity contract: all checks passed")
