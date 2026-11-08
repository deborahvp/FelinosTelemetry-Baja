// Prints the dashboard's analysis thresholds as JSON (checked against config/analysis.yaml).
import { DEFAULTS } from '../../dashboard/analysis.js';

process.stdout.write(JSON.stringify(DEFAULTS));
