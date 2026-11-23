const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkRelease } = require('../dist/core/updates');

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
