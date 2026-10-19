"""Focused source contracts for firmware transport, OTA, storage, and lease hardening."""
from pathlib import Path
import json

ROOT = Path(__file__).parent.parent
FW = (ROOT / "crackle" / "crackle.ino").read_text(encoding="utf-8")
SERVER = (ROOT / "crackle" / "sr800_network_server.cpp").read_text(encoding="utf-8")
SERVER_H = (ROOT / "crackle" / "sr800_network_server.h").read_text(encoding="utf-8")
MAILBOX = (ROOT / "crackle" / "sr800_network_mailbox.cpp").read_text(encoding="utf-8")
MAILBOX_H = (ROOT / "crackle" / "sr800_network_mailbox.h").read_text(encoding="utf-8")
QUERY_H = (ROOT / "crackle" / "sr800_query_args.h").read_text(encoding="utf-8")
PAGE = (ROOT / "crackle" / "sr800_web_pages.h").read_text(encoding="utf-8")
README = (ROOT / "README.md").read_text(encoding="utf-8")


def section(source: str, start: str, end: str) -> str:
    left = source.index(start)
    return source[left:source.index(end, left)]


# The embedded updater and native raw route are one exact contract.
assert "request.open('POST','/update');" in PAGE
assert "/api/update');" not in PAGE
assert 'registerRoute("/update", HTTP_POST, serveOtaDirect)' in SERVER

# Only a completed health response marks the cross-core latch.
assert "using HealthResponseServed" in SERVER_H
for handler in (section(SERVER, "esp_err_t serveLive(httpd_req_t* request) {", "esp_err_t serveStatus(AsyncJob& job) {"),
                section(SERVER, "esp_err_t serveStatus(AsyncJob& job) {", "bool registerRoute")):
    assert "result == ESP_OK" in handler
    assert "serverConfig.healthResponseServed()" in handler
assert "portENTER_CRITICAL(&otaStateMux)" in section(
    FW, "void markOtaHealthResponseServed", "bool max31856Configured")
assert "copyOtaHealthResponseServed()" in section(
    FW, "void maybeValidateOtaImage", "}  // namespace")
assert "httpRequestServed" not in FW

# Form bodies are bounded, NUL terminated, body-first, and scrubbed in
# both static copies. Query-only commands retain their existing fallback.
assert "kCommandBodyBytes + 1" in MAILBOX_H and "kCommandBodyBytes + 1" in SERVER
assert "application/x-www-form-urlencoded" in SERVER
assert "request->content_len > kCommandBodyBytes" in SERVER
assert "job.body[received] = 0" in SERVER
assert "primary source wins" in QUERY_H
assert "form == nullptr ? nativeCommandRequest->query : form" in FW
assert "form == nullptr ? nullptr : nativeCommandRequest->query" in FW
for source in (MAILBOX, SERVER):
    assert "volatile uint8_t* body" in source
    assert "body[index] = 0" in source

# The maximum full response remains compatible with GET and PATCH and
# fits the fixed 4 KiB mailbox. This concrete maximum uses all 12 current and 12
# initial zones plus longest identifiers and 32-bit decimal fields.
assert "kCommandResponseBytes = 4096" in MAILBOX_H
assert "kActivePlanWorstCaseBytes" in FW
assert "kActivePlanWorstCaseBytes <" in FW
plan = section(FW, "void sendActiveRoastPlan", "void handleRoastActivePlanGet")
patch = section(FW, "void handleRoastActivePlanPatch", "void handleRoastSet")
assert "initial_zones" in plan
assert "sendActiveRoastPlan(202)" in patch
assert "sendActiveRoastPlan(202, true, immediateTransition)" in patch
zone = {"start_c": 300.00, "end_c": 300.00, "duration_sec": 1800.0,
        "fan_min": 10.000, "fan_max": 10.000,
        "heat_min": 10.000, "heat_max": 10.000}
initial = {"start_c": 300.0, "end_c": 300.0, "duration_sec": 65535,
           "fan_min": 10.0, "fan_max": 10.0,
           "heat_min": 10.0, "heat_max": 10.0}
maximum = {"ok": True, "active": True, "boot_id": "4294967295",
           "session_id": 4294967295, "plan_rev": 4294967295,
           "mode": "journey", "profile_id": "x" * 64,
           "profile_revision": 4294967295, "name": "x" * 32,
           "batch_mass_g": 2000.0, "start_c": 300.00, "steps": [],
           "zones": [zone] * 12, "initial_zones": [initial] * 12,
           "immediate_transition": False}
assert len(json.dumps(maximum, separators=(",", ":"))) < 4096

