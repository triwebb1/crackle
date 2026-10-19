"""Native HTTP transport contracts for bounded work and live subscriptions."""
from pathlib import Path
import re

ROOT = Path(__file__).parent.parent / "crackle"
SOURCE = (ROOT / "crackle.ino").read_text(encoding="utf-8")
SERVER = (ROOT / "sr800_network_server.cpp").read_text(encoding="utf-8")


def section(source: str, start: str, end: str) -> str:
    begin = source.index(start)
    return source[begin:source.index(end, begin)]


# Browser sockets never run from Arduino loopTask.
loop = SOURCE[SOURCE.index("void loop()") :]
assert "server.handleClient" not in loop
assert "servicePendingStaticHttpTransfers" not in loop
assert "WebServer" not in SOURCE

# One native server owns port 80 and queues every body-producing route.
assert "native.server_port = config.port;" in SERVER
assert "kHttpOpenSocketCount = 8" in SERVER
assert "native.max_open_sockets = kHttpOpenSocketCount;" in SERVER
assert "native.backlog_conn = 8;" in SERVER
assert "native.keep_alive_enable = true;" in SERVER
for route, handler in (
    ('"/api/live", HTTP_GET', "queueLive"),
    ('"/api/status", HTTP_GET', "queueStatus"),
    ('"/api/update/version", HTTP_GET', "queueOtaVersion"),
    ('"/update", HTTP_POST', "serveOtaDirect"),
    ('"/api/data/*", HTTP_GET', "queueStorage"),
    ('"/api/events", HTTP_GET', "queueStorage"),
    ('"/capture.csv", HTTP_GET', "queueStorage"),
    ('"/timing.csv", HTTP_GET', "queueStorage"),
):
    assert f"registerRoute({route}, {handler})" in SERVER, route

# Storage responses batch into one fixed buffer and use IDF's bounded send path.
chunk = re.search(r"constexpr size_t kHttpChunkBytes = (\d+)U;", SOURCE)
assert chunk and 2048 <= int(chunk.group(1)) <= 4096
writer = section(SOURCE, "class HttpResponseWriter", "void handleDataRunsIndex")
assert "httpd_resp_send_chunk" in writer
assert "sizeof(httpChunkBuffer) - used_" in writer
assert "memcpy(httpChunkBuffer + used_, value, take)" in writer
assert "server.sendContent" not in SOURCE

# Upload timeouts are renewable no-progress leases, not total request lifetimes.
assert "constexpr uint32_t kHttpIdleNoProgressBudgetMs = 10000U;" in SOURCE
for upload in (
    section(SOURCE, "bool receiveNativeStorageBody", "void handleNativeLogRestore"),
    section(SOURCE, "void handleNativeLogRestore", "esp_err_t handleNativeStorageRequest"),
    section(SOURCE, "esp_err_t handleRawOtaUpload", "void serviceOtaRestart"),
):
    assert "lastProgressMs" in upload
    assert "lastProgressMs = millis()" in upload
    assert "httpd_req_recv" in upload

# Live state starts with a snapshot, advances by sequence-fenced deltas, and
# resnapshots every subscriber if a delta cannot be represented safely.
publisher = section(SERVER, "void livePublisherMain(void*) {", "esp_err_t serveLive")
assert "buildTopLevelJsonDelta" in publisher
assert "requireSnapshotForAllSubscribers()" in publisher
assert "previousLivePayload" in publisher
assert "kLivePublishIntervalMs" in SERVER
assert "httpd_ws_send_frame_async" in SERVER
assert "httpd_sess_trigger_close" in SERVER

print(f"firmware native HTTP transport contract: PASS ({chunk.group(1)}-byte chunks)")