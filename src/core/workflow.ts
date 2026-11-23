import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Adapter, Failure, Files, Profile } from './model';
import { assertValid, inspect, materialize, normalizeExport, selectAssets, summarize } from './snapshot';
import { compare, readCommit, resolveCommit } from './git';
import { pack } from './zip';

export const inventory = (files: Files) => inspect(files).assets.map(({ data, ...asset }) => asset);
export async function exportSnapshot(adapter: Adapter, selected: string[] = []) {
  const files = selectAssets(normalizeExport(await adapter.download()), selected);
  const assets = assertValid(files);
  return { files, assets: inventory(files), counts: summarize(assets) };
}
export async function sourceSnapshot(repo: string, ref: string, folder: string) {
  const sha = await resolveCommit(repo, ref);
  const files = await readCommit(repo, sha, folder);
  return { sha, files };
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
  const mismatches = expected.flatMap(asset => {
    const actual = byId.get(asset.uuid);
    const count = observed.assets.filter(item => item.uuid === asset.uuid).length;
    return !actual || actual.kind !== asset.kind || count !== 1 || [...new Set(asset.references)].sort().join() !== [...new Set(actual.references)].sort().join()
      ? [{ path: asset.path, message: !actual ? 'UUID не найден на цели.' : 'На цели отличаются связи, тип или число объектов с UUID.' }] : [];
  });
  const seenPaths = new Set(expected.flatMap(asset => byId.get(asset.uuid)?.path ?? []));
  const issues = [...mismatches, ...observed.issues.filter(issue => seenPaths.has(issue.path) || issue.path === 'metadata.yaml' || !issue.path || issue.path === '[путь скрыт]')];
  return { verified: !issues.length, checked: expected.length, issues };
}
export async function applyImport(adapter: Adapter, profile: Profile, files: Files, connections: Record<string, string>, options: {
  sha: string; confirm?: string; backup?: string; expected?: { targetState: string; connectionState: string };
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
