import React, { useState } from 'react';
import type { WorkingFile } from './core/public';

type Props = {
  files: WorkingFile[];
  refresh: () => void;
  readPatch: (path: string, staged: boolean, complete: (patch: string) => void) => void;
  stage: (path: string, staged: boolean, complete: () => void) => void;
  commit: (message: string, complete: () => void) => void;
};

type Folder = { folders: Map<string, Folder>; files: WorkingFile[] };
const newFolder = (): Folder => ({ folders: new Map(), files: [] });
const inIndex = (file: WorkingFile) => file.index !== ' ' && file.index !== '?';
const inWorktree = (file: WorkingFile) => file.worktree !== ' ';

function fileTree(files: WorkingFile[]) {
  const root = newFolder();
  for (const file of files) {
    let folder = root;
    for (const name of file.path.split('/').slice(0, -1)) {
      let child = folder.folders.get(name);
      if (!child) {
        child = newFolder();
        folder.folders.set(name, child);
      }
      folder = child;
    }
    folder.files.push(file);
  }
  return root;
}

function FileNodes({ folder, selected, onSelect }: {
  folder: Folder; selected?: string; onSelect: (file: WorkingFile) => void;
}) {
  return <ul>{[...folder.folders].map(([name, child]) => <li key={'folder:' + name}>
    <details open><summary>{name}</summary><FileNodes folder={child} selected={selected} onSelect={onSelect}/></details>
  </li>)}
  {folder.files.map(file => <li key={file.path}>
    <button className="working-file-name" type="button" title={file.previousPath ? file.previousPath + ' → ' + file.path : file.path}
      aria-pressed={selected === file.path} onClick={() => onSelect(file)}>
      <span className="mono file-status" aria-hidden="true">{(file.index + file.worktree).trim()}</span>
      <span>{file.path.split('/').at(-1)}</span>
      {inIndex(file) && <span className="working-index-mark" title="Добавлено в индекс" aria-label="Добавлено в индекс">✓</span>}
    </button>
  </li>)}</ul>;
}

type DiffLine = { number: number; text: string; tone?: 'added' | 'removed'; noNewline?: boolean };
type DiffRow = { before?: DiffLine; after?: DiffLine; heading?: string };

function splitDiff(lines: string[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let before = 0;
  let after = 0;
  let remainingBefore = 0;
  let remainingAfter = 0;
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];
  let previous: DiffLine[] = [];
  function flush() {
    for (let index = 0; index < Math.max(removed.length, added.length); index++) {
      rows.push({ before: removed[index], after: added[index] });
    }
    removed = [];
    added = [];
  }
  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      flush();
      before = Number(header[1]);
      remainingBefore = Number(header[2] ?? 1);
      after = Number(header[3]);
      remainingAfter = Number(header[4] ?? 1);
      previous = [];
      rows.push({ heading: line });
    } else if (line.startsWith('\\ ') && previous.length) {
      for (const item of previous) item.noNewline = true;
    } else if (remainingBefore > 0 && line.startsWith('-')) {
      remainingBefore--;
      const item: DiffLine = { number: before++, text: line.slice(1), tone: 'removed' };
      removed.push(item);
      previous = [item];
    } else if (remainingAfter > 0 && line.startsWith('+')) {
      remainingAfter--;
      const item: DiffLine = { number: after++, text: line.slice(1), tone: 'added' };
      added.push(item);
      previous = [item];
    } else if (remainingBefore > 0 && remainingAfter > 0 && line.startsWith(' ')) {
      flush();
      remainingBefore--;
      remainingAfter--;
      const row = { before: { number: before++, text: line.slice(1) }, after: { number: after++, text: line.slice(1) } };
      rows.push(row);
      previous = [row.before, row.after];
    }
  }
  flush();
  return rows;
}

function DiffCell({ line }: { line?: DiffLine }) {
  return <div className={line ? 'working-diff-cell' + (line.tone ? ' patch-' + line.tone : '') : 'working-diff-cell empty-line'}>
    <span className="working-line-number">{line?.number}</span>
    <code>{line?.text}{line?.noNewline && <span className="no-newline" title="Нет перевода строки в конце файла"> ↵</span>}</code>
  </div>;
}

