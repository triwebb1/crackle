"""Narrow source contract for fail-closed shared-volume reliability."""
from pathlib import Path

SOURCE = (Path(__file__).parents[1] / "crackle" / "crackle.ino").read_text(
    encoding="utf-8"
)


def section(start: str, end: str) -> str:
    left = SOURCE.index(start)
    right = SOURCE.index(end, left + len(start))
    return SOURCE[left:right]


mount = section("bool mountLogArchive()", "// Explicit, operator-confirmed recovery")
assert "classifyLayout(marker, currentLayout)" in mount
assert "LayoutVerdict::REQUIRES_FORMAT" in mount
assert "probeArchiveFilesystem()" in mount
assert "archivePartitionAppearsErased()" in mount
assert "if (!setArchiveFilesystemMarker(currentLayout))" in mount
assert "LittleFS.begin(true" in mount
fresh_branch = mount.index("LayoutVerdict::FRESH")
auto_format = mount.index("LittleFS.begin(true")
assert fresh_branch < auto_format



marker_write = section(
    "bool setArchiveFilesystemMarker", "bool probeArchiveFilesystem"
)
assert marker_write.index('putBool("fsinit", true)') < marker_write.index('putUInt("fsaddr"')
assert 'const sr800::storage::Marker verified = archiveFilesystemMarker()' in marker_write
assert 'sameLayout(verified.layout, layout)' in marker_write
assert 'recordStorageFailure(StorageFailureStage::MARKER_WRITE)' in marker_write

blank_check = section("bool archivePartitionAppearsErased()", "sr800::storage::Marker archiveFilesystemMarker")
assert "esp_partition_read" in blank_check
assert "bytes[index] != 0xFFU" in blank_check

probe = section("bool probeArchiveFilesystem()", "// ---------------------------------------------------------------------------")
for stage in (
    "PROBE_DEST_OPEN",
    "PROBE_DEST_WRITE",
    "PROBE_TEMP_OPEN",
    "PROBE_TEMP_WRITE",
    "PROBE_RENAME",
    "PROBE_VERIFY",
):
    assert stage in probe
assert probe.index('LittleFS.open(kProbeTempPath, "w")') < probe.index(
    "LittleFS.rename(kProbeTempPath, kProbeDestinationPath)"
)
assert probe.index("temporary.write") < probe.index("temporary.flush()")
assert probe.index("temporary.flush()") < probe.index("temporary.size()")
assert probe.index("LittleFS.rename") < probe.index(
    'LittleFS.open(kProbeDestinationPath, "r")'
)

for start, end in (
    ("bool docWriteTemp(void* context)", "// littlefs implements rename"),
    ("bool persistProvisionalRoastArchive() {", "void discardProvisionalRoastArchive()"),
    ("void persistUnsavedThermalLog(bool force = false) {", "// A new actuation episode is beginning"),
):
    durable_write = section(start, end)
    assert durable_write.index("file.write") < durable_write.index("file.flush()")
    assert durable_write.index("file.flush()") < durable_write.index("file.size()")

finalize = section(
    "bool finalizeThermalLogForNewEpisode() {", "void serviceThermalArchive"
)
assert "persistUnsavedThermalLog" not in finalize
assert "discardSubminimumAtHandoff" in finalize
assert "thermalLogUnsaved = false" in finalize
assert "persistenceBlocksNewEpisode" in finalize
assert "thermalLogPersistenceClaimed" in finalize
assert "return !pending" in finalize
assert SOURCE.count("!finalizeThermalLogForNewEpisode()") == 0
# Every Start and the manual set take over from the post-stop tail and the
# prior recording through one helper: idle-gated, then a synchronous forced
# persist, and a refusal only when that persist genuinely failed.
assert SOURCE.count("!takeOverPriorRecordingForNewEpisode(rejection)") == 4
assert SOURCE.count("takeOverPriorRecordingForNewEpisode(takeOverRejection)") == 1
take_over = section(
    "bool takeOverPriorRecordingForNewEpisode(const char*& rejection) {", "// ---------------------------------------------------------------------------"
)
assert take_over.index("actuatorFullyIdle()") < take_over.index("finalizeThermalLogForNewEpisode()")
assert take_over.index("finalizeThermalLogForNewEpisode()") < take_over.index("persistUnsavedThermalLog(true)")
assert take_over.index("persistUnsavedThermalLog(true)") < take_over.rindex("finalizeThermalLogForNewEpisode()")

request_guard = section("class StorageRequestGuard", "bool currentArchiveLayout")
request_lock = request_guard.index("portENTER_CRITICAL(&storageMutationMux)")
request_ota_recheck = request_guard.index("if (otaReservesPort80())", request_lock)
request_early_exit = request_guard.index("portEXIT_CRITICAL(&storageMutationMux)", request_ota_recheck)
assert request_lock < request_ota_recheck < request_early_exit
mutation_guard = section("class StorageMutationGuard", "uint32_t actuatorIdleSinceMs")
mutation_lock = mutation_guard.index("portENTER_CRITICAL(&storageMutationMux)")
mutation_ota_recheck = mutation_guard.index("if (otaReservesPort80())", mutation_lock)
mutation_early_exit = mutation_guard.index("portEXIT_CRITICAL(&storageMutationMux)", mutation_ota_recheck)
assert mutation_lock < mutation_ota_recheck < mutation_early_exit

