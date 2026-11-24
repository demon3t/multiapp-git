import { app, BrowserWindow, dialog, ipcMain, net, safeStorage, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Failure, Profile, profileUrl, Secret, uuidPattern } from './core/model';
import { Bridge, Context, Entry, ProfileInput, Requests } from './core/public';
import * as git from './core/git';
import { Superset } from './core/superset';
import { prepareSnapshot, summarize } from './core/snapshot';
import { applyImport, confirmation, exportSnapshot, planImport, sourceSnapshot, verifyImport } from './core/workflow';
import { checkRelease, releasesPage, UpdateStatus } from './core/updates';

type Stored = { profile: Profile; encrypted: string; type?: 'superset'; repo?: string };
type State = { profiles: Stored[]; history: Entry[]; updates?: { automatic: boolean; encryptedToken?: string } };
let state: State;
let window: BrowserWindow;
let busy = false;
let preparedExport: (Context & Awaited<ReturnType<typeof exportSnapshot>> & { id: string; head: string; branch: string; written: boolean }) | undefined;
let preparedImport: (Context & Awaited<ReturnType<typeof sourceSnapshot>> & { id: string; expected: Awaited<ReturnType<typeof planImport>> }) | undefined;
const path = () => join(app.getPath('userData'), 'mgit.json');
let releaseStatus: UpdateStatus = { current: app.getVersion(), status: 'idle' };
let updateCheck: Promise<ReturnType<typeof updateView>> | undefined;
let updateTimer: NodeJS.Timeout | undefined;
const updateView = () => ({ ...releaseStatus, automatic: state.updates?.automatic, hasToken: Boolean(state.updates?.encryptedToken) });

function reportUpdate() {
  if (window && !window.isDestroyed()) window.webContents.send('mgit:update', updateView());
  return updateView();
}
function scheduleUpdate(delay: number) {
  clearTimeout(updateTimer);
  if (state.updates?.automatic) updateTimer = setTimeout(() => void checkUpdate(), delay);
}
function checkUpdate() {
  if (updateCheck) return updateCheck;
  updateCheck = (async () => {
    releaseStatus = { current: app.getVersion(), status: 'checking' };
    reportUpdate();
    try {
      const encrypted = state.updates?.encryptedToken;
      const token = encrypted ? safeStorage.decryptString(Buffer.from(encrypted, 'base64')) : '';
      releaseStatus = await checkRelease(app.getVersion(), token, (url, options) => net.fetch(url, options));
    } catch {
      releaseStatus = { current: app.getVersion(), status: 'error', message: 'Не удалось прочитать защищённый токен GitHub. Сохраните его заново.' };
    }
    return reportUpdate();
  })().finally(() => {
    updateCheck = undefined;
    scheduleUpdate(24 * 60 * 60 * 1000);
  });
  return updateCheck;
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
function profileFor(id: string) {
  const item = state.profiles.find(item => item.profile.id === id);
  if (!item) throw new Failure('Выберите профиль Superset.');
  const secret = unlock(item);
  return { profile: item.profile, secret, adapter: new Superset(item.profile, secret) };
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
  preparedImport = undefined;
  preparedExport = undefined;
  return listProfiles();
}
const requests: { [K in keyof Requests]: (input: Requests[K][0]) => Requests[K][1] | Promise<Requests[K][1]> } = {
  profiles: listProfiles, save, probe: id => profileFor(id).adapter.probe(),
  async pickDirectory() { return (await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] })).filePaths[0] ?? ''; },
  async open(path) { const repo = await git.openRepoRoot(path); return { repo, state: await git.gitStatus(repo) }; },
  async clone(input) { const repo = await git.cloneRepo(input.url, input.path); return { repo, state: await git.gitStatus(repo) }; },
  status: git.gitStatus, diff: git.gitDiff, branch: input => git.changeBranch(input.repo, input.branch, input.create),
  fetch: git.fetchRemote, push: git.pushBranch,
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
  async saveUpdateSettings(input) {
    if (typeof input.automatic !== 'boolean') throw new Failure('Укажите, включать ли автоматическую проверку.');
    const token = input.token?.trim();
    let encryptedToken = input.clearToken ? undefined : state.updates?.encryptedToken;
    if ((token || input.clearToken) && updateCheck) throw new Failure('Дождитесь завершения проверки перед сменой токена.');
    if (token) {
      if (token.length > 512 || !/^[\w-]+$/.test(token)) throw new Failure('Проверьте формат токена GitHub.');
      if (!safeStorage.isEncryptionAvailable()) throw new Failure('Системное защищённое хранилище недоступно.', 'storage');
      encryptedToken = safeStorage.encryptString(token).toString('base64');
    }
    await persist({ ...state, updates: { automatic: input.automatic, encryptedToken } });
    if (!updateCheck && (token || input.clearToken)) releaseStatus = { current: app.getVersion(), status: 'idle' };
    scheduleUpdate(15_000);
    return reportUpdate();
  },
  openReleases: () => shell.openExternal(releasesPage)
};
const quiet = new Set(['profiles', 'history', 'pickDirectory', 'status', 'diff', 'snapshotFolders', 'updateStatus', 'checkUpdate', 'openReleases']);
const logMessages: Partial<Record<keyof Requests, string>> = {
  save: 'Профиль сохранён', probe: 'Проверка стенда выполнена', open: 'Репозиторий открыт', clone: 'Репозиторий клонирован',
  branch: 'Ветка выбрана', fetch: 'Fetch выполнен', push: 'Push выполнен', inventory: 'Состав экспорта получен',
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
      backgroundColor: '#f5f6fa', titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#e5e8ee', symbolColor: '#223148', height: 39 },
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