# Production branches use the behaviorally host-tested wrap-safe
# instruction and sustained-condition helpers rather than duplicate arithmetic.
assert FW.count("sr800::runtime::instructionExpired(") == 2
assert "overtemperatureCondition.observe(" in FW
assert "overtempSinceMs" not in FW

# OTA and flash mutation exclude each other. Every new
# actuation path acquires the shared flash guard, while Stop remains independent.
mutation_guard = section(FW, "class StorageMutationGuard", "uint32_t actuatorIdleSinceMs")
request_guard = section(FW, "class StorageRequestGuard", "bool currentArchiveLayout")
assert "otaReservesPort80()" in mutation_guard
assert "otaReservesPort80()" in request_guard
admission = section(FW, "bool requestOtaAdmission", "esp_err_t sendOtaJson")
for token in ("storageMutationActive", "storageRequestActive", "actuatorFullyIdle()"):
    assert token in admission
for start, end in (("bool startFanTest", "bool startHeaterProof"),
                   ("bool startHeaterProof", "bool startCalibration"),
                   ("bool startCalibration", "bool finishRoast"),
                   ("bool startRoast", "void logArchivePath")):
    assert "StorageMutationGuard" in section(FW, start, end)
assert "StorageMutationGuard storage(!wasActive, !wasActive)" in FW
assert 'registerRoute("/api/stop", HTTP_POST, queueStop)' in SERVER
assert 'strcmp(command.uri, "/api/stop") == 0' in FW
assert "return actuatorFullyIdle() && !otaReservesPort80();" in FW
capture_clear = section(FW, "void handleCaptureClear", "void handleCaptureFreeze")
assert "otaReservesPort80()" in capture_clear
for start, end in (("void handleRestoreBegin", "void handleRestoreCommit"),
                   ("void handleThermocoupleOffset", "bool loadNetworkCredentials"),
                   ("void handleWifiConfiguration", "bool requestOtaAdmission"),
                   ("void handleCalibrationApply", "// POST /api/roast/start")):
    assert "nvsMutationAllowed()" in section(FW, start, end)

# Probe controls consume the lifecycle field and derive the current host.
assert "s.lifecycle!=='STANDBY'" in PAGE
assert "location.hostname" in PAGE
for stale in ("s.heater_proof_phase", "s.fan_test_active", "s.station_ip",
              "s.station_configured"):
    assert stale not in PAGE

# Storage-task stack margin is measured and exposed separately.
storage_main = section(SERVER, "void storageMain", "void workerMain")
# Measured per job and per idle service pass, with the route that set it.
assert "recordStorageStackLowWater(route)" in storage_main
assert "uxTaskGetStackHighWaterMark2" in section(SERVER, "void recordStorageStackLowWater", "void storageLowWaterRouteSnapshot")
assert "storageStackLowWaterBytes" in SERVER_H
assert "storage_worker_stack_low_water_bytes" in FW

# A lost Heat lease ends its owner explicitly, and deadline
# arming is independent of a micros() value that happens to wrap to zero.
lease = section(FW, "Once requested Heat has been observed effective", "if (heaterProofPhase")
assert lease.count('"heat_lease_expired"') == 3
assert "calibrationEndReason" in lease and "manualEndReason" in lease
assert "finishRoast" in lease and "actuator.stop" in lease
assert "calibrationStepDeadlineArmed" in FW
assert "roastStepDeadlineArmed" in FW
assert "calibrationStepEndUs != 0" not in FW
assert "roastStepEndUs != 0" not in FW

# Exact PING payload echo and no destructive format while a
# passive-tail recording remains live or unsaved.
ws = section(SERVER, "esp_err_t handleLiveWebSocket", "void requireSnapshotForAllSubscribers")
assert "frame.type == HTTPD_WS_TYPE_PING" in ws
assert "frame.type = HTTPD_WS_TYPE_PONG" in ws
assert "frame.payload = payload" in ws
assert "httpd_ws_send_frame(request, &frame)" in ws
format_logs = section(FW, "void handleLogsFormat", "bool readLogArchiveHeader")
assert "copyThermalLogState()" in format_logs
assert "recording.active || recording.unsaved" in format_logs

# Firmware and documentation use the same confirmation token.
assert "SET_ROAST_LEVELS" not in README
assert README.count("CONTROL_ROAST") >= 2


# The distinct healthy Heat-lease termination must survive archive persistence.
assert 'if (strcmp(reason, "heat_lease_expired") == 0) return 12;' in FW
assert 'case 12: return "heat_lease_expired";' in FW
print("Firmware hardening contracts: PASS")