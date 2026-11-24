const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { parse } = require('yaml');
const { fixture, ids, path } = require('./fixture.cjs');
const { Superset } = require('../dist/core/superset');
const { exportSnapshot } = require('../dist/core/workflow');
const { pack } = require('../dist/core/zip');
const git = require('../dist/core/git');
const { restore } = require('../dist/core/restore');

test('exports paginated UUIDs, retries smaller ZIP batches and preserves colliding YAML paths', async t => {
  const files = fixture();
  const other = 'c1000000-0000-4000-8000-000000000099';
  const resources = { database: 'database', dataset: 'dataset', chart: 'chart', dashboard: 'dashboard', saved_query: 'query' };
  const calls = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = body => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    assert.equal(req.headers.authorization, 'Bearer test-token');
    if (url.pathname === '/api/v1/me/roles/') { res.writeHead(401); res.end(); return; }
    if (url.pathname === '/api/v1/_openapi') return json({
      info: { version: '4.1.3' },
      paths: Object.fromEntries(Object.keys(resources).map(name => ['/api/v1/' + name + '/export/', { get: {} }]))
    });
    const match = /^\/api\/v1\/([^/]+)\/(export\/)?$/.exec(url.pathname);
    const kind = resources[match?.[1]];
    assert(kind);
    const q = url.searchParams.get('q');
    calls.push([kind, q]);
    if (!match[2]) {
      const secondPage = q.includes('page:1,');
      return json({ count: kind === 'chart' ? 2 : 1, result: [
        { id: secondPage ? 2 : 1, uuid: kind === 'query' ? undefined : secondPage ? other : ids[kind] }
      ] });
    }
    if (q === '!(1,2)') { res.writeHead(504); res.end(); return; }
    let source = files.get(path[kind]);
    if (q === '!(2)') source = source.replace(ids.chart, other);
    if (kind === 'database') source += 'encrypted_extra: secret-value\nserver_cert: sample\nssh_tunnel: {password: secret-value}\n';
    res.end(await pack(new Map([['metadata.yaml', 'version: 1.0.0\ntype: resource\n'], [path[kind], source]])));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const adapter = new Superset({ url: 'http://127.0.0.1:' + server.address().port, auth: 'token' },
    { credential: 'test-token', connections: {} });
  const probe = await adapter.probe();
  assert.equal(probe.admin, null);
  assert.equal(probe.export, true);
  const snapshot = await exportSnapshot(adapter);
  assert.deepEqual(snapshot.counts, { databases: 1, datasets: 1, charts: 2, dashboards: 1, queries: 1 });
  assert(calls.some(([kind, query]) => kind === 'chart' && query.includes('page:1,')));
  assert.deepEqual(calls.filter(([kind, query]) => kind === 'chart' && query.startsWith('!')).map(([, query]) => query),
    ['!(1,2)', '!(1)', '!(2)']);
  assert.equal(parse(snapshot.files.get('metadata.yaml')).type, 'assets');
  assert(parse(snapshot.files.get('metadata.yaml')).timestamp);
  assert.match(snapshot.files.get('metadata.yaml'), /^timestamp: "[^"]+"$/m);
  assert.equal(parse(snapshot.files.get(path.database)).sqlalchemy_uri, 'REDACTED');
  assert.deepEqual(parse(snapshot.files.get(path.database)).extra, {});
  assert.doesNotMatch(snapshot.files.get(path.database), /secret-value|server_cert|ssh_tunnel|encrypted_extra/);
  for (const uuid of [ids.chart, other]) assert.equal(parse(snapshot.files.get('charts/' + uuid + '.yaml')).uuid, uuid);
});

test('restore pins a Git commit, checks the adapter hash and orders phases', async t => {
  const repo = await mkdtemp(join(tmpdir(), 'mgit-restore-test-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const run = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  run('init', '-b', 'test');
  run('config', 'user.name', 'mGit test');
  run('config', 'user.email', 'mgit@example.invalid');
  const folder = 'snapshots/test/assets';
  const files = fixture();
  const preview = await git.previewWrite(repo, folder, files);
  await git.writeSnapshot(repo, folder, files, preview);
  const { head } = await git.commitSnapshot(repo, folder, 'Snapshot', { ...preview, files });
  const adapter = join(repo, 'adapter.cjs');
  const code = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const get = name => process.argv[process.argv.indexOf(name) + 1];
    assert.equal(get('--source-commit'), '${head}');
    assert.equal(get('--owner'), 'owner');
    assert(fs.existsSync(path.join(get('--assets'), 'metadata.yaml')));
    assert(JSON.parse(process.env.SUPERSET_DATABASE_BINDINGS)['${ids.database}']);
    if (process.argv.includes('--apply')) console.log('phase=verified');
    else if (!process.argv.includes('--verify-only')) console.log('VALIDATED; no metadata imported');
  `;
  await writeFile(adapter, code);
  const saved = process.env.SUPERSET_DATABASE_BINDINGS;
  process.env.SUPERSET_DATABASE_BINDINGS = JSON.stringify({ [ids.database]: { sqlalchemy_uri: 'sqlite:///test.db' } });
  t.after(() => {
    if (saved === undefined) delete process.env.SUPERSET_DATABASE_BINDINGS;
    else process.env.SUPERSET_DATABASE_BINDINGS = saved;
  });
  const log = join(repo, 'restore.jsonl');
  const options = { repo, ref: 'test', folder, adapter, python: process.execPath, target: randomUUID(), owner: 'owner', log, apply: true };
  await assert.rejects(restore({ ...options, adapterSha256: '0'.repeat(64) }), { code: 'adapter' });
  assert.deepEqual(await restore({ ...options, adapterSha256: createHash('sha256').update(code).digest('hex') }),
    { sha: head, phases: ['validate', 'apply', 'verify'], issues: [] });
  const events = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.filter(event => event.event === 'completed').map(event => event.phase), ['validate', 'apply', 'verify']);
});
