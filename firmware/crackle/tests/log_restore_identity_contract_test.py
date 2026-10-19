"""Raw recording restore preserves provenance while assigning local identity."""
from pathlib import Path

SOURCE = (Path(__file__).parent.parent / "crackle" / "crackle.ino").read_text(encoding="utf-8")


def section(start: str, end: str) -> str:
    left = SOURCE.index(start)
    return SOURCE[left:SOURCE.index(end, left + len(start))]


upload = section("void handleNativeLogRestore()", "esp_err_t handleNativeStorageRequest")
assert "nativeRequestHasRawContentType(nativeStorageRequest)" in upload
assert "application/octet-stream" in upload
assert 'requestedId == "auto"' in upload
assert "logRestoreUpload.autoAllocate = autoAllocate" in upload
assert "logRestoreUpload.replacing = LittleFS.exists(path)" in upload
assert "httpd_req_recv" in upload
assert "lastProgressMs = millis()" in upload

remap = section("bool remapRestoredArchiveAddress", "size_t readLogRestoreFile")
assert "header.logId = destinationLogId" in remap
assert "originLogId" not in remap
assert "archiveIntegrityCrcBegin(header)" in remap
assert "header.crc32 = sr800::logcodec::crc32Finish(crc)" in remap

restore = section("void handleLogRestore()", "bool parseFiniteFloatArg")
assert "const uint32_t originLogId = summary.originLogId" in restore
assert "const uint32_t destinationLogId = nextLogArchiveId()" in restore
assert "remapRestoredArchiveAddress(destinationLogId)" in restore
assert "remappedSummary.originLogId != originLogId" in restore
assert restore.index("remapRestoredArchiveAddress") < restore.index("LittleFS.rename")
for field in ("recorded_on", "recording_origin", "storage_address"):
    assert field in restore, field
assert "formatStableDeviceId(currentDeviceId" in restore

print("firmware log restore identity contract: PASS")