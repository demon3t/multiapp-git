import React, { useLayoutEffect, useRef, useState } from 'react';
import type { CommitAction, CommitCommand, GitCommit, GitState } from './core/public';
import { ContextItem, ContextMenu } from './context-menu';

export type CommitMenuTarget = { commit: GitCommit; anchor: HTMLButtonElement; point?: { x: number; y: number } };
export type CommitEdit = CommitAction['action'];
export const commitLabels: Record<CommitCommand, string> = {
  create: 'Создать ветку…', tag: 'Создать тег…', checkout: 'Переключиться на коммит…',
  'cherry-pick': 'Cherry-pick коммита…', revert: 'Отменить коммит (Revert)…',
  reset: 'Сбросить ветку до коммита…', rebase: 'Выполнить rebase на этот коммит…',
  patch: 'Сохранить как патч…', compare: 'Сравнить с рабочей папкой',
  'copy-sha': 'Копировать SHA коммита', 'copy-info': 'Копировать сведения о коммите'
};

export function CommitMenu({ target, state, onClose, onCommand, onBranch }: {
  target: CommitMenuTarget; state: GitState; onClose: () => void;
  onCommand: (command: CommitCommand) => void; onBranch: (ref: string) => void;
}) {
  const refs = target.commit.refs.map(ref => ref.replace(/^HEAD -> /, ''))
    .filter(ref => /^refs\/(heads|remotes)\//.test(ref));
  const item = (command: CommitCommand, disabled = false, shortcut?: string, label = commitLabels[command]) =>
    <ContextItem label={label} disabled={disabled} shortcut={shortcut} onClick={() => onCommand(command)}/>;
  return <ContextMenu anchor={target.anchor} point={target.point} label={'Коммит ' + target.commit.sha.slice(0, 8)} onClose={onClose} onKeyDown={event => {
    const command = event.code === 'KeyC' ? (event.shiftKey ? 'copy-info' : 'copy-sha')
      : event.shiftKey && event.code === 'KeyB' ? 'create' : event.shiftKey && event.code === 'KeyG' ? 'tag' : undefined;
    if (!event.ctrlKey || event.altKey || event.metaKey || !command) return;
    event.preventDefault(); event.stopPropagation(); onCommand(command);
  }}>
    {refs.map(ref => <ContextItem key={ref} label={ref.replace(/^refs\/(heads|remotes)\//, '') + '  ›'} onClick={() => onBranch(ref)}/>)}
    {refs.length > 0 && <div className="menu-separator" role="separator"/>}
    {item('create', false, 'Control+Shift+B')}
    {item('tag', false, 'Control+Shift+G')}
    <div className="menu-separator" role="separator"/>
    {item('rebase', !state.branch || state.head === target.commit.sha, undefined, state.branch ? 'Rebase «' + state.branch + '» на этот коммит…' : undefined)}
    {item('reset', !state.branch || state.head === target.commit.sha, undefined, state.branch ? 'Сбросить «' + state.branch + '» до коммита…' : undefined)}
    <div className="menu-separator" role="separator"/>
    {item('checkout', !state.head)}
    {item('cherry-pick', !state.branch || state.head === target.commit.sha)}
    {item('revert', !state.branch)}
    {item('patch')}
    <div className="menu-separator" role="separator"/>
    {item('compare')}
    {item('copy-sha', false, 'Control+C')}
    {item('copy-info', false, 'Control+Shift+C')}
  </ContextMenu>;
}

export function CommitActionDialog({ commit, action, state, onClose, onSubmit }: {
  commit: GitCommit; action: CommitEdit; state: GitState; onClose: () => void; onSubmit: (input: CommitAction) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState('');
  const [parent, setParent] = useState('');
  const [mode, setMode] = useState<Extract<CommitAction, { action: 'reset' }>['mode']>('soft');
  const naming = action === 'create' || action === 'tag';
  const chooseParent = (action === 'cherry-pick' || action === 'revert') && commit.parents.length > 1;
  useLayoutEffect(() => { dialog.current?.showModal(); }, []);
  function submit(event: React.FormEvent) {
    event.preventDefault();
    const target = { sha: commit.sha, current: state.branch, head: state.head };
    if (action === 'create' || action === 'tag') {
      if (name.trim()) onSubmit({ ...target, action, name: name.trim() });
    } else if (action === 'reset') onSubmit({ ...target, action, mode });
    else if (action === 'cherry-pick' || action === 'revert') {
      if (!chooseParent || parent) onSubmit({ ...target, action, parent: parent ? Number(parent) : undefined });
    } else onSubmit({ ...target, action });
  }
  return <dialog ref={dialog} className="update-dialog branch-dialog commit-action-dialog" aria-labelledby="commit-action-title"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <h2 id="commit-action-title">{commitLabels[action].replace(/…$/, '')}</h2>
    <form onSubmit={submit}>
      <p><code>{commit.sha.slice(0, 8)}</code> · {commit.subject}</p>
      {naming && <label>{action === 'create' ? 'Имя ветки' : 'Имя тега'}<input value={name} onChange={event => setName(event.target.value)} required autoFocus/></label>}
      {chooseParent && <label>Основной родитель<select required value={parent} onChange={event => setParent(event.target.value)}>
        <option value="">Выберите родителя</option>
        {commit.parents.map((sha, index) => <option key={sha} value={index + 1}>{index + 1} · {sha.slice(0, 12)}</option>)}
      </select></label>}
      {action === 'checkout' && <p>Рабочая папка перейдёт к выбранному коммиту в режиме detached HEAD.</p>}
      {action === 'rebase' && <p>Коммиты ветки «{state.branch}» будут перенесены на выбранный коммит. Их SHA изменятся.</p>}
      {action === 'cherry-pick' && <p>Изменения коммита будут применены к ветке «{state.branch}».</p>}
      {action === 'revert' && <p>В ветке «{state.branch}» будет создан коммит с обратными изменениями.</p>}
      {action === 'reset' && <label>Режим сброса ветки «{state.branch}»<select value={mode} onChange={event => setMode(event.target.value as typeof mode)}>
        <option value="soft">Soft · сохранить индекс и рабочие файлы</option>
        <option value="mixed">Mixed · сбросить индекс</option>
        <option value="hard">Hard · заменить индекс и рабочие файлы</option>
      </select></label>}
      {action === 'reset' && mode === 'hard' && <p className="error">Незакоммиченные изменения в затронутых файлах будут потеряны.</p>}
      <div className="update-dialog-actions">
        <button type="button" onClick={onClose} autoFocus={!naming}>Отмена</button>
        <button className={action === 'reset' && mode === 'hard' ? 'danger' : 'primary'}
          disabled={(naming && !name.trim()) || (chooseParent && !parent)}>Выполнить</button>
      </div>
    </form>
  </dialog>;
}
