import React, { FormEvent, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AssetSummary, Bridge, Change, Entry, GitState, OpenedRepo, Plan, Preview, ProfileInput, ProfileSummary, Requests, UpdateView } from './core/public';
import './ui.css';
import { UpdateDialog } from './update-dialog';
import { UpdateNotification } from './update-notification';
import { BranchList } from './branch-list';
import { BranchDialog, BranchMenu, type BranchCommand, type BranchMenuTarget, type EditAction } from './branch-menu';
import type { BranchAction } from './core/public';
import { GitHistory } from './git-history';
import { WorkingTree } from './working-tree';
import { RepositoryIcon, TabAppearanceDialog } from './tab-appearance';

declare global { interface Window { mgit: Bridge } }
const pages = ['Приложения', 'Репозитории', 'Экспорт', 'Импорт', 'История Git', 'История операций', 'Настройки'] as const;
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

const emptyProfile: ProfileInput = { name: '', url: '', type: '', repo: '', auth: 'db', username: '' };
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
  const [editor, setEditor] = useState<ProfileInput>({ ...emptyProfile });
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
  const [history, setHistory] = useState<Entry[]>([]);
  const [update, setUpdate] = useState<UpdateView>();
  const [dismissedUpdate, setDismissedUpdate] = useState('');
  const [updateError, setUpdateError] = useState('');
  const [updateMenu, setUpdateMenu] = useState(false);
  const [updateDialog, setUpdateDialog] = useState(false);
  const [repoMenu, setRepoMenu] = useState(false);
  const [appMenu, setAppMenu] = useState(false);
  const [appearanceTab, setAppearanceTab] = useState<ProfileSummary>();
  const [branchMenu, setBranchMenu] = useState<BranchMenuTarget>();
  const [branchDialog, setBranchDialog] = useState<{ ref: string; action: EditAction; current: string; head: string }>();
  const updateAvailable = Boolean(update?.latest && ['available', 'downloading', 'ready', 'installing'].includes(update.status));
  const profile = profiles.find(item => item.id === profileId);
  const folderRef = page === 'Импорт' ? ref : 'HEAD';
  const paths = snapshotFolders?.repo === repo && snapshotFolders.ref === folderRef && snapshotFolders.head === git.head ? snapshotFolders.paths : [];
  const folder = folderInput ?? (paths.length === 1 ? paths[0] : defaultFolder);
  const context = { repo, folder, profileId };
  const applicationReady = Boolean(profile?.repo && profile.repo === repo);

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
    try {
      const result = await window.mgit.call(method, input);
      if (result.ok) await complete?.(result.data);
      else setError({ message: result.message, details: result.details });
    } catch { setError({ message: 'Связь с процессом mGit прервалась.' }); }
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
    if (!updateMenu) return;
    function close(event: PointerEvent | KeyboardEvent) {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : event.target instanceof Element && !event.target.closest('.updates-menu, .app-menu')) setUpdateMenu(false);
    }
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', close); };
  }, [updateMenu]);
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
    if (next === 'История операций') void run('history', undefined, 'Загрузка журнала', setHistory);
  }
  function editApplication(application?: ProfileSummary) {
    setEditor(application ? { ...application } : { ...emptyProfile });
    navigate('Настройки');
  }
  function saveProfile(event: FormEvent) {
    event.preventDefault();
    void run('save', editor, 'Сохранение профиля', value => {
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
    setHistoryRef(value);
    if (value) { setRef(value); invalidate(); }
    navigate('История Git');
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
        showGitHistory('refs/heads/' + result.branch);
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
  function statusResult(result: { verified: boolean; checked: number; issues: unknown[] }) {
    if (result.verified) setMessage('На цели подтверждены UUID и связи. Проверено объектов: ' + result.checked + '.');
    else setError({ message: 'На цели есть расхождения.', details: result.issues });
  }

  function checkForUpdates() {
    setUpdateMenu(false);
    setDismissedUpdate('');
    setUpdateError('');
    setUpdate(previous => previous && { ...previous, status: 'checking', message: undefined });
    void window.mgit.call('checkUpdate', undefined).then(result => {
      if (!result.ok) {
        setUpdate(previous => previous && { ...previous, status: 'error', message: result.message });
        return;
      }
      setUpdate(result.data);
      if (result.data.latest && ['available', 'downloading', 'ready'].includes(result.data.status)) setUpdateDialog(true);
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
    history: { label: 'История операций', shortcut: 'Ctrl+H', code: 'KeyH', ctrl: true,
      run: () => { setAppMenu(false); navigate('История операций'); } },
    settings: { label: 'Настройки', shortcut: 'Ctrl+,', code: 'Comma', ctrl: true,
      run: () => { setAppMenu(false); editApplication(profile); } },
    checkUpdate: { label: 'Проверить сейчас', shortcut: 'Ctrl+Shift+U', code: 'KeyU', ctrl: true, shift: true,
      disabled: update?.status === 'checking',
      run: checkForUpdates },
    updateNotes: { label: 'Что нового', shortcut: 'Shift+F1', code: 'F1', shift: true, disabled: !updateAvailable,
      run: () => { setUpdateMenu(false); setUpdateDialog(true); } },
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
      if (event.repeat || busy || updateDialog || appearanceTab || branchDialog || branchMenu || command.disabled) return;
      setRepoMenu(false);
      setAppMenu(false);
      command.run();
    }
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  });

  const contextPanel = <div className="context">
    <label>Superset<div className="readout" title={profile?.url}>{profile?.url || 'Выберите приложение'}</div></label>
    <label>Репозиторий<div className="readout" title={repo}>{repo || 'Откройте репозиторий'}</div></label>
    <label>{page === 'Импорт' ? 'Ветка, тег или коммит' : 'Текущая ветка'}
      {page === 'Импорт' ? <input value={ref} list="refs" onChange={e => { setRef(e.target.value); invalidate(); }}/> : <div className="readout">{git.branch || '—'}</div>}</label>
    <label>Каталог снимка<input value={folder} list="snapshot-folders" onChange={e => { setFolderInput(e.target.value); invalidate(); }}/></label>
    <datalist id="refs">{[...new Set([...git.localBranches, ...git.remoteBranches, ...git.tags])].map(name => <option key={name} value={name}/>)}</datalist>
    <datalist id="snapshot-folders">{paths.map(path => <option key={path} value={path}/>)}</datalist>
  </div>;

  const fileWorkspace = page === 'Репозитории' && !cloning && Boolean(repo) && profile?.type === 'git';
  const askUpdatePermission = update?.askPermission && !updateMenu && !showUpdateDialog && !updateNotification;
  const notifications = (busy || error || message || updateNotification || askUpdatePermission) && <div className="operation-toasts">
    {busy && <div role="status" className="notice progress"><progress aria-label={busy}/>{busy}…</div>}
    {error && <div className="error operation-toast-result">
      <div role="alert"><strong>{error.message}</strong>{error.details != null && <pre>{JSON.stringify(error.details, null, 2)}</pre>}</div>
      <button type="button" aria-label="Закрыть уведомление" title="Закрыть" onClick={() => setError(undefined)}>×</button>
    </div>}
    {message && <div className="notice success operation-toast-result">
      <div role="status">{message}</div>
      <button type="button" aria-label="Закрыть уведомление" title="Закрыть" onClick={() => setMessage('')}>×</button>
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
        <button className="repo-menu-trigger" disabled={!!busy} aria-expanded={appMenu} onClick={() => { setRepoMenu(false); setAppMenu(!appMenu); }}>Приложение</button>
        {appMenu && <div className="repo-menu-panel app-menu-panel">
          <CommandButton command={commands.history}/>
          <div className="menu-separator" role="separator"/>
          <CommandButton command={commands.settings}/>
          <button className="menu-command" type="button" onClick={() => { setAppMenu(false); setUpdateMenu(true); }}>Настройки обновлений</button>
        </div>}
      </div>
      <div className="title-drag"/>
      <div className="updates-menu">
        <button className={'updates-toggle update-icon-button' + (updateAvailable ? ' update-available' : '')}
          aria-label="Проверить обновления" title="Проверить обновления (Ctrl+Shift+U)" aria-haspopup="dialog"
          disabled={!!busy || update?.status === 'checking' || update?.status === 'installing'}
          onClick={checkForUpdates}>
          <span className="update-icon" aria-hidden="true">↻</span>
        </button>
        {updateMenu && <section className="updates-panel" aria-label="Обновления mGit">
          <h2>mGit {update?.current}</h2>
          <div className="update-commands">
            <CommandButton command={{ ...commands.checkUpdate, disabled: !!busy || commands.checkUpdate.disabled }}/>
            {updateAvailable && <CommandButton command={commands.updateNotes}/>}
            <CommandButton command={{ ...commands.releases, disabled: !!busy }}/>
          </div>
          <label className="check"><input type="checkbox" checked={update?.automatic === true} disabled={!!busy} onChange={e =>
            run('saveUpdateSettings', { automatic: e.target.checked }, 'Сохранение настроек', setUpdate)}/>Проверять автоматически</label>
          <label className="check"><input type="checkbox" checked={update?.automatic === true && update?.autoInstall === true}
            disabled={!!busy || update?.automatic !== true} onChange={e =>
              run('saveUpdateSettings', { automatic: true, autoInstall: e.target.checked }, 'Сохранение настроек', setUpdate)}/>Скачивать и устанавливать при выходе</label>
        </section>}
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
          expanded active={'refs/heads/' + git.branch} disabled={!!busy} onSelect={showGitHistory}
          onMenu={openBranchMenu} onSwitch={ref => changeSelectedBranch({ ref, action: 'switch' })}/>
        <BranchList label="Удалённые ветки" names={git.remoteBranches} prefix="refs/remotes/"
          disabled={!!busy} onSelect={showGitHistory} onMenu={openBranchMenu}
          onSwitch={ref => changeSelectedBranch({ ref, action: 'switch' })}/>
        {git.tags.length > 0 && <BranchList label="Теги" names={git.tags} prefix="refs/tags/"
          active={page === 'История Git' ? historyRef : undefined} disabled={!!busy} onSelect={showGitHistory}/>}
      </div>}
    </aside>
    {branchMenu && <BranchMenu target={branchMenu} current={git.branch} head={git.head} onClose={() => setBranchMenu(undefined)} onCommand={chooseBranchCommand}/>}
    {branchDialog && <BranchDialog refName={branchDialog.ref} action={branchDialog.action} current={branchDialog.current} head={branchDialog.head}
      onClose={() => setBranchDialog(undefined)} onSubmit={changeSelectedBranch}/>}
    {!showUpdateDialog && notifications}
    <main className={page === 'История Git' ? 'history-page' : fileWorkspace ? 'file-workspace' : undefined}>
      {page !== 'История Git' && !fileWorkspace && <header><h1>{page}</h1></header>}
      <fieldset disabled={Boolean(busy)}>
      {page === 'История Git' && (repo ? <GitHistory key={repo + '\0' + (historyRef ?? '')} repo={repo} ref={historyRef} revision={git}/>
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
      {page === 'Настройки' && <section className="panel">
        <div className="section-title"><h2>{editor.id ? 'Редактирование приложения' : 'Добавление приложения'}</h2>
          {profiles.length > 0 && <select aria-label="Редактируемое приложение" value={editor.id || ''} onChange={e => setEditor(profiles.find(item => item.id === e.target.value) ?? { ...emptyProfile })}>
            <option value="">Добавить приложение</option>{profiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}</div>
        <form onSubmit={saveProfile}>
          <div className="form-grid">
            <label>Тип приложения<select value={editor.type} required disabled={Boolean(editor.id)} onChange={e => setEditor({ ...editor, type: e.target.value })}>
              <option value="">Выберите тип</option><option value="git">Git-репозиторий</option><option value="superset">Apache Superset</option></select></label>
            <label>Папка Git<div className="path-input"><input value={editor.repo} required onChange={e => setEditor({ ...editor, repo: e.target.value })}/>
              <button type="button" onClick={() => run('pickDirectory', undefined, 'Выбор папки Git', value => { if (value) setEditor({ ...editor, repo: value }); })}>Выбрать</button></div></label>
            {editor.type === 'git' && <label className="wide">Название вкладки<input value={editor.name}
              placeholder="Имя папки" onChange={e => setEditor({ ...editor, name: e.target.value })}/></label>}
            {editor.type === 'superset' && <>
            <label className="wide">URL Superset<input placeholder="https://superset.example.com" value={editor.url} required onChange={e => setEditor({ ...editor, url: e.target.value })}/></label>
            <label>Авторизация<select value={editor.auth} onChange={e => setEditor({ ...editor, auth: e.target.value as ProfileInput['auth'], credential: '' })}>
              <option value="db">Пользователь и пароль</option><option value="token">Токен доступа</option></select></label>
            {editor.auth === 'db' && <label>Пользователь<input value={editor.username ?? ''} required onChange={e => setEditor({ ...editor, username: e.target.value })}/></label>}
            <label>{editor.auth === 'db' ? 'Пароль' : 'Токен доступа'}<input autoComplete="new-password" type="password" required={!editor.id} value={editor.credential || ''} placeholder={editor.id ? 'Введите для замены' : ''}
              onChange={e => setEditor({ ...editor, credential: e.target.value })}/></label>
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
          <div className="actions"><button className="primary" type="submit">Сохранить приложение</button></div>
        </form>
      </section>}
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
      {page === 'Экспорт' && <>{contextPanel}<section className="panel">
        <h2>Состав снимка</h2>
        <label className="check"><input type="checkbox" checked={partial} onChange={e => { setPartial(e.target.checked); invalidate(); }}/>Выбор объектов с зависимостями</label>
        {partial && <><div className="actions"><button disabled={!profile} onClick={() => run('inventory', profileId, 'Получение объектов Superset', value => { setAssets(value); setSelected([]); invalidate(); })}>Загрузить список объектов</button></div>
          <div className="asset-list">{assets.map(asset => <label className="check" key={asset.uuid}><input type="checkbox" checked={selected.includes(asset.uuid)} onChange={e => {
            setSelected(e.target.checked ? [...selected, asset.uuid] : selected.filter(id => id !== asset.uuid)); invalidate();
          }}/>{asset.name} <span className="hint">{labels[asset.kind]}</span></label>)}</div></>}
        <div className="actions"><button className="primary" disabled={!applicationReady || !git.branch || (partial && !selected.length)}
          onClick={() => { invalidate(); void run('exportPreview', { ...context, selected: partial ? selected : [] }, 'Экспорт и проверка YAML', setPreview); }}>Подготовить экспорт</button></div>
      </section>
      {preview && <section className="panel"><h2>Изменения снимка</h2><Counts values={preview.counts}/>
        <p className="hint">Файлов с изменениями: {preview.changes.length}.</p>
        {preview.issues.length > 0 && <details className="notice"><summary>Неполные зависимости: {preview.issues.length}</summary>
          <div className="asset-list">{preview.issues.map((issue, i) => <p key={i}>{issue.path} · {issue.message}</p>)}</div>
        </details>}
        <Changes key={preview.id} changes={preview.changes}/>
        <div className="actions"><button className="primary" disabled={written || !preview.changes.length}
          onClick={() => run('write', preview.id, 'Запись снимка', state => { setGit(state); setWritten(true); setMessage('Снимок записан.'); })}>Записать снимок</button></div>
        {written && <div className="actions"><input aria-label="Сообщение коммита" value={commitMessage} onChange={e => setCommitMessage(e.target.value)} placeholder="Сообщение коммита"/>
          <button disabled={!commitMessage.trim()} onClick={() => run('commit', { id: preview.id, message: commitMessage }, 'Создание коммита', result => {
            updateGit(result); setRef(result.head); setCommitMessage(''); setMessage('Коммит создан: ' + result.head);
          })}>Создать коммит</button></div>}
      </section>}</>}
      {page === 'Импорт' && <>{contextPanel}<section className="panel"><h2>Предварительная проверка</h2>
        <label className="check"><input type="checkbox" checked={only} onChange={e => { setOnly(e.target.checked); invalidate(); }}/>Только метаданные · локальная проверка</label>
        <label className="check"><input type="checkbox" checked={compatibleOnly} onChange={e => { setCompatibleOnly(e.target.checked); invalidate(); }}/>Частичный снимок · исключить объекты с ошибками и зависящие от них объекты</label>
        <div className="actions"><button disabled={!repo || !ref.trim()} className={only ? 'primary' : ''}
          onClick={() => run('validate', { repo, ref, folder, compatibleOnly }, 'Локальная проверка', result => { setValidation(result); setMessage(result.excluded.length ? 'Совместимая часть прошла локальную проверку.' : 'Снимок прошёл локальную проверку.'); })}>Проверить снимок</button>
          {!only && <><button className="primary" disabled={!applicationReady || !ref.trim()} onClick={() => {
            setPlan(undefined); setConfirm(''); void run('plan', { ...context, ref, compatibleOnly }, 'Подготовка плана импорта', setPlan);
          }}>Построить план</button><button disabled={!applicationReady || !ref.trim()} onClick={() => run('verify', { ...context, ref, compatibleOnly }, 'Проверка цели', statusResult)}>Проверить UUID и связи на цели</button></>}
        </div>
        {validation && <><p className="hint mono">{validation.sha}</p><Counts values={validation.counts}/><Exclusions items={validation.excluded}/></>}
      </section>
      {plan && !only && <section className="panel"><h2>План импорта</h2>
        <p className="hint">{plan.url} · Superset {plan.version}</p><p className="hint mono">{plan.sha}</p>
        <Counts values={plan.counts}/>
        <Exclusions items={plan.excluded}/>
        <div className="asset-list">{plan.assets.map(asset => <div className="plan-row" key={asset.uuid}><span>{asset.name}</span><span className={'tag ' + asset.action}>{actionNames[asset.action ?? '']}</span><span className="hint">{labels[asset.kind]}</span></div>)}</div>
        <p className="hint">При применении Superset может обращаться к аналитическим подключениям целевого окружения.</p>
        <label className="check"><input type="checkbox" checked={backup} onChange={e => setBackup(e.target.checked)}/>Сохранить резервный экспорт метаданных</label>
        {profile && <label>Введите название приложения и полный SHA через пробел<input placeholder={profile.name + ' ' + plan.sha} value={confirm} onChange={e => setConfirm(e.target.value)}/></label>}
        <div className="actions"><button className="primary"
          disabled={!profile || confirm !== profile.name + ' ' + plan.sha}
          onClick={() => run('apply', { id: plan.id, confirm, backup }, 'Импорт и проверка Superset', result => { setPlan(undefined); statusResult(result); })}>Применить коммит</button></div>
      </section>}</>}
      {page === 'История операций' && <section className="panel">
        {history.length === 0 ? <p className="empty">Операций пока нет.</p> : <table><thead><tr><th>Время</th><th>Действие</th><th>Статус</th></tr></thead>
          <tbody>{history.map((entry, index) => <tr key={entry.time + index}><td>{new Date(entry.time).toLocaleString('ru-RU')}</td><td>{entry.action}</td>
            <td><span className={'tag ' + (entry.status === 'ok' ? 'add' : 'remove')}>{entry.status === 'ok' ? 'Готово' : 'Ошибка'}</span> {entry.message}</td></tr>)}</tbody></table>}
      </section>}
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
