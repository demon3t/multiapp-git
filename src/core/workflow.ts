import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Adapter, Failure, Files, Profile } from './model';
import { assertValid, inspect, inspectExport, materialize, normalizeExport, prepareSnapshot, safePath, selectAssets, summarize } from './snapshot';
import { compare, gitStatus, readCommit, resolveCommit, snapshotFolders, writeSnapshot } from './git';
import { pack } from './zip';

export async function exportSnapshot(adapter: Adapter, selected: string[] = []) {
  const source = adapter.exportFiles ? await adapter.exportFiles() : normalizeExport(await adapter.download());
  const files = selectAssets(source, selected);
  const { assets, issues } = inspectExport(files);
  return { files, assets: assets.map(({ data, ...asset }) => asset), counts: summarize(assets), issues };
}
export async function sourceSnapshot(repo: string, ref: string, folder: string) {
  const sha = await resolveCommit(repo, ref);
  const files = await readCommit(repo, sha, folder);
  return { sha, files };
}

async function workingSnapshot(repo: string, operation: 'export' | 'import') {
  const state = await gitStatus(repo);
  const { branch, head } = state;
  if (!branch) throw new Failure('Переключитесь на локальную ветку.');
  const folders = head ? await snapshotFolders(repo, head) : [];
  const branchFolder = 'snapshots/' + branch + '/assets';
  const defaultFolder = 'snapshots/superset/assets';
  const folder = [branchFolder, defaultFolder].find(path => folders.includes(path))
    ?? (folders.length === 1 ? folders[0] : undefined);
  if (folder) return { branch, head, folder, state };
  if (folders.length) throw new Failure('В текущей ветке несколько каталогов снимков. Используйте стандартный путь для снимка этой ветки.', 'validation', folders);
  if (operation === 'import') throw new Failure('В текущей ветке нет сохранённого снимка Superset.');
  return { branch, head, folder: safePath(branchFolder) && branchFolder.length <= 150 ? branchFolder : defaultFolder, state };
}

export async function exportWorkingSnapshot(adapter: Adapter, repo: string) {
  const working = await workingSnapshot(repo, 'export');
  const exported = await exportSnapshot(adapter);
  const review = await writeSnapshot(repo, working.folder, exported.files, working);
  return { ...working, ...exported, changes: review.changes, state: await gitStatus(repo) };
}

export async function importWorkingSnapshot(adapter: Adapter, profile: Profile, repo: string,
  connections: Record<string, string>, backup: (sha: string) => Promise<string>) {
  const { branch, head: sha, folder, state } = await workingSnapshot(repo, 'import');
  const { files, assets, excluded } = prepareSnapshot(await readCommit(repo, sha, folder), true);
  const backupPath = await backup(sha);
  const verified = await applyImport(adapter, profile, files, connections, {
    sha, backup: backupPath, async beforeUpload() {
      const current = await gitStatus(repo);
      if (current.head !== sha || current.branch !== branch) throw new Failure('Рабочая ветка или HEAD изменились. Повторите импорт.');
    }
  });
  return { branch, sha, folder, state, counts: summarize(assets), excluded, backupPath, checked: verified.checked };
}
const digest = (files: Files) => createHash('sha256').update(JSON.stringify([...files].sort(([a], [b]) => a.localeCompare(b)))).digest('hex');

