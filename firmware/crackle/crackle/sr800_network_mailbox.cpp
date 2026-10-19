#include "sr800_network_mailbox.h"

#include <string.h>

#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

namespace sr800::network {
namespace {

constexpr size_t kNormalSlotCount = 2;

enum class SlotState : uint8_t {
  FREE = 0,
  ACQUIRED,
  QUEUED,
  EXECUTING,
  COMPLETE,
  READING,
  ABANDONED,
};

portMUX_TYPE mailboxMux = portMUX_INITIALIZER_UNLOCKED;
uint32_t nextCommandId = 1;
uint32_t mailboxRejected = 0;
uint32_t mailboxAbandoned = 0;
uint32_t currentStopGeneration = 1;

}  // namespace

struct CommandSlot {
  SlotState state = SlotState::FREE;
  CommandPriority priority = CommandPriority::NORMAL;
  CommandRequest request;
  CommandResponse response;
  StaticSemaphore_t completionStorage;
  SemaphoreHandle_t completion = nullptr;
};

namespace {
CommandSlot* normalSlots = nullptr;
CommandSlot* stopSlot = nullptr;

void* allocateMailboxMemory(size_t count, size_t bytes) {
  // Synchronization state stays in internal SRAM. Some controller commands
  // commit Preferences, temporarily disabling the external-memory cache.
  return heap_caps_calloc(
      count, bytes, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
}

void freeSlot(CommandSlot& slot) {
  // Command bodies can contain Wi-Fi credentials. A volatile write prevents
  // the scrub from being optimized away before the static slot is reused.
  volatile uint8_t* body = slot.request.body;
  for (size_t index = 0; index < slot.request.bodyLength; ++index) {
    body[index] = 0;
  }
  slot.request.body[0] = 0;
  slot.request.bodyLength = 0;
  slot.request.formUrlEncoded = false;
  slot.request.stopGeneration = 0;
  slot.state = SlotState::FREE;
  slot.priority = CommandPriority::NORMAL;
}

bool textFits(const char* value, size_t capacity) {
  return value == nullptr || strlen(value) < capacity;
}

void copyText(char* destination, size_t capacity, const char* source) {
  if (source == nullptr) source = "";
  const size_t length = strlen(source);
  memcpy(destination, source, length);
  destination[length] = 0;
}

bool initializeSlot(CommandSlot& slot) {
  slot.completion = xSemaphoreCreateBinaryStatic(&slot.completionStorage);
  return slot.completion != nullptr;
}

void releaseAllocations() {
  if (normalSlots != nullptr) heap_caps_free(normalSlots);
  if (stopSlot != nullptr) heap_caps_free(stopSlot);
  normalSlots = nullptr;
  stopSlot = nullptr;
}

}  // namespace

bool beginMailbox() {
  if (normalSlots != nullptr && stopSlot != nullptr) return true;
  normalSlots = static_cast<CommandSlot*>(allocateMailboxMemory(
      kNormalSlotCount, sizeof(CommandSlot)));
  stopSlot = static_cast<CommandSlot*>(allocateMailboxMemory(
      1, sizeof(CommandSlot)));
  if (normalSlots == nullptr || stopSlot == nullptr) {
    releaseAllocations();
    return false;
  }
  for (size_t index = 0; index < kNormalSlotCount; ++index) {
    if (!initializeSlot(normalSlots[index])) {
      releaseAllocations();
      return false;
    }
  }
  if (!initializeSlot(*stopSlot)) {
    releaseAllocations();
    return false;
  }
  return true;
}

CommandSlot* acquire(CommandPriority priority, CommandMethod method,
                     const char* uri, const char* query,
                     const uint8_t* body, size_t bodyLength,
                     bool formUrlEncoded, uint32_t stopGeneration) {
  if (bodyLength > kCommandBodyBytes || (bodyLength > 0 && body == nullptr) ||
      !textFits(uri, kCommandUriBytes) ||
      !textFits(query, kCommandQueryBytes)) {
    portENTER_CRITICAL(&mailboxMux);
    ++mailboxRejected;
    portEXIT_CRITICAL(&mailboxMux);
    return nullptr;
  }

  CommandSlot* slot = nullptr;
  portENTER_CRITICAL(&mailboxMux);
  if (priority == CommandPriority::STOP) {
    if (stopSlot != nullptr && stopSlot->state == SlotState::FREE) {
      slot = stopSlot;
    }
  } else if (normalSlots != nullptr) {
    for (size_t index = 0; index < kNormalSlotCount; ++index) {
      if (normalSlots[index].state == SlotState::FREE) {
        slot = &normalSlots[index];
        break;
      }
    }
  }
  if (slot == nullptr) {
    ++mailboxRejected;
    portEXIT_CRITICAL(&mailboxMux);
    return nullptr;
  }
  slot->state = SlotState::ACQUIRED;
  slot->priority = priority;
  slot->request.id = nextCommandId++;
  if (nextCommandId == 0) nextCommandId = 1;
  slot->request.method = method;
  slot->request.stopGeneration = stopGeneration;
  portEXIT_CRITICAL(&mailboxMux);

  // A completion racing the prior wait timeout may leave one token behind.
  // This slot is exclusively ACQUIRED now, so drain it before the new request.
  xSemaphoreTake(slot->completion, 0);
  copyText(slot->request.uri, sizeof(slot->request.uri), uri);
  copyText(slot->request.query, sizeof(slot->request.query), query);
  if (bodyLength > 0) memcpy(slot->request.body, body, bodyLength);
  slot->request.body[bodyLength] = 0;
  slot->request.bodyLength = bodyLength;
  slot->request.formUrlEncoded = formUrlEncoded;
  slot->response.bodyLength = 0;
  return slot;
}

bool submitAndWait(CommandSlot* slot, uint32_t timeoutMs,
                   CommandResponse& response) {
  if (slot == nullptr || slot->completion == nullptr) return false;
  portENTER_CRITICAL(&mailboxMux);
  if (slot->state != SlotState::ACQUIRED) {
    portEXIT_CRITICAL(&mailboxMux);
    return false;
  }
  slot->state = SlotState::QUEUED;
  portEXIT_CRITICAL(&mailboxMux);

  const bool notified =
      xSemaphoreTake(slot->completion, pdMS_TO_TICKS(timeoutMs)) == pdTRUE;
  bool readCompleted = false;
  portENTER_CRITICAL(&mailboxMux);
  if (slot->state == SlotState::COMPLETE) {
    // This also handles completion racing the timeout. A committed mutation
    // must return its real result instead of a false transport failure.
    slot->state = SlotState::READING;
    readCompleted = true;
  } else if (slot->state == SlotState::QUEUED ||
             slot->state == SlotState::EXECUTING) {
    slot->state = SlotState::ABANDONED;
    ++mailboxAbandoned;
  }
  portEXIT_CRITICAL(&mailboxMux);

  if (!readCompleted) return false;
  (void)notified;
  response = slot->response;
  portENTER_CRITICAL(&mailboxMux);
  freeSlot(*slot);
  portEXIT_CRITICAL(&mailboxMux);
  return true;
}

CommandSlot* takeForController() {
  portENTER_CRITICAL(&mailboxMux);
  if (stopSlot != nullptr) {
    if (stopSlot->state == SlotState::ABANDONED) freeSlot(*stopSlot);
    else if (stopSlot->state == SlotState::QUEUED) {
      stopSlot->state = SlotState::EXECUTING;
      portEXIT_CRITICAL(&mailboxMux);
      return stopSlot;
    }
  }
  if (normalSlots != nullptr) {
    for (size_t index = 0; index < kNormalSlotCount; ++index) {
      CommandSlot& slot = normalSlots[index];
      if (slot.state == SlotState::ABANDONED) {
        freeSlot(slot);
        continue;
      }
      if (slot.state == SlotState::QUEUED) {
        slot.state = SlotState::EXECUTING;
        portEXIT_CRITICAL(&mailboxMux);
        return &slot;
      }
    }
  }
  portEXIT_CRITICAL(&mailboxMux);
  return nullptr;
}

const CommandRequest& request(const CommandSlot* slot) {
  return slot->request;
}

void completeFromController(CommandSlot* slot,
                            const CommandResponse& response) {
  if (slot == nullptr) return;
  portENTER_CRITICAL(&mailboxMux);
  if (slot->state == SlotState::ABANDONED) {
    freeSlot(*slot);
    portEXIT_CRITICAL(&mailboxMux);
    return;
  }
  if (slot->state != SlotState::EXECUTING) {
    portEXIT_CRITICAL(&mailboxMux);
    return;
  }
  portEXIT_CRITICAL(&mailboxMux);

  // EXECUTING is exclusively controller-owned. Keep the bounded copy outside
  // the spinlock so interrupts are never masked by payload movement.
  slot->response = response;

  portENTER_CRITICAL(&mailboxMux);
  if (slot->state == SlotState::ABANDONED) {
    freeSlot(*slot);
    portEXIT_CRITICAL(&mailboxMux);
    return;
  }
  if (slot->state != SlotState::EXECUTING) {
    portEXIT_CRITICAL(&mailboxMux);
    return;
  }
  slot->state = SlotState::COMPLETE;
  portEXIT_CRITICAL(&mailboxMux);
  xSemaphoreGive(slot->completion);
}

size_t pendingCount() {
  size_t count = 0;
  portENTER_CRITICAL(&mailboxMux);
  if (stopSlot != nullptr && stopSlot->state != SlotState::FREE) ++count;
  if (normalSlots != nullptr) {
    for (size_t index = 0; index < kNormalSlotCount; ++index) {
      if (normalSlots[index].state != SlotState::FREE) ++count;
    }
  }
  portEXIT_CRITICAL(&mailboxMux);
  return count;
}

uint32_t rejectedCount() {
  portENTER_CRITICAL(&mailboxMux);
  const uint32_t value = mailboxRejected;
  portEXIT_CRITICAL(&mailboxMux);
  return value;
}

uint32_t abandonedCount() {
  portENTER_CRITICAL(&mailboxMux);
  const uint32_t value = mailboxAbandoned;
  portEXIT_CRITICAL(&mailboxMux);
  return value;
}

uint32_t stopGenerationSnapshot() {
  portENTER_CRITICAL(&mailboxMux);
  const uint32_t value = currentStopGeneration;
  portEXIT_CRITICAL(&mailboxMux);
  return value;
}

void invalidateActuationStartsForStop() {
  portENTER_CRITICAL(&mailboxMux);
  ++currentStopGeneration;
  portEXIT_CRITICAL(&mailboxMux);
}

}  // namespace sr800::network
