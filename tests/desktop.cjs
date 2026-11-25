const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { mkdir, mkdtemp, readFile, realpath, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { once } = require('node:events');
const { setTimeout: wait } = require('node:timers/promises');

test('packaged mGit opens Superset and plain Git repositories', { timeout: 60_000 }, async t => {
  const profile = await mkdtemp(join(tmpdir(), 'mgit-desktop-'));
  const repo = join(profile, 'repo');
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
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('update-ref', 'refs/remotes/origin/feature/ui/compact', 'feature/ui/compact');
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
  assert.equal(initialized.data.profiles[0].type, 'git');
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
  const selectedTab = 'document.querySelector(".app-tabs button[aria-pressed=true]")?.textContent';
  for (let attempt = 0; attempt < 30 && await evaluate(selectedTab) !== '127.0.0.1:18088'; attempt++) await wait(100);
  assert.equal(await evaluate(selectedTab), '127.0.0.1:18088');
  for (let attempt = 0; attempt < 30 && !(await evaluate('!!document.querySelector(".branch-status")')); attempt++) await wait(100);
  assert.equal(await evaluate('document.querySelector(".branch-status")?.textContent'), 'main');
  const saved = await evaluate('window.mgit.call("profiles")');
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const supersetProfile = saved.data.find(item => item.type === 'superset');
  assert.equal(supersetProfile.repo, await realpath(repo));
  assert.equal(supersetProfile.name, '127.0.0.1:18088');
  assert.equal(Object.hasOwn(supersetProfile, 'environment'), false);
  const updated = await evaluate('window.mgit.call("save", ' + JSON.stringify({ ...input, id: supersetProfile.id }) + ')');
  assert.equal(updated.ok, true, JSON.stringify(updated));
  assert.deepEqual(updated.data.find(item => item.type === 'superset').mappingIds, ['c1000000-0000-4000-8000-000000000001']);
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
    ['origin', 'feature', 'ui']);
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".branch-group")[1].querySelectorAll("button"), item => item.textContent)'),
    ['compact', 'main']);
  await evaluate('document.querySelectorAll(".branch-group")[1].querySelector("button").click()');
  const rowCount = 'document.querySelectorAll(".commit-row").length';
  for (let attempt = 0; attempt < 30 && await evaluate(rowCount) !== 2; attempt++) await wait(100);
  assert.equal(await evaluate(rowCount), 2);
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
  await evaluate('document.querySelector(".operation[aria-label=Import]").click()');
  assert.equal(await evaluate('document.querySelector("input[list=refs]").value'), 'refs/remotes/origin/feature/ui/compact');

  const localRepo = initialized.data.repo;
  const localGit = (...args) => execFileSync('git', args, { cwd: localRepo, encoding: 'utf8' });
  localGit('config', 'user.name', 'mGit test');
  localGit('config', 'user.email', 'test@example.invalid');
  await writeFile(join(localRepo, 'README.md'), '# Old notes\nCommon line\n');
  localGit('add', 'README.md');
  localGit('commit', '-m', 'Initialize project notes');
  await writeFile(join(localRepo, 'README.md'), '# Project notes\nExtra line\nCommon line\n');
  await mkdir(join(localRepo, 'docs', 'drafts'), { recursive: true });
  await writeFile(join(localRepo, 'docs', 'drafts', 'notes [draft].txt'), 'Keep this local\n');
  await evaluate('document.querySelector(".brand").click()');
  await devtools('Page.reload', {});
  const localTab = 'Array.from(document.querySelectorAll(".app-tabs button")).find(button => button.textContent === "initialized")';
  for (let attempt = 0; attempt < 50 && !(await evaluate('!!(' + localTab + ')')); attempt++) await wait(100);
  await evaluate(localTab + '.click()');
  const file = '.working-file-name[title="README.md"]';
  const fileButton = 'document.querySelector(' + JSON.stringify(file) + ')';
  for (let attempt = 0; attempt < 50 && !(await evaluate('!!' + fileButton + ' && !' + fileButton + '.matches(":disabled")')); attempt++) await wait(100);
  assert.equal(await evaluate('!!' + fileButton), true, await evaluate('document.querySelector("main")?.innerText'));
  assert.equal(await evaluate('document.querySelector("main").classList.contains("file-workspace") && !document.querySelector("main h1, main h2, .file-workspace-body > p")'), true);
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".working-file-tree summary"), node => node.textContent)'), ['docs', 'drafts']);
  assert.equal(await evaluate('document.querySelectorAll(".working-file-tree .working-file-name").length'), 2);
  assert.doesNotMatch(await evaluate('document.querySelector(".working-files").innerText'), /Изменённые файлы|В индексе/);
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".operation"), x => x.textContent)'), ['PULL', 'FETCH', 'PUSH']);
  await evaluate('document.querySelector(' + JSON.stringify(file) + ').click()');
  const patch = 'document.querySelector(".working-file-patch pre")?.textContent';
  for (let attempt = 0; attempt < 30 && !(await evaluate(patch)); attempt++) await wait(100);
  assert.match(await evaluate(patch) ?? '', /\+# Project notes/, await evaluate('document.querySelector("main")?.innerText'));
  assert.match(await evaluate(patch), /-# Old notes/);
  const capture = async name => {
    if (!name) return;
    const { data } = await devtools('Page.captureScreenshot', { format: 'png' });
    await writeFile(name, Buffer.from(data, 'base64'));
  };
  await capture(process.env.MGIT_TEST_GIT_SCREENSHOT);
  await evaluate('document.querySelector(\'.working-toolbar button[aria-label="До и после"]\').click()');
  const row = 'document.querySelectorAll(".working-split .working-diff-columns")';
  assert.deepEqual(await evaluate('Array.from(' + row + '[1].querySelectorAll("code"), cell => cell.textContent)'), ['# Old notes', '# Project notes']);
  assert.deepEqual(await evaluate('Array.from(' + row + '[2].querySelectorAll("code"), cell => cell.textContent)'), ['', 'Extra line']);
  assert.deepEqual(await evaluate('Array.from(' + row + '[3].querySelectorAll(".working-line-number"), cell => cell.textContent)'), ['2', '3']);
  await capture(process.env.MGIT_TEST_GIT_SPLIT_SCREENSHOT);
  const selectFile = fileButton + '.click()';
  const stage = 'document.querySelector(".working-diff-header button[data-stage]")';
  const waitForStage = async type => {
    for (let attempt = 0; attempt < 30 && !(await evaluate(stage + '?.dataset.stage === ' + JSON.stringify(type) + ' && !' + stage + '?.matches(":disabled")')); attempt++) await wait(100);
    assert.equal(await evaluate(stage + '?.dataset.stage'), type);
  };
  await waitForStage('add');
  await evaluate(stage + '.click()');
  const index = 'document.querySelectorAll(".working-file-tree .working-index-mark").length';
  for (let attempt = 0; attempt < 30 && await evaluate(index) !== 1; attempt++) await wait(100);
  assert.equal(localGit('diff', '--cached', '--name-only').trim(), 'README.md');
  await evaluate(selectFile);
  await waitForStage('remove');
  await evaluate(stage + '.click()');
  for (let attempt = 0; attempt < 30 && await evaluate(index) !== 0; attempt++) await wait(100);
  assert.match(localGit('status', '--short'), / M README\.md/);
  await evaluate(selectFile);
  await waitForStage('add');
  await evaluate(stage + '.click()');
  for (let attempt = 0; attempt < 30 && await evaluate(index) !== 1; attempt++) await wait(100);
  await evaluate(`(() => {
    const field = document.querySelector('.working-files input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, 'Add project notes');
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.form.requestSubmit();
  })()`);
  for (let attempt = 0; attempt < 30 && await evaluate(index) !== 0; attempt++) await wait(100);
  assert.equal(localGit('log', '-1', '--format=%s').trim(), 'Add project notes');
  assert.equal(localGit('ls-files').trim(), 'README.md');
  assert.equal(await readFile(join(localRepo, 'docs', 'drafts', 'notes [draft].txt'), 'utf8'), 'Keep this local\n');
  const plain = JSON.parse(await readFile(join(profile, 'mgit.json'), 'utf8')).profiles.find(item => item.type === 'git');
  assert.deepEqual(Object.keys(plain.profile).sort(), ['id', 'name']);
  assert.equal(plain.repo, localRepo);
  assert.equal(Object.hasOwn(plain, 'encrypted'), false);
});
