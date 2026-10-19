"""The native status route is always built from an immutable controller snapshot."""
from pathlib import Path

ROOT = Path(__file__).parent.parent
FIRMWARE = (ROOT / "crackle" / "crackle.ino").read_text(encoding="utf-8")
SERVER = (ROOT / "crackle" / "sr800_network_server.cpp").read_text(encoding="utf-8")
HEADER = (ROOT / "crackle" / "sr800_network_server.h").read_text(encoding="utf-8")

snapshot = FIRMWARE[
    FIRMWARE.index("struct LiveStatusSnapshot"):
    FIRMWARE.index("portMUX_TYPE liveStatusMux")
]
publisher = FIRMWARE[
    FIRMWARE.index("void publishNetworkSnapshot"):
    FIRMWARE.index("LiveStatusSnapshot copyLiveStatusSnapshot")
]
builder = FIRMWARE[
    FIRMWARE.index("size_t buildControllerStatusJson"):
    FIRMWARE.index("bool startCrackleHttpServer")
]

for field in (
    "sensorConfigured",
    "dataStoreMounted",
    "logArchiveMounted",
    "appliedCalibrationPresent",
    "restoreIncomplete",
    "appSlotBytes",
    "resetReason",
    "uptimeMs",
    "freeHeapBytes",
    "minimumFreeHeapBytes",
    "freePsramBytes",
    "lastLoopGapMs",
    "maximumLoopGapMs",
    "lastArchivePersistMs",
    "maximumArchivePersistMs",
    "archivePersistCount",
):
    assert field in snapshot
    assert f"next.{field}" in publisher
    assert f"source.{field}" in builder

assert "copyLiveStatusSnapshot()" in builder
assert "LittleFS" not in builder
assert "server." not in builder
assert "status_suspended_during_actuation" not in builder
assert "buildStatusJson" in HEADER
assert 'registerRoute("/api/status", HTTP_GET, queueStatus)' in SERVER
assert "buildControllerStatusJson" in FIRMWARE
assert "reportedStackLowWaterBytes" in SERVER
for diagnostic in (
    "live_websocket_client_capacity",
    "http_rejected_request_count",
    "http_worker_failure_count",
    "live_websocket_stack_low_water_bytes",
    "http_worker_stack_low_water_bytes",
    "storage_worker_stack_low_water_bytes",
    "reset_reason",
    "heap_minimum_free_bytes",
    "loop_maximum_gap_ms",
    "archive_persist_maximum_ms",
    "fault_reasons",
    # Worker-pool stacks, PSRAM low-water, and allocation failures.
    "http_asset_worker_stack_low_water_bytes",
    "http_command_worker_stack_low_water_bytes",
    "psram_low_water_bytes",
    "psram_low_water_at_ms",
    "failed_allocations",
    "last_failed_allocation",
    "current_build",
    "storage_worker_stack_low_water_route",
    "storage_request_slowest_ms",
    "storage_request_slowest_route",
    "storage_requests_over_1s",
):
    assert diagnostic in builder

# The failed-allocation hook runs inside the allocator on any task: it must not allocate, log, or
# take a lock that is not ISR-safe.
hook = FIRMWARE[FIRMWARE.index("void recordFailedAllocation(") : FIRMWARE.index("void samplePsramLowWater(")]
assert "portENTER_CRITICAL_SAFE(&heapDiagnosticsMux)" in hook
for forbidden in ("String", "Serial", "log_", "printf", "malloc", "new "):
    assert forbidden not in hook, forbidden
assert "heap_caps_register_failed_alloc_callback(recordFailedAllocation)" in FIRMWARE
assert "esp_app_get_elf_sha256" in FIRMWARE

print("native immutable status contract: PASS")
