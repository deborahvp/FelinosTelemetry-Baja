// Run log: one entry per Sensor Logger recording (sessionId), labeled with the run details
// from the header. Pure logic, no DOM, so it runs under `node --test`.
//
// Each new recording gets the next run ID automatically (R01 → R02) and keeps the test type
// and configuration. Entries persist in the browser and can be exported as meta.yaml (one per
// run, schema in templates/meta.yaml) or as a CSV log.

export const TEST_REQUIREMENTS = {
  acceleration: ['VG-04'],
  turning: ['VG-05'],
  climb: ['VG-06'],
  obstacles: ['VG-07'],
  endurance: ['VG-02'],
  free: [],
};

const FIELDS = ['run', 'test', 'suspension', 'cvt', 'driver', 'place'];

/** R01 → R02, R9 → R10, keeping at least two digits. */
export function nextRunId(id) {
  const m = /^R(\d+)$/.exec(String(id ?? '').trim());
  const n = m ? Number(m[1]) + 1 : 1;
  return `R${String(n).padStart(2, '0')}`;
}

const runNumber = (id) => {
  const m = /^R(\d+)$/.exec(String(id ?? ''));
  return m ? Number(m[1]) : 0;
};

export const slug = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Folder name from the field guide: R01_acceleration_susp-A_cvt-1 */
export function folderName(entry) {
  return [entry.run, entry.test, entry.suspension, entry.cvt]
    .map((p) => String(p ?? '').trim().replace(/[^A-Za-z0-9.-]+/g, '-'))
    .filter(Boolean)
    .join('_');
}

/** Merge a live analysis snapshot into a stored one without ever losing data (page reloads). */
export function mergeAnalysis(stored, live) {
  if (!stored) return structuredClone(live);
  const byT = (xs) => new Map(xs.map((x) => [Math.round(x.t * 100), x]));
  const union = (a = [], b = []) => [...new Map([...byT(a), ...byT(b)]).values()].sort((x, y) => x.t - y.t);
  const counts = { ...stored.counts };
  for (const [k, v] of Object.entries(live.counts ?? {})) counts[k] = Math.max(counts[k] ?? 0, v);
  return {
    activeS: Math.max(stored.activeS ?? 0, live.activeS ?? 0),
    distanceM: Math.max(stored.distanceM ?? 0, live.distanceM ?? 0),
    counts,
    impactBins: (live.impactBins ?? []).map((v, i) => Math.max(v, stored.impactBins?.[i] ?? 0)),
    attempts: union(stored.attempts, live.attempts),
    turns: union(stored.turns, live.turns),
  };
}

export class RunLog {
  /** @param {{load: () => any, save: (entries: object[]) => void}} storage */
  constructor(storage) {
    this.storage = storage;
    const loaded = storage.load();
    this.entries = Array.isArray(loaded) ? loaded : [];
  }

  save() {
    this.storage.save(this.entries);
  }

  find(sessionId) {
    return this.entries.find((e) => e.sessionId === sessionId) ?? null;
  }

  /**
   * A recording started (or the page reloaded during one). Returns the entry and the header
   * to show: an existing entry for this session wins; otherwise the header's run ID is used
   * unless it was already taken, in which case the next free ID is assigned.
   */
  startSession(sessionId, header, info = {}) {
    const existing = this.find(sessionId);
    if (existing) return { entry: existing, header: pick(existing) };
    const next = { ...header };
    if (this.entries.some((e) => e.run === next.run)) {
      const max = Math.max(0, ...this.entries.map((e) => runNumber(e.run)));
      next.run = nextRunId(`R${max}`);
    }
    const entry = {
      ...pick(next),
      sessionId,
      deviceId: info.deviceId ?? null,
      startedAt: info.startedAt ?? Date.now(),
      duration: 0,
      maxSpeed: 0,
      maxAlong: 0,
      maxAlat: 0,
    };
    this.entries.push(entry);
    this.save();
    return { entry, header: pick(next) };
  }

  /** Relabel a run (the user edited the header while it was recording). */
  relabel(sessionId, header) {
    const e = this.find(sessionId);
    if (!e) return;
    Object.assign(e, pick(header));
    this.save();
  }

  /**
   * Merge live stats from the dashboard session. Never shrinks: after a page reload mid-recording
   * the dashboard only sees the rest of the run, so duration comes from the run's real start and
   * maxima keep the larger value.
   */
  updateStats(sessionId, { lastSampleAt, maxSpeed, maxAlong, maxAlat, deviceId, analysis }) {
    const e = this.find(sessionId);
    if (!e) return;
    if (Number.isFinite(lastSampleAt)) e.duration = Math.max(e.duration, (lastSampleAt - e.startedAt) / 1000);
    e.maxSpeed = Math.max(e.maxSpeed, maxSpeed ?? 0);
    e.maxAlong = Math.max(e.maxAlong, maxAlong ?? 0);
    e.maxAlat = Math.max(e.maxAlat, maxAlat ?? 0);
    if (deviceId) e.deviceId = deviceId;
    if (analysis) e.analysis = mergeAnalysis(e.analysis, analysis);
  }

  clear() {
    this.entries = [];
    this.save();
  }
}

