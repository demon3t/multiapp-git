import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { GitCommit, GitState, Requests } from './core/public';
import { GraphCell, layoutGraph } from './commit-graph';
import type { CommitMenuTarget } from './commit-menu';

const dateFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
const refName = (ref: string) => ref.replace(/^(?:HEAD -> |tag: )?refs\/(?:heads|remotes|tags)\//, '');
const formatDate = (date: string) => date ? dateFormat.format(new Date(date)) : '—';

export function GitHistory({ repo, ref, revision, onMenu }: {
  repo: string; ref?: string; revision: GitState; onMenu: (target: CommitMenuTarget) => void;
}) {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [selected, setSelected] = useState('');
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const request = useRef(0);
  const graph = useMemo(() => layoutGraph(commits), [commits]);
  const commit = commits.find(item => item.sha === selected) ?? commits[0];

  async function load(offset: number) {
    const id = ++request.current;
    setLoading(true);
    setError('');
    try {
      const result = await window.mgit.call('gitLog', { repo, ref, offset });
      if (id !== request.current) return;
      if (result.ok) {
        setCommits(previous => offset ? [...previous, ...result.data.commits] : result.data.commits);
        setMore(result.data.more);
      } else setError(result.message);
    } catch {
      if (id === request.current) setError('Не удалось загрузить историю Git.');
    } finally {
      if (id === request.current) setLoading(false);
    }
  }

  useEffect(() => {
    void load(0);
    return () => { request.current++; };
  }, [repo, ref, revision]);

  return <div className="git-history">
    <div className="git-history-heading"><h1>{ref ? refName(ref) : 'Все коммиты'}</h1></div>
    <div className="commit-list" aria-label="Граф истории Git">
      <div className="commit-table-head commit-grid" style={{ minWidth: graph.width + 470 }}>
        <span style={{ width: graph.width }}>Граф</span><span>Сообщение</span><span>Автор</span><span>SHA</span><span>Дата</span>
      </div>
      {commits.map((item, index) => <button type="button" className="commit-row commit-grid" aria-pressed={item.sha === commit?.sha}
        key={item.sha} style={{ minWidth: graph.width + 470 }} aria-haspopup="menu" onClick={() => setSelected(item.sha)}
        onContextMenu={event => {
          event.preventDefault();
          setSelected(item.sha);
          onMenu({ commit: item, anchor: event.currentTarget, point: { x: event.clientX, y: event.clientY } });
        }}
        onKeyDown={event => {
          if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
          event.preventDefault(); event.stopPropagation(); setSelected(item.sha);
          onMenu({ commit: item, anchor: event.currentTarget });
        }}>
        <GraphCell row={graph.rows[index]} width={graph.width}/>
        <span className="commit-subject" title={item.subject}>
          {item.refs.map(name => <span key={name} title={name} className={'commit-ref' +
            (name.startsWith('HEAD') ? ' commit-ref-head' : name.startsWith('tag: ') ? ' commit-ref-tag' : '')}>{refName(name)}</span>)}
          <span className="commit-title">{item.subject || 'Без сообщения'}</span>
        </span>
        <span className="commit-author" title={item.author}>{item.author}</span>
        <span className="mono" title={item.sha}>{item.sha.slice(0, 8)}</span>
        <span className="commit-date">{formatDate(item.date)}</span>
      </button>)}
      {error && <p className="history-feedback" role="alert">{error}</p>}
      {loading && <p className="history-feedback" role="status">Загрузка коммитов…</p>}
      {!loading && !error && !commits.length && <p className="history-feedback">В репозитории пока нет коммитов.</p>}
      {more && !loading && <button className="history-more" onClick={() => void load(commits.length)}>Загрузить ещё</button>}
    </div>
    {commit && <CommitDetails key={commit.sha} repo={repo} commit={commit}/>}
  </div>;
}

function CommitDetails({ repo, commit }: { repo: string; commit: GitCommit }) {
  const [details, setDetails] = useState<Requests['commitFiles'][1]>();
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'info' | 'changes'>('changes');
  const [fileIndex, setFileIndex] = useState(0);
  const file = details?.files[fileIndex];
  useEffect(() => {
    let active = true;
    void window.mgit.call('commitFiles', { repo, sha: commit.sha }).then(result => {
      if (!active) return;
      if (result.ok) setDetails(result.data);
      else setError(result.message);
    }).catch(() => { if (active) setError('Не удалось прочитать коммит.'); });
    return () => { active = false; };
  }, [repo, commit.sha]);

  return <section className="commit-details" aria-label="Выбранный коммит">
    <div className="commit-tabs">
      <button aria-pressed={tab === 'info'} onClick={() => setTab('info')}>Коммит</button>
      <button aria-pressed={tab === 'changes'} onClick={() => setTab('changes')}>Изменения{details ? ' · ' + details.files.length : ''}</button>
      <span className="mono">{commit.sha.slice(0, 8)}</span>
    </div>
    {error && <p className="history-feedback" role="alert">{error}</p>}
    {tab === 'info' && <div className="commit-info">
      <dl><dt>Автор</dt><dd>{commit.author}</dd><dt>Дата</dt><dd>{formatDate(commit.date)}</dd>
        <dt>SHA</dt><dd className="mono">{commit.sha}</dd>
        {commit.parents.length > 0 && <><dt>Родители</dt><dd className="mono">{commit.parents.join(' · ')}</dd></>}
      </dl>
      <pre>{details?.message ?? commit.subject}</pre>
    </div>}
    {tab === 'changes' && !error && (details?.files.length ? <div className="commit-changes">
      <div className="commit-files" aria-label="Изменённые файлы">
        {details.files.map((item, index) => <button key={item.path} aria-pressed={fileIndex === index}
          title={item.previousPath ? item.previousPath + ' → ' + item.path : item.path} onClick={() => setFileIndex(index)}>
          <span className={'file-status file-status-' + item.status[0]}>{item.status[0]}</span><span>{item.path}</span>
        </button>)}
      </div>
      {file && <CommitPatch key={file.path} repo={repo} sha={commit.sha} paths={file.previousPath ? [file.previousPath, file.path] : [file.path]}
        name={file.previousPath ? file.previousPath + ' → ' + file.path : file.path} merge={commit.parents.length > 1}/>}
    </div> : <p className="history-feedback">{details ? 'Файлы в этом коммите не изменились.' : 'Загрузка списка файлов…'}</p>)}
  </section>;
}

function CommitPatch({ repo, sha, paths, name, merge }: { repo: string; sha: string; paths: string[]; name: string; merge: boolean }) {
  const [patch, setPatch] = useState<string>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void window.mgit.call('commitPatch', { repo, sha, paths }).then(result => {
      if (!active) return;
      if (result.ok) setPatch(result.data);
      else setError(result.message);
    }).catch(() => { if (active) setError('Не удалось прочитать изменения файла.'); });
    return () => { active = false; };
  }, []);
  const maxPreviewLength = 250_000;
  const preview = patch?.slice(0, maxPreviewLength);
  return <div className="commit-patch">
    <div className="patch-heading"><span title={name}>{name}</span>{merge && <small>Относительно первого родителя</small>}</div>
    {preview ? <pre tabIndex={0}>{preview.trimEnd().split('\n').map((line, index) =>
      <span key={index} className={line.startsWith('@@') ? 'patch-hunk' :
        line.startsWith('+') && !line.startsWith('+++ ') ? 'patch-added' :
        line.startsWith('-') && !line.startsWith('--- ') ? 'patch-removed' : undefined}>{line || ' '}</span>)}
      {patch && patch.length > maxPreviewLength && '… Показано начало diff.\n'}</pre>
      : <p className="history-feedback">{error || (patch === '' ? 'Нет текстовых изменений.' : 'Загрузка diff…')}</p>}
  </div>;
}
