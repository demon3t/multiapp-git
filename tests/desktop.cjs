const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { once } = require('node:events');
const { setTimeout: wait } = require('node:timers/promises');
const { createServer } = require('node:http');
const { fixture, ids, path } = require('./fixture.cjs');
const { pack } = require('../dist/core/zip');

async function testSuperset(t) {
  const files = fixture();
  const resources = { database: 'database', dataset: 'dataset', chart: 'chart', dashboard: 'dashboard', saved_query: 'query' };
  const batches = new Map(await Promise.all(Object.values(resources).map(async kind => [kind,
    await pack(new Map([['metadata.yaml', files.get('metadata.yaml')], [path[kind], files.get(path[kind])]]))])));
  const empty = await pack(new Map([['metadata.yaml', files.get('metadata.yaml')]]));
  const full = await pack(files);
  const calls = { imports: 0 };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const json = body => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(body));
    };
    switch (url.pathname) {
      case '/api/v1/security/login': return json({ access_token: 'test-token' });
      case '/api/v1/security/csrf_token/': return json({ result: 'test-csrf' });
      case '/api/v1/me/roles/': return json({ result: { roles: ['Admin'] } });
      case '/api/v1/_openapi': return json({ info: { version: '6.1.0' }, paths: {
        '/api/v1/assets/export/': { get: {} }, '/api/v1/assets/import/': { post: {} }
      } });
      case '/api/v1/assets/export/': return response.end(calls.imports ? full : empty);
      case '/api/v1/assets/import/':
        for await (const chunk of request) { assert(chunk.length > 0); }
        calls.imports++;
        return json({ message: 'OK' });
    }
    const match = /^\/api\/v1\/([^/]+)\/(export\/)?$/.exec(url.pathname);
    const kind = resources[match?.[1]];
    if (!kind) { response.writeHead(404).end(); return; }
    if (match[2]) return response.end(batches.get(kind));
    return json({ count: 1, result: [{ id: 1, uuid: ids[kind] }] });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: 'http://127.0.0.1:' + server.address().port, calls };
}

