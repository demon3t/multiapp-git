import React, { useState } from 'react';
import type { WorkingFile } from './core/public';

type Props = {
  files: WorkingFile[];
  refresh: () => void;
  readPatch: (path: string, staged: boolean, complete: (patch: string) => void) => void;
  stage: (path: string, staged: boolean, complete: () => void) => void;
  commit: (message: string, complete: () => void) => void;
};

export function WorkingTree({ files, refresh, readPatch, stage, commit }: Props) {
  const [selection, setSelection] = useState<{ path: string; staged: boolean; patch: string }>();
  const [message, setMessage] = useState('');
  const index = files.filter(file => file.index !== ' ' && file.index !== '?');
  const unstaged = files.filter(file => file.worktree !== ' ');
  const showFiles = (items: WorkingFile[], staged: boolean) => <section className="working-file-group">
    <h3>{staged ? 'В индексе' : 'Изменённые файлы'} <span className="hint">{items.length}</span></h3>
    {items.length === 0 ? <p className="hint">Нет файлов.</p> : <ul>
      {items.map(file => <li key={file.path}>
        <button className="working-file-name" type="button" title={file.path}
          aria-pressed={selection?.path === file.path && selection.staged === staged}
          onClick={() => readPatch(file.path, staged, patch => setSelection({ path: file.path, staged, patch }))}>
          <span className="mono">{staged ? file.index : file.worktree}</span>
          <span>{file.previousPath ? file.previousPath + ' → ' + file.path : file.path}</span>
        </button>
        <button type="button" onClick={() => stage(file.path, staged, () => setSelection(undefined))}>
          {staged ? 'Убрать из индекса' : 'В индекс'}
        </button>
      </li>)}
    </ul>}
  </section>;

  return <div className="working-files">
    <div className="actions"><button type="button" onClick={() => { setSelection(undefined); refresh(); }}>Обновить список</button></div>
    <div className="working-file-groups">{showFiles(unstaged, false)}{showFiles(index, true)}</div>
    {selection && <section className="working-file-patch">
      <h3 className="mono">{selection.path}</h3>
      <pre>{selection.patch ? selection.patch.split('\n').map((line, i) => <span key={i}
        className={line.startsWith('+') ? 'patch-added' : line.startsWith('-') ? 'patch-removed' : undefined}>{line}{'\n'}</span>)
        : 'Нет текстовых изменений.'}</pre>
    </section>}
    <form className="actions" onSubmit={event => {
      event.preventDefault();
      if (index.length && message.trim()) commit(message, () => { setMessage(''); setSelection(undefined); });
    }}>
      <input aria-label="Сообщение коммита" placeholder="Сообщение коммита" value={message} onChange={event => setMessage(event.target.value)}/>
      <button className="primary" disabled={!index.length || !message.trim()}>Создать коммит</button>
    </form>
  </div>;
}
