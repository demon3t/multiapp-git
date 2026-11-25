import React, { useEffect, useRef, useState } from 'react';
import { tabIcons, type ProfileSummary, type TabAppearance, type TabIcon } from './core/public';

const icons: Record<TabIcon, { label: string; path: string }> = {
  repository: { label: 'Репозиторий', path: 'M5 3h13v17H5z M5 16h13 M8 7h7 M8 10h5' },
  server: { label: 'Сервер', path: 'M3 5h18v5H3z M3 14h18v5H3z M7 7.5h1 M7 16.5h1' },
  folder: { label: 'Папка', path: 'M3 6h7l2 3h9v10H3z' },
  branch: { label: 'Ветка', path: 'M6 9v6 M8 16c5 0 10-2 10-7 M8 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0z M20 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0z M8 17a2 2 0 1 1-4 0 2 2 0 0 1 4 0z' },
  code: { label: 'Код', path: 'M8 7l-5 5 5 5 M16 7l5 5-5 5 M14 5l-4 14' },
  star: { label: 'Звезда', path: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z' }
};

export function RepositoryIcon({ icon, color, type }: Pick<ProfileSummary, 'icon' | 'color' | 'type'>) {
  const key = icon && Object.hasOwn(icons, icon) ? icon : type === 'git' ? 'repository' : 'server';
  return <svg className="repository-icon" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
    style={color ? { color } : undefined}><path d={icons[key].path}/></svg>;
}

export function TabAppearanceDialog({ tab, onClose, save }: {
  tab: ProfileSummary; onClose: () => void; save: (value: TabAppearance & { id: string }) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(tab.name);
  const [icon, setIcon] = useState(tab.icon);
  const [color, setColor] = useState(tab.color);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);

  return <dialog ref={dialog} className="update-dialog tab-appearance-dialog" aria-labelledby="tab-appearance-title"
    onCancel={event => { event.preventDefault(); if (!saving) onClose(); }}>
    <h2 id="tab-appearance-title">Оформление вкладки</h2>
    <form onSubmit={async event => {
      event.preventDefault();
      if (saving || !name.trim()) return;
      setSaving(true);
      setError('');
      try { await save({ id: tab.id, name, icon, color }); }
      catch (error) { setError(error instanceof Error ? error.message : 'Не удалось сохранить оформление.'); }
      finally { setSaving(false); }
    }}>
      <fieldset disabled={saving}>
        <label>Название вкладки<input value={name} onChange={event => setName(event.target.value)} maxLength={80} required autoFocus/></label>
        <div className="tab-icon-options" role="group" aria-label="Значок">
          <button type="button" aria-label="Значок по умолчанию" title="По умолчанию" aria-pressed={!icon} onClick={() => setIcon(undefined)}>Авто</button>
          {tabIcons.map(key => <button key={key} type="button" aria-label={icons[key].label} title={icons[key].label}
            aria-pressed={key === icon} onClick={() => setIcon(key)}><RepositoryIcon icon={key} type={tab.type}/></button>)}
        </div>
        <div className="tab-color-options">
          <label>Цвет значка<input type="color" value={color ?? '#15549e'} onChange={event => setColor(event.target.value)}/></label>
          <button type="button" disabled={!color} onClick={() => setColor(undefined)}>Сбросить цвет</button>
        </div>
        <div className="tab-appearance-preview" aria-label="Предпросмотр"><RepositoryIcon icon={icon} color={color} type={tab.type}/><span>{name}</span></div>
      </fieldset>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="update-dialog-actions">
        <button type="button" disabled={saving} onClick={onClose}>Отмена</button>
        <button className="primary" disabled={saving || !name.trim()}>Сохранить</button>
      </div>
    </form>
  </dialog>;
}
