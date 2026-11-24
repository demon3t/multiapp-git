import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Failure, normalizeUuid, object } from './model';
import { inspectExport } from './snapshot';
import { sourceSnapshot } from './workflow';

type Options = {
  repo: string; ref: string; folder: string; adapter: string; adapterSha256: string; python: string;
  target: string; owner: string; orphans?: string; log?: string; apply?: boolean; verifyOnly?: boolean;
};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const run = promisify(execFile);

export async function restore(options: Options) {
  const { sha, files } = await sourceSnapshot(options.repo, options.ref, options.folder);
  const { assets, issues } = inspectExport(files);
  const adapter = resolve(options.adapter);
  async function checkAdapter() {
    if (hash(await fs.readFile(adapter)) !== options.adapterSha256.toLowerCase()) {
      throw new Failure('SHA256 адаптера отличается от контрольной суммы поставки.', 'adapter');
    }
  }
  await checkAdapter();
  let bindings: Record<string, unknown>;
  try {
    const entries = Object.entries(object(JSON.parse(process.env.SUPERSET_DATABASE_BINDINGS ?? '{}')));
    bindings = Object.fromEntries(entries.map(([uuid, value]) => {
      const config = object(value);
      if (!normalizeUuid(uuid) || typeof config.sqlalchemy_uri !== 'string' || !/^[a-z][\w+.-]*:\/\/[^\r\n\0]+$/i.test(config.sqlalchemy_uri) ||
          (config.extra != null && (typeof config.extra !== 'object' || Array.isArray(config.extra)))) throw new Error();
      return [normalizeUuid(uuid), config];
    }));
    if (entries.length !== Object.keys(bindings).length) throw new Error();
  } catch {
    throw new Failure('Проверьте формат SUPERSET_DATABASE_BINDINGS.', 'mapping');
  }
  for (const asset of assets) {
    if (asset.kind === 'databases' && !Object.hasOwn(bindings, asset.uuid)) {
      throw new Failure('В SUPERSET_DATABASE_BINDINGS отсутствует UUID ' + asset.uuid + '.', 'mapping');
    }
  }
  if (!options.orphans && assets.some(asset => asset.kind === 'charts' && !normalizeUuid(asset.data.dataset_uuid))) {
    throw new Failure('Для графиков без dataset_uuid требуется source-orphans.json выбранного снимка.', 'validation', issues);
  }
  const orphans = options.orphans ? await fs.readFile(resolve(options.orphans), 'utf8') : undefined;
  if (orphans !== undefined) {
    let sourceCommit: unknown;
    try { sourceCommit = object(JSON.parse(orphans)).source_commit; } catch { /* Report the same input error below. */ }
    if (sourceCommit !== sha) throw new Failure('source_commit из source-orphans.json не совпадает с выбранным коммитом.', 'validation');
  }

  const lockPath = join(tmpdir(), 'mgit-restore-' + hash(options.target.toLowerCase()) + '.lock');
  const lock = await fs.open(lockPath, 'wx').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') throw new Failure('Для цели уже запущена установка или требуется проверка состояния. Блокировка: ' + lockPath, 'locked');
    throw error;
  });
  let retain = false;
  let staging: string | undefined;
  let log: Awaited<ReturnType<typeof fs.open>> | undefined;
  const phases: string[] = [];
  try {
    if (options.log) log = await fs.open(resolve(options.log), 'wx', 0o600);
    await lock.writeFile(JSON.stringify({ pid: process.pid, sha, target: options.target }));
    staging = await fs.mkdtemp(join(tmpdir(), 'mgit-restore-assets-'));
    const directory = join(staging, 'assets');
    for (const [path, text] of files) {
      const destination = join(directory, path);
      await fs.mkdir(dirname(destination), { recursive: true });
      await fs.writeFile(destination, text, { flag: 'wx' });
    }
    const args = [adapter, '--assets', directory, '--source-commit', sha, '--target-name', options.target, '--owner', options.owner];
    if (orphans !== undefined) {
      const path = join(staging, 'source-orphans.json');
      await fs.writeFile(path, orphans, { flag: 'wx' });
      args.push('--source-orphans', path);
    }
    async function step(phase: string, flag: string[], expected?: RegExp) {
      await checkAdapter();
      await log?.appendFile(JSON.stringify({ sha, target: options.target, phase, event: 'started' }) + '\n');
      const env = { ...process.env, SUPERSET_DATABASE_BINDINGS: JSON.stringify(bindings) };
      let output: string;
      try {
        const result = await run(options.python, [...args, ...flag], { env, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
        output = result.stdout + '\n' + result.stderr;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        await log?.appendFile(JSON.stringify({ phase, event: 'failed', code }) + '\n');
        throw new Failure('Адаптер завершил этап ' + phase + ' с ошибкой (' + (code ?? 'unknown') + ').', 'adapter');
      }
      if (expected && !expected.test(output)) {
        await log?.appendFile(JSON.stringify({ phase, event: 'unconfirmed', code: 0 }) + '\n');
        throw new Failure('Адаптер не подтвердил этап ' + phase + '.', 'adapter');
      }
      await log?.appendFile(JSON.stringify({ phase, event: 'completed', code: 0 }) + '\n');
      phases.push(phase);
    }
    if (!options.verifyOnly) await step('validate', [], /^\s*VALIDATED; no metadata imported\s*$/m);
    if (options.apply) {
      retain = true;
      await step('apply', ['--apply'], /(?:\bphase\s*=\s*verified\b|"phase"\s*:\s*"verified")/);
    }
    if (options.apply || options.verifyOnly) await step('verify', ['--verify-only']);
    retain = false;
    return { sha, phases, issues };
  } catch (error) {
    if (retain) throw new Failure((error as Error).message + ' Проверьте состояние целевой БД. Блокировка: ' + lockPath, 'import-unknown');
    throw error;
  } finally {
    try {
      await log?.close();
      if (staging) await fs.rm(staging, { recursive: true, force: true });
    } finally {
      await lock.close();
      if (!retain) await fs.unlink(lockPath);
    }
  }
}
