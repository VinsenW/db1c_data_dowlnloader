const $ = id => document.getElementById(id);
const state = { product: 'market', months: [], fields: [], ready: false, queried: false };

async function api(path, data) {
  const response = await fetch(path, data ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data)
  } : undefined);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

function error(message) {
  $('alert').textContent = message;
  $('alert').hidden = !message;
}

function selection() {
  const from = $('from').value, through = $('through').value;
  if (from > through) throw new Error('The starting month is after the ending month');
  return state.months.filter(x => x >= from && x <= through);
}

function request() {
  return { product: state.product, months: selection() };
}

function filters() {
  return {
    origin: $('origin').value, dest: state.product === 'market' ? $('dest').value : '',
    windows: [...document.querySelectorAll('#windows input:checked')].map(x => x.value),
    minAmount: $('minAmount').value, maxAmount: $('maxAmount').value,
    columns: [...document.querySelectorAll('#fields input:checked')].map(x => x.value)
  };
}

function busy(value) {
  for (const id of ['download', 'runQuery', 'exportCsv', 'exportParquet']) {
    $(id).disabled = value || (id !== 'download' && !state.ready) ||
      (id.startsWith('export') && !state.queried);
  }
}

async function poll(id, update) {
  while (true) {
    const job = await api(`/api/jobs/${id}`);
    update(job);
    if (job.state === 'failed') throw new Error(job.error || 'Job failed');
    if (job.state === 'done') return job;
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
}

function renderTable(container, data, message) {
  container.replaceChildren();
  if (!data?.length) {
    const empty = document.createElement('div');
    empty.className = 'empty'; empty.textContent = message;
    container.append(empty); return;
  }
  const cols = Object.keys(data[0]);
  const table = document.createElement('table');
  const head = document.createElement('thead'), hrow = document.createElement('tr');
  for (const col of cols) {
    const th = document.createElement('th'); th.textContent = col; hrow.append(th);
  }
  head.append(hrow); table.append(head);
  const body = document.createElement('tbody');
  for (const row of data) {
    const tr = document.createElement('tr');
    for (const col of cols) {
      const td = document.createElement('td');
      const value = row[col];
      td.textContent = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(body); container.append(table);
}

function renderChart(data) {
  const chart = $('chart'); chart.replaceChildren();
  const totals = new Map();
  for (const row of data) {
    const key = row.PurchaseWindowGroup;
    if (key == null) continue;
    totals.set(key, (totals.get(key) || 0) + Number(row.Records || 0));
  }
  const max = Math.max(1, ...totals.values());
  for (const [key, value] of totals) {
    const item = document.createElement('div'); item.className = 'bar-item';
    const bar = document.createElement('div'); bar.className = 'bar';
    bar.style.height = `${Math.max(4, value / max * 105)}px`;
    const label = document.createElement('strong'); label.textContent = key;
    const count = document.createElement('span'); count.textContent = value.toLocaleString();
    item.append(bar, label, count); chart.append(item);
  }
}

function renderFields(fields) {
  state.fields = fields;
  const target = $('fields'); target.replaceChildren();
  const preferred = ['RpYear', 'RpMonth', 'Origin', 'Dest', 'PurchaseWindowGroup',
    'Passengers', 'MktAmount', 'TotalAmount', 'MktCarrier', 'RpCarrier', 'ItinID'];
  for (const field of fields) {
    const label = document.createElement('label');
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = field;
    checkbox.checked = preferred.includes(field);
    label.append(checkbox, document.createTextNode(field)); target.append(label);
  }
  if (!target.querySelector('input:checked')) {
    for (const x of target.querySelectorAll('input')) x.checked = true;
  }
}

async function loadFields() {
  const result = await api('/api/fields', request());
  renderFields(result.fields);
  state.ready = true; state.queried = false;
  $('cachePill').textContent = `${selection().length} month(s) ready`;
  busy(false);
}

async function download() {
  error(''); busy(true);
  try {
    const requestData = request();
    const cache = await api('/api/cache', requestData);
    const missing = cache.files.filter(x => !x.cached).length;
    $('downloadStatus').textContent = missing ? `${missing} month(s) to download…` : 'All selected months are cached.';
    if (missing) {
      const job = await api('/api/download', requestData);
      await poll(job.id, j => {
        $('downloadStatus').textContent = `${j.state === 'done' ? 'Complete' : 'Downloading'} · ${j.completed}/${j.total} months · ${j.current || ''}`;
      });
    }
    await loadFields();
    $('downloadStatus').textContent = `Ready. ${selection().length} month(s) available in the local data folder.`;
  } catch (e) { error(e.message); $('downloadStatus').textContent = 'Download interrupted.'; }
  finally { busy(false); }
}

async function runQuery() {
  error(''); busy(true);
  try {
    const result = await api('/api/query', { ...request(), filters: filters() });
    renderTable($('previewTable'), result.preview, 'No matching records.');
    renderTable($('summaryTable'), result.summary, 'No summary rows.');
    renderTable($('routesTable'), result.routes,
      state.product === 'ticket' ? 'Top markets are available in the Market file.' : 'No matching markets.');
    renderChart(result.summary);
    $('previewCount').textContent = `${result.preview.length} shown`;
    state.queried = true;
  } catch (e) { error(e.message); state.queried = false; }
  finally { busy(false); }
}

async function exportFile(format) {
  error(''); busy(true);
  try {
    const job = await api('/api/export', { ...request(), filters: filters(), format });
    await poll(job.id, j => {
      $('exportStatus').textContent = j.state === 'done' ? 'Export ready.' : 'Writing matching records…';
    });
    const link = document.createElement('a');
    link.href = `/api/exports/${job.id}`; link.download = job.name;
    document.body.append(link); link.click(); link.remove();
    $('exportStatus').textContent = `Your ${format.toUpperCase()} download is ready.`;
  } catch (e) { error(e.message); $('exportStatus').textContent = 'Export failed.'; }
  finally { busy(false); }
}

function resetSelection() {
  state.ready = false; state.queried = false; busy(false);
  $('cachePill').textContent = 'No data open';
  $('downloadStatus').textContent = 'Click Download / open months for this selection.';
  $('fields').replaceChildren();
}

async function init() {
  const catalog = await api('/api/catalog');
  state.months = catalog.months;
  for (const id of ['from', 'through']) {
    const select = $(id);
    for (const month of catalog.months) select.add(new Option(month, month));
  }
  $('from').value = catalog.months[0];
  $('through').value = catalog.months[0];
  for (const button of document.querySelectorAll('[data-product]')) {
    button.addEventListener('click', () => {
      state.product = button.dataset.product;
      for (const x of document.querySelectorAll('[data-product]')) x.classList.toggle('selected', x === button);
      $('destWrap').hidden = state.product === 'ticket';
      $('viewTitle').textContent = state.product === 'ticket' ? 'Whole Ticket' : 'Directional Market';
      $('productHelp').textContent = state.product === 'ticket' ?
        'Whole-ticket itineraries and gross total amount.' :
        'Directional origin, destination, passengers, and market amount.';
      resetSelection();
    });
  }
  for (const id of ['from', 'through']) $(id).addEventListener('change', resetSelection);
  for (const button of document.querySelectorAll('[data-tab]')) {
    button.addEventListener('click', () => {
      for (const x of document.querySelectorAll('[data-tab]')) x.classList.toggle('active', x === button);
      for (const id of ['preview', 'summary', 'routes', 'export']) $(id).classList.toggle('hidden', id !== button.dataset.tab);
    });
  }
  $('allFields').addEventListener('click', () => {
    for (const x of document.querySelectorAll('#fields input')) x.checked = true;
    state.queried = false; busy(false);
  });
  for (const id of ['origin', 'dest', 'windows', 'minAmount', 'maxAmount', 'fields']) {
    $(id).addEventListener('change', () => {
      state.queried = false;
      $('exportStatus').textContent = 'Run the query again to export the changed selection.';
      busy(false);
    });
  }
  $('download').addEventListener('click', download);
  $('runQuery').addEventListener('click', runQuery);
  $('exportCsv').addEventListener('click', () => exportFile('csv'));
  $('exportParquet').addEventListener('click', () => exportFile('parquet'));
  $('downloadStatus').textContent = `Local folder: ${catalog.dataDir}`;
}

init().catch(e => error(e.message));
