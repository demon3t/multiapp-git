#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { promises as fs } from 'node:fs';
import { Environment, Failure, object, Profile, profileUrl, uuidPattern } from './core/model';
import * as git from './core/git';
import { assertValid, summarize } from './core/snapshot';
import { Superset } from './core/superset';
import { applyImport, exportSnapshot, planImport, sourceSnapshot, verifyImport } from './core/workflow';

const help = [
  'mGit export|validate|plan|import|verify --repo PATH --folder snapshots/test/assets --commit SHA',
  'Network operations: --target URL --environment DEV|TEST|PREPROD|PROD [--name NAME] [--ca PEM]',
  'export: [--select UUID,UUID] [--write]    import: --apply [--confirm TEXT] [--backup PATH]',
  'Credentials: MGIT_TOKEN or MGIT_USERNAME and MGIT_PASSWORD. Mappings: MGIT_CONNECTIONS_JSON.'
].join('\n');

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!action || ['--help', '-h'].includes(action)) { process.stdout.write(help + '\n'); return; }
  if (!['export', 'validate', 'plan', 'import', 'verify'].includes(action)) throw new Failure('Неизвестная команда.', 'usage');
  const { values } = parseArgs({ args, options: {
    repo: { type: 'string' }, folder: { type: 'string' }, commit: { type: 'string' },
    target: { type: 'string' }, environment: { type: 'string' }, name: { type: 'string' }, ca: { type: 'string' },
    write: { type: 'boolean' }, apply: { type: 'boolean' }, select: { type: 'string' }, confirm: { type: 'string' }, backup: { type: 'string' }
  } });
  if (!values.repo || !values.folder || !values.commit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(values.commit)) {
    throw new Failure('Укажите --repo, --folder и полный --commit SHA.', 'usage');
  }
  if (action === 'import' && !values.apply) throw new Failure('Для запуска импорта добавьте --apply.', 'usage');
  const repo = await git.openRepo(values.repo);
  const commit = values.commit.toLowerCase();
  const source = () => sourceSnapshot(repo, commit, values.folder!);
  let data: unknown;
  if (action === 'validate') {
    const snapshot = await source();
    data = { sha: snapshot.sha, counts: summarize(assertValid(snapshot.files)) };
  } else {
    if (!values.target || !values.environment || !['DEV', 'TEST', 'PREPROD', 'PROD'].includes(values.environment)) {
      throw new Failure('Укажите --target и --environment.', 'usage');
    }
    const url = profileUrl(values.target);
    const token = process.env.MGIT_TOKEN;
    const username = process.env.MGIT_USERNAME;
    if (!token && !username) throw new Failure('Укажите MGIT_USERNAME или MGIT_TOKEN.', 'usage');
    if (action === 'import' && values.environment === 'PROD' && !values.name) throw new Failure('Для PROD укажите --name.', 'usage');
    const profile: Profile = { id: 'cli', name: values.name || url, url, environment: values.environment as Environment,
      auth: token ? 'token' : 'db', username, ca: values.ca ? await fs.readFile(resolve(values.ca), 'utf8') : undefined };
    let connections: Record<string, string>;
    try {
      const raw = object(JSON.parse(process.env.MGIT_CONNECTIONS_JSON || '{}'));
      connections = Object.fromEntries(Object.entries(raw).map(([id, value]) => {
        if (!uuidPattern.test(id) || typeof value !== 'string') throw new Error();
        return [id.toLowerCase(), value];
      }));
    } catch { throw new Failure('MGIT_CONNECTIONS_JSON должен содержать объект UUID → SQLAlchemy URI.', 'usage'); }
    const adapter = new Superset(profile, { credential: token || process.env.MGIT_PASSWORD || '', connections });
    if (action === 'export') {
      if (await git.resolveCommit(repo, 'HEAD') !== commit) throw new Failure('--commit должен совпадать с HEAD выбранной ветки.');
      const exported = await exportSnapshot(adapter, values.select?.split(',').filter(Boolean) ?? []);
      const preview = await git.previewWrite(repo, values.folder, exported.files);
      if (preview.head !== commit) throw new Failure('HEAD изменился во время экспорта.');
      if (values.write) await git.writeSnapshot(repo, values.folder, exported.files, preview);
      data = { head: preview.head, branch: preview.branch, counts: exported.counts, written: Boolean(values.write && preview.changes.length),
        changes: preview.changes.map(({ path, action }) => ({ path, action })) };
    } else {
      const snapshot = await source();
      if (action === 'import') {
        data = await applyImport(adapter, profile, snapshot.files, connections, { sha: snapshot.sha, confirm: values.confirm, backup: values.backup });
      } else if (action === 'plan') {
        const { targetState, connectionState, ...plan } = await planImport(adapter, profile, snapshot.files, connections);
        data = { sha: snapshot.sha, ...plan };
      } else {
        const result = await verifyImport(adapter, snapshot.files);
        if (!result.verified) throw new Failure('Проверка цели обнаружила расхождения.', 'verify', result);
        data = result;
      }
    }
  }
  console.log(JSON.stringify({ ok: true, action, data }));
}
void main().catch(error => {
  const usage = typeof error?.code === 'string' && error.code.startsWith('ERR_PARSE_ARGS');
  const failure = error instanceof Failure ? error : new Failure(usage ? 'Некорректные параметры. Используйте --help.' : 'Операция не завершилась. Проверьте входные файлы и права.', usage ? 'usage' : 'operation');
  console.error(JSON.stringify({ ok: false, code: failure.code, message: failure.message, details: failure.details }));
  process.exitCode = failure.code === 'usage' ? 2 : failure.code === 'validation' || failure.code === 'verify' ? 3 : failure.code === 'import-unknown' ? 4 : 1;
});
