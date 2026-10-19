#include "sr800_network_server.h"

#include <algorithm>
#include <stdio.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>

#include "esp_http_server.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "sr800_network_policy.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/idf_additions.h"
#include "freertos/task.h"
#include "sr800_live_delta.h"
#include "sr800_network_mailbox.h"

namespace sr800::network {
namespace {

constexpr size_t kNormalWorkerCount = 2;
constexpr size_t kAssetJobCount = 5;
constexpr size_t kStorageJobCount = 3;
constexpr size_t kWorkerCount = kNormalWorkerCount + 1;
constexpr size_t kStopWorkerIndex = kWorkerCount - 1;
constexpr size_t kCommandWorkerStackBytes = 12288;
constexpr size_t kAssetWorkerStackBytes = 5120;
// Bulk storage runs from internal SRAM because LittleFS can disable the flash cache. Measured
// reserves on the LittleFS paths: 528 bytes of an 8 KB stack while archive import and document
// promotion were active (followed by an ESP_RST_PANIC reboot and an unacknowledged run write), and
// 2,740 bytes of 12 KB in a session with document writes. 16 KB retains a full 4 KB safety margin
// rather than letting ordinary calibration imports approach stack exhaustion.
constexpr size_t kStorageWorkerStackBytes = 16384;
constexpr size_t kStorageRouteBytes = 48;
constexpr size_t kLivePublisherStackBytes = 6144;
// OTA stays in its registered URI handler from receive through verification.
// There is no separate OTA worker; its stack budget goes to this internal-SRAM HTTP daemon.
constexpr size_t kHttpServerStackBytes = 16384;
constexpr size_t kHttpOpenSocketCount = 8;
constexpr size_t kTransferChunkBytes = 4096;
constexpr size_t kLivePayloadBytes = 3072;
// 12 KB: an estimated worst case (calibration steps, boot history, a full stored-crash backtrace,
// journey zones, fault reasons) reaches ~7 KB, which leaves 8 KB too thin, and an overflow fails
// status for every client. Two PSRAM buffers, so the headroom costs no internal RAM.
constexpr size_t kStatusPayloadBytes = 12288;
constexpr size_t kLiveFrameBytes = 3584;
constexpr size_t kSubscriberCount = 4;
constexpr uint32_t kLivePublishIntervalMs = 1000;
constexpr uint32_t kNormalCommandWaitMs = 6000;
constexpr uint32_t kStopCommandWaitMs = 3000;
constexpr uint32_t kCommandReceiveNoProgressMs = 10000;
// A controller response explicitly marked storage-busy guarantees no start
// side effect occurred. Keep the original browser request open and retry on a
// network worker while the already-running transfer drains; never replay a
// timeout, ambiguous response, or any other mutation failure.
// 12 x 250 ms = 3 s outlasts one full library transfer (see
// kActuationStartStoragePriorityMs in crackle.ino), so a Start that collides with a
// reconnecting browser's hydration is admitted once that transfer finishes instead
// of surfacing "storage busy" to the operator after 1 s.
constexpr uint8_t kStorageBusyRetryCount = 12;
constexpr uint32_t kStorageBusyRetryDelayMs = 250;

enum class JobType : uint8_t { ASSET = 0, LIVE, STATUS, OTA_VERSION, COMMAND, STORAGE };

struct AsyncJob {
  bool claimed = false;
  JobType type = JobType::ASSET;
  httpd_req_t* request = nullptr;
  const EmbeddedAsset* asset = nullptr;
  CommandMethod method = CommandMethod::GET;
  char uri[kCommandUriBytes] = {};
  char query[kCommandQueryBytes] = {};
  uint8_t body[kCommandBodyBytes + 1] = {};
  size_t bodyLength = 0;
  bool formUrlEncoded = false;
  char* statusPayload = nullptr;
  uint32_t stopGeneration = 0;
};

struct StorageJob {
  bool claimed = false;
  httpd_req_t* request = nullptr;
};

HttpServerConfig serverConfig;
httpd_handle_t server = nullptr;
QueueHandle_t workQueue = nullptr;
QueueHandle_t assetQueue = nullptr;
QueueHandle_t stopQueue = nullptr;
QueueHandle_t storageQueue = nullptr;
TaskHandle_t workerTasks[kWorkerCount] = {};
TaskHandle_t assetTask = nullptr;
TaskHandle_t storageTask = nullptr;
TaskHandle_t livePublisherTask = nullptr;
AsyncJob* jobs = nullptr;
AsyncJob* assetJobs = nullptr;
AsyncJob* stopJob = nullptr;
StorageJob* storageJobs = nullptr;
char* statusPayloads = nullptr;
portMUX_TYPE jobMux = portMUX_INITIALIZER_UNLOCKED;
portMUX_TYPE subscriberMux = portMUX_INITIALIZER_UNLOCKED;
portMUX_TYPE diagnosticsMux = portMUX_INITIALIZER_UNLOCKED;
volatile uint32_t rejectedRequests = 0;
uint32_t workerFailures = 0;
uint32_t workerStackLowWater = UINT32_MAX;
uint32_t storageStackLowWater = UINT32_MAX;
uint32_t otaHandlerStackLowWater = UINT32_MAX;
uint32_t livePublisherStackLowWater = UINT32_MAX;
bool subscriberReconcileQueued = false;
volatile uint32_t publishedLiveSnapshots = 0;
volatile uint32_t publishedLiveDeltas = 0;
volatile uint32_t failedLiveSends = 0;
uint32_t nextLiveSequence = 1;
char* previousLivePayload = nullptr;
char* currentLivePayload = nullptr;
char* liveFramePayload = nullptr;
const char* lastStartFailure = "not attempted";

bool failStart(const char* reason) {
  lastStartFailure = reason;
  return false;
}

void noteWorkerFailure() {
  portENTER_CRITICAL(&diagnosticsMux);
  ++workerFailures;
  portEXIT_CRITICAL(&diagnosticsMux);
}

void recordStackLowWater(uint32_t lowWater, bool storage) {
  portENTER_CRITICAL(&diagnosticsMux);
  uint32_t& aggregate = storage ? storageStackLowWater : workerStackLowWater;
  if (lowWater < aggregate) aggregate = lowWater;
  portEXIT_CRITICAL(&diagnosticsMux);
}

// Which storage request (or the idle service pass) set the storage low-water, so the
// deepest path is named instead of guessed.
char storageLowWaterRoute[kStorageRouteBytes] = "none";
void recordStorageStackLowWater(const char* route) {
  const uint32_t lowWater =
      static_cast<uint32_t>(uxTaskGetStackHighWaterMark2(nullptr));
  portENTER_CRITICAL(&diagnosticsMux);
  if (lowWater < storageStackLowWater) {
    storageStackLowWater = lowWater;
    strlcpy(storageLowWaterRoute, route, sizeof(storageLowWaterRoute));
  }
  portEXIT_CRITICAL(&diagnosticsMux);
}
void storageLowWaterRouteSnapshot(char* out, size_t capacity) {
  portENTER_CRITICAL(&diagnosticsMux);
  strlcpy(out, storageLowWaterRoute, capacity);
  portEXIT_CRITICAL(&diagnosticsMux);
}

// The slowest storage request's handler time (reading, flash work, and sending the
// response) and its route. A request the browser saw take seconds but the roaster handled quickly
// was delayed on the network, not in storage.
uint32_t storageSlowestRequestMs = 0;
uint32_t storageRequestsOverOneSecond = 0;
char storageSlowestRequestRoute[kStorageRouteBytes] = "none";
void recordStorageRequestDuration(const char* route, uint32_t elapsedMs) {
  portENTER_CRITICAL(&diagnosticsMux);
  if (elapsedMs >= 1000) ++storageRequestsOverOneSecond;
  if (elapsedMs > storageSlowestRequestMs) {
    storageSlowestRequestMs = elapsedMs;
    strlcpy(storageSlowestRequestRoute, route, sizeof(storageSlowestRequestRoute));
  }
  portEXIT_CRITICAL(&diagnosticsMux);
}
void storageSlowestSnapshot(uint32_t& elapsedMs, uint32_t& overOneSecond, char* route, size_t capacity) {
  portENTER_CRITICAL(&diagnosticsMux);
  elapsedMs = storageSlowestRequestMs;
  overOneSecond = storageRequestsOverOneSecond;
  strlcpy(route, storageSlowestRequestRoute, capacity);
  portEXIT_CRITICAL(&diagnosticsMux);
}

uint32_t assetStackLowWater = UINT32_MAX;
uint32_t commandStackLowWater = UINT32_MAX;
void recordWorkerPoolLowWater(uint32_t lowWater, bool asset) {
  portENTER_CRITICAL(&diagnosticsMux);
  uint32_t& pool = asset ? assetStackLowWater : commandStackLowWater;
  if (lowWater < pool) pool = lowWater;
  portEXIT_CRITICAL(&diagnosticsMux);
}
uint32_t poolLowWaterSnapshot(bool asset) {
  portENTER_CRITICAL(&diagnosticsMux);
  const uint32_t value = asset ? assetStackLowWater : commandStackLowWater;
  portEXIT_CRITICAL(&diagnosticsMux);
  return value;
}

void recordOtaHandlerStackLowWater(uint32_t lowWater) {
  portENTER_CRITICAL(&diagnosticsMux);
  if (lowWater < otaHandlerStackLowWater) otaHandlerStackLowWater = lowWater;
  portEXIT_CRITICAL(&diagnosticsMux);
}

void recordLivePublisherStackLowWater(uint32_t lowWater) {
  portENTER_CRITICAL(&diagnosticsMux);
  if (lowWater < livePublisherStackLowWater) {
    livePublisherStackLowWater = lowWater;
  }
  portEXIT_CRITICAL(&diagnosticsMux);
}

uint32_t workerFailureSnapshot() {
  portENTER_CRITICAL(&diagnosticsMux);
  const uint32_t snapshot = workerFailures;
  portEXIT_CRITICAL(&diagnosticsMux);
  return snapshot;
}

uint32_t stackLowWaterSnapshot(bool storage) {
  portENTER_CRITICAL(&diagnosticsMux);
  const uint32_t snapshot = storage ? storageStackLowWater : workerStackLowWater;
  portEXIT_CRITICAL(&diagnosticsMux);
  return snapshot;
}

uint32_t otaHandlerStackLowWaterSnapshot() {
  portENTER_CRITICAL(&diagnosticsMux);
  const uint32_t snapshot = otaHandlerStackLowWater;
  portEXIT_CRITICAL(&diagnosticsMux);
  return snapshot;
}

uint32_t livePublisherStackLowWaterSnapshot() {
  portENTER_CRITICAL(&diagnosticsMux);
  const uint32_t snapshot = livePublisherStackLowWater;
  portEXIT_CRITICAL(&diagnosticsMux);
  return snapshot;
}

struct Subscriber {
  int socket = -1;
  bool active = false;
  bool needsSnapshot = true;
  uint8_t channels = 1;
  uint32_t lastSequence = 0;
  uint32_t lastSuccessfulSendMs = 0;
};

Subscriber subscribers[kSubscriberCount];

const char* statusText(int status) {
  switch (status) {
    case 200: return "200 OK";
    case 202: return "202 Accepted";
    case 307: return "307 Temporary Redirect";
    case 400: return "400 Bad Request";
    case 408: return "408 Request Timeout";
    case 404: return "404 Not Found";
    case 405: return "405 Method Not Allowed";
    case 409: return "409 Conflict";
    case 413: return "413 Content Too Large";
    case 414: return "414 URI Too Long";
    case 415: return "415 Unsupported Media Type";
    case 423: return "423 Locked";
    case 429: return "429 Too Many Requests";
    case 500: return "500 Internal Server Error";
    case 501: return "501 Not Implemented";
    case 503: return "503 Service Unavailable";
    case 504: return "504 Gateway Timeout";
    case 507: return "507 Insufficient Storage";
    default: return "500 Internal Server Error";
  }
}

void* allocateNetworkMemory(size_t count, size_t bytes) {
  void* allocation = heap_caps_calloc(
      count, bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (allocation != nullptr) return allocation;
  return heap_caps_calloc(
      count, bytes, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
}

esp_err_t sendError(httpd_req_t* request, int status, const char* message) {
  char body[256] = {};
  const int length = snprintf(body, sizeof(body),
      "{\"ok\":false,\"message\":\"%s\"}", message);
  httpd_resp_set_status(request, statusText(status));
  httpd_resp_set_type(request, "application/json");
  httpd_resp_set_hdr(request, "Cache-Control", "no-store");
  if (status == 503) httpd_resp_set_hdr(request, "Retry-After", "1");
  return httpd_resp_send(request, body,
      length > 0 && static_cast<size_t>(length) < sizeof(body) ? length : 0);
}

bool requestHasUrlEncodedForm(httpd_req_t* request) {
  char contentType[96] = {};
  if (request == nullptr || httpd_req_get_hdr_value_str(
          request, "Content-Type", contentType, sizeof(contentType)) != ESP_OK) {
    return false;
  }
  static constexpr char expected[] = "application/x-www-form-urlencoded";
  return strncasecmp(contentType, expected, sizeof(expected) - 1) == 0 &&
      (contentType[sizeof(expected) - 1] == 0 ||
       contentType[sizeof(expected) - 1] == ';');
}

AsyncJob* claimJob() {
  if (jobs == nullptr) return nullptr;
  portENTER_CRITICAL(&jobMux);
  for (size_t index = 0; index < kNormalWorkerCount; ++index) {
    AsyncJob& job = jobs[index];
    if (job.claimed) continue;
    job.claimed = true;
    portEXIT_CRITICAL(&jobMux);
    job.request = nullptr;
    job.asset = nullptr;
    job.uri[0] = 0;
    job.query[0] = 0;
    job.bodyLength = 0;
    return &job;
  }
  ++rejectedRequests;
  portEXIT_CRITICAL(&jobMux);
  return nullptr;
}

AsyncJob* claimAssetJob() {
  if (assetJobs == nullptr) return nullptr;
  portENTER_CRITICAL(&jobMux);
  for (size_t index = 0; index < kAssetJobCount; ++index) {
    AsyncJob& job = assetJobs[index];
    if (job.claimed) continue;
    job.claimed = true;
    portEXIT_CRITICAL(&jobMux);
    job.request = nullptr;
    job.asset = nullptr;
    job.uri[0] = 0;
    job.query[0] = 0;
    job.bodyLength = 0;
    return &job;
  }
  ++rejectedRequests;
  portEXIT_CRITICAL(&jobMux);
  return nullptr;
}

AsyncJob* claimStopJob() {
  if (stopJob == nullptr) return nullptr;
  AsyncJob& job = *stopJob;
  portENTER_CRITICAL(&jobMux);
  if (job.claimed) {
    ++rejectedRequests;
    portEXIT_CRITICAL(&jobMux);
    return nullptr;
  }
  job.claimed = true;
  portEXIT_CRITICAL(&jobMux);
  job.request = nullptr;
  job.asset = nullptr;
  job.uri[0] = 0;
  job.query[0] = 0;
  job.bodyLength = 0;
  return &job;
}
void releaseJob(AsyncJob* job) {
  if (job == nullptr) return;
  // Async command bodies can contain Wi-Fi credentials. Scrub the worker copy
  // before publishing the static job as reusable.
  volatile uint8_t* body = job->body;
  for (size_t index = 0; index < job->bodyLength; ++index) body[index] = 0;
  job->body[0] = 0;
  job->bodyLength = 0;
  job->formUrlEncoded = false;
  job->stopGeneration = 0;
  portENTER_CRITICAL(&jobMux);
  job->claimed = false;
  portEXIT_CRITICAL(&jobMux);
}

void releaseStorageJob(StorageJob* job) {
  if (job == nullptr) return;
  job->request = nullptr;
  portENTER_CRITICAL(&jobMux);
  job->claimed = false;
  portEXIT_CRITICAL(&jobMux);
}

StorageJob* claimStorageJob() {
  if (storageJobs == nullptr) return nullptr;
  portENTER_CRITICAL(&jobMux);
  for (size_t index = 0; index < kStorageJobCount; ++index) {
    if (storageJobs[index].claimed) continue;
    storageJobs[index].claimed = true;
    portEXIT_CRITICAL(&jobMux);
    storageJobs[index].request = nullptr;
    return &storageJobs[index];
  }
  ++rejectedRequests;
  portEXIT_CRITICAL(&jobMux);
  return nullptr;
}
esp_err_t enqueueAsync(httpd_req_t* original, AsyncJob* job,
                       QueueHandle_t destination = workQueue) {
  if (job == nullptr) {
    return sendError(original, 503,
        "The network workers are busy. Retry shortly.");
  }
  if (httpd_req_async_handler_begin(original, &job->request) != ESP_OK) {
    noteWorkerFailure();
    releaseJob(job);
    return sendError(original, 503,
        "The request could not leave the listener safely.");
  }
  if (xQueueSend(destination, &job, 0) != pdTRUE) {
    noteWorkerFailure();
    sendError(job->request, 503, "The network work queue is full.");
    httpd_req_async_handler_complete(job->request);
    releaseJob(job);
  }
  return ESP_OK;
}

esp_err_t serveLive(httpd_req_t* request);
esp_err_t serveStatus(AsyncJob& job);

esp_err_t queueAsset(httpd_req_t* request) {
  AsyncJob* job = claimAssetJob();
  if (job == nullptr) return enqueueAsync(request, nullptr);
  job->type = JobType::ASSET;
  job->asset = static_cast<const EmbeddedAsset*>(request->user_ctx);
  return enqueueAsync(request, job, assetQueue);
}

esp_err_t queueLive(httpd_req_t* request) {
  AsyncJob* job = claimJob();
  if (job == nullptr) return enqueueAsync(request, nullptr);
  job->type = JobType::LIVE;
  return enqueueAsync(request, job);
}

esp_err_t queueStatus(httpd_req_t* request) {
  AsyncJob* job = claimJob();
  if (job == nullptr) return enqueueAsync(request, nullptr);
  job->type = JobType::STATUS;
  return enqueueAsync(request, job);
}

esp_err_t queueOtaVersion(httpd_req_t* request) {
  AsyncJob* job = claimJob();
  if (job == nullptr) return enqueueAsync(request, nullptr);
  job->type = JobType::OTA_VERSION;
  return enqueueAsync(request, job);
}

bool isStopCommandUri(const char* uri) {
  return uri != nullptr &&
      (strcmp(uri, "/api/stop") == 0 ||
       strcmp(uri, "/api/manual/stop") == 0 ||
       strcmp(uri, "/api/calibration/stop") == 0 ||
       strcmp(uri, "/api/fan-test/stop") == 0 ||
       strcmp(uri, "/api/heater-proof/stop") == 0 ||
       strcmp(uri, "/api/roast/stop") == 0);
}

esp_err_t queueStop(httpd_req_t* request) {
  // Every Stop-class POST (/api/stop and the per-mode */stop routes) uses the
  // reserved Stop job, queue, worker, and mailbox slot so a saturated normal
  // pool can never refuse it. Invalidate sleeping and already-queued starts at
  // Stop admission, before the dedicated Stop worker waits for the loop.
  invalidateActuationStartsForStop();
  AsyncJob* job = claimStopJob();
  if (job == nullptr) {
    return sendError(request, 503, "A Stop request is already pending.");
  }
  job->type = JobType::COMMAND;
  job->method = CommandMethod::POST;
  job->stopGeneration = stopGenerationSnapshot();
  const size_t pathLength = strcspn(request->uri, "?");
  if (pathLength == 0 || pathLength >= sizeof(job->uri)) {
    releaseJob(job);
    return sendError(request, 414, "The request path is too long.");
  }
  memcpy(job->uri, request->uri, pathLength);
  job->uri[pathLength] = 0;
  const size_t queryLength = httpd_req_get_url_query_len(request);
  if (queryLength >= sizeof(job->query) ||
      (queryLength > 0 && httpd_req_get_url_query_str(
          request, job->query, sizeof(job->query)) != ESP_OK)) {
    releaseJob(job);
    return sendError(request, 400, "The Stop query is invalid.");
  }
  if (request->content_len > kCommandBodyBytes) {
    releaseJob(job);
    return sendError(request, 413, "The Stop body is too large.");
  }
  if (request->content_len > 0 && requestHasUrlEncodedForm(request)) {
    job->formUrlEncoded = true;
  }
  return enqueueAsync(request, job, stopQueue);
}

bool requestIsStopCommand(httpd_req_t* request) {
  if (request == nullptr || request->method != HTTP_POST) return false;
  char path[kCommandUriBytes] = {};
  const size_t pathLength = strcspn(request->uri, "?");
  if (pathLength == 0 || pathLength >= sizeof(path)) return false;
  memcpy(path, request->uri, pathLength);
  path[pathLength] = 0;
  return isStopCommandUri(path);
}
esp_err_t serveOtaDirect(httpd_req_t* request) {
  if (serverConfig.handleOtaUpload == nullptr) {
    return sendError(request, 501, "Firmware update routing is unavailable.");
  }
  // Keep httpd_req_recv() in the URI-handler task that owns this request.
  // Admission guarantees idle outputs/storage while port 80 is reserved.
  const esp_err_t result = serverConfig.handleOtaUpload(request);
  recordOtaHandlerStackLowWater(
      static_cast<uint32_t>(uxTaskGetStackHighWaterMark2(nullptr)));
  return result;
}

esp_err_t queueStorage(httpd_req_t* request) {
  StorageJob* job = claimStorageJob();
  if (job == nullptr) {
    httpd_resp_set_hdr(request, "Retry-After", "1");
    return sendError(request, 503,
        "The storage request queue is full. Retry shortly.");
  }
  if (httpd_req_async_handler_begin(request, &job->request) != ESP_OK) {
    noteWorkerFailure();
    releaseStorageJob(job);
    return sendError(request, 503,
        "The storage request could not leave the listener safely.");
  }
  if (xQueueSend(storageQueue, &job, 0) != pdTRUE) {
    noteWorkerFailure();
    httpd_resp_set_hdr(job->request, "Retry-After", "1");
    sendError(job->request, 503, "The storage request queue is full.");
    httpd_req_async_handler_complete(job->request);
    releaseStorageJob(job);
  }
  return ESP_OK;
}
esp_err_t queueCommand(httpd_req_t* request) {
  // Route Stop-class paths to the reserved lane BEFORE claiming a normal job:
  // a full normal pool must never refuse a Stop.
  if (requestIsStopCommand(request)) return queueStop(request);
  AsyncJob* job = claimJob();
  if (job == nullptr) return enqueueAsync(request, nullptr);
  job->type = JobType::COMMAND;
  job->method = request->method == HTTP_POST
      ? CommandMethod::POST : CommandMethod::GET;
  const size_t pathLength = strcspn(request->uri, "?");
  if (pathLength == 0 || pathLength >= sizeof(job->uri)) {
    releaseJob(job);
    return sendError(request, 414, "The request path is too long.");
  }
  memcpy(job->uri, request->uri, pathLength);
  job->uri[pathLength] = 0;
  if (isStopCommandUri(job->uri)) invalidateActuationStartsForStop();
  job->stopGeneration = stopGenerationSnapshot();
  const size_t queryLength = httpd_req_get_url_query_len(request);
  if (queryLength >= sizeof(job->query)) {
    releaseJob(job);
    return sendError(request, 413, "The command query is too large.");
  }
  if (queryLength > 0 && httpd_req_get_url_query_str(
          request, job->query, sizeof(job->query)) != ESP_OK) {
    releaseJob(job);
    return sendError(request, 400, "The command query is invalid.");
  }
  if (request->content_len > kCommandBodyBytes) {
    releaseJob(job);
    return sendError(request, 413, "The command body is too large.");
  }
  if (request->content_len > 0) {
    if (!requestHasUrlEncodedForm(request)) {
      releaseJob(job);
      return sendError(request, 415,
          "Command bodies must use application/x-www-form-urlencoded.");
    }
    job->formUrlEncoded = true;
  }
  return enqueueAsync(request, job);
}

void serveAsset(AsyncJob& job) {
  const EmbeddedAsset* asset = job.asset;
  if (asset == nullptr || asset->bytes == nullptr || asset->length == 0) {
    sendError(job.request, 500, "The embedded asset is unavailable.");
    return;
  }
  httpd_resp_set_type(job.request, asset->contentType);
  httpd_resp_set_hdr(job.request, "Cache-Control", asset->cacheControl);
  if (asset->gzip) httpd_resp_set_hdr(job.request, "Content-Encoding", "gzip");
  size_t offset = 0;
  while (offset < asset->length) {
    const size_t count = std::min(kTransferChunkBytes, asset->length - offset);
    if (httpd_resp_send_chunk(job.request,
            reinterpret_cast<const char*>(asset->bytes + offset), count) !=
        ESP_OK) {
      noteWorkerFailure();
      return;
    }
    offset += count;
  }
  if (httpd_resp_send_chunk(job.request, nullptr, 0) != ESP_OK) {
    noteWorkerFailure();
  }
}

bool receiveCommandBody(AsyncJob& job) {
  size_t received = 0;
  TickType_t lastProgress = xTaskGetTickCount();
  while (received < job.request->content_len) {
    const int result = httpd_req_recv(job.request,
        reinterpret_cast<char*>(job.body + received),
        job.request->content_len - received);
    if (result == HTTPD_SOCK_ERR_TIMEOUT) {
      if (xTaskGetTickCount() - lastProgress <
          pdMS_TO_TICKS(kCommandReceiveNoProgressMs)) continue;
      return false;
    }
    if (result <= 0) return false;
    received += static_cast<size_t>(result);
    job.bodyLength = received;
    lastProgress = xTaskGetTickCount();
  }
  job.body[received] = 0;
  job.bodyLength = received;
  return true;
}

void serveCommand(AsyncJob& job) {
  if (!receiveCommandBody(job)) {
    sendError(job.request, 400, "The command body was interrupted.");
    return;
  }
  const CommandPriority priority =
      job.method == CommandMethod::POST && isStopCommandUri(job.uri)
      ? CommandPriority::STOP : CommandPriority::NORMAL;
  const uint32_t waitMs = priority == CommandPriority::STOP
      ? kStopCommandWaitMs : kNormalCommandWaitMs;
  CommandResponse response;
  uint32_t requestId = 0;
  const uint32_t commandStopGeneration = job.stopGeneration;

  for (uint8_t attempt = 0;; ++attempt) {
    CommandSlot* slot = acquire(priority, job.method, job.uri, job.query,
                                job.body, job.bodyLength,
                                job.formUrlEncoded, commandStopGeneration);
    if (slot == nullptr) {
      sendError(job.request, 503,
          priority == CommandPriority::STOP
              ? "A Stop command is already pending."
              : "Another command is being committed. Retry shortly.");
      return;
    }
    requestId = request(slot).id;
    response = {};
    if (!submitAndWait(slot, waitMs, response)) {
      char id[16] = {};
      snprintf(id, sizeof(id), "%lu",
               static_cast<unsigned long>(requestId));
      httpd_resp_set_hdr(job.request, "X-Crackle-Request-Id", id);
      sendError(job.request, 504,
          "The controller did not acknowledge this command in time. Reconcile current state before retrying.");
      return;
    }
    if (!response.retryStorageBusy ||
        attempt >= kStorageBusyRetryCount) break;
    vTaskDelay(pdMS_TO_TICKS(kStorageBusyRetryDelayMs));
  }

  char id[16] = {};
  char revision[24] = {};
  snprintf(id, sizeof(id), "%lu", static_cast<unsigned long>(requestId));
  snprintf(revision, sizeof(revision), "%llu",
           static_cast<unsigned long long>(response.stateRevision));
  httpd_resp_set_hdr(job.request, "X-Crackle-Request-Id", id);
  httpd_resp_set_hdr(job.request, "X-Crackle-State-Revision", revision);
  if (response.retryStorageBusy) {
    httpd_resp_set_hdr(job.request, "Retry-After", "1");
  }
  httpd_resp_set_hdr(job.request, "Cache-Control", "no-store");
  httpd_resp_set_status(job.request, statusText(response.status));
  httpd_resp_set_type(job.request, response.contentType);
  if (httpd_resp_send(job.request, response.body,
                      response.bodyLength) != ESP_OK) {
    noteWorkerFailure();
  }
}

// "POST /api/data/runs/run-x" without the query, restricted to characters that are safe inside a
// JSON string.
void describeStorageRoute(httpd_req_t* request, char* out, size_t capacity) {
  const char* method = request->method == HTTP_GET ? "GET "
      : request->method == HTTP_POST ? "POST "
      : request->method == HTTP_DELETE ? "DELETE " : "OTHER ";
  size_t used = strlcpy(out, method, capacity);
  for (const char* cursor = request->uri; *cursor != '\0' && *cursor != '?' &&
                                          used + 1 < capacity; ++cursor) {
    const char c = *cursor;
    out[used++] = (c > 0x20 && c < 0x7f && c != '"' && c != '\\') ? c : '-';
  }
  out[used < capacity ? used : capacity - 1] = '\0';
}

void storageMain(void*) {
  while (true) {
    StorageJob* job = nullptr;
    const BaseType_t received = xQueueReceive(
        storageQueue, &job, pdMS_TO_TICKS(250));
    if (received == pdTRUE && job != nullptr) {
      char route[kStorageRouteBytes];
      describeStorageRoute(job->request, route, sizeof(route));
      const int64_t startedUs = esp_timer_get_time();
      if (serverConfig.handleStorageRequest == nullptr) {
        sendError(job->request, 501, "Storage routing is unavailable.");
      } else if (serverConfig.handleStorageRequest(job->request) != ESP_OK) {
        noteWorkerFailure();
      }
      httpd_req_async_handler_complete(job->request);
      releaseStorageJob(job);
      recordStorageRequestDuration(
          route, static_cast<uint32_t>((esp_timer_get_time() - startedUs) / 1000));
      recordStorageStackLowWater(route);
    }
    if (serverConfig.serviceStorage != nullptr) serverConfig.serviceStorage();
    recordStorageStackLowWater("idle service");
  }
}
void workerMain(void* context) {
  QueueHandle_t queue = static_cast<QueueHandle_t>(context);
  while (true) {
    AsyncJob* job = nullptr;
    if (xQueueReceive(queue, &job, portMAX_DELAY) != pdTRUE ||
        job == nullptr) continue;
    if (job->type == JobType::ASSET) serveAsset(*job);
    else if (job->type == JobType::LIVE) serveLive(job->request);
    else if (job->type == JobType::STATUS) serveStatus(*job);
    else if (job->type == JobType::OTA_VERSION &&
             serverConfig.handleOtaVersion != nullptr) {
      if (serverConfig.handleOtaVersion(job->request) != ESP_OK) {
        noteWorkerFailure();
      }
    } else if (job->type == JobType::COMMAND) serveCommand(*job);
    else sendError(job->request, 500, "Invalid network worker job.");
    httpd_req_async_handler_complete(job->request);
    releaseJob(job);
    const uint32_t lowWater =
        static_cast<uint32_t>(uxTaskGetStackHighWaterMark2(nullptr));
    recordStackLowWater(lowWater, false);
    recordWorkerPoolLowWater(lowWater, queue == assetQueue);
  }
}


void removeSubscriber(int socket) {
  portENTER_CRITICAL(&subscriberMux);
  for (Subscriber& subscriber : subscribers) {
    if (!subscriber.active || subscriber.socket != socket) continue;
    subscriber = {};
    subscriber.socket = -1;
    break;
  }
  portEXIT_CRITICAL(&subscriberMux);
}

void closeNetworkSession(httpd_handle_t, int socket) {
  removeSubscriber(socket);
  // ESP-IDF delegates descriptor ownership to close_fn when one is installed.
  // The fd may already be invalid after a network-stack close; close() is still
  // required and its harmless EBADF result needs no special handling.
  ::close(socket);
}

void reconcileSubscribersWithServer(uint32_t nowMs) {
  // Runs on the HTTP daemon through httpd_queue_work; ESP-IDF owns the session
  // array, so application reconciliation shares that task's serialization.
  if (server == nullptr) return;
  int clientSockets[kHttpOpenSocketCount] = {};
  size_t clientCount = kHttpOpenSocketCount;
  if (httpd_get_client_list(server, &clientCount, clientSockets) != ESP_OK) {
    return;
  }

  int websocketSockets[kHttpOpenSocketCount] = {};
  size_t websocketCount = 0;
  for (size_t index = 0; index < clientCount; ++index) {
    if (httpd_ws_get_fd_info(server, clientSockets[index]) ==
        HTTPD_WS_CLIENT_WEBSOCKET) {
      websocketSockets[websocketCount++] = clientSockets[index];
    }
  }

  int excessSockets[kHttpOpenSocketCount] = {};
  size_t excessCount = 0;
  portENTER_CRITICAL(&subscriberMux);
  for (Subscriber& subscriber : subscribers) {
    if (!subscriber.active) continue;
    bool present = false;
    for (size_t index = 0; index < websocketCount; ++index) {
      if (websocketSockets[index] == subscriber.socket) {
        present = true;
        break;
      }
    }
    if (!present) {
      subscriber = {};
      subscriber.socket = -1;
    }
  }
  for (size_t index = 0; index < websocketCount; ++index) {
    const int socket = websocketSockets[index];
    Subscriber* selected = nullptr;
    for (Subscriber& subscriber : subscribers) {
      if (subscriber.active && subscriber.socket == socket) {
        selected = &subscriber;
        break;
      }
      if (!subscriber.active && selected == nullptr) selected = &subscriber;
    }
    if (selected == nullptr) {
      excessSockets[excessCount++] = socket;
      continue;
    }
    if (!selected->active) {
      *selected = {};
      selected->socket = socket;
      selected->active = true;
      selected->needsSnapshot = true;
      selected->channels = 1;
      selected->lastSuccessfulSendMs = nowMs;
    }
  }
  portEXIT_CRITICAL(&subscriberMux);
  for (size_t index = 0; index < excessCount; ++index) {
    httpd_sess_trigger_close(server, excessSockets[index]);
  }
}

void reconcileSubscribersOnServerTask(void*) {
  reconcileSubscribersWithServer(
      static_cast<uint32_t>(esp_timer_get_time() / 1000ULL));
  portENTER_CRITICAL(&subscriberMux);
  subscriberReconcileQueued = false;
  portEXIT_CRITICAL(&subscriberMux);
}

void queueSubscriberReconciliation() {
  bool shouldQueue = false;
  portENTER_CRITICAL(&subscriberMux);
  if (!subscriberReconcileQueued) {
    subscriberReconcileQueued = true;
    shouldQueue = true;
  }
  portEXIT_CRITICAL(&subscriberMux);
  if (!shouldQueue) return;
  httpd_handle_t activeServer = server;
  if (activeServer != nullptr &&
      httpd_queue_work(activeServer, reconcileSubscribersOnServerTask, nullptr) ==
          ESP_OK) {
    return;
  }
  portENTER_CRITICAL(&subscriberMux);
  subscriberReconcileQueued = false;
  portEXIT_CRITICAL(&subscriberMux);
}

esp_err_t handleLiveWebSocket(httpd_req_t* request) {
  const int socket = httpd_req_to_sockfd(request);
  if (request->method == HTTP_GET) {
    const uint32_t nowMs = static_cast<uint32_t>(esp_timer_get_time() / 1000ULL);
    int evictedSocket = -1;
    Subscriber* selected = nullptr;
    portENTER_CRITICAL(&subscriberMux);
    for (Subscriber& subscriber : subscribers) {
      if (subscriber.active && subscriber.socket == socket) {
        selected = &subscriber;
        break;
      }
      if (!subscriber.active && selected == nullptr) selected = &subscriber;
    }
    if (selected == nullptr) {
      uint32_t oldestAgeMs = 0;
      for (Subscriber& subscriber : subscribers) {
        const uint32_t ageMs = nowMs - subscriber.lastSuccessfulSendMs;
        if (!subscriberEvictionAllowed(nowMs, subscriber.lastSuccessfulSendMs)) continue;
        if (selected != nullptr && ageMs <= oldestAgeMs) continue;
        selected = &subscriber;
        oldestAgeMs = ageMs;
      }
      if (selected != nullptr) evictedSocket = selected->socket;
    }
    if (selected != nullptr) {
      *selected = {};
      selected->socket = socket;
      selected->active = true;
      selected->needsSnapshot = true;
      selected->channels = 1;
      selected->lastSuccessfulSendMs = nowMs;
    }
    portEXIT_CRITICAL(&subscriberMux);
    // A newly opened browser wins over an actually stale tab. Four healthy
    // subscribers reject a fifth instead of evicting/reconnecting forever.
    if (evictedSocket >= 0 && evictedSocket != socket && server != nullptr) {
      httpd_sess_trigger_close(server, evictedSocket);
    }
    return selected != nullptr ? ESP_OK : ESP_FAIL;
  }

  httpd_ws_frame_t frame = {};
  if (httpd_ws_recv_frame(request, &frame, 0) != ESP_OK) {
    removeSubscriber(socket);
    return ESP_FAIL;
  }
  if (frame.len > 160) {
    removeSubscriber(socket);
    httpd_sess_trigger_close(server, socket);
    return ESP_FAIL;
  }
  uint8_t payload[161] = {};
  if (frame.len > 0) {
    frame.payload = payload;
    if (httpd_ws_recv_frame(request, &frame, frame.len) != ESP_OK) {
      removeSubscriber(socket);
      return ESP_FAIL;
    }
  }
  if (frame.type == HTTPD_WS_TYPE_CLOSE) {
    removeSubscriber(socket);
    return ESP_OK;
  }
  if (frame.type == HTTPD_WS_TYPE_PING) {
    // Control frames are delegated to this handler. Echo the exact payload in
    // the required PONG instead of silently consuming the peer's keepalive.
    frame.type = HTTPD_WS_TYPE_PONG;
    frame.payload = payload;
    return httpd_ws_send_frame(request, &frame);
  }
  if (frame.type == HTTPD_WS_TYPE_TEXT) {
    payload[frame.len] = 0;
    const bool wantsLive = strstr(reinterpret_cast<const char*>(payload),
                                  "live") != nullptr;
    portENTER_CRITICAL(&subscriberMux);
    for (Subscriber& subscriber : subscribers) {
      if (subscriber.active && subscriber.socket == socket) {
        subscriber.channels = wantsLive ? 1 : 0;
        subscriber.needsSnapshot = wantsLive;
        break;
      }
    }
    portEXIT_CRITICAL(&subscriberMux);
  }
  return ESP_OK;
}

bool buildLiveEnvelope(char* frameBuffer, size_t frameCapacity,
                       const char* kind, uint32_t sequence,
                       const char* payload, size_t payloadLength,
                       size_t& frameLength) {
  char prefix[96] = {};
  const int prefixLength = strcmp(kind, "delta") == 0
      ? snprintf(
          prefix, sizeof(prefix),
          "{\"channel\":\"live\",\"kind\":\"delta\",\"seq\":%lu,\"base\":%lu,\"payload\":",
          static_cast<unsigned long>(sequence),
          static_cast<unsigned long>(sequence - 1U))
      : snprintf(
          prefix, sizeof(prefix),
          "{\"channel\":\"live\",\"kind\":\"snapshot\",\"seq\":%lu,\"payload\":",
          static_cast<unsigned long>(sequence));
  if (prefixLength <= 0 ||
      static_cast<size_t>(prefixLength) >= sizeof(prefix)) return false;
  const size_t prefixBytes = static_cast<size_t>(prefixLength);
  if (prefixBytes + payloadLength + 2 > frameCapacity) return false;
  if (payload == frameBuffer) {
    memmove(frameBuffer + prefixBytes, frameBuffer, payloadLength);
  } else {
    memcpy(frameBuffer + prefixBytes, payload, payloadLength);
  }
  memcpy(frameBuffer, prefix, prefixBytes);
  frameBuffer[prefixBytes + payloadLength] = '}';
  frameBuffer[prefixBytes + payloadLength + 1] = 0;
  frameLength = prefixBytes + payloadLength + 1;
  return true;
}

bool sendLiveFrame(int socket, char* frameBuffer, size_t length) {
  httpd_ws_frame_t frame = {};
  frame.final = true;
  frame.type = HTTPD_WS_TYPE_TEXT;
  frame.payload = reinterpret_cast<uint8_t*>(frameBuffer);
  frame.len = length;
  if (server != nullptr &&
      httpd_ws_send_frame_async(server, socket, &frame) == ESP_OK) return true;
  ++failedLiveSends;
  removeSubscriber(socket);
  if (server != nullptr) httpd_sess_trigger_close(server, socket);
  return false;
}

void requireSnapshotForAllSubscribers() {
  portENTER_CRITICAL(&subscriberMux);
  for (Subscriber& subscriber : subscribers) {
    if (subscriber.active && (subscriber.channels & 1) != 0) {
      subscriber.needsSnapshot = true;
    }
  }
  portEXIT_CRITICAL(&subscriberMux);
}

void publishToSubscribers(bool snapshot, uint32_t sequence,
                          const char* payload, size_t payloadLength,
                          char* frameBuffer, size_t frameCapacity) {
  size_t frameLength = 0;
  if (!buildLiveEnvelope(
          frameBuffer, frameCapacity, snapshot ? "snapshot" : "delta",
          sequence, payload, payloadLength, frameLength)) {
    ++failedLiveSends;
    return;
  }
  for (size_t index = 0; index < kSubscriberCount; ++index) {
    int socket = -1;
    bool shouldSend = false;
    portENTER_CRITICAL(&subscriberMux);
    const Subscriber& subscriber = subscribers[index];
    if (subscriber.active && (subscriber.channels & 1) != 0 &&
        subscriber.needsSnapshot == snapshot &&
        (snapshot || subscriber.lastSequence != sequence)) {
      socket = subscriber.socket;
      shouldSend = true;
    }
    portEXIT_CRITICAL(&subscriberMux);
    if (!shouldSend ||
        !sendLiveFrame(socket, frameBuffer, frameLength)) continue;
    portENTER_CRITICAL(&subscriberMux);
    Subscriber& accepted = subscribers[index];
    if (accepted.active && accepted.socket == socket) {
      accepted.needsSnapshot = false;
      accepted.lastSequence = sequence;
      accepted.lastSuccessfulSendMs = static_cast<uint32_t>(esp_timer_get_time() / 1000ULL);
    }
    portEXIT_CRITICAL(&subscriberMux);
  }
  if (snapshot) ++publishedLiveSnapshots;
  else ++publishedLiveDeltas;
}

void livePublisherMain(void*) {
  size_t previousLength = 0;
  TickType_t nextWake = xTaskGetTickCount();
  while (true) {
    vTaskDelayUntil(&nextWake, pdMS_TO_TICKS(kLivePublishIntervalMs));
    if (serverConfig.buildLiveJson == nullptr || server == nullptr) continue;
    queueSubscriberReconciliation();
    if (liveSubscriberCount() == 0) {
      // The next subscriber must receive a full snapshot, never a delta from idle time.
      previousLength = 0;
      continue;
    }
    const size_t currentLength = serverConfig.buildLiveJson(
        currentLivePayload, kLivePayloadBytes);
    if (currentLength == 0 || currentLength >= kLivePayloadBytes) {
      ++failedLiveSends;
      continue;
    }
    const uint32_t sequence = nextLiveSequence++;
    if (nextLiveSequence == 0) nextLiveSequence = 1;
    size_t deltaLength = 0;
    if (previousLength != 0) {
      deltaLength = buildTopLevelJsonDelta(
          previousLivePayload, previousLength,
          currentLivePayload, currentLength,
          liveFramePayload, kLiveFrameBytes);
    }
    if (previousLength != 0 && deltaLength == 0) {
      // A parse or capacity failure cannot advance the delta base invisibly.
      // Reinitialize every subscriber from the coherent current snapshot.
      requireSnapshotForAllSubscribers();
    } else if (deltaLength != 0) {
      // Existing subscribers advance from the prior sequence first. New
      // subscribers still have needsSnapshot=true and cannot consume this delta.
      publishToSubscribers(
          false, sequence, liveFramePayload, deltaLength,
          liveFramePayload, kLiveFrameBytes);
    }
    // Send the full current state only to newly subscribed/recovering clients.
    // Doing this after the delta avoids sending a same-sequence delta to a
    // client that was just initialized by the snapshot.
    publishToSubscribers(
        true, sequence, currentLivePayload, currentLength,
        liveFramePayload, kLiveFrameBytes);
    memcpy(previousLivePayload, currentLivePayload, currentLength + 1);
    previousLength = currentLength;
    recordLivePublisherStackLowWater(
        static_cast<uint32_t>(uxTaskGetStackHighWaterMark2(nullptr)));
  }
}

esp_err_t serveLive(httpd_req_t* request) {
  char liveHttpPayload[kLivePayloadBytes] = {};
  if (serverConfig.buildLiveJson == nullptr) {
    return sendError(request, 503, "Live state is not initialized.");
  }
  const size_t length = serverConfig.buildLiveJson(
      liveHttpPayload, sizeof(liveHttpPayload));
  if (length == 0 || length >= sizeof(liveHttpPayload)) {
    return sendError(request, 500, "Live state exceeded its fixed buffer.");
  }
  httpd_resp_set_type(request, "application/json");
  httpd_resp_set_hdr(request, "Cache-Control", "no-store");
  const esp_err_t result = httpd_resp_send(request, liveHttpPayload, length);
  if (result == ESP_OK && serverConfig.healthResponseServed != nullptr) {
    serverConfig.healthResponseServed();
  }
  return result;
}

esp_err_t serveStatus(AsyncJob& job) {
  if (serverConfig.buildStatusJson == nullptr || job.statusPayload == nullptr) {
    return sendError(job.request, 503, "Status state is not initialized.");
  }
  const size_t length = serverConfig.buildStatusJson(
      job.statusPayload, kStatusPayloadBytes);
  if (length == 0 || length >= kStatusPayloadBytes) {
    return sendError(job.request, 500,
                     "Status state exceeded its fixed buffer.");
  }
  httpd_resp_set_type(job.request, "application/json");
  httpd_resp_set_hdr(job.request, "Cache-Control", "no-store");
  const esp_err_t result =
      httpd_resp_send(job.request, job.statusPayload, length);
  if (result == ESP_OK && serverConfig.healthResponseServed != nullptr) {
    serverConfig.healthResponseServed();
  }
  return result;
}

bool registerRoute(const char* uri, httpd_method_t method,
                   esp_err_t (*handler)(httpd_req_t*), void* context = nullptr) {
  httpd_uri_t route = {};
  route.uri = uri;
  route.method = method;
  route.handler = handler;
  route.user_ctx = context;
  return httpd_register_uri_handler(server, &route) == ESP_OK;
}

void clearRuntime() {
  for (TaskHandle_t& task : workerTasks) {
    if (task != nullptr) {
      vTaskDeleteWithCaps(task);
      task = nullptr;
    }
  }
  if (assetTask != nullptr) {
    vTaskDeleteWithCaps(assetTask);
    assetTask = nullptr;
  }
  if (storageTask != nullptr) {
    vTaskDelete(storageTask);
    storageTask = nullptr;
  }
  if (workQueue != nullptr) {
    vQueueDelete(workQueue);
    workQueue = nullptr;
  }
  if (assetQueue != nullptr) {
    vQueueDelete(assetQueue);
    assetQueue = nullptr;
  }
  if (stopQueue != nullptr) {
    vQueueDelete(stopQueue);
    stopQueue = nullptr;
  }
  if (storageQueue != nullptr) {
    vQueueDelete(storageQueue);
    storageQueue = nullptr;
  }
  if (jobs != nullptr) {
    heap_caps_free(jobs);
    jobs = nullptr;
  }
  if (assetJobs != nullptr) {
    heap_caps_free(assetJobs);
    assetJobs = nullptr;
  }
  if (stopJob != nullptr) {
    heap_caps_free(stopJob);
    stopJob = nullptr;
  }
  if (storageJobs != nullptr) {
    heap_caps_free(storageJobs);
    storageJobs = nullptr;
  }
  if (statusPayloads != nullptr) {
    heap_caps_free(statusPayloads);
    statusPayloads = nullptr;
  }
  if (previousLivePayload != nullptr) {
    heap_caps_free(previousLivePayload);
    previousLivePayload = nullptr;
  }
  if (currentLivePayload != nullptr) {
    heap_caps_free(currentLivePayload);
    currentLivePayload = nullptr;
  }
  if (liveFramePayload != nullptr) {
    heap_caps_free(liveFramePayload);
    liveFramePayload = nullptr;
  }
  portENTER_CRITICAL(&subscriberMux);
  subscriberReconcileQueued = false;
  portEXIT_CRITICAL(&subscriberMux);
}
}  // namespace

bool beginHttpServer(const HttpServerConfig& config) {
  lastStartFailure = "starting";
  if (server != nullptr || config.buildLiveJson == nullptr ||
      config.buildStatusJson == nullptr ||
      config.handleStorageRequest == nullptr ||
      config.serviceStorage == nullptr ||
      config.healthResponseServed == nullptr ||
      config.handleOtaVersion == nullptr ||
      config.handleOtaUpload == nullptr ||
      config.assets[0].bytes == nullptr ||
      config.assets[1].bytes == nullptr ||
      config.assets[2].bytes == nullptr ||
      config.assets[3].bytes == nullptr ||
      config.assets[4].bytes == nullptr) return failStart("invalid configuration");
  serverConfig = config;
  if (!beginMailbox()) return failStart("command mailbox allocation");
  // Payload/job buffers prefer PSRAM and can fall back to internal SRAM. The
  // physically viable command, Stop, asset, and publisher stacks explicitly
  // require the board's populated PSRAM; a failed start is reported and retried
  // without blocking the actuator loop.
  jobs = static_cast<AsyncJob*>(allocateNetworkMemory(
      kNormalWorkerCount, sizeof(AsyncJob)));
  assetJobs = static_cast<AsyncJob*>(allocateNetworkMemory(
      kAssetJobCount, sizeof(AsyncJob)));
  statusPayloads = static_cast<char*>(allocateNetworkMemory(
      kNormalWorkerCount, kStatusPayloadBytes));
  // Stop and storage coordination must remain addressable while flash cache is
  // disabled by LittleFS. Keep these records in internal SRAM.
  stopJob = static_cast<AsyncJob*>(heap_caps_calloc(
      1, sizeof(AsyncJob), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
  storageJobs = static_cast<StorageJob*>(heap_caps_calloc(
      kStorageJobCount, sizeof(StorageJob), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
  previousLivePayload = static_cast<char*>(allocateNetworkMemory(
      kLivePayloadBytes, 1));
  currentLivePayload = static_cast<char*>(allocateNetworkMemory(
      kLivePayloadBytes, 1));
  liveFramePayload = static_cast<char*>(allocateNetworkMemory(
      kLiveFrameBytes, 1));
  if (jobs == nullptr || assetJobs == nullptr || statusPayloads == nullptr ||
      stopJob == nullptr || storageJobs == nullptr ||
      previousLivePayload == nullptr ||
      currentLivePayload == nullptr ||
      liveFramePayload == nullptr) {
    clearRuntime();
    return failStart("request buffer allocation (PSRAM/internal memory unavailable)");
  }
  for (size_t index = 0; index < kNormalWorkerCount; ++index) {
    jobs[index].statusPayload =
        statusPayloads + index * kStatusPayloadBytes;
  }
  workQueue = xQueueCreate(kNormalWorkerCount, sizeof(AsyncJob*));
  assetQueue = xQueueCreate(kAssetJobCount, sizeof(AsyncJob*));
  stopQueue = xQueueCreate(1, sizeof(AsyncJob*));
  storageQueue = xQueueCreate(kStorageJobCount, sizeof(StorageJob*));
  if (workQueue == nullptr || assetQueue == nullptr || stopQueue == nullptr ||
      storageQueue == nullptr) {
    clearRuntime();
    return failStart("request queue allocation");
  }
  for (size_t index = 0; index < kNormalWorkerCount; ++index) {
    char name[16] = {};
    snprintf(name, sizeof(name), "crackle-http-%u",
             static_cast<unsigned>(index));
    if (xTaskCreatePinnedToCoreWithCaps(
            workerMain, name, kCommandWorkerStackBytes, workQueue,
            tskIDLE_PRIORITY + 4, &workerTasks[index], 0,
            MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) != pdPASS) {
      clearRuntime();
      return failStart("normal worker task allocation");
    }
  }
  if (xTaskCreatePinnedToCoreWithCaps(
          workerMain, "crackle-assets", kAssetWorkerStackBytes, assetQueue,
          tskIDLE_PRIORITY + 3, &assetTask, 0,
          MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) != pdPASS) {
    clearRuntime();
    return failStart("asset worker task allocation");
  }
  if (xTaskCreatePinnedToCoreWithCaps(
          workerMain, "crackle-stop", kCommandWorkerStackBytes, stopQueue,
          tskIDLE_PRIORITY + 5, &workerTasks[kStopWorkerIndex], 0,
          MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) != pdPASS) {
    clearRuntime();
    return failStart("Stop worker task allocation");
  }

  // Storage can disable the flash cache. Its task stack must stay in internal
  // SRAM. OTA uses the HTTP daemon's internal-SRAM stack.
  if (xTaskCreatePinnedToCore(
          storageMain, "crackle-store", kStorageWorkerStackBytes, nullptr,
          tskIDLE_PRIORITY + 3, &storageTask, 0) != pdPASS) {
    clearRuntime();
    return failStart("storage worker task allocation");
  }
  httpd_config_t native = HTTPD_DEFAULT_CONFIG();
  native.server_port = config.port;
  native.ctrl_port = config.controlPort;
  native.task_priority = tskIDLE_PRIORITY + 5;
  native.stack_size = kHttpServerStackBytes;
  native.core_id = 0;
  native.max_open_sockets = kHttpOpenSocketCount;
  native.backlog_conn = 8;
  native.max_uri_handlers = 24;
  native.lru_purge_enable = true;
  native.recv_wait_timeout = 3;
  native.send_wait_timeout = 2;
  native.keep_alive_enable = true;
  native.keep_alive_idle = 10;
  native.keep_alive_interval = 5;
  native.keep_alive_count = 3;
  native.uri_match_fn = httpd_uri_match_wildcard;
  native.close_fn = closeNetworkSession;
  if (httpd_start(&server, &native) != ESP_OK) {
    server = nullptr;
    clearRuntime();
    return failStart("ESP-IDF HTTP daemon start");
  }
  bool ok = registerRoute(config.assets[0].path, HTTP_GET, queueAsset,
                          &serverConfig.assets[0]) &&
      registerRoute(config.assets[1].path, HTTP_GET, queueAsset,
                    &serverConfig.assets[1]) &&
      registerRoute(config.assets[2].path, HTTP_GET, queueAsset,
                    &serverConfig.assets[2]) &&
      registerRoute(config.assets[3].path, HTTP_GET, queueAsset,
                    &serverConfig.assets[3]) &&
      registerRoute(config.assets[4].path, HTTP_GET, queueAsset,
                    &serverConfig.assets[4]) &&
      registerRoute("/api/live", HTTP_GET, queueLive) &&
      registerRoute("/api/status", HTTP_GET, queueStatus) &&
      registerRoute("/api/update/version", HTTP_GET, queueOtaVersion) &&
      registerRoute("/update", HTTP_POST, serveOtaDirect) &&
      registerRoute("/api/data/*", HTTP_GET, queueStorage) &&
      registerRoute("/api/data/*", HTTP_POST, queueStorage) &&
      registerRoute("/api/logs", HTTP_GET, queueStorage) &&
      registerRoute("/api/logs/*", HTTP_POST, queueStorage) &&
      registerRoute("/logs/*", HTTP_GET, queueStorage) &&
      registerRoute("/api/events", HTTP_GET, queueStorage) &&
      registerRoute("/capture.csv", HTTP_GET, queueStorage) &&
      registerRoute("/timing.csv", HTTP_GET, queueStorage) &&
      registerRoute("/thermal.csv", HTTP_GET, queueStorage) &&
      registerRoute("/api/roast/active-plan", HTTP_GET, queueCommand) &&
      registerRoute("/api/stop", HTTP_POST, queueStop) &&
      registerRoute("/api/*", HTTP_POST, queueCommand);
  httpd_uri_t liveWebSocket = {};
  liveWebSocket.uri = "/ws/live";
  liveWebSocket.method = HTTP_GET;
  liveWebSocket.handler = handleLiveWebSocket;
  liveWebSocket.is_websocket = true;
  liveWebSocket.handle_ws_control_frames = true;
  ok = ok &&
      httpd_register_uri_handler(server, &liveWebSocket) == ESP_OK;
  if (!ok) {
    stopHttpServer();
    return failStart("HTTP route registration");
  }
  if (xTaskCreatePinnedToCoreWithCaps(
          livePublisherMain, "crackle-live", kLivePublisherStackBytes, nullptr,
          tskIDLE_PRIORITY + 3, &livePublisherTask, 0,
          MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) != pdPASS) {
    stopHttpServer();
    return failStart("live publisher task allocation");
  }
  lastStartFailure = "none";
  return true;
}

void stopHttpServer() {
  if (livePublisherTask != nullptr) {
    vTaskDeleteWithCaps(livePublisherTask);
    livePublisherTask = nullptr;
  }
  if (server != nullptr) {
    httpd_stop(server);
    server = nullptr;
  }
  clearRuntime();
}

bool httpServerRunning() { return server != nullptr; }
const char* httpServerStartFailure() { return lastStartFailure; }
uint32_t httpRejectedRequestCount() { return rejectedRequests; }
uint32_t httpWorkerFailureCount() { return workerFailureSnapshot(); }
uint32_t httpStackLowWaterBytes() {
  return reportedStackLowWaterBytes(stackLowWaterSnapshot(false));
}
uint32_t assetWorkerStackLowWaterBytes() {
  return reportedStackLowWaterBytes(poolLowWaterSnapshot(true));
}
uint32_t commandWorkerStackLowWaterBytes() {
  return reportedStackLowWaterBytes(poolLowWaterSnapshot(false));
}
uint32_t livePublisherStackLowWaterBytes() {
  return reportedStackLowWaterBytes(livePublisherStackLowWaterSnapshot());
}
uint32_t storageStackLowWaterBytes() {
  return reportedStackLowWaterBytes(stackLowWaterSnapshot(true));
}
void storageStackLowWaterRoute(char* out, size_t capacity) {
  storageLowWaterRouteSnapshot(out, capacity);
}
void storageSlowestRequest(uint32_t& elapsedMs, uint32_t& overOneSecond, char* route, size_t capacity) {
  storageSlowestSnapshot(elapsedMs, overOneSecond, route, capacity);
}

uint32_t otaHandlerStackLowWaterBytes() {
  return reportedStackLowWaterBytes(otaHandlerStackLowWaterSnapshot());
}
uint32_t liveSubscriberCapacity() { return kSubscriberCount; }

uint32_t liveSubscriberCount() {
  uint32_t count = 0;
  portENTER_CRITICAL(&subscriberMux);
  for (const Subscriber& subscriber : subscribers) {
    if (subscriber.active) ++count;
  }
  portEXIT_CRITICAL(&subscriberMux);
  return count;
}

uint32_t liveSnapshotCount() { return publishedLiveSnapshots; }
uint32_t liveDeltaCount() { return publishedLiveDeltas; }
uint32_t liveSendFailureCount() { return failedLiveSends; }

}  // namespace sr800::network