storage_service = section("void serviceNativeStorage()", "// ---------------------------------------------------------------------------")
assert "StorageRequestGuard storage" in storage_service
assert storage_service.index("StorageRequestGuard storage") < storage_service.index("serviceThermalArchive")
gate = section("bool dataStoreIdleGate()", "// Streams the payload")
assert gate.index("persistUnsavedThermalLog(true)") < gate.index(
    "copyThermalLogState()", gate.index("persistUnsavedThermalLog(true)")
)
assert "if (recording.unsaved)" in gate
assert "document write was not attempted" in gate

store = section("void storeDocumentRequest", "// The collection name arrives")
assert store.index("dataStoreIdleGate()") < store.index(
    'requestArg("plain")'
)

format_path = section("void handleLogsFormat()", "constexpr uint32_t kMaxLogArchiveId")
explicit_format = format_path.index('esp_littlefs_format("spiffs")')
explicit_mount = format_path.index('LittleFS.begin(false, "/littlefs", 10, "spiffs")')
assert explicit_format < explicit_mount
assert "LittleFS.begin(true," not in format_path
assert "StorageFailureStage::FORMAT" in format_path
assert "if (!setArchiveFilesystemMarker(currentLayout))" in format_path
assert "Storage remains unavailable" in format_path

status = section("size_t buildControllerStatusJson(", "bool startCrackleHttpServer()")
for diagnostic in (
    "log_archive", "mounted", "needs_format", "health", "lost_logs",
):
    assert diagnostic in status
failure = section("void recordStorageFailure", "class StorageRequestGuard")
for diagnostic in (
    "storageFailureStage", "storageFailureFreeHeapBytes",
    "storageFailureMinFreeHeapBytes", "storageFailureLargestBlockBytes",
    "storageWriteFailures",
):
    assert diagnostic in failure
# A long flash walk (handleDataManifest's directory walk, for one) can exceed the 5 s task
# watchdog. delay(0) is vTaskDelay(0), which never yields to the lower-priority IDLE task the
# watchdog watches, so long flash loops must use pacedYield() (a real one-tick sleep).
FUNCTION_END = "\n}\n"
assert "delay(0);" not in SOURCE
paced = section("inline void pacedYield() {", FUNCTION_END)
assert "vTaskDelay(1)" in paced
# The walk lives in the revision-keyed manifest cache.
manifest = section("void handleDataManifest() {", FUNCTION_END)
assert "loadManifestEntries()" in manifest
loader = section("bool loadManifestEntries() {", FUNCTION_END)
assert loader.count("pacedYield();") >= 2
assert "manifestCacheMutations == mutations" in loader
# Restore-lease writes defer the revision to commit, so they must still invalidate the cache.
assert "noteManifestMutation();" in section("void markRestoreDirty() {", FUNCTION_END)
assert "manifestMutationCount++;" in section("void advanceStateRevision() {", FUNCTION_END)
# Bodies have a whole-transfer deadline, not only a no-progress budget.
body = section("bool receiveNativeStorageBody(size_t maximumBytes) {", FUNCTION_END)
assert "kDocumentBodyDeadlineMs" in body
assert "kRecordingUploadDeadlineMs" in section("void handleNativeLogRestore() {", FUNCTION_END)
# A save or delete moves the cached data-store figures by one document, never a tree walk.
store = section("void storeDocumentRequest(const char* path, uint32_t maxPayloadBytes) {", FUNCTION_END)
assert "refreshDataStoreStats();" not in store
assert "applyStoredDocDelta(path, info, readStoredDoc(path));" in store
assert "applyStoredDocDelta(path, info, StoredDocInfo{});" in SOURCE
assert SOURCE.count("refreshDataStoreStats();") == 1  # prepareDataStore (mount, format) only
# The recordings list is served from a cache keyed like the manifest.
log_list = section("void handleLogsList() {", FUNCTION_END)
assert "loadLogListEntries()" in log_list
assert "LittleFS.usedBytes()" not in log_list and "readLogArchiveHeader" not in log_list
log_loader = section("bool loadLogListEntries() {", FUNCTION_END)
assert "logListCacheMutations == mutations" in log_loader
for walker in ("uint32_t countArchivedLogs() {", "void refreshDataStoreStats() {", "void handleLogsList() {",
               "bool loadLogListEntries() {",
               "bool enforceLogArchiveRetention(size_t bytesNeeded, uint32_t protectedId) {"):
    assert "pacedYield();" in section(walker, FUNCTION_END), walker
print("storage reliability source contract: PASS")
