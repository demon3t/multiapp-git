import { fromBuffer, Entry } from 'yauzl';
import { ZipFile } from 'yazl';
import { Files, Failure } from './model';
import { assetPath, maxBytes } from './snapshot';

export function unpackEntries(buffer: Buffer): Promise<[string, string][]> {
  return new Promise((resolve, reject) => {
    fromBuffer(buffer, { lazyEntries: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) { reject(new Failure('Ожидался штатный ZIP Superset.', 'format')); return; }
      const files: [string, string][] = [];
      let root: string | undefined;
      let size = 0;
      const fail = () => { zip.close(); reject(new Failure('ZIP содержит неожиданные файлы или превышает допустимый размер.', 'format')); };
      zip.on('error', fail);
      zip.on('end', () => resolve(files));
      zip.on('entry', (entry: Entry) => {
        const [folder, ...parts] = entry.fileName.split('/');
        const path = parts.join('/');
        if (!/^[a-z0-9_-]+$/i.test(folder) || (root && root !== folder) || !parts.length) { fail(); return; }
        root = folder;
        if (entry.fileName.endsWith('/') && !entry.uncompressedSize) { zip.readEntry(); return; }
        size += entry.uncompressedSize;
        if (!assetPath(path) || size > maxBytes ||
            ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) { fail(); return; }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { fail(); return; }
          const chunks: Buffer[] = [];
          stream.on('error', fail);
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', () => {
            try { files.push([path, new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))]); }
            catch { fail(); return; }
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

export async function unpack(buffer: Buffer): Promise<Files> {
  const files: Files = new Map();
  const seen = new Set<string>();
  for (const [path, content] of await unpackEntries(buffer)) {
    const key = path.toLowerCase();
    if (seen.has(key)) throw new Failure('ZIP содержит повторяющиеся пути.', 'format');
    seen.add(key);
    files.set(path, content);
  }
  return files;
}

export function pack(files: Files): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', chunk => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
    for (const [path, text] of files) zip.addBuffer(Buffer.from(text), 'assets/' + path);
    zip.end();
  });
}
