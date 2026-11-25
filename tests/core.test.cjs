const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile, readFile, mkdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { createServer } = require('node:http');
const { fixture, ids, path } = require('./fixture.cjs');
const { inspect, assertValid, compatibleSnapshot, normalizeExport, materialize, selectAssets } = require('../dist/core/snapshot');
const git = require('../dist/core/git');
const { Superset } = require('../dist/core/superset');

test('merges and rebases the active branch and rolls back conflicts', async t => {
  const repo = await mkdtemp(join(tmpdir(), 'mgit-integrate-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const run = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  run('init', '-b', 'main');
  run('config', 'user.name', 'mGit test');
  run('config', 'user.email', 'test@example.invalid');
  async function commit(path, contents) {
    await writeFile(join(repo, path), contents + '\n');
    run('add', '--', path);
    run('commit', '-m', contents);
    return run('rev-parse', 'HEAD');
  }
  await commit('shared.txt', 'base');
  run('switch', '-c', 'source');
  const source = await commit('source.txt', 'source');
  run('switch', 'main');
  const main = await commit('main.txt', 'main');
  const integrate = (action, ref = 'source', head = run('rev-parse', 'HEAD')) =>
    git.branchAction(repo, { action, ref: 'refs/heads/' + ref, current: 'main', head });
  await assert.rejects(integrate('merge', 'source', source), /изменились/);
  assert.equal((await integrate('merge')).branch, 'main');
  assert.equal(run('show', '-s', '--format=%P'), main + ' ' + source);
  run('branch', 'pre-rebase', main);
  run('switch', 'source');
  const upstream = await commit('shared.txt', 'source edit');
  run('switch', 'main');
  await commit('shared.txt', 'main edit');
  for (const action of ['merge', 'rebase']) {
    // Rebase the pre-merge line so that the edits to shared.txt conflict.
    if (action === 'rebase') {
      run('switch', 'pre-rebase');
      const head = await commit('shared.txt', 'pre-rebase edit');
      await assert.rejects(git.branchAction(repo, { action, ref: 'refs/heads/source', current: 'pre-rebase', head }), /восстановил/);
      assert.equal(run('rev-parse', 'HEAD'), head);
      assert.equal(run('status', '--porcelain'), '');
      assert.match(await readFile(join(repo, 'shared.txt'), 'utf8'), /^pre-rebase edit\r?\n$/);
    } else {
      const head = run('rev-parse', 'HEAD');
      await assert.rejects(integrate(action), /восстановил/);
      assert.equal(run('rev-parse', 'HEAD'), head);
      assert.equal(run('status', '--porcelain'), '');
    }
  }
  run('switch', '-c', 'clean-rebase', main);
  const result = await git.branchAction(repo, { action: 'rebase', ref: 'refs/heads/source', current: 'clean-rebase', head: main });
  assert.equal(result.branch, 'clean-rebase');
  assert.notEqual(result.head, main);
  assert.equal(run('rev-parse', 'HEAD^'), upstream);
  assert.equal(run('rev-parse', 'source'), upstream);
});

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
  normalized.set('metadata.yaml', normalized.get('metadata.yaml') + 'timestamp: 2026-11-24T17:07:33.291Z\n');
  assertValid(normalized);
  assert(!normalized.get(path.database).includes('source.local'));
  const { output, passwords } = materialize(normalized, { [ids.database]: 'postgresql://target:pass%401@target.local/db' });
  assert.equal(passwords[path.database], 'pass@1');
  assert.match(output.get(path.database), /target.local/);
  assert.match(output.get('metadata.yaml'), /^timestamp: "2026-11-24T17:07:33\.291Z"$/m);
  assert(!normalized.get(path.database).includes('target.local'));
});

test('accepts large snapshots and lists exclusions for explicit partial import', () => {
  const files = fixture();
  files.set(path.database, files.get(path.database).replace('sqlite:///mgit-unconfigured.db', 'REDACTED'));
  files.set(path.chart, files.get(path.chart).replace(/^dataset_uuid:.*\n/m, ''));
  const query = files.get(path.query);
  for (let index = 1; index <= 5_000; index++) {
    files.set('queries/query-' + index + '.yaml', query.replace(ids.query, 'c2000000-0000-4000-8000-' + String(index).padStart(12, '0')));
  }
  assert.throws(() => assertValid(files), { code: 'validation' });
  const result = compatibleSnapshot(files);
  assert.deepEqual(new Set(result.excluded.map(item => item.path)), new Set([path.chart, path.dashboard]));
  assert.equal(result.files.size, 5_004);
  assert.equal(files.size, 5_006);
  files.set('secret.txt', 'secret');
  assert.throws(() => compatibleSnapshot(files), { code: 'validation' });
});

test('preserves staged and unstaged paths outside snapshot', async t => {
  const repo = await mkdtemp(join(tmpdir(), 'mgit-git-test-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const run = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  run('init', '-b', 'main');
  await mkdir(join(repo, 'nested'));
  await assert.rejects(git.openRepoRoot(join(repo, 'nested')), /корень отдельного/);
  run('config', 'user.email', 'test@example.invalid');
  run('config', 'user.name', 'mGit test');
  await writeFile(join(repo, 'README.md'), 'initial');
  run('add', 'README.md');
  run('commit', '-m', 'initial');
  const folder = 'snapshots/test/assets';
  const files = fixture();
  assert.deepEqual(await git.snapshotFolders(repo, 'HEAD'), []);
  const preview = await git.previewWrite(repo, folder, files);
  await writeFile(join(repo, 'README.md'), 'changed');
  run('add', 'README.md');
  await writeFile(join(repo, 'notes.txt'), 'work in progress');
  await git.writeSnapshot(repo, folder, files, preview);
  const result = await git.commitSnapshot(repo, folder, 'Export', { ...preview, files });
  assert.match(result.status, /M  README\.md/);
  assert.match(result.status, /\?\? notes\.txt/);
  assert.equal(run('show', 'HEAD:README.md').toString(), 'initial');
  assert.deepEqual(await git.readCommit(repo, result.head, folder), files);
  assert.deepEqual(await git.snapshotFolders(repo, 'main'), [folder]);
  assert.deepEqual(await git.snapshotFolders(repo, 'HEAD~1'), []);
  assert.equal((await git.previewWrite(repo, folder, files)).changes.length, 0);
  await mkdir(join(repo, folder, 'datasets', 'ignored'), { recursive: true });
  await writeFile(join(repo, folder, 'datasets', 'ignored', 'unrelated.txt'), 'keep');
  await assert.rejects(git.previewWrite(repo, folder, files), { code: 'dirty' });
  assert.equal(await readFile(join(repo, folder, 'datasets', 'ignored', 'unrelated.txt'), 'utf8'), 'keep');
  assert.equal(await readFile(join(repo, 'README.md'), 'utf8'), 'changed');
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
