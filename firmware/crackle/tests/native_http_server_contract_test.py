"""Native HTTP parsing, workers, and mailbox ownership remain explicit."""
from pathlib import Path

ROOT = Path(__file__).parent.parent
HEADER = (ROOT / "crackle" / "sr800_network_server.h").read_text(encoding="utf-8")
SOURCE = (ROOT / "crackle" / "sr800_network_server.cpp").read_text(encoding="utf-8")
SKETCH = (ROOT / "crackle" / "crackle.ino").read_text(encoding="utf-8")

assert "httpd_req_async_handler_begin" in SOURCE
assert "httpd_req_async_handler_complete" in SOURCE
assert "kNormalWorkerCount = 2" in SOURCE
assert "kWorkerCount = kNormalWorkerCount + 1" in SOURCE
assert "xQueueCreate(kNormalWorkerCount" in SOURCE
assert "kAssetJobCount = 5" in SOURCE
assert "assetQueue = xQueueCreate(kAssetJobCount" in SOURCE
assert "stopQueue = xQueueCreate(1" in SOURCE
assert "kStorageJobCount = 3" in SOURCE
assert "storageQueue = xQueueCreate(kStorageJobCount, sizeof(StorageJob*))" in SOURCE
assert "StorageJob* job = claimStorageJob();" in SOURCE
assert "xQueueSend(storageQueue, &job, 0)" in SOURCE
assert 'workerMain, "crackle-assets"' in SOURCE
assert 'workerMain, "crackle-stop"' in SOURCE
assert 'registerRoute("/update", HTTP_POST, serveOtaDirect)' in SOURCE
assert "kHttpServerStackBytes = 16384" in SOURCE
assert "otaQueue" not in SOURCE and '"crackle-ota"' not in SOURCE
assert "xTaskCreatePinnedToCore" in SOURCE
assert "native.core_id = 0" in SOURCE
assert "kHttpOpenSocketCount = 8" in SOURCE
assert "native.max_open_sockets = kHttpOpenSocketCount" in SOURCE
assert "native.backlog_conn = 8" in SOURCE
assert "native.lru_purge_enable = true" in SOURCE
assert "native.keep_alive_enable = true" in SOURCE
assert "native.uri_match_fn = httpd_uri_match_wildcard" in SOURCE
assert "native.close_fn = closeNetworkSession" in SOURCE
close_callback = SOURCE[SOURCE.index("void closeNetworkSession"):SOURCE.index("esp_err_t handleLiveWebSocket")]
assert "removeSubscriber(socket)" in close_callback
assert "::close(socket)" in close_callback
assert 'registerRoute("/api/live", HTTP_GET, queueLive)' in SOURCE
assert 'registerRoute("/api/status", HTTP_GET, queueStatus)' in SOURCE
assert "requireSnapshotForAllSubscribers" in SOURCE
assert "xTaskCreatePinnedToCoreWithCaps" in SOURCE
assert "vTaskDeleteWithCaps" in SOURCE
assert "MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT" in SOURCE
assert 'liveWebSocket.uri = "/ws/live"' in SOURCE
assert "liveWebSocket.is_websocket = true" in SOURCE
assert "kSubscriberCount = 4" in SOURCE
assert "kLivePublishIntervalMs = 1000" in SOURCE
assert "buildTopLevelJsonDelta" in SOURCE
assert '"snapshot"' in SOURCE and '"delta"' in SOURCE
assert "httpd_sess_trigger_close" in SOURCE
assert "reconcileSubscribersWithServer" in SOURCE
assert "httpd_queue_work" in SOURCE
assert "reconcileSubscribersOnServerTask" in SOURCE
assert "kAssetWorkerStackBytes = 5120" in SOURCE
assert "livePublisherStackLowWaterBytes" in SOURCE
assert "httpd_get_client_list" in SOURCE
assert "httpd_ws_get_fd_info" in SOURCE
assert "lastSuccessfulSendMs" in SOURCE
assert "A newly opened browser wins" in SOURCE
assert "subscriberEvictionAllowed" in SOURCE
assert "Four healthy" in SOURCE
assert 'httpd_resp_set_hdr(request, "Retry-After", "1")' in SOURCE

