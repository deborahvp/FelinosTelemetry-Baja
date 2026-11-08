// Dashboard entry point: wires config, i18n, theme, live MQTT (or demo playback) and panels.

import { LiveChart, fmtNum } from './charts.js';
import { GGDiagram } from './gg.js';
import { pickLanguage, translate } from './i18n.js';
import { TrackMap } from './map.js';
import { connectLive, isBrokerUrl, resolveConnection } from './mqtt.js';
import { parseNdjson, play } from './replay.js';
import { REQUIREMENTS, runValue, summarizeGoals } from './goals.js';
import { RunLog, folderName, localDate, toCsv, toMetaYaml } from './runlog.js';
import { Store } from './state.js';
import { matchPreset, parseAxisMap, presetAxisMap } from './vehicle.js';

const DEFAULTS = {
  mqtt: { url: '', username: '', password: '', topic: 'felinos/#' },
  axisMap: { x: 'lateral', y: 'longitudinal', z: 'vertical' },
  track: 'assets/track.json',
  mapCenter: [21.0894, -101.6987],
  mapZoom: 17,
  satellite: true,
  mapMaxSpeedKmh: 50,
  windowSeconds: 60,
  placeName: 'León, Gto.',
  trackWidthM: null, // vehicle track (m) for the inner-tire turning radius (VG-05); null = CG radius only
};

// ---- small helpers -------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const store_ = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
  },
};
const params = new URLSearchParams(location.search);
let lang = pickLanguage(location.search, store_.get('felinos.lang'));
const t = (key, vars) => translate(lang, key, vars);

function setStatus(node, cls, text) {
  node.className = `status ${cls}`;
  node.replaceChildren(document.createTextNode('● '), Object.assign(document.createElement('span'), { textContent: text }));
}

function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function loadConfig() {
  try {
    const mod = await import('./config.js');
    const c = mod.default ?? {};
    return { found: true, cfg: { ...DEFAULTS, ...c, mqtt: { ...DEFAULTS.mqtt, ...(c.mqtt ?? {}) } } };
  } catch {
    return { found: false, cfg: DEFAULTS };
  }
}

// ---- app ------------------------------------------------------------------------------
const { found, cfg } = await loadConfig();
const demoUrl = params.get('demo');
const demoSpeed = demoUrl ? Number(params.get('speed')) || 1 : 1; // latency is meaningless when sped up
// Browser-saved connection (Connection dialog) wins over config.js, so a hosted copy needs no secrets.
const connection = resolveConnection(store_.get('felinos.conn'), found ? cfg.mqtt : null);
let conn = demoUrl ? 'demo' : connection.source !== 'none' ? 'connecting' : 'noConfig';
let dirty = true;

// Mounting chosen in the Mount dialog (this browser) wins over config.js.
let axisMap = cfg.axisMap;
try {
  const saved = store_.get('felinos.axisMap');
  if (saved) { parseAxisMap(saved); axisMap = saved; }
} catch { /* ignore an invalid saved map */ }

const store = new Store({
  axisMap,
  loadLevel: (device) => store_.get(`felinos.level.${device}`),
  saveLevel: (device, g) => store_.set(`felinos.level.${device}`, g),
});
let run = { run: 'R01', test: 'acceleration', suspension: 'susp-A', cvt: 'cvt-1', driver: '', place: cfg.placeName, ...store_.get('felinos.run', {}) };
const runLog = new RunLog({ load: () => store_.get('felinos.runs', []), save: (entries) => store_.set('felinos.runs', entries) });
let runLogDirty = true;

store.onChange((session, isNew) => {
  if (isNew) {
    map.reset();
    const prev = store.previous;
    if (prev) runLog.updateStats(prev.id, { analysis: prev.analysis.snapshot() }); // final numbers of the run that ended
    // A new recording in Sensor Logger = a new run in the log.
    const started = runLog.startSession(session.id, run, {
      deviceId: session.deviceId,
      startedAt: session.t0 ? session.t0 * 1000 : Date.now(),
    });
    run = started.header;
    store_.set('felinos.run', run);
    runLogDirty = true;
  }
  dirty = true;
});

// theme
document.documentElement.dataset.theme = store_.get('felinos.theme', 'light') === 'dark' ? 'dark' : 'light';

