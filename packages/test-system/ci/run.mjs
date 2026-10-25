// Author-only historical qualification; production source remains at the named parent.
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { runPromptState } from './prompt-state.mjs';
assert.equal(process.platform, 'linux');
assert.notEqual(process.getuid(), 0);
assert.ok(Object.values(networkInterfaces()).flat().every(row => row.internal));
const bytes = readFileSync('/opt/openrig-testbed/library/prompt-state.json');
const report = { mode: 'healthy', caseName: 'prompt-state', records: [], fault: null,
  scenarioSha256: createHash('sha256').update(bytes).digest('hex'), promptState: {} };
try {
  await runPromptState(realpathSync('/usr/local/bin/rig'), JSON.parse(bytes), report.promptState);
  report.result = { scenario: 'prompt-state', verdict: 'PASS' }; report.records.push(report.result);
} catch (error) { report.error = error.stack || String(error); process.exitCode = 2; }
console.log('OPENRIG_SCENARIO_RESULT=' + JSON.stringify(report));
