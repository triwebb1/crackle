"""Bounded immutable GET /api/status response contract."""
from pathlib import Path
import re

ROOT = Path(__file__).parent.parent / "crackle"
SOURCE = (ROOT / "crackle.ino").read_text(encoding="utf-8")
SERVER = (ROOT / "sr800_network_server.cpp").read_text(encoding="utf-8")

start = SOURCE.index("size_t buildControllerStatusJson(")
end = SOURCE.index("bool startCrackleHttpServer()", start)
status = SOURCE[start:end]
serve = SERVER[SERVER.index("esp_err_t serveStatus"):SERVER.index("bool registerRoute")]

capacity = re.search(r"constexpr size_t kStatusPayloadBytes = (\d+);", SERVER)
assert capacity and 4096 <= int(capacity.group(1)) <= 12288
assert "const LiveStatusSnapshot source = copyLiveStatusSnapshot();" in status
for forbidden in ("LittleFS", "Preferences", "actuator.snapshot", "WiFi.", "delay("):
    assert forbidden not in status, forbidden
assert "job.statusPayload" in serve
assert "char statusHttpPayload[kStatusPayloadBytes]" not in serve
assert "if (length == 0 || length >= kStatusPayloadBytes)" in serve
assert "httpd_resp_send(job.request, job.statusPayload, length)" in serve
assert "statusPayloads = static_cast<char*>(allocateNetworkMemory" in SERVER
assert 'registerRoute("/api/status", HTTP_GET, queueStatus)' in SERVER
assert "kHttpServerStackBytes = 16384" in SERVER
assert "native.stack_size = kHttpServerStackBytes;" in SERVER
assert "native.task_caps" not in SERVER
assert "xTaskCreatePinnedToCore" in SERVER
assert "size_t buildControllerStatusJson(char* buffer, size_t capacity)" in SOURCE
assert "static_cast<size_t>(length) >= capacity - used" in status

print(f"firmware immutable status capacity contract: PASS ({capacity.group(1)} bytes)")