// panels
const W = cfg.windowSeconds;
const charts = {
  speed: new LiveChart($('cSpeed'), { t, windowS: W, yMin: 0, yMax: 50, series: [{ label: () => t('speed'), color: '--series-1', unit: 'km/h', digits: 1 }] }),
  accel: new LiveChart($('cAccel'), {
    t, windowS: W, yMin: -0.8, yMax: 0.8,
    series: [
      { label: () => t('longitudinal'), color: '--series-1', unit: 'g', digits: 2 },
      { label: () => t('lateral'), color: '--series-2', unit: 'g', digits: 2 },
    ],
  }),
  yaw: new LiveChart($('cYaw'), {
    t, windowS: W, yMin: -40, yMax: 40,
    series: [
      { label: () => t('yawRate'), color: '--series-1', unit: '°/s', digits: 1 },
      { label: () => t('grade'), color: '--series-2', unit: '°', digits: 1 },
    ],
  }),
};
const map = new TrackMap($('map'), { center: cfg.mapCenter, zoom: cfg.mapZoom, maxSpeedKmh: cfg.mapMaxSpeedKmh, t, satellite: cfg.satellite });
const gg = new GGDiagram($('gg'), t);
const hasTrack = cfg.track ? await map.loadTrack(cfg.track) : false;

// ---- rendering ------------------------------------------------------------------------
function renderData() {
  const s = store.session;
  if (!s) return;
  const tmax = s.duration;
  charts.speed.setData([s.gps.t, s.gps.speed], tmax);
  charts.accel.setData([s.imu.t, s.imu.along, s.imu.alat], tmax);
  charts.yaw.setData([s.imu.t, s.imu.yaw, s.imu.grade], tmax);
  map.update(s.gps);
  gg.update(s.recentImu(W));

  $('kSpeed').textContent = fmtNum(s.now.speed, 1);
  $('nSpeed').textContent = fmtNum(s.now.speed, 1);
  $('kSpeedMax').textContent = fmtNum(s.max.speed, 1);
  $('kLong').textContent = fmtNum(s.now.along, 2);
  $('nLong').textContent = fmtNum(s.now.along, 2);
  $('kLongMax').textContent = fmtNum(s.max.along, 2);
  $('kLat').textContent = fmtNum(s.now.alat, 2);
  $('nLat').textContent = fmtNum(s.now.alat, 2);
  $('kLatMax').textContent = fmtNum(s.max.alat, 2);
  $('nYaw').textContent = fmtNum(s.now.yaw, 1);
  $('nGrade').textContent = fmtNum(s.now.grade, 1);

  const n = s.gps.lat.length;
  if (n) {
    const lat = s.gps.lat[n - 1];
    const lon = s.gps.lon[n - 1];
    $('mapCoords').hidden = false;
    $('mapCoords').textContent = `${Math.abs(lat).toFixed(4)}° ${t(lat >= 0 ? 'dirN' : 'dirS')}, ${Math.abs(lon).toFixed(4)}° ${t(lon >= 0 ? 'dirE' : 'dirW')}`;
  }

  runLog.updateStats(s.id, {
    lastSampleAt: s.tLast * 1000, maxSpeed: s.max.speed, maxAlong: s.max.along, maxAlat: s.max.alat,
    deviceId: s.deviceId, analysis: s.analysis.snapshot(),
  });
  runLogDirty = true;
}

/** Result shown in the run log for the run's own test type (live estimate). */
function runResult(e) {
  const req = REQUIREMENTS.find((r) => r.test === e.test);
  if (!req) return '—';
  const v = runValue(req, e, { trackWidthM: cfg.trackWidthM });
  return v === null ? '—' : `${fmtNum(v, 2)} ${req.unit}`;
}

