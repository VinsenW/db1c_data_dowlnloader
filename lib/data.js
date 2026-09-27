import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { extractParquet, validParquet } from './archive.js';

const catalog = JSON.parse(await fsp.readFile(new URL('../catalog.json', import.meta.url), 'utf8'));
export const months = [...new Set(catalog.map(x => x.month))].sort();
export const products = ['ticket', 'market'];
export const dataDir = path.resolve(process.env.DB1C_DATA_DIR ||
  path.join(os.homedir(), 'Desktop', 'DB1C_ticket_data'));

export function choose(product, requested) {
  if (!products.includes(product)) throw new Error('Select Ticket or Market');
  if (!Array.isArray(requested) || !requested.length || requested.length > months.length) {
    throw new Error('Select at least one available month');
  }
  const unique = [...new Set(requested)].sort();
  for (const month of unique) {
    if (!months.includes(month)) throw new Error(`Month is unavailable: ${month}`);
  }
  return unique.map(month => {
    const item = catalog.find(x => x.product === product && x.month === month);
    if (!item) throw new Error(`No download for ${product} ${month}`);
    return { ...item, file: path.join(dataDir,
      `DB1C.${product.toUpperCase()}.${month.replace('-', '')}.parquet`) };
  });
}

export async function cached(product, requested) {
  const items = choose(product, requested);
  return Promise.all(items.map(async item => ({
    month: item.month,
    cached: await validParquet(item.file),
    file: item.file
  })));
}

export async function fetchMonth(item) {
  await fsp.mkdir(dataDir, { recursive: true });
  if (await validParquet(item.file)) return { file: item.file, reused: true };
  const tag = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const zipPath = `${item.file}.${tag}.zip`;
  const tempParquet = `${item.file}.${tag}.parquet`;
  try {
    const response = await fetch(item.url, { signal: AbortSignal.timeout(60 * 60 * 1000) });
    if (!response.ok || !response.body) throw new Error(`BTS download: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(zipPath, { flags: 'wx' }));
    await extractParquet(zipPath, tempParquet);
    await fsp.rename(tempParquet, item.file);
    return { file: item.file, reused: false };
  } finally {
    await Promise.all([fsp.rm(zipPath, { force: true }), fsp.rm(tempParquet, { force: true })]);
  }
}

export async function requiredPaths(product, requested) {
  const items = choose(product, requested);
  for (const item of items) {
    if (!await validParquet(item.file)) throw new Error(`Download ${item.product} ${item.month} first`);
  }
  return items.map(x => x.file);
}
