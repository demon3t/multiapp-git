const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtemp, readFile, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { checkRelease, downloadInstaller, installerName, releaseChanges } = require('../dist/core/updates');

test('checks GitHub Releases and compares semantic versions', async () => {
  const request = async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/demon3t/multiapp-git/releases/latest');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.equal(options.redirect, 'error');
    return Response.json({ tag_name: 'v0.10.0' });
  };
  assert.deepEqual(await checkRelease('0.9.0', 'test-token', request), {
    current: '0.9.0', latest: '0.10.0', status: 'available'
  });
  assert.equal((await checkRelease('0.10.0', 'test-token', request)).status, 'current');
});

test('distinguishes a private repository from an empty release list', async () => {
  const respond = status => async url => new Response(null, { status: url.endsWith('/latest') ? 404 : status });
  assert.equal((await checkRelease('0.3.0', '', respond(200))).status, 'no-release');
  assert.match((await checkRelease('0.3.0', '', respond(404))).message, /GitHub-токен/);
  const failed = await checkRelease('0.3.0', '', async () => { throw new Error('offline'); });
  assert.equal(failed.status, 'error');
});

test('downloads a newer private Windows build and verifies the release digest', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mgit-updater-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('test installer');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const release = await checkRelease('0.3.2-build.9', 'test-token', async () => Response.json({
    tag_name: 'v0.3.2-build.10', prerelease: false, draft: false,
    assets: [{ id: 42, name: installerName, size: bytes.length, state: 'uploaded', digest: 'sha256:' + digest }]
  }));
  assert.equal(release.status, 'available');
  assert.deepEqual(release.asset, { id: 42, size: bytes.length, digest });
  const location = 'https://release-assets.githubusercontent.com/signed-example';
  const request = async (url, options) => {
    if (url === location) {
      assert.equal(options.headers, undefined);
      return new Response(bytes);
    }
    assert.match(url, /\/releases\/assets\/42$/);
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.equal(options.headers.Accept, 'application/octet-stream');
    assert.equal(options.redirect, 'manual');
    return Response.redirect(location);
  };
  await assert.rejects(downloadInstaller({ ...release.asset, digest: '0'.repeat(64) }, release.current, 'test-token', directory, request, () => {}),
    /SHA256/);
  assert.deepEqual(await readdir(directory), []);
  const file = await downloadInstaller(release.asset, release.current, 'test-token', directory, request, () => {});
  assert.deepEqual(await readFile(file), bytes);
});

test('loads the changelog from the release tag and groups changes since the installed version', async () => {
  const request = async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/demon3t/multiapp-git/contents/changelog/ru.md?ref=v0.3.4-build.8');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    return new Response([
      '## 0.3.5', '### New', '- future',
      '## 0.3.4', '### Fixed', '- issue',
      '## 0.3.3', '### New', '- feature', '### Improved', '- speed',
      '## 0.3.2', '### New', '- already installed'
    ].join('\n'));
  };
  assert.deepEqual(await releaseChanges('0.3.2-build.2', '0.3.4-build.8', 'test-token', request),
    { New: ['feature'], Improved: ['speed'], Fixed: ['issue'] });
});
