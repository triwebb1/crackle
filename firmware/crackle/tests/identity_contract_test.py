"""Stable device/model identity comes from the immutable status snapshot."""
from pathlib import Path

SOURCE = (Path(__file__).parent.parent / "crackle" / "crackle.ino").read_text(encoding="utf-8")
start = SOURCE.index("size_t buildControllerStatusJson(")
end = SOURCE.index("bool startCrackleHttpServer()", start)
status = SOURCE[start:end]

assert 'kRoasterModelId[] = "freshroast-sr800"' in SOURCE
assert 'kRoasterDisplayName[] = "FreshRoast SR800"' in SOURCE
assert "const LiveStatusSnapshot source = copyLiveStatusSnapshot();" in status
assert "formatStableDeviceId(stableDeviceId" in status
assert "ESP.getEfuseMac()" in SOURCE
assert '"esp32-%012llx"' in SOURCE
for key in ("roaster", "device_id", "model_id", "display_name", "simulated", "false"):
    assert key in status, key
print("firmware stable identity contract: PASS")