// Verify the distributable helper, not a source import. Synthetic records only; sources disabled.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..', 'resources', 'compose-runtime');
function request(payload) {
  const result = spawnSync(path.join(root, 'node.exe'), [path.join(root, 'worker.mjs')], {
    input: JSON.stringify({ command: 'registerDetectedGame', payload }), encoding: 'utf8',
    timeout: 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true
  });
  if (result.error) throw result.error;
  const response = JSON.parse(result.stdout);
  assert.equal(result.status, 0, response.error || result.stderr);
  assert.equal(response.ok, true);
  return response.result;
}
const payload = {
  records: { opponents: [], matches: [], candidates: [], fixtures: [] },
  settings: { externalSourcesEnabled: false }, userName: 'LocalPlayer', region: 'EU',
  session: { id: 'compose-synthetic-session', isActive: true, mode: 'ranked-1v1',
    detectedAt: '2026-10-25T00:00:30.000Z', startedAt: '2026-10-25T00:00:00.000Z',
    players: [{ name: 'LocalPlayer', race: 'Terran', isUser: true }, { name: 'Opponent', race: 'Zerg' }] }
};
const first = request(payload);
assert.equal(first.records.opponents.length, 1);
assert.equal(first.records.matches.length, 1);
const second = request({ ...payload, records: first.records });
assert.equal(second.records.matches.length, 1);
assert.equal(second.records.opponents[0].encounters, 1);
console.log('PASS bundled Node/domain helper: synthetic registration, identity and repeat without duplicate; no network or user files.');
