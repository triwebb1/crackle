"""Source contracts for the recordable manual-roast Stop boundary."""
from pathlib import Path
import unittest

SOURCE = (Path(__file__).resolve().parents[1] / "crackle" / "crackle.ino").read_text(encoding="utf-8")
SERVER = (Path(__file__).resolve().parents[1] / "crackle" / "sr800_network_server.cpp").read_text(encoding="utf-8")


def section(start: str, end: str) -> str:
    begin = SOURCE.index(start)
    return SOURCE[begin:SOURCE.index(end, begin)]


class ManualRoastStopContract(unittest.TestCase):
    def test_manual_roast_closes_immediately_and_marks_archive_pending(self) -> None:
        finish = section("bool finishRoast(uint32_t nowUs, const char* endReason) {", "// TIMED:")
        self.assertLess(finish.index("markRoastEnded"), finish.index("actuator.stop"))
        self.assertLess(finish.index("actuator.stop"), finish.index("roastCommandHeatMilli = 0"))
        self.assertIn("return finalizeEndedRoastRecordingForStop()", finish)
        finalize = section("bool finalizeEndedRoastRecordingForStop() {", "// TIMED:")
        self.assertIn("if (!thermalLogUnsaved) {", finalize)
        self.assertIn("if (thermalLogSource != ThermalLogSource::ROAST) {", finalize)
        self.assertIn("portENTER_CRITICAL(&thermalLogMux)", finalize)
        self.assertIn("portEXIT_CRITICAL(&thermalLogMux)", finalize)
        self.assertLess(finalize.index("roastMode != RoastMode::MANUAL"), finalize.index("thermalLogPassiveTailComplete = true"))
        self.assertIn("thermalLogActive = false", finalize)
        self.assertNotIn("persistUnsavedThermalLog", finalize)
        self.assertTrue(finalize.rstrip().endswith("return false;\n}"))

    def test_controller_archive_service_owns_post_stop_commit(self) -> None:
        archive = section("void serviceThermalCaptureLifecycle", "// ---------------------------------------------------------------------------")
        self.assertIn("persistUnsavedThermalLog()", archive)
        self.assertIn("thermalLogUnsaved", archive)
        self.assertIn("StorageRequestGuard", archive)

    def test_stop_has_reserved_mailbox_and_reports_durability_truthfully(self) -> None:
        self.assertIn('registerRoute("/api/stop", HTTP_POST, queueStop)', SERVER)
        command = section("void serviceNetworkCommandMailbox()", "void setup()")
        shared = command[command.index('strcmp(command.uri, "/api/stop")'):command.index('strcmp(command.uri, "/api/clear")')]
        roast = command[command.index('strcmp(command.uri, "/api/roast/stop")'):command.index('strcmp(command.uri, "/api/roast/start")')]
        self.assertIn("finishStopped", shared)
        self.assertIn('finishRoast(micros(), "stopped")', roast)
        for body in (command[command.index("const auto finishStopped"):command.index("if (command.method", command.index("const auto finishStopped"))], roast):
            self.assertIn("recording_saved", body)
            self.assertIn("recording_pending", body)

    def test_zero_sample_terminal_roast_replaces_provisional_archive(self) -> None:
        meaningful = section("bool terminalRoastArchiveNeedsReplacement()", "void startThermalLog")
        persist = section("void persistUnsavedThermalLog(bool force = false)", "// A new actuation episode is beginning")
        self.assertIn("roastEndReasonCode(roastEndReason) != 0", meaningful)
        self.assertIn("roastArchivePlanValid", meaningful)
        self.assertIn("terminalRoastArchiveNeedsReplacement()", persist)
        self.assertIn("header.sampleCount = thermalLogCount", persist)

    def test_non_manual_recordings_keep_the_calibration_tail(self) -> None:
        archive = section("void serviceThermalCaptureLifecycle", "// ---------------------------------------------------------------------------")
        self.assertIn("nowMs - actuatorIdleSinceMs >= kLogIdleFinalizeMs", archive)
        self.assertIn("constexpr uint32_t kLogIdleFinalizeMs = 3U * 60U * 1000U", SOURCE)

    def test_post_stop_cooling_tail_follows_a_roast_interrupting_stop(self) -> None:
        # Requirement: a roast-ending Stop runs Fan 10 / Heat 0 for 10 seconds,
        # and the tail never blocks manual controls.
        self.assertIn("constexpr uint32_t kPostStopCoolingTailMs = 10000;", SOURCE)
        self.assertIn("constexpr uint32_t kPostStopCoolingFanMilli = 10000;", SOURCE)
        begin = section("void beginPostStopCoolingTail(uint32_t nowUs) {", "bool stopDiagnosticTest()")
        self.assertIn("actuator.request(kPostStopCoolingFanMilli, 0, micros(), rejection)", begin)
        # Only a Stop that interrupted an ACTIVE roast earns the tail; recording
        # closure and end_reason are unaffected by the tail.
        stop = section("bool stopDiagnosticTest()", "constexpr char kStorageBusyStartRejection")
        self.assertLess(stop.index("actuator.stop(micros());"), stop.index("releasePostStopCoolingTail();"))
        self.assertIn("if (roastWasActive) beginPostStopCoolingTail(micros());", stop)
        roast_stop = section('strcmp(command.uri, "/api/roast/stop")', 'strcmp(command.uri, "/api/roast/start")')
        self.assertIn("beginPostStopCoolingTail(micros());", roast_stop)
        self.assertIn("preemptPostStopCoolingTail(micros());", roast_stop)
        self.assertLess(roast_stop.index('finishRoast(micros(), "stopped")'), roast_stop.index("beginPostStopCoolingTail"))

    def test_cooling_tail_never_blocks_or_outlives_a_new_instruction(self) -> None:
        # Any newly accepted instruction preempts the tail immediately: every
        # program start, and the manual set acceptance, stand it down.
        for start in ("bool startFanTest", "bool startHeaterProof", "bool startCalibration", "bool startRoast"):
            begin = SOURCE.index(start)
            gate = SOURCE[begin:SOURCE.index("Another actuator operation is active", begin)]
            self.assertIn("preemptPostStopCoolingTail(micros());", gate, start)
        manual_set = section('strcmp(command.uri, "/api/manual/set")', 'strcmp(command.uri, "/api/roast/stop")')
        self.assertIn("releasePostStopCoolingTail();", manual_set)
        # The tail retires itself on its deadline, or the moment the outputs were
        # taken away by a fault or a successor — never by killing a successor.
        service = section("void serviceDiagnosticTests(uint32_t nowUs) {", "void detachSignalInterrupts()")
        self.assertIn("postStopCoolingActive &&", service)
        self.assertIn("!actuator.outputsActive()", service)
        # The tail is executor-authored: the audited actuator core knows nothing of it.
        actuator = (Path(__file__).resolve().parents[1] / "crackle" / "sr800_actuator.cpp").read_text(encoding="utf-8")
        self.assertNotIn("PostStopCooling", actuator)