function FileDiff({ patch, split }: { patch: string; split: boolean }) {
  if (!patch) return <p className="working-diff-empty hint">Нет текстовых изменений.</p>;
  const lines = patch.replace(/\r?\n$/, '').split(/\r?\n/);
  const rows = split ? splitDiff(lines) : [];
  if (!rows.length) return <pre className="working-unified">{lines.map((line, index) => <span key={index}
    className={line.startsWith('@@') ? 'patch-hunk' : /^\+(?!\+\+ )/.test(line) ? 'patch-added'
      : /^-(?!-- )/.test(line) ? 'patch-removed' : undefined}>{line || ' '}</span>)}</pre>;
  return <div className="working-split mono">
    <div className="working-diff-columns"><span>До</span><span>После</span></div>
    {rows.map((row, index) => row.heading ? <div className="working-diff-hunk patch-hunk" key={index}>{row.heading}</div>
      : <div className="working-diff-columns" key={index}><DiffCell line={row.before}/><DiffCell line={row.after}/></div>)}
  </div>;
}

export function WorkingTree({ files, refresh, readPatch, stage, commit }: Props) {
  const [selection, setSelection] = useState<{ path: string; staged: boolean; patch: string }>();
  const [split, setSplit] = useState(false);
  const [message, setMessage] = useState('');
  const selected = files.find(file => file.path === selection?.path);
  const readyToCommit = files.some(inIndex) && Boolean(message.trim());
  function select(file: WorkingFile, staged = !inWorktree(file)) {
    readPatch(file.path, staged, patch => setSelection({ path: file.path, staged, patch }));
  }

  return <div className="working-files">
    <div className="working-toolbar">
      <button className="working-mode-icon" type="button" aria-label="Обновить список" title="Обновить список"
        onClick={() => { setSelection(undefined); refresh(); }}>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
          strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M13.5 2.5V6h-3.5M13.5 6a5.5 5.5 0 1 0 .1 3.8"/>
        </svg>
      </button>
      <div className="working-modes" role="group" aria-label="Режим просмотра diff">
        <button className="working-mode-icon" type="button" aria-label="В линию" title="В линию"
          aria-pressed={!split} onClick={() => setSplit(false)}>
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
            <rect x="1.5" y="2.5" width="13" height="11" rx="1"/>
            <path d="M4 6h8M4 10h8"/>
          </svg>
        </button>
        <button className="working-mode-icon" type="button" aria-label="До и после" title="До и после"
          aria-pressed={split} onClick={() => setSplit(true)}>
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
            <rect x="1.5" y="2.5" width="13" height="11" rx="1"/>
            <path d="M8 3v10M4 6h1.5M4 10h1.5m5-4H12m-1.5 4H12"/>
          </svg>
        </button>
      </div>
    </div>
    <div className="working-layout">
      <section className="working-file-tree" aria-label="Дерево файлов">
        {files.length ? <FileNodes folder={fileTree(files)} selected={selection?.path} onSelect={select}/>
          : <p className="working-diff-empty hint">Рабочее дерево чистое.</p>}
      </section>
      <section className="working-file-patch" aria-label="Сравнение файла">
        {selection && selected ? <>
          <div className="working-diff-header">
            <strong className="mono" title={selection.path}>{selection.path}</strong>
            {inIndex(selected) && inWorktree(selected) && <div className="working-modes" role="group" aria-label="Источник diff">
              <button type="button" aria-pressed={!selection.staged} onClick={() => select(selected, false)}>Локальные</button>
              <button type="button" aria-pressed={selection.staged} onClick={() => select(selected, true)}>Индекс</button>
            </div>}
            <button type="button" data-stage={selection.staged ? 'remove' : 'add'}
              onClick={() => stage(selected.path, selection.staged, () => setSelection(undefined))}>
              {selection.staged ? 'Убрать из индекса' : 'Добавить в индекс'}
            </button>
          </div>
          <FileDiff patch={selection.patch} split={split}/>
        </> : <p className="working-diff-empty hint">Выберите файл для просмотра изменений.</p>}
      </section>
    </div>
    <form className="actions commit-actions" onSubmit={event => {
      event.preventDefault();
      if (readyToCommit) commit(message, () => { setMessage(''); setSelection(undefined); });
    }}>
      <button className="primary" disabled={!readyToCommit}>Создать коммит</button>
      <input aria-label="Сообщение коммита" placeholder="Сообщение коммита" value={message} onChange={event => setMessage(event.target.value)}/>
    </form>
  </div>;
}
