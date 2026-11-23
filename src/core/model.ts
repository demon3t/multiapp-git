export const kinds = ['databases', 'datasets', 'charts', 'dashboards', 'queries'] as const;
export type Kind = typeof kinds[number];
export type Environment = 'DEV' | 'TEST' | 'PREPROD' | 'PROD';
export type Profile = {
  id: string; name: string; url: string; environment: Environment; auth: 'db' | 'token';
  username?: string; ca?: string;
};
export type Secret = { credential: string; connections: Record<string, string> };
export type Files = Map<string, string>;
export type Row = Record<string, unknown>;
export type Asset = { path: string; kind: Kind; uuid: string; name: string; references: string[]; data: Row };
export type Issue = { path: string; message: string; dashboards?: string[] };
export type Inspection = { assets: Asset[]; issues: Issue[] };
export const uuidPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
export const normalizeUuid = (value: unknown) => typeof value === 'string' && uuidPattern.test(value) ? value.toLowerCase() : '';
export function object(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}
export const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export class Failure extends Error {
  constructor(message: string, readonly code = 'operation', readonly details?: unknown) { super(message); }
}
export function profileUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Failure('Укажите корректный URL Superset.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username || url.password || url.search || url.hash || /%2f|%5c/i.test(url.pathname)) {
    throw new Failure('Используйте HTTPS без учётных данных, query и fragment. HTTP доступен для localhost.');
  }
  return url.href.replace(/\/+$/, '');
}
export interface Adapter {
  download(): Promise<Files>;
  supportsImport(): Promise<{ version: string }>;
  upload(files: Files, connections: Record<string, string>): Promise<void>;
}
