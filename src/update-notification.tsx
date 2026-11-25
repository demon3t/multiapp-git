import React from 'react';
import type { UpdateView } from './core/public';

export function UpdateNotification({ update, dismiss, showDetails }: {
  update: UpdateView; dismiss: () => void; showDetails?: () => void;
}) {
  const { status, latest, progress, message } = update;
  if (status === 'idle') return null;
  const pending = status === 'checking' || status === 'downloading' || status === 'installing';
  const text = {
    checking: 'Проверяем обновления…',
    current: 'У вас актуальная версия mGit.',
    available: 'Доступна версия mGit ' + latest + '.',
    downloading: 'Загружаем обновление · ' + (progress ?? 0) + '%',
    ready: 'Обновление mGit ' + latest + ' готово к установке.',
    installing: 'Запускаем установщик…',
    'no-release': 'В репозитории пока нет опубликованных релизов.',
    error: 'Не удалось проверить обновления.'
  }[status];
  return <div className={(message || status === 'error' ? 'error' : 'notice') + ' operation-toast-result update-toast'}>
    <div>
      <div role={message || status === 'error' ? 'alert' : 'status'}>{message || text}</div>
      {status === 'downloading' && <progress max={100} value={progress ?? 0} aria-label="Ход загрузки обновления"/>}
      {showDetails && (status === 'available' || status === 'ready') &&
        <button className="update-toast-action" type="button" aria-haspopup="dialog" onClick={showDetails}>Открыть обновление</button>}
    </div>
    {!pending && <button type="button" aria-label="Закрыть уведомление" title="Закрыть" onClick={dismiss}>×</button>}
  </div>;
}
