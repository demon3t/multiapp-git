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
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, 'error');
    return Response.json({ tag_name: 'v0.10.0' });
  };
  assert.deepEqual(await checkRelease('0.9.0', request), {
    current: '0.9.0', latest: '0.10.0', tag: 'v0.10.0', status: 'available'
  });
  assert.equal((await checkRelease('0.10.0', request)).status, 'current');
});

test('distinguishes a private repository from an empty release list', async () => {
  const respond = status => async url => new Response(null, { status: url.endsWith('/latest') ? 404 : status });
  assert.equal((await checkRelease('0.3.0', respond(200))).status, 'no-release');
  assert.match((await checkRelease('0.3.0', respond(404))).message, /недоступны/);
  const failed = await checkRelease('0.3.0', async () => { throw new Error('offline'); });
  assert.equal(failed.status, 'error');
});

test('downloads a newer public Windows build and verifies the release digest', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mgit-updater-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('test installer');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const assetUrl = 'https://github.com/demon3t/multiapp-git/releases/download/v0.3.2-build.10/' + installerName;
  const release = await checkRelease('0.3.2-build.9', async () => Response.json({
    tag_name: 'v0.3.2-build.10', prerelease: false, draft: false,
    assets: [{ browser_download_url: assetUrl, name: installerName, size: bytes.length, state: 'uploaded', digest: 'sha256:' + digest }]
  }));
  assert.equal(release.status, 'available');
  assert.deepEqual(release.asset, { url: assetUrl, size: bytes.length, digest });
  const location = 'https://release-assets.githubusercontent.com/signed-example';
  const request = async (url, options) => {
    if (url === location) {
      assert.equal(options.headers, undefined);
      return new Response(bytes);
    }
    assert.equal(url, assetUrl);
    assert.equal(options.headers, undefined);
    assert.equal(options.redirect, 'manual');
    return Response.redirect(location);
  };
  await assert.rejects(downloadInstaller({ ...release.asset, digest: '0'.repeat(64) }, directory, request, () => {}),
    /SHA256/);
  assert.deepEqual(await readdir(directory), []);
  const file = await downloadInstaller(release.asset, directory, request, () => {});
  assert.deepEqual(await readFile(file), bytes);
});

test('loads the changelog from the release tag and groups changes since the installed version', async () => {
  const request = async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/demon3t/multiapp-git/contents/changelog/ru.md?ref=v0.3.4-build.8');
    assert.equal(options.headers.Authorization, undefined);
    return new Response([
      '## 0.3.5', '### New', '- future',
      '## 0.3.4', '### Fixed', '- issue',
      '## 0.3.3', '### New', '- feature', '### Improved', '- speed',
      '## 0.3.2', '### New', '- already installed'
    ].join('\n'));
  };
  assert.deepEqual(await releaseChanges({ current: '0.3.2-build.2', latest: '0.3.4-build.8', tag: 'v0.3.4-build.8' }, request),
    { New: ['feature'], Improved: ['speed'], Fixed: ['issue'] });
});

test('uses the release notes when only the build number changed', async () => {
  const release = {
    current: '0.3.4-build.6', latest: '0.3.4-build.7', tag: 'v0.3.4-build.7',
    notes: "## What's Changed\n* Проверка обновлений by @example in https://github.com/demon3t/multiapp-git/pull/7"
  };
  const request = async () => new Response('## 0.3.4\n### New\n- Already installed');
  assert.deepEqual(await releaseChanges(release, request), { New: [], Improved: ['Проверка обновлений'], Fixed: [] });
});
