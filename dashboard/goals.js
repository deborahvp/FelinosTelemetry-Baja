// Vehicle goals panel: summarizes the run log against the requirements (config/requirements.yaml,
// kept in sync by a test). Pure logic, no DOM. Live estimates; the DVP&R table from the offline
// analysis is the official record.

import { localDate } from './runlog.js';

export const FT_PER_M = 3.280839895;

export const REQUIREMENTS = [
  { id: 'VG-04', test: 'acceleration', metric: 'time_100ft_s', op: '<=', value: 4.3, minRuns: 3, unit: 's' },
  { id: 'VG-05', test: 'turning', metric: 'turning_radius_inner_ft', op: '<=', value: 6.0, minRuns: 3, unit: 'ft' },
  { id: 'VG-06', test: 'climb', metric: 'climb_time_150ft_s', op: '<', value: 20.0, minRuns: 3, unit: 's' },
];

const OPS = { '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b };
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const sd = (xs) => (xs.length < 2 ? 0 : Math.sqrt(xs.reduce((s, x) => s + (x - mean(xs)) ** 2, 0) / (xs.length - 1)));
const finite = (x) => typeof x === 'number' && Number.isFinite(x);

/** One value per run for a requirement (best attempt of that run), or null. */
export function runValue(req, entry, { trackWidthM = null } = {}) {
  const a = entry.analysis;
  if (!a || entry.test !== req.test) return null;
  if (req.id === 'VG-04') {
    const xs = (a.attempts ?? []).map((x) => x.t100).filter(finite);
    return xs.length ? Math.min(...xs) : null;
  }
  if (req.id === 'VG-06') {
    const xs = (a.attempts ?? []).map((x) => x.t150).filter(finite);
    return xs.length ? Math.min(...xs) : null;
  }
  if (req.id === 'VG-05') {
    const xs = (a.turns ?? []).map((x) => x.rCgM).filter(finite);
    if (!xs.length) return null;
    const rCg = Math.min(...xs);
    return finite(trackWidthM) ? (rCg - trackWidthM / 2) * FT_PER_M : rCg * FT_PER_M;
  }
  return null;
}

/**
 * Summary of one requirement over the given runs:
 * status 'noData' | 'partial' (fewer runs than required) | 'pass' | 'fail' | 'info' (cannot judge).
 */
export function summarizeRequirement(req, entries, opts = {}) {
  const values = entries.map((e) => runValue(req, e, opts)).filter(finite);
  if (!values.length) return { id: req.id, status: 'noData', n: 0, minRuns: req.minRuns };
  const m = mean(values);
  // Judge the value as displayed (3 decimals), not float noise: (4.4 + 4.2) / 2 must meet ≤ 4.3.
  const meets = OPS[req.op](Math.round(m * 1000) / 1000, req.value);
  let status = values.length < req.minRuns ? 'partial' : meets ? 'pass' : 'fail';
  const cgOnly = req.id === 'VG-05' && !finite(opts.trackWidthM);
  if (cgOnly) status = 'info'; // inner-tire radius needs the track width
  return { id: req.id, status, meets, cgOnly, n: values.length, minRuns: req.minRuns, mean: m, sd: sd(values), unit: req.unit };
}

const sumCounts = (entries) => entries.reduce((acc, e) => {
  for (const [k, v] of Object.entries(e.analysis?.counts ?? {})) acc[k] = (acc[k] ?? 0) + v;
  return acc;
}, { impact: 0, jump: 0, hardBrake: 0, hardCorner: 0 });

const sumUsage = (entries) => ({
  activeS: entries.reduce((s, e) => s + (e.analysis?.activeS ?? 0), 0),
  distanceM: entries.reduce((s, e) => s + (e.analysis?.distanceM ?? 0), 0),
});

/** Everything the goals card shows. `today` is a local date string (YYYY-MM-DD). */
export function summarizeGoals(entries, { today, trackWidthM = null, targetHours = 80 } = {}) {
  const todays = entries.filter((e) => localDate(e.startedAt) === today);
  const total = sumUsage(entries);
  return {
    requirements: REQUIREMENTS.map((r) => summarizeRequirement(r, todays, { trackWidthM })),
    events: sumCounts(todays),
    today: sumUsage(todays),
    total,
    durability: { activeHours: total.activeS / 3600, targetHours, fraction: Math.min(1, total.activeS / 3600 / targetHours) },
  };
}
