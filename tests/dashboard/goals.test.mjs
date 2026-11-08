import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FT_PER_M, REQUIREMENTS, runValue, summarizeGoals, summarizeRequirement } from '../../dashboard/goals.js';
import { mergeAnalysis } from '../../dashboard/runlog.js';

const close = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);
const TODAY = '2026-11-08';
const at = (h) => new Date(2026, 10, 8, h).getTime();
const run = (test, analysis, startedAt = at(10)) => ({ test, startedAt, analysis: { activeS: 0, distanceM: 0, counts: {}, impactBins: [], attempts: [], turns: [], ...analysis } });
const VG = (id) => REQUIREMENTS.find((r) => r.id === id);

test('VG-04: best launch per run, mean over runs, partial until 3 runs', () => {
  const runs = [
    run('acceleration', { attempts: [{ t: 1, t100: 4.6 }, { t: 9, t100: 4.4 }] }),
    run('acceleration', { attempts: [{ t: 2, t100: 4.2 }] }),
    run('free', { attempts: [{ t: 3, t100: 3.0 }] }), // not an acceleration run: ignored
  ];
  const s = summarizeRequirement(VG('VG-04'), runs);
  assert.equal(s.n, 2);
  close(s.mean, 4.3, 1e-9);
  assert.equal(s.status, 'partial');
  assert.equal(s.meets, true);
  const three = summarizeRequirement(VG('VG-04'), [...runs, run('acceleration', { attempts: [{ t: 4, t100: 5.0 }] })]);
  assert.equal(three.status, 'fail'); // mean 4.533 > 4.3
});

test('VG-06 uses the 150 ft time of climb runs; strict < 20 s', () => {
  const runs = [1, 2, 3].map((i) => run('climb', { attempts: [{ t: i, t100: 9, t150: 18 + i }] }));
  const s = summarizeRequirement(VG('VG-06'), runs);
  close(s.mean, 20, 1e-9);
  assert.equal(s.status, 'fail'); // 20 is not < 20
});

test('VG-05: inner-tire radius needs the track width; without it the CG radius is informative', () => {
  const runs = [run('turning', { turns: [{ t: 1, rCgM: 2.9 }, { t: 5, rCgM: 2.7 }] })];
  close(runValue(VG('VG-05'), runs[0], { trackWidthM: 1.4 }), (2.7 - 0.7) * FT_PER_M, 1e-9);
  const cg = summarizeRequirement(VG('VG-05'), runs);
  assert.equal(cg.status, 'info');
  assert.equal(cg.cgOnly, true);
  close(cg.mean, 2.7 * FT_PER_M, 1e-9);
  assert.equal(summarizeRequirement(VG('VG-05'), runs, { trackWidthM: 1.4 }).status, 'partial');
});

test('no data when there are no matching runs', () => {
  assert.equal(summarizeRequirement(VG('VG-04'), [run('turning', {})]).status, 'noData');
});

test('summary: only today counts for results and events; total usage counts everything', () => {
  const yesterday = new Date(2026, 10, 7, 12).getTime();
  const entries = [
    run('free', { activeS: 1800, distanceM: 9000, counts: { impact: 3, jump: 1, hardBrake: 2, hardCorner: 0 } }, yesterday),
    run('free', { activeS: 900, distanceM: 4000, counts: { impact: 5, jump: 0, hardBrake: 1, hardCorner: 4 } }),
    run('acceleration', { activeS: 60, distanceM: 300, attempts: [{ t: 1, t100: 4.1 }] }),
  ];
  const g = summarizeGoals(entries, { today: TODAY });
  assert.deepEqual(g.events, { impact: 5, jump: 0, hardBrake: 1, hardCorner: 4 });
  assert.equal(g.today.activeS, 960);
  assert.equal(g.total.activeS, 2760);
  close(g.durability.activeHours, 2760 / 3600, 1e-9);
  close(g.durability.fraction, 2760 / 3600 / 80, 1e-9);
  assert.equal(g.requirements.find((r) => r.id === 'VG-04').n, 1);
});

test('mergeAnalysis never loses data after a page reload', () => {
  const stored = { activeS: 300, distanceM: 2000, counts: { impact: 7, jump: 2, hardBrake: 1, hardCorner: 0 }, impactBins: [5, 2, 0], attempts: [{ t: 100.001, t100: 4.4 }], turns: [] };
  const live = { activeS: 40, distanceM: 150, counts: { impact: 1, jump: 0, hardBrake: 3, hardCorner: 1 }, impactBins: [1, 0, 0], attempts: [{ t: 100.001, t100: 4.4 }, { t: 400, t100: 4.2 }], turns: [{ t: 50, rCgM: 3 }] };
  const m = mergeAnalysis(stored, live);
  assert.equal(m.activeS, 300);
  assert.deepEqual(m.counts, { impact: 7, jump: 2, hardBrake: 3, hardCorner: 1 });
  assert.deepEqual(m.impactBins, [5, 2, 0]);
  assert.deepEqual(m.attempts.map((a) => a.t), [100.001, 400]); // de-duplicated, sorted
  assert.equal(m.turns.length, 1);
  assert.deepEqual(mergeAnalysis(null, live), live);
});