function renderGoals() {
  const g = summarizeGoals(runLog.entries, { today: localDate(Date.now()), trackWidthM: cfg.trackWidthM });
  const ids = { 'VG-04': '04', 'VG-05': '05', 'VG-06': '06' };
  for (const r of g.requirements) {
    const id = ids[r.id];
    const val = $(`gVal${id}`);
    $(`gRuns${id}`).textContent = t('nRuns', { n: r.n, m: r.minRuns });
    if (r.status === 'noData') {
      val.className = 'req-val num';
      val.textContent = t('noData');
      val.title = '';
      continue;
    }
    const mark = r.status === 'info' ? '' : r.meets ? ' ✓' : ' ✕';
    val.textContent = `${fmtNum(r.mean, r.unit === 's' ? 2 : 1)} ${r.unit}${mark}`;
    val.className = `req-val num ${r.status === 'info' ? 'info' : r.meets ? 'good' : 'bad'}`;
    val.title = r.cgOnly ? t('cgRadius') : r.n > 1 ? `± ${fmtNum(r.sd, 2)} ${r.unit}` : '';
  }
  const h = g.durability.activeHours;
  $('gVal02').textContent = `${fmtNum(h, h < 10 ? 2 : 1)} / ${g.durability.targetHours} h`;
  $('gBar02').style.width = `${(g.durability.fraction * 100).toFixed(1)}%`;
  $('eImpact').textContent = g.events.impact;
  $('eJump').textContent = g.events.jump;
  $('eBrake').textContent = g.events.hardBrake;
  $('uActive').textContent = clock(g.today.activeS);
  $('uDist').textContent = `${fmtNum(g.today.distanceM / 1000, 2)} km`;
}

