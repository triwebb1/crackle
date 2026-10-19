"""Source contracts for pre-actuation logging and terminal failure cleanup."""

from pathlib import Path
import unittest


SOURCE = (Path(__file__).parents[1] / "crackle" / "crackle.ino").read_text(encoding="utf-8")


def between(start: str, end: str) -> str:
    begin = SOURCE.index(start)
    finish = SOURCE.index(end, begin)
    return SOURCE[begin:finish]


class ActuationStartFailureContract(unittest.TestCase):
    def test_first_commands_wait_for_timing_after_idle_storage_work(self) -> None:
        helper = between("bool waitForActuationStartTiming(",
                         "void exitActuationWifiAwakeMode()")
        self.assertIn("schedulerState.zeroCrossQualified", helper)
        self.assertIn("actuatorState.lastZeroCrossAgeUs <= kZeroCrossTimeoutUs", helper)
        self.assertIn("kActuationStartTimingWaitMs", helper)
        self.assertIn("delay(1);", helper)

        starts = (
            (between("bool startFanTest(", "bool startHeaterProof("),
             "takeOverPriorRecordingForNewEpisode("),
            (between("bool startHeaterProof(", "bool startCalibration("),
             "startThermalLog(ThermalLogSource::PROOF)"),
            (between("bool startCalibration(", "// The program is over."),
             "startThermalLog(ThermalLogSource::CALIBRATION)"),
            (between("bool startRoast(", "void logArchivePath"),
             "persistProvisionalRoastArchive()"),
            (between("    const bool wasActive = manualActive;",
                     "    manualActive = true;"),
             "takeOverPriorRecordingForNewEpisode("),
        )
        for body, preparation in starts:
            self.assertIn("waitForActuationStartTiming(", body)
            self.assertLess(body.index(preparation),
                            body.index("waitForActuationStartTiming("))
            self.assertLess(body.index("waitForActuationStartTiming("),
                            body.index("actuator.request("))

    def assert_log_precedes_request(self, body: str, source: str) -> None:
        start = f"startThermalLog(ThermalLogSource::{source})"
        request = "actuator.request("
        self.assertIn(start, body)
        self.assertLess(body.index(start), body.index(request))
        self.assertNotIn(start, body[body.index(request):])

    def test_heater_proof_reserves_log_before_request_and_rolls_back(self) -> None:
        body = between("bool startHeaterProof(", "bool startCalibration(")
        self.assert_log_precedes_request(body, "PROOF")
        self.assertGreaterEqual(body.count("rollbackThermalLogStart();"), 2)

    def test_calibration_reserves_stable_log_before_request_and_rolls_back(self) -> None:
        body = between("bool startCalibration(", "// The program is over.")
        self.assert_log_precedes_request(body, "CALIBRATION")
        self.assertLess(body.index("calibrationStableLogId = thermalLogReservedId;"),
                        body.index("actuator.request("))
        self.assertGreaterEqual(body.count("rollbackThermalLogStart();"), 2)
        self.assertEqual(body.count("calibrationStableLogId = 0;"), 3)

    def test_roast_start_failure_uses_the_mux_owned_rollback(self) -> None:
        body = between("bool startRoast(", "void logArchivePath")
        self.assertEqual(body.count("rollbackThermalLogStart();"), 3)
        for direct_reset in (
            "thermalLogActive = false;", "thermalLogUnsaved = false;",
            "thermalLogCount = 0;", "thermalLogReservedId = 0;",
            "thermalLogSource = ThermalLogSource::NONE;",
        ):
            self.assertNotIn(direct_reset, body)

    def test_manual_controls_finalize_prior_evidence_without_starting_a_recording(self) -> None:
        body = between("    const bool wasActive = manualActive;",
                       "    manualActive = true;")
        self.assertIn("takeOverPriorRecordingForNewEpisode(takeOverRejection)", body)
        # The manual instruction stands the post-stop tail down BEFORE the
        # prior recording is handed off, so the idle gate can pass.
        self.assertLess(body.index("preemptPostStopCoolingTail(micros());"),
                        body.index("takeOverPriorRecordingForNewEpisode(takeOverRejection)"))
        self.assertLess(body.index("takeOverPriorRecordingForNewEpisode(takeOverRejection)"),
                        body.index("actuator.request("))
        self.assertNotIn("startThermalLog(", body)
        self.assertNotIn("rollbackThermalLogStart()", body)

    def test_rollback_abandons_only_the_volatile_episode(self) -> None:
        body = between("void rollbackThermalLogStart()",
                       "// Defined with the archive code below;")
        for reset in (
            "thermalLogCount = 0;", "thermalLogActive = false;",
            "thermalLogSource = ThermalLogSource::NONE;",
            "thermalLogUnsaved = false;", "thermalLogReservedId = 0;",
        ):
            self.assertIn(reset, body)
        self.assertNotIn("Preferences", body)
        self.assertNotIn("LittleFS", body)

    def test_ota_abort_requests_controller_owned_release(self) -> None:
        failure = between("void resetFailedOtaAttempt(",
                          "esp_err_t failOtaUpload(")
        admission = between("void serviceOtaAdmission()",
                            "esp_err_t sendOtaJson(")
        self.assertIn("esp_ota_abort(otaHandle);", failure)
        self.assertIn("requestOtaRelease();", failure)
        self.assertNotIn("attachSignalInterrupts();", failure)
        release = admission[admission.index("OtaAdmissionState::RELEASE_REQUESTED"):]
        self.assertIn("attachSignalInterrupts();", release)

    def test_hard_fault_ends_active_calibration(self) -> None:
        body = between("if (state.fault != sr800::ActuatorFault::NONE",
                       "if (heaterProofPhase == HeaterProofPhase::FAN_QUALIFICATION")
        self.assertIn("if (calibrationActive)", body)


if __name__ == "__main__":
    unittest.main()
