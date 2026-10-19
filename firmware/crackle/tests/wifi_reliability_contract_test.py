"""Source contract for idle Wi-Fi availability and failure telemetry."""
from pathlib import Path

SOURCE = (Path(__file__).parent.parent / "crackle" / "crackle.ino").read_text(
    encoding="utf-8"
)

setup_start = SOURCE.index("void setup()")
loop_start = SOURCE.index("void loop()", setup_start)
setup = SOURCE[setup_start:loop_start]

exit_start = SOURCE.index("void exitActuationWifiAwakeMode()")
exit_end = SOURCE.index("bool stopDiagnosticTest()", exit_start)
exit_awake = SOURCE[exit_start:exit_end]

assert "WiFi.setSleep(false);" in setup
assert "WiFi.setSleep(true)" not in SOURCE
assert "WiFi.setAutoReconnect(true);" in setup
assert "WiFi.onEvent(onWiFiEvent);" in setup
assert "ARDUINO_EVENT_WIFI_STA_DISCONNECTED" in SOURCE
assert "info.wifi_sta_disconnected.reason" in SOURCE
assert "wifiDisconnectCount++;" in SOURCE
assert "wifiPollReconnectAttemptCount++;" in SOURCE
assert 'wifi_disconnect_count\":' in SOURCE
assert 'wifi_poll_reconnect_attempt_count\":' in SOURCE
assert 'wifi_last_disconnect_reason\":' in SOURCE
assert "actuationWifiAwake = false;" in exit_awake
assert "if (WiFi.getSleep() != WIFI_PS_NONE)" in SOURCE
assert "if (!WiFi.setSleep(false)) return false;" in SOURCE
assert "delay(50);" in SOURCE

maintain_start = SOURCE.index("void maintainStationConnection()")
maintain_end = SOURCE.index("template <typename Output>", maintain_start)
maintain = SOURCE[maintain_start:maintain_end]
assert "constexpr uint32_t kReconnectIntervalMs = 5000;" in SOURCE
assert "WiFi.reconnect();" in maintain
assert "if (actuator.outputsActive())" not in maintain
assert "const bool outputsActive = actuator.outputsActive();" in maintain
assert "const bool recoveryApDue = !stationConfigured ||" in maintain
assert "now - lastApStartAttemptMs >= kReconnectIntervalMs" in maintain
assert "!outputsActive && !apActive && recoveryApDue" in maintain
assert "lastApStartAttemptMs = millis();" in SOURCE

print("firmware idle Wi-Fi reliability contract: PASS")
