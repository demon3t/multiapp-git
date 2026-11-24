import React, { FormEvent, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Bridge, Change, Entry, ExportResult, GitState, ImportResult, ProfileInput, ProfileSummary, Requests, UpdateView } from './core/public';
import './ui.css';
import { UpdateDialog } from './update-dialog';
import { BranchList } from './branch-list';
import { GitHistory } from './git-history';

declare global { interface Window { mgit: Bridge } }
const pages = ['Приложения', 'Репозитории', 'Экспорт', 'Импорт', 'История Git', 'История операций', 'Настройки'] as const;
type Page = typeof pages[number];
const labels: Record<string, string> = { databases: 'Подключения', datasets: 'Датасеты', charts: 'Графики', dashboards: 'Дашборды', queries: 'SQL-запросы' };
const actionNames: Record<string, string> = { add: 'Добавление', update: 'Обновление', remove: 'Удаление' };
const repositoryName = (path: string) => path.split(/[\\/]/).at(-1);
const icons = ['M3 5h18v5H3z M3 14h18v5H3z M7 7.5h1 M7 16.5h1', 'M5 3h13v17H5z M5 16h13 M8 7h7 M8 10h5', 'M12 16V3 M7 8l5-5 5 5 M4 14v6h16v-6', 'M12 3v13 M7 11l5 5 5-5 M4 14v6h16v-6', 'M3 12a9 9 0 1 0 3-7 M3 4v5h5 M12 7v5l3 2', 'M12 8a4 4 0 1 0 0 8 4 4 0 1 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M19 5l-2 2 M7 17l-2 2'];
const operationIcons = {
  pull: 'M5 5h14 M5 5l4-4 M5 5l4 4 M19 19H5 M19 19l-4-4 M19 19l-4 4',
  fetch: 'M12 3v14 M7 13l5 5 5-5 M4 20h16',
  push: 'M12 21V7 M7 11l5-5 5 5 M4 3h16',
  export: 'M12 16V3 M7 8l5-5 5 5 M4 14v6h16v-6',
  import: 'M12 3v13 M7 11l5 5 5-5 M4 14v6h16v-6'
} as const;
function Icon({ index }: { index: number }) {
  return <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={icons[index]}/></svg>;
}
function OperationIcon({ name }: { name: keyof typeof operationIcons }) {
  return <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={operationIcons[name]}/></svg>;
}

