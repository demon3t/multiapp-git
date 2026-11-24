import { app, BrowserWindow, dialog, ipcMain, net, safeStorage, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Failure, Profile, profileUrl, Secret, uuidPattern } from './core/model';
import { Bridge, Context, Entry, ProfileInput, Requests } from './core/public';
import * as git from './core/git';
import { Superset } from './core/superset';
import { exportWorkingSnapshot, importWorkingSnapshot } from './core/workflow';
import { checkRelease, downloadInstaller, releaseChanges, releasesPage, UpdateStatus } from './core/updates';

type Stored = { profile: Profile; encrypted: string; type?: 'superset'; repo?: string };
type State = { profiles: Stored[]; history: Entry[]; updates?: { automatic: boolean; autoInstall?: boolean } };
let state: State;
let window: BrowserWindow;
let busy = false;
let preparedExport: (Context & Pick<Awaited<ReturnType<typeof exportWorkingSnapshot>>, 'head' | 'branch' | 'folder' | 'files'> & { id: string }) | undefined;
const path = () => join(app.getPath('userData'), 'mgit.json');
let releaseStatus: UpdateStatus = { current: app.getVersion(), status: 'idle' };
let updateCheck: Promise<ReturnType<typeof updateView>> | undefined;
let updateTimer: NodeJS.Timeout | undefined;
let installer: string | undefined;
let updateDownload: Promise<void> | undefined;
let launchingInstaller = false;
let quitForUpdate = false;
const updatesSupported = () => app.isPackaged && process.platform === 'win32' && process.arch === 'x64';
const updateView = () => {
  const { asset, tag, notes, ...status } = releaseStatus;
  return { ...status, canInstall: Boolean(asset && updatesSupported()), automatic: state.updates?.automatic,
    autoInstall: state.updates?.autoInstall,
    askPermission: updatesSupported() && state.updates?.automatic === undefined };
};

function reportUpdate() {
  if (window && !window.isDestroyed()) window.webContents.send('mgit:update', updateView());
  return updateView();
}
function scheduleUpdate(delay: number) {
  clearTimeout(updateTimer);
  if (state.updates?.automatic) updateTimer = setTimeout(() => void checkUpdate().then(autoDownload), delay);
}
function checkUpdate() {
  if (updateCheck) return updateCheck;
  if (updateDownload || launchingInstaller) return Promise.resolve(updateView());
  updateCheck = (async () => {
    const previousAsset = releaseStatus.asset;
    releaseStatus = { current: app.getVersion(), status: 'checking' };
    reportUpdate();
    releaseStatus = await checkRelease(app.getVersion(), (url, options) => net.fetch(url, options));
    if (installer) {
      const next = releaseStatus.asset;
      if (next && next.url === previousAsset?.url && next.digest === previousAsset.digest) {
        releaseStatus.status = 'ready';
      } else {
        await fs.rm(installer, { force: true }).catch(() => undefined);
        installer = undefined;
      }
    }
    return reportUpdate();
  })().finally(() => {
    updateCheck = undefined;
    scheduleUpdate(24 * 60 * 60 * 1000);
  });
  return updateCheck;
}

function fetchUpdate() {
  if (updateDownload) return updateDownload;
  const asset = releaseStatus.asset;
  if (installer) return Promise.resolve();
  if (!asset || !updatesSupported()) throw new Failure('Проверенный установщик для этой сборки недоступен.');
  releaseStatus = { ...releaseStatus, status: 'downloading', progress: 0, message: undefined };
  reportUpdate();
  updateDownload = Promise.resolve().then(async () => {
    installer = await downloadInstaller(asset, app.getPath('temp'), fetch, progress => {
      releaseStatus.progress = progress;
      reportUpdate();
    });
    releaseStatus.status = 'ready';
  }).catch(() => {
    const message = 'Не удалось загрузить или проверить установщик. Повторите попытку.';
    releaseStatus = { ...releaseStatus, status: 'available', message };
    throw new Failure(message);
  }).finally(() => { updateDownload = undefined; reportUpdate(); });
  return updateDownload;
}

function autoDownload() {
  if (state.updates?.automatic && state.updates.autoInstall && releaseStatus.status === 'available' && updateView().canInstall) {
    void fetchUpdate().catch(() => undefined);
  }
}

async function persist(next: State) {
  const temporary = path() + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, path());
    state = next;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}
