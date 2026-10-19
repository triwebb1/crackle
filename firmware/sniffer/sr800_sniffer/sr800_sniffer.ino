#include <Arduino.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WebServer.h>
#include "driver/gpio.h"
#include "driver/temperature_sensor.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "sr800_display_decoder.h"

namespace {

constexpr char kApName[] = "SR800-Sniffer";
constexpr char kApPassword[] = "freshroast";
constexpr char kHostName[] = "sr800-sniffer";
constexpr char kFirmwareVersion[] = "2026-07-24.1";
constexpr char kPreferencesNamespace[] = "sr800-net";
constexpr char kDiagnosticsNamespace[] = "sr800-diag";
constexpr uint32_t kReconnectIntervalMs = 30000;
constexpr uint32_t kApShutdownDelayMs = 15000;
constexpr uint32_t kApRecoveryDelayMs = 15000;

constexpr gpio_num_t kClockPin = GPIO_NUM_4;
constexpr gpio_num_t kInputAPin = GPIO_NUM_5;
constexpr gpio_num_t kInputBPin = GPIO_NUM_6;
constexpr gpio_num_t kClearPin = GPIO_NUM_7;

// A pause longer than this starts a new candidate 8-bit transfer.
// Change from the web page after observing the first capture if needed.
volatile uint32_t groupGapUs = 40;

constexpr size_t kEventCapacity = 2048;
constexpr uint32_t kClockEdgeLimit = 32768;
constexpr uint8_t kStopNone = 0;
constexpr uint8_t kStopEventLimit = 1;
constexpr uint8_t kStopClockLimit = 2;
constexpr uint8_t kStopManual = 3;

struct ByteEvent {
  uint32_t sequence;
  uint32_t atUs;
  uint32_t precedingGapUs;
  uint8_t inputA;
  uint8_t inputB;
  uint8_t effective;
  uint8_t clearLevel;
};

struct LiveSample {
  uint32_t sequence;
  uint32_t atUs;
  uint8_t inputA;
  uint8_t inputB;
  uint8_t effective;
  uint8_t clearLevel;
};

constexpr size_t kLiveSampleCapacity = 256;
DRAM_ATTR volatile ByteEvent eventBuffer[kEventCapacity];
DRAM_ATTR volatile LiveSample liveSampleBuffer[kLiveSampleCapacity];
DRAM_ATTR volatile uint32_t liveSampleSequence = 0;
DRAM_ATTR volatile uint32_t totalEvents = 0;
DRAM_ATTR volatile uint32_t totalClockEdges = 0;
DRAM_ATTR volatile uint32_t incompleteGroups = 0;
DRAM_ATTR volatile uint32_t clocksWhileClearLow = 0;
DRAM_ATTR volatile uint32_t lastClockUs = 0;
DRAM_ATTR volatile uint32_t currentGroupGapUs = 0;
DRAM_ATTR volatile uint8_t bitCount = 0;
DRAM_ATTR volatile uint8_t shiftA = 0;
DRAM_ATTR volatile uint8_t shiftB = 0;
DRAM_ATTR volatile uint8_t shiftEffective = 0;
DRAM_ATTR volatile bool captureStopRequested = false;
DRAM_ATTR volatile uint8_t captureStopReason = kStopNone;
DRAM_ATTR volatile bool captureEnabled = false;
DRAM_ATTR volatile uint32_t diagnosticClockRises = 0;
DRAM_ATTR volatile uint32_t diagnosticAChanges = 0;
DRAM_ATTR volatile uint32_t diagnosticBChanges = 0;
DRAM_ATTR volatile uint32_t diagnosticClearChanges = 0;
DRAM_ATTR volatile uint32_t diagnosticABDisagreements = 0;
DRAM_ATTR volatile uint32_t lastClockRiseUs = 0;
DRAM_ATTR volatile uint32_t lastClockPeriodUs = 0;
DRAM_ATTR volatile uint32_t minClockPeriodUs = UINT32_MAX;
DRAM_ATTR volatile uint32_t maxClockPeriodUs = 0;
DRAM_ATTR volatile uint8_t lastSampledLevels = 0;
DRAM_ATTR volatile uint8_t seenHighMask = 0;
DRAM_ATTR volatile uint8_t seenLowMask = 0;
DRAM_ATTR volatile bool clockPeriodPrimed = false;
DRAM_ATTR volatile bool sampledLevelsPrimed = false;

portMUX_TYPE captureMux = portMUX_INITIALIZER_UNLOCKED;
WebServer server(80);
temperature_sensor_handle_t chipTemperatureSensor = nullptr;
String stationSsid;
bool stationConfigured = false;
bool mdnsStarted = false;
bool apActive = false;
bool signalInterruptsAttached = false;
uint32_t lastReconnectAttemptMs = 0;
uint32_t stationConnectedSinceMs = 0;
uint32_t stationDisconnectedSinceMs = 0;
uint32_t bootCount = 0;
esp_reset_reason_t bootResetReason = ESP_RST_UNKNOWN;
bool updateStarted = false;
bool updateFinished = false;
bool otaHandleActive = false;
esp_ota_handle_t otaHandle = 0;
const esp_partition_t* otaTargetPartition = nullptr;
esp_err_t otaError = ESP_OK;
size_t otaBytesWritten = 0;
sr800::DisplayDecoder displayDecoder;
uint32_t decoderReadSequence = 0;
uint32_t decoderQueueDrops = 0;

const char kPage[] PROGMEM = R"HTML(
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SR800 PIC Sniffer</title>
<style>
body{font:15px system-ui,sans-serif;margin:0;background:#f4f5f6;color:#16191d}
header{background:#20262d;color:white;padding:14px 18px}
main{max-width:1000px;margin:auto;padding:16px}
.warning{border-left:5px solid #b42318;background:#fff;padding:12px;margin-bottom:14px}
.controls{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0;align-items:end}
.network{border-top:1px solid #c8ced4;border-bottom:1px solid #c8ced4;padding:12px 0;margin:14px 0}
.network h2{font-size:17px;margin:0 0 8px}
.network label{display:grid;gap:4px}
.network input{width:min(260px,70vw)}
.result{min-height:20px;padding:8px 0}
button,a.button{border:1px solid #68727d;background:white;color:#111;padding:8px 11px;text-decoration:none;cursor:pointer}
input{width:80px;padding:7px}
pre{background:#111820;color:#d9e2ec;padding:12px;overflow:auto;min-height:70px}
table{border-collapse:collapse;width:100%;background:white;font-family:ui-monospace,monospace;font-size:13px}
th,td{border:1px solid #c8ced4;padding:5px 7px;text-align:right}
th{background:#e8ebee;position:sticky;top:0}
.table-wrap{max-height:55vh;overflow:auto}
</style>
</head>
<body>
<header><strong>SR800 PIC / 74HC164 Sniffer</strong></header>
<main>
<div class="warning"><strong>Powered-roaster rule:</strong> no USB, serial cable, programmer, charger, or other wired connection to a computer. Treat the sniffer and its battery as potentially mains-referenced.</div>
<div id="status"><pre>Loading status...</pre></div>
<section class="network">
<h2>Decoded display</h2>
<div id="display"><pre>Waiting for display consensus...</pre></div>
</section>
<section class="network">
<h2>Network</h2>
<div id="networkState">Checking network...</div>
<div class="controls">
<label>Wi-Fi name <input id="wifiSsid" type="text" maxlength="32" autocomplete="username"></label>
<label>Password <input id="wifiPassword" type="password" maxlength="63" autocomplete="current-password"></label>
<button onclick="saveWifi()">Connect</button>
<button onclick="forgetWifi()">Forget</button>
</div>
<div id="wifiResult" class="result"></div>
</section>
<div class="controls">
<label>Gap us <input id="gap" type="number" min="2" max="100000" value="40"></label>
<button onclick="setGap()">Set gap</button>
<button onclick="clearCapture()">Clear &amp; arm capture</button>
<button onclick="freezeCapture()">Freeze capture</button>
<a class="button" href="/capture.csv?limit=2048">Download CSV</a>
<a class="button" href="/update">Firmware update</a>
</div>
<div class="table-wrap">
<table>
<thead><tr><th>seq</th><th>time us</th><th>gap us</th><th>A hex</th><th>B hex</th><th>A&amp;B hex</th><th>CLR</th></tr></thead>
<tbody id="events"></tbody>
</table>
</div>
</main>
<script>
async function refresh(){
  const [s,d,e]=await Promise.all([fetch('/api/status').then(r=>r.json()),fetch('/api/display').then(r=>r.json()),fetch('/api/events?limit=160').then(r=>r.json())]);
  document.getElementById('status').innerHTML='<pre>'+JSON.stringify(s,null,2)+'</pre>';
  document.getElementById('display').innerHTML='<pre>'+JSON.stringify(d,null,2)+'</pre>';
  const network=s.station_connected
    ? `Connected: <a href="http://${s.station_ip}">http://${s.station_ip}</a> or <a href="http://${s.hostname}">http://${s.hostname}</a>`
    : (s.station_configured?'Connecting to saved Wi-Fi...':'Home Wi-Fi is not configured.');
  document.getElementById('networkState').innerHTML=network;
  document.getElementById('gap').value=s.group_gap_us;
  document.getElementById('events').innerHTML=e.events.map(x=>`<tr><td>${x.seq}</td><td>${x.us}</td><td>${x.gap}</td><td>${hx(x.a)}</td><td>${hx(x.b)}</td><td>${hx(x.effective)}</td><td>${x.clear}</td></tr>`).join('');
}
function hx(v){return '0x'+Number(v).toString(16).padStart(2,'0').toUpperCase()}
async function clearCapture(){await fetch('/api/clear',{method:'POST'});refresh()}
async function freezeCapture(){await fetch('/api/freeze',{method:'POST'});refresh()}
async function setGap(){const v=document.getElementById('gap').value;await fetch('/api/gap?us='+encodeURIComponent(v),{method:'POST'});refresh()}
async function saveWifi(){
  const ssid=document.getElementById('wifiSsid').value;
  const password=document.getElementById('wifiPassword').value;
  const result=document.getElementById('wifiResult');
  result.textContent='Connecting...';
  const response=await fetch('/api/wifi',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({ssid,password})});
  const body=await response.json();
  document.getElementById('wifiPassword').value='';
  result.textContent=body.message;
  refresh();
}
async function forgetWifi(){
  const response=await fetch('/api/wifi/forget',{method:'POST'});
  const body=await response.json();
  document.getElementById('wifiSsid').value='';
  document.getElementById('wifiPassword').value='';
  document.getElementById('wifiResult').textContent=body.message;
  refresh();
}
setInterval(refresh,1000);refresh();
</script>
</body>
</html>
)HTML";

const char kUpdatePage[] PROGMEM = R"HTML(
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SR800 Firmware Update</title></head>
<body style="font:15px system-ui,sans-serif;max-width:620px;margin:30px auto;padding:0 16px;color:#16191d">
<h1 style="font-size:22px">SR800 Sniffer Firmware Update</h1>
<p><strong>Unplug the roaster from mains before updating.</strong> Keep the ESP32 powered from its battery and connected to home Wi-Fi.</p>
<form method="POST" action="/update" enctype="multipart/form-data">
<input type="file" name="firmware" accept=".bin,application/octet-stream" required>
<button type="submit" style="padding:8px 11px;margin-left:8px">Upload and restart</button>
</form>
<p><a href="/">Return to sniffer</a></p>
</body>
</html>
)HTML";

void ARDUINO_ISR_ATTR onClockRise() {
  const uint32_t nowUs = micros();
  const uint8_t inputA = gpio_get_level(kInputAPin);
  const uint8_t inputB = gpio_get_level(kInputBPin);
  const uint8_t clearLevel = gpio_get_level(kClearPin);
  const uint8_t sampledLevels =
      inputA | static_cast<uint8_t>(inputB << 1) |
      static_cast<uint8_t>(clearLevel << 2);

  portENTER_CRITICAL_ISR(&captureMux);

  diagnosticClockRises = diagnosticClockRises + 1;
  const uint8_t observedMask = static_cast<uint8_t>(0x01 | (sampledLevels << 1));
  seenHighMask |= observedMask;
  seenLowMask |= static_cast<uint8_t>(0x01 | ((~observedMask) & 0x0E));

  if (clockPeriodPrimed) {
    const uint32_t periodUs = nowUs - lastClockRiseUs;
    lastClockPeriodUs = periodUs;
    if (periodUs < minClockPeriodUs) minClockPeriodUs = periodUs;
    if (periodUs > maxClockPeriodUs) maxClockPeriodUs = periodUs;
  }
  lastClockRiseUs = nowUs;
  clockPeriodPrimed = true;

  if (sampledLevelsPrimed) {
    const uint8_t changed = sampledLevels ^ lastSampledLevels;
    if (changed & 0x01) diagnosticAChanges = diagnosticAChanges + 1;
    if (changed & 0x02) diagnosticBChanges = diagnosticBChanges + 1;
  }
  lastSampledLevels = sampledLevels;
  sampledLevelsPrimed = true;
  if (inputA != inputB) {
    diagnosticABDisagreements = diagnosticABDisagreements + 1;
  }

  const uint32_t deltaUs = nowUs - lastClockUs;
  lastClockUs = nowUs;

  if (captureEnabled) {
    totalClockEdges = totalClockEdges + 1;
    if (totalClockEdges >= kClockEdgeLimit) {
      captureStopRequested = true;
      captureStopReason = kStopClockLimit;
      captureEnabled = false;
    }
  }

  if (clearLevel == 0) {
    bitCount = 0;
    shiftA = 0;
    shiftB = 0;
    shiftEffective = 0;
    if (captureEnabled) clocksWhileClearLow = clocksWhileClearLow + 1;
    portEXIT_CRITICAL_ISR(&captureMux);
    return;
  }

  if (bitCount != 0 && deltaUs > groupGapUs) {
    if (captureEnabled) incompleteGroups = incompleteGroups + 1;
    bitCount = 0;
    shiftA = 0;
    shiftB = 0;
    shiftEffective = 0;
  }

  if (bitCount == 0) {
    currentGroupGapUs = deltaUs;
  }

  shiftA = static_cast<uint8_t>((shiftA << 1) | inputA);
  shiftB = static_cast<uint8_t>((shiftB << 1) | inputB);
  shiftEffective = static_cast<uint8_t>((shiftEffective << 1) | (inputA & inputB));
  bitCount = bitCount + 1;

  if (bitCount == 8) {
    const uint32_t liveSequence = liveSampleSequence + 1;
    const size_t liveIndex = (liveSequence - 1) % kLiveSampleCapacity;
    liveSampleBuffer[liveIndex].atUs = nowUs;
    liveSampleBuffer[liveIndex].inputA = shiftA;
    liveSampleBuffer[liveIndex].inputB = shiftB;
    liveSampleBuffer[liveIndex].effective = shiftEffective;
    liveSampleBuffer[liveIndex].clearLevel = clearLevel;
    liveSampleBuffer[liveIndex].sequence = liveSequence;
    liveSampleSequence = liveSequence;

    if (captureEnabled) {
      totalEvents = totalEvents + 1;
      const uint32_t sequence = totalEvents;
      const size_t index = sequence - 1;

      eventBuffer[index].sequence = sequence;
      eventBuffer[index].atUs = nowUs;
      eventBuffer[index].precedingGapUs = currentGroupGapUs;
      eventBuffer[index].inputA = shiftA;
      eventBuffer[index].inputB = shiftB;
      eventBuffer[index].effective = shiftEffective;
      eventBuffer[index].clearLevel = clearLevel;

      if (sequence >= kEventCapacity) {
        captureStopRequested = true;
        captureStopReason = kStopEventLimit;
        captureEnabled = false;
      }
    }

    bitCount = 0;
    shiftA = 0;
    shiftB = 0;
    shiftEffective = 0;
  }

  portEXIT_CRITICAL_ISR(&captureMux);
}
void ARDUINO_ISR_ATTR onClearChange() {
  const uint8_t level = gpio_get_level(kClearPin);
  portENTER_CRITICAL_ISR(&captureMux);
  diagnosticClearChanges = diagnosticClearChanges + 1;
  if (level) seenHighMask |= 0x08;
  else seenLowMask |= 0x08;
  portEXIT_CRITICAL_ISR(&captureMux);
}

void detachSignalInterrupts() {
  if (!signalInterruptsAttached) return;
  detachInterrupt(digitalPinToInterrupt(static_cast<uint8_t>(kClockPin)));
  detachInterrupt(digitalPinToInterrupt(static_cast<uint8_t>(kClearPin)));
  signalInterruptsAttached = false;
}

void attachSignalInterrupts() {
  attachInterrupt(digitalPinToInterrupt(static_cast<uint8_t>(kClockPin)), onClockRise, RISING);
  attachInterrupt(digitalPinToInterrupt(static_cast<uint8_t>(kClearPin)), onClearChange, CHANGE);
  signalInterruptsAttached = true;
}

void resetAndArmCapture() {
  detachSignalInterrupts();
  const uint8_t levels =
      gpio_get_level(kClockPin) |
      (gpio_get_level(kInputAPin) << 1) |
      (gpio_get_level(kInputBPin) << 2) |
      (gpio_get_level(kClearPin) << 3);

  portENTER_CRITICAL(&captureMux);
  totalEvents = 0;
  totalClockEdges = 0;
  incompleteGroups = 0;
  clocksWhileClearLow = 0;
  lastClockUs = micros();
  currentGroupGapUs = 0;
  bitCount = 0;
  shiftA = 0;
  shiftB = 0;
  shiftEffective = 0;
  captureStopReason = kStopNone;
  captureStopRequested = false;
  captureEnabled = true;
  diagnosticClockRises = 0;
  diagnosticAChanges = 0;
  diagnosticBChanges = 0;
  diagnosticClearChanges = 0;
  diagnosticABDisagreements = 0;
  lastClockRiseUs = micros();
  lastClockPeriodUs = 0;
  minClockPeriodUs = UINT32_MAX;
  maxClockPeriodUs = 0;
  lastSampledLevels = static_cast<uint8_t>((levels >> 1) & 0x07);
  seenHighMask = levels;
  seenLowMask = static_cast<uint8_t>((~levels) & 0x0F);
  clockPeriodPrimed = false;
  sampledLevelsPrimed = true;
  portEXIT_CRITICAL(&captureMux);

  attachSignalInterrupts();
}

void freezeCapture() {
  portENTER_CRITICAL(&captureMux);
  if (captureEnabled) {
    captureEnabled = false;
    captureStopRequested = true;
    captureStopReason = kStopManual;
  }
  portEXIT_CRITICAL(&captureMux);
}
const char* resetReasonName(esp_reset_reason_t reason) {
  switch (reason) {
    case ESP_RST_POWERON: return "power_on";
    case ESP_RST_EXT: return "external_pin";
    case ESP_RST_SW: return "software";
    case ESP_RST_PANIC: return "panic";
    case ESP_RST_INT_WDT: return "interrupt_watchdog";
    case ESP_RST_TASK_WDT: return "task_watchdog";
    case ESP_RST_WDT: return "other_watchdog";
    case ESP_RST_DEEPSLEEP: return "deep_sleep";
    case ESP_RST_BROWNOUT: return "brownout";
    case ESP_RST_SDIO: return "sdio";
    default: return "unknown";
  }
}
uint32_t readUintArg(const char* name, uint32_t fallback, uint32_t minimum, uint32_t maximum) {
  if (!server.hasArg(name)) {
    return fallback;
  }

  const long parsed = server.arg(name).toInt();
  if (parsed < static_cast<long>(minimum)) {
    return minimum;
  }
  if (parsed > static_cast<long>(maximum)) {
    return maximum;
  }
  return static_cast<uint32_t>(parsed);
}

bool copyEvent(uint32_t sequence, ByteEvent& destination) {
  if (sequence == 0) {
    return false;
  }

  const size_t index = (sequence - 1) % kEventCapacity;
  portENTER_CRITICAL(&captureMux);
  const bool valid = eventBuffer[index].sequence == sequence;
  if (valid) {
    destination.sequence = eventBuffer[index].sequence;
    destination.atUs = eventBuffer[index].atUs;
    destination.precedingGapUs = eventBuffer[index].precedingGapUs;
    destination.inputA = eventBuffer[index].inputA;
    destination.inputB = eventBuffer[index].inputB;
    destination.effective = eventBuffer[index].effective;
    destination.clearLevel = eventBuffer[index].clearLevel;
  }
  portEXIT_CRITICAL(&captureMux);
  return valid;
}

bool copyLiveSample(uint32_t sequence, LiveSample& destination) {
  if (sequence == 0) return false;

  const size_t index = (sequence - 1) % kLiveSampleCapacity;
  portENTER_CRITICAL(&captureMux);
  const bool valid = liveSampleBuffer[index].sequence == sequence;
  if (valid) {
    destination.sequence = liveSampleBuffer[index].sequence;
    destination.atUs = liveSampleBuffer[index].atUs;
    destination.inputA = liveSampleBuffer[index].inputA;
    destination.inputB = liveSampleBuffer[index].inputB;
    destination.effective = liveSampleBuffer[index].effective;
    destination.clearLevel = liveSampleBuffer[index].clearLevel;
  }
  portEXIT_CRITICAL(&captureMux);
  return valid;
}

void serviceDisplayDecoder() {
  uint32_t newest;
  portENTER_CRITICAL(&captureMux);
  newest = liveSampleSequence;
  portEXIT_CRITICAL(&captureMux);

  if (newest - decoderReadSequence > kLiveSampleCapacity) {
    const uint32_t firstAvailable = newest - kLiveSampleCapacity + 1;
    decoderQueueDrops += firstAvailable - (decoderReadSequence + 1);
    decoderReadSequence = firstAvailable - 1;
  }

  uint16_t serviced = 0;
  while (decoderReadSequence < newest && serviced < kLiveSampleCapacity) {
    const uint32_t sequence = decoderReadSequence + 1;
    LiveSample sample;
    if (copyLiveSample(sequence, sample)) {
      displayDecoder.ingest(sample.atUs, sample.inputA, sample.inputB,
                            sample.effective, sample.clearLevel);
    } else {
      ++decoderQueueDrops;
    }
    decoderReadSequence = sequence;
    ++serviced;
  }
  displayDecoder.tick(micros());
}

void scrubString(String& value) {
  for (size_t i = 0; i < value.length(); ++i) {
    value.setCharAt(i, '\0');
  }
  value = String();
}

bool saveNetworkCredentials(const String& ssid, const String& password) {
  Preferences preferences;
  if (!preferences.begin(kPreferencesNamespace, false)) {
    return false;
  }

  const size_t ssidBytes = preferences.putString("ssid", ssid);
  const size_t passwordBytes = preferences.putString("pass", password);
  preferences.end();
  return ssidBytes == ssid.length() &&
         (password.isEmpty() || passwordBytes == password.length());
}

bool loadNetworkCredentials(String& ssid, String& password) {
  Preferences preferences;
  if (!preferences.begin(kPreferencesNamespace, true)) {
    return false;
  }

  ssid = preferences.getString("ssid", "");
  password = preferences.getString("pass", "");
  preferences.end();
  return !ssid.isEmpty();
}

void startStationConnection(const String& ssid, String& password) {
  stationSsid = ssid;
  stationConfigured = true;
  lastReconnectAttemptMs = millis();
  WiFi.disconnect(false, false);
  WiFi.begin(stationSsid.c_str(), password.c_str());
  scrubString(password);
}

void connectToStoredNetwork() {
  String ssid;
  String password;
  if (!loadNetworkCredentials(ssid, password)) {
    stationConfigured = false;
    return;
  }

  startStationConnection(ssid, password);
}

bool startRecoveryAccessPoint() {
  if (apActive) {
    return true;
  }

  apActive = WiFi.softAP(kApName, kApPassword);
  if (!apActive) {
    Serial.println("Failed to start recovery access point");
  }
  return apActive;
}

void stopRecoveryAccessPoint() {
  if (apActive && WiFi.softAPdisconnect(true)) {
    apActive = false;
  }
}

void maintainStationConnection() {
  static wl_status_t previousStatus = WL_NO_SHIELD;
  const wl_status_t status = WiFi.status();
  const uint32_t now = millis();

  if (status == WL_CONNECTED) {
    if (previousStatus != WL_CONNECTED) {
      stationConnectedSinceMs = now;
      stationDisconnectedSinceMs = 0;
    }

    if (!mdnsStarted) {
      mdnsStarted = MDNS.begin(kHostName);
      if (mdnsStarted) {
        MDNS.addService("http", "tcp", 80);
      }
    }

    if (previousStatus != WL_CONNECTED) {
      Serial.print("LAN address: http://");
      Serial.println(WiFi.localIP());
      if (mdnsStarted) {
        Serial.print("mDNS address: http://");
        Serial.print(kHostName);
        Serial.println(".local");
      }
    }

    if (apActive && stationConnectedSinceMs != 0 &&
        now - stationConnectedSinceMs >= kApShutdownDelayMs) {
      stopRecoveryAccessPoint();
    }
  } else {
    stationConnectedSinceMs = 0;
    if (previousStatus == WL_CONNECTED) {
      stationDisconnectedSinceMs = now;
    }

    if (mdnsStarted) {
      MDNS.end();
      mdnsStarted = false;
    }

    if (stationConfigured && now - lastReconnectAttemptMs >= kReconnectIntervalMs) {
      lastReconnectAttemptMs = now;
      WiFi.reconnect();
    }
    if (stationConfigured && !apActive && stationDisconnectedSinceMs != 0 &&
        now - stationDisconnectedSinceMs >= kApRecoveryDelayMs) {
      startRecoveryAccessPoint();
    }
  }

  previousStatus = status;
}
void appendHexByte(String& output, uint8_t value) {
  char formatted[7];
  snprintf(formatted, sizeof(formatted), "\"0x%02X\"", value);
  output += formatted;
}

void appendFrame(String& output, const uint8_t frame[4]) {
  output += '[';
  for (uint8_t index = 0; index < 4; ++index) {
    if (index != 0) output += ',';
    appendHexByte(output, frame[index]);
  }
  output += ']';
}

void handleDisplay() {
  const sr800::DecoderSnapshot state = displayDecoder.snapshot();
  String json;
  json.reserve(1100);
  json += F("{\"firmware_version\":\"");
  json += kFirmwareVersion;
  json += F("\",\"fresh\":");
  json += state.fresh ? F("true") : F("false");
  json += F(",\"mode\":\"");
  json += sr800::displayModeName(state.mode);
  json += F("\",\"edit_selection\":\"");
  json += sr800::editSelectionName(state.editSelection);
  json += F("\",\"phase_locked\":");
  json += state.phaseLocked ? F("true") : F("false");
  json += F(",\"phase_offset\":");
  if (state.phaseLocked) json += static_cast<unsigned>(state.phaseOffset);
  else json += F("null");
  json += F(",\"visible_valid_mask\":");
  json += static_cast<unsigned>(state.visibleValidMask);
  json += F(",\"visible_frame_hex\":");
  appendFrame(json, state.visible);
  json += F(",\"effective_valid_mask\":");
  json += static_cast<unsigned>(state.effectiveValidMask);
  json += F(",\"effective_frame_hex\":");
  appendFrame(json, state.effective);
  json += F(",\"frame_confidence_pct\":");
  json += static_cast<unsigned>(state.frameConfidencePct);
  json += F(",\"mode_confidence_pct\":");
  json += static_cast<unsigned>(state.modeConfidencePct);
  json += F(",\"fan\":");
  if (state.fan >= 0) json += static_cast<int>(state.fan);
  else json += F("null");
  json += F(",\"power\":");
  if (state.power >= 0) json += static_cast<int>(state.power);
  else json += F("null");
  json += F(",\"timer_tenths\":");
  if (state.timerTenths >= 0) json += state.timerTenths;
  else json += F("null");
  json += F(",\"timer_text\":");
  if (state.timerTenths >= 0) {
    json += '"';
    json += state.timerTenths / 10;
    json += '.';
    json += state.timerTenths % 10;
    json += '"';
  } else {
    json += F("null");
  }
  json += F(",\"cooling_value\":");
  if (state.coolingValue >= 0) json += static_cast<int>(state.coolingValue);
  else json += F("null");
  json += F(",\"last_frame_age_ms\":");
  if (state.lastFrameUs != 0) json += (micros() - state.lastFrameUs) / 1000;
  else json += F("null");
  json += F(",\"input_samples\":");
  json += state.inputSamples;
  json += F(",\"accepted_samples\":");
  json += state.acceptedSamples;
  json += F(",\"rejected_a_b_disagreements\":");
  json += state.rejectedDisagreements;
  json += F(",\"rejected_clear_low\":");
  json += state.rejectedClearLow;
  json += F(",\"timing_resets\":");
  json += state.timingResets;
  json += F(",\"vote_windows\":");
  json += state.voteWindows;
  json += F(",\"valid_frames\":");
  json += state.validFrames;
  json += F(",\"queue_drops\":");
  json += decoderQueueDrops;
  json += '}';
  server.send(200, "application/json", json);
}

void handleStatus() {
  uint32_t events;
  uint32_t clocks;
  uint32_t incomplete;
  uint32_t clearClocks;
  uint32_t gap;
  uint32_t diagRises;
  uint32_t aChanges;
  uint32_t bChanges;
  uint32_t clearChanges;
  uint32_t abDisagreements;
  uint32_t lastPeriodUs;
  uint32_t minPeriodUs;
  uint32_t maxPeriodUs;
  uint8_t partialBits;
  uint8_t highMask;
  uint8_t lowMask;
  bool stopRequested;
  bool enabled;
  uint8_t stopReason;

  portENTER_CRITICAL(&captureMux);
  events = totalEvents;
  clocks = totalClockEdges;
  incomplete = incompleteGroups;
  clearClocks = clocksWhileClearLow;
  gap = groupGapUs;
  partialBits = bitCount;
  stopRequested = captureStopRequested;
  enabled = captureEnabled;
  stopReason = captureStopReason;
  diagRises = diagnosticClockRises;
  aChanges = diagnosticAChanges;
  bChanges = diagnosticBChanges;
  clearChanges = diagnosticClearChanges;
  abDisagreements = diagnosticABDisagreements;
  lastPeriodUs = lastClockPeriodUs;
  minPeriodUs = minClockPeriodUs;
  maxPeriodUs = maxClockPeriodUs;
  highMask = seenHighMask;
  lowMask = seenLowMask;
  portEXIT_CRITICAL(&captureMux);

  const bool stationConnected = WiFi.status() == WL_CONNECTED;
  float chipTempC = NAN;
  if (chipTemperatureSensor != nullptr) {
    temperature_sensor_get_celsius(chipTemperatureSensor, &chipTempC);
  }
  const int clockLevel = gpio_get_level(kClockPin);
  const int inputALevel = gpio_get_level(kInputAPin);
  const int inputBLevel = gpio_get_level(kInputBPin);
  const int clearLevel = gpio_get_level(kClearPin);
  const esp_partition_t* runningPartition = esp_ota_get_running_partition();
  const esp_partition_t* nextPartition = esp_ota_get_next_update_partition(nullptr);
  String json;
  json.reserve(1800);
  json += F("{\"firmware_version\":\"");
  json += kFirmwareVersion;
  json += F("\",\"ota_running_partition\":\"");
  if (runningPartition != nullptr) json += runningPartition->label;
  json += F("\",\"ota_next_partition\":\"");
  if (nextPartition != nullptr) json += nextPartition->label;
  json += F("\",\"ota_slot_bytes\":");
  json += nextPartition != nullptr ? nextPartition->size : 0;
  json += F(",\"ap_active\":");
  json += apActive ? F("true") : F("false");
  json += F(",\"ap_ssid\":\"");
  json += kApName;
  json += F("\",\"ap_ip\":\"");
  json += WiFi.softAPIP().toString();
  json += F("\",\"station_configured\":");
  json += stationConfigured ? F("true") : F("false");
  json += F(",\"station_connected\":");
  json += stationConnected ? F("true") : F("false");
  json += F(",\"station_ip\":\"");
  if (stationConnected) json += WiFi.localIP().toString();
  json += F("\",\"station_rssi_dbm\":");
  if (stationConnected) json += WiFi.RSSI();
  else json += F("null");
  json += F(",\"hostname\":\"");
  json += kHostName;
  json += F(".local\",\"chip_temp_c\":");
  if (isnan(chipTempC)) {
    json += F("null,\"chip_temp_f\":null");
  } else {
    json += String(chipTempC, 1);
    json += F(",\"chip_temp_f\":");
    json += String(chipTempC * 1.8f + 32.0f, 1);
  }
  json += F(",\"uptime_s\":");
  json += millis() / 1000;
  json += F(",\"boot_count\":");
  json += bootCount;
  json += F(",\"reset_reason\":\"");
  json += resetReasonName(bootResetReason);
  json += F("\",\"free_heap_bytes\":");
  json += ESP.getFreeHeap();
  json += F(",\"min_free_heap_bytes\":");
  json += ESP.getMinFreeHeap();
  json += F(",\"clock_gpio\":4,\"a_gpio\":5,\"b_gpio\":6,\"clear_gpio\":7");
  const sr800::DecoderSnapshot displayState = displayDecoder.snapshot();
  json += F(",\"display_fresh\":");
  json += displayState.fresh ? F("true") : F("false");
  json += F(",\"display_mode\":\"");
  json += sr800::displayModeName(displayState.mode);
  json += F("\",\"display_edit_selection\":\"");
  json += sr800::editSelectionName(displayState.editSelection);
  json += F("\",\"display_frame_confidence_pct\":");
  json += static_cast<unsigned>(displayState.frameConfidencePct);
  json += F(",\"signal_interrupts_attached\":");
  json += signalInterruptsAttached ? F("true") : F("false");
  json += F(",\"clock_edge_mode\":\"rising\"");
  json += F(",\"clock_level\":");
  json += clockLevel;
  json += F(",\"a_level\":");
  json += inputALevel;
  json += F(",\"b_level\":");
  json += inputBLevel;
  json += F(",\"clear_level\":");
  json += clearLevel;
  json += F(",\"clock_seen_high\":");
  json += (highMask & 0x01) ? F("true") : F("false");
  json += F(",\"clock_seen_low\":");
  json += (lowMask & 0x01) ? F("true") : F("false");
  json += F(",\"a_seen_high\":");
  json += (highMask & 0x02) ? F("true") : F("false");
  json += F(",\"a_seen_low\":");
  json += (lowMask & 0x02) ? F("true") : F("false");
  json += F(",\"b_seen_high\":");
  json += (highMask & 0x04) ? F("true") : F("false");
  json += F(",\"b_seen_low\":");
  json += (lowMask & 0x04) ? F("true") : F("false");
  json += F(",\"clear_seen_high\":");
  json += (highMask & 0x08) ? F("true") : F("false");
  json += F(",\"clear_seen_low\":");
  json += (lowMask & 0x08) ? F("true") : F("false");
  json += F(",\"diagnostic_clock_rises\":");
  json += diagRises;
  json += F(",\"diagnostic_clock_falls\":null");
  json += F(",\"diagnostic_sampling\":\"a_b_at_clock_rise_clear_async\"");
  json += F(",\"diagnostic_a_changes\":");
  json += aChanges;
  json += F(",\"diagnostic_b_changes\":");
  json += bChanges;
  json += F(",\"diagnostic_clear_changes\":");
  json += clearChanges;
  json += F(",\"diagnostic_a_b_disagreements\":");
  json += abDisagreements;
  json += F(",\"clock_last_period_us\":");
  json += lastPeriodUs;
  json += F(",\"clock_min_period_us\":");
  if (minPeriodUs == UINT32_MAX) json += F("null"); else json += minPeriodUs;
  json += F(",\"clock_max_period_us\":");
  json += maxPeriodUs;
  json += F(",\"capture_armed\":");
  json += (enabled && signalInterruptsAttached) ? F("true") : F("false");
  json += F(",\"capture_complete\":");
  json += stopRequested ? F("true") : F("false");
  json += F(",\"capture_stop_reason\":\"");
  if (stopReason == kStopEventLimit) json += F("event_limit");
  else if (stopReason == kStopClockLimit) json += F("clock_limit");
  else if (stopReason == kStopManual) json += F("manual");
  json += F("\",\"event_limit\":");
  json += kEventCapacity;
  json += F(",\"clock_edge_limit\":");
  json += kClockEdgeLimit;
  json += F(",\"clock_edges\":");
  json += clocks;
  json += F(",\"byte_events\":");
  json += events;
  json += F(",\"incomplete_groups\":");
  json += incomplete;
  json += F(",\"clocks_while_clear_low\":");
  json += clearClocks;
  json += F(",\"partial_bits\":");
  json += partialBits;
  json += F(",\"group_gap_us\":");
  json += gap;
  json += '}';

  server.send(200, "application/json", json);
}

void handleEvents() {
  const uint32_t limit = readUintArg("limit", 160, 1, 512);
  uint32_t newest;

  portENTER_CRITICAL(&captureMux);
  newest = totalEvents;
  portEXIT_CRITICAL(&captureMux);

  const uint32_t available = newest < kEventCapacity ? newest : kEventCapacity;
  const uint32_t count = limit < available ? limit : available;
  const uint32_t first = count == 0 ? 0 : newest - count + 1;

  String json;
  json.reserve(96 + count * 96);
  json += F("{\"events\":[");

  bool wroteOne = false;
  for (uint32_t sequence = first; sequence != 0 && sequence <= newest; ++sequence) {
    ByteEvent event;
    if (!copyEvent(sequence, event)) {
      continue;
    }

    if (wroteOne) {
      json += ',';
    }
    wroteOne = true;

    char row[160];
    snprintf(row, sizeof(row),
             "{\"seq\":%lu,\"us\":%lu,\"gap\":%lu,\"a\":%u,\"b\":%u,\"effective\":%u,\"clear\":%u}",
             static_cast<unsigned long>(event.sequence),
             static_cast<unsigned long>(event.atUs),
             static_cast<unsigned long>(event.precedingGapUs),
             event.inputA, event.inputB, event.effective, event.clearLevel);
    json += row;
  }

  json += F("]}");
  server.send(200, "application/json", json);
}

void handleCsv() {
  const uint32_t limit = readUintArg("limit", kEventCapacity, 1, kEventCapacity);
  uint32_t newest;

  portENTER_CRITICAL(&captureMux);
  newest = totalEvents;
  portEXIT_CRITICAL(&captureMux);

  const uint32_t available = newest < kEventCapacity ? newest : kEventCapacity;
  const uint32_t count = limit < available ? limit : available;
  const uint32_t first = count == 0 ? 0 : newest - count + 1;

  server.sendHeader("Content-Disposition", "attachment; filename=sr800-capture.csv");
  server.setContentLength(CONTENT_LENGTH_UNKNOWN);
  server.send(200, "text/csv", "sequence,time_us,preceding_gap_us,input_a_hex,input_b_hex,effective_and_hex,clear\n");

  char row[128];
  for (uint32_t sequence = first; sequence != 0 && sequence <= newest; ++sequence) {
    ByteEvent event;
    if (!copyEvent(sequence, event)) {
      continue;
    }

    snprintf(row, sizeof(row), "%lu,%lu,%lu,0x%02X,0x%02X,0x%02X,%u\n",
             static_cast<unsigned long>(event.sequence),
             static_cast<unsigned long>(event.atUs),
             static_cast<unsigned long>(event.precedingGapUs),
             event.inputA, event.inputB, event.effective, event.clearLevel);
    server.sendContent(row);
    if ((sequence & 0x1F) == 0) serviceDisplayDecoder();
    delay(0);
  }
  server.sendContent("");
}

void handleClear() {
  resetAndArmCapture();
  server.send(200, "application/json", "{\"ok\":true,\"armed\":true}");
}

void handleFreeze() {
  freezeCapture();
  server.send(200, "application/json", "{\"ok\":true,\"armed\":false}");
}

void handleGap() {
  const uint32_t requested = readUintArg("us", 40, 2, 100000);
  portENTER_CRITICAL(&captureMux);
  groupGapUs = requested;
  bitCount = 0;
  shiftA = 0;
  shiftB = 0;
  shiftEffective = 0;
  portEXIT_CRITICAL(&captureMux);

  server.send(200, "application/json", "{\"ok\":true}");
}

void handleWifiConfiguration() {
  if (!server.hasArg("ssid") || !server.hasArg("password")) {
    server.send(400, "application/json", "{\"ok\":false,\"message\":\"Wi-Fi name and password are required.\"}");
    return;
  }

  const String ssid = server.arg("ssid");
  String password = server.arg("password");
  if (ssid.isEmpty() || ssid.length() > 32) {
    scrubString(password);
    server.send(400, "application/json", "{\"ok\":false,\"message\":\"Wi-Fi name must be 1 to 32 characters.\"}");
    return;
  }
  if ((!password.isEmpty() && password.length() < 8) || password.length() > 63) {
    scrubString(password);
    server.send(400, "application/json", "{\"ok\":false,\"message\":\"Password must be empty for an open network or 8 to 63 characters.\"}");
    return;
  }
  if (!saveNetworkCredentials(ssid, password)) {
    scrubString(password);
    server.send(500, "application/json", "{\"ok\":false,\"message\":\"Could not save network settings.\"}");
    return;
  }

  startStationConnection(ssid, password);
  server.send(202, "application/json", "{\"ok\":true,\"message\":\"Settings saved. Waiting for the LAN connection...\"}");
}

void handleWifiForget() {
  Preferences preferences;
  const bool opened = preferences.begin(kPreferencesNamespace, false);
  if (opened) {
    preferences.clear();
    preferences.end();
  }

  stationSsid = String();
  stationConfigured = false;
  startRecoveryAccessPoint();
  if (mdnsStarted) {
    MDNS.end();
    mdnsStarted = false;
  }
  WiFi.disconnect(false, false);
  server.send(opened ? 200 : 500, "application/json",
              opened
                  ? "{\"ok\":true,\"message\":\"Saved home Wi-Fi removed. Recovery access point remains active.\"}"
                  : "{\"ok\":false,\"message\":\"Could not open saved network settings.\"}");
}
void handleUpdateUpload() {
  HTTPUpload& upload = server.upload();
  if (upload.status == UPLOAD_FILE_START) {
    freezeCapture();
    detachSignalInterrupts();
    updateStarted = false;
    updateFinished = false;
    otaHandleActive = false;
    otaBytesWritten = 0;
    otaTargetPartition = esp_ota_get_next_update_partition(nullptr);
    otaError = otaTargetPartition == nullptr
                   ? ESP_ERR_NOT_FOUND
                   : esp_ota_begin(otaTargetPartition, OTA_WITH_SEQUENTIAL_WRITES, &otaHandle);
    updateStarted = otaError == ESP_OK;
    otaHandleActive = updateStarted;
  } else if (upload.status == UPLOAD_FILE_WRITE) {
    if (otaHandleActive && otaError == ESP_OK) {
      otaError = esp_ota_write(otaHandle, upload.buf, upload.currentSize);
      if (otaError == ESP_OK) otaBytesWritten += upload.currentSize;
    }
  } else if (upload.status == UPLOAD_FILE_END) {
    if (otaHandleActive) {
      if (otaError == ESP_OK && otaBytesWritten > 0) {
        otaError = esp_ota_end(otaHandle);
      } else {
        esp_ota_abort(otaHandle);
        if (otaError == ESP_OK) otaError = ESP_ERR_INVALID_SIZE;
      }
      otaHandleActive = false;
    }
    if (otaError == ESP_OK && otaTargetPartition != nullptr) {
      otaError = esp_ota_set_boot_partition(otaTargetPartition);
    }
    updateFinished = updateStarted && otaError == ESP_OK;
  } else if (upload.status == UPLOAD_FILE_ABORTED) {
    if (otaHandleActive) esp_ota_abort(otaHandle);
    otaHandleActive = false;
    otaError = ESP_ERR_INVALID_STATE;
    updateFinished = false;
  }
}

void handleUpdateFinished() {
  const bool succeeded = updateStarted && updateFinished && otaError == ESP_OK;
  server.sendHeader("Connection", "close");
  if (succeeded) {
    server.send(200, "text/plain", "Update complete and validated. Restarting...");
    delay(500);
    ESP.restart();
  } else {
    String message = F("Update failed (");
    message += esp_err_to_name(otaError);
    message += F("). The current firmware remains selected; retry with the application .ino.bin file.");
    server.send(500, "text/plain", message);
    attachSignalInterrupts();
  }
}

void setupWebServer() {
  server.on("/", HTTP_GET, []() { server.send_P(200, "text/html", kPage); });
  server.on("/update", HTTP_GET, []() { server.send_P(200, "text/html", kUpdatePage); });
  server.on("/update", HTTP_POST, handleUpdateFinished, handleUpdateUpload);
  server.on("/api/status", HTTP_GET, handleStatus);
  server.on("/api/display", HTTP_GET, handleDisplay);
  server.on("/api/events", HTTP_GET, handleEvents);
  server.on("/api/clear", HTTP_POST, handleClear);
  server.on("/api/freeze", HTTP_POST, handleFreeze);
  server.on("/api/gap", HTTP_POST, handleGap);
  server.on("/api/wifi", HTTP_POST, handleWifiConfiguration);
  server.on("/api/wifi/forget", HTTP_POST, handleWifiForget);
  server.on("/capture.csv", HTTP_GET, handleCsv);
  server.onNotFound([]() { server.send(404, "text/plain", "Not found"); });
  server.begin();
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(300);

  bootResetReason = esp_reset_reason();
  Preferences diagnostics;
  if (diagnostics.begin(kDiagnosticsNamespace, false)) {
    bootCount = diagnostics.getUInt("boots", 0) + 1;
    diagnostics.putUInt("boots", bootCount);
    diagnostics.end();
  }

  temperature_sensor_config_t temperatureConfig =
      TEMPERATURE_SENSOR_CONFIG_DEFAULT(20, 100);
  esp_err_t temperatureResult =
      temperature_sensor_install(&temperatureConfig, &chipTemperatureSensor);
  if (temperatureResult == ESP_OK) {
    temperatureResult = temperature_sensor_enable(chipTemperatureSensor);
  }
  if (temperatureResult != ESP_OK) {
    if (chipTemperatureSensor != nullptr) {
      temperature_sensor_uninstall(chipTemperatureSensor);
      chipTemperatureSensor = nullptr;
    }
    Serial.println("Failed to start chip temperature sensor");
  }

  pinMode(static_cast<uint8_t>(kClockPin), INPUT);
  pinMode(static_cast<uint8_t>(kInputAPin), INPUT);
  pinMode(static_cast<uint8_t>(kInputBPin), INPUT);
  pinMode(static_cast<uint8_t>(kClearPin), INPUT);

  WiFi.mode(WIFI_AP_STA);
  WiFi.setSleep(true);
  WiFi.setHostname(kHostName);
  startRecoveryAccessPoint();
  connectToStoredNetwork();

  setupWebServer();
  resetAndArmCapture();
  esp_ota_mark_app_valid_cancel_rollback();

  Serial.println();
  Serial.println("SR800 sniffer ready");
  Serial.print("SSID: ");
  Serial.println(kApName);
  Serial.print("Address: http://");
  Serial.println(WiFi.softAPIP());
  Serial.println("Disconnect USB before attaching to the SR800.");
}

void loop() {
  serviceDisplayDecoder();
  server.handleClient();
  serviceDisplayDecoder();
  maintainStationConnection();
  delay(1);
}

