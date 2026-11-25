import React, { useLayoutEffect, useRef, useState } from 'react';
import type { BranchAction } from './core/public';

export type BranchMenuTarget = { ref: string; anchor: HTMLButtonElement };
export type BranchCommand = BranchAction['action'] | 'history' | 'copy';
export type EditAction = 'create' | 'rename' | 'delete' | 'tag' | 'merge' | 'rebase';

export function BranchMenu({ target, current, head, onClose, onCommand }: {
  target: BranchMenuTarget; current: string; head: string; onClose: () => void; onCommand: (command: BranchCommand) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const local = target.ref.startsWith('refs/heads/');
  const name = target.ref.replace(/^refs\/(heads|remotes)\//, '');
  const canIntegrate = Boolean(current && head && (!local || name !== current));
  useLayoutEffect(() => {
    const box = menu.current!;
    const anchor = target.anchor.getBoundingClientRect();
    box.style.left = Math.max(4, Math.min(anchor.left, window.innerWidth - box.offsetWidth - 4)) + 'px';
    box.style.top = Math.max(4, Math.min(anchor.bottom, window.innerHeight - box.offsetHeight - 4)) + 'px';
    box.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !box.contains(event.target) && !target.anchor.contains(event.target)) onClose();
    }
    window.addEventListener('pointerdown', outside);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', onClose);
      if (target.anchor.isConnected && box.contains(document.activeElement)) target.anchor.focus();
    };
  }, [target, onClose]);
  const item = (command: BranchCommand, label: string, disabled = false, shortcut?: string) =>
    <button type="button" role="menuitem" className="menu-command" disabled={disabled}
      aria-label={label} aria-keyshortcuts={shortcut} onClick={() => onCommand(command)}>
      <span>{label}</span>{shortcut && <kbd aria-hidden="true">{shortcut.replace('Control', 'Ctrl')}</kbd>}
    </button>;
  return <div ref={menu} role="menu" aria-label={name} className="repo-menu-panel branch-menu" onKeyDown={event => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault(); event.stopPropagation(); onClose();
    } else if ((event.ctrlKey && event.key.toLowerCase() === 'c') ||
      (local && (event.key === 'F2' || (event.key === 'Delete' && name !== current)))) {
      event.preventDefault();
      event.stopPropagation();
      onCommand(event.key === 'F2' ? 'rename' : event.key === 'Delete' ? 'delete' : 'copy');
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const buttons = [...event.currentTarget.querySelectorAll('button:not(:disabled)')] as HTMLButtonElement[];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
        (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  }}>
    {item('switch', 'Переключить ветку', local && name === current)}
    {item('history', 'Показать историю')}
    <div className="menu-separator" role="separator"/>
    {item('merge', 'Слить в ' + (current || 'текущую ветку') + '…', !canIntegrate)}
    {item('rebase', 'Rebase ' + (current || 'текущей ветки') + ' на выбранную…', !canIntegrate)}
    <div className="menu-separator" role="separator"/>
    {item('create', 'Создать ветку от этой')}
    {item('tag', 'Создать тег…')}
    {local && <>
      <div className="menu-separator" role="separator"/>
      {item('rename', 'Переименовать…', false, 'F2')}
      {item('delete', 'Удалить…', name === current, 'Delete')}
    </>}
    <div className="menu-separator" role="separator"/>
    {item('copy', 'Копировать имя ветки', false, 'Control+C')}
  </div>;
}

const titles = { create: 'Создать ветку', rename: 'Переименовать ветку', delete: 'Удалить ветку', tag: 'Создать тег',
  merge: 'Слияние веток', rebase: 'Перенос коммитов (rebase)' };

export function BranchDialog({ refName, action, current, head, onClose, onSubmit }: {
  refName: string; action: EditAction; current: string; head: string; onClose: () => void; onSubmit: (action: BranchAction) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const branch = refName.replace(/^refs\/(heads|remotes)\//, '');
  const [name, setName] = useState(action === 'rename' ? branch : '');
  useLayoutEffect(() => { dialog.current?.showModal(); }, []);
  const deleting = action === 'delete';
  const integrating = action === 'merge' || action === 'rebase';
  return <dialog ref={dialog} className="update-dialog branch-dialog" aria-labelledby="branch-dialog-title"
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <h2 id="branch-dialog-title">{titles[action]}</h2>
    <form onSubmit={event => {
      event.preventDefault();
      if (deleting) onSubmit({ ref: refName, action });
      else if (integrating) onSubmit({ ref: refName, action, current, head });
      else if (name.trim()) onSubmit({ ref: refName, action, name: name.trim() });
    }}>
      {deleting ? <p>Удалить локальную ветку <strong>{branch}</strong>?</p>
        : integrating ? <p>{action === 'merge'
          ? <>Слить <strong>{branch}</strong> в <strong>{current}</strong>?</>
          : <>Перенести коммиты <strong>{current}</strong> на <strong>{branch}</strong>? Хеши перенесённых коммитов изменятся.</>}</p>
        : <label>{action === 'tag' ? 'Имя тега' : 'Имя ветки'}<input value={name} onChange={event => setName(event.target.value)} required autoFocus/></label>}
      <div className="update-dialog-actions">
        <button type="button" onClick={onClose} autoFocus={deleting || integrating}>Отмена</button>
        <button className={deleting ? 'danger' : 'primary'} disabled={!deleting && !integrating && (!name.trim() || action === 'rename' && name.trim() === branch)}>
          {deleting ? 'Удалить' : action === 'create' ? 'Создать и переключить' : action === 'merge' ? 'Слить' : action === 'rebase' ? 'Выполнить rebase' : titles[action]}
        </button>
      </div>
    </form>
  </dialog>;
}
