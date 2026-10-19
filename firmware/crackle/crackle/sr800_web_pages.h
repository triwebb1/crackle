// Static diagnostic (/probe) and OTA (/update) pages served by the controller.
//
// These literals live in a header rather than the .ino on purpose. The Arduino
// sketch preprocessor injects its auto-generated forward declarations at the
// first function definition its parser finds, and that parser sees the
// JavaScript "async function" declarations inside these raw strings. With the
// literals in the .ino, the generated prototype block landed *inside* kPage, so
// the served diagnostic page carried #line directives and mangled prototypes,
// the script died on a syntax error, and every control was dead. The build was
// clean throughout. Header files are not run through that preprocessor.
#pragma once

#include <Arduino.h>

const char kPage[] PROGMEM = R"HTML(
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SR800 Power-Stage Probe</title>
<style>
body{font:15px system-ui,sans-serif;margin:0;background:#f4f5f6;color:#16191d}
header{background:#20262d;color:white;padding:14px 18px}
main{max-width:1050px;margin:auto;padding:16px}
.warning{border-left:5px solid #b42318;background:white;padding:12px;margin-bottom:14px}
.disabled-banner{display:none;background:#b42318;color:white;padding:18px;margin-bottom:14px;font-size:20px;font-weight:800}
.disabled-banner.visible{display:block}
.controls{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0;align-items:end}
.network{border-top:1px solid #c8ced4;border-bottom:1px solid #c8ced4;padding:12px 0;margin:14px 0}
.network h2{font-size:17px;margin:0 0 8px}
.network label{display:grid;gap:4px}
button,a.button{border:1px solid #68727d;background:white;color:#111;padding:8px 11px;text-decoration:none;cursor:pointer}
input{width:min(260px,70vw);padding:7px}
pre{background:#111820;color:#d9e2ec;padding:12px;overflow:auto;min-height:70px}
table{border-collapse:collapse;width:100%;background:white;font-family:ui-monospace,monospace;font-size:13px}
th,td{border:1px solid #c8ced4;padding:5px 7px;text-align:right}
th{background:#e8ebee;position:sticky;top:0}
.table-wrap{max-height:55vh;overflow:auto}
</style>
</head>
<body>
<header><strong>SR800 Modular Actuator Proof</strong></header>
<main>
<div id="disabledBanner" class="disabled-banner">DISABLED: Factory controls were detected. ESP actuation is locked until the roaster is power-cycled.</div>
<div id="faultBanner" class="disabled-banner"></div>
<div class="warning"><strong>Powered-roaster rule:</strong> use only the permanently installed isolated charger. Do not attach a computer, serial cable, programmer, oscilloscope, or grounded instrument. Confirm four solid dashes. Run and verify the three-second 100 us Fan hardware audit before arming Heat.</div>
<div id="status"><pre>Loading status...</pre></div>
<div class="controls">
<button onclick="armCapture()">Clear &amp; arm</button>
<label>Fan level <input id="fanLevel" type="number" min="0.1" max="10" step="0.1" value="0.1"></label>
<button id="fanTestButton" onclick="runFanTest()">Run 100 us fan proof</button>
<button onclick="stopFanTest()">Stop outputs</button>
<button onclick="freezeCapture()">Freeze</button>
<a class="button" href="/capture.csv">Download edge CSV</a>
<a class="button" href="/timing.csv">Download timing CSV</a>
<a class="button" href="/update">Firmware update</a>
</div>
<div class="controls">
<label>Heat level <input id="heatLevel" type="number" min="0" max="10" step="0.1" value="0.1"></label>
<label>Heat seconds <input id="heatDuration" type="number" min="1" max="30" step="1" value="10"></label>
<button id="heaterStartButton" onclick="runHeaterProof()">Run heat test</button>
<button onclick="stopFanTest()">Stop heat and cool</button>
</div>
<div class="controls">
<label>Steps fan:heat <input id="calSteps" type="text" value="5:1,5:3,5:5,5:7" size="22"></label>
<label>Max step s <input id="calStepSeconds" type="number" min="15" max="300" step="5" value="300"></label>
<label>Min step s <input id="calMinSeconds" type="number" min="5" max="120" step="5" value="20"></label>
<label>Settle s <input id="calSettleSeconds" type="number" min="2" max="30" step="1" value="20"></label>
<label>Settle +/-C <input id="calSettleBand" type="number" min="0.2" max="10" step="0.1" value="0.2"></label>
<button id="calStartButton" onclick="startCalibration()">Start calibration program</button>
<button onclick="stopFanTest()">Stop</button>
<a class="button" href="/thermal.csv">Download thermal CSV</a>
</div>
<div class="controls">
<label>Baseline fans <input id="baseFans" type="text" value="1,4,7,10" size="10"></label>
<label>Baseline heats <input id="baseHeats" type="text" value="1,5,10" size="12"></label>
<button id="baseStartButton" onclick="startBaseline()">Start baseline air map</button>
</div>
<section class="network">
<h2>Network</h2>
<div id="networkState">Checking network...</div>
<div class="controls">
<label>Wi-Fi name <input id="wifiSsid" type="text" maxlength="32" autocomplete="username"></label>
<label>Password <input id="wifiPassword" type="password" maxlength="63" autocomplete="current-password"></label>
<button onclick="saveWifi()">Connect</button>
</div>
<div id="wifiResult"></div>
</section>
<div class="table-wrap">
<table>
<thead><tr><th>seq</th><th>time us</th><th>gap us</th><th>changed</th><th>levels</th><th>CH0</th><th>CH1</th><th>CH2</th><th>CH3</th></tr></thead>
<tbody id="events"></tbody>
</table>
</div>
</main>
<script>
function bits(v){return '0b'+Number(v).toString(2).padStart(4,'0')}
async function refresh(){
  const s=await fetch('/api/status').then(r=>r.json());
  const active=s.actuator && (s.actuator.effective_fan>0 || s.actuator.effective_heat>0);
  const e=active ? {events:[]} : await fetch('/api/events?limit=200').then(r=>r.json());
  document.getElementById('status').innerHTML='<pre>'+JSON.stringify(s,null,2)+'</pre>';
  document.getElementById('disabledBanner').classList.toggle('visible',s.manual_conflict_latched);
  const fault=s.actuator&&s.actuator.fault!=='none'?s.actuator.fault:null;
  const faultBanner=document.getElementById('faultBanner');
  const stale=fault==='thermal_stale';
  faultBanner.textContent=stale?'Live temperature updates paused. Outputs stopped; controls return after fresh telemetry.'
    :(fault?`FAULT: ${fault.replace(/_/g,' ')} - actuation disabled until power cycle`: '');
  faultBanner.classList.toggle('visible',!!fault);
  const locked=s.manual_conflict_latched||s.actuator.fault!=='none';
  const startLocked=locked||s.lifecycle!=='STANDBY';
  document.getElementById('fanTestButton').disabled=startLocked;
  document.getElementById('heaterStartButton').disabled=startLocked;
  document.getElementById('calStartButton').disabled=startLocked;
  document.getElementById('baseStartButton').disabled=startLocked;
  const currentHost=location.hostname;
  document.getElementById('networkState').innerHTML=s.station_connected
    ? `Connected: <a href="/">http://${currentHost}</a> or <a href="http://${s.hostname}">http://${s.hostname}</a>`
    : 'Home Wi-Fi is not connected.';
  document.getElementById('events').innerHTML=e.events.map(x=>`<tr><td>${x.seq}</td><td>${x.us}</td><td>${x.gap_us}</td><td>${bits(x.changed_mask)}</td><td>${bits(x.levels)}</td><td>${x.ch0}</td><td>${x.ch1}</td><td>${x.ch2}</td><td>${x.ch3}</td></tr>`).join('');
}
async function armCapture(){await fetch('/api/clear',{method:'POST'});refresh()}
async function freezeCapture(){await fetch('/api/freeze',{method:'POST'});refresh()}
async function runFanTest(){
  if(!confirm('Factory display must show four solid dashes. Start the fan-only test?'))return;
  const level=document.getElementById('fanLevel').value;
  const query=new URLSearchParams({confirm:'FOUR_DASHES',duration_ms:'3000',level});
  const response=await fetch('/api/fan-test/start?'+query,{method:'POST'});
  const message=await response.json();
  if(!response.ok){alert(message.message);return}
  refresh();
}
async function stopFanTest(){await fetch('/api/fan-test/stop',{method:'POST'});refresh()}
async function runHeaterProof(){
  const fanLevel=document.getElementById('fanLevel').value;
  const heatLevel=document.getElementById('heatLevel').value;
  const durationSeconds=document.getElementById('heatDuration').value;
  if(!confirm(`Factory display must show four solid dashes. Run Fan ${fanLevel}, then Heat ${heatLevel} for ${durationSeconds} seconds?`))return;
  const durationMs=String(Math.round(Number(durationSeconds)*1000));
  const query=new URLSearchParams({confirm:'FOUR_DASHES_HEAT_TEST',duration_ms:durationMs,fan_level:fanLevel,heat_level:heatLevel});
  const response=await fetch('/api/heater-proof/start?'+query,{method:'POST'});
  const message=await response.json();
  if(!response.ok){alert(message.message);return}
  refresh();
}
async function startBaseline(){
  const fans=document.getElementById('baseFans').value;
  const heats=document.getElementById('baseHeats').value;
  const stepSeconds=document.getElementById('calStepSeconds').value;
  const settleSeconds=document.getElementById('calSettleSeconds').value;
  const settleBand=document.getElementById('calSettleBand').value;
  if(!confirm(`Factory display must show four solid dashes. Sweep fans [${fans}] x heats [${heats}] as a serpentine grid, max ${stepSeconds}s per step, settle +/-${settleBand} C for ${settleSeconds}s? This can run for many minutes.`))return;
  const query=new URLSearchParams({confirm:'FOUR_DASHES_CALIBRATION',fans,heats,step_seconds:stepSeconds,min_step_seconds:document.getElementById('calMinSeconds').value,settle_seconds:settleSeconds,settle_band_tenths_c:String(Math.round(Number(settleBand)*10))});
  const response=await fetch('/api/calibration/start?'+query,{method:'POST'});
  const message=await response.json();
  if(!response.ok){alert(message.message);return}
  refresh();
}
async function startCalibration(){
  const steps=document.getElementById('calSteps').value;
  const stepSeconds=document.getElementById('calStepSeconds').value;
  const settleSeconds=document.getElementById('calSettleSeconds').value;
  const settleBand=document.getElementById('calSettleBand').value;
  if(!confirm(`Factory display must show four solid dashes. Run calibration steps [${steps}] (fan:heat), max ${stepSeconds}s per step, advancing early when stable within +/-${settleBand} C for ${settleSeconds}s?`))return;
  const query=new URLSearchParams({confirm:'FOUR_DASHES_CALIBRATION',steps,step_seconds:stepSeconds,min_step_seconds:document.getElementById('calMinSeconds').value,settle_seconds:settleSeconds,settle_band_tenths_c:String(Math.round(Number(settleBand)*10))});
  const response=await fetch('/api/calibration/start?'+query,{method:'POST'});
  const message=await response.json();
  if(!response.ok){alert(message.message);return}
  refresh();
}
async function saveWifi(){
  const result=document.getElementById('wifiResult');
  result.textContent='Connecting...';
  const body=new URLSearchParams({
    ssid:document.getElementById('wifiSsid').value,
    password:document.getElementById('wifiPassword').value
  });
  const response=await fetch('/api/wifi',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
  const message=await response.json();
  document.getElementById('wifiPassword').value='';
  result.textContent=message.message;
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
<h1 style="font-size:22px">Crackle firmware update</h1>
<p>Currently installed: <strong id="currentVersion">Loading...</strong></p>
<p><strong>Wireless OTA only.</strong> Stop every test, leave the factory panel at four solid dashes, and disconnect computer USB, serial, programmers, and grounded instruments. The installed isolated charger may remain powered.</p>
<form id="updateForm">
<input id="firmwareFile" type="file" name="firmware" accept=".bin,application/octet-stream" required>
<button id="uploadButton" type="submit" style="padding:8px 11px;margin-left:8px">Upload and restart</button>
</form>
<progress id="progress" value="0" max="100" style="display:none;width:100%;margin-top:16px"></progress>
<p id="result" role="status"></p>
<p><a id="returnLink" href="#">Return to Crackle</a></p>
<script>
document.getElementById('returnLink').href='http://'+location.hostname+'/';
const version=document.getElementById('currentVersion');
const form=document.getElementById('updateForm');
const file=document.getElementById('firmwareFile');
const button=document.getElementById('uploadButton');
const progress=document.getElementById('progress');
const result=document.getElementById('result');
async function readVersion(){
  try{
    const response=await fetch('/api/update/version',{cache:'no-store'});
    const status=await response.json();
    version.textContent=status.firmware_version;
    return status.firmware_version;
  }catch(error){version.textContent='Unavailable';return null;}
}
readVersion();
form.addEventListener('submit',event=>{
  event.preventDefault();
  if(!file.files.length)return;
  const selected=file.files[0];
  if(!/\.bin$/i.test(selected.name)){
    result.textContent='Choose the versioned Crackle OTA .bin file.';return;
  }
  button.disabled=true;file.disabled=true;progress.style.display='block';
  result.textContent='Uploading '+selected.name+' ('+selected.size.toLocaleString()+' bytes)...';
  const request=new XMLHttpRequest();
  request.open('POST','/update');
  request.setRequestHeader('Content-Type','application/octet-stream');
  request.upload.onprogress=e=>{if(e.lengthComputable)progress.value=e.loaded/e.total*100;};
  request.onload=()=>{
    let message=request.responseText;
    try{
      const parsed=JSON.parse(request.responseText);
      if(parsed.message)message=parsed.message;
      const detail=[parsed.code,parsed.detail].filter(Boolean).join(' / ');
      if(detail)message+=' ('+detail+')';
      if(parsed.received_sha256){
        message+=' Received SHA-256: '+parsed.received_sha256+'.';
      }
      if(parsed.flash_sha256){
        message+=' Flash SHA-256: '+parsed.flash_sha256+'.';
      }
      if(parsed.readback_complete){
        message+=' Flash readback '+(parsed.readback_match?'matched.':'DID NOT MATCH.');
      }
    }catch(error){}
    result.textContent=request.status>=200&&request.status<300
      ? message+' Keep power connected while Crackle reboots.'
      : (message||'The roaster rejected the update.');
    if(request.status<200||request.status>=300){button.disabled=false;file.disabled=false;}
  };
  request.onerror=()=>{
    result.textContent='The connection closed. The image may already be installed and rebooting. Keep power connected for two minutes, then reload this page; do not immediately unplug the roaster.';
  };
  request.send(selected);
});
</script>
</body>
</html>
)HTML";
