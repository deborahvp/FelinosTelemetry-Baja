// Prints the meta.yaml the dashboard would download for each test type, separated by "---".
// Used by tests/test_dashboard_meta.py to validate it against RunMeta.
import { RunLog, TEST_REQUIREMENTS, toMetaYaml } from '../../dashboard/runlog.js';

let data = null;
const log = new RunLog({ load: () => data, save: (v) => { data = v; } });
const docs = Object.keys(TEST_REQUIREMENTS).map((test, i) => {
  const { entry } = log.startSession(`session-${i}`, {
    run: 'R01', test, suspension: 'susp-A', cvt: 'cvt-1', driver: 'Ana "Turbo" Pérez', place: 'La Salle Bajío',
  }, { startedAt: new Date(2026, 10, 8, 10, 0).getTime() });
  return toMetaYaml(entry, { axisMap: { x: '-longitudinal', y: 'vertical', z: 'lateral' } });
});
process.stdout.write(docs.join('---\n'));
