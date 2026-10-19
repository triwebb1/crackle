"""Source-level native HTTP and LittleFS integration contract.

The pure cursor/revision arithmetic remains native-tested. This check pins the route ordering and
streamed wire keys without pretending a host filesystem is LittleFS. It never flashes hardware.
"""
from pathlib import Path

SOURCE = (Path(__file__).parent.parent / "crackle" / "crackle.ino").read_text(encoding="utf-8")
SERVER = (Path(__file__).parent.parent / "crackle" / "sr800_network_server.cpp").read_text(encoding="utf-8")


def section(start: str, end: str) -> str:
    left = SOURCE.index(start)
    right = SOURCE.index(end, left)
    return SOURCE[left:right]


manifest = section("void handleDataManifest()", "void handleDataDelete()")
route = 'registerRoute("/api/data/*", HTTP_GET, queueStorage)'
generic = 'registerRoute("/api/*", HTTP_POST, queueCommand)'
assert route in SERVER and SERVER.index(route) < SERVER.index(generic)
assert "kManifestPageEntries = 64" in SOURCE
assert 'cursor.startsWith("m:")' in manifest
assert "decimalUint64" in manifest and "parsed > UINT32_MAX" in manifest
assert "HttpResponseWriter response;" in manifest
for token in ('state_rev', 'boot_id', 'collections', 'runs', 'logs', 'next_cursor', 'restore_maintenance'):
    assert token in manifest, token
assert "kCollectionCount" in manifest and 'F("null")' in manifest
assert 'restoreLease.dirty' in manifest and 'dirty' in manifest

start_log = section("void startThermalLog", "bool finalizeThermalLogForNewEpisode")
assert "advanceStateRevision" not in start_log
assert "meaningfulUnsavedThermalLog()" in start_log
assert "source == ThermalLogSource::ROAST ? 1U : kLogArchiveMinSamples" in SOURCE
persist = section(
    "void persistUnsavedThermalLog(bool force = false) {",
    "bool finalizeThermalLogForNewEpisode",
)
assert "minimumArchivedSamples(thermalLogSource)" in persist
assert "LittleFS.rename" in persist
assert persist.index("LittleFS.rename") < persist.rindex("advanceStateRevision")
delete_log = section("bool deleteArchivedLog", "bool enforceLogArchiveRetention")
assert "advanceStateRevision" in delete_log

abort = section("void handleRestoreAbort", "void handleThermocoupleOffset")
assert abort.index("restoreAbortAllowed") < abort.index("RestoreLease{}")
assert 'incomplete' in abort and 'dirty' in abort and 'Resume it and commit' in abort
thermal = section("void handleThermalCsv", "bool readLogArchiveHeader")
assert "server.send(409" not in thermal
assert "rejectBulkResponseDuringTimingSensitiveWork" not in SOURCE
# The mutable current-RAM CSV does not wait for capture freeze: a browser
# joining mid-roast reads a consistent append-only prefix instead of a 409.
assert "thermal_csv_mutating" not in SOURCE
assert SOURCE.count("mutableThermalCsvSnapshot(recording)") == 1
mutable_gate = section("bool mutableThermalCsvSnapshot(ThermalLogStateSnapshot& recording)", "bool sendBoundedResponse")
assert "copyThermalLogState()" in mutable_gate
assert "canReadFrozenBuffer" in mutable_gate
assert "sendBoundedResponse(409" not in mutable_gate
assert "HttpResponseWriter response;" in thermal
# The active-capture read copies bounded chunks under short thermalLogMux
# critical sections and never holds the mux across a response write; the
# loopTask sampler appends every 250 ms and must never wait behind a socket.
assert "portENTER_CRITICAL(&thermalLogMux);" in thermal
assert "portEXIT_CRITICAL(&thermalLogMux);" in thermal
assert thermal.index("portEXIT_CRITICAL(&thermalLogMux);") < thermal.index("response += row", thermal.index("thermalCsvChunk["))
assert "static ThermalSample thermalCsvChunk[kThermalCsvChunkSamples];" in thermal
assert "thermalLogReservedId == recording.reservedId" in thermal

patch = section("void handleRoastActivePlanPatch", "void handleRoastSet")
assert "ACCEPT_AND_ADVANCE" in patch
assert "serviceJourneyRoast(nowUs, actuator.snapshot(nowUs), true)" in patch
assert "sendActiveRoastPlan(202, true, immediateTransition)" in patch

roast_start = section("bool startRoast", "void logArchivePath")
assert "kCompactRoastLogIntervalMs" in roast_start
assert "startThermalLog(ThermalLogSource::ROAST" in roast_start
assert roast_start.index("startThermalLog(ThermalLogSource::ROAST") < roast_start.index("actuator.request")
assert "captureInitialRoastArchivePlan();" in roast_start
assert roast_start.index("persistProvisionalRoastArchive()") < roast_start.index("actuator.request")
assert "could not be committed to storage" in roast_start
assert roast_start.index("discardProvisionalRoastArchive()", roast_start.index("actuator.request")) > roast_start.index("actuator.request")
assert "header.intervalMs = thermalLogIntervalMs" in persist

roast_stop = section(
    '} else if (strcmp(command.uri, "/api/roast/stop") == 0) {',
    '} else if (strcmp(command.uri, "/api/roast/start") == 0) {',
)
assert 'finishRoast(micros(), "stopped")' in roast_stop
assert "stopDiagnosticTest()" not in roast_stop
finish_roast = section(
    "bool finishRoast(uint32_t nowUs, const char* endReason) {",
    "void serviceTimedRoast",
)
assert "actuator.stop(nowUs)" in finish_roast
assert "roastCommandFanMilli = 0" in finish_roast
assert "roastCommandHeatMilli = 0" in finish_roast
assert "roastCommandFanMilli > 0" not in finish_roast
assert "/api/manual/takeover" not in SOURCE

active_plan = section("void sendActiveRoastPlan", "void handleRoastActivePlanGet")
assert "initial_zones" in active_plan
assert "roastArchivePlan.items" in active_plan
assert "roastArchivePlan.mode == sr800::logcodec::PlanMode::JOURNEY" in active_plan

log_list = section("void handleLogsList", "// The stored file, byte for byte")
assert "passive_tail_complete" in log_list
assert "kArchivePassiveTailIncomplete" in log_list

print("firmware manifest/runtime source contract: PASS")
