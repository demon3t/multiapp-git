import { gt, valid } from 'semver';

export const releasesPage = 'https://github.com/demon3t/multiapp-git/releases';
const api = 'https://api.github.com/repos/demon3t/multiapp-git/releases';

export type UpdateStatus = {
  current: string;
  latest?: string;
  status: 'idle' | 'checking' | 'current' | 'available' | 'no-release' | 'error';
  message?: string;
};

export async function checkRelease(current: string, token: string, request: (url: string, options: RequestInit) => Promise<Response>): Promise<UpdateStatus> {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'mGit/' + current,
    ...(token ? { Authorization: 'Bearer ' + token } : {})
  };
  const get = (path: string) => request(api + path, { headers, signal: AbortSignal.timeout(15_000), redirect: 'error' });
  try {
    const response = await get('/latest');
    if (response.status === 404) {
      const access = await get('?per_page=1');
      if (access.ok) return { current, status: 'no-release' };
      return { current, status: 'error', message: access.status === 404 || access.status === 401
        ? 'Нет доступа к релизам mGit. Укажите GitHub-токен с правом чтения Contents.'
        : 'GitHub вернул HTTP ' + access.status + '.' };
    }
    if (!response.ok) return { current, status: 'error', message: response.status === 401
      ? 'GitHub отклонил токен. Проверьте его срок действия и доступ к репозиторию.'
      : 'GitHub вернул HTTP ' + response.status + '.' };
    const { tag_name: tag, draft, prerelease } = await response.json();
    const latest = typeof tag === 'string' && tag.length < 100 ? valid(tag) : null;
    if (!latest || !valid(current) || draft || prerelease) {
      return { current, status: 'error', message: 'GitHub вернул неожиданные данные о релизе.' };
    }
    return { current, latest, status: gt(latest, current) ? 'available' : 'current' };
  } catch {
    return { current, status: 'error', message: 'Не удалось связаться с GitHub. Проверьте подключение и повторите попытку.' };
  }
}