function renderRunLog() {
  const current = store.session?.id;
  const rows = [...runLog.entries].reverse().map((e) => {
    const tr = document.createElement('tr');
    if (e.sessionId === current) tr.className = 'current';
    const d = new Date(e.startedAt);
    const start = `${localDate(e.startedAt)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const cells = [
      [e.run, ''],
      [t(`t_${e.test}`), ''],
      [[e.suspension, e.cvt].filter(Boolean).join(' · ') || '—', ''],
      [e.driver || '—', ''],
      [start, ''],
      [clock(e.duration), 'r'],
      [e.analysis ? clock(e.analysis.activeS) : '—', 'r'],
      [e.analysis ? `${fmtNum(e.analysis.distanceM / 1000, 2)} km` : '—', 'r'],
      [`${fmtNum(e.maxSpeed, 1)} km/h`, 'r'],
      [`${fmtNum(e.maxAlong, 2)} / ${fmtNum(e.maxAlat, 2)}`, 'r'],
      [e.analysis ? `${e.analysis.counts.impact} / ${e.analysis.counts.jump} / ${e.analysis.counts.hardBrake}` : '—', 'r'],
      [runResult(e), 'r'],
    ];
    cells.forEach(([text, cls], i) => {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      if (i === 0) {
        td.appendChild(Object.assign(document.createElement('b'), { textContent: text }));
        if (e.sessionId === current) td.appendChild(Object.assign(document.createElement('span'), { className: 'live-tag', textContent: t('liveNow') }));
      } else {
        td.textContent = text;
      }
      tr.appendChild(td);
    });
    const td = document.createElement('td');
    td.className = 'r';
    const btn = Object.assign(document.createElement('button'), { className: 'small-btn', textContent: 'meta.yaml', title: `${folderName(e)}/meta.yaml` });
    btn.onclick = () => download(`${folderName(e)}.meta.yaml`, toMetaYaml(e, { axisMap }), 'text/yaml');
    td.appendChild(btn);
    tr.appendChild(td);
    return tr;
  });
  $('runRows').replaceChildren(...rows);
  $('runEmpty').hidden = rows.length > 0;
}

function renderStatus() {
  const s = store.session;
  const age = s?.lastReceivedMs ? (Date.now() - s.lastReceivedMs) / 1000 : null;

  // connection pill
  const pill = $('pill');
  const pillState = {
    connecting: ['warn', t('connecting')],
    connected: ['', t('connected')],
    reconnecting: ['warn', t('reconnecting')],
    offline: ['bad', t('offline')],
    auth: ['bad', t('offline')],
    noConfig: ['bad', t('noConfig')],
    demo: ['', t('demo')],
  }[conn];
  let cls = pillState[0];
  if ((conn === 'connected' || conn === 'demo') && age !== null && age > 5) cls = 'warn';
  pill.className = `pill ${cls}`;
  $('pillText').textContent = age !== null && (conn === 'connected' || conn === 'demo') ? `${pillState[1]} · ${age.toFixed(1)} s` : pillState[1];

  // banner
  const banner = $('banner');
  const msg = conn === 'noConfig' ? ['bad', t('noConfigBanner')] : conn === 'auth' ? ['bad', t('authError')] : conn === 'connected' && !s ? ['', t('waitingData')] : null;
  banner.hidden = !msg;
  if (msg) {
    const clickable = conn === 'noConfig' || conn === 'auth';
    banner.className = `banner ${msg[0]}${clickable ? ' clickable' : ''}`;
    banner.textContent = msg[1];
  }

  // run meta
  $('mRun').textContent = run.run;
  $('mTest').textContent = t(`t_${run.test}`);
  $('mConfig').textContent = [run.suspension, run.cvt].filter(Boolean).join(' · ') || '—';
  const day = s?.t0 ? new Date(s.t0 * 1000) : new Date();
  const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  $('mSession').textContent = [date, run.place, s ? s.id.slice(0, 8) : null].filter(Boolean).join(' · ');

  if (!s) {
    $('kRec').textContent = t('waiting');
    setStatus($('kAccStatus'), '', '—');
    setStatus($('kGaps'), '', '—');
    $('kBatHint').textContent = '—';
    return;
  }
  $('kAge').textContent = fmtNum(age, 1);
  $('kTime').textContent = clock(s.duration);
  $('kRec').textContent = age !== null && age < 5 ? t('recording') : t('stale');
  const latencyValid = s.latencyS !== null && Number.isFinite(s.latencyS) && demoSpeed === 1;
  $('kLatency').textContent = latencyValid ? t('latency', { s: s.latencyS.toFixed(1) }) : '';
  if (s.missing === 0) setStatus($('kGaps'), age !== null && age > 5 ? 'warn' : 'good', age !== null && age > 5 ? t('stale') : t('noGaps'));
  else setStatus($('kGaps'), 'warn', t('missingMsgs', { n: s.missing }));

  const acc = s.now.acc;
  $('kAcc').textContent = fmtNum(acc, 1);
  if (!s.gps.t.length) setStatus($('kAccStatus'), 'bad', t('noFix'));
  else if (acc === null) setStatus($('kAccStatus'), '', '—');
  else if (acc <= 5) setStatus($('kAccStatus'), 'good', t('good'));
  else if (acc <= 15) setStatus($('kAccStatus'), 'warn', t('fair'));
  else setStatus($('kAccStatus'), 'bad', t('poor'));

  $('kBat').textContent = fmtNum(s.now.battery, 0);
  const hours = s.batteryHoursLeft();
  $('kBatHint').textContent = s.now.battery === null ? t('noBattery') : hours !== null ? t('hoursLeft', { h: hours.toFixed(1) }) : t('estimating');
}

function applyLang() {
  document.documentElement.lang = lang;
  document.title = t('title');
  document.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = t(n.dataset.i18n); });
  document.querySelectorAll('[data-i18n-title]').forEach((n) => { n.title = t(n.dataset.i18nTitle); });
  document.querySelectorAll('[data-i18n-aria]').forEach((n) => { n.setAttribute('aria-label', t(n.dataset.i18nAria)); });
  document.querySelectorAll('[data-lang]').forEach((b) => b.classList.toggle('on', b.dataset.lang === lang));
  $('mapSub').textContent = t(hasTrack ? 'mapSub' : cfg.satellite ? 'mapSat' : 'mapNoImage');
  $('mapRange').textContent = `0 → ${cfg.mapMaxSpeedKmh} km/h`;
  gg.relabel();
  map.relabel();
  Object.values(charts).forEach((c) => c.redraw());
  dirty = true;
  runLogDirty = true;
  renderStatus();
}

// ---- controls -------------------------------------------------------------------------
document.querySelectorAll('[data-lang]').forEach((b) => {
  b.onclick = () => { lang = b.dataset.lang; store_.set('felinos.lang', lang); applyLang(); };
});
$('themeBtn').onclick = () => {
  const root = document.documentElement;
  root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
  store_.set('felinos.theme', root.dataset.theme);
  Object.values(charts).forEach((c) => c.build());
  gg.build();
  map.redraw(store.session?.gps);
  dirty = true;
};
function showLeveling() {
  const btn = $('levelBtn');
  btn.textContent = t('leveling');
  btn.disabled = true;
  setTimeout(() => { btn.textContent = t('setLevel'); btn.disabled = false; }, 2500);
}
$('levelBtn').onclick = () => {
  if (!store.session) return;
  store.session.relevel(2);
  showLeveling();
};

// Mount dialog: change how the phone is mounted without editing files (works on a hosted copy).
const mountDialog = $('mountDialog');
const mountForm = $('mountForm');
$('mountBtn').onclick = () => {
  const match = matchPreset(axisMap);
  $('mountCustomRow').hidden = Boolean(match);
  $('mountCustomMap').textContent = match ? '' : JSON.stringify(axisMap);
  mountForm.elements.preset.value = match ? match.preset : 'custom';
  mountForm.elements.invert.checked = match ? match.invertForward : false;
  mountDialog.showModal();
};
mountDialog.addEventListener('close', () => {
  if (mountDialog.returnValue !== 'save') return;
  const preset = mountForm.elements.preset.value;
  const invert = mountForm.elements.invert.checked;
  const next = preset === 'custom' ? cfg.axisMap : presetAxisMap(preset, invert);
  axisMap = next;
  store_.set('felinos.axisMap', next);
  store.setAxisMap(next); // re-levels the current session over the next 2 s
  if (store.session) showLeveling();
  dirty = true;
});
const dialog = $('runDialog');
const form = $('runForm');
$('runMeta').onclick = () => {
  for (const [k, v] of Object.entries(run)) if (form.elements[k]) form.elements[k].value = v;
  dialog.showModal();
};
dialog.addEventListener('close', () => {
  if (dialog.returnValue !== 'save') return;
  run = Object.fromEntries(['run', 'test', 'suspension', 'cvt', 'driver', 'place'].map((k) => [k, form.elements[k].value.trim()]));
  store_.set('felinos.run', run);
  if (store.session) runLog.relabel(store.session.id, run); // fix the label of the current recording
  runLogDirty = true;
  renderStatus();
});
// Connection dialog: settings saved in this browser only (hosted dashboard has no config.js).
const connDialog = $('connDialog');
const connForm = $('connForm');
function openConnection() {
  for (const k of ['url', 'username', 'password', 'topic']) connForm.elements[k].value = connection[k] ?? '';
  $('connSource').textContent = connection.source === 'browser' ? t('connFromBrowser') : connection.source === 'config' ? t('connFromConfig') : '';
  $('connForget').hidden = connection.source !== 'browser';
  $('connError').hidden = true;
  connDialog.showModal();
}
$('pill').onclick = () => { if (!demoUrl) openConnection(); };
$('banner').onclick = () => { if (conn === 'noConfig' || conn === 'auth') openConnection(); };
$('connSave').onclick = (ev) => {
  if (!isBrokerUrl(connForm.elements.url.value)) {
    ev.preventDefault();
    $('connError').textContent = t('connInvalidUrl');
    $('connError').hidden = false;
  }
};
connDialog.addEventListener('close', () => {
  if (connDialog.returnValue === 'save') {
    const v = Object.fromEntries(['url', 'username', 'password', 'topic'].map((k) => [k, connForm.elements[k].value.trim()]));
    store_.set('felinos.conn', v);
    location.reload();
  } else if (connDialog.returnValue === 'forget') {
    try { localStorage.removeItem('felinos.conn'); } catch { /* private mode */ }
    location.reload();
  }
});

$('exportCsv').onclick = () => {
  download(`felinos-run-log_${localDate(Date.now())}.csv`, toCsv(runLog.entries), 'text/csv');
};
$('clearLog').onclick = () => {
  if (!runLog.entries.length || !window.confirm(t('clearLogConfirm'))) return;
  runLog.clear();
  runLogDirty = true;
};

// ---- data source ----------------------------------------------------------------------
if (demoUrl) {
  const res = await fetch(demoUrl);
  const records = parseNdjson(await res.text());
  play(records, (m) => store.handle(m), { speed: demoSpeed });
} else if (conn === 'connecting') {
  connectLive(connection, {
    onMessage: (m) => store.handle(m),
    onStatus: (state) => { conn = state; renderStatus(); },
  });
}

applyLang();
setInterval(() => {
  if (dirty) { renderData(); dirty = false; }
  renderStatus();
}, 250);
setInterval(() => {
  if (runLogDirty) { renderRunLog(); renderGoals(); runLogDirty = false; }
}, 1000);
setInterval(() => runLog.save(), 5000); // persist live stats
