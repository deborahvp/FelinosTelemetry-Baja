// Replay of recorded data through the same pipeline as live data. Pure logic, no DOM.
//
// - Replay mode: Sensor Logger CSV exports (one folder per recording, e.g. a whole test day) or
//   NDJSON stream backups, opened in the browser (nothing is uploaded), played with play/pause,
//   speed and seek.
// - Demo mode (?demo=<url>): plays an NDJSON file in real time to rehearse without the car.

/** Parse NDJSON text into [{receivedAt (ms), message}] sorted by receive time. */
export function parseNdjson(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && rec.message && typeof rec.message === 'object') out.push({ receivedAt: Number(rec.received_at) / 1e6, message: rec.message });
    } catch {
      // skip corrupt lines
    }
  }
  return out.sort((a, b) => a.receivedAt - b.receivedAt);
}

/** Shift every sample time so the recording appears to happen now. */
export function shiftMessage(message, offsetNs) {
  const payload = Array.isArray(message.payload) ? message.payload.map((e) => ({ ...e, time: Number(e.time) + offsetNs })) : [];
  return { ...message, payload };
}

/**
 * Feed records to onMessage in real time (scaled by speed). Returns a stop function.
 * @param {{receivedAt: number, message: object}[]} records
 */
export function play(records, onMessage, { speed = 1, loop = true } = {}) {
  let timer = null;
  let stopped = false;
  let round = 0;
  const run = () => {
    if (!records.length) return;
    const wallStart = Date.now();
    const recStart = records[0].receivedAt;
    // One constant shift keeps sample times monotonic; latency is only meaningful at speed 1.
    const offsetNs = (wallStart - recStart) * 1e6;
    const suffix = round ? `-loop${round}` : '';
    let i = 0;
    const tick = () => {
      if (stopped) return;
      const simNow = recStart + (Date.now() - wallStart) * speed;
      while (i < records.length && records[i].receivedAt <= simNow) {
        const m = shiftMessage(records[i].message, offsetNs);
        if (suffix) m.sessionId = `${m.sessionId}${suffix}`;
        onMessage(m);
        i += 1;
      }
      if (i < records.length) timer = setTimeout(tick, 100);
      else if (loop) { round += 1; timer = setTimeout(run, 2000); }
    };
    tick();
  };
  run();
  return () => { stopped = true; clearTimeout(timer); };
}

// ---- Replay mode: recordings from CSV exports or NDJSON backups ---------------------------

/** Sensors the dashboard uses; others (uncalibrated, orientation…) are skipped to save memory. */
export const REPLAY_SENSORS = ['accelerometer', 'gravity', 'gyroscope', 'location', 'battery', 'barometer'];

