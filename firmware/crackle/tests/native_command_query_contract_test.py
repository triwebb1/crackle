"""Native command arguments are bounded, decoded, and never use Arduino String."""
from pathlib import Path

ROOT = Path(__file__).parent.parent
HEADER = (ROOT / "crackle" / "sr800_query_args.h").read_text(encoding="utf-8")
SOURCE = (ROOT / "crackle" / "sr800_query_args.cpp").read_text(encoding="utf-8")
FIRMWARE = (ROOT / "crackle" / "crackle.ino").read_text(encoding="utf-8")
SERVER = (ROOT / "crackle" / "sr800_network_server.cpp").read_text(encoding="utf-8")

assert "class QueryArgs" in HEADER
assert "bool levelMilli" in HEADER
assert "value == '+'" in SOURCE
assert "value == '%'" in SOURCE
assert "UINT32_MAX" in SOURCE
assert "String" not in SOURCE
assert '#include "sr800_query_args.h"' in FIRMWARE
mailbox = FIRMWARE[
    FIRMWARE.index("void serviceNetworkCommandMailbox()"):
    FIRMWARE.index("// Rollback protection only works")
]
for route in (
    "/api/stop",
    "/api/manual/set",
    "/api/manual/stop",
    "/api/calibration/stop",
    "/api/roast/stop",
):
    assert route in mailbox
assert "const sr800::network::QueryArgs args(" in mailbox
assert "form == nullptr ? command.query : form" in mailbox
assert "form == nullptr ? nullptr : command.query" in mailbox
assert "refreshRestoreLease()" in mailbox
assert "takeOverPriorRecordingForNewEpisode(takeOverRejection)" in mailbox

print("native command query contract: PASS")

assert 'strcspn(request->uri, "?")' in SERVER
assert 'strcspn(request->uri, "?")' in FIRMWARE
assert 'kCommandReceiveNoProgressMs' in SERVER
