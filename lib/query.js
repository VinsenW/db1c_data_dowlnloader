import { DuckDBInstance } from '@duckdb/node-api';
import { requiredPaths } from './data.js';

const instance = await DuckDBInstance.create(':memory:');
const lit = value => `'${String(value).replaceAll("'", "''")}'`;
const ident = value => `"${String(value).replaceAll('"', '""')}"`;

export async function withData(product, months, task) {
  const files = await requiredPaths(product, months);
  const source = `read_parquet([${files.map(lit).join(', ')}], union_by_name = true)`;
  const con = await instance.connect();
  try {
    return await task(con, source);
  } finally { con.disconnectSync(); }
}

export async function rows(con, sql) {
  const reader = await con.runAndReadAll(sql);
  return reader.getRowObjectsJson();
}

export async function fieldsFor(con, source) {
  const desc = await rows(con, `DESCRIBE SELECT * FROM ${source}`);
  return desc.map(x => x.column_name);
}

function airports(input) {
  if (!input) return [];
  const codes = [...new Set(String(input).toUpperCase().split(',').map(x => x.trim()).filter(Boolean))];
  if (codes.some(x => !/^[A-Z0-9]{3}$/.test(x))) {
    throw new Error('Airport codes must have three characters, separated by commas');
  }
  return codes;
}

export function buildQuery(source, fields, options = {}) {
  const columns = Array.isArray(options.columns) && options.columns.length ? options.columns : fields;
  if (columns.some(x => !fields.includes(x))) throw new Error('Unknown column selected');
  const filters = [];
  for (const name of ['Origin', 'Dest']) {
    const codes = airports(options[name.toLowerCase()]);
    if (codes.length) {
      if (!fields.includes(name)) throw new Error(`${name} is unavailable in this product`);
      filters.push(`${ident(name)} IN (${codes.map(lit).join(', ')})`);
    }
  }
  const windows = Array.isArray(options.windows) ? options.windows : [];
  if (windows.some(x => !['21AP', '2290', '91UP'].includes(x))) throw new Error('Unknown purchase window');
  if (windows.length && fields.includes('PurchaseWindowGroup')) {
    filters.push(`${ident('PurchaseWindowGroup')} IN (${windows.map(lit).join(', ')})`);
  }
  const amount = fields.includes('MktAmount') ? 'MktAmount' :
    fields.includes('TotalAmount') ? 'TotalAmount' : null;
  for (const [key, op] of [['minAmount', '>='], ['maxAmount', '<=']]) {
    if (options[key] !== '' && options[key] != null) {
      const value = Number(options[key]);
      if (!Number.isFinite(value) || !amount) throw new Error('Invalid amount filter');
      filters.push(`${ident(amount)} ${op} ${value}`);
    }
  }
  const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
  return { sql: `SELECT ${columns.map(ident).join(', ')} FROM ${source}${where}`,
           where, amount, columns };
}

export async function analyze(con, source, fields, query) {
  const preview = await rows(con, `${query.sql} LIMIT 200`);
  const groups = ['RpYear', 'RpMonth', 'PurchaseWindowGroup'].filter(x => fields.includes(x));
  const count = 'COUNT(*) AS Records';
  const pax = fields.includes('Passengers') ? ', SUM("Passengers") AS Passengers' : '';
  const amount = query.amount ? `, AVG(${ident(query.amount)}) AS MeanAmount` : '';
  const summary = groups.length ? await rows(con,
    `SELECT ${groups.map(ident).join(', ')}, ${count}${pax}${amount} ` +
    `FROM ${source}${query.where} GROUP BY ${groups.map(ident).join(', ')} ` +
    `ORDER BY ${groups.map(ident).join(', ')}`) : [];
  const routes = ['Origin', 'Dest', 'Passengers', 'MktAmount'].every(x => fields.includes(x)) ?
    await rows(con, `SELECT Origin, Dest, COUNT(*) AS Records, ` +
      `SUM(Passengers) AS Passengers, ` +
      `SUM(MktAmount * Passengers) / NULLIF(SUM(Passengers), 0) AS WeightedAmount ` +
      `FROM ${source}${query.where} GROUP BY Origin, Dest ` +
      `ORDER BY Passengers DESC LIMIT 50`) : [];
  return { preview, summary, routes, columns: query.columns };
}

export async function exportQuery(con, query, file, format) {
  if (!['CSV', 'PARQUET'].includes(format)) throw new Error('Invalid export format');
  const opts = format === 'CSV' ? 'FORMAT CSV, HEADER TRUE' : 'FORMAT PARQUET';
  await con.run(`COPY (${query.sql}) TO ${lit(file)} (${opts})`);
}
