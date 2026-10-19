"""Source contract for power-loss-safe roast occurrence archives.

LittleFS and the Arduino actuator cannot be host-executed together, so this pins
ordering and atomic-file invariants at their integration boundary. Codec behavior
remains covered by the native log codec test.
"""
from pathlib import Path

SOURCE = (Path(__file__).parent.parent / "crackle" / "crackle.ino").read_text(encoding="utf-8")


def section(start: str, end: str) -> str:
    left = SOURCE.index(start)
    right = SOURCE.index(end, left + len(start))
    return SOURCE[left:right]


start = section("bool startRoast", "void logArchivePath")
commit_at = start.index("persistProvisionalRoastArchive()")
request_at = start.index("actuator.request")
assert commit_at < request_at
assert "could not be committed to storage" in start
assert start.index("discardProvisionalRoastArchive()", request_at) > request_at

provisional = section(
    "bool persistProvisionalRoastArchive() {",
    "void discardProvisionalRoastArchive()",
)
for invariant in (
    "actuatorFullyIdle()",
    "thermalLogSource != ThermalLogSource::ROAST",
    "!roastArchivePlanValid",
    "header.sampleCount = 0",
    "header.roastEndReason",
    "kCodecDeltaVarintPlan",
    "encodePlanProvenance",
    "crc32Finish",
    "enforceLogArchiveRetention",
    "kLogArchiveTempPath",
    "LittleFS.rename",
    "thermalLogProvisionalPersisted = true",
    "advanceStateRevision",
):
    assert invariant in provisional, invariant
assert "attempted-but-not-accepted" in SOURCE
start_log = section("void startThermalLog", "bool finalizeThermalLogForNewEpisode")
assert "thermalLogPassiveTailComplete = false" in start_log
service = section(
    "void serviceThermalCaptureLifecycle", "void serviceThermalArchive()"
)
assert service.index("thermalLogPassiveTailComplete = true") < service.index("thermalLogActive = false")

delete_log = section("bool deleteArchivedLog", "bool enforceLogArchiveRetention")
assert "logId == thermalLogReservedId" in delete_log
assert "thermalLogProvisionalPersisted = false" in delete_log

retention = section(
    "bool enforceLogArchiveRetention", "// Commit a valid plan-only archive"
)
assert "kMaxPlannedDeletions + 1" in retention
assert "logId == protectedId" in retention
assert "planLogRetention" in retention
assert "Verdict::IMPOSSIBLE" in retention
assert retention.index("planLogRetention") < retention.index("deleteArchivedLog")

assert provisional.index("LittleFS.exists(kLogArchiveTempPath)") < provisional.index(
    "LittleFS.remove(kLogArchiveTempPath)"
)
assert provisional.index("LittleFS.remove(kLogArchiveTempPath)") < provisional.index(
    "enforceLogArchiveRetention"
)
assert provisional.index("enforceLogArchiveRetention") < provisional.index("LittleFS.open")
assert "if (!enforceLogArchiveRetention" in provisional
assert provisional.index("LittleFS.open") < provisional.index("LittleFS.rename")

cleanup = section(
    "void discardProvisionalRoastArchive()",
    "// Persist the unsaved in-RAM thermal log",
)
assert "LittleFS.remove(path)" in cleanup
assert "logArchiveCount--" in cleanup
assert "thermalLogProvisionalPersisted = false" in cleanup

finalize = section(
    "void persistUnsavedThermalLog(bool force = false) {",
    "bool finalizeThermalLogForNewEpisode",
)
assert "if (!enforceLogArchiveRetention" in finalize
assert finalize.index("LittleFS.exists(kLogArchiveTempPath)") < finalize.index(
    "LittleFS.remove(kLogArchiveTempPath)"
)
assert finalize.index("LittleFS.remove(kLogArchiveTempPath)") < finalize.index(
    "if (!enforceLogArchiveRetention"
)
assert finalize.index("if (!enforceLogArchiveRetention") < finalize.rindex(
    "thermalLogPersistAttempts++"
)
assert "if (!thermalLogProvisionalPersisted) logArchiveCount++" in finalize
assert finalize.index("LittleFS.rename") < finalize.index("claim.markPersisted()")
claim = section("class FrozenThermalLogClaim", "// Persist the unsaved in-RAM thermal log")
assert "void markPersisted() { release(true, true); }" in claim
assert claim.index("if (clearProvisional)") < claim.index(
    "thermalLogPersistenceClaimed = false"
)
assert "durable plan-only form" in finalize

reader = section("bool readLogArchiveHeader", "void handleLogsList")
assert "header.sampleCount > kThermalLogCapacity" in reader
assert "header.sampleCount == 0" not in reader

validator = (Path(__file__).parent.parent / "crackle" / "sr800_log_codec.cpp").read_text(encoding="utf-8")
assert "declared > out.encodedBytes" in validator
assert "declared >= out.encodedBytes" not in validator

stored_csv = section("void handleLogFetch()", "void handleLogDelete()")
assert "declared > header.encodedBytes" in stored_csv
assert "declared >= header.encodedBytes" not in stored_csv
assert "HttpResponseWriter response;" in stored_csv
assert 'response.begin("text/csv", filename);' in stored_csv
assert "response.ok()" in stored_csv
assert "response += row;" in stored_csv
assert "response.finish();" in stored_csv
assert "server.sendContent(row)" not in stored_csv
print("firmware provisional roast archive durability contract: PASS")
