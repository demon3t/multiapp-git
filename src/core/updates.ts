import { gt, valid } from 'semver';
import { createHash } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

export const releasesPage = 'https://github.com/demon3t/multiapp-git/releases';
const repositoryApi = 'https://api.github.com/repos/demon3t/multiapp-git';
const api = repositoryApi + '/releases';
export const installerName = 'mGit-Windows-x64-Setup.exe';
const maxInstallerBytes = 512 * 1024 * 1024;
type Asset = { url: string; size: number; digest: string };
type Request = (url: string, options: RequestInit) => Promise<Response>;
const changeGroups = ['New', 'Improved', 'Fixed'] as const;
type ChangeGroup = typeof changeGroups[number];
export type UpdateChanges = Record<ChangeGroup, string[]>;

export type UpdateStatus = {
  current: string;
  latest?: string;
  status: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'installing' | 'no-release' | 'error';
  message?: string;
  progress?: number;
  asset?: Asset;
  tag?: string;
  notes?: string;
};

function githubHeaders(current: string, accept: string) {
  return { Accept: accept, 'User-Agent': 'mGit/' + current };
}

export async function checkRelease(current: string, request: Request): Promise<UpdateStatus> {
  const headers = githubHeaders(current, 'application/vnd.github+json');
  const get = (path: string) => request(api + path, { headers, cache: 'no-store', signal: AbortSignal.timeout(15_000), redirect: 'error' });
  try {
    const response = await get('/latest');
    if (response.status === 404) {
      const access = await get('?per_page=1');
      if (access.ok) return { current, status: 'no-release' };
      return { current, status: 'error', message: access.status === 404 || access.status === 401
        ? 'Публичные релизы mGit недоступны.'
        : 'GitHub вернул HTTP ' + access.status + '.' };
    }
    if (!response.ok) return { current, status: 'error', message: 'GitHub вернул HTTP ' + response.status + '.' };
    const { tag_name: tag, draft, prerelease, assets, body } = await response.json();
    const latest = typeof tag === 'string' && tag.length < 100 ? valid(tag) : null;
    if (!latest || !valid(current) || draft || prerelease) {
      return { current, status: 'error', message: 'GitHub вернул неожиданные данные о релизе.' };
    }
    if (!gt(latest, current)) return { current, latest, status: 'current' };
    const installer = Array.isArray(assets) && assets.find(asset => asset?.name === installerName && asset.state === 'uploaded');
    const url = releasesPage + '/download/' + encodeURIComponent(tag) + '/' + installerName;
    const asset: Asset | undefined = installer?.browser_download_url === url &&
      Number.isSafeInteger(installer.size) && installer.size > 0 && installer.size <= maxInstallerBytes &&
      typeof installer.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(installer.digest)
      ? { url, size: installer.size, digest: installer.digest.slice(7) } : undefined;
    return { current, latest, tag, status: 'available', ...(asset && { asset }), ...(typeof body === 'string' && { notes: body }) };
  } catch {
    return { current, status: 'error', message: 'Не удалось связаться с GitHub. Проверьте подключение и повторите попытку.' };
  }
}

export async function releaseChanges({ current, latest, tag, notes }: UpdateStatus, request: Request): Promise<UpdateChanges> {
  const groups: UpdateChanges = { New: [], Improved: [], Fixed: [] };
  if (!latest || !tag || !valid(current) || !valid(latest) || !gt(latest, current)) return groups;
  const fallback = (notes ?? '').split(/\r?\n/).map(line => line.trim())
    .filter(line => line && !/^#|^\*\*Full Changelog\*\*/i.test(line))
    .map(line => line.replace(/^[-*]\s+/, '').replace(/ by @[\w-]+ in https:\/\/github\.com\/\S+$/, ''));
  const response = await request(repositoryApi + '/contents/changelog/ru.md?ref=' + encodeURIComponent(tag), {
    headers: githubHeaders(current, 'application/vnd.github.raw+json'),
    signal: AbortSignal.timeout(15_000), redirect: 'error'
  }).catch(error => {
    if (!fallback.length) throw error;
  });
  if (response && !response.ok && response.status !== 404 && !fallback.length) throw new Error('GitHub вернул HTTP ' + response.status + '.');
  const latestBase = latest.replace(/-build\.\d+$/, '');
  let included = false;
  let group: ChangeGroup | undefined;
  for (const line of (response?.ok ? await response.text() : '').split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      const version = valid(line.slice(3).split(/\s+/, 1)[0]);
      included = Boolean(version && gt(version, current) && !gt(version, latestBase) &&
        version !== current.replace(/-build\.\d+$/, ''));
      group = undefined;
    } else if (line.startsWith('### ')) {
      group = changeGroups.find(value => value === line.slice(4).trim());
    } else if (included && group && line.startsWith('- ')) {
      groups[group].push(line.slice(2).trim());
    }
  }
  return Object.values(groups).some(items => items.length) ? groups : { ...groups, Improved: fallback };
}

export async function downloadInstaller(
  asset: Asset, directory: string, request: Request, onProgress: (progress: number) => void
) {
  const signal = AbortSignal.timeout(15 * 60_000);
  let response = await request(asset.url, { redirect: 'manual', signal });
  if (response.status === 302) {
    const location = new URL(response.headers.get('location') ?? '');
    if (location.protocol !== 'https:' || location.port || location.username || location.password ||
        !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(location.hostname)) {
      throw new Error('Неожиданный адрес загрузки GitHub.');
    }
    await response.body?.cancel();
    response = await request(location.href, { redirect: 'error', signal });
  }
  if (response.status !== 200 || !response.body) throw new Error('Не удалось скачать установщик с GitHub.');
  const folder = await fs.mkdtemp(join(directory, 'mgit-update-'));
  const file = join(folder, installerName);
  const hash = createHash('sha256');
  let bytes = 0;
  let percent = 0;
  const reader = response.body.getReader();
  async function* chunks() {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > asset.size) throw new Error('Размер установщика отличается от релиза.');
      hash.update(value);
      const next = Math.floor(100 * bytes / asset.size);
      if (next > percent) { percent = next; onProgress(percent); }
      yield value;
    }
  }
  try {
    await pipeline(chunks(), createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal });
    if (bytes !== asset.size || hash.digest('hex') !== asset.digest) throw new Error('SHA256 или размер установщика отличается от релиза.');
    return file;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await fs.rm(file, { force: true }).catch(() => undefined);
    await fs.rmdir(folder).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
