// Prints the dashboard's analysis thresholds and requirements as JSON, checked against
// config/analysis.yaml and config/requirements.yaml by tests/test_analysis_config.py.
import { DEFAULTS } from '../../dashboard/analysis.js';
import { REQUIREMENTS } from '../../dashboard/goals.js';

process.stdout.write(JSON.stringify({ analysis: DEFAULTS, requirements: REQUIREMENTS }));
