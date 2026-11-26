import React, { FormEvent, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AssetSummary, Bridge, Change, GitState, OpenedRepo, Plan, Preview, ProfileInput, ProfileSummary, Requests, UpdateView } from './core/public';
import './ui.css';
import { UpdateDialog } from './update-dialog';
import { UpdateNotification } from './update-notification';
import { BranchList } from './branch-list';
import { BranchDialog, BranchMenu, type BranchCommand, type BranchMenuTarget, type EditAction } from './branch-menu';
import type { BranchAction, CommitAction, CommitCommand, GitCommit } from './core/public';
import { CommitActionDialog, CommitMenu, commitLabels, type CommitEdit, type CommitMenuTarget } from './commit-menu';
import { GitHistory } from './git-history';
import { WorkingTree } from './working-tree';
import { RepositoryIcon, TabAppearanceDialog } from './tab-appearance';

declare global { interface Window { mgit: Bridge } }
const pages = ['Приложения', 'Репозитории', 'Экспорт', 'Импорт', 'История Git', 'Настройки', 'Система'] as const;
type Page = typeof pages[number];
const labels: Record<string, string> = { databases: 'Подключения', datasets: 'Датасеты', charts: 'Графики', dashboards: 'Дашборды', queries: 'SQL-запросы' };
const actionNames: Record<string, string> = { add: 'Добавление', update: 'Обновление', remove: 'Удаление' };
const repositoryName = (path: string) => path.split(/[\\/]/).at(-1);
const operationIcons = {
  pull: 'M5 5h14 M5 5l4-4 M5 5l4 4 M19 19H5 M19 19l-4-4 M19 19l-4 4',
  fetch: 'M12 3v14 M7 13l5 5 5-5 M4 20h16',
  push: 'M12 21V7 M7 11l5-5 5 5 M4 3h16',
  export: 'M12 16V3 M7 8l5-5 5 5 M4 14v6h16v-6',
  import: 'M12 3v13 M7 11l5 5 5-5 M4 14v6h16v-6'
} as const;
function OperationIcon({ name }: { name: keyof typeof operationIcons }) {
  return <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={operationIcons[name]}/></svg>;
}

type ProfileEditor = Omit<ProfileInput, 'auth'> & { auth: ProfileInput['auth'] | '' };
const emptyProfile: ProfileEditor = { name: '', url: '', type: '', repo: '', auth: '', username: '' };
const emptyGit: GitState = { branch: '', status: '', head: '', localBranches: [], remoteBranches: [], tags: [], files: [] };
const defaultFolder = 'snapshots/superset/assets';
type MenuCommand = {
  label: string; shortcut: string; code: string; ctrl?: boolean; shift?: boolean;
  disabled?: boolean; run: () => void;
};
function CommandButton({ command }: { command: MenuCommand }) {
  return <button type="button" className="menu-command" disabled={command.disabled}
    aria-keyshortcuts={command.shortcut.replace('Ctrl', 'Control')} onClick={command.run}>
    <span>{command.label}</span><kbd aria-hidden="true">{command.shortcut}</kbd>
  </button>;
}
function Counts({ values }: { values: Record<string, number> }) {
  return <div className="counts">{Object.entries(values).map(([kind, count]) => <div key={kind}><strong>{count}</strong><span>{labels[kind]}</span></div>)}</div>;
}
function Exclusions({ items }: { items: Plan['excluded'] }) {
  if (!items.length) return null;
  return <details className="notice"><summary>Исключено объектов: {items.length}</summary>
    <div className="asset-list">{items.map(issue => <p key={issue.path}>{issue.path} · {issue.message}</p>)}</div>
  </details>;
}
function Changes({ changes }: { changes: Change[] }) {
  const [index, setIndex] = useState(0);
  const change = changes[index] ?? changes[0];
  if (!change) return <p className="notice">Снимок совпадает с HEAD.</p>;
  return <div className="diff">
    <div className="diff-files">{changes.map((entry, i) => <button className={entry === change ? 'active' : ''} key={entry.path} onClick={() => setIndex(i)}>
      <span className={'tag ' + entry.action}>{actionNames[entry.action]}</span><span>{entry.path}</span></button>)}</div>
    <div className="yaml-comparison">
      <div className="diff-path" title={change.path}>{change.path}</div>
      <section aria-label="До"><h3>До</h3><pre>{change.before ?? '—'}</pre></section>
      <section aria-label="После"><h3>После</h3><pre>{change.after ?? '—'}</pre></section>
    </div>
  </div>;
}

