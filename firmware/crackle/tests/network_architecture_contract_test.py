"""The network boundary keeps browser sockets out of the control loop."""
from pathlib import Path

ROOT = Path(__file__).parent.parent
SOURCE = (ROOT / "crackle" / "crackle.ino").read_text(encoding="utf-8")
SERVER = (ROOT / "crackle" / "sr800_network_server.cpp").read_text(encoding="utf-8")
ARCHITECTURE = (ROOT.parent.parent / "docs" / "network-architecture.md").read_text(
    encoding="utf-8"
)


def require(text: str) -> None:
    assert text in ARCHITECTURE, text


for invariant in (
    "No browser-owned socket may run",
    "bounded command mailbox",
    "single storage worker",
    "one complete immutable snapshot",
    "at most one update per second",
    "Status is formatted from an immutable controller snapshot",
    "Stop has a reserved mailbox slot",
    "leaving NVS and LittleFS untouched",
):
    require(invariant)

# The synchronous WebServer transport must never return. This check must not
# silently stop running when the release version changes.
assert "#include <WebServer.h>" not in SOURCE
assert "CrackleWebServer server(80);" not in SOURCE
assert "server.handleClient();" not in SOURCE
assert "PendingStaticHttpTransfer" not in SOURCE
assert "writeHttpBodyBounded(NetworkClient" not in SOURCE
assert "startCrackleHttpServer()" in SOURCE
assert "serviceNetworkCommandMailbox();" in SOURCE
assert "publishNetworkSnapshot();" in SOURCE

assert "kSubscriberCount = 4" in SERVER
assert "kAssetJobCount = 5" in SERVER
assert 'httpd_resp_set_hdr(request, "Retry-After", "1")' in SERVER
assert "lastSuccessfulSendMs" in SERVER
assert "A newly opened browser wins" in SERVER
assert "subscriberEvictionAllowed" in SERVER
assert "Four healthy" in SERVER
assert "reconcileSubscribersWithServer" in SERVER
assert "httpd_get_client_list" in SERVER
assert "httpd_ws_get_fd_info" in SERVER
assert "vTaskDeleteWithCaps" in SERVER
assert "assetQueue = xQueueCreate(kAssetJobCount" in SERVER
assert 'workerMain, "crackle-assets"' in SERVER
assert 'registerRoute("/update", HTTP_POST, serveOtaDirect)' in SERVER
assert "dedicated OTA worker" not in ARCHITECTURE
assert "its own queue, job, worker" not in ARCHITECTURE
assert "reserves port 80" in ARCHITECTURE
assert "otaQueue" not in SERVER and '"crackle-ota"' not in SERVER


diagnostics = SERVER[SERVER.index("void noteWorkerFailure") : SERVER.index("struct Subscriber")]
assert "diagnosticsMux" in SERVER
# 14: asset/command pools, storage low-water route, slowest storage request.
assert diagnostics.count("portENTER_CRITICAL(&diagnosticsMux)") == 14
assert diagnostics.count("portEXIT_CRITICAL(&diagnosticsMux)") == 14
for forbidden in ("httpd_", "xQueue", "sendError", "httpWorkerFailureCount"):
    assert forbidden not in diagnostics, forbidden
assert SERVER.count("++workerFailures") == 1
# All asynchronous handoff/send failures feed the same diagnostic counter,
# including the storage listener-to-worker handoff and bounded FIFO enqueue.
assert SERVER.count("noteWorkerFailure();") == 9
assert "kStorageJobCount = 3" in SERVER
assert "kStorageWorkerStackBytes = 16384" in SERVER
# Every storage job and every idle service pass is attributed.
storage_main = SERVER[SERVER.index("void storageMain(void*) {") : SERVER.index("void workerMain(")]
assert storage_main.count("recordStorageStackLowWater(") == 2
assert "describeStorageRoute(job->request" in storage_main
assert "recordStorageRequestDuration(" in storage_main and "esp_timer_get_time()" in storage_main
assert "recordStorageStackLowWater(route);" in SERVER
assert "recordStackLowWater(lowWater, false);" in SERVER
assert "otaHandlerStackLowWaterBytes" in SERVER
assert "stackLowWaterSnapshot" in SERVER and "workerFailureSnapshot" in SERVER
setup = SOURCE[SOURCE.index("void setup()") : SOURCE.index("void loop()")]
recording_allocation = setup[
    setup.index("thermalLog = static_cast<ThermalSample*>") :
    setup.index("loadRuntimeContract()")
]
assert "manualConflictLatched = true" not in recording_allocation
assert "recordingAvailable = thermalLog != nullptr" in SOURCE
assert '\"thermal_log\":{\"available\":%s' in SOURCE

