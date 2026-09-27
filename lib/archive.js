import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

export async function validParquet(file) {
  try {
    const handle = await fsp.open(file, 'r');
    try {
      const { size } = await handle.stat();
      if (size < 8) return false;
      const first = Buffer.alloc(4), last = Buffer.alloc(4);
      await handle.read(first, 0, 4, 0);
      await handle.read(last, 0, 4, size - 4);
      return first.toString() === 'PAR1' && last.toString() === 'PAR1';
    } finally { await handle.close(); }
  } catch { return false; }
}

export function extractParquet(zipPath, outputPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, validateEntrySizes: true }, (openError, zip) => {
      if (openError) return reject(openError);
      let found = false, done = false;
      const fail = (error) => {
        if (done) return;
        done = true;
        zip.close();
        reject(error);
      };
      zip.on('error', fail);
      zip.on('entry', (entry) => {
        if (!/\.parquet$/i.test(entry.fileName)) return zip.readEntry();
        if (found || entry.fileName !== path.basename(entry.fileName)) {
          return fail(new Error('Unexpected Parquet entries in BTS ZIP'));
        }
        found = true;
        zip.openReadStream(entry, (streamError, source) => {
          if (streamError) return fail(streamError);
          pipeline(source, fs.createWriteStream(outputPath, { flags: 'wx' }))
            .then(async () => {
              if (done) return;
              if (!await validParquet(outputPath)) return fail(new Error('Invalid Parquet payload'));
              done = true;
              zip.close();
              resolve(outputPath);
            }).catch(fail);
        });
      });
      zip.on('end', () => {
        if (!found) fail(new Error('No Parquet member in BTS ZIP'));
      });
      zip.readEntry();
    });
  });
}
