import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { Failure, Files } from './model';
import { assetPath, inspectExport, maxBytes, safePath } from './snapshot';
import type { BranchAction, CommitAction, GitCommit, GitCommitFile, WorkingFile } from './public';

const run = promisify(execFile);
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
const modes = new Set(['100644', '100755']);

async function git(cwd: string, args: string[], diffExit = false) {
  try {
    const { stdout } = await run('git', ['-c', 'core.quotepath=false', ...args], {
      cwd, env, maxBuffer: maxBytes + 1024 * 1024, timeout: 120_000, windowsHide: true, encoding: 'buffer'
    });
    return stdout;
  } catch (error) {
    const e = error as { code?: string | number; stderr?: Buffer; stdout?: Buffer; killed?: boolean };
    if (diffExit && e.code === 1 && e.stdout) return e.stdout;
    const diagnostic = e.stderr?.toString() ?? '';
    let reason = 'Проверьте репозиторий, права и настройки Git.';
    if (e.code === 'ENOENT') reason = 'Установите Git и добавьте его в PATH.';
    else if (e.killed) reason = 'Истекло время ожидания или превышен лимит вывода. Проверьте состояние Git.';
    else if (/author identity unknown|unable to auto-detect email/i.test(diagnostic)) reason = 'Настройте user.name и user.email в Git.';
    else if (/not fully merged/i.test(diagnostic)) reason = 'Ветка содержит несохранённые в других ветках коммиты. Сначала выполните слияние.';
    else if (/would be overwritten/i.test(diagnostic)) reason = 'Git остановил переключение, чтобы сохранить локальные изменения.';
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
export async function openRepoRoot(path: string) {
  const selected = await fs.realpath(resolve(path));
  const root = await openRepo(selected);
  if (root !== selected) throw new Failure('Выберите корень отдельного Git-репозитория. Выбранная папка находится внутри другого репозитория.', 'git');
  return root;
}
export async function initRepo(path: string) {
  if (!path.trim()) throw new Failure('Выберите папку для репозитория.');
  const target = resolve(path);
  await fs.mkdir(target, { recursive: true });
  const existing = await openRepo(target).catch(() => undefined);
  if (existing) {
    if (existing === await fs.realpath(target)) return existing;
    throw new Failure('Выберите папку вне существующего репозитория.', 'git');
  }
  await git(target, ['init', '-b', 'main']);
  return openRepoRoot(target);
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
export async function snapshotFolders(repo: string, ref: string) {
  const sha = await resolveCommit(repo, ref);
  const paths = split((await git(repo, ['ls-tree', '-rz', '--name-only', sha])).toString('utf8'));
  const folders = new Set(paths.flatMap(path => {
    const match = /\/(?:databases|datasets|charts|dashboards|queries)\//g;
    return [...path.matchAll(match)].filter(part => assetPath(path.slice(part.index + 1))).map(part => path.slice(0, part.index));
  }));
  return paths.flatMap(path => {
    if (!path.endsWith('/metadata.yaml')) return [];
    const folder = path.slice(0, -'/metadata.yaml'.length);
    return folders.has(folder) && folder.includes('/') && folder.length <= 150 && safePath(folder) ? [folder] : [];
  });
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
  const [branch, files, refs, head] = await Promise.all([
    command(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
    workingFiles(repo),
    command(repo, ['for-each-ref', '--format=%(refname)%09%(symref)', 'refs/heads', 'refs/remotes', 'refs/tags']),
    optionalHead(repo)
  ]);
  const localBranches: string[] = [];
  const remoteBranches: string[] = [];
  const tags: string[] = [];
  for (const line of refs.split(/\r?\n/)) {
    const [ref, symbolic] = line.split('\t');
    if (symbolic) continue;
    if (ref.startsWith('refs/heads/')) localBranches.push(ref.slice('refs/heads/'.length));
    if (ref.startsWith('refs/remotes/')) remoteBranches.push(ref.slice('refs/remotes/'.length));
    if (ref.startsWith('refs/tags/')) tags.push(ref.slice('refs/tags/'.length));
  }
  if (branch && !localBranches.includes(branch)) localBranches.push(branch);
  const status = files.map(file => file.index + file.worktree + ' ' +
    (file.previousPath ? file.previousPath + ' -> ' : '') + file.path).join('\n');
  return { branch, status, files, localBranches, remoteBranches, tags, head };
}
async function workingFiles(repo: string): Promise<WorkingFile[]> {
  const fields = split((await git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).toString('utf8'));
  const files: WorkingFile[] = [];
  for (let i = 0; i < fields.length; i++) {
    const [index, worktree] = fields[i];
    const path = fields[i].slice(3);
    const previousPath = /[RC]/.test(index + worktree) ? fields[++i] : undefined;
    files.push({ path, index, worktree, ...(previousPath && { previousPath }) });
  }
  return files;
}

async function currentWorkingFile(repo: string, path: string, staged: boolean) {
  const file = (await workingFiles(repo)).find(item => item.path === path &&
    (staged ? item.index !== ' ' && item.index !== '?' : item.worktree !== ' '));
  if (!file) throw new Failure('Состояние файла изменилось. Обновите рабочее дерево.', 'git');
  return file;
}

export async function workingPatch(repo: string, path: string, staged: boolean) {
  const file = await currentWorkingFile(repo, path, staged);
  const flags = ['--no-ext-diff', '--no-textconv', '--no-color'];
  if (file.index === '?') {
    return (await git(repo, ['diff', '--no-index', ...flags, '--', '/dev/null', path], true)).toString('utf8');
  }
  const paths = file.previousPath ? [file.previousPath, file.path] : [file.path];
  return command(repo, ['--literal-pathspecs', 'diff', ...flags, ...(staged ? ['--cached'] : []), '--', ...paths]);
}

export async function stageFile(repo: string, path: string, staged: boolean) {
  const file = await currentWorkingFile(repo, path, staged);
  const status = file.index + file.worktree;
  const paths = file.previousPath && status.includes('R') ? [file.previousPath, file.path] : [file.path];
  const args = !staged ? ['add', '-A'] : await optionalHead(repo) ? ['restore', '--staged'] : ['rm', '--cached', '-f'];
  await git(repo, ['--literal-pathspecs', ...args, '--', ...paths]);
  return gitStatus(repo);
}

export async function commitStaged(repo: string, message: string, description = '') {
  if (!message.trim() || message.length > 4000) throw new Failure('Введите сообщение коммита.');
  const body = description.trim();
  await git(repo, ['commit', '-m', message.trim(), ...(body ? ['-m', body] : [])]);
  return gitStatus(repo);
}
export async function gitDiff(repo: string) {
  const flags = ['--no-ext-diff', '--no-textconv', '--no-color'];
  const [staged, unstaged] = await Promise.all([
    command(repo, ['diff', ...flags, '--cached']),
    command(repo, ['diff', ...flags])
  ]);
  return { staged, unstaged };
}

const commitSha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const historyPageSize = 200;

export async function gitLog(repo: string, ref: string | undefined, offset: number) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Failure('Неверное смещение истории.');
  const revisions = ref ? [await resolveCommit(repo, ref)] : ['--branches', '--remotes', '--tags'];
  if (!ref && await optionalHead(repo)) revisions.push('HEAD');
  const args = ['log', '--topo-order', '--decorate=full', '--no-notes', '--no-show-signature', '-z',
    '--format=%H%x00%P%x00%D%x00%an%x00%aI%x00%s', '--skip=' + offset,
    '--max-count=' + (historyPageSize + 1), ...revisions, '--'];
  const fields = (await git(repo, args)).toString('utf8').split('\0');
  const commits: GitCommit[] = [];
  for (let index = 0; index + 5 < fields.length; index += 6) {
    const [sha, parents, refs, author, date, subject] = fields.slice(index, index + 6);
    commits.push({ sha, parents: parents.split(' ').filter(Boolean), refs: refs ? refs.split(', ') : [], author, date, subject });
  }
  return { commits: commits.slice(0, historyPageSize), more: commits.length > historyPageSize };
}

async function commitDiffArgs(repo: string, sha: string) {
  if (!commitSha.test(sha)) throw new Failure('Укажите полный SHA коммита.');
  const parents = await command(repo, ['show', '--no-notes', '--no-show-signature', '-s', '--format=%P', sha, '--']);
  const firstParent = parents.split(' ')[0];
  const revisions = firstParent ? [firstParent, sha] : [sha];
  return { flags: ['diff-tree', '--root', '--no-commit-id', '-r',
    '--no-ext-diff', '--no-textconv', '--no-color', '-M'], revisions };
}

export async function commitFiles(repo: string, sha: string) {
  const { flags, revisions } = await commitDiffArgs(repo, sha);
  const [message, listing] = await Promise.all([
    command(repo, ['show', '--no-notes', '--no-show-signature', '-s', '--format=%B', sha, '--']),
    git(repo, [...flags, '--name-status', '-z', ...revisions, '--'])
  ]);
  const fields = split(listing.toString('utf8'));
  const files: GitCommitFile[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    const path = fields[index++];
    if (/^[RC]/.test(status)) files.push({ status, previousPath: path, path: fields[index++] });
    else files.push({ status, path });
  }
  return { message, files };
}

export async function commitPatch(repo: string, sha: string, paths: string[]) {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 2 ||
      paths.some(path => typeof path !== 'string' || !path || path.includes('\0'))) {
    throw new Failure('Выберите файл коммита.');
  }
  const { flags, revisions } = await commitDiffArgs(repo, sha);
  return (await git(repo, ['--literal-pathspecs', ...flags, '-p', ...revisions, '--', ...paths])).toString('utf8');
}
export async function saveCommitPatch(repo: string, sha: string) {
  const { flags, revisions } = await commitDiffArgs(repo, sha);
  return git(repo, [...flags, '-p', '--binary', '--full-index', ...revisions, '--']);
}

export async function compareCommit(repo: string, sha: string) {
  const target = await resolveCommitSelection(repo, sha);
  return command(repo, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', target, '--']);
}

async function resolveCommitSelection(repo: string, sha: string) {
  if (!commitSha.test(sha)) throw new Failure('Укажите полный SHA коммита.');
  return resolveCommit(repo, sha);
}

export async function copyCommitText(repo: string, sha: string, full: boolean) {
  const target = await resolveCommitSelection(repo, sha);
  return full ? command(repo, ['show', '-s', '--no-notes', '--no-show-signature', '--format=fuller', target, '--']) : target;
}

export async function commitAction(repo: string, input: CommitAction) {
  const target = await resolveCommitSelection(repo, input.sha);
  const { action } = input;
  if (action === 'create' || action === 'tag') {
    if (!input.name || input.name.startsWith('-') || input.name.startsWith('@{')) throw new Failure('Укажите допустимое имя.');
    if (action === 'create') {
      await git(repo, ['check-ref-format', '--branch', input.name]);
      await git(repo, ['branch', '--', input.name, target]);
    } else await git(repo, ['tag', '--', input.name, target]);
    return gitStatus(repo);
  }
  const state = await gitStatus(repo);
  if (!state.head || state.head !== input.head || state.branch !== input.current) {
    throw new Failure('Текущая ветка или HEAD изменились. Откройте меню коммита заново.', 'git');
  }
  const paths = await ensureNoGitOperation(repo);
  if (action === 'reset') {
    if (!state.branch || !['soft', 'mixed', 'hard'].includes(input.mode)) throw new Failure('Выберите ветку и режим сброса.');
    await git(repo, ['reset', '--' + input.mode, target]);
  } else if (action === 'checkout') {
    await git(repo, ['switch', '--detach', target]);
  } else if (action === 'cherry-pick' || action === 'revert' || action === 'rebase') {
    if (!state.branch || state.status) throw new Failure('Переключитесь на локальную ветку и сохраните изменения в рабочем дереве.', 'dirty');
    const parents = (await command(repo, ['show', '-s', '--format=%P', target, '--'])).split(' ').filter(Boolean);
    const parent = input.action === 'cherry-pick' || input.action === 'revert' ? input.parent : undefined;
    if (action !== 'rebase' && parents.length > 1 && (!parent || !Number.isInteger(parent) || parent > parents.length || parent < 1)) {
      throw new Failure('Выберите родителя коммита слияния.');
    }
    const args = action === 'rebase' ? ['rebase', '--no-autostash', '--no-update-refs', target]
      : [action, '--no-edit', ...(parents.length > 1 ? ['-m', String(parent)] : []), target];
    await runWithAbort(repo, args, paths);
  } else throw new Failure('Неизвестное действие с коммитом.');
  return gitStatus(repo);
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
export async function branchAction(repo: string, input: BranchAction) {
  const { ref, action } = input;
  const state = await gitStatus(repo);
  const local = state.localBranches.find(name => 'refs/heads/' + name === ref);
  const remote = state.remoteBranches.find(name => 'refs/remotes/' + name === ref);
  if (!local && !remote) throw new Failure('Ветка больше не доступна.', 'git');
  if (action === 'merge' || action === 'rebase') {
    await integrateBranch(repo, input, state);
  } else if (action === 'tag') {
    if (!input.name || input.name.startsWith('-')) throw new Failure('Укажите имя тега.');
    await git(repo, ['tag', '--', input.name, ref]);
  } else if (action === 'create' || action === 'rename') {
    if (!input.name || input.name.startsWith('-') || input.name.startsWith('@{')) throw new Failure('Укажите имя локальной ветки.');
    await git(repo, ['check-ref-format', '--branch', input.name]);
    if (action === 'create') await git(repo, ['switch', '-c', input.name, ...(state.head || remote ? [ref] : [])]);
    else if (local) await git(repo, ['branch', '-m', '--', local, input.name]);
    else throw new Failure('Переименование доступно для локальной ветки.');
  } else if (action === 'delete') {
    if (!local || local === state.branch) throw new Failure('Для удаления выберите другую локальную ветку.');
    await git(repo, ['branch', '-d', '--', local]);
  } else if (action === 'switch') {
    if (local) {
      if (local !== state.branch) await git(repo, ['switch', '--no-guess', '--', local]);
    } else {
      const name = (await command(repo, ['remote'])).split(/\r?\n/)
        .filter(name => remote?.startsWith(name + '/')).sort((a, b) => b.length - a.length)[0];
      if (!name || !remote) throw new Failure('Удалённый репозиторий ветки не настроен.');
      const branch = remote.slice(name.length + 1);
      if (!state.localBranches.includes(branch)) await git(repo, ['switch', '--track', '-c', branch, ref]);
      else {
        const upstream = await command(repo, ['rev-parse', '--symbolic-full-name', '--verify', branch + '@{upstream}']).catch(() => '');
        if (upstream !== ref) throw new Failure('Одноимённая локальная ветка уже существует. Выберите её в списке локальных веток.');
        if (branch !== state.branch) await git(repo, ['switch', '--no-guess', '--', branch]);
      }
    }
  } else throw new Failure('Неизвестное действие с веткой.');
  return gitStatus(repo);
}
async function integrateBranch(repo: string, input: Extract<BranchAction, { action: 'merge' | 'rebase' }>, state: Awaited<ReturnType<typeof gitStatus>>) {
  const { action, ref } = input;
  if (!state.branch || !state.head || state.branch !== input.current || state.head !== input.head) {
    throw new Failure('Текущая ветка или её коммит изменились. Откройте меню ветки заново.', 'git');
  }
  if (ref === 'refs/heads/' + state.branch) throw new Failure('Выберите другую ветку.', 'git');
  if (state.status) throw new Failure('Сохраните изменения в рабочем дереве перед слиянием или rebase.', 'dirty');
  const paths = await ensureNoGitOperation(repo);
  const target = await resolveCommit(repo, ref);
  await runWithAbort(repo, action === 'merge' ? ['merge', '--no-edit', target] : ['rebase', '--no-autostash', '--no-update-refs', target], paths);
}

async function gitPathExists(repo: string, path: string) {
  try { await fs.stat(resolve(repo, path)); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function ensureNoGitOperation(repo: string) {
  const markers = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer'];
  const paths = (await command(repo, ['rev-parse', ...markers.flatMap(marker => ['--git-path', marker])])).split(/\r?\n/);
  if ((await Promise.all(paths.map(path => gitPathExists(repo, path)))).some(Boolean)) {
    throw new Failure('Завершите текущую операцию Git перед продолжением.', 'git');
  }
  return paths;
}

async function runWithAbort(repo: string, args: string[], paths: string[]) {
  const [action] = args;
  try {
    await git(repo, args);
  } catch (error) {
    const operationPaths = action === 'merge' ? paths.slice(0, 1) : action === 'rebase' ? paths.slice(1, 3)
      : [paths[action === 'cherry-pick' ? 3 : 4], paths[5]];
    if (!(await Promise.all(operationPaths.map(path => gitPathExists(repo, path)))).some(Boolean)) throw error;
    try { await git(repo, [action, '--abort']); }
    catch { throw new Failure('Git не смог отменить операцию. Проверьте рабочее дерево и завершите или отмените операцию в Git.', 'git'); }
    throw new Failure('Операция остановлена. Git восстановил исходное состояние.', 'git');
  }
}
export async function fetchRemote(repo: string) {
  await git(repo, ['fetch', '--all']);
  return gitStatus(repo);
}

export async function pullBranch(repo: string) {
  await assertClean(repo);
  await git(repo, ['pull', '--ff-only']);
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
    if (!entry.isFile() || !assetPath(relative)) throw new Failure('В каталоге снимка есть посторонние файлы. Выберите другой каталог.');
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
  const { head, branch } = await gitStatus(repo);
  if (!branch) throw new Failure('Переключитесь на локальную ветку.');
  if (await command(repo, ['status', '--porcelain=v1', '--untracked-files=all', '--', folder])) {
    throw new Failure('Каталог снимка содержит локальные изменения.', 'dirty');
  }
  const before = head ? await readCommit(repo, head, folder) : new Map();
  if (before.size) inspectExport(before);
  if (!sameSnapshot(before, await readWorktree(await assertParents(repo, folder)))) {
    throw new Failure('В каталоге снимка есть локальные или игнорируемые файлы.');
  }
  return { head, branch, changes: compare(before, files) };
}
export async function writeSnapshot(repo: string, folder: string, files: Files, reviewed: { head: string; branch: string }) {
  inspectExport(files);
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
    const pending = await command(repo, ['status', '--porcelain=v1', '--untracked-files=all', '--', folder]);
    if (status.head !== reviewed.head || status.branch !== reviewed.branch || pending || !sameSnapshot(before, existing)) {
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
  if (await command(repo, ['diff', '--cached', '--name-only', '--', folder])) throw new Failure('В индексе уже есть изменения снимка. Сохраните их отдельно.');
  const files = await readWorktree(await assertParents(repo, folder));
  inspectExport(files);
  if (!sameSnapshot(files, reviewed.files)) throw new Failure('Снимок изменился после экспорта.');
  await git(repo, ['add', '--intent-to-add', '--', folder]);
  await git(repo, ['diff', '--check', '--', folder]);
  await git(repo, ['commit', '--only', '-m', message, '--', folder]);
  return gitStatus(repo);
}
