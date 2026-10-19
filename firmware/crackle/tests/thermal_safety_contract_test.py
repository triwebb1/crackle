"""Narrow source contracts for Heat-off behavior and sensor qualification."""

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
ACTUATOR = (ROOT / "crackle" / "sr800_actuator.cpp").read_text(encoding="utf-8")
ACTUATOR_HEADER = (ROOT / "crackle" / "sr800_actuator.h").read_text(encoding="utf-8")
FIRMWARE = (ROOT / "crackle" / "crackle.ino").read_text(encoding="utf-8")
WEB_PAGE = (ROOT / "crackle" / "sr800_web_pages.h").read_text(encoding="utf-8")


class ThermalSafetyContractTest(unittest.TestCase):
    def test_heat_off_has_no_mandatory_cooling_debt(self) -> None:
        # The safety policy forbids mandatory post-Heat cooling. These are the names a cooling-debt
        # mechanism in the actuator core would need, so their absence keeps one from returning.
        for obsolete in (
            "kPostHeatFanHoldMs", "beginCoolingObligation",
            "coolingRemainingUs_", "coolingFanFloorMilli_",
            "coolingDurationUs_", "coolingLastAccountedUs_",
            "coolingRemainingMs", "coolingFanFloorMilli",
            "coolingDurationMs", "coolingElapsedMs",
            "ActuatorMode::COOLING", "stopHeatForCooling",
        ):
            self.assertNotIn(obsolete, ACTUATOR_HEADER)
            self.assertNotIn(obsolete, ACTUATOR)

    def test_every_stop_ends_the_overtemperature_cooldown(self) -> None:
        # Every Stop route runs stopDiagnosticTest; Stop must mean all outputs off, cooldown included.
        stop = FIRMWARE[FIRMWARE.index("bool stopDiagnosticTest() {") :]
        stop = stop[: stop.index("\n}\n")]
        self.assertIn("actuator.cancelOvertempCooldown(", stop)
        # The cooldown belongs to the core, so ordinary workflow stops cannot end it.
        self.assertNotIn("cancelOvertempCooldown", ACTUATOR[ACTUATOR.index("void Actuator::stop(") :][:600])

    def test_calibration_readiness_is_a_separate_start_gate(self) -> None:
        start_gate = FIRMWARE[FIRMWARE.index("if (anyHeat)") :]
        self.assertIn("calibrationReadiness.ready(readinessNowMs)", start_gate)
        self.assertIn("maxSensorFaultQualifier.qualified()", start_gate)
        self.assertIn("sensor_fault_latched", start_gate)
    def test_heat_start_uses_one_named_fresh_probe_gate(self) -> None:
        self.assertIn("bool thermocoupleFreshValid", FIRMWARE)
        self.assertIn("bool heatStartTemperatureHealthy", FIRMWARE)
        self.assertGreaterEqual(FIRMWARE.count("heatStartTemperatureHealthy(millis())"), 4)
        self.assertIn('"open_circuit"', FIRMWARE)
        status = FIRMWARE[FIRMWARE.index("size_t buildControllerStatusJson") :]
        self.assertIn('"fault_reasons"', status)


    def test_stale_controller_telemetry_is_recoverable_not_a_sensor_latch(self) -> None:
        self.assertIn("THERMAL_STALE", ACTUATOR_HEADER)
        self.assertIn("ActuatorFault::THERMAL_STALE", ACTUATOR)
        self.assertIn('case ActuatorFault::THERMAL_STALE: return "thermal_stale"', ACTUATOR)
        self.assertIn("clearThermalStaleFault", ACTUATOR_HEADER)
        clear = ACTUATOR[ACTUATOR.index("bool Actuator::clearThermalStaleFault") :]
        clear = clear[: clear.index("void Actuator::forceOutputsLow")]
        self.assertIn("thermalSafetyStatus_ == ThermalSafetyStatus::HEALTHY", clear)
        self.assertIn("requestedHeatMilli_ == 0", clear)
        self.assertIn('"telemetry_stale"', FIRMWARE)

    def test_legacy_page_does_not_demand_power_cycle_for_stale_telemetry(self) -> None:
        self.assertIn("fault==='thermal_stale'", WEB_PAGE)
        self.assertIn("controls return after fresh telemetry", WEB_PAGE)


    def test_global_stop_is_immediate(self) -> None:
        mailbox = FIRMWARE[FIRMWARE.index("void serviceNetworkCommandMailbox()") :]
        route = mailbox[mailbox.index('strcmp(command.uri, "/api/stop")') :]
        route = route[: route.index('strcmp(command.uri, "/api/clear")')]
        stop = FIRMWARE[FIRMWARE.index("bool stopDiagnosticTest()") :]
        stop = stop[: stop.index("bool startFanTest")]
        self.assertIn('finishStopped("all")', route)
        self.assertIn("actuator.stop(micros());", stop)
        self.assertNotIn("cooling_active", route)

    def test_heat_on_fan_floor_is_a_command_layer_rule(self) -> None:
        # Design rule: if Heat is on, Fan must be 1.0 or higher on every
        # command path. The rule lives at the command layer; the audited
        # actuator core keeps its own 0.1-with-heat qualification unchanged.
        self.assertIn("constexpr uint32_t kHeatOnFanMinimumMilli = 1000;", FIRMWARE)
        self.assertIn("uint32_t heatOnFanFloorMilli(uint32_t fanMilli, uint32_t heatMilli)", FIRMWARE)
        # Every pair-forming command path applies the lift.
        self.assertGreaterEqual(FIRMWARE.count("heatOnFanFloorMilli("), 9)
        for section_start, section_end in (
            ("bool parseRoastStepsArg", "bool parseZoneNumber"),
            ("bool parseStepPairsArg", "bool parseHeatLevelsArg"),
            ("void handleRoastSet()", "void handleWifiConfiguration"),
            ("void handleCalibrationStart()", "void handleCalibrationStop()"),
            ("void serviceJourneyRoast", "void serviceDiagnosticTests"),
        ):
            begin = FIRMWARE.index(section_start)
            section = FIRMWARE[begin:FIRMWARE.index(section_end, begin)]
            self.assertIn("heatOnFanFloorMilli(", section, section_start)
        # The actuator core does not carry the rule.
        self.assertNotIn("kHeatOnFanMinimumMilli", ACTUATOR)
        self.assertNotIn("kHeatOnFanMinimumMilli", ACTUATOR_HEADER)
        self.assertNotIn("heatOnFanFloorMilli", ACTUATOR)
        # The journey control law mirrors the same floor for its solve fold-back.
        journey_header = (ROOT / "crackle" / "sr800_journey_control.h").read_text(encoding="utf-8")
        self.assertIn("constexpr double kHeatOnMinimumFan = 1.0;", journey_header)


if __name__ == "__main__":
    unittest.main()