const emptyProfile: ProfileInput = { name: '', url: '', type: '', repo: '', auth: 'db', username: '' };
const emptyGit: GitState = { branch: '', status: '', head: '', localBranches: [], remoteBranches: [], tags: [] };
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
function Exclusions({ items }: { items: ImportResult['excluded'] }) {
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
  const [openedRepos, setOpenedRepos] = useState<string[]>([]);
  const [repoInput, setRepoInput] = useState('');
  const [cloning, setCloning] = useState(false);
  const [remote, setRemote] = useState('');
  const [git, setGit] = useState(emptyGit);
  const [gitDiff, setGitDiff] = useState<{ staged: string; unstaged: string }>();
  const [newBranch, setNewBranch] = useState('');
  const [historyRef, setHistoryRef] = useState<string>();
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<{ message: string; details?: unknown }>();
  const [exportResult, setExportResult] = useState<ExportResult>();
  const [importResult, setImportResult] = useState<ImportResult>();
  const [commitMessage, setCommitMessage] = useState('');
  const [history, setHistory] = useState<Entry[]>([]);
  const [update, setUpdate] = useState<UpdateView>();
  const [updateMenu, setUpdateMenu] = useState(false);
  const [updateDialog, setUpdateDialog] = useState(false);
  const [repoMenu, setRepoMenu] = useState(false);
  const [appMenu, setAppMenu] = useState(false);
  const updateAvailable = Boolean(update?.latest && ['available', 'downloading', 'ready', 'installing'].includes(update.status));
  const profile = profiles.find(item => item.id === profileId);
  const applicationReady = Boolean(profile?.repo && profile.repo === repo);

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
    const unsubscribe = window.mgit.onUpdate(setUpdate);
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
  function invalidate() { setExportResult(undefined); setImportResult(undefined); setCommitMessage(''); }
  function chooseProfile(id: string) {
    setHistoryRef(undefined);
    if (id !== profileId) {
      setRepo(''); setRepoInput(''); setGit(emptyGit); setGitDiff(undefined);
    }
    setProfileId(id); invalidate();
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
        setRepo(''); setRepoInput(''); setGit(emptyGit); setGitDiff(undefined);
      }
      setProfiles(value); chooseProfile(saved.id); setEditor({ ...emptyProfile });
      navigate('Приложения'); setMessage('Приложение сохранено.');
    });
  }
  function setOpened(result: { repo: string; state: GitState }) {
    if (repo !== result.repo) setHistoryRef(undefined);
    const linkedProfile = profiles.find(item => item.repo === result.repo);
    if (linkedProfile && !profiles.some(item => item.id === profileId && item.repo === result.repo)) {
      setProfileId(linkedProfile.id);
    }
    setOpenedRepos(paths => paths.includes(result.repo) ? paths : [...paths, result.repo]);
    setCloning(false);
    setRepo(result.repo); setRepoInput(result.repo); setGit(result.state); setGitDiff(undefined); invalidate(); setMessage('Репозиторий открыт.');
  }
  function openDirectory(method: 'init' | 'open') {
    setRepoMenu(false);
    void run('pickDirectory', undefined, 'Выбор каталога Git', async path => {
      if (!path) return;
      await run(method, path, method === 'init' ? 'Инициализация репозитория' : 'Открытие репозитория', result => {
        navigate('История Git');
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
    navigate('История Git');
  }
  function checkoutRef(ref: string) {
    const remote = ref.startsWith('refs/remotes/');
    const branch = ref.slice(remote ? 'refs/remotes/'.length : 'refs/heads/'.length);
    if (!remote && git.branch === branch) return;
    void run('branch', { repo, branch, create: false, remote }, 'Переключение ветки', result => {
      updateGit(result);
      showGitHistory('refs/heads/' + result.branch);
      setMessage('Рабочая ветка: ' + result.branch);
    });
  }
  function exportSuperset() {
    navigate('Экспорт');
    invalidate();
    void run('exportSnapshot', { repo, profileId }, 'Экспорт и запись снимка', result => {
      setGit(result.state);
      setGitDiff(undefined);
      setExportResult(result);
      setMessage(result.changes.length ? 'Снимок записан в рабочее дерево.' : 'Снимок совпадает с текущим коммитом.');
    });
  }
  function importSuperset() {
    navigate('Импорт');
    invalidate();
    void run('importSnapshot', { repo, profileId }, 'Импорт и проверка Superset', result => {
      setGit(result.state);
      setGitDiff(undefined);
      setImportResult(result);
      setMessage(result.excluded.length ? 'Частичный снимок импортирован и проверен.' : 'Снимок импортирован и проверен.');
    });
  }

  function checkForUpdates() {
    setUpdateMenu(false);
    void run('checkUpdate', undefined, 'Проверка обновлений', result => {
      setUpdate(result);
      if (result.latest && ['available', 'downloading', 'ready'].includes(result.status)) {
        setUpdateDialog(true);
      } else if (result.status === 'current') {
        setMessage('У вас актуальная версия mGit.');
      } else if (result.status === 'no-release') {
        setMessage('В репозитории пока нет опубликованных релизов.');
      } else if (result.status === 'error') {
        setError({ message: result.message ?? 'Не удалось проверить обновления.' });
      }
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
      if (event.repeat || busy || updateDialog || command.disabled) return;
      setRepoMenu(false);
      setAppMenu(false);
      command.run();
    }
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  });

  const operationResult = page === 'Экспорт' ? exportResult : importResult;
  const contextPanel = <div className="context">
    <label>Superset<div className="readout" title={profile?.url}>{profile?.url || '—'}</div></label>
    <label>Репозиторий<div className="readout" title={repo}>{repo || '—'}</div></label>
    <label>Рабочая ветка<div className="readout">{operationResult?.branch ?? (git.branch || '—')}</div></label>
    {operationResult && <label>Каталог снимка<div className="readout" title={operationResult.folder}>{operationResult.folder}</div></label>}
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
          <p role="status">{update?.message ?? ({
            idle: 'Проверьте наличие новой версии на GitHub.', checking: 'Проверяем GitHub…',
            current: 'У вас актуальная версия.', available: 'Доступна версия ' + update?.latest + '.',
            downloading: 'Загрузка установщика · ' + (update?.progress ?? 0) + '%',
            ready: 'Обновление ' + update?.latest + ' готово к установке.', installing: 'Запускаем установщик…',
            'no-release': 'В репозитории пока нет опубликованных релизов.', error: 'Проверка не завершилась.'
          }[update?.status ?? 'idle'])}</p>
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
        {update?.askPermission && !updateMenu && <section className="updates-panel" aria-labelledby="update-permission">
          <h2 id="update-permission">Проверять обновления автоматически?</h2>
          <p>mGit сможет проверять новые версии ежедневно, пока приложение открыто.</p>
          <div className="actions">
            <button className="primary" disabled={!!busy} onClick={() => run('saveUpdateSettings', { automatic: true }, 'Сохранение настроек', setUpdate)}>Разрешить</button>
            <button disabled={!!busy} onClick={() => run('saveUpdateSettings', { automatic: false }, 'Сохранение настроек', setUpdate)}>Нет, спасибо</button>
          </div>
        </section>}
      </div>
    </div>
    {updateDialog && update && updateAvailable && <UpdateDialog key={update.latest} update={update} busy={!!busy} onClose={() => setUpdateDialog(false)}/>}
    <div className="toolbar">
      <div className="app-tabs" aria-label="Подключённые репозитории">
        {profiles.map(item => <button key={item.id} aria-pressed={item.id === profileId && applicationReady}
          disabled={!!busy} onClick={() => { selectApplication(item); navigate(item.repo ? 'История Git' : 'Приложения'); }}
          title={item.repo || item.url}><Icon index={0}/>{item.name}</button>)}
        {openedRepos.filter(path => !profiles.some(item => item.repo === path)).map(path =>
          <button key={path} aria-pressed={path === repo} disabled={!!busy} title={path}
            onClick={() => { setCloning(false); showGitHistory(); if (path !== repo) void run('open', path, 'Открытие репозитория', setOpened); }}>
            <Icon index={1}/>{repositoryName(path)}
          </button>)}
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
        <button className="operation" title="Экспортировать в рабочую ветку" aria-label="Export" disabled={!!busy || !git.branch} onClick={exportSuperset}><OperationIcon name="export"/><span>EXPORT</span></button>
        <button className="operation" title="Импортировать текущий коммит рабочей ветки" aria-label="Import" disabled={!!busy || !git.branch || !git.head} onClick={importSuperset}><OperationIcon name="import"/><span>IMPORT</span></button>
      </div>}
      {repo && <div className="branches" key={repo}>
        <div className="repo-views">
          <button aria-pressed={page === 'Репозитории' && !cloning} disabled={!!busy}
            onClick={() => { setCloning(false); navigate('Репозитории'); }}>Рабочее дерево</button>
          <button aria-pressed={page === 'История Git' && !historyRef} disabled={!!busy}
            onClick={() => showGitHistory()}>Все коммиты</button>
        </div>
        <BranchList label="Локальные ветки" names={git.localBranches} prefix="refs/heads/"
          expanded active={'refs/heads/' + git.branch} selected={page === 'История Git' ? historyRef : undefined}
          disabled={!!busy} onSelect={showGitHistory} onCheckout={checkoutRef}/>
        <BranchList label="Удалённые ветки" names={git.remoteBranches} prefix="refs/remotes/"
          selected={page === 'История Git' ? historyRef : undefined} disabled={!!busy} onSelect={showGitHistory} onCheckout={checkoutRef}/>
        {git.tags.length > 0 && <BranchList label="Теги" names={git.tags} prefix="refs/tags/"
          selected={page === 'История Git' ? historyRef : undefined} disabled={!!busy} onSelect={showGitHistory}/>}
      </div>}
    </aside>
    <main className={page === 'История Git' ? 'history-page' : undefined}>
      {page !== 'История Git' && <header><h1>{page}</h1></header>}
      {busy && <div role="status" className="notice progress"><progress/>{busy}…</div>}
      {error && <div role="alert" className="error"><strong>{error.message}</strong>{error.details != null && <pre>{JSON.stringify(error.details, null, 2)}</pre>}</div>}
      {message && <div role="status" className="notice success">{message}</div>}
      <fieldset disabled={Boolean(busy)}>
      {page === 'История Git' && (repo ? <GitHistory key={repo + '\0' + (historyRef ?? '')} repo={repo} ref={historyRef} revision={git}/>
        : <p className="empty">Откройте репозиторий, чтобы увидеть историю Git.</p>)}
      {page === 'Приложения' && <>
        <section className="panel">
          <div className="section-title"><h2>Подключённые приложения</h2><button className="primary" onClick={() => editApplication()}>Добавить приложение</button></div>
          {profiles.length === 0 ? <p className="empty">Добавьте приложение и выберите папку его Git-репозитория.</p> :
            <div className="profile-list">{profiles.map(item => <div className={'profile-row ' + (item.id === profileId ? 'selected' : '')} key={item.id}>
              <button className="profile-select" onClick={() => selectApplication(item)}><strong>{item.name}</strong><span>Apache Superset · {item.url}</span><span>{item.repo || 'Укажите папку Git'}</span></button>
              <button onClick={() => run('probe', item.id, 'Проверка стенда', data => setMessage(
                'Superset ' + (data.version || '· версия не определена') + '. Admin: ' + (data.admin === null ? 'роль не определена' : data.admin ? 'да' : 'нет') +
                '. API экспорта: ' + (data.export ? 'да' : 'нет') + '. API импорта: ' + (data.import ? 'да' : 'нет') + '.'
              ))}>Проверить</button>
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
            <label>Тип приложения<select value={editor.type} required onChange={e => setEditor({ ...editor, type: e.target.value })}>
              <option value="">Выберите тип</option><option value="superset">Apache Superset</option></select></label>
            <label>Папка Git<div className="path-input"><input value={editor.repo} required onChange={e => setEditor({ ...editor, repo: e.target.value })}/>
              <button type="button" onClick={() => run('pickDirectory', undefined, 'Выбор папки Git', value => { if (value) setEditor({ ...editor, repo: value }); })}>Выбрать</button></div></label>
            {editor.type === 'superset' && <>
            <label className="wide">URL Superset<input placeholder="https://superset.example.com" value={editor.url} required onChange={e => setEditor({ ...editor, url: e.target.value })}/></label>
            <label>Авторизация<select value={editor.auth} onChange={e => setEditor({ ...editor, auth: e.target.value as ProfileInput['auth'], credential: '' })}>
              <option value="db">Пользователь и пароль</option><option value="token">Токен доступа</option></select></label>
            {editor.auth === 'db' && <label>Пользователь<input value={editor.username ?? ''} required onChange={e => setEditor({ ...editor, username: e.target.value })}/></label>}
            <label>{editor.auth === 'db' ? 'Пароль' : 'Токен доступа'}<input autoComplete="new-password" type="password" required={!editor.id} value={editor.credential || ''} placeholder={editor.id ? 'Введите для замены' : ''}
              onChange={e => setEditor({ ...editor, credential: e.target.value })}/></label>
            </>}
          </div>
          {editor.id && <details className="advanced"><summary>Дополнительные параметры Superset</summary>
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
        {repo && <section className="panel"><h2>Рабочее дерево</h2>
          <p className="hint" title={repo}>{repo}</p>
          <p className="hint">{git.branch || 'Detached HEAD'} · {git.head || 'Коммитов пока нет'}</p>
          <pre className="readout">{git.status || 'Рабочее дерево чистое.'}</pre>
          <div className="actions"><button onClick={() => run('diff', repo, 'Чтение Git diff', setGitDiff)}>Показать Git diff</button></div>
          {gitDiff && <div className="diff-bodies"><details open><summary>Индекс</summary><pre>{gitDiff.staged || '—'}</pre></details>
            <details open><summary>Рабочее дерево</summary><pre>{gitDiff.unstaged || '—'}</pre></details></div>}
          <div className="actions"><input aria-label="Имя ветки" value={newBranch} onChange={e => setNewBranch(e.target.value)} list="branches" placeholder="Имя локальной ветки"/>
            <datalist id="branches">{git.localBranches.map(branch => <option key={branch} value={branch}/>)}</datalist>
            <button disabled={!newBranch} onClick={() => run('branch', { repo, branch: newBranch, create: false }, 'Переключение ветки', updateGit)}>Переключить</button>
            <button disabled={!newBranch} onClick={() => run('branch', { repo, branch: newBranch, create: true }, 'Создание ветки', updateGit)}>Создать и переключить</button></div>
        </section>}
      </>}
      {page === 'Экспорт' && <>{contextPanel}
        {exportResult && <section className="panel"><h2>Изменения снимка</h2><Counts values={exportResult.counts}/>
          <p className="hint">Файлов с изменениями: {exportResult.changes.length}.</p>
          {exportResult.issues.length > 0 && <details className="notice"><summary>Неполные зависимости: {exportResult.issues.length}</summary>
            <div className="asset-list">{exportResult.issues.map((issue, i) => <p key={i}>{issue.path} · {issue.message}</p>)}</div>
          </details>}
          <Changes key={exportResult.id} changes={exportResult.changes}/>
          {exportResult.changes.length > 0 && <div className="actions"><input aria-label="Сообщение коммита" value={commitMessage}
            onChange={e => setCommitMessage(e.target.value)} placeholder="Сообщение коммита"/>
            <button disabled={!commitMessage.trim()} onClick={() => run('commit', { id: exportResult.id, message: commitMessage }, 'Создание коммита', result => {
              updateGit(result); setMessage('Коммит создан: ' + result.head);
            })}>Создать коммит</button></div>}
        </section>}
      </>}
      {page === 'Импорт' && <>{contextPanel}
        {importResult && <section className="panel"><h2>Результат импорта</h2>
          <p className="hint mono">{importResult.sha}</p>
          <Counts values={importResult.counts}/>
          <Exclusions items={importResult.excluded}/>
          <p>Проверены UUID и связи {importResult.checked} объектов.</p>
          <p className="hint">Резервная копия · <span className="mono">{importResult.backupPath}</span></p>
        </section>}
      </>}
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