function App() {
  const [page, setPage] = useState<Page>('Приложения');
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [profileId, setProfileId] = useState('');
  const [editor, setEditor] = useState<ProfileEditor>({ ...emptyProfile });
  const [repo, setRepo] = useState('');
  const [repoInput, setRepoInput] = useState('');
  const [cloning, setCloning] = useState(false);
  const [remote, setRemote] = useState('');
  const [git, setGit] = useState(emptyGit);
  const [gitDiff, setGitDiff] = useState<{ staged: string; unstaged: string }>();
  const [folderInput, setFolderInput] = useState<string>();
  const [snapshotFolders, setSnapshotFolders] = useState<{ repo: string; ref: string; head: string; paths: string[] }>();
  const [ref, setRef] = useState('HEAD');
  const [historyRef, setHistoryRef] = useState<string>();
  const [historyFocus, setHistoryFocus] = useState<{ ref: string }>();
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<{ message: string; details?: unknown }>();
  const [assets, setAssets] = useState<AssetSummary[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [partial, setPartial] = useState(false);
  const [preview, setPreview] = useState<Preview>();
  const [written, setWritten] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [plan, setPlan] = useState<Plan>();
  const [only, setOnly] = useState(false);
  const [compatibleOnly, setCompatibleOnly] = useState(false);
  const [backup, setBackup] = useState(true);
  const [confirm, setConfirm] = useState('');
  const [validation, setValidation] = useState<Requests['validate'][1]>();
  const [operationLog, setOperationLog] = useState<string[]>([]);
  const [update, setUpdate] = useState<UpdateView>();
  const [dismissedUpdate, setDismissedUpdate] = useState('');
  const [updateError, setUpdateError] = useState('');
  const [updateDialog, setUpdateDialog] = useState(false);
  const [repoMenu, setRepoMenu] = useState(false);
  const [appMenu, setAppMenu] = useState(false);
  const [appearanceTab, setAppearanceTab] = useState<ProfileSummary>();
  const [branchMenu, setBranchMenu] = useState<BranchMenuTarget>();
  const [branchDialog, setBranchDialog] = useState<{ ref: string; action: EditAction; current: string; head: string }>();
  const [commitMenu, setCommitMenu] = useState<CommitMenuTarget>();
  const [commitAction, setCommitAction] = useState<{ commit: GitCommit; action: CommitEdit; state: GitState }>();
  const [commitComparison, setCommitComparison] = useState<{ sha: string; patch: string }>();
  const comparisonDialog = useRef<HTMLDialogElement>(null);
  const updateAvailable = Boolean(update?.latest && ['available', 'downloading', 'ready', 'installing'].includes(update.status));
  const profile = profiles.find(item => item.id === profileId);
  const folderRef = page === 'Импорт' ? ref : 'HEAD';
  const paths = snapshotFolders?.repo === repo && snapshotFolders.ref === folderRef && snapshotFolders.head === git.head ? snapshotFolders.paths : [];
  const folder = folderInput ?? (paths.length === 1 ? paths[0] : defaultFolder);
  const context = { repo, folder, profileId };
  const applicationReady = Boolean(profile?.repo && profile.repo === repo);
  useEffect(() => { if (commitComparison) comparisonDialog.current?.showModal(); }, [commitComparison]);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(''), 6000);
    return () => window.clearTimeout(timer);
  }, [message]);

  const updateNoticeKey = update ? JSON.stringify([update.status, update.latest, update.message, updateError]) : '';
  const showUpdateDialog = updateDialog && updateAvailable;
  const updateNotification = update && (update.status !== 'idle' || updateError) && updateNoticeKey !== dismissedUpdate &&
    <UpdateNotification update={updateError ? { ...update, status: 'error', message: updateError } : update}
      dismiss={() => setDismissedUpdate(updateNoticeKey)} showDetails={showUpdateDialog ? undefined : () => setUpdateDialog(true)}/>;

  useEffect(() => {
    if (update?.status !== 'current' && update?.status !== 'no-release') return;
    const timer = window.setTimeout(() => setDismissedUpdate(updateNoticeKey), 6000);
    return () => window.clearTimeout(timer);
  }, [update?.status, updateNoticeKey]);

  async function run<K extends keyof Requests>(
    method: K, input: Requests[K][0], title: string, complete?: (result: Requests[K][1]) => void | Promise<void>
  ) {
    if (busy) return;
    setBusy(title); setError(undefined); setMessage('');
    setOperationLog(log => [...log, title + '…']);
    try {
      const result = await window.mgit.call(method, input);
      if (result.ok) { setOperationLog(log => [...log, title + ': готово']); await complete?.(result.data); }
      else { setOperationLog(log => [...log, title + ': ошибка — ' + result.message]); setError({ message: result.message, details: result.details }); }
    } catch { setOperationLog(log => [...log, title + ': ошибка связи']); setError({ message: 'Связь с процессом mGit прервалась.' }); }
    finally { setBusy(''); }
  }
  useEffect(() => { void run('profiles', undefined, 'Загрузка профилей', data => { setProfiles(data); setProfileId(data[0]?.id ?? ''); }); }, []);
  useEffect(() => {
    let active = true;
    const unsubscribe = window.mgit.onUpdate(status => {
      if (status.status === 'checking' || status.status === 'downloading') {
        setDismissedUpdate('');
        setUpdateError('');
      }
      setUpdate(status);
    });
    void window.mgit.call('updateStatus', undefined).then(result => {
      if (active && result.ok) setUpdate(result.data);
    }).catch(() => undefined);
    return () => { active = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    if (!repoMenu && !appMenu) return;
    function close(event: PointerEvent | KeyboardEvent) {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : event.target instanceof Element && !event.target.closest('.repo-menu, .app-menu')) {
        setRepoMenu(false); setAppMenu(false);
      }
    }
    window.addEventListener('pointerdown', close); window.addEventListener('keydown', close);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', close); };
  }, [repoMenu, appMenu]);
  useEffect(() => {
    if (!profile?.repo) return;
    let active = true;
    const path = profile.repo;
    void window.mgit.call('status', path).then(result => {
      if (!active) return;
      if (result.ok) {
        setRepo(path); setRepoInput(path); setGit(result.data);
      } else setError({ message: 'Не удалось открыть папку Git приложения. Проверьте её в настройках.' });
    }).catch(() => {
      if (active) setError({ message: 'Связь с процессом mGit прервалась.' });
    });
    return () => { active = false; };
  }, [profile?.id, profile?.repo]);
  useEffect(() => {
    if (!repo || !git.head || !folderRef.trim()) return;
    let active = true;
    void window.mgit.call('snapshotFolders', { repo, ref: folderRef }).then(result => {
      if (active) setSnapshotFolders({ repo, ref: folderRef, head: git.head, paths: result.ok ? result.data : [] });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [repo, git, folderRef]);
  function invalidate() { setPreview(undefined); setWritten(false); setPlan(undefined); setValidation(undefined); setConfirm(''); }
  function chooseProfile(id: string) {
    setHistoryRef(undefined);
    if (id !== profileId) {
      setRepo(''); setRepoInput(''); setGit(emptyGit); setGitDiff(undefined); setRef('HEAD'); setFolderInput(undefined);
    }
    setProfileId(id); setAssets([]); setSelected([]); setCompatibleOnly(false); invalidate();
  }
  function navigate(next: Page) {
    setPage(next); setError(undefined); setMessage('');
    if (next === 'Импорт' && git.branch) setRef(git.branch);
  }
  function editApplication(application?: ProfileSummary) {
    setEditor(application ? { ...application, auth: application.type === 'git' ? '' : application.auth } : { ...emptyProfile });
    navigate('Настройки');
  }
  function saveProfile(event: FormEvent) {
    event.preventDefault();
    const { auth } = editor;
    if (editor.type === 'superset' && !auth) return;
    void run('save', { ...editor, auth: auth || 'db' }, 'Сохранение профиля', value => {
      const saved = value.at(-1)!;
      if (saved.id === profileId && saved.repo !== profile?.repo) {
        setRepo(''); setRepoInput(''); setGit(emptyGit); setGitDiff(undefined); setRef('HEAD'); setFolderInput(undefined);
      }
      setProfiles(value); chooseProfile(saved.id); setEditor({ ...emptyProfile });
      navigate('Приложения'); setMessage('Приложение сохранено.');
    });
  }
  function setOpened(result: OpenedRepo) {
    if (repo !== result.repo) { setRef('HEAD'); setFolderInput(undefined); setHistoryRef(undefined); }
    setProfiles(result.profiles);
    const linkedProfile = result.profiles.find(item => item.repo === result.repo);
    if (linkedProfile && !result.profiles.some(item => item.id === profileId && item.repo === result.repo)) {
      setProfileId(linkedProfile.id);
      setAssets([]); setSelected([]); setCompatibleOnly(false);
    }
    setCloning(false);
    setRepo(result.repo); setRepoInput(result.repo); setGit(result.state); setGitDiff(undefined); invalidate(); setMessage('Репозиторий открыт.');
  }
  function openDirectory(method: 'init' | 'open') {
    setRepoMenu(false);
    void run('pickDirectory', undefined, 'Выбор каталога Git', async path => {
      if (!path) return;
      await run(method, path, method === 'init' ? 'Инициализация репозитория' : 'Открытие репозитория', result => {
        navigate(result.profiles.some(item => item.repo === result.repo && item.type === 'git') ? 'Репозитории' : 'История Git');
        setOpened(result);
      });
    });
  }
  function selectApplication(application: ProfileSummary) {
    chooseProfile(application.id);
    if (application.id === profileId && application.repo && !applicationReady) {
      void run('open', application.repo, 'Открытие репозитория приложения', setOpened);
    }
  }
  function updateGit(result: GitState) { setGit(result); setGitDiff(undefined); invalidate(); }
  function showGitHistory(value?: string) {
    setHistoryFocus(undefined);
    setHistoryRef(value);
    if (value) { setRef(value); invalidate(); }
    navigate('История Git');
  }
  function locateBranch(ref: string) {
    setBranchMenu(undefined);
    showGitHistory();
    setHistoryFocus({ ref });
  }
  function openBranchMenu(ref: string, anchor: HTMLButtonElement) {
    setBranchMenu({ ref, anchor });
  }
  function changeSelectedBranch(action: BranchAction) {
    setBranchMenu(undefined);
    setBranchDialog(undefined);
    if (busy) return;
    void run('branchAction', { repo, ...action }, 'Операция с веткой', result => {
      updateGit(result);
      if (action.action === 'switch' || action.action === 'create') {
        locateBranch('refs/heads/' + result.branch);
        setMessage('Текущая ветка: ' + result.branch);
      } else if (action.action === 'tag') {
        setMessage('Тег создан.');
      } else if (action.action === 'merge' || action.action === 'rebase') {
        showGitHistory('refs/heads/' + result.branch);
        setMessage(action.action === 'merge' ? 'Слияние выполнено.' : 'Rebase выполнен.');
      } else {
        if (historyRef === action.ref) showGitHistory(action.action === 'rename' ? 'refs/heads/' + action.name : undefined);
        setMessage(action.action === 'rename' ? 'Ветка переименована.' : 'Ветка удалена.');
      }
    });
  }
  function chooseBranchCommand(command: BranchCommand) {
    if (!branchMenu) return;
    const { ref } = branchMenu;
    setBranchMenu(undefined);
    if (command === 'history') showGitHistory(ref);
    else if (command === 'switch') changeSelectedBranch({ ref, action: 'switch' });
    else if (command === 'copy') void run('copyBranchName', { repo, ref }, 'Копирование имени ветки');
    else setBranchDialog({ ref, action: command, current: git.branch, head: git.head });
  }
  function chooseCommitCommand(command: CommitCommand) {
    if (!commitMenu) return;
    const { commit } = commitMenu;
    setCommitMenu(undefined);
    const input = { repo, sha: commit.sha };
    if (command === 'compare') void run('compareCommit', input, 'Сравнение с рабочей папкой', patch => setCommitComparison({ sha: commit.sha, patch }));
    else if (command === 'patch') void run('saveCommitPatch', input, 'Сохранение патча', saved => { if (saved) setMessage('Патч сохранён.'); });
    else if (command === 'copy-sha' || command === 'copy-info') void run('copyCommit', { ...input, full: command === 'copy-info' },
      'Копирование коммита', () => setMessage(command === 'copy-info' ? 'Сведения о коммите скопированы.' : 'SHA коммита скопирован.'));
    else setCommitAction({ commit, action: command, state: git });
  }
  function applyCommitAction(input: CommitAction) {
    setCommitAction(undefined);
    void run('commitAction', { repo, ...input }, commitLabels[input.action].replace(/…$/, ''), result => {
      updateGit(result);
      setMessage('Операция с коммитом выполнена.');
    });
  }
  function statusResult(result: { verified: boolean; checked: number; issues: unknown[] }) {
    if (result.verified) setMessage('На цели подтверждены UUID и связи. Проверено объектов: ' + result.checked + '.');
    else setError({ message: 'На цели есть расхождения.', details: result.issues });
  }
  async function executeExport() {
    if (busy || !selected.length) return;
    setBusy('Экспорт'); setError(undefined); setMessage('');
    try {
      const prepared = await window.mgit.call('exportPreview', { ...context, selected });
      if (!prepared.ok) throw prepared;
      setOperationLog(log => [...log, 'Экспорт: подготовка завершена']);
      const written = await window.mgit.call('write', prepared.data.id);
      if (!written.ok) throw written;
      const committed = await window.mgit.call('commit', { id: prepared.data.id, message: 'Export Superset metadata' });
      if (!committed.ok) throw committed;
      setGit(committed.data); setMessage('Экспорт завершён.'); setOperationLog(log => [...log, 'Экспорт: коммит создан']);
    } catch (caught) { const failure = caught as { message?: string; details?: unknown }; setError({ message: failure.message || 'Экспорт не завершён.', details: failure.details }); setOperationLog(log => [...log, 'Экспорт: ошибка']); }
    finally { setBusy(''); }
  }
  async function executeImport() {
    if (busy || !selected.length || !profile) return;
    setBusy('Импорт'); setError(undefined); setMessage('');
    try {
      const planned = await window.mgit.call('plan', { ...context, ref: git.branch || ref, selected });
      if (!planned.ok) throw planned;
      setOperationLog(log => [...log, 'Импорт: план подготовлен']);
      const applied = await window.mgit.call('apply', { id: planned.data.id, confirm: profile.name + ' ' + planned.data.sha, backup: false });
      if (!applied.ok) throw applied;
      statusResult(applied.data); setOperationLog(log => [...log, applied.data.verified ? 'Импорт: проверка пройдена' : 'Импорт: проверка не пройдена']);
    } catch (caught) { const failure = caught as { message?: string; details?: unknown }; setError({ message: failure.message || 'Импорт не завершён.', details: failure.details }); setOperationLog(log => [...log, 'Импорт: ошибка']); }
    finally { setBusy(''); }
  }

  function checkForUpdates() {
    setDismissedUpdate('');
    setUpdateError('');
    setUpdate(previous => previous && { ...previous, status: 'checking', message: undefined });
    void window.mgit.call('checkUpdate', undefined).then(result => {
      if (!result.ok) {
        setUpdate(previous => previous && { ...previous, status: 'error', message: result.message });
        return;
      }
      setUpdate(result.data);
    }).catch(() => {
      setUpdate(previous => previous && { ...previous, status: 'error', message: 'Не удалось проверить обновления.' });
    });
  }

  const commands = {
    init: { label: 'Инициализировать репозиторий', shortcut: 'Ctrl+Shift+N', code: 'KeyN', ctrl: true, shift: true,
      run: () => openDirectory('init') },
    open: { label: 'Открыть репозиторий', shortcut: 'Ctrl+O', code: 'KeyO', ctrl: true,
      run: () => openDirectory('open') },
    clone: { label: 'Клонировать репозиторий', shortcut: 'Ctrl+Shift+O', code: 'KeyO', ctrl: true, shift: true,
      run: () => { setRepoMenu(false); setRepoInput(''); setRemote(''); setCloning(true); navigate('Репозитории'); } },
    settings: { label: 'Система', shortcut: 'Ctrl+,', code: 'Comma', ctrl: true,
      run: () => { setAppMenu(false); navigate('Система'); } },
    checkUpdate: { label: 'Проверить сейчас', shortcut: 'Ctrl+Shift+U', code: 'KeyU', ctrl: true, shift: true,
      disabled: update?.status === 'checking',
      run: checkForUpdates },
    updateNotes: { label: 'Что нового', shortcut: 'Shift+F1', code: 'F1', shift: true, disabled: !updateAvailable,
      run: () => setUpdateDialog(true) },
    releases: { label: 'Релизы на GitHub', shortcut: 'F1', code: 'F1',
      run: () => { void run('openReleases', undefined, 'Открытие GitHub'); } }
  } satisfies Record<string, MenuCommand>;

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.metaKey) return;
      const command = (Object.values(commands) as MenuCommand[]).find(item =>
        item.code === event.code && Boolean(item.ctrl) === event.ctrlKey && Boolean(item.shift) === event.shiftKey);
      if (!command) return;
      event.preventDefault();
      if (event.repeat || busy || updateDialog || appearanceTab || branchDialog || branchMenu || commitMenu || commitAction || commitComparison || command.disabled) return;
      setRepoMenu(false);
      setAppMenu(false);
      command.run();
    }
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  });

  const contextPanel = null;
  const selectableAssets = assets.filter(asset => asset.kind === 'datasets' || asset.kind === 'charts');
  const operationLogPanel = (page === 'Экспорт' || page === 'Импорт') && <section className="panel operation-log"><h2>Лог операции</h2>
    <pre>{operationLog.length ? operationLog.join('\n') : 'Операции ещё не запускались.'}</pre></section>;

  const fileWorkspace = page === 'Репозитории' && !cloning && Boolean(repo) && profile?.type === 'git';
  const askUpdatePermission = update?.askPermission && page !== 'Система' && !showUpdateDialog && !updateNotification;
  const notifications = (busy || error || message || updateNotification || askUpdatePermission) && <div className="operation-toasts">
    {busy && <div role="status" className="notice progress"><progress aria-label={busy}/>{busy}…</div>}
    {error && <div className="error operation-toast-result">
      <div role="alert"><strong>{error.message}</strong>{error.details != null && <pre>{JSON.stringify(error.details, null, 2)}</pre>}</div>
      <button className="toast-close" type="button" aria-label="Закрыть уведомление" title="Закрыть" onClick={() => setError(undefined)}/>
    </div>}
    {message && <div className="notice success operation-toast-result">
      <div role="status">{message}</div>
      <button className="toast-close" type="button" aria-label="Закрыть уведомление" title="Закрыть" onClick={() => setMessage('')}/>
    </div>}
    {updateNotification}
    {askUpdatePermission && <section className="notice operation-toast-result" aria-labelledby="update-permission">
      <div>
        <h2 id="update-permission">Проверять обновления автоматически?</h2>
        <p>mGit сможет проверять новые версии ежедневно, пока приложение открыто.</p>
        <div className="actions">
          <button className="primary" disabled={!!busy} onClick={() => run('saveUpdateSettings', { automatic: true }, 'Сохранение настроек', setUpdate)}>Разрешить</button>
          <button disabled={!!busy} onClick={() => run('saveUpdateSettings', { automatic: false }, 'Сохранение настроек', setUpdate)}>Нет, спасибо</button>
        </div>
      </div>
    </section>}
  </div>;

  return <div className="shell">
    <div className="tabbar">
      <button className="brand" aria-label="Приложения" onClick={() => navigate('Приложения')} disabled={!!busy}>
        <img src="./icon.png" width="16" height="16" alt=""/>
      </button>
      <div className="repo-menu">
        <button className="repo-menu-trigger" disabled={!!busy} aria-expanded={repoMenu} onClick={() => { setAppMenu(false); setRepoMenu(!repoMenu); }}>Файл</button>
        {repoMenu && <div className="repo-menu-panel">
          <CommandButton command={commands.init}/>
          <CommandButton command={commands.open}/>
          <CommandButton command={commands.clone}/>
        </div>}
      </div>
      <div className="app-menu">
        <button className="repo-menu-trigger" disabled={!!busy} aria-expanded={appMenu} onClick={() => { setRepoMenu(false); setAppMenu(!appMenu); }}>Настройки</button>
        {appMenu && <div className="repo-menu-panel app-menu-panel">
          <CommandButton command={commands.settings}/>
        </div>}
      </div>
      <div className="title-drag"/>
      <div className="updates-menu">
        <button className={'updates-toggle update-icon-button' + (updateAvailable ? ' update-available' : '')}
          aria-label="Проверить обновления" title="Проверить обновления (Ctrl+Shift+U)"
          disabled={!!busy || update?.status === 'checking' || update?.status === 'installing'}
          onClick={checkForUpdates}>
          <span className="update-icon" aria-hidden="true">↻</span>
        </button>
      </div>
    </div>
    {showUpdateDialog && update && <UpdateDialog key={update.latest} update={update} busy={!!busy}
      notification={notifications} onError={message => { setDismissedUpdate(''); setUpdateError(message); }} onClose={() => setUpdateDialog(false)}/>}
    {appearanceTab && <TabAppearanceDialog tab={appearanceTab} onClose={() => setAppearanceTab(undefined)} save={async input => {
      const result = await window.mgit.call('saveTabAppearance', input);
      if (!result.ok) throw new Error(result.message);
      setProfiles(result.data);
      setAppearanceTab(undefined);
    }}/>}
    <div className="toolbar">
      <div className="app-tabs" aria-label="Подключённые репозитории">
        {profiles.map(item => <button key={item.id} aria-pressed={item.id === profileId && applicationReady}
          disabled={!!busy} onClick={() => { setCloning(false); selectApplication(item); navigate(item.type === 'git' ? 'Репозитории' : item.repo ? 'История Git' : 'Приложения'); }}
          style={item.color ? { ['--tab-accent' as string]: item.color } as React.CSSProperties : undefined}
          onContextMenu={event => { event.preventDefault(); if (!busy) setAppearanceTab(item); }}
          title={(item.repo || item.url) + '\nПравый щелчок — оформление вкладки'}><RepositoryIcon {...item}/><span>{item.name}</span></button>)}
      </div>
      <button className="new-tab" title="Добавить приложение" aria-label="Добавить приложение" disabled={!!busy} onClick={() => editApplication()}>+</button>
    </div>
    <aside>
      <div className="operation-group" aria-label="Git операции">
        <button className="operation" title="Pull" aria-label="Pull" disabled={!repo || !git.branch || !!busy}
          onClick={() => run('pull', repo, 'Git pull', result => { setGit(result); setMessage('Pull выполнен.'); })}><OperationIcon name="pull"/><span>PULL</span></button>
        <button className="operation" title="Fetch" aria-label="Fetch" disabled={!repo || !!busy}
          onClick={() => run('fetch', repo, 'Git fetch', result => { setGit(result); setMessage('Fetch выполнен.'); })}><OperationIcon name="fetch"/><span>FETCH</span></button>
        <button className="operation" title="Push" aria-label="Push" disabled={!repo || !git.head || !git.branch || !!busy}
          onClick={() => run('push', repo, 'Git push', result => { setGit(result); setMessage('Push выполнен.'); })}><OperationIcon name="push"/><span>PUSH</span></button>
      </div>
      {profile?.type === 'superset' && applicationReady && <div className="operation-group superset-operations" aria-label="Superset операции">
        <button className="operation" title="Export" aria-label="Export" disabled={!!busy} onClick={() => navigate('Экспорт')}><OperationIcon name="export"/><span>EXPORT</span></button>
        <button className="operation" title="Import" aria-label="Import" disabled={!!busy} onClick={() => navigate('Импорт')}><OperationIcon name="import"/><span>IMPORT</span></button>
      </div>}
      {repo && <div className="branches" key={repo}>
        <div className="repo-views">
          <button aria-pressed={page === 'Репозитории' && !cloning} disabled={!!busy}
            onClick={() => { setCloning(false); navigate('Репозитории'); }}>Рабочее дерево</button>
          <button aria-pressed={page === 'История Git' && !historyRef} disabled={!!busy}
            onClick={() => showGitHistory()}>Все коммиты</button>
        </div>
        <BranchList label="Локальные ветки" names={git.localBranches} prefix="refs/heads/"
          expanded active={'refs/heads/' + git.branch} disabled={!!busy} onSelect={locateBranch}
          onMenu={openBranchMenu} onSwitch={ref => changeSelectedBranch({ ref, action: 'switch' })}/>
        <BranchList label="Удалённые ветки" names={git.remoteBranches} prefix="refs/remotes/"
          disabled={!!busy} onSelect={locateBranch} onMenu={openBranchMenu}
          onSwitch={ref => changeSelectedBranch({ ref, action: 'switch' })}/>
        {git.tags.length > 0 && <BranchList label="Теги" names={git.tags} prefix="refs/tags/"
          active={page === 'История Git' ? historyRef : undefined} disabled={!!busy} onSelect={showGitHistory}/>}
      </div>}
    </aside>
    {branchMenu && <BranchMenu target={branchMenu} current={git.branch} head={git.head} onClose={() => setBranchMenu(undefined)} onCommand={chooseBranchCommand}/>}
    {branchDialog && <BranchDialog refName={branchDialog.ref} action={branchDialog.action} current={branchDialog.current} head={branchDialog.head}
      onClose={() => setBranchDialog(undefined)} onSubmit={changeSelectedBranch}/>}
    {commitMenu && <CommitMenu target={commitMenu} state={git} onClose={() => setCommitMenu(undefined)} onCommand={chooseCommitCommand}
      onBranch={ref => { setBranchMenu({ ref, anchor: commitMenu.anchor }); setCommitMenu(undefined); }}/>}
    {commitAction && <CommitActionDialog {...commitAction} onClose={() => setCommitAction(undefined)} onSubmit={applyCommitAction}/>}
    {commitComparison && <dialog ref={comparisonDialog} className="update-dialog commit-comparison-dialog" aria-labelledby="commit-comparison-title"
      onCancel={event => { event.preventDefault(); setCommitComparison(undefined); }}>
      <h2 id="commit-comparison-title">Рабочая папка и коммит {commitComparison.sha.slice(0, 8)}</h2>
      <pre tabIndex={0}>{commitComparison.patch ? commitComparison.patch.slice(0, 250_000).split('\n').map((line, index) =>
        <span key={index} className={line.startsWith('@@') ? 'patch-hunk' : line.startsWith('+') && !line.startsWith('+++ ') ? 'patch-added'
          : line.startsWith('-') && !line.startsWith('--- ') ? 'patch-removed' : undefined}>{line || ' '}</span>) : 'Различий нет.'}
        {commitComparison.patch.length > 250_000 && '… Показано начало diff.'}</pre>
      <div className="update-dialog-actions"><button type="button" onClick={() => setCommitComparison(undefined)}>Закрыть</button></div>
    </dialog>}
    {!showUpdateDialog && notifications}
    <main className={page === 'Настройки' ? 'repository-settings' : page === 'История Git' ? 'history-page' : fileWorkspace ? 'file-workspace' : undefined}>
      {page !== 'История Git' && page !== 'Настройки' && page !== 'Система' && !fileWorkspace && <header><h1>{page}</h1></header>}
      <fieldset disabled={Boolean(busy)}>
      {page === 'Система' && <>
        <div className="commit-tabs" role="tablist" aria-label="Настройки">
          <button id="system-settings-tab" type="button" role="tab" aria-selected="true" aria-controls="system-settings-panel">Система</button>
        </div>
        <section id="system-settings-panel" className="form-grid repository-form" role="tabpanel" aria-labelledby="system-settings-tab">
          <label>Язык<select disabled><option value=""/></select></label>
          <label>Тема<select disabled><option value=""/></select></label>
          <section className="panel" aria-labelledby="system-updates-heading">
            <h2 id="system-updates-heading">Обновления{update?.current ? ' · mGit ' + update.current : ''}</h2>
            <label className="check"><input type="checkbox" checked={update?.automatic === true} onChange={e =>
              run('saveUpdateSettings', { automatic: e.target.checked }, 'Сохранение настроек', setUpdate)}/>Проверять автоматически</label>
            <label className="check"><input type="checkbox" checked={update?.automatic === true && update?.autoInstall === true}
              disabled={update?.automatic !== true} onChange={e =>
                run('saveUpdateSettings', { automatic: true, autoInstall: e.target.checked }, 'Сохранение настроек', setUpdate)}/>Скачивать и устанавливать при выходе</label>
            <div className="update-commands">
              <CommandButton command={commands.checkUpdate}/>
              {updateAvailable && <CommandButton command={commands.updateNotes}/>}
              <CommandButton command={commands.releases}/>
            </div>
          </section>
        </section>
      </>}
      {page === 'История Git' && (repo ? <GitHistory key={repo + '\0' + (historyRef ?? '')} repo={repo} ref={historyRef} revision={git}
        focus={historyFocus}
        onMenu={target => { setBranchMenu(undefined); setCommitMenu(target); }}/>
        : <p className="empty">Откройте репозиторий, чтобы увидеть историю Git.</p>)}
      {page === 'Приложения' && <>
        <section className="panel">
          <div className="section-title"><h2>Подключённые приложения</h2><button className="primary" onClick={() => editApplication()}>Добавить приложение</button></div>
          {profiles.length === 0 ? <p className="empty">Добавьте приложение и выберите папку его Git-репозитория.</p> :
            <div className="profile-list">{profiles.map(item => <div className={'profile-row ' + (item.id === profileId ? 'selected' : '')} key={item.id}>
              <button className="profile-select" onClick={() => { selectApplication(item); if (item.type === 'git') navigate('Репозитории'); }}>
                <strong>{item.name}</strong><span>{item.type === 'git' ? 'Git-репозиторий' : 'Apache Superset · ' + item.url}</span><span>{item.repo || 'Укажите папку Git'}</span></button>
              {item.type === 'superset' && <button onClick={() => run('probe', item.id, 'Проверка стенда', data => setMessage(
                'Superset ' + (data.version || '· версия не определена') + '. Admin: ' + (data.admin === null ? 'роль не определена' : data.admin ? 'да' : 'нет') +
                '. API экспорта: ' + (data.export ? 'да' : 'нет') + '. API импорта: ' + (data.import ? 'да' : 'нет') + '.'
              ))}>Проверить</button>}
              <button onClick={() => setAppearanceTab(item)}>Оформление вкладки</button>
              <button onClick={() => editApplication(item)}>Изменить</button>
            </div>)}</div>}
        </section>
      </>}
      {page === 'Настройки' && <>
        {editor.id && <header><h1>Редактирование приложения</h1></header>}
        <form id="repository-profile-form" onSubmit={saveProfile}>
          <div className="form-grid repository-form">
            <label><span>Тип приложения<span className="required-mark" aria-hidden="true"/></span><select value={editor.type} required onChange={e => setEditor({ ...editor, type: e.target.value, url: e.target.value === 'git' ? '' : editor.url, auth: e.target.value === 'git' ? '' : editor.auth })}>
              <option value="">Выберите тип</option><option value="git">Git-репозиторий</option><option value="superset">Apache Superset</option></select></label>
            <div className="repository-path">
              <label htmlFor="repository-directory"><span>Папка Git<span className="required-mark" aria-hidden="true"/></span></label>
              <div className="path-input">
                <input id="repository-directory" value={editor.repo} required onChange={e => setEditor({ ...editor, repo: e.target.value })}/>
                <button type="button" className="folder-picker" aria-label="Выбрать папку Git" title="Выбрать папку Git"
                  onClick={() => run('pickDirectory', undefined, 'Выбор папки Git', value => { if (value) setEditor({ ...editor, repo: value }); })}>
                  <RepositoryIcon icon="folder"/>
                </button>
              </div>
            </div>
            {editor.type === 'superset' && <>
              <label>URL<input value={editor.url} onChange={e => setEditor({ ...editor, url: e.target.value })}/></label>
              <label><span>Тип подключения<span className="required-mark" aria-hidden="true"/></span><select required value={editor.auth} onChange={e => setEditor({ ...editor, auth: e.target.value as ProfileEditor['auth'], credential: '' })}>
                <option value="" disabled>Выберите тип</option><option value="db">Логин и пароль</option><option value="token">Токен</option></select></label>
              {editor.auth === 'db' && <label>Логин<input value={editor.username ?? ''} onChange={e => setEditor({ ...editor, username: e.target.value })}/></label>}
              {editor.auth && <label key={editor.auth}>{editor.auth === 'token' ? 'Токен' : 'Пароль'}<input autoComplete="new-password" type="password"
                value={editor.credential || ''} onChange={e => setEditor({ ...editor, credential: e.target.value })}/></label>}
            </>}
          </div>
          {editor.id && editor.type === 'superset' && <details className="advanced"><summary>Дополнительные параметры Superset</summary>
          <div className="form-grid">
            <label className="wide">Название<input value={editor.name} onChange={e => setEditor({ ...editor, name: e.target.value })}/></label>
            <label className="wide">Корпоративный CA · PEM<textarea rows={3} spellCheck={false} value={editor.ca ?? ''} onChange={e => setEditor({ ...editor, ca: e.target.value })}/></label>
            <label className="wide">Подключения для импорта<textarea rows={4} spellCheck={false} autoComplete="off" placeholder="UUID SQLAlchemy URI · одно подключение на строку"
              value={editor.mappings ?? ''} onChange={e => setEditor({ ...editor, mappings: e.target.value })}/></label>
          </div>
          {editor.id && <p className="hint">Настроено UUID: {profiles.find(item => item.id === editor.id)?.mappingIds.join(', ') || '—'}</p>}
          {editor.id && <label className="check"><input type="checkbox" checked={!!editor.clearMappings} onChange={e => setEditor({ ...editor, clearMappings: e.target.checked })}/>Очистить ранее сохранённые подключения</label>}
          </details>}
        </form>
        <div className="actions form-submit"><button className="primary" type="submit" form="repository-profile-form">{editor.id ? 'Сохранить' : 'Создать'}</button></div>
      </>}
      {page === 'Репозитории' && <>
        {cloning && <section className="panel"><h2>Клонировать репозиторий</h2><div className="form-grid">
          <label className="wide">Локальный путь<input value={repoInput} onChange={e => setRepoInput(e.target.value)} placeholder="D:\repos\superset-config"/></label>
          <div className="actions wide"><button onClick={() => run('pickDirectory', undefined, 'Выбор каталога', value => { if (value) setRepoInput(value); })}>Выбрать папку</button></div>
          <label className="wide">HTTPS URL для клонирования<input value={remote} placeholder="https://devops.example.com/Collection/Project/_git/Repository" onChange={e => setRemote(e.target.value)}/></label>
        </div><div className="actions"><button disabled={!remote || !repoInput} onClick={() => run('clone', { url: remote, path: repoInput }, 'Клонирование', setOpened)}>Клонировать в указанный путь</button></div></section>}
        {repo && !cloning && <section className={fileWorkspace ? 'file-workspace-body' : 'panel'}>
          {fileWorkspace ? <WorkingTree key={repo + '\0' + git.branch} files={git.files}
            refresh={() => run('status', repo, 'Обновление рабочего дерева', updateGit)}
            readPatch={(path, staged, complete) => run('workingPatch', { repo, path, staged }, 'Чтение изменений', complete)}
            stage={(path, staged, complete) => run('stageFile', { repo, path, staged }, staged ? 'Удаление из индекса' : 'Добавление в индекс', result => {
              updateGit(result); complete();
            })}
            commit={(message, description, complete) => run('commitStaged', { repo, message, description }, 'Создание коммита', result => {
              updateGit(result); complete(); setMessage('Коммит создан.');
            })}/> : <>
          <h2>Рабочее дерево</h2>
          <p className="hint" title={repo}>{repo}</p>
          <p className="hint">{git.branch || 'Detached HEAD'} · {git.head || 'Коммитов пока нет'}</p>
          <pre className="readout">{git.status || 'Рабочее дерево чистое.'}</pre>
          <div className="actions"><button onClick={() => run('diff', repo, 'Чтение Git diff', setGitDiff)}>Показать Git diff</button></div>
          {gitDiff && <div className="diff-bodies"><details open><summary>Индекс</summary><pre>{gitDiff.staged || '—'}</pre></details>
            <details open><summary>Рабочее дерево</summary><pre>{gitDiff.unstaged || '—'}</pre></details></div>}
          </>}
        </section>}
      </>}
      {page === 'Экспорт' && <section className="panel">
        <h2>Выберите объекты для экспорта</h2>
        <div className="actions"><button disabled={!profile} onClick={() => run('inventory', profileId, 'Получение объектов Superset', value => { setAssets(value); setSelected([]); invalidate(); })}>Обновить список</button></div>
          <div className="asset-list">{selectableAssets.map(asset => <label className="check" key={asset.uuid}><input type="checkbox" checked={selected.includes(asset.uuid)} onChange={e => {
            setSelected(e.target.checked ? [...selected, asset.uuid] : selected.filter(id => id !== asset.uuid)); invalidate();
          }}/>{asset.name} <span className="hint">{labels[asset.kind]}</span></label>)}</div>
        <div className="actions"><button className="primary" disabled={!applicationReady || !git.branch || !selected.length}
          onClick={() => void executeExport()}>Экспорт</button></div>
      </section>}
      {page === 'Импорт' && <section className="panel"><h2>Выберите объекты для импорта</h2>
        <div className="actions"><button disabled={!profile} onClick={() => run('inventory', profileId, 'Получение объектов Superset', value => { setAssets(value); setSelected([]); })}>Обновить список</button></div>
        <div className="asset-list">{selectableAssets.map(asset => <label className="check" key={asset.uuid}><input type="checkbox" checked={selected.includes(asset.uuid)} onChange={e => setSelected(e.target.checked ? [...selected, asset.uuid] : selected.filter(id => id !== asset.uuid))}/>{asset.name} <span className="hint">{labels[asset.kind]}</span></label>)}</div>
        <div className="actions"><button className="primary" disabled={!applicationReady || !git.branch || !selected.length} onClick={() => void executeImport()}>Импорт</button></div>
      </section>}
      {operationLogPanel}
      </fieldset>
    </main>
    <footer className="statusbar">
      <span title={repo}>{repo ? repositoryName(repo) : 'Git-репозиторий не открыт'}</span>
      {git.branch && <span className="branch-status"><span className="branch-dot" aria-hidden="true"/>{git.branch}</span>}
      {git.head && <span className="mono" title={git.head}>{git.head.slice(0, 8)}</span>}
      {repo && <span className="tree-status">{git.status ? 'Есть изменения' : 'Рабочее дерево чистое'}</span>}
    </footer>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App/>);
