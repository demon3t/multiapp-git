#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { promises as fs } from 'node:fs';
import { Environment, Failure, object, Profile, profileUrl, uuidPattern } from './core/model';
import * as git from './core/git';
import { prepareSnapshot, summarize } from './core/snapshot';
import { Superset } from './core/superset';
import { restore } from './core/restore';
import { applyImport, exportSnapshot, planImport, sourceSnapshot, verifyImport } from './core/workflow';

const help = [
  'mGit export|validate|plan|import|verify --repo PATH --folder snapshots/test/assets --commit SHA',
  'Network operations: --target URL --environment DEV|TEST|PREPROD|PROD [--name NAME] [--ca PEM]',
  'export: [--select UUID,UUID] [--write]    import: --apply [--confirm TEXT] [--backup PATH]',
  'validate|plan|import|verify: [--compatible-only]',
  'restore --repo PATH --folder PATH [--ref BRANCH] --adapter FILE --adapter-sha256 SHA256 --target-name NAME --owner USER',
  'restore: [--python PATH] [--source-orphans FILE] [--log FILE] [--apply | --verify-only]',
  'Credentials: MGIT_TOKEN or MGIT_USERNAME and MGIT_PASSWORD. Mappings: MGIT_CONNECTIONS_JSON.'
].join('\n');

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!action || ['--help', '-h'].includes(action)) { process.stdout.write(help + '\n'); return; }
  if (!['export', 'validate', 'plan', 'import', 'verify', 'restore'].includes(action)) throw new Failure('Неизвестная команда.', 'usage');
  const { values } = parseArgs({ args, options: {
    repo: { type: 'string' }, folder: { type: 'string' }, commit: { type: 'string' },
    target: { type: 'string' }, environment: { type: 'string' }, name: { type: 'string' }, ca: { type: 'string' },
    write: { type: 'boolean' }, apply: { type: 'boolean' }, select: { type: 'string' }, confirm: { type: 'string' }, backup: { type: 'string' },
    'compatible-only': { type: 'boolean' }, ref: { type: 'string' },
    adapter: { type: 'string' }, 'adapter-sha256': { type: 'string' }, python: { type: 'string' },
    'target-name': { type: 'string' }, owner: { type: 'string' }, 'source-orphans': { type: 'string' },
    'verify-only': { type: 'boolean' }, log: { type: 'string' }
  } });
  if (action === 'restore') {
    const checksum = values['adapter-sha256'];
    const target = values['target-name'];
    if (!values.repo || !values.folder || !values.adapter || !checksum || !/^[a-f0-9]{64}$/i.test(checksum) ||
        !target?.trim() || !values.owner?.trim() || (values.apply && values['verify-only']) ||
        values.commit || values['compatible-only']) {
      throw new Failure('Проверьте параметры restore. Используйте --help.', 'usage');
    }
    const data = await restore({
      repo: await git.openRepoRoot(values.repo), ref: values.ref ?? 'HEAD', folder: values.folder,
      adapter: values.adapter, adapterSha256: checksum, python: values.python ?? 'python',
      target, owner: values.owner, orphans: values['source-orphans'], log: values.log,
      apply: values.apply, verifyOnly: values['verify-only']
    });
    console.log(JSON.stringify({ ok: true, action, data }));
    return;
  }
  if (values.ref !== undefined || values.adapter || values['adapter-sha256'] || values.python || values['target-name'] ||
      values.owner || values['source-orphans'] || values['verify-only'] || values.log) {
    throw new Failure('Параметры адаптера доступны в команде restore.', 'usage');
  }
  if (!values.repo || !values.folder || !values.commit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(values.commit)) {
    throw new Failure('Укажите --repo, --folder и полный --commit SHA.', 'usage');
  }
  if (action === 'import' && !values.apply) throw new Failure('Для запуска импорта добавьте --apply.', 'usage');
  if (action === 'export' && values['compatible-only']) throw new Failure('--compatible-only применяется к снимку из Git.', 'usage');
  const repo = await git.openRepo(values.repo);
  const commit = values.commit.toLowerCase();
  const source = async () => {
    const snapshot = await sourceSnapshot(repo, commit, values.folder!);
    return { sha: snapshot.sha, ...prepareSnapshot(snapshot.files, values['compatible-only']) };
  };
  const exclusions = (excluded: Awaited<ReturnType<typeof source>>['excluded']) => values['compatible-only'] ? { excluded } : {};
  let data: unknown;
  if (action === 'validate') {
    const snapshot = await source();
    data = { sha: snapshot.sha, counts: summarize(snapshot.assets), ...exclusions(snapshot.excluded) };
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
      data = { head: preview.head, branch: preview.branch, counts: exported.counts, issues: exported.issues, written: Boolean(values.write && preview.changes.length),
        changes: preview.changes.map(({ path, action }) => ({ path, action })) };
    } else {
      const snapshot = await source();
      if (action === 'import') {
        const result = await applyImport(adapter, profile, snapshot.files, connections, { sha: snapshot.sha, confirm: values.confirm, backup: values.backup });
        data = { ...result, ...exclusions(snapshot.excluded) };
      } else if (action === 'plan') {
        const { targetState, connectionState, ...plan } = await planImport(adapter, profile, snapshot.files, connections);
        data = { sha: snapshot.sha, ...plan, ...exclusions(snapshot.excluded) };
      } else {
        const result = await verifyImport(adapter, snapshot.files);
        if (!result.verified) throw new Failure('Проверка цели обнаружила расхождения.', 'verify', result);
        data = { ...result, ...exclusions(snapshot.excluded) };
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
