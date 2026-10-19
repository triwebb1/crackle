"""The fixed mailbox reserves Stop, permits two normal mutations, and isolates waits."""
from pathlib import Path

ROOT = Path(__file__).parent.parent
HEADER = (ROOT / "crackle" / "sr800_network_mailbox.h").read_text(encoding="utf-8")
SOURCE = (ROOT / "crackle" / "sr800_network_mailbox.cpp").read_text(encoding="utf-8")

assert "kCommandQueryBytes = 2048" in HEADER
assert "kCommandBodyBytes = 1024" in HEADER
assert "kCommandResponseBytes = 4096" in HEADER
assert "CommandPriority : uint8_t { NORMAL = 0, STOP }" in HEADER
assert "bool retryStorageBusy = false;" in HEADER
assert "uint32_t stopGeneration = 0;" in HEADER
assert "uint32_t stopGenerationSnapshot();" in HEADER
assert "void invalidateActuationStartsForStop();" in HEADER
assert "kNormalSlotCount = 2" in SOURCE
assert "CommandSlot* normalSlots = nullptr;" in SOURCE
assert "CommandSlot* stopSlot = nullptr;" in SOURCE
assert "MALLOC_CAP_INTERNAL" in SOURCE
assert "MALLOC_CAP_SPIRAM" not in SOURCE
assert "xSemaphoreCreateBinaryStatic" in SOURCE
assert "ulTaskNotifyTake" not in SOURCE
assert "xTaskNotifyGive" not in SOURCE
assert "bool beginMailbox()" in SOURCE
assert "uint32_t currentStopGeneration = 1;" in SOURCE

invalidate = SOURCE[SOURCE.index("void invalidateActuationStartsForStop"):]
assert "portENTER_CRITICAL(&mailboxMux)" in invalidate
assert "++currentStopGeneration;" in invalidate
assert "portEXIT_CRITICAL(&mailboxMux)" in invalidate

take = SOURCE[SOURCE.index("CommandSlot* takeForController"):SOURCE.index(
    "const CommandRequest& request"
)]
assert take.index("stopSlot") < take.index("normalSlots")
assert "SlotState::ABANDONED" in take

wait = SOURCE[SOURCE.index("bool submitAndWait"):SOURCE.index(
    "CommandSlot* takeForController"
)]
assert "SlotState::QUEUED" in wait
assert "SlotState::EXECUTING" in wait
assert "completion racing the timeout" in wait
assert "xSemaphoreTake" in wait

complete = SOURCE[SOURCE.index("void completeFromController"):SOURCE.index(
    "size_t pendingCount"
)]
assert complete.index("SlotState::ABANDONED") < complete.index("xSemaphoreGive")

print("network command mailbox contract: PASS")