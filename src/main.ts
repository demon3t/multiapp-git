import { app, BrowserWindow, clipboard, dialog, ipcMain, net, safeStorage, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import { Failure, Profile, profileUrl, Secret, uuidPattern } from './core/model';
import { Bridge, Context, Entry, ProfileInput, Requests, TabAppearance, tabIcons } from './core/public';
import * as git from './core/git';
import { Superset } from './core/superset';
import { prepareSnapshot, summarize } from './core/snapshot';
import { applyImport, confirmation, exportSnapshot, planImport, sourceSnapshot, verifyImport } from './core/workflow';
import { checkRelease, downloadInstaller, releaseChanges, releasesPage, UpdateStatus } from './core/updates';

type StoredSuperset = { profile: Profile & TabAppearance; encrypted: string; type?: 'superset'; repo?: string };
type StoredGit = { profile: { id: string } & TabAppearance; type: 'git'; repo: string };
type Stored = StoredGit | StoredSuperset;
type State = { profiles: Stored[]; history: Entry[]; updates?: { automatic: boolean; autoInstall?: boolean } };
let state: State;
let window: BrowserWindow;
let busy = false;
let preparedExport: (Context & Awaited<ReturnType<typeof exportSnapshot>> & { id: string; head: string; branch: string; written: boolean }) | undefined;
let preparedImport: (Context & Awaited<ReturnType<typeof sourceSnapshot>> & { id: string; expected: Awaited<ReturnType<typeof planImport>> }) | undefined;
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
function unlock(value: StoredSuperset): Secret {
  if (!safeStorage.isEncryptionAvailable()) throw new Failure('Системное защищённое хранилище недоступно.', 'storage');
  try { return JSON.parse(safeStorage.decryptString(Buffer.from(value.encrypted, 'base64'))); }
  catch { throw new Failure('Защищённые настройки нельзя прочитать. Сохраните профиль заново.', 'storage'); }
}
function listProfiles() {
  return state.profiles.map(item => {
    const { id, name, icon, color } = item.profile;
    if (item.type === 'git') return { id, name, icon, color, url: '', auth: 'db' as const, type: item.type, repo: item.repo, mappingIds: [] };
    const { url, auth, username, ca } = item.profile;
    let mappingIds: string[] = [];
    try { mappingIds = Object.keys(unlock(item).connections); } catch { /* Opening Git does not require Superset credentials. */ }
    return { id, name, icon, color, url, auth, username, ca, type: item.type ?? 'superset', repo: item.repo ?? '', mappingIds };
  });
}
function profileFor(id: string) {
  const item = state.profiles.find(item => item.profile.id === id);
  if (!item || item.type === 'git') throw new Failure('Выберите профиль Superset.');
  const secret = unlock(item);
  return { profile: item.profile, secret, adapter: new Superset(item.profile, secret) };
}
function applicationRepo(input: Context) {
  const repo = state.profiles.find(item => item.profile.id === input.profileId)?.repo;
  if (!repo || input.repo !== repo) throw new Failure('Откройте Git-репозиторий, указанный в настройках приложения.');
  return repo;
}
async function save(input: ProfileInput) {
  const existing = state.profiles.find(item => item.profile.id === input.id);
  if (input.type === 'git') {
    if (!input.repo?.trim()) throw new Failure('Укажите папку Git.');
    const repo = await git.openRepoRoot(input.repo.trim());
    const entry = existing ?? state.profiles.find(item => item.type === 'git' && item.repo === repo);
    const profile = { id: entry?.profile.id ?? randomUUID(), name: input.name?.trim() || basename(repo),
      icon: entry?.profile.icon, color: entry?.profile.color };
    await persist({ ...state, profiles: [...state.profiles.filter(item => item !== entry), { profile, type: 'git', repo }] });
    preparedImport = undefined;
    preparedExport = undefined;
    return listProfiles();
  }
  const old = existing?.type === 'git' ? undefined : existing;
  if (input.type !== 'superset' || !input.repo?.trim() || !['db', 'token'].includes(input.auth)) {
    throw new Failure('Укажите тип приложения, папку Git и способ входа.');
  }
  if (input.auth === 'db' && !input.username?.trim()) throw new Failure('Укажите пользователя Superset.');
  if (input.ca && (!input.ca.includes('-----BEGIN CERTIFICATE-----') || /PRIVATE KEY/.test(input.ca))) throw new Failure('Корпоративный CA должен быть сертификатом PEM.');
  const url = profileUrl(input.url);
  const repo = await git.openRepoRoot(input.repo.trim());
  const profile: StoredSuperset['profile'] = { id: existing?.profile.id ?? randomUUID(), name: input.name?.trim() || new URL(url).host, url,
    icon: existing?.profile.icon, color: existing?.profile.color,
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
  preparedImport = undefined;
  preparedExport = undefined;
  return listProfiles();
}
async function openWorkspace(repo: string) {
  const status = await git.gitStatus(repo);
  if (!state.profiles.some(item => item.repo === repo)) {
    const item: StoredGit = { type: 'git', repo, profile: { id: randomUUID(), name: basename(repo) } };
    await persist({ ...state, profiles: [...state.profiles, item] });
  }
  return { repo, state: status, profiles: listProfiles() };
}
const requests: { [K in keyof Requests]: (input: Requests[K][0]) => Requests[K][1] | Promise<Requests[K][1]> } = {
  profiles: listProfiles, save, probe: id => profileFor(id).adapter.probe(),
  async saveTabAppearance(input) {
    const item = state.profiles.find(item => item.profile.id === input.id);
    const name = input.name?.trim();
    if (!item || !name || name.length > 80 || /[\r\n\0]/.test(name) ||
      (input.icon !== undefined && !tabIcons.includes(input.icon)) ||
      (input.color !== undefined && !/^#[0-9a-f]{6}$/i.test(input.color))) {
      throw new Failure('Проверьте название, значок и цвет вкладки.');
    }
    const updated = structuredClone(item);
    Object.assign(updated.profile, { name, icon: input.icon, color: input.color });
    const profiles = state.profiles.map(profile => profile === item ? updated : profile);
    await persist({ ...state, profiles });
    return listProfiles();
  },
  async pickDirectory() { return (await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] })).filePaths[0] ?? ''; },
  async open(path) { return openWorkspace(await git.openRepoRoot(path)); },
  async init(path) { return openWorkspace(await git.initRepo(path)); },
  async clone(input) { return openWorkspace(await git.cloneRepo(input.url, input.path)); },
  status: git.gitStatus, diff: git.gitDiff, branch: input => git.changeBranch(input.repo, input.branch, input.create),
  branchAction: input => git.branchAction(input.repo, input),
  async copyBranchName({ repo, ref }) {
    const { localBranches, remoteBranches } = await git.gitStatus(repo);
    const name = localBranches.find(name => ref === 'refs/heads/' + name)
      ?? remoteBranches.find(name => ref === 'refs/remotes/' + name);
    if (!name) throw new Failure('Ветка больше не доступна.', 'git');
    clipboard.writeText(name);
  },
  workingPatch: input => git.workingPatch(input.repo, input.path, input.staged),
  stageFile: input => git.stageFile(input.repo, input.path, input.staged),
  commitStaged: input => git.commitStaged(input.repo, input.message, input.description),
  gitLog: input => git.gitLog(input.repo, input.ref, input.offset),
  commitFiles: input => git.commitFiles(input.repo, input.sha),
  commitPatch: input => git.commitPatch(input.repo, input.sha, input.paths),
  fetch: git.fetchRemote, pull: git.pullBranch, push: git.pushBranch,
  async inventory(id) {
    return (await exportSnapshot(profileFor(id).adapter)).assets;
  },
  async exportPreview(input) {
    preparedExport = undefined;
    const repo = applicationRepo(input);
    const exported = await exportSnapshot(profileFor(input.profileId).adapter, input.selected);
    const preview = await git.previewWrite(repo, input.folder, exported.files);
    const id = randomUUID();
    preparedExport = { ...input, ...exported, id, head: preview.head, branch: preview.branch, written: false };
    return { ...preview, id, counts: exported.counts, issues: exported.issues };
  },
  async write(id) {
    const prepared = preparedExport;
    if (!prepared || prepared.id !== id || prepared.written) throw new Failure('Сначала подготовьте экспорт.');
    const result = await git.writeSnapshot(prepared.repo, prepared.folder, prepared.files, prepared);
    prepared.written = Boolean(result.changes.length);
    return git.gitStatus(prepared.repo);
  },
  async commit(input) {
    const prepared = preparedExport;
    if (!prepared || prepared.id !== input.id || !prepared.written) throw new Failure('Сначала запишите просмотренный снимок.');
    const result = await git.commitSnapshot(prepared.repo, prepared.folder, input.message, prepared);
    preparedExport = undefined;
    return result;
  },
  async validate(input) {
    const source = await sourceSnapshot(input.repo, input.ref, input.folder);
    const { assets, excluded } = prepareSnapshot(source.files, input.compatibleOnly);
    return { sha: source.sha, counts: summarize(assets), excluded };
  },
  snapshotFolders: input => git.snapshotFolders(input.repo, input.ref),
  async plan(input) {
    preparedImport = undefined;
    const source = await sourceSnapshot(applicationRepo(input), input.ref, input.folder);
    const { profile, secret, adapter } = profileFor(input.profileId);
    const { files, excluded } = prepareSnapshot(source.files, input.compatibleOnly);
    const expected = await planImport(adapter, profile, files, secret.connections);
    const id = randomUUID();
    preparedImport = { ...input, ...source, files, id, expected };
    const { targetState, connectionState, ...publicPlan } = expected;
    return { ...publicPlan, id, sha: source.sha, excluded };
  },
  async verify(input) {
    const source = await sourceSnapshot(applicationRepo(input), input.ref, input.folder);
    const { files } = prepareSnapshot(source.files, input.compatibleOnly);
    return verifyImport(profileFor(input.profileId).adapter, files);
  },
  async apply(input) {
    const prepared = preparedImport;
    if (!prepared || prepared.id !== input.id) throw new Failure('Сначала постройте план импорта.');
    const { profile, secret, adapter } = profileFor(prepared.profileId);
    if (input.confirm !== confirmation(profile, prepared.sha)) throw new Failure('Подтвердите импорт названием приложения и полным SHA.');
    let backup: string | undefined;
    if (input.backup) {
      backup = (await dialog.showSaveDialog(window, { defaultPath: 'superset-assets-before-' + prepared.sha.slice(0, 10) + '.zip',
        filters: [{ name: 'ZIP', extensions: ['zip'] }] })).filePath;
      if (!backup) throw new Failure('Выбор файла резервного экспорта отменён.', 'cancelled');
    }
    preparedImport = undefined;
    return applyImport(adapter, profile, prepared.files, secret.connections, { sha: prepared.sha, confirm: input.confirm, backup, expected: prepared.expected });
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
const quiet = new Set(['profiles', 'history', 'pickDirectory', 'status', 'diff', 'workingPatch', 'gitLog', 'commitFiles', 'commitPatch', 'snapshotFolders', 'updateStatus', 'checkUpdate', 'updateChanges', 'installUpdate', 'openReleases', 'copyBranchName']);
const logMessages: Partial<Record<keyof Requests, string>> = {
  save: 'Профиль сохранён', probe: 'Проверка стенда выполнена', open: 'Репозиторий открыт', clone: 'Репозиторий клонирован',
  branch: 'Ветка выбрана', branchAction: 'Операция с веткой', fetch: 'Fetch выполнен', pull: 'Pull выполнен', push: 'Push выполнен', inventory: 'Состав экспорта получен',
  exportPreview: 'Предпросмотр экспорта готов', write: 'Каталог снимка проверен и записан', commit: 'Коммит создан',
  validate: 'Локальная проверка пройдена', plan: 'План импорта подготовлен', apply: 'Импорт применён и проверен', verify: 'Проверка цели выполнена',
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
    const unsuccessful = method === 'verify' && data && typeof data === 'object' && 'verified' in data && !data.verified;
    await log(method, unsuccessful ? 'error' : 'ok', unsuccessful ? 'На стенде есть расхождения.' : '');
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
