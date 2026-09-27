import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { cached, choose, dataDir, fetchMonth, months, products } from './lib/data.js';
import { analyze, buildQuery, exportQuery, fieldsFor, withData } from './lib/query.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const appUser = process.env.APP_USER || 'researcher';
const appPassword = process.env.APP_PASSWORD;
const exportDir = path.resolve(process.env.DB1C_TEMP_DIR || os.tmpdir());
if (host !== '127.0.0.1' && host !== 'localhost' && !appPassword) {
  throw new Error('Set APP_PASSWORD before exposing the app on a network interface');
}
const jobs = new Map();
let activeJob = null;
let activeExport = null;

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
                          'content-length': Buffer.byteLength(body),
                          'cache-control': 'no-store' });
  res.end(body);
}

async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Expected JSON');
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 65536) throw new Error('Request is too large');
  }
  return JSON.parse(raw || '{}');
}

function checkOrigin(req) {
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) {
    throw new Error('Request origin is not allowed');
  }
}

function authorized(req) {
  if (!appPassword) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const received = Buffer.from(header.slice(6), 'base64');
  const expected = Buffer.from(`${appUser}:${appPassword}`);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function startJob(product, selected) {
  if (activeJob) throw new Error('A download is already running');
  const items = choose(product, selected);
  const id = randomUUID();
  const job = { id, state: 'running', current: '', completed: 0,
                total: items.length, error: null, reused: 0 };
  jobs.set(id, job);
  activeJob = id;
  (async () => {
    try {
      for (const item of items) {
        job.current = `${item.product} ${item.month}`;
        const result = await fetchMonth(item);
        if (result.reused) job.reused++;
        job.completed++;
      }
      job.state = 'done';
    } catch (error) {
      job.state = 'failed';
      job.error = error.message;
    } finally {
      activeJob = null;
      setTimeout(() => jobs.delete(id), 60 * 60 * 1000).unref();
    }
  })();
  return job;
}

function startExport(product, selected, filters, format) {
  if (activeExport) throw new Error('An export is already running');
  if (!['csv', 'parquet'].includes(format)) throw new Error('Choose CSV or Parquet');
  choose(product, selected);
  const id = randomUUID();
  const file = path.join(exportDir, `db1c-export-${id}.${format}`);
  const job = { id, state: 'running', current: 'Writing matching rows', error: null,
                name: `DB1C_${product}_${selected[0]}_${selected.at(-1)}.${format}` };
  jobs.set(id, job);
  activeExport = id;
  (async () => {
    try {
      await fsp.mkdir(exportDir, { recursive: true });
      await withData(product, selected, async (con, source) => {
        const fields = await fieldsFor(con, source);
        await exportQuery(con, buildQuery(source, fields, filters), file, format.toUpperCase());
      });
      job.file = file;
      job.state = 'done';
    } catch (error) {
      job.state = 'failed';
      job.error = error.message;
      await fsp.rm(file, { force: true });
    } finally {
      activeExport = null;
      setTimeout(async () => {
        if (job.file) await fsp.rm(job.file, { force: true });
        jobs.delete(id);
      }, 60 * 60 * 1000).unref();
    }
  })();
  return job;
}

async function serveFile(res, pathname) {
  const files = { '/': ['public/index.html', 'text/html'],
                  '/app.js': ['public/app.js', 'text/javascript'],
                  '/styles.css': ['public/styles.css', 'text/css'] };
  const item = files[pathname];
  if (!item) return json(res, 404, { error: 'Not found' });
  const file = path.join(root, item[0]);
  const stat = await fsp.stat(file);
  res.writeHead(200, { 'content-type': `${item[1]}; charset=utf-8`,
                       'content-length': stat.size, 'cache-control': 'no-store' });
  await pipeline(fs.createReadStream(file), res);
}

const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
    if (req.method === 'GET' && pathname === '/api/health') {
      return json(res, 200, { ok: true });
    }
    if (!authorized(req)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="DB1C Explorer"',
                           'cache-control': 'no-store' });
      return res.end('Authentication required');
    }
    checkOrigin(req);
    if (req.method === 'GET' && pathname === '/api/catalog') {
      return json(res, 200, { months, products, dataDir });
    }
    if (req.method === 'GET' && pathname.startsWith('/api/jobs/')) {
      const job = jobs.get(pathname.slice('/api/jobs/'.length));
      if (!job) return json(res, 404, { error: 'Job not found' });
      const { file, ...visible } = job;
      return json(res, 200, visible);
    }
    if (req.method === 'GET' && pathname.startsWith('/api/exports/')) {
      const job = jobs.get(pathname.slice('/api/exports/'.length));
      if (!job?.file || job.state !== 'done') return json(res, 404, { error: 'Export not ready' });
      const stat = await fsp.stat(job.file);
      res.writeHead(200, {
        'content-type': job.name.endsWith('.csv') ? 'text/csv' : 'application/octet-stream',
        'content-disposition': `attachment; filename="${job.name}"`,
        'content-length': stat.size
      });
      await pipeline(fs.createReadStream(job.file), res);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/cache') {
      const { product, months: selected } = await body(req);
      return json(res, 200, { files: await cached(product, selected) });
    }
    if (req.method === 'POST' && pathname === '/api/download') {
      const { product, months: selected } = await body(req);
      return json(res, 202, startJob(product, selected));
    }
    if (req.method === 'POST' && pathname === '/api/fields') {
      const { product, months: selected } = await body(req);
      const fields = await withData(product, selected, fieldsFor);
      return json(res, 200, { fields });
    }
    if (req.method === 'POST' && pathname === '/api/query') {
      const { product, months: selected, filters } = await body(req);
      const result = await withData(product, selected, async (con, source) => {
        const fields = await fieldsFor(con, source);
        return analyze(con, source, fields, buildQuery(source, fields, filters));
      });
      return json(res, 200, result);
    }
    if (req.method === 'POST' && pathname === '/api/export') {
      const { product, months: selected, filters, format } = await body(req);
      return json(res, 202, startExport(product, selected, filters, format));
    }
    if (req.method === 'GET') return serveFile(res, pathname);
    json(res, 404, { error: 'Not found' });
  } catch (error) {
    if (!res.headersSent) json(res, 400, { error: error.message });
    else res.destroy(error);
  }
});

server.listen(port, host, () => {
  console.log(`DB1C Explorer listening on ${host}:${port}`);
  console.log(`Data folder: ${dataDir}`);
});
