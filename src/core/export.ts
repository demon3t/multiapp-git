import { parse, stringify } from 'yaml';
import { Failure, Files, Kind, kinds, normalizeUuid, object } from './model';
import { maxBytes, redactDatabase } from './snapshot';
import { unpackEntries } from './zip';

const resources: Record<Kind, [string, number]> = {
  databases: ['database', 30], datasets: ['dataset', 30], charts: ['chart', 30],
  dashboards: ['dashboard', 5], queries: ['saved_query', 30]
};
const pageSize = 100;

export async function batchExport(
  listPage: (path: string) => Promise<Record<string, unknown>>,
  download: (path: string) => Promise<Buffer>
): Promise<Files> {
  const timestamp = new Date().toISOString();
  const assets = new Map<string, { path: string; text: string }>();
  const version = '1.0.0';
  let bytes = 0;
  for (const kind of kinds) {
    const [resource, batchSize] = resources[kind];
    const base = '/api/v1/' + resource + '/';
    const inventory = new Map<number, string>();
    const expected = new Set<string>();
    let count = 0;
    for (let page = 0; page === 0 || inventory.size < count; page++) {
      const result = await listPage(base + '?q=(page:' + page + ',page_size:' + pageSize + ')');
      if (page === 0 && typeof result.count === 'number') count = result.count;
      if (!Number.isSafeInteger(count) || count < 0 || result.count !== count || !Array.isArray(result.result) ||
          (!result.result.length && inventory.size < count) || inventory.size + result.result.length > count) {
        throw new Failure('Изменился или повреждён список Superset: ' + resource + '.', 'inventory');
      }
      for (const row of result.result.map(object)) {
        const id = row.id;
        const uuid = normalizeUuid(row.uuid);
        if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || inventory.has(id) ||
            (row.uuid != null && !uuid) || (uuid && expected.has(uuid))) {
          throw new Failure('Недопустимый или повторяющийся ID/UUID в списке Superset: ' + resource + '.', 'inventory');
        }
        inventory.set(id, uuid);
        if (uuid) expected.add(uuid);
      }
    }

    async function collect(ids: number[]): Promise<void> {
      try {
        const archive = await download(base + 'export/?q=!(' + ids.join(',') + ')');
        const entries = await unpackEntries(archive);
        const headers = entries.filter(([path]) => path === 'metadata.yaml');
        const declared = headers.length === 1 ? object(parse(headers[0][1], { maxAliasCount: 0 })).version : undefined;
        if (declared !== version) throw new Failure('Неподдерживаемая версия ZIP Superset: ' + resource + '.', 'format');
        const batch = new Map<string, { path: string; text: string }>();
        for (const [path, source] of entries) {
          if (!path.startsWith(kind + '/')) continue;
          const data = object(parse(source, { maxAliasCount: 0 }));
          const uuid = normalizeUuid(data.uuid);
          if (!uuid || data.version !== declared) throw new Failure('Объект без корректного UUID или версии: ' + resource + '.', 'format');
          batch.set(uuid, { path, text: kind === 'databases' ? redactDatabase(source) : source.replace(/\r\n/g, '\n') });
        }
        if (batch.size !== ids.length || ids.some(id => inventory.get(id) && !batch.has(inventory.get(id)!))) {
          throw new Failure('UUID архива расходятся со списком Superset: ' + resource + '.', 'inventory');
        }
        if ([...batch.keys()].some(uuid => assets.has(uuid))) {
          throw new Failure('Повторяющийся UUID в экспорте Superset: ' + resource + '.', 'format');
        }
        for (const [uuid, asset] of batch) {
          bytes += Buffer.byteLength(asset.text);
          if (bytes > maxBytes) throw new Failure('Снимок превышает допустимый размер.', 'format');
          assets.set(uuid, asset);
        }
      } catch (error) {
        if (ids.length === 1 || !(error instanceof Failure) ||
            !['timeout', 'export-gateway', 'inventory'].includes(error.code)) throw error;
        const middle = Math.floor(ids.length / 2);
        await collect(ids.slice(0, middle));
        await collect(ids.slice(middle));
      }
    }

    const ids = [...inventory.keys()];
    const comparable = ids.filter(id => inventory.get(id));
    for (let start = 0; start < comparable.length; start += batchSize) await collect(comparable.slice(start, start + batchSize));
    // Saved-query lists in Superset 4.1.3 have IDs but no UUIDs.
    for (const id of ids) if (!inventory.get(id)) await collect([id]);
  }

  // Superset loads metadata with PyYAML, which treats an unquoted ISO date as a datetime.
  const files: Files = new Map([['metadata.yaml', stringify({ version, type: 'assets', timestamp }, { version: '1.1' })]]);
  const pathCounts = new Map<string, number>();
  for (const { path } of assets.values()) {
    const key = path.toLowerCase();
    pathCounts.set(key, (pathCounts.get(key) ?? 0) + 1);
  }
  const reserved = new Set(pathCounts.keys());
  for (const [uuid, { path, text }] of [...assets].sort(([left], [right]) => left.localeCompare(right))) {
    if (pathCounts.get(path.toLowerCase()) === 1) { files.set(path, text); continue; }
    const kind = path.split('/')[0];
    let name = kind + '/' + uuid + '.yaml';
    for (let suffix = 1; reserved.has(name.toLowerCase()); suffix++) name = kind + '/' + uuid + '-' + suffix + '.yaml';
    reserved.add(name.toLowerCase());
    files.set(name, text);
  }
  return files;
}
