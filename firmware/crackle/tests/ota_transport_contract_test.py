"""Raw OTA is handler-owned, bounded by progress, and device-restarted."""
from pathlib import Path

ROOT = Path(__file__).parent.parent / "crackle"
SOURCE = (ROOT / "crackle.ino").read_text(encoding="utf-8")
SERVER = (ROOT / "sr800_network_server.cpp").read_text(encoding="utf-8")
PAGE = (ROOT / "sr800_web_pages.h").read_text(encoding="utf-8")


def section(start: str, end: str) -> str:
    begin = SOURCE.index(start)
    return SOURCE[begin:SOURCE.index(end, begin)]


upload = section("esp_err_t handleRawOtaUpload(httpd_req_t* request) {", "void serviceOtaRestart")
admission = section("bool requestOtaAdmission", "esp_err_t sendOtaJson")
failure = section("void resetFailedOtaAttempt", "esp_err_t failOtaUpload")
restart = section("void serviceOtaRestart", "void setNetworkCommandResponse")
loop = SOURCE[SOURCE.index("void loop()") :]
publish = section("void publishNetworkSnapshot", "LiveStatusSnapshot copyLiveStatusSnapshot")
setup = SOURCE[SOURCE.index("void setup()") : SOURCE.index("void loop()")]

# Rollback validation is delayed until the new image proves its health.
assert 'extern "C" bool verifyRollbackLater()' in SOURCE
assert section('extern "C" bool verifyRollbackLater()', 'namespace {').count('return true;') == 1
validation = section("void maybeValidateOtaImage", "}  // namespace")
assert "esp_ota_mark_app_valid_cancel_rollback() == ESP_OK" in validation
assert "otaUptimeFallbackAllowed" in validation
assert "httpServerRunning()" in validation

# OTA owns its request synchronously on the native HTTP handler. This is the
# only body stream not cloned into an async job; all other worker lanes remain.
assert 'registerRoute("/update", HTTP_POST, serveOtaDirect)' in SERVER
direct = SERVER[SERVER.index("esp_err_t serveOtaDirect"):SERVER.index("esp_err_t queueStorage")]
assert "serverConfig.handleOtaUpload(request)" in direct
assert "recordOtaHandlerStackLowWater" in direct
assert "kHttpServerStackBytes = 16384" in SERVER
for retired in ("otaQueue", "otaJob", "otaTask", "claimOtaJob", "queueOta(",
                '"crackle-ota"', "JobType::OTA &&"):
    assert retired not in SERVER, retired
assert "MALLOC_CAP_INTERNAL" in SERVER
assert "otaRequestHasRawContentType(request)" in upload
assert "request->content_len" in upload
assert "httpd_req_recv" in upload
assert "kOtaReceiveNoProgressMs" in upload
assert "lastProgressMs = millis()" in upload
for call in ("esp_ota_begin(", "esp_ota_write(", "esp_ota_end(", "esp_ota_set_boot_partition("):
    assert call in upload
preflight_receive = upload[
    upload.index("while (preflightUsed < sizeof(preflight))"):
    upload.index("if (!validOtaApplicationPrefix")
]
assert "httpd_req_recv" in preflight_receive
assert "receivedHasher.update" in preflight_receive
assert "esp_ota_begin" not in preflight_receive
assert "esp_ota_write" not in preflight_receive
assert upload.index("while (preflightUsed < sizeof(preflight))") < upload.index(
    "validOtaApplicationPrefix"
) < upload.index("esp_ota_begin") < upload.index("esp_ota_write")

# The server rejects a bootloader/wrong-chip/malformed first segment, hashes the
# received stream, finalizes it, then reads the exact inactive bytes back.
for required in (
    "validOtaApplicationPrefix",
    "ESP_CHIP_ID_ESP32S3",
    "ESP_APP_DESC_MAGIC_WORD",
    "firstSegment.data_len >= sizeof(esp_app_desc_t)",
    "receivedHasher.update",
    "hashOtaPartition",
    "esp_partition_read",
    "ota_flash_readback_mismatch",
    "receivedSha256",
    "flashSha256",
):
    assert required in SOURCE, required
assert upload.index("esp_ota_end(otaHandle)") < upload.index(
    "hashOtaPartition("
)
# The HTTP handler asks loopTask for idle admission; it never touches mutable actuation or storage state directly.
assert "requestOtaAdmission()" in upload and "waitForOtaAdmission()" in upload
for forbidden in ("actuatorFullyIdle()", "thermalLogActive", "storageMutationActive", "freezeCapture()", "detachSignalInterrupts()"):
    assert forbidden not in upload, forbidden
for required in ("actuatorFullyIdle()", "copyThermalLogState()", "recording.active",
                 "recording.unsaved", "storageMutationActive",
                 "storageRequestActive", "freezeCapture()", "detachSignalInterrupts()"):
    assert required in admission, required
assert "serviceOtaAdmission();" in loop

# ESP.getSketchSize() internally calls esp_image_verify(), which uses the same
# single global bootloader mapping as esp_ota_end(). Cache it once before the
# network starts; never race runtime status publication against OTA validation.
assert SOURCE.count("ESP.getSketchSize();") == 1
assert "next.appUsedBytes = cachedAppUsedBytes;" in publish
assert "ESP.getSketchSize()" not in publish
assert setup.index("cachedAppUsedBytes = ESP.getSketchSize();") < setup.index(
    "publishNetworkSnapshot(true);"
)

# Failed precommit updates release admission; selected images always reboot even
# if delivery of the success acknowledgement itself fails.
assert "esp_ota_abort(otaHandle);" in failure
assert "requestOtaRelease();" in failure
assert 'httpd_resp_set_hdr(request, "Connection", "close")' in SOURCE
assert "responseResult == ESP_OK ? ESP_FAIL" in SOURCE
assert "attachSignalInterrupts();" not in failure
assert upload.index("esp_ota_set_boot_partition") < upload.index("httpd_resp_send(")
assert upload.index("httpd_resp_send(") < upload.index("otaRestartPending = true")
assert "ESP.restart();" not in upload
assert "ESP.restart();" in restart
assert "serviceOtaRestart();" in loop

# The update page reports the installed image and sends the File directly.
assert 'id="currentVersion"' in PAGE
assert "fetch('/api/update/version'" in PAGE
assert "const selected=file.files[0];" in PAGE
assert "request.open('POST','/update');" in PAGE
assert "request.setRequestHeader('Content-Type','application/octet-stream');" in PAGE
assert "request.upload.onprogress" in PAGE and "request.send(selected)" in PAGE
assert "parsed.code,parsed.detail" in PAGE
assert "parsed.received_sha256" in PAGE
assert "parsed.flash_sha256" in PAGE
assert "FormData" not in PAGE and "multipart/form-data" not in PAGE

print("firmware native raw OTA transport contract: PASS")