test('packaged mGit switches Git branches and runs Superset operations in one click', { timeout: 60_000 }, async t => {
  const profile = await mkdtemp(join(tmpdir(), 'mgit-desktop-'));
  const repo = join(profile, 'repo');
  const superset = await testSuperset(t);
  await mkdir(repo);
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'pipe' });
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('config', 'user.name', 'mGit test');
  git('config', 'user.email', 'test@example.invalid');
  await writeFile(join(repo, 'README.md'), '# Superset configuration\n');
  git('add', 'README.md');
  git('commit', '-m', 'Initialize the configuration repository');
  git('switch', '-c', 'feature/ui/compact');
  await mkdir(join(repo, 'snapshots'));
  await writeFile(join(repo, 'snapshots', 'metadata.yaml'), 'type: assets\nversion: 1.0.0\n');
  git('add', 'snapshots');
  git('commit', '-m', 'Add the Superset snapshot');
  git('switch', 'main');
  await writeFile(join(repo, 'README.md'), '# Superset configuration\n\nLocal snapshots are versioned in Git.\n');
  git('commit', '-am', 'Document the local snapshot workflow');
  git('merge', '--no-ff', 'feature/ui/compact', '-m', 'Merge the Superset snapshot');
  git('tag', 'v1.0.0');
  git('remote', 'add', 'origin', repo);
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('update-ref', 'refs/remotes/origin/feature/ui/compact', 'feature/ui/compact');
  git('update-ref', 'refs/remotes/origin/test/remote', 'main');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
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
  function devtools(method, params) {
    return new Promise(resolve => {
      pending.set(++id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    return (await devtools('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.value;
  }
  function shortcut(code, shiftKey = false) {
    return evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", ${JSON.stringify({ code, ctrlKey: true, shiftKey, cancelable: true })}))`);
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
  await evaluate('document.querySelector(".app-menu button").click()');
  await evaluate('document.querySelector(".app-menu-panel button:last-child").click()');
  assert.match(await evaluate('document.querySelector(".updates-panel")?.textContent'), /Проверить сейчас/);
  assert.equal((await evaluate('window.mgit.call("updateStatus")')).data.status, 'idle');
  await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))');
  assert.equal(await evaluate('!!document.querySelector(".updates-panel")'), false);
  assert.equal(await evaluate('document.querySelector(".update-icon-button")?.getAttribute("aria-label")'), 'Проверить обновления');
  if (process.env.MGIT_TEST_UPDATE_SCREENSHOT) {
    await evaluate('document.querySelector(".update-icon-button").click()');
    const notes = 'document.querySelectorAll(".update-dialog[open] li").length';
    for (let attempt = 0; attempt < 160 && !(await evaluate(notes)); attempt++) await wait(100);
    assert(await evaluate(notes), 'The update icon should open the dialog with release notes');
    assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".update-dialog-actions button"), button => button.textContent)'), ['Отмена', 'Обновить']);
    const { data } = await devtools('Page.captureScreenshot', { format: 'png' });
    await writeFile(process.env.MGIT_TEST_UPDATE_SCREENSHOT, Buffer.from(data, 'base64'));
    await evaluate('document.querySelector(".update-dialog-actions button").click()');
    assert.equal(await evaluate('!!document.querySelector(".update-dialog[open]")'), false);
    assert.equal((await evaluate('window.mgit.call("updateStatus")')).data.status, 'available');
  }
  assert.deepEqual(await evaluate('window.mgit.call("profiles")'), { ok: true, data: [] });
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".operation"), x => x.textContent)'), [
    'PULL', 'FETCH', 'PUSH'
  ]);
  await evaluate('Array.from(document.querySelectorAll(".repo-menu-trigger")).find(button => button.textContent.includes("Файл")).click()');
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".repo-menu-panel button"), item => [item.firstChild.textContent, item.querySelector("kbd").textContent])'), [
    ['Инициализировать репозиторий', 'Ctrl+Shift+N'], ['Открыть репозиторий', 'Ctrl+O'], ['Клонировать репозиторий', 'Ctrl+Shift+O']
  ]);
  assert.equal(await shortcut('KeyO', true), false);
  assert.equal(await evaluate('document.querySelector("main .panel h2")?.textContent'), 'Клонировать репозиторий');
  assert.equal(await evaluate('!!document.querySelector(".repo-menu-panel")'), false);
  await evaluate('Array.from(document.querySelectorAll(".repo-menu-trigger")).find(button => button.textContent.includes("Приложение")).click()');
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".app-menu-panel button"), item => [item.firstChild.textContent, item.querySelector("kbd")?.textContent ?? ""])'),
    [['История операций', 'Ctrl+H'], ['Настройки', 'Ctrl+,'], ['Настройки обновлений', '']]);
  assert.equal(await evaluate('document.querySelector(".app-menu-panel [role=separator]")?.className'), 'menu-separator');
  await evaluate('document.querySelector(".app-menu-panel button:first-child").click()');
  assert.equal(await evaluate('document.querySelector("h1")?.textContent'), 'История операций');
  for (let attempt = 0; attempt < 30 && await evaluate('document.querySelector(".app-menu button").disabled'); attempt++) await wait(100);
  await evaluate('document.querySelector(".app-menu button").click()');
  assert.equal(await shortcut('Comma'), false);
  assert.equal(await evaluate('document.querySelector("h1")?.textContent'), 'Настройки');
  await evaluate('document.querySelector(".brand").click()');
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
  const input = { name: '', type: 'superset', repo, url: superset.url, auth: 'db',
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
  assert.equal(await evaluate('document.querySelector(".app-tabs button")?.textContent'), new URL(superset.url).host);
  for (let attempt = 0; attempt < 30 && !(await evaluate('!!document.querySelector(".branch-status")')); attempt++) await wait(100);
  assert.equal(await evaluate('document.querySelector(".branch-status")?.textContent'), 'main');
  const saved = await evaluate('window.mgit.call("profiles")');
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.data[0].repo, await realpath(repo));
  assert.equal(saved.data[0].name, new URL(superset.url).host);
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
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".branch-group > summary"), item => item.textContent)'),
    ['Локальные ветки', 'Удалённые ветки', 'Теги']);
  assert.equal(await evaluate('document.querySelectorAll(".branch-group")[1].open'), false);
  await evaluate('document.querySelectorAll(".branch-group > summary")[1].click()');
  assert.equal(await evaluate('document.querySelectorAll(".branch-group")[1].open'), true);
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".branch-group")[1].querySelectorAll(":scope ul details > summary"), item => item.textContent)'),
    ['origin', 'feature', 'ui', 'test']);
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".branch-group")[1].querySelectorAll("button"), item => item.textContent)'),
    ['compact', 'main', 'remote']);
  await evaluate('document.querySelectorAll(".branch-group")[1].querySelector("button").click()');
  const rowCount = 'document.querySelectorAll(".commit-row").length';
  for (let attempt = 0; attempt < 30 && await evaluate(rowCount) !== 2; attempt++) await wait(100);
  assert.equal(await evaluate(rowCount), 2);
  assert.equal(git('branch', '--show-current').toString().trim(), 'main');
  await evaluate('document.querySelector(".repo-views button:last-child").click()');
  for (let attempt = 0; attempt < 30 && await evaluate(rowCount) !== 4; attempt++) await wait(100);
  assert.equal(await evaluate(rowCount), 4);
  assert.match(await evaluate('document.querySelector(".commit-row").textContent'), /v1\.0\.0.*Merge the Superset snapshot/);
  for (let attempt = 0; attempt < 30 && !(await evaluate('!!document.querySelector(".commit-patch .patch-added")')); attempt++) await wait(100);
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".commit-files button"), button => button.title)'), ['snapshots/metadata.yaml']);
  assert.match(await evaluate('document.querySelector(".commit-patch pre")?.textContent'), /\+type: assets/);
  assert(await evaluate('(() => { const lines = document.querySelectorAll(".commit-patch pre span"); return lines[1].offsetTop > lines[0].offsetTop; })()'));
  await evaluate('document.querySelector(".commit-tabs button:first-child").click()');
  assert.match(await evaluate('document.querySelector(".commit-info")?.textContent'), /Родители/);
  const doubleClick = ref => evaluate(`Array.from(document.querySelectorAll(".branch-ref")).find(button => button.title.startsWith(${JSON.stringify(ref + ' ·')})).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
  const branchStatus = 'document.querySelector(".branch-status")?.textContent';
  await doubleClick('refs/heads/feature/ui/compact');
  for (let attempt = 0; attempt < 30 && await evaluate(branchStatus) !== 'feature/ui/compact'; attempt++) await wait(100);
  assert.equal(await evaluate(branchStatus), 'feature/ui/compact');
  assert.equal(git('branch', '--show-current').toString().trim(), 'feature/ui/compact');
  assert.doesNotMatch(await readFile(join(repo, 'README.md'), 'utf8'), /Local snapshots/);

  await doubleClick('refs/remotes/origin/test/remote');
  for (let attempt = 0; attempt < 30 && await evaluate(branchStatus) !== 'test/remote'; attempt++) await wait(100);
  assert.equal(await evaluate(branchStatus), 'test/remote');
  assert.equal(git('rev-parse', '--symbolic-full-name', '@{upstream}').toString().trim(), 'refs/remotes/origin/test/remote');
  assert.match(await readFile(join(repo, 'README.md'), 'utf8'), /Local snapshots/);

  await evaluate('document.querySelector(".operation[aria-label=Export]").click()');
  for (let attempt = 0; attempt < 50 && !(await evaluate('!!document.querySelector(".diff-files")')); attempt++) await wait(100);
  assert.equal(await evaluate('document.querySelector("h1").textContent'), 'Экспорт');
  assert.equal(await evaluate('!!document.querySelector(".diff-files")'), true, await evaluate('document.querySelector("main")?.innerText?.slice(0, 400)'));
  assert.doesNotMatch(await evaluate('document.querySelector("main").innerText'), /Каталог снимка|Репозиторий|Рабочая ветка|^Superset$/m);
  assert.match(await readFile(join(repo, 'snapshots', 'test', 'remote', 'assets', 'metadata.yaml'), 'utf8'), /type: assets/);
  assert.equal(git('branch', '--show-current').toString().trim(), 'test/remote');

  git('add', 'snapshots/test/remote/assets');
  git('commit', '-m', 'Export on the working branch');
  await evaluate('document.querySelector(".operation[aria-label=Import]").click()');
  const success = 'document.querySelector("main .notice.success")?.textContent';
  for (let attempt = 0; attempt < 50 && await evaluate(success) !== 'Снимок импортирован и проверен.'; attempt++) await wait(100);
  assert.equal(await evaluate(success), 'Снимок импортирован и проверен.');
  assert.equal(await evaluate('document.querySelector("h1").textContent'), 'Экспорт');
  assert.equal(await evaluate('!!document.querySelector(".diff-files")'), true);
  assert.equal(superset.calls.imports, 1);
  const backups = join(profile, 'backups');
  const [backup] = await readdir(backups);
  assert((await readFile(join(backups, backup))).length > 0);
  if (process.env.MGIT_TEST_SCREENSHOT) {
    const { data } = await devtools('Page.captureScreenshot', { format: 'png' });
    await writeFile(process.env.MGIT_TEST_SCREENSHOT, Buffer.from(data, 'base64'));
  }
});