class StopAndRecoveryContract(unittest.TestCase):
    def test_roast_stop_never_refuses_on_session_mismatch(self) -> None:
        roast_stop = section('strcmp(command.uri, "/api/roast/stop")', 'strcmp(command.uri, "/api/roast/start")')
        self.assertNotIn("response.status = 409", roast_stop)
        self.assertNotIn("expected_session must match the active roast.", roast_stop)
        self.assertIn('"session_mismatch":%s', roast_stop)
        self.assertIn("sessionMismatch ? \"true\" : \"false\"", roast_stop)
        self.assertIn('finishRoast(micros(), "stopped")', roast_stop)

    def test_transient_actuator_refusals_retry_within_a_bound(self) -> None:
        actuator = (Path(__file__).resolve().parents[1] / "crackle" / "sr800_actuator.cpp").read_text(encoding="utf-8")
        for text in ("Zero-cross timing is unavailable.", "Fresh fault-free thermocouple telemetry is required."):
            self.assertIn(text, actuator)
            self.assertIn(text, SOURCE)
        helper = section("bool transientActuatorRejection(const char* rejection) {", "void clearTransientRejection")
        self.assertIn("current.fault != sr800::ActuatorFault::NONE) return false;", helper)
        self.assertIn("sr800::ThermalSafetyStatus::UNKNOWN", helper)
        self.assertIn("constexpr uint32_t kTransientRejectionRetryMs = 2000;", SOURCE)
        journey = section("void serviceJourneyRoast(", "void serviceCalibrationStepRequest(")
        self.assertIn("!retryTransientRejection(roastRejectionRetry, rejection)", journey)
        timed = section("void serviceTimedRoast(", "// MANUAL ROAST:")
        self.assertLess(timed.index("retryTransientRejection(roastRejectionRetry, rejection)) return;"),
                        timed.index('finishRoast(nowUs, "step_rejected")'))
        service = section("void serviceDiagnosticTests(uint32_t nowUs) {", "void detachSignalInterrupts()")
        self.assertIn("retryTransientRejection(calibrationRejectionRetry,", service)
        self.assertIn("retryTransientRejection(manualRejectionRetry, rejection)", service)
        self.assertIn("actuator.service(micros());", service)
        self.assertNotIn("actuator.request(manualFanMilli, manualHeatMilli, nowUs", service)

    def test_heater_proof_cannot_wedge_in_qualification(self) -> None:
        service = section("void serviceDiagnosticTests(uint32_t nowUs) {", "void detachSignalInterrupts()")
        qualification = service[service.index("if (heaterProofPhase == HeaterProofPhase::FAN_QUALIFICATION) {"):service.index("} else if (heaterProofPhase == HeaterProofPhase::HEATING) {")]
        self.assertLess(qualification.index("if (actuationAbortFault) {"), qualification.index("state.effectiveHeatMilli > 0"))
        self.assertIn("heaterProofQualificationStartedUs", qualification)
        self.assertIn("kCalibrationQualifyStallUs", qualification)
        self.assertEqual(qualification.count("heaterProofPhase = HeaterProofPhase::IDLE;"), 2)

    def test_manual_roast_journal_never_gates_the_actuator(self) -> None:
        self.assertNotIn("maximum 32 accepted manual instructions", SOURCE)
        roast_set = section("void handleRoastSet() {", "void handleWifiConfiguration()")
        self.assertNotIn("canStageManualRoastArchiveChange", roast_set)
        self.assertLess(roast_set.index("actuator.request("), roast_set.index("roastArchiveJournalTruncated = true;"))
        self.assertNotIn("could not be archived, so Heat was stopped", roast_set)
        self.assertIn('journal_truncated', roast_set)

    def test_short_file_streams_never_end_cleanly(self) -> None:
        raw = section("void serveArchiveFileRaw(File& file, unsigned long logId) {", "void handleLogFetch()")
        self.assertIn("if (sentBytes != expectedBytes) {", raw)
        self.assertLess(raw.index("if (sentBytes != expectedBytes) {"),
                        raw.rindex("httpd_resp_send_chunk(nativeStorageRequest, nullptr, 0);"))
        self.assertEqual(raw.count("abortStorageStream();"), 2)
        doc = section("void serveStoredDocument(const char* path) {", "void storeDocumentRequest(")
        self.assertIn("abortStorageStream();", doc)
        # No cross-task session close (it is associated with task-watchdog resets); a short
        # stream is left unterminated instead, never ended cleanly.
        abort = section("void abortStorageStream() {", "void serveStoredDocument(")
        self.assertNotIn("httpd_sess_trigger_close", abort)

    def test_restore_cannot_target_the_live_recording_id(self) -> None:
        restore = section("void handleNativeLogRestore() {", "esp_err_t handleNativeStorageRequest(")
        self.assertIn("parsedId == recording.reservedId", restore)
        self.assertLess(restore.index("parsedId == recording.reservedId"), restore.index("clearLogRestoreUpload(true);"))

    def test_status_and_live_json_never_emit_non_finite_numbers(self) -> None:
        live = section("size_t buildLiveStatusJson(char* buffer, size_t capacity) {", "size_t buildControllerStatusJson(")
        status = section("size_t buildControllerStatusJson(char* buffer, size_t capacity) {", "bool startCrackleHttpServer()")
        helper = section("const char* jsonNumber(", "size_t buildLiveStatusJson(")
        self.assertIn("if (!isfinite(value)) {", helper)
        for body in (live, status):
            self.assertNotIn("isnan(", body)
            self.assertNotIn("source.roastBatchMassG,", body)
            self.assertNotIn("source.roastSolvedFan,", body)
        for fragment in ('"loss_per_min":%.4f', '"heater_gain":%.3f', '"thermocouple_offset_c":%.2f', '"settle_band_c":%.1f'):
            self.assertNotIn(fragment, status)

    def test_retention_sweep_advances_the_revision_once(self) -> None:
        retention = section("bool enforceLogArchiveRetention", "// Commit a valid plan-only archive")
        self.assertIn("deleteArchivedLog(plan.ids[index], false)", retention)
        self.assertEqual(retention.count("advanceStateRevision()"), 1)
        self.assertIn("bool deleteArchivedLog(uint32_t logId, bool advanceRevision = true) {", SOURCE)
        self.assertIn("if (advanceRevision) advanceStateRevision();", SOURCE)


if __name__ == "__main__":
    unittest.main()