export async function planImport(adapter: Adapter, profile: Profile, files: Files, connections: Record<string, string>) {
  const assets = assertValid(files);
  const prepared = materialize(files, connections);
  const capability = await adapter.supportsImport();
  const raw = await adapter.download();
  const before = normalizeExport(raw);
  const existing = inspect(before);
  if (existing.issues.some(issue => issue.path === 'metadata.yaml' || !issue.path || issue.path === '[путь скрыт]')) {
    throw new Failure('Невозможно безопасно проверить каталог целевого стенда.', 'validation', existing.issues);
  }
  const exact = new Map(existing.assets.map(asset => [asset.uuid, asset]));
  const collisions = assets.filter(asset => existing.assets.some(other => other.kind === asset.kind && other.uuid !== asset.uuid &&
      ((asset.kind === 'databases' && other.name === asset.name) || (asset.kind === 'dashboards' && asset.data.slug && other.data.slug === asset.data.slug))));
  if (collisions.length) throw new Failure('На цели есть объекты с тем же именем подключения или slug дашборда и другим UUID.', 'validation', collisions.map(asset => ({ path: asset.path, message: 'Конфликт идентификаторов.' })));
  return {
    version: capability.version, url: profile.url, environment: profile.environment, counts: summarize(assets),
    assets: assets.map(({ uuid, kind, path, name }) => ({ uuid, kind, path, name, action: exact.has(uuid) ? 'update' : 'add' })),
    targetState: digest(before),
    connectionState: digest(prepared.output) + ':' + createHash('sha256').update(JSON.stringify(prepared.passwords)).digest('hex')
  };
}
export const confirmation = (profile: Profile, sha: string) => profile.name + ' ' + sha;
export async function verifyImport(adapter: Adapter, files: Files) {
  const expected = assertValid(files);
  const observed = inspect(normalizeExport(await adapter.download()));
  const byId = new Map(observed.assets.map(asset => [asset.uuid, asset]));
  const counts = new Map<string, number>();
  for (const asset of observed.assets) counts.set(asset.uuid, (counts.get(asset.uuid) ?? 0) + 1);
  const mismatches = expected.flatMap(asset => {
    const actual = byId.get(asset.uuid);
    const count = counts.get(asset.uuid);
    return !actual || actual.kind !== asset.kind || count !== 1 || [...new Set(asset.references)].sort().join() !== [...new Set(actual.references)].sort().join()
      ? [{ path: asset.path, message: !actual ? 'UUID не найден на цели.' : 'На цели отличаются связи, тип или число объектов с UUID.' }] : [];
  });
  const seenPaths = new Set(expected.flatMap(asset => byId.get(asset.uuid)?.path ?? []));
  const issues = [...mismatches, ...observed.issues.filter(issue => seenPaths.has(issue.path) || issue.path === 'metadata.yaml' || !issue.path || issue.path === '[путь скрыт]')];
  return { verified: !issues.length, checked: expected.length, issues };
}
export async function applyImport(adapter: Adapter, profile: Profile, files: Files, connections: Record<string, string>, options: {
  sha: string; confirm?: string; backup?: string; expected?: { targetState: string; connectionState: string }; beforeUpload?: () => Promise<void>;
}) {
  if (profile.environment === 'PROD' && options.confirm !== confirmation(profile, options.sha)) {
    throw new Failure('Для PROD введите точное название стенда и полный commit SHA.', 'confirmation');
  }
  const key = createHash('sha256').update(profile.url.replace(/\/+$/, '').toLowerCase()).digest('hex');
  const lockPath = join(tmpdir(), 'mgit-import-' + key + '.lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Failure('Для цели уже запущен импорт или осталась блокировка: ' + lockPath, 'locked');
    throw error;
  }
  let retainLock = false;
  try {
    await lock.writeFile(String(process.pid));
    const current = await planImport(adapter, profile, files, connections);
    if (options.expected && (current.targetState !== options.expected.targetState || current.connectionState !== options.expected.connectionState)) {
      throw new Failure('Целевой снимок или настройки подключений изменились. Постройте план заново.');
    }
    if (options.backup) {
      const snapshot = normalizeExport(await adapter.download());
      assertValid(snapshot);
      if (digest(snapshot) !== current.targetState) throw new Failure('Целевой стенд изменился во время резервного экспорта. Постройте план заново.');
      await fs.writeFile(options.backup, await pack(snapshot), { flag: 'wx' });
    }
    await options.beforeUpload?.();
    try { await adapter.upload(files, connections); }
    catch (error) {
      if (!(error instanceof Failure) || error.code !== 'import-unknown') throw error;
      retainLock = true;
      const observed = await verifyImport(adapter, files).catch(() => undefined);
      throw new Failure(error.message + ' Блокировка сохранена: ' + lockPath, error.code, observed);
    }
    try {
      const verified = await verifyImport(adapter, files);
      if (!verified.verified) throw new Failure('Импорт принят, но результат отличается от плана.', 'verify', verified);
      return verified;
    } catch (error) {
      if (error instanceof Failure && error.code === 'verify') throw error;
      throw new Failure('Superset принял импорт. Проверка результата через API не удалась.', 'verify');
    }
  } finally {
    await lock.close();
    if (!retainLock) await fs.unlink(lockPath);
  }
}
export function snapshotDiff(before: Files, after: Files) {
  return compare(before, after);
}