function unlock(value: Stored): Secret {
  if (!safeStorage.isEncryptionAvailable()) throw new Failure('Системное защищённое хранилище недоступно.', 'storage');
  try { return JSON.parse(safeStorage.decryptString(Buffer.from(value.encrypted, 'base64'))); }
  catch { throw new Failure('Защищённые настройки нельзя прочитать. Сохраните профиль заново.', 'storage'); }
}
function listProfiles() {
  return state.profiles.map(({ profile, ...item }) => ({
    id: profile.id, name: profile.name, url: profile.url, auth: profile.auth, username: profile.username, ca: profile.ca,
    type: item.type ?? 'superset', repo: item.repo ?? '', mappingIds: Object.keys(unlock({ profile, ...item }).connections)
  }));
}
function profileFor(id: string, timeout?: number) {
  const item = state.profiles.find(item => item.profile.id === id);
  if (!item) throw new Failure('Выберите профиль Superset.');
  const secret = unlock(item);
  return { profile: item.profile, secret, adapter: new Superset(item.profile, secret, timeout) };
}
function applicationRepo(input: Context) {
  const repo = state.profiles.find(item => item.profile.id === input.profileId)?.repo;
  if (!repo || input.repo !== repo) throw new Failure('Откройте Git-репозиторий, указанный в настройках приложения.');
  return repo;
}
async function save(input: ProfileInput) {
  const old = state.profiles.find(item => item.profile.id === input.id);
  if (input.type !== 'superset' || !input.repo?.trim() || !['db', 'token'].includes(input.auth)) {
    throw new Failure('Укажите тип приложения, папку Git и способ входа.');
  }
  if (input.auth === 'db' && !input.username?.trim()) throw new Failure('Укажите пользователя Superset.');
  if (input.ca && (!input.ca.includes('-----BEGIN CERTIFICATE-----') || /PRIVATE KEY/.test(input.ca))) throw new Failure('Корпоративный CA должен быть сертификатом PEM.');
  const url = profileUrl(input.url);
  const repo = await git.openRepoRoot(input.repo.trim());
  const profile: Profile = { id: old?.profile.id ?? randomUUID(), name: input.name?.trim() || new URL(url).host, url,
    auth: input.auth, username: input.auth === 'db' ? input.username?.trim() : undefined, ca: input.ca || undefined };
  let secret: Secret = { credential: '', connections: {} };
  const sameTarget = old?.profile.url === profile.url;
  if (old && sameTarget) {
    try { secret = unlock(old); } catch { /* A new credential can replace unreadable settings. */ }
    if (old.profile.auth !== input.auth || old.profile.username !== profile.username) secret.credential = '';
  }
  if (input.credential) secret.credential = input.credential;
  if (!secret.credential || /[\r\n\0]/.test(secret.credential)) throw new Failure('Укажите пароль или токен для выбранного стенда.');
  if (input.clearMappings) secret.connections = {};
  if (input.mappings?.trim()) {
    for (const line of input.mappings.trim().split(/\r?\n/)) {
      if (!line.trim()) continue;
      const space = line.indexOf(' ');
      const id = line.slice(0, space).trim().toLowerCase();
      const connection = line.slice(space + 1).trim();
      if (space < 0 || !uuidPattern.test(id) || !/^[a-z][a-z0-9+_-]*:\/\/\S+$/i.test(connection)) {
        throw new Failure('Каждая строка подключения должна содержать UUID, пробел и SQLAlchemy URI.');
      }
      secret.connections[id] = connection;
    }
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Failure('Системное защищённое хранилище недоступно.', 'storage');
  const encrypted = safeStorage.encryptString(JSON.stringify(secret)).toString('base64');
  await persist({ ...state, profiles: [...state.profiles.filter(item => item.profile.id !== profile.id), { profile, encrypted, repo, type: input.type }] });
  preparedExport = undefined;
  return listProfiles();
}
const requests: { [K in keyof Requests]: (input: Requests[K][0]) => Requests[K][1] | Promise<Requests[K][1]> } = {
  profiles: listProfiles, save, probe: id => profileFor(id).adapter.probe(),
  async pickDirectory() { return (await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] })).filePaths[0] ?? ''; },
  async open(path) { const repo = await git.openRepoRoot(path); return { repo, state: await git.gitStatus(repo) }; },
  async init(path) { const repo = await git.initRepo(path); return { repo, state: await git.gitStatus(repo) }; },
  async clone(input) { const repo = await git.cloneRepo(input.url, input.path); return { repo, state: await git.gitStatus(repo) }; },
  status: git.gitStatus, diff: git.gitDiff, branch: input => git.changeBranch(input.repo, input.branch, input.create, input.remote),
  gitLog: input => git.gitLog(input.repo, input.ref, input.offset),
  commitFiles: input => git.commitFiles(input.repo, input.sha),
  commitPatch: input => git.commitPatch(input.repo, input.sha, input.paths),
  fetch: git.fetchRemote, pull: git.pullBranch, push: git.pushBranch,
  async exportSnapshot(input) {
    preparedExport = undefined;
    const repo = applicationRepo(input);
    const { head, files, ...result } = await exportWorkingSnapshot(profileFor(input.profileId).adapter, repo);
    const id = randomUUID();
    if (result.changes.length) preparedExport = { ...input, head, files, branch: result.branch, folder: result.folder, id };
    return { ...result, id };
  },
  async commit(input) {
    const prepared = preparedExport;
    if (!prepared || prepared.id !== input.id) throw new Failure('Сначала экспортируйте снимок.');
    const result = await git.commitSnapshot(prepared.repo, prepared.folder, input.message, prepared);
    preparedExport = undefined;
    return result;
  },
  async importSnapshot(input) {
    const repo = applicationRepo(input);
    const { profile, secret, adapter } = profileFor(input.profileId, 10 * 60_000);
    return importWorkingSnapshot(adapter, profile, repo, secret.connections, async sha => {
      const directory = join(app.getPath('userData'), 'backups');
      await fs.mkdir(directory, { recursive: true });
      return join(directory, 'superset-' + sha.slice(0, 10) + '-' + randomUUID() + '.zip');
    });
  },
  history: () => state.history,
  updateStatus: updateView,
  checkUpdate,
  async updateChanges() {
    try {
      return await releaseChanges(releaseStatus, (url, options) => net.fetch(url, options));
    } catch {
      throw new Failure('Не удалось загрузить список изменений.');
    }
  },
  async installUpdate() {
    if (busy || launchingInstaller) throw new Failure('Дождитесь завершения текущей операции.');
    await fetchUpdate();
    if (busy) throw new Failure('Дождитесь завершения текущей операции.');
    quitForUpdate = true;
    setImmediate(() => app.quit());
    return updateView();
  },
  async saveUpdateSettings(input) {
    if (typeof input.automatic !== 'boolean' || (input.autoInstall !== undefined && typeof input.autoInstall !== 'boolean')) {
      throw new Failure('Проверьте настройки автоматического обновления.');
    }
    await persist({ ...state, updates: { automatic: input.automatic, autoInstall: input.autoInstall ?? state.updates?.autoInstall } });
    scheduleUpdate(15_000);
    autoDownload();
    return reportUpdate();
  },
  openReleases: () => shell.openExternal(releasesPage)
};
const quiet = new Set(['profiles', 'history', 'pickDirectory', 'status', 'diff', 'gitLog', 'commitFiles', 'commitPatch', 'updateStatus', 'checkUpdate', 'updateChanges', 'installUpdate', 'openReleases']);
const logMessages: Partial<Record<keyof Requests, string>> = {
  save: 'Профиль сохранён', probe: 'Проверка стенда выполнена', open: 'Репозиторий открыт', clone: 'Репозиторий клонирован',
  branch: 'Ветка выбрана', fetch: 'Fetch выполнен', pull: 'Pull выполнен', push: 'Push выполнен',
  exportSnapshot: 'Снимок Superset записан', importSnapshot: 'Импорт Superset применён и проверен', commit: 'Коммит создан',
  saveUpdateSettings: 'Настройки обновлений сохранены'
};
async function log(action: keyof Requests, status: Entry['status'], message: string) {
  if (quiet.has(action)) return;
  const history = [{ action: logMessages[action] ?? action, status, message, time: new Date().toISOString() }, ...state.history].slice(0, 250);
  try { await persist({ ...state, history }); } catch { state = { ...state, history }; }
}
const handle: Bridge['call'] = async (method, input) => {
  if (!Object.hasOwn(requests, method)) return { ok: false, message: 'Неизвестное действие.', code: 'ipc' };
  if (busy && !quiet.has(method)) return { ok: false, message: 'Дождитесь завершения текущей операции.', code: 'busy' };
  const tracked = !quiet.has(method);
  if (tracked) busy = true;
  try {
    const data = await requests[method](input);
    await log(method, 'ok', '');
    return { ok: true, data };
  } catch (error) {
    const failure = error instanceof Failure ? error : new Failure('Операция не завершилась. Проверьте доступ и свободное место.');
    await log(method, 'error', failure.code);
    return { ok: false, message: failure.message, code: failure.code, details: failure.details };
  } finally { if (tracked) busy = false; }
};

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  void app.whenReady().then(async () => {
    try { state = JSON.parse(await fs.readFile(path(), 'utf8')); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') { dialog.showErrorBox('mGit', 'Файл профилей недоступен: ' + path()); app.quit(); return; }
      state = { profiles: [], history: [] };
    }
    window = new BrowserWindow({ width: 1270, height: 850, minWidth: 860, minHeight: 590,
      icon: join(__dirname, 'ui', 'icon.png'),
      backgroundColor: '#f5f6fa', titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#e5e8ee', symbolColor: '#223148', height: 30 },
      webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    window.removeMenu();
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    ipcMain.handle('mgit', (event, method, input) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return { ok: false, message: 'Недоступный запрос.', code: 'ipc' };
      return handle(method, input);
    });
    await window.loadFile(join(__dirname, 'ui', 'index.html'));
    scheduleUpdate(15_000);
  });
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (!installer || busy || launchingInstaller || !(quitForUpdate || (state.updates?.automatic && state.updates.autoInstall))) return;
  event.preventDefault();
  launchingInstaller = true;
  releaseStatus.status = 'installing';
  reportUpdate();
  const process = spawn(installer, ['--updated', '/S', ...(quitForUpdate ? ['--force-run'] : [])],
    { detached: true, stdio: 'ignore' });
  process.once('spawn', () => {
    process.unref();
    app.quit();
  });
  process.once('error', () => {
    launchingInstaller = false;
    quitForUpdate = false;
    releaseStatus = { ...releaseStatus, status: 'ready', message: 'Не удалось запустить установщик.' };
    reportUpdate();
    if (!window || window.isDestroyed()) app.exit();
  });
});
