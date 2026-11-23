const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { once } = require('node:events');
const { setTimeout: wait } = require('node:timers/promises');

test('packaged mGit loads the renderer and reaches the preload bridge', { timeout: 30_000 }, async t => {
  const profile = await mkdtemp(join(tmpdir(), 'mgit-desktop-'));
  const app = spawn(resolve('release/win-unpacked/mGit.exe'), [
    '--user-data-dir=' + profile, '--remote-debugging-port=0'
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const closed = once(app, 'exit');
  t.after(async () => {
    app.kill();
    await Promise.race([closed, wait(2000)]).catch(() => undefined);
    await rm(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  });
  let endpoint;
  let log = '';
  app.stderr.setEncoding('utf8');
  app.stderr.on('data', chunk => {
    log += chunk;
    endpoint = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(log)?.[1];
  });
  let target;
  for (let attempt = 0; attempt < 60 && !target && app.exitCode === null; attempt++) {
    await wait(200);
    if (!endpoint) continue;
    try {
      const response = await fetch('http://127.0.0.1:' + endpoint + '/json/list');
      target = (await response.json()).find(page => page.type === 'page' && page.url.endsWith('/index.html'));
    } catch { /* Chromium may still be starting. */ }
  }
  assert(target, log || 'Packaged Electron renderer not found');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, 'open');
  t.after(() => socket.close());
  const pending = new Map();
  let id = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
  });
  function evaluate(expression) {
    return new Promise(resolve => {
      pending.set(++id, value => resolve(value?.result?.value));
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });
  }
  for (let attempt = 0; attempt < 30 && await evaluate('document.querySelector("h1")?.textContent') !== 'Стенды'; attempt++) await wait(100);
  assert.equal(await evaluate('document.querySelector("h1")?.textContent'), 'Стенды');
  assert.deepEqual(await evaluate('window.mgit.call("profiles")'), { ok: true, data: [] });
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("nav button"), x => x.textContent)'), [
    'Стенды', 'Репозитории', 'Экспорт', 'Импорт', 'История операций', 'Настройки'
  ]);
  const input = { name: 'Desktop test', url: 'http://127.0.0.1:18088', environment: 'TEST', auth: 'db',
    username: 'desktop', credential: 'assert-dpapi-credential', mappings: 'c1000000-0000-4000-8000-000000000001 postgresql://desktop:assert-dpapi-uri@local/test' };
  const saved = await evaluate('window.mgit.call("save", ' + JSON.stringify(input) + ')');
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.deepEqual(saved.data[0].mappingIds, ['c1000000-0000-4000-8000-000000000001']);
  const stored = await readFile(join(profile, 'mgit.json'), 'utf8');
  assert(!stored.includes('assert-dpapi-credential'));
  assert(!stored.includes('assert-dpapi-uri'));
});
