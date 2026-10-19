#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_http_server.h"

namespace sr800::network {

using LiveJsonBuilder = size_t (*)(char* buffer, size_t capacity);
using NativeRequestHandler = esp_err_t (*)(httpd_req_t* request);
using StorageService = void (*)();
using HealthResponseServed = void (*)();

struct EmbeddedAsset {
  const char* path = nullptr;
  const char* contentType = nullptr;
  const char* cacheControl = nullptr;
  const uint8_t* bytes = nullptr;
  size_t length = 0;
  bool gzip = true;
};

struct HttpServerConfig {
  uint16_t port = 80;
  uint16_t controlPort = 32770;
  EmbeddedAsset assets[5];
  LiveJsonBuilder buildLiveJson = nullptr;
  LiveJsonBuilder buildStatusJson = nullptr;
  NativeRequestHandler handleStorageRequest = nullptr;
  StorageService serviceStorage = nullptr;
  HealthResponseServed healthResponseServed = nullptr;

  NativeRequestHandler handleOtaVersion = nullptr;
  NativeRequestHandler handleOtaUpload = nullptr;
};

bool beginHttpServer(const HttpServerConfig& config);
void stopHttpServer();
bool httpServerRunning();
const char* httpServerStartFailure();
uint32_t httpRejectedRequestCount();
uint32_t httpWorkerFailureCount();
uint32_t httpStackLowWaterBytes();
// The 5 KB asset worker and the 12 KB command/Stop workers, reported separately.
uint32_t assetWorkerStackLowWaterBytes();
uint32_t commandWorkerStackLowWaterBytes();
uint32_t livePublisherStackLowWaterBytes();
uint32_t storageStackLowWaterBytes();
// The storage request ("POST /api/data/...") or "idle service" that set the low-water.
void storageStackLowWaterRoute(char* out, size_t capacity);
// The slowest storage request's handler time and route, and how many took >= 1 s.
void storageSlowestRequest(uint32_t& elapsedMs, uint32_t& overOneSecond, char* route, size_t capacity);
uint32_t otaHandlerStackLowWaterBytes();
uint32_t liveSubscriberCapacity();
uint32_t liveSubscriberCount();
uint32_t liveSnapshotCount();
uint32_t liveDeltaCount();
uint32_t liveSendFailureCount();

}  // namespace sr800::network
