import { request as http } from 'node:http';
import { request as https } from 'node:https';
import { getCACertificates } from 'node:tls';
import { randomUUID } from 'node:crypto';
import { Adapter, Failure, Files, object, Profile, profileUrl, Secret } from './model';
import { materialize, maxBytes, normalizeExport } from './snapshot';
import { pack, unpack } from './zip';

type Result = { status: number; body: Buffer; type: string };
const exportPath = '/api/v1/assets/export/';
const importPath = '/api/v1/assets/import/';
export class Superset implements Adapter {
  private readonly base: string;
  private readonly cookies = new Map<string, string>();
  private access = '';
  constructor(private readonly profile: Profile, private readonly secret: Secret, private readonly timeout = 60_000) {
    this.base = profileUrl(profile.url);
  }
  private async request(path: string, method = 'GET', headers: Record<string, string> = {}, body?: Buffer): Promise<Result> {
    const url = new URL(this.base + path);
    const send = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), this.timeout);
      const failure = () => new Failure(abort.signal.aborted ? 'Истекло время ожидания Superset.' : 'Нет соединения с Superset или сертификат TLS не прошёл проверку.', 'network');
      const req = send(url, {
        method, signal: abort.signal,
        ca: this.profile.ca ? [...getCACertificates('default'), this.profile.ca] : undefined,
        headers: {
          ...(this.access ? { authorization: 'Bearer ' + this.access } : {}),
          ...(this.cookies.size ? { cookie: [...this.cookies.values()].join('; ') } : {}),
          ...(body ? { 'content-length': String(body.length) } : {}), ...headers
        }
      }, response => {
        for (const cookie of response.headers['set-cookie'] ?? []) {
          const pair = cookie.split(';', 1)[0];
          const key = pair.split('=', 1)[0];
          if (key) this.cookies.set(key, pair);
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            reject(new Failure('Ответ Superset превышает допустимый размер.', 'format'));
            response.destroy();
          } else chunks.push(chunk);
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks), type: response.headers['content-type'] ?? '' }));
        response.on('error', () => reject(failure()));
      });
      req.on('error', () => reject(failure()));
      req.on('close', () => clearTimeout(timer));
      req.end(body);
    });
  }

  private check(result: Result, label: string) {
    if (result.status >= 200 && result.status < 300) return result;
    if (result.status === 401 || (result.status >= 300 && result.status < 400)) throw new Failure('Superset отклонил вход или сессия истекла. Проверьте учётные данные.', 'auth');
    if (result.status === 403) throw new Failure('Superset отказал в доступе: ' + label + '.', 'permission');
    if (result.status === 404 || result.status === 405) throw new Failure('Операция недоступна в Superset: ' + label + '.', 'compatibility');
    throw new Failure('Superset вернул HTTP ' + result.status + ': ' + label + '.', result.status >= 500 ? 'server' : 'remote');
  }
  private json(result: Result) {
    try {
      if (!result.type.includes('json')) throw new Error();
      return object(JSON.parse(result.body.toString()));
    } catch { throw new Failure('Superset вернул неожиданный ответ API.', 'format'); }
  }
  async authenticate() {
    if (this.access) return;
    if (!this.secret.credential || /[\r\n\0]/.test(this.secret.credential)) throw new Failure('Задайте пароль или токен в профиле.', 'auth');
    if (this.profile.auth === 'token') { this.access = this.secret.credential; return; }
    const body = Buffer.from(JSON.stringify({ username: this.profile.username, password: this.secret.credential, provider: 'db', refresh: false }));
    const response = this.check(await this.request('/api/v1/security/login', 'POST', { 'content-type': 'application/json' }, body), 'вход');
    const token = this.json(response).access_token;
    if (typeof token !== 'string' || !token) throw new Failure('Superset не выдал токен.', 'auth');
    this.access = token;
  }

  async probe() {
    await this.authenticate();
    this.check(await this.request('/api/v1/me/'), 'профиль пользователя');
    const roles = this.json(this.check(await this.request('/api/v1/me/roles/'), 'права пользователя'));
    const data = object(roles.result ?? roles);
    const names = new Set(Array.isArray(data.roles) ? data.roles.flatMap(role => typeof role === 'string' ? [role] : [object(role).name]) : Object.keys(object(data.roles)));
    const specification = this.json(this.check(await this.request('/api/v1/_openapi'), 'спецификация API'));
    const paths = object(specification.paths);
    const declared = object(specification.info).version;
    let version = typeof declared === 'string' && /^\d+\.\d+\.\d+/.test(declared) ? declared : '';
    if (!version) {
      const health = await this.request('/version');
      if (health.status === 200 && health.type.includes('json')) {
        const versionInfo = this.json(health);
        const candidate = versionInfo.version_string ?? versionInfo.version ?? object(versionInfo.result).version;
        if (typeof candidate === 'string' && /^\d+\.\d+\.\d+/.test(candidate)) version = candidate;
      }
    }
    if (!version) {
      const welcome = await this.request('/superset/welcome/');
      const match = /(?:&quot;|")version_string(?:&quot;|")\s*:\s*(?:&quot;|")(\d+\.\d+\.\d+(?:[-+.][\w.-]+)?)/.exec(welcome.body.toString());
      if (match) version = match[1];
    }
    return { version, apiVersion: typeof declared === 'string' ? declared : '', admin: names.has('Admin'),
      export: Boolean(object(paths[exportPath]).get), import: Boolean(object(paths[importPath]).post) };
  }

  async supportsImport() {
    const probe = await this.probe();
    if (!probe.admin) throw new Failure('Для подтверждения полного доступа к импорту и проверке объектов нужна роль Admin.', 'permission');
    if (!probe.import || !probe.export) throw new Failure('Стенд не объявляет штатный импорт и экспорт assets.', 'compatibility');
    if (probe.version !== '6.1.0') throw new Failure('Импорт доступен для Superset 6.1.0. Стенд сообщает: ' + (probe.version || 'версия не определена') + '.', 'compatibility');
    return { version: probe.version };
  }
  async download() {
    const probe = await this.probe();
    if (!probe.admin || !probe.export) throw new Failure('Для подтверждения полноты экспорта нужны assets/export и роль Admin.', 'permission');
    const response = this.check(await this.request(exportPath), 'экспорт assets');
    return unpack(response.body);
  }
  async upload(files: Files, connections: Record<string, string>) {
    await this.authenticate();
    const csrf = this.json(this.check(await this.request('/api/v1/security/csrf_token/'), 'получение CSRF')).result;
    if (typeof csrf !== 'string' || !csrf) throw new Failure('Superset не выдал CSRF-токен.', 'auth');
    const { output, passwords } = materialize(files, connections);
    const archive = await pack(output);
    const boundary = 'mgit-' + randomUUID();
    const form = Buffer.concat([
      Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="bundle"; filename="assets.zip"\r\nContent-Type: application/zip\r\n\r\n'),
      archive,
      Buffer.from('\r\n--' + boundary + '\r\nContent-Disposition: form-data; name="passwords"\r\n\r\n' + JSON.stringify(passwords) + '\r\n--' + boundary + '--\r\n')
    ]);
    try {
      const response = this.check(await this.request(importPath, 'POST', {
        'content-type': 'multipart/form-data; boundary=' + boundary, 'x-csrftoken': csrf, referer: this.base + '/'
      }, form), 'импорт assets');
      if (this.json(response).message !== 'OK') throw new Failure('Superset не подтвердил результат импорта.', 'format');
    } catch (error) {
      if (error instanceof Failure && ['auth', 'permission', 'compatibility'].includes(error.code)) throw error;
      throw new Failure('Superset не подтвердил импорт. Проверьте целевой стенд перед повторным запуском.', 'import-unknown');
    }
  }

  async snapshot() { return normalizeExport(await this.download()); }
}