asset = SOURCE[SOURCE.index("void serveAsset"):SOURCE.index("bool receiveCommandBody")]
assert "kTransferChunkBytes" in asset
assert "httpd_resp_send_chunk" in asset
queue_asset = SOURCE[SOURCE.index("esp_err_t queueAsset"):SOURCE.index("esp_err_t queueLive")]
assert "claimAssetJob" in queue_asset
assert "assetQueue" in queue_asset

command = SOURCE[SOURCE.index("void serveCommand"):SOURCE.index("void workerMain")]
assert "CommandPriority::STOP" in command
assert "submitAndWait" in command
assert "X-Crackle-Request-Id" in command
assert "X-Crackle-State-Revision" in command
assert "Reconcile current state before retrying" in command
assert "kStorageBusyRetryCount = 12" in SOURCE
assert "kStorageBusyRetryDelayMs = 250" in SOURCE
assert "response.retryStorageBusy" in command
assert "vTaskDelay(pdMS_TO_TICKS(kStorageBusyRetryDelayMs))" in command
assert 'httpd_resp_set_hdr(job.request, "Retry-After", "1")' in command
assert "const uint32_t commandStopGeneration = job.stopGeneration;" in command
assert "job.formUrlEncoded, commandStopGeneration" in command

queue_stop = SOURCE[SOURCE.index("esp_err_t queueStop"):SOURCE.index("esp_err_t serveOtaDirect")]
assert queue_stop.index("invalidateActuationStartsForStop();") < queue_stop.index(
    "enqueueAsync(request, job, stopQueue)"
)
assert "job->stopGeneration = stopGenerationSnapshot();" in queue_stop
queue_storage = SOURCE[SOURCE.index("esp_err_t queueStorage"):SOURCE.index("esp_err_t queueCommand")]
assert "kStorageJobCount = 3" in SOURCE
assert "claimStorageJob" in queue_storage
assert "storageQueue" in queue_storage
assert queue_storage.count('"Retry-After", "1"') == 2

queue_command = SOURCE[SOURCE.index("esp_err_t queueCommand"):SOURCE.index("void serveAsset")]
# Every Stop-class POST is diverted to the reserved Stop lane before a normal
# job is claimed, keeps its real path and query, and runs at STOP priority.
assert queue_command.index("if (requestIsStopCommand(request)) return queueStop(request);") < queue_command.index(
    "claimJob()"
)
assert "return isStopCommandUri(path);" in queue_stop
assert "request->method != HTTP_POST" in queue_stop
assert 'strlcpy(job->uri, "/api/stop"' not in queue_stop
assert "memcpy(job->uri, request->uri, pathLength);" in queue_stop
assert "httpd_req_get_url_query_str(" in queue_stop
assert "job.method == CommandMethod::POST && isStopCommandUri(job.uri)" in command
assert 'strcmp(job.uri, "/api/stop") == 0' not in command
assert "job->stopGeneration = stopGenerationSnapshot();" in queue_command
assert queue_command.index("job->stopGeneration = stopGenerationSnapshot();") < queue_command.index(
    "enqueueAsync(request, job)"
)

assert "beginHttpServer" in HEADER
assert "stopHttpServer" in HEADER
print("native HTTP server contract: PASS")

assert 'EmbeddedAsset assets[5]' in HEADER
assert 'registerRoute(config.assets[3].path' in SOURCE
assert 'registerRoute(config.assets[4].path' in SOURCE
assert 'registerRoute("/api/update/version", HTTP_GET, queueOtaVersion)' in SOURCE
assert '"/probe"' in SKETCH
