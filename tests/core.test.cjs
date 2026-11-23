const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile, readFile, mkdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { createServer } = require('node:http');
const { fixture, ids, path } = require('./fixture.cjs');
const { inspect, assertValid, normalizeExport, materialize, selectAssets } = require('../dist/core/snapshot');
const git = require('../dist/core/git');
const { Superset } = require('../dist/core/superset');

test('validates UUID, layout and required dataset', () => {
  const files = fixture();
  assert.equal(assertValid(files).length, 5);
  files.set(path.chart, files.get(path.chart).replace(/^dataset_uuid:.*\n/m, ''));
  const issue = inspect(files).issues.find(item => item.path === path.chart);
  assert.match(issue.message, /dataset_uuid/);
  assert.deepEqual(issue.dashboards, ['mGit dashboard']);
  assert.throws(() => selectAssets(files, [ids.dashboard]), { code: 'validation' });
  const clean = fixture();
  const selected = selectAssets(clean, [ids.dashboard]);
  assert.equal(selected.size, 5);
  assert.equal(selected.has(path.query), false);
  clean.delete(path.database);
  assert(inspect(clean).issues.some(issue => /database_uuid/.test(issue.message)));
});

test('blocks secret fields, unsafe attachments and incompatible versions', () => {
  const files = fixture();
  files.set(path.database, files.get(path.database) + 'password: real-value\n');
  assert.throws(() => assertValid(files), error => error.code === 'validation' && !JSON.stringify(error.details).includes('real-value'));
  const incompatible = fixture();
  incompatible.set('metadata.yaml', 'version: 2.0.0\ntype: assets\n');
  incompatible.set('databases/private.key', 'anything');
  assert.equal(inspect(incompatible).issues.length, 2);
  const raw = fixture();
  raw.set(path.database, raw.get(path.database).replace('sqlite:///mgit-unconfigured.db', 'postgresql://source:example@source.local/analytics'));
  const normalized = normalizeExport(raw);
  assertValid(normalized);
  assert(!normalized.get(path.database).includes('source.local'));
  const { output, passwords } = materialize(normalized, { [ids.database]: 'postgresql://target:pass%401@target.local/db' });
  assert.equal(passwords[path.database], 'pass@1');
  assert.match(output.get(path.database), /target.local/);
  assert(!normalized.get(path.database).includes('target.local'));
});

test('requires clean Git and preserves paths outside snapshot', async t => {
  const repo = await mkdtemp(join(tmpdir(), 'mgit-git-test-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const run = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  run('init', '-b', 'main');
  run('config', 'user.email', 'test@example.invalid');
  run('config', 'user.name', 'mGit test');
  await writeFile(join(repo, 'README.md'), 'initial');
  run('add', 'README.md');
  run('commit', '-m', 'initial');
  const folder = 'snapshots/test/assets';
  const files = fixture();
  const preview = await git.previewWrite(repo, folder, files);
  await writeFile(join(repo, 'README.md'), 'changed');
  await assert.rejects(git.writeSnapshot(repo, folder, files, preview), { code: 'dirty' });
  assert.equal(await readFile(join(repo, 'README.md'), 'utf8'), 'changed');
  await writeFile(join(repo, 'README.md'), 'initial');
  await git.writeSnapshot(repo, folder, files, preview);
  const result = await git.commitSnapshot(repo, folder, 'Export', { ...preview, files });
  assert.equal(result.status, '');
  assert.deepEqual(await git.readCommit(repo, result.head, folder), files);
  assert.equal((await git.previewWrite(repo, folder, files)).changes.length, 0);
  await mkdir(join(repo, folder, 'datasets', 'ignored'), { recursive: true });
  await writeFile(join(repo, folder, 'datasets', 'ignored', 'unrelated.txt'), 'keep');
  await assert.rejects(git.previewWrite(repo, folder, files), { code: 'dirty' });
  assert.equal(await readFile(join(repo, folder, 'datasets', 'ignored', 'unrelated.txt'), 'utf8'), 'keep');
  assert.equal(await readFile(join(repo, 'README.md'), 'utf8'), 'initial');
});

test('Superset handles expired token and network timeout', async t => {
  const server = createServer((req, res) => {
    if (req.headers.authorization === 'Bearer expired') { res.writeHead(401); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const profile = { url: 'http://127.0.0.1:' + server.address().port, auth: 'token' };
  const adapter = credential => new Superset(profile, { credential, connections: {} }, 200);
  await assert.rejects(adapter('expired').probe(), { code: 'auth' });
  await assert.rejects(adapter('timeout').probe(), { code: 'network' });
});