# Cross-core recording ownership: core 1 alone closes capture; core 0 can only
# persist a frozen, claimed buffer. No flash operation occurs under either mux.
loop_body = SOURCE[SOURCE.index("void loop()") :]
assert "serviceThermalCaptureLifecycle(loopEntryMs);" in loop_body
setup_body = SOURCE[SOURCE.index("void setup()") : SOURCE.index("void loop()")]
assert "serviceThermalCaptureLifecycle" not in setup_body
storage_service = SOURCE[SOURCE.index("void serviceThermalArchive()") : SOURCE.index("void serviceNativeStorage()")]
assert "thermalLogActive = false" not in storage_service
persist = SOURCE[SOURCE.index("void persistUnsavedThermalLog(bool force = false) {") : SOURCE.index("bool finalizeThermalLogForNewEpisode() {")]
assert persist.index("FrozenThermalLogClaim claim;") < persist.index("thermalLogCount")
assert "Preferences" not in SOURCE[SOURCE.index("class FrozenThermalLogClaim") : SOURCE.index("void persistUnsavedThermalLog(bool force = false) {")]

# Every command-lane NVS mutation owns the same storage exclusion for the
# complete handler lifetime. Revision reads take a short 64-bit snapshot lock.
assert SOURCE.count("StorageMutationGuard nvsMutation;") == 6
assert SOURCE.count("!nvsMutationAllowed() || !nvsMutation") == 6
revision_snapshot = SOURCE[SOURCE.index("uint64_t currentStateRevision() {") : SOURCE.index("void advanceStateRevision() {")]
assert "portENTER_CRITICAL(&stateRevisionMux)" in revision_snapshot
assert "Preferences" not in revision_snapshot
revision_advance = SOURCE[SOURCE.index("void advanceStateRevision() {") : SOURCE.index("bool saveThermocoupleOffset")]
assert revision_advance.index("portEXIT_CRITICAL(&stateRevisionMux)") < revision_advance.index("Preferences store")
for unsafe_read in (
    "nativeCommandResponse->stateRevision = stateRevision;",
    "response.stateRevision = stateRevision;",
    "next.stateRevision = stateRevision;",
    "appendUint64Decimal(response, stateRevision)",
    "static_cast<unsigned long long>(stateRevision)",
):
    assert unsafe_read not in SOURCE, unsafe_read
print("Network architecture contract: PASS")

assert 'class StorageRequestGuard' in SOURCE
request_guard = SOURCE[SOURCE.index('class StorageRequestGuard'):SOURCE.index('bool currentArchiveLayout')]
assert 'storageRequestOwner == current' in SOURCE
assert 'storageMutationActive || storageRequestActive' in SOURCE

assert 'storageMutationOwner == current' in SOURCE
assert 'storageMutationDepth' in SOURCE
assert 'kActuationStartStoragePriorityMs = 3500' in SOURCE
assert SOURCE.count('StorageMutationGuard storage(true, true);') == 4
assert 'StorageMutationGuard storage(!wasActive, !wasActive);' in SOURCE
assert 'storageMutationPriorityUntilMs' in request_guard
assert 'kStorageBusyStartRejection' in SOURCE
assert 'nativeCommandResponse->retryStorageBusy = storageBusy;' in SOURCE
assert 'bool commandMayStartOrChangeActuation(const char* uri)' in SOURCE
command_service = SOURCE[
    SOURCE.index("void serviceNetworkCommandMailbox()") :
    SOURCE.index("void maybeValidateOtaImage()")
]
for actuator_command in (
    "/api/fan-test/start",
    "/api/heater-proof/start",
    "/api/calibration/start",
    "/api/manual/set",
    "/api/roast/start",
    "/api/roast/set",
    "/api/roast/active-plan",
):
    assert actuator_command in command_service
assert "command.method == sr800::network::CommandMethod::POST" in command_service
assert "command.stopGeneration !=" in command_service
assert "sr800::network::stopGenerationSnapshot()" in command_service
assert '"code":"start_cancelled_by_stop"' in command_service
assert command_service.index("command.stopGeneration !=") < command_service.index(
    "runControllerHandler(handleFanTestStart)"
)

native_storage_start = SOURCE.index(
    "esp_err_t handleNativeStorageRequest(httpd_req_t* request) {"
)
native_storage = SOURCE[
    native_storage_start :
    SOURCE.index("bool parseFiniteFloatArg(", native_storage_start)
]
busy_branch = native_storage[
    native_storage.index("if (!requestGuard) {") :
    native_storage.index("char requestPath[128]")
]
assert busy_branch.index(
    'httpd_resp_set_hdr(nativeStorageRequest, "Retry-After", "1");'
) < busy_branch.index("sendRequestResponse(503")