/** Sensor Logger tag (Tags.csv) → test type. */
export function testFromTag(tag) {
  const t = String(tag ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (/acel|accel/.test(t)) return 'acceleration';
  if (/giro|turn|radio/.test(t)) return 'turning';
  if (/ascen|climb|subida|pendiente/.test(t)) return 'climb';
  if (/obsta/.test(t)) return 'obstacles';
  if (/susp/.test(t)) return 'suspension';
  if (/tracc|tracti|arrastre|towing/.test(t)) return 'traction';
  if (/endur|resist/.test(t)) return 'endurance';
  return 'free';
}

/** Minimal CSV parser for Sensor Logger files (numbers, no quoted commas). */
export function parseCsv(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { header: [], rows: [] };
  return { header: lines[0].split(',').map((h) => h.trim()), rows: lines.slice(1).map((l) => l.split(',')) };
}

const stem = (name) => String(name).split(/[\\/]/).pop().replace(/\.csv$/i, '').toLowerCase();

/**
 * Build a recording from the CSV files of one Sensor Logger export.
 * @param {{name: string, text: string}[]} files
 * @returns {{id, name, tag, test, deviceId, platform, startedAt, t0, t1, entries}}
 */
export function recordingFromCsvFiles(files, name) {
  const byStem = new Map(files.map((f) => [stem(f.name), f.text]));
  const meta = parseCsv(byStem.get('metadata') ?? '');
  const metaRow = Object.fromEntries(meta.header.map((h, i) => [h.toLowerCase(), meta.rows[0]?.[i]]));
  const epochMs = Number(metaRow['recording epoch time']);
  const tags = parseCsv(byStem.get('tags') ?? '');
  const tag = tags.rows.map((r) => r[0]).filter(Boolean).join(', ');
  const entries = [];
  for (const sensor of REPLAY_SENSORS) {
    const { header, rows } = parseCsv(byStem.get(sensor) ?? '');
    const ti = header.indexOf('time');
    const ei = header.indexOf('seconds_elapsed');
    if (ti < 0) continue;
    const fields = header.map((h, i) => [h, i]).filter(([h]) => h !== 'time' && h !== 'seconds_elapsed');
    for (const r of rows) {
      let time = Number(r[ti]);
      // A spreadsheet may have rounded time to 1.79342E+18: rebuild it from the recording epoch.
      if ((/[eE.]/.test(r[ti]) || !Number.isFinite(time)) && Number.isFinite(epochMs) && ei >= 0) time = epochMs * 1e6 + Number(r[ei]) * 1e9;
      if (!Number.isFinite(time)) continue;
      const values = {};
      for (const [h, i] of fields) {
        const v = Number(r[i]);
        if (r[i] !== '' && r[i] !== undefined && Number.isFinite(v)) values[h] = v;
      }
      entries.push({ name: sensor, time, values });
    }
  }
  entries.sort((a, b) => a.time - b.time);
  return finishRecording({
    name, tag, test: testFromTag(tag), deviceId: metaRow['device id'] ?? null,
    platform: metaRow.platform ?? null, startedAt: Number.isFinite(epochMs) ? epochMs : null, entries,
  });
}

/** Build a recording from an NDJSON stream backup (felinos ingest). */
export function recordingFromNdjson(text, name) {
  const records = parseNdjson(text);
  const entries = [];
  let deviceId = null;
  for (const { message } of records) {
    deviceId = deviceId ?? message.deviceId ?? null;
    for (const e of message.payload ?? []) {
      const sensor = String(e?.name ?? '').toLowerCase();
      if (REPLAY_SENSORS.includes(sensor) && e.values && Number.isFinite(Number(e.time))) entries.push({ name: sensor, time: Number(e.time), values: e.values });
    }
  }
  entries.sort((a, b) => a.time - b.time);
  return finishRecording({ name, tag: '', test: 'free', deviceId, platform: null, startedAt: null, entries });
}

function finishRecording(rec) {
  const t0 = rec.entries.length ? rec.entries[0].time / 1e9 : 0;
  const t1 = rec.entries.length ? rec.entries[rec.entries.length - 1].time / 1e9 : 0;
  return { ...rec, id: `replay:${rec.name}`, t0, t1, startedAt: rec.startedAt ?? t0 * 1000 };
}

/**
 * Group files picked from a folder (input webkitdirectory) into recordings: every folder that
 * holds an Accelerometer.csv is one Sensor Logger export; every .ndjson file is one backup.
 * @param {{path: string}[]} files  path = webkitRelativePath or name
 * @returns {{name: string, kind: 'csv'|'ndjson', files: object[]}[]} naturally sorted
 */
export function groupRecordings(files) {
  const folders = new Map();
  const out = [];
  for (const f of files) {
    const parts = String(f.path).split(/[\\/]/);
    const file = parts.pop();
    if (/\.ndjson$/i.test(file)) {
      out.push({ name: file.replace(/\.ndjson$/i, ''), kind: 'ndjson', files: [f] });
      continue;
    }
    if (!/\.csv$/i.test(file)) continue;
    const dir = parts.join('/');
    if (!folders.has(dir)) folders.set(dir, []);
    folders.get(dir).push(f);
  }
  for (const [dir, list] of folders) {
    if (!list.some((f) => /(^|[\\/])accelerometer\.csv$/i.test(f.path))) continue;
    out.push({ name: dir.split('/').pop() || dir || 'recording', kind: 'csv', files: list });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

/**
 * Plays a recording into the dashboard: feeds entries up to the playhead in ≤1 s batches (like
 * Sensor Logger messages). Seeking backwards resets and re-feeds from the start (fast: a few
 * hundred ms of processing for minutes of data).
 */
export class ReplayController {
  constructor(recording, { onReset, onFeed }) {
    this.rec = recording;
    this.onReset = onReset;
    this.onFeed = onFeed;
    this.speed = 1;
    this.playing = false;
    this.lastTick = null;
    this.restart();
  }

  restart() {
    this.pos = 0;
    this.t = this.rec.t0;
    this.messageId = 0;
    this.onReset();
  }

  get duration() { return this.rec.t1 - this.rec.t0; }

  get elapsed() { return this.t - this.rec.t0; }

  get ended() { return this.t >= this.rec.t1; }

  /** Move the playhead to absolute time tS (s), feeding or replaying as needed. */
  seek(tS) {
    const target = Math.max(this.rec.t0, Math.min(this.rec.t1, tS));
    if (target < this.t) this.restart();
    const entries = this.rec.entries;
    while (this.pos < entries.length && entries[this.pos].time / 1e9 <= target) {
      const batchEnd = Math.min(target, entries[this.pos].time / 1e9 + 1);
      const batch = [];
      while (this.pos < entries.length && entries[this.pos].time / 1e9 <= batchEnd) batch.push(entries[this.pos++]);
      this.messageId += 1;
      this.onFeed(batch, this.messageId);
    }
    this.t = target;
  }

  seekFraction(f) { this.seek(this.rec.t0 + f * this.duration); }

  play(nowMs) {
    if (this.ended) this.restart();
    this.playing = true;
    this.lastTick = nowMs;
  }

  pause() { this.playing = false; }

  toggle(nowMs) {
    if (this.playing) this.pause();
    else this.play(nowMs);
  }

  /** Advance with wall-clock time × speed; stops at the end. */
  tick(nowMs) {
    if (!this.playing) return;
    const dt = Math.max(0, (nowMs - this.lastTick) / 1000) * this.speed;
    this.lastTick = nowMs;
    this.seek(this.t + dt);
    if (this.ended) this.playing = false;
  }
}
