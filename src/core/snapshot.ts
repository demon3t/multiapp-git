import { isScalar, parse, parseDocument } from 'yaml';
import { Asset, Failure, Files, Inspection, Kind, kinds, list, normalizeUuid, object, Row } from './model';

export const maxBytes = 64 * 1024 * 1024;
const safeSegment = /^[\p{L}\p{N}_ .-]+$/u;
export function safePath(value: string) {
  return value.length <= 220 && value.split('/').every(part =>
    part.length <= 120 && safeSegment.test(part) && !/^[ .]|[ .]$/.test(part) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
const section = /^(databases|datasets|charts|dashboards|queries)(?:\/[^/]+){1,3}\.ya?ml$/;
export const assetPath = (path: string) => safePath(path) && (path === 'metadata.yaml' || section.test(path));
const names: Record<Kind, string> = { databases: 'database_name', datasets: 'table_name', charts: 'slice_name', dashboards: 'dashboard_title', queries: 'label' };
const placeholder = 'sqlite:///mgit-unconfigured.db';
const masked = (value: unknown) => value == null || value === '' || (typeof value === 'string' && /^\*{3,}$/.test(value));
const sensitive = /^(?:password|passwd|pwd|access_?token|refresh_?token|token|api_?key|secret(?:_?key)?|client_?secret|private_?key|authorization|credentials|credentials_info|cookie|ssh_tunnel|encrypted_extra|keyfile_dict|service_account|connect_args|engine_params)$/i;
const credentialValue = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:gh[pousr]_[a-z0-9]{16,}|github_pat_[a-z0-9_]{16,})\b|\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+|\b[a-z][a-z0-9+.-]*:\/\/[^\s/"']+:[^\s/"']+@|\b(?:password|passwd|pwd|token|secret|api_key)\s*[=:]\s*["']?[^*'"\s,;&}]+/i;
export function redactDatabase(source: string) {
  const doc = parseDocument(source);
  if (doc.errors.length || !doc.has('uuid')) throw new Failure('Некорректный YAML подключения.', 'format');
  doc.set('sqlalchemy_uri', 'REDACTED');
  for (const key of Object.keys(object(doc.toJS({ maxAliasCount: 0 })))) {
    if (sensitive.test(key) || /^(?:extra|masked_encrypted_extra|server_cert|parameters|ssh_.*|client_cert|client_key)$/i.test(key)) doc.delete(key);
  }
  doc.set('extra', {});
  return doc.toString({ lineWidth: 0 });
}
function hasSecret(value: unknown, depth = 0): boolean {
  if (depth > 45) return true;
  if (typeof value === 'string') {
    if (credentialValue.test(value)) return true;
    if (/^\s*[{[]/.test(value)) {
      try { return hasSecret(JSON.parse(value), depth + 1); } catch { return false; }
    }
    return false;
  }
  if (Array.isArray(value)) return value.some(child => hasSecret(child, depth + 1));
  return Object.entries(object(value)).some(([key, child]) => {
    const empty = child && typeof child === 'object' && Object.keys(child).length === 0;
    const serializedEmpty = typeof child === 'string' && /^\s*(?:\{\s*\}|\[\s*\]|null)\s*$/.test(child);
    return (sensitive.test(key) && !masked(child) && !empty && !serializedEmpty) || hasSecret(child, depth + 1);
  });
}

export function inspect(files: Files): Inspection {
  const result: Inspection = { assets: [], issues: [] };
  const { assets, issues } = result;
  const paths = new Set<string>();
  const byId = new Map<string, Asset>();
  const expected = new Map<Asset, [unknown, Kind, string][]>();
  if (!files.has('metadata.yaml')) issues.push({ path: 'metadata.yaml', message: 'Нет metadata.yaml.' });
  if ([...files.values()].reduce((size, text) => size + Buffer.byteLength(text), 0) > maxBytes) {
    issues.push({ path: '', message: 'Снимок превышает допустимый размер.' });
    return result;
  }
  for (const [path, source] of files) {
    if (!assetPath(path) || paths.has(path.toLowerCase())) {
      issues.push({ path: '[путь скрыт]', message: 'Неожиданный файл или совпадение путей без учёта регистра.' });
      continue;
    }
    paths.add(path.toLowerCase());
    try {
      const data = object(parse(source, { maxAliasCount: 0 }));
      if (hasSecret(data) || credentialValue.test(path)) {
        issues.push({ path: '[путь скрыт]', message: 'Обнаружены возможные секреты или неподдерживаемые параметры подключения.' });
        continue;
      }
      if (path === 'metadata.yaml') {
        if (data.version !== '1.0.0' || data.type !== 'assets') issues.push({ path, message: 'Ожидается формат Superset assets 1.0.0.' });
        continue;
      }
      const kind = path.split('/')[0] as Kind;
      const uuid = normalizeUuid(data.uuid);
      const name = kind === 'queries' && (data.label == null || data.label === '') ? path.split('/').at(-1)! : data[names[kind]];
      if (!uuid || typeof name !== 'string' || !name.trim() || data.version !== '1.0.0') {
        issues.push({ path, message: 'Нет корректного UUID, имени объекта или версии 1.0.0.' });
        continue;
      }
      if (byId.has(uuid)) issues.push({ path, message: 'Повторяющийся UUID.' });
      if (kind === 'databases' && data.sqlalchemy_uri !== placeholder && data.sqlalchemy_uri !== 'REDACTED') {
        issues.push({ path, message: 'В снимке Git допустимы только очищенные URI подключений.' });
      }
      if (kind === 'datasets' && (!Array.isArray(data.columns) || !Array.isArray(data.metrics))) {
        issues.push({ path, message: 'Нет списка колонок или метрик dataset.' });
      }
      if (kind === 'datasets') {
        if (data.data_file != null) issues.push({ path, message: 'Импорт файлов с данными в mGit не поддерживается.' });
        if (list(data.columns).some(column => typeof object(column).column_name !== 'string') ||
            list(data.metrics).some(metric => typeof object(metric).metric_name !== 'string' || typeof object(metric).expression !== 'string')) {
          issues.push({ path, message: 'У колонки или метрики нет обязательного имени или выражения.' });
        }
      }
      if (kind === 'charts' && (typeof data.viz_type !== 'string' || !data.viz_type)) issues.push({ path, message: 'Нет обязательного viz_type.' });
      if (kind === 'queries' && typeof data.sql !== 'string') issues.push({ path, message: 'Нет SQL сохранённого запроса.' });
      const asset: Asset = { path, kind, uuid, name, data, references: [] };
      assets.push(asset);
      byId.set(uuid, asset);
      const refs: [unknown, Kind, string][] = [];
      if (kind === 'datasets' || kind === 'queries') refs.push([data.database_uuid, 'databases', 'database_uuid']);
      if (kind === 'charts') refs.push([data.dataset_uuid, 'datasets', 'dataset_uuid']);
      if (kind === 'dashboards') {
        if (!data.position || typeof data.position !== 'object' || Array.isArray(data.position)) {
          issues.push({ path, message: 'Отсутствует структура layout дашборда.' });
        }
        if (data.theme_uuid != null || data.theme_id != null) {
          issues.push({ path, message: 'Снимок с привязкой к отдельной теме Superset пока не поддерживается.' });
        }
        const chartIds = new Set<number>();
        const position = object(data.position);
        for (const node of Object.values(position).map(object)) {
          if ([...list(node.children), ...list(node.parents)].some(id => typeof id !== 'string' || !Object.hasOwn(position, id))) {
            issues.push({ path, message: 'В layout есть ссылка на отсутствующий компонент.', dependency: true });
          }
          if (node.type === 'CHART') {
            const meta = object(node.meta);
            refs.push([meta.uuid, 'charts', 'layout.chart.uuid']);
            if (typeof meta.chartId !== 'number') issues.push({ path, message: 'В layout графика нет chartId.', dependency: true });
            else chartIds.add(meta.chartId);
          }
        }
        const metadata = object(data.metadata);
        for (const filter of list(metadata.native_filter_configuration).map(object)) {
          for (const target of list(filter.targets).map(object)) {
            if (target.column || target.datasetUuid || target.datasetId != null) refs.push([target.datasetUuid, 'datasets', 'filter.datasetUuid']);
          }
        }
        for (const id of list(metadata.timed_refresh_immune_slices)) {
          if (typeof id !== 'number' || !chartIds.has(id)) issues.push({ path, message: 'В настройках автообновления есть график вне layout.', dependency: true });
        }
      }
      asset.references = refs.map(([value]) => normalizeUuid(value)).filter(Boolean);
      expected.set(asset, refs);
    } catch {
      issues.push({ path, message: 'Недопустимый YAML или превышена сложность документа.' });
    }
  }
  for (const [asset, refs] of expected) {
    for (const [value, kind, field] of refs) {
      const uuid = normalizeUuid(value);
      if (uuid && byId.get(uuid)?.kind === kind) continue;
      const dashboards = asset.kind === 'charts' ? assets.filter(a => a.kind === 'dashboards' && a.references.includes(asset.uuid)).map(a => a.name) : undefined;
      issues.push({ path: asset.path, message: uuid ? 'Не найдена зависимость ' + field + ' (' + uuid + ').' : 'Нет обязательного ' + field + '.', dashboards, dependency: true });
    }
  }
  return result;
}

export function normalizeExport(files: Files): Files {
  const result: Files = new Map();
  for (const [path, input] of files) {
    let content = input.replace(/\r\n/g, '\n');
    if (path === 'metadata.yaml' || path.startsWith('databases/')) {
      try {
        const doc = parseDocument(content);
        if (doc.errors.length) throw new Error();
        if (path === 'metadata.yaml') doc.delete('timestamp');
        else doc.set('sqlalchemy_uri', placeholder);
        content = doc.toString({ lineWidth: 0 });
      } catch { throw new Failure('Superset вернул некорректный YAML.', 'format'); }
    }
    result.set(path, content);
  }
  return result;
}

export function assertValid(files: Files) {
  const inspection = inspect(files);
  if (inspection.issues.length) throw new Failure('Проверка снимка обнаружила ошибки.', 'validation', inspection.issues);
  return inspection.assets;
}
export function inspectExport(files: Files) {
  const result = inspect(files);
  if (result.issues.some(issue => !issue.dependency)) {
    throw new Failure('Снимок нельзя сохранить. Проверьте формат и секреты.', 'validation', result.issues);
  }
  return result;
}
export function prepareSnapshot(files: Files, compatibleOnly = false) {
  if (!compatibleOnly) return { files, assets: assertValid(files), excluded: [] };
  const { assets, issues } = inspect(files);
  if (!issues.length && assets.length) return { files, assets, excluded: [] };
  if (issues.some(issue => !assetPath(issue.path) || issue.path === 'metadata.yaml' || issue.message === 'Повторяющийся UUID.')) {
    throw new Failure('Снимок содержит ошибки, которые нельзя исключить частичным импортом.', 'validation', issues);
  }
  const excluded = new Map(issues.map(issue => [issue.path, issue.message]));
  const dependents = new Map<string, Asset[]>();
  const pending = assets.filter(asset => excluded.has(asset.path));
  for (const asset of assets) {
    for (const uuid of asset.references) {
      const references = dependents.get(uuid) ?? [];
      references.push(asset);
      dependents.set(uuid, references);
    }
  }
  for (const invalid of pending) {
    for (const asset of dependents.get(invalid.uuid) ?? []) {
      if (excluded.has(asset.path)) continue;
      excluded.set(asset.path, 'Исключена зависимость ' + invalid.uuid + '.');
      pending.push(asset);
    }
  }
  const compatible = new Map([...files].filter(([path]) => !excluded.has(path)));
  const compatibleAssets = assertValid(compatible);
  if (!compatibleAssets.length) throw new Failure('В снимке нет объектов для частичного импорта.', 'validation', issues);
  return { files: compatible, assets: compatibleAssets, excluded: [...excluded].map(([path, message]) => ({ path, message })) };
}
export function compatibleSnapshot(files: Files) {
  const { files: compatible, excluded } = prepareSnapshot(files, true);
  return { files: compatible, excluded };
}
export function selectAssets(files: Files, selected: string[]) {
  if (!selected.length) return files;
  const { assets, issues } = inspect(files);
  if (issues.some(issue => issue.path === '[путь скрыт]' || issue.path === 'metadata.yaml' || !issue.path)) {
    throw new Failure('Ошибка формата или проверки секретов в экспорте.', 'validation', issues);
  }
  const index = new Map(assets.map(asset => [asset.uuid, asset]));
  const output: Files = new Map([['metadata.yaml', files.get('metadata.yaml')!]]);
  const pending = [...selected];
  while (pending.length) {
    const uuid = pending.pop()!;
    const asset = index.get(uuid);
    if (!asset) throw new Failure('Выбранный объект или зависимость отсутствует в выгрузке: ' + uuid, 'validation');
    if (output.has(asset.path)) continue;
    output.set(asset.path, files.get(asset.path)!);
    pending.push(...asset.references);
  }
  assertValid(output);
  return output;
}
export function summarize(assets: Asset[]) {
  return Object.fromEntries(kinds.map(kind => [kind, assets.filter(asset => asset.kind === kind).length]));
}
function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}
export function materialize(files: Files, connections: Record<string, string>) {
  const assets = assertValid(files);
  const output = new Map(files);
  const metadata = parseDocument(files.get('metadata.yaml')!);
  const timestamp = metadata.get('timestamp', true);
  if (isScalar(timestamp) && typeof timestamp.value === 'string') {
    timestamp.type = 'QUOTE_DOUBLE';
    output.set('metadata.yaml', metadata.toString({ lineWidth: 0 }));
  }
  const passwords: Record<string, string> = {};
  for (const asset of assets) {
    if (asset.kind === 'charts' && typeof asset.data.query_context === 'string') {
      const context = object(parseJson(asset.data.query_context));
      if (typeof context.form_data === 'string') {
        const formData = parseJson(context.form_data);
        if (!formData || formData !== object(formData)) {
          throw new Failure('Некорректный query_context.form_data у графика.', 'validation', [{ path: asset.path }]);
        }
        context.form_data = formData;
        const document = parseDocument(files.get(asset.path)!);
        document.set('query_context', JSON.stringify(context));
        output.set(asset.path, document.toString({ lineWidth: 0 }));
      }
    }
    if (asset.kind !== 'databases') continue;
    const connection = connections[asset.uuid];
    if (!connection || /[\r\n\0]/.test(connection) || !/^[a-z][a-z0-9+_-]*:\/\//i.test(connection)) {
      throw new Failure('Настройте локальное подключение для ' + asset.name + ' (' + asset.uuid + ').', 'mapping');
    }
    const document = parseDocument(files.get(asset.path)!);
    if (document.get('extra') == null) document.set('extra', {});
    const auth = /^([a-z][a-z0-9+_-]*:\/\/[^\/@]*?):([^\/@]+)@/i.exec(connection);
    if (auth) {
      try { passwords[asset.path] = decodeURIComponent(auth[2]); }
      catch { throw new Failure('Некорректное URL-кодирование пароля подключения.', 'mapping'); }
    }
    document.set('sqlalchemy_uri', auth ? auth[1] + ':XXXXXXXXXX@' + connection.slice(auth[0].length) : connection);
    output.set(asset.path, document.toString({ lineWidth: 0 }));
  }
  return { output, passwords };
}
