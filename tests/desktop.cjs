const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { mkdir, mkdtemp, readFile, realpath, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { once } = require('node:events');
const { setTimeout: wait } = require('node:timers/promises');

test('packaged mGit adds a Superset application with its Git repository', { timeout: 60_000 }, async t => {
  const profile = await mkdtemp(join(tmpdir(), 'mgit-desktop-'));
  const repo = join(profile, 'repo');
  await mkdir(repo);
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'pipe' });
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
  for (let attempt = 0; attempt < 30 && await evaluate('document.querySelector("h1")?.textContent') !== 'Приложения'; attempt++) await wait(100);
  assert.equal(await evaluate('document.querySelector("h1")?.textContent'), 'Приложения');
  const titleBar = await evaluate(`(() => {
    const overlay = navigator.windowControlsOverlay;
    const bar = document.querySelector('.tabbar').getBoundingClientRect();
    const controls = overlay?.getTitlebarAreaRect();
    return { visible: overlay?.visible, y: controls?.y, height: controls?.height, barHeight: bar.height, reserved: bar.width - (controls?.width ?? bar.width) };
  })()`);
  assert.equal(titleBar.visible, true);
  assert.equal(titleBar.y, 0);
  assert.equal(titleBar.height, titleBar.barHeight);
  assert(titleBar.reserved > 0);
  for (let attempt = 0; attempt < 30 && !(await evaluate('!!document.querySelector("#update-permission")')); attempt++) await wait(100);
  assert.match(await evaluate('document.querySelector("#update-permission")?.textContent'), /автоматически/);
  await evaluate('Array.from(document.querySelectorAll(".updates-panel button")).find(button => button.textContent === "Нет, спасибо").click()');
  for (let attempt = 0; attempt < 30 && await evaluate('!!document.querySelector("#update-permission")'); attempt++) await wait(100);
  assert.equal((await evaluate('window.mgit.call("updateStatus")')).data.automatic, false);
  assert.equal(await evaluate('!!document.querySelector("#update-permission")'), false);
  await evaluate('document.querySelector(".updates-toggle").click()');
  assert.match(await evaluate('document.querySelector(".updates-panel")?.textContent'), /Проверить сейчас/);
  assert.equal((await evaluate('window.mgit.call("updateStatus")')).data.status, 'idle');
  await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))');
  assert.equal(await evaluate('!!document.querySelector(".updates-panel")'), false);
  assert.deepEqual(await evaluate('window.mgit.call("profiles")'), { ok: true, data: [] });
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".operation"), x => x.textContent)'), [
    'PULL', 'FETCH', 'PUSH'
  ]);
  await evaluate('document.querySelector(".repo-menu-trigger").click()');
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".repo-menu-panel button"), x => x.textContent)'), [
    'Инициализировать репозиторий', 'Открыть репозиторий', 'Клонировать репозиторий'
  ]);
  await evaluate('document.querySelector(".repo-menu-panel button:last-child").click()');
  assert.equal(await evaluate('document.querySelector("main .panel h2")?.textContent'), 'Клонировать репозиторий');
  const initialized = await evaluate('window.mgit.call("init", ' + JSON.stringify(join(profile, 'initialized')) + ')');
  assert.equal(initialized.ok, true, JSON.stringify(initialized));
  assert.equal(initialized.data.state.branch, 'main');
  assert.equal(initialized.data.state.head, '');
  assert.deepEqual(await evaluate('window.mgit.call("open", ' + JSON.stringify(initialized.data.repo) + ')'), initialized);
  assert.equal(await evaluate('document.querySelectorAll("nav button").length'), 0);
  await evaluate('document.querySelector(".new-tab").click()');
  for (let attempt = 0; attempt < 30 && !(await evaluate('!!document.querySelector("form")')); attempt++) await wait(100);
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("form label"), x => x.firstChild.textContent)'), ['Тип приложения', 'Папка Git']);
  await evaluate(`(() => {
    const field = document.querySelector('form select');
    field.value = 'superset';
    field.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("form label"), x => x.firstChild.textContent)'),
    ['Тип приложения', 'Папка Git', 'URL Superset', 'Авторизация', 'Пользователь', 'Пароль']);
  const input = { name: '', type: 'superset', repo, url: 'http://127.0.0.1:18088', auth: 'db',
    username: 'desktop', credential: 'assert-dpapi-credential', mappings: 'c1000000-0000-4000-8000-000000000001 postgresql://desktop:assert-dpapi-uri@local/test' };
  for (const invalid of [{ ...input, repo: '' }, { ...input, type: '' }, { ...input, repo: profile }]) {
    assert.equal((await evaluate('window.mgit.call("save", ' + JSON.stringify(invalid) + ')')).ok, false);
  }
  await evaluate(`(() => {
    const values = ${JSON.stringify([repo, input.url, input.username, input.credential])};
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    document.querySelectorAll('form input').forEach((field, index) => {
      setValue.call(field, values[index]);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
  })()`);
  await evaluate('document.querySelector("form").requestSubmit()');
  for (let attempt = 0; attempt < 30 && !(await evaluate('!!document.querySelector(".app-tabs button")')); attempt++) await wait(100);
  assert.equal(await evaluate('document.querySelector(".app-tabs button")?.textContent'), '127.0.0.1:18088');
  for (let attempt = 0; attempt < 30 && !(await evaluate('!!document.querySelector(".branch-status")')); attempt++) await wait(100);
  assert.equal(await evaluate('document.querySelector(".branch-status")?.textContent'), 'main');
  const saved = await evaluate('window.mgit.call("profiles")');
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.data[0].repo, await realpath(repo));
  assert.equal(saved.data[0].name, '127.0.0.1:18088');
  assert.equal(saved.data[0].type, 'superset');
  assert.equal(Object.hasOwn(saved.data[0], 'environment'), false);
  const updated = await evaluate('window.mgit.call("save", ' + JSON.stringify({ ...input, id: saved.data[0].id }) + ')');
  assert.equal(updated.ok, true, JSON.stringify(updated));
  assert.deepEqual(updated.data[0].mappingIds, ['c1000000-0000-4000-8000-000000000001']);
  const stored = await readFile(join(profile, 'mgit.json'), 'utf8');
  assert(!stored.includes('assert-dpapi-credential'));
  assert(!stored.includes('assert-dpapi-uri'));

  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".operation"), x => x.textContent)'),
    ['PULL', 'FETCH', 'PUSH', 'EXPORT', 'IMPORT']);
});
