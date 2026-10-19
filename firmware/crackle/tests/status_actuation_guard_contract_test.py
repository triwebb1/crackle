"""Full status remains available during actuation from an immutable snapshot."""
from pathlib import Path

ROOT = Path(__file__).parent.parent
SOURCE = (ROOT / "crackle" / "crackle.ino").read_text(encoding="utf-8")
SERVER = (ROOT / "crackle" / "sr800_network_server.cpp").read_text(encoding="utf-8")

start = SOURCE.index("size_t buildControllerStatusJson")
end = SOURCE.index("bool startCrackleHttpServer", start)
status = SOURCE[start:end]

assert "copyLiveStatusSnapshot()" in status
assert "status_suspended_during_actuation" not in status
assert "actuator.outputsActive()" not in status
assert "LittleFS" not in status
assert 'registerRoute("/api/status", HTTP_GET, queueStatus)' in SERVER
assert "JobType::STATUS" in SERVER
assert "else if (job->type == JobType::STATUS) serveStatus" in SERVER

print("firmware active status availability contract: PASS")