import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function post(base, route, payload) {
  const response = await fetch(base + route, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const value = await response.json();
  assert.equal(response.status < 400, true, JSON.stringify(value));
  return value;
}

test('Market selection, preview, summary, and full export', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'db1c-js-test-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const db = await DuckDBInstance.create(':memory:');
  const con = await db.connect();
  const parquet = path.join(dir, 'DB1C.MARKET.202507.parquet');
  await con.run(`CREATE TABLE fixture AS SELECT * FROM (VALUES
    (2025, 7, 'CMH', 'LAX', '21AP', 1, 200.0),
    (2025, 7, 'CMH', 'LAX', '91UP', 2, 100.0),
    (2025, 7, 'LCK', 'SFO', '2290', 1, 150.0)
  ) t(RpYear, RpMonth, Origin, Dest, PurchaseWindowGroup, Passengers, MktAmount)`);
  await con.run(`COPY fixture TO '${parquet}' (FORMAT PARQUET)`);
  await con.run(`CREATE TABLE ticket AS SELECT * FROM (VALUES
    (2025, 7, 'CMH', '21AP', 1, 240.0),
    (2025, 7, 'LCK', '91UP', 1, 120.0)
  ) t(RpYear, RpMonth, Origin, PurchaseWindowGroup, Passengers, TotalAmount)`);
  await con.run(`COPY ticket TO '${path.join(dir, 'DB1C.TICKET.202507.parquet')}' (FORMAT PARQUET)`);
  con.disconnectSync();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, DB1C_DATA_DIR: dir, PORT: String(port) },
    stdio: 'ignore'
  });
  try {
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch(base + '/api/catalog')).ok) { ready = true; break; } }
      catch { /* startup */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'server started');
    const selection = { product: 'market', months: ['2025-07'] };
    const cache = await post(base, '/api/cache', selection);
    assert.equal(cache.files[0].cached, true);
    const fields = await post(base, '/api/fields', selection);
    assert.ok(fields.fields.includes('MktAmount'));
    const filters = { origin: 'CMH', windows: ['21AP', '91UP'],
      columns: ['Origin', 'Dest', 'MktAmount'] };
    const result = await post(base, '/api/query', { ...selection, filters });
    assert.equal(result.preview.length, 2);
    assert.equal(result.routes[0].Passengers, '3');
    assert.equal(result.summary.length, 2);
    const ticket = await post(base, '/api/query', {
      product: 'ticket', months: ['2025-07'],
      filters: { origin: 'CMH', columns: ['Origin', 'TotalAmount'] }
    });
    assert.equal(ticket.preview.length, 1);
    assert.equal(ticket.routes.length, 0);

    const exportJob = await post(base, '/api/export', { ...selection, filters, format: 'csv' });
    let job;
    for (let i = 0; i < 40; i++) {
      job = await (await fetch(base + `/api/jobs/${exportJob.id}`)).json();
      if (job.state !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(job.state, 'done', job.error);
    const download = await fetch(base + `/api/exports/${job.id}`);
    assert.equal(download.status, 200);
    const csv = await download.text();
    assert.equal(csv.trim().split('\n').length, 3);
    assert.match(csv, /CMH,LAX/);
  } finally {
    child.kill();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('hosted mode requires a password and accepts same-origin requests', async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, PORT: String(port), HOST: '0.0.0.0',
      APP_USER: 'researcher', APP_PASSWORD: 'test-secret' },
    stdio: 'ignore'
  });
  try {
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch(base + '/api/health')).ok) { ready = true; break; } }
      catch { /* startup */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'hosted server started');
    assert.equal((await fetch(base + '/api/catalog')).status, 401);
    const authorization = `Basic ${Buffer.from('researcher:test-secret').toString('base64')}`;
    assert.equal((await fetch(base + '/api/catalog', {
      headers: { authorization }
    })).status, 200);
    assert.equal((await fetch(base + '/api/cache', {
      method: 'POST', headers: { authorization, origin: 'https://elsewhere.example',
        'content-type': 'application/json' },
      body: JSON.stringify({ product: 'market', months: ['2025-07'] })
    })).status, 400);
    assert.equal((await fetch(base + '/api/cache', {
      method: 'POST', headers: { authorization, origin: base,
        'content-type': 'application/json' },
      body: JSON.stringify({ product: 'market', months: ['2025-07'] })
    })).status, 200);
  } finally {
    child.kill();
  }
});
