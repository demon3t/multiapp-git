import React, { useEffect, useRef, useState } from 'react';
import type { UpdateView } from './core/public';
import type { UpdateChanges } from './core/updates';

const headings = { New: ['Новое', '✦'], Improved: ['Улучшения', '↗'], Fixed: ['Исправления', '✓'] } as const;

export function UpdateDialog({ update, busy, onClose, notification, onError }: {
  update: UpdateView; busy: boolean; onClose: () => void; notification: React.ReactNode; onError: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [changes, setChanges] = useState<UpdateChanges>();
  const [notesError, setNotesError] = useState(false);
  const [starting, setStarting] = useState(false);
  const installing = update.status === 'installing';
  const downloading = update.status === 'downloading';
  const updating = starting || installing;
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    let active = true;
    void window.mgit.call('updateChanges', undefined).then(result => {
      if (!active) return;
      if (result.ok) setChanges(result.data);
      else setNotesError(true);
    }).catch(() => { if (active) setNotesError(true); });
    return () => { active = false; };
  }, [update.latest]);

  async function install() {
    setStarting(true);
    try {
      const result = update.canInstall
        ? await window.mgit.call('installUpdate', undefined)
        : await window.mgit.call('openReleases', undefined);
      if (!result.ok) onError(result.message);
    } catch {
      onError('Не удалось запустить обновление.');
    } finally {
      setStarting(false);
    }
  }

  return <dialog ref={dialog} className="update-dialog" aria-labelledby="update-dialog-title"
    onCancel={event => { event.preventDefault(); if (!updating) onClose(); }}>
    <p className="update-eyebrow">Что нового</p>
    <h2 id="update-dialog-title">mGit {update.latest}</h2>
    <p className="update-versions mono">{update.current} <span aria-hidden="true">→</span> <strong>{update.latest}</strong></p>
    <div className="update-changes" aria-live="polite">
      {!changes && <p className="hint">{notesError ? 'Не удалось загрузить список изменений.' : 'Загружаем список изменений…'}</p>}
      {changes && !Object.values(changes).some(items => items.length) && <p className="hint">Для этой сборки нет новых записей в журнале изменений.</p>}
      {changes && (Object.keys(headings) as (keyof UpdateChanges)[]).map(group => changes[group].length > 0 &&
        <section key={group}><h3><span aria-hidden="true">{headings[group][1]}</span> {headings[group][0]}</h3>
          <ul>{changes[group].map((item, index) => <li key={index}>{item}</li>)}</ul>
        </section>)}
    </div>
    {notification}
    <div className="update-dialog-actions">
      <button onClick={onClose} disabled={updating}>Отмена</button>
      <button className="primary" onClick={() => void install()} disabled={busy || starting || downloading || installing}>
        {installing ? 'Установка…' : downloading ? 'Загрузка ' + (update.progress ?? 0) + '%' :
          update.canInstall ? 'Обновить' : 'Скачать на GitHub'}
      </button>
    </div>
  </dialog>;
}
