#pragma once

#include <stddef.h>
#include <stdint.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace sr800::network {

constexpr size_t kCommandUriBytes = 112;
constexpr size_t kCommandQueryBytes = 2048;
constexpr size_t kCommandBodyBytes = 1024;
// Maximum active-plan JSON is proven below 4 KiB for both 24 timed steps and
// 12 current plus 12 initial journey zones.
constexpr size_t kCommandResponseBytes = 4096;

enum class CommandMethod : uint8_t { GET = 0, POST };
enum class CommandPriority : uint8_t { NORMAL = 0, STOP };

struct CommandRequest {
  uint32_t id = 0;
  // Snapshot captured when the HTTP request first enters the command lane.
  // A later Stop changes the generation and invalidates queued/retried starts.
  uint32_t stopGeneration = 0;
  CommandMethod method = CommandMethod::GET;
  char uri[kCommandUriBytes] = {};
  char query[kCommandQueryBytes] = {};
  // One extra byte keeps an accepted form body NUL-terminated without reducing
  // the documented 1024-byte wire limit.
  uint8_t body[kCommandBodyBytes + 1] = {};
  size_t bodyLength = 0;
  bool formUrlEncoded = false;
};

struct CommandResponse {
  int status = 503;
  // True only when the controller refused before side effects because a
  // storage transfer overlapped an actuation start. The HTTP worker may safely
  // retry this exact command without creating a second authority.
  bool retryStorageBusy = false;
  char contentType[40] = "application/json";
  char body[kCommandResponseBytes] = {};
  size_t bodyLength = 0;
  uint64_t stateRevision = 0;
};

struct CommandSlot;

// Allocate two normal slots plus one Stop slot in internal SRAM.
bool beginMailbox();

// Two normal slots keep mutation memory fixed. Stop has its own reserved slot,
// so an editor request can never prevent the safety command from reaching loop().
CommandSlot* acquire(CommandPriority priority, CommandMethod method,
                     const char* uri, const char* query,
                     const uint8_t* body, size_t bodyLength,
                     bool formUrlEncoded = false,
                     uint32_t stopGeneration = 0);

// Called by a native network worker. The timeout abandons only the caller; a
// command already executing is allowed to finish, then its static slot is freed.
bool submitAndWait(CommandSlot* slot, uint32_t timeoutMs,
                   CommandResponse& response);

// Called only by the controller loop. Stop is always returned before normal
// work. At most one command is dispatched per loop iteration.
CommandSlot* takeForController();
const CommandRequest& request(const CommandSlot* slot);
void completeFromController(CommandSlot* slot, const CommandResponse& response);

size_t pendingCount();
uint32_t rejectedCount();
uint32_t abandonedCount();

// Stop invalidates every actuation start that entered the command lane before
// it. Wrap is harmless: no command can survive 2^32 Stop requests.
uint32_t stopGenerationSnapshot();
void invalidateActuationStartsForStop();

}  // namespace sr800::network