function pick(obj) {
  return Object.fromEntries(FIELDS.map((k) => [k, obj[k] ?? '']));
}

// ---- exports ----------------------------------------------------------------------------

const yq = (s) => JSON.stringify(String(s ?? '')); // JSON strings are valid YAML scalars

/** meta.yaml for one run, matching templates/meta.yaml (validated by RunMeta in Python). */
export function toMetaYaml(entry, { vehicleId = 'felinos-2027', axisMap, deviceModel = 'iPhone 15' } = {}) {
  const date = localDate(entry.startedAt);
  const reqs = TEST_REQUIREMENTS[entry.test] ?? [];
  const ax = axisMap ?? { x: 'lateral', y: 'longitudinal', z: 'vertical' };
  return [
    '# Generated by the Felinos dashboard run log. Check and complete before archiving.',
    'schema_version: 1',
    `vehicle_id: ${yq(vehicleId)}`,
    `date: ${date}`,
    `session_id: ${yq([date, slug(entry.place)].filter(Boolean).join('_'))}`,
    `run_id: ${yq(entry.run)}`,
    `sensorlogger_session_id: ${yq(entry.sessionId)}`,
    `test_type: ${entry.test in TEST_REQUIREMENTS ? entry.test : 'free'}`,
    `requirement_ids: [${reqs.join(', ')}]`,
    `driver: ${yq(entry.driver)}`,
    'configuration:',
    `  suspension: ${yq(entry.suspension)}`,
    `  cvt: ${yq(entry.cvt)}`,
    '  tire_pressure_psi: {front: 0, rear: 0}',
    '  ballast_kg: 0',
    `track: ${yq(entry.place)}`,
    'weather: {temp_c: null, surface: dry}',
    'device:',
    `  model: ${yq(deviceModel)}`,
    '  mounting: ""',
    `  axis_map: {x: ${yq(ax.x)}, y: ${yq(ax.y)}, z: ${yq(ax.z)}}`,
    `notes: ${yq(runNotes(entry))}`,
    '',
  ].join('\n');
}

/** Best (lowest) value of a field across a run's launch attempts, or null. */
const bestAttempt = (entry, field) => {
  const xs = (entry.analysis?.attempts ?? []).map((a) => a[field]).filter((x) => Number.isFinite(x));
  return xs.length ? Math.min(...xs) : null;
};
const minTurn = (entry) => {
  const xs = (entry.analysis?.turns ?? []).map((x) => x.rCgM).filter((x) => Number.isFinite(x));
  return xs.length ? Math.min(...xs) : null;
};

/** Live summary written into meta.yaml notes (the offline analysis recomputes everything). */
function runNotes(entry) {
  const a = entry.analysis;
  const parts = [
    `duration ${Math.round(entry.duration)} s`,
    `max speed ${entry.maxSpeed.toFixed(1)} km/h`,
    `max |a_long| ${entry.maxAlong.toFixed(2)} g`,
    `max |a_lat| ${entry.maxAlat.toFixed(2)} g`,
  ];
  if (a) {
    parts.push(`active ${Math.round(a.activeS)} s`, `distance ${(a.distanceM / 1000).toFixed(2)} km`);
    parts.push(`impacts ${a.counts.impact}, jumps ${a.counts.jump}, hard brakes ${a.counts.hardBrake}, hard corners ${a.counts.hardCorner}`);
    const t100 = bestAttempt(entry, 't100');
    const t150 = bestAttempt(entry, 't150');
    const r = minTurn(entry);
    if (t100 !== null) parts.push(`best 100 ft ${t100.toFixed(2)} s`);
    if (t150 !== null) parts.push(`best 150 ft ${t150.toFixed(2)} s`);
    if (r !== null) parts.push(`tightest steady turn R_cg ${r.toFixed(2)} m`);
  }
  return `${parts.join('; ')} (live estimates)`;
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(entries) {
  const head = ['run', 'test', 'suspension', 'cvt', 'driver', 'place', 'start_local', 'duration_s', 'max_speed_kmh', 'max_along_g', 'max_alat_g', 'session_id', 'device_id', 'folder',
    'active_s', 'distance_km', 'impacts', 'jumps', 'hard_brakes', 'hard_corners', 'best_100ft_s', 'best_150ft_s', 'min_turn_radius_cg_m'];
  const fmt = (x, d) => (x === null || x === undefined ? '' : x.toFixed(d));
  const rows = entries.map((e) => {
    const d = new Date(e.startedAt);
    const start = `${localDate(e.startedAt)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    const a = e.analysis;
    return [e.run, e.test, e.suspension, e.cvt, e.driver, e.place, start, Math.round(e.duration), e.maxSpeed.toFixed(1), e.maxAlong.toFixed(2), e.maxAlat.toFixed(2), e.sessionId, e.deviceId ?? '', folderName(e),
      a ? Math.round(a.activeS) : '', a ? (a.distanceM / 1000).toFixed(3) : '',
      a?.counts.impact ?? '', a?.counts.jump ?? '', a?.counts.hardBrake ?? '', a?.counts.hardCorner ?? '',
      fmt(bestAttempt(e, 't100'), 2), fmt(bestAttempt(e, 't150'), 2), fmt(minTurn(e), 2)];
  });
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}
