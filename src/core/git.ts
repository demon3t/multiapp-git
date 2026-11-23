import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { Failure, Files } from './model';
import { assetPath, assertValid, maxBytes, maxFiles, safePath } from './snapshot';

const run = promisify(execFile);
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
const modes = new Set(['100644', '100755']);

async function git(cwd: string, args: string[]) {
  try {
    const { stdout } = await run('git', ['-c', 'core.quotepath=false', ...args], {
      cwd, env, maxBuffer: maxBytes + 1024 * 1024, timeout: 120_000, windowsHide: true, encoding: 'buffer'
    });
    return stdout;
  } catch (error) {
    const e = error as { code?: string | number; stderr?: Buffer; killed?: boolean };
    const diagnostic = e.stderr?.toString() ?? '';
    let reason = 'Проверьте репозиторий, права и настройки Git.';
    if (e.code === 'ENOENT') reason = 'Установите Git и добавьте его в PATH.';
    else if (e.killed) reason = 'Истекло время ожидания или превышен лимит вывода. Проверьте состояние Git.';
    else if (/author identity unknown|unable to auto-detect email/i.test(diagnostic)) reason = 'Настройте user.name и user.email в Git.';
    else if (/non-fast-forward|fetch first/i.test(diagnostic)) reason = 'Удалённая ветка изменилась. Выполните fetch и согласуйте историю.';
    else if (/authentication|permission denied|credential/i.test(diagnostic)) reason = 'Проверьте доступ и Git Credential Manager.';
    throw new Failure('Git ' + args[0] + ': ' + reason, 'git');
  }
}
const command = async (repo: string, args: string[]) => (await git(repo, args)).toString('utf8').trimEnd();
const split = (text: string) => text.split('\0').filter(Boolean);
export function snapshotPath(path: string) {
  if (!safePath(path) || path.split('/').length < 2 || path.length > 150) {
    throw new Failure('Укажите вложенный каталог снимка, например snapshots/test/assets.');
  }
  return path;
}
export async function openRepo(path: string) {
  const root = (await command(resolve(path), ['rev-parse', '--show-toplevel'])).trimEnd();
  return fs.realpath(root);
}
export async function cloneRepo(url: string, folder: string) {
  let remote: URL;
  try { remote = new URL(url); } catch { throw new Failure('Укажите HTTPS URL Git.'); }
  if (remote.protocol !== 'https:' || remote.username || remote.password || remote.search || remote.hash) {
    throw new Failure('Укажите HTTPS URL Git без учётных данных и параметров.');
  }
  const target = resolve(folder);
  await git(dirname(target), ['clone', '--', remote.href, target]);
  return openRepo(target);
}
export async function resolveCommit(repo: string, ref: string) {
  if (!ref.trim() || ref.startsWith('-') || /[\0\r\n]/.test(ref)) throw new Failure('Укажите ветку, тег или commit SHA.');
  return command(repo, ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}']);
}
async function optionalHead(repo: string) {
  const refs = await command(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads']);
  const head = await command(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', 'HEAD']).catch(() => '');
  if (head) return resolveCommit(repo, 'HEAD');
  const symbolic = await command(repo, ['symbolic-ref', 'HEAD']);
  if (refs.split('\n').includes(symbolic)) throw new Failure('Git не смог прочитать HEAD.', 'git');
  return '';
}
export async function gitStatus(repo: string) {
  const [branch, status, branches, head] = await Promise.all([
    command(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
    command(repo, ['status', '--porcelain=v1', '--untracked-files=all']),
    command(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes', 'refs/tags']),
    optionalHead(repo)
  ]);
  return { branch, status, branches: branches ? branches.split(/\r?\n/) : [], head };
}
export async function gitDiff(repo: string) {
  const flags = ['--no-ext-diff', '--no-textconv', '--no-color'];
  const [staged, unstaged] = await Promise.all([
    command(repo, ['diff', ...flags, '--cached']),
    command(repo, ['diff', ...flags])
  ]);
  return { staged, unstaged };
}
async function assertClean(repo: string) {
  const status = await gitStatus(repo);
  if (status.status) throw new Failure('Рабочее дерево содержит изменения. Сохраните их перед операцией.', 'dirty');
  if (!status.branch) throw new Failure('Переключитесь на локальную ветку.');
  return status;
}
export async function changeBranch(repo: string, branch: string, create: boolean) {
  await assertClean(repo);
  if (branch.startsWith('-') || branch.startsWith('@{')) throw new Failure('Укажите имя локальной ветки.');
  await git(repo, ['check-ref-format', '--branch', branch]);
  await git(repo, create ? ['switch', '-c', branch] : ['switch', '--no-guess', '--', branch]);
  return gitStatus(repo);
}
export async function fetchRemote(repo: string) {
  await git(repo, ['fetch', '--all']);
  return gitStatus(repo);
}
export async function pushBranch(repo: string) {
  const { branch } = await gitStatus(repo);
  if (!branch) throw new Failure('Выберите локальную ветку для push.');
  await git(repo, ['push', '--set-upstream', 'origin', 'refs/heads/' + branch + ':refs/heads/' + branch]);
  return gitStatus(repo);
}

export async function readCommit(repo: string, sha: string, folder: string): Promise<Files> {
  snapshotPath(folder);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) throw new Failure('Нужен полный commit SHA.');
  const files: Files = new Map();
  const listing = split((await git(repo, ['ls-tree', '-rz', sha, '--', folder])).toString('utf8'));
  if (listing.length > maxFiles) throw new Failure('Снимок слишком большой.');
  if (!listing.length) return files;
  const entries = listing.map(entry => {
    const tab = entry.indexOf('\t');
    const [mode, type, hash] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    const file = path.slice(folder.length + 1);
    if (!path.startsWith(folder + '/') || !assetPath(file) || !modes.has(mode) || type !== 'blob') {
      throw new Failure('В commit есть неожиданный файл, ссылка или вложенный репозиторий.', 'format');
    }
    return { file, hash };
  });
  const children = execFile('git', ['cat-file', '--batch'], { cwd: repo, env, encoding: 'buffer', maxBuffer: maxBytes + 1024 * 1024, timeout: 90_000, windowsHide: true });
  const output = new Promise<Buffer>((resolve, reject) => {
    let length = 0;
    const chunks: Buffer[] = [];
    children.stdout!.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > maxBytes + 1024 * 1024) { children.kill(); return; }
      chunks.push(chunk);
    });
    children.stdin!.on('error', () => undefined);
    children.on('error', reject);
    children.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Failure('Git не смог прочитать объекты снимка.', 'git')));
    children.stdin!.end(entries.map(entry => entry.hash).join('\n') + '\n');
  });
  const bytes = await output;
  let cursor = 0;
  let total = 0;
  for (const entry of entries) {
    const eol = bytes.indexOf(10, cursor);
    const parts = bytes.toString('ascii', cursor, eol).split(' ');
    const size = Number(parts[2]);
    total += size;
    if (eol < 0 || parts[0] !== entry.hash || parts[1] !== 'blob' || !Number.isSafeInteger(size) ||
        size < 0 || total > maxBytes || bytes[eol + size + 1] !== 10) throw new Failure('Некорректный вывод Git или слишком большой снимок.', 'git');
    try { files.set(entry.file, new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(eol + 1, eol + 1 + size)).replace(/\r\n/g, '\n')); }
    catch { throw new Failure('Файл снимка должен быть в UTF-8.', 'format'); }
    cursor = eol + size + 2;
  }
  return files;
}
export type Change = { path: string; action: 'add' | 'remove' | 'update'; before?: string; after?: string };
export function compare(before: Files, after: Files): Change[] {
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(path => {
    const oldText = before.get(path);
    const newText = after.get(path);
    return oldText === newText ? [] : [{ path, action: oldText === undefined ? 'add' : newText === undefined ? 'remove' : 'update', before: oldText, after: newText }];
  });
}
async function assertParents(repo: string, folder: string) {
  let current = repo;
  for (const part of folder.split('/')) {
    current = join(current, part);
    const stat = await fs.lstat(current).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return undefined;
      throw e;
    });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Failure('Каталог снимка проходит через ссылку или обычный файл.');
  }
  return current;
}
async function readWorktree(path: string, prefix = '', files: Files = new Map(), size = { bytes: 0 }): Promise<Files> {
  const entries = await fs.readdir(path, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT' && !prefix) return [];
    throw e;
  });
  for (const entry of entries) {
    const relative = prefix + entry.name;
    const full = join(path, entry.name);
    if (!safePath(relative) || entry.isSymbolicLink()) throw new Failure('В каталоге снимка обнаружен неожиданный файл или ссылка.');
    if (entry.isDirectory() && /^(databases|datasets|charts|dashboards|queries)(\/[^/]+){0,2}$/.test(relative)) {
      await readWorktree(full, relative + '/', files, size);
      continue;
    }
    if (!entry.isFile() || !assetPath(relative) || files.size >= maxFiles) throw new Failure('В каталоге снимка есть посторонние файлы. Выберите другой каталог.');
    size.bytes += (await fs.stat(full)).size;
    if (size.bytes > maxBytes) throw new Failure('Снимок слишком большой.');
    files.set(relative, (await fs.readFile(full, 'utf8')).replace(/\r\n/g, '\n'));
  }
  return files;
}
function sameSnapshot(before: Files, after: Files) {
  return !compare(before, after).length;
}
export async function previewWrite(repo: string, folder: string, files: Files) {
  snapshotPath(folder);
  const { head, branch } = await assertClean(repo);
  const before = head ? await readCommit(repo, head, folder) : new Map();
  if (before.size) assertValid(before);
  if (!sameSnapshot(before, await readWorktree(await assertParents(repo, folder)))) {
    throw new Failure('В каталоге снимка есть локальные или игнорируемые файлы.');
  }
  return { head, branch, changes: compare(before, files) };
}
export async function writeSnapshot(repo: string, folder: string, files: Files, reviewed: { head: string; branch: string }) {
  assertValid(files);
  const review = await previewWrite(repo, folder, files);
  if (review.head !== reviewed.head || review.branch !== reviewed.branch) throw new Failure('Ветка или HEAD изменились. Повторите просмотр.');
  if (!review.changes.length) return review;
  const target = await assertParents(repo, folder);
  const parent = dirname(target);
  await fs.mkdir(parent, { recursive: true });
  const stage = await fs.mkdtemp(join(parent, '.mgit-stage-'));
  const backup = join(parent, '.mgit-backup-' + randomUUID());
  let backedUp = false;
  try {
    for (const [path, text] of files) {
      const destination = join(stage, path);
      await fs.mkdir(dirname(destination), { recursive: true });
      await fs.writeFile(destination, text, { flag: 'wx' });
    }
    const status = await gitStatus(repo);
    const existing = await readWorktree(target);
    const before = reviewed.head ? await readCommit(repo, reviewed.head, folder) : new Map();
    const pending = split((await git(repo, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'])).toString('utf8'));
    const stagePrefix = folder.slice(0, folder.lastIndexOf('/') + 1) + stage.slice(parent.length + 1) + '/';
    if (status.head !== reviewed.head || status.branch !== reviewed.branch || pending.some(line => !line.startsWith('?? ' + stagePrefix)) || !sameSnapshot(before, existing)) {
      throw new Failure('Рабочее дерево изменилось во время подготовки записи.');
    }
    try { await fs.rename(target, backup); backedUp = true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    try { await fs.rename(stage, target); }
    catch (e) {
      if (backedUp) {
        try { await fs.rename(backup, target); }
        catch { throw new Failure('Не удалось восстановить каталог снимка автоматически. Резервный каталог: ' + backup, 'git'); }
      }
      throw e;
    }
    if (backedUp) await fs.rm(backup, { recursive: true, force: true });
    return review;
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

export async function commitSnapshot(repo: string, folder: string, message: string, reviewed: { head: string; branch: string; files: Files }) {
  snapshotPath(folder);
  if (!message.trim() || message.length > 4000) throw new Failure('Введите сообщение коммита.');
  const { head, branch } = await gitStatus(repo);
  if (head !== reviewed.head || branch !== reviewed.branch) throw new Failure('HEAD изменился после экспорта.');
  if (await command(repo, ['diff', '--cached', '--name-only'])) throw new Failure('В индексе уже есть изменения. Сохраните их отдельно.');
  const files = await readWorktree(await assertParents(repo, folder));
  assertValid(files);
  if (!sameSnapshot(files, reviewed.files)) throw new Failure('Снимок изменился после экспорта.');
  await git(repo, ['add', '--intent-to-add', '--', folder]);
  await git(repo, ['commit', '--only', '-m', message, '--', folder]);
  return gitStatus(repo);
}
