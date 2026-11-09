import * as core from './core.js';
import * as drive from './drive.js';

// ---------- persistence ----------

const K = {
  text: 'budget.text', base: 'budget.syncBase', fileId: 'budget.driveFileId',
  version: 'budget.driveVersion', clientId: 'budget.clientId', lastSync: 'budget.lastSync',
};
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

const STARTER = core.serialize({
  currency: 'EUR',
  categories: [
    { name: 'Salary', type: 'income', certain: true },
    { name: 'Other income', type: 'income' },
    { name: 'Rent', type: 'expense', certain: true },
    { name: 'Groceries', type: 'expense' },
    { name: 'Utilities', type: 'expense' },
    { name: 'Transport', type: 'expense' },
    { name: 'Entertainment', type: 'expense' },
    { name: 'Savings', type: 'expense' },
    { name: 'Other', type: 'expense' },
  ],
  plans: {}, tx: [],
});

let text = ls.get(K.text) ?? STARTER;
let { budget, errors } = core.parse(text);

const today = new Date();
const todayStr = isoDate(today);
const view = {
  tab: 'month', year: today.getFullYear(), month: today.getMonth(),
  editTx: null, lastCat: null, draft: null,
};
const sync = { status: 'idle', msg: '' };

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function saveText(t) {
  text = t;
  ls.set(K.text, t);
}

// Model changed through the UI: re-serialize, store, re-render, sync.
function commit({ deferRender = false } = {}) {
  saveText(core.serialize(budget));
  errors = [];
  deferRender ? setTimeout(render, 0) : render();
  scheduleSync();
}

// Text changed from outside (raw editor, import, Drive).
function setText(t) {
  saveText(t);
  ({ budget, errors } = core.parse(t));
  render();
}

// ---------- formatting ----------

let fmtCache = {};
function money(n, whole = false) {
  const key = budget.currency + whole;
  if (!fmtCache[key]) {
    const opts = { style: 'currency', currency: budget.currency, ...(whole ? { maximumFractionDigits: 0, minimumFractionDigits: 0 } : {}) };
    try { fmtCache[key] = new Intl.NumberFormat(undefined, opts); }
    catch { fmtCache[key] = { format: x => `${x.toFixed(whole ? 0 : 2)} ${budget.currency}` }; }
  }
  return fmtCache[key].format(n);
}
const money0 = n => money(n, true);
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const monthTitle = (y, m) => new Date(y, m, 1).toLocaleString(undefined, { month: 'long', year: 'numeric' });

// ---------- rendering ----------

const main = document.getElementById('main');

function render() {
  const active = document.activeElement?.dataset?.focus;
  const sel = active && document.activeElement.selectionStart != null
    ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;

  document.querySelectorAll('nav.tabs button').forEach(b =>
    b.classList.toggle('on', b.dataset.tab === view.tab));
  document.body.dataset.tab = view.tab;
  main.innerHTML = { month: renderMonth, year: renderYear, cats: renderCats, text: renderText, sync: renderSync }[view.tab]();
  renderSyncButton();

  if (active) {
    const el = main.querySelector(`[data-focus="${CSS.escape(active)}"]`);
    if (el) { el.focus(); if (sel) try { el.setSelectionRange(...sel); } catch {} }
  }
}

function catOptions(selected) {
  const group = type => budget.categories.filter(c => c.type === type)
    .map(c => `<option ${c.name === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  return `<optgroup label="Expenses">${group('expense')}</optgroup><optgroup label="Income">${group('income')}</optgroup>`;
}

function bar(r) {
  const pct = r.planned > 0 ? Math.min(100, (r.actual / r.planned) * 100) : (r.actual ? 100 : 0);
  const over = r.type === 'expense' && r.actual > r.planned;
  return `<div class="bar"><div class="${over ? 'over' : r.type}" style="width:${pct}%"></div></div>`;
}

function catRows(rows) {
  if (!rows.length) return '<p class="muted">Nothing planned or spent.</p>';
  return rows.map(r => {
    const left = r.planned - r.actual;
    const leftTxt = r.type === 'expense'
      ? (left >= 0 ? `${money(left)} left` : `<span class="neg">${money(-left)} over</span>`)
      : (left > 0 ? `${money(left)} to go` : 'received');
    return `<div class="catrow${r.auto ? ' auto' : ''}">
      <div class="catline"><span class="name">${esc(r.cat)}${r.certain ? ` <span class="tag" title="Certain: the planned amount counts even without a transaction">${r.auto ? 'certain · auto' : 'certain'}</span>` : ''}</span>
        <span class="amt">${money(r.actual)} <span class="muted">/ ${money(r.planned)}</span></span></div>
      ${bar(r)}
      <div class="small muted right">${r.auto ? 'counted from plan · ' : ''}${leftTxt}</div>
    </div>`;
  }).join('');
}

function renderMonth() {
  const { year, month } = view;
  const s = core.monthStats(budget, year, month);
  const visible = s.rows.filter(r => r.planned || r.actual);
  const net = s.income.actual - s.expense.actual;
  const plannedNet = s.income.planned - s.expense.planned;
  const isCurrent = year === today.getFullYear() && month === today.getMonth();

  const e = view.editTx;
  const d = view.draft || {};
  const defDate = isCurrent ? todayStr : `${core.ym(year, month)}-01`;
  const fCat = e?.cat ?? d.cat ?? view.lastCat ?? budget.categories.find(c => c.type === 'expense')?.name;

  const txs = s.tx.slice().reverse().map(t => {
    const i = budget.tx.indexOf(t);
    const type = budget.categories.find(c => c.name === t.cat)?.type;
    return `<li class="${t === e ? 'editing' : ''}">
      <span class="day">${+t.date.slice(8)}</span>
      <span class="desc"><b>${esc(t.cat)}</b>${t.note ? `<br><span class="muted">${esc(t.note)}</span>` : ''}</span>
      <span class="amt ${type === 'income' ? 'pos' : ''}">${type === 'income' ? '+' : ''}${money(t.amount)}</span>
      <button class="icon" data-act="editTx" data-i="${i}" title="Edit">✎</button>
      <button class="icon" data-act="delTx" data-i="${i}" title="Delete">✕</button>
    </li>`;
  }).join('');

  return `
  <div class="pager">
    <button data-act="prevMonth" aria-label="Previous month">‹</button>
    <h2>${esc(monthTitle(year, month))}</h2>
    <button data-act="nextMonth" aria-label="Next month">›</button>
  </div>
  ${isCurrent ? '' : '<p class="center"><button class="link" data-act="thisMonth">Back to this month</button></p>'}
  <div class="cards">
    <div class="card"><div class="label">Income</div><div class="big pos">${money(s.income.actual)}</div><div class="muted small">of ${money(s.income.planned)} planned</div></div>
    <div class="card"><div class="label">Expenses</div><div class="big">${money(s.expense.actual)}</div><div class="muted small">of ${money(s.expense.planned)} planned</div></div>
    <div class="card"><div class="label">Net</div><div class="big ${net < 0 ? 'neg' : 'pos'}">${money(net)}</div><div class="muted small">planned ${money(plannedNet)}</div></div>
  </div>

  <form id="txForm" class="panel">
    <h3>${e ? 'Edit transaction' : 'Add transaction'}</h3>
    <div class="formgrid">
      <label>Date<input type="date" name="date" required value="${esc(e?.date ?? d.date ?? defDate)}"></label>
      <label>Category<select name="cat" required>${catOptions(fCat)}</select></label>
      <label>Amount<input name="amount" inputmode="decimal" required autocomplete="off" placeholder="0.00" value="${e ? core.fmtNum(e.amount) : esc(d.amount ?? '')}"></label>
      <label class="wide">Note<input name="note" autocomplete="off" placeholder="optional" value="${esc(e?.note ?? d.note ?? '')}"></label>
    </div>
    <div class="actions">
      ${e ? '<button type="button" data-act="cancelEdit">Cancel</button>' : ''}
      <button type="submit" class="primary">${e ? 'Save' : 'Add'}</button>
    </div>
  </form>

  ${visible.length === 0 && s.tx.length === 0
    ? `<p class="muted center">No plan for this month yet. <button class="link" data-act="goYear">Plan your year →</button></p>` : ''}
  <h3>Expenses</h3>${catRows(visible.filter(r => r.type === 'expense'))}
  <h3>Income</h3>${catRows(visible.filter(r => r.type === 'income'))}
  <h3>Transactions</h3>
  ${txs ? `<ul class="txlist">${txs}</ul>` : '<p class="muted">No transactions this month.</p>'}`;
}

function renderYear() {
  const y = String(view.year);
  const plans = budget.plans[y] || {};
  const stats = core.yearStats(budget, y);
  const months = core.MONTH_NAMES;
  const curM = view.year === today.getFullYear() ? today.getMonth() : -1;
  const th = m => `<th class="${m === curM ? 'cur' : ''}">${months[m]}</th>`;
  const head = `<tr><th class="sticky">Category</th>${months.map((_, m) => th(m)).join('')}<th>Year</th></tr>`;

  const section = type => {
    const cats = budget.categories.filter(c => c.type === type);
    const rows = cats.map(c => {
      const row = plans[c.name] || Array(12).fill(0);
      const cells = row.map((v, m) => `<td class="${m === curM ? 'cur' : ''}"><input data-plan data-cat="${esc(c.name)}" data-m="${m}"
        data-focus="p:${esc(c.name)}:${m}" inputmode="decimal" value="${v ? core.fmtNum(v) : ''}"></td>`).join('');
      return `<tr><th class="sticky">${esc(c.name)}
        <button class="icon small" data-act="fillRow" data-cat="${esc(c.name)}" title="Copy first value to all months">⇉</button></th>
        ${cells}<td class="total">${money0(row.reduce((a, b) => a + b, 0))}</td></tr>`;
    }).join('');
    const tot = months.map((_, m) => stats[m][type].planned);
    return `<tr class="section"><th class="sticky">${type === 'income' ? 'Income' : 'Expenses'}</th><td colspan="13"></td></tr>${rows}
      <tr class="sum"><th class="sticky">Total ${type}</th>${tot.map(v => `<td>${money0(v)}</td>`).join('')}<td>${money0(tot.reduce((a, b) => a + b, 0))}</td></tr>`;
  };

  let cum = 0, cumP = 0;
  const pNet = stats.map(s => s.plannedNet);
  const future = m => view.year > today.getFullYear() || (curM !== -1 && m > curM);
  const aNet = stats.map((s, m) => future(m) ? null : s.actualNet);
  const cumPlan = pNet.map(v => (cumP += v));
  const cumAct = aNet.map(v => v == null ? null : (cum += v));
  const sumRow = (label, vals, total) => `<tr class="sum"><th class="sticky">${label}</th>${vals.map(v =>
    `<td class="${v < 0 ? 'neg' : ''}">${v == null ? '' : money0(v)}</td>`).join('')}<td>${total == null ? '' : money0(total)}</td></tr>`;

  const hasPrev = !!budget.plans[String(view.year - 1)];
  const maxAbs = Math.max(1, ...stats.flatMap(s => [s.income.planned, s.expense.planned, s.income.actual, s.expense.actual]));
  const chart = stats.map((s, m) => `<div class="col ${m === curM ? 'cur' : ''}" title="${months[m]}">
      <div class="bars">
        <div class="b inc" style="height:${(s.income.planned / maxAbs) * 100}%"></div>
        <div class="b incA" style="height:${(s.income.actual / maxAbs) * 100}%"></div>
        <div class="b exp" style="height:${(s.expense.planned / maxAbs) * 100}%"></div>
        <div class="b expA" style="height:${(s.expense.actual / maxAbs) * 100}%"></div>
      </div><div class="small">${months[m][0]}</div></div>`).join('');

  return `
  <div class="pager">
    <button data-act="prevYear" aria-label="Previous year">‹</button>
    <h2>Plan ${y}</h2>
    <button data-act="nextYear" aria-label="Next year">›</button>
  </div>
  <div class="actions left">
    ${hasPrev ? `<button data-act="copyPlan">Copy plan from ${view.year - 1}</button>` : ''}
    <button data-act="goCats">Edit categories</button>
  </div>
  <div class="cards">
    <div class="card"><div class="label">Planned income</div><div class="big pos">${money(stats.reduce((a, s) => a + s.income.planned, 0))}</div></div>
    <div class="card"><div class="label">Planned expenses</div><div class="big">${money(stats.reduce((a, s) => a + s.expense.planned, 0))}</div></div>
    <div class="card"><div class="label">Planned net</div><div class="big">${money(pNet.reduce((a, b) => a + b, 0))}</div></div>
  </div>
  <div class="chart">${chart}</div>
  <div class="legend small"><span class="sw inc"></span>Income plan <span class="sw incA"></span>actual
    <span class="sw exp"></span>Expense plan <span class="sw expA"></span>actual</div>
  <p class="muted small">Enter the planned amount per month. ⇉ copies the first filled month to all months.</p>
  <div class="gridwrap"><table class="grid">
    <thead>${head}</thead>
    <tbody>${section('income')}${section('expense')}</tbody>
    <tfoot>
      ${sumRow('Planned net', pNet, pNet.reduce((a, b) => a + b, 0))}
      ${sumRow('Actual net', aNet, aNet.reduce((a, b) => a + (b || 0), 0))}
      ${sumRow('Cumulative plan', cumPlan, null)}
      ${sumRow('Cumulative actual', cumAct, null)}
    </tfoot>
  </table></div>`;
}

function renderCats() {
  const used = name => budget.tx.filter(t => t.cat === name).length;
  const rows = budget.categories.map((c, i) => `<li>
      <input data-rename="${i}" data-focus="cat:${i}" value="${esc(c.name)}">
      <select data-ctype="${i}">${typeOptions(c)}</select>
      <span class="muted small">${used(c.name)} tx</span>
      <button class="icon" data-act="delCat" data-i="${i}" title="Delete">✕</button>
    </li>`).join('');
  return `<h2>Categories</h2>
    <ul class="catlist">${rows}</ul>
    <form id="catForm" class="panel row">
      <input name="name" placeholder="New category" required>
      <select name="type">${typeOptions({ type: 'expense' })}</select>
      <button class="primary">Add</button>
    </form>
    <p class="muted small"><b>Certain</b> income/expense: the planned amount counts as actual in any month without
      transactions in that category (e.g. salary, rent). Entering a transaction replaces the automatic amount.</p>
    <h3>Settings</h3>
    <label class="row">Currency <input id="currency" maxlength="3" size="4" value="${esc(budget.currency)}"></label>`;
}

const TYPES = [['expense', 'Expense'], ['expense certain', 'Certain expense'],
  ['income', 'Income'], ['income certain', 'Certain income']];
function typeOptions(c) {
  const cur = c.type + (c.certain ? ' certain' : '');
  return TYPES.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('');
}
const parseType = v => ({ type: v.split(' ')[0], certain: v.endsWith(' certain') });

function renderText() {
  return `<h2>Plain text</h2>
    <p class="muted small">This is exactly what's stored and synced. Edit it directly and press Apply.</p>
    ${errors.length ? `<div class="errors">${errors.map(e =>
      `<div class="${e.warn ? 'warn' : 'err'}">Line ${e.line}: ${esc(e.msg)}</div>`).join('')}</div>` : ''}
    <textarea id="raw" spellcheck="false">${esc(text)}</textarea>
    <div class="actions">
      <button data-act="rawRevert">Revert</button>
      <button class="primary" data-act="rawApply">Apply</button>
    </div>`;
}

function renderSync() {
  const clientId = ls.get(K.clientId) || '';
  const last = ls.get(K.lastSync);
  return `<h2>Sync &amp; file</h2>
    <section class="panel">
      <h3>Google Drive</h3>
      <p class="small muted">Keeps <code>budget.txt</code> in your Google Drive and merges changes from your other devices.
        Needs an OAuth Client ID. See README.md for setup.</p>
      <label>OAuth Client ID<input id="clientId" value="${esc(clientId)}" placeholder="xxxx.apps.googleusercontent.com"></label>
      <div class="actions left">
        <button class="primary" data-act="sync" ${clientId ? '' : 'disabled'}>Sync now</button>
        ${ls.get(K.fileId) ? '<button data-act="unlink">Disconnect</button>' : ''}
      </div>
      <p class="small">Status: <b>${esc(syncLabel())}</b>${sync.msg ? ` - ${esc(sync.msg)}` : ''}</p>
      ${last ? `<p class="small muted">Last synced ${esc(new Date(+last).toLocaleString())}</p>` : ''}
    </section>
    <section class="panel">
      <h3>Local file</h3>
      <div class="actions left">
        <button data-act="download">Download budget.txt</button>
        <label class="button">Import file…<input type="file" id="importFile" accept=".txt,text/plain" hidden></label>
      </div>
      <p class="small muted">Import merges the file into your current data. Use the Text tab to replace everything.</p>
    </section>`;
}

// ---------- sync ----------

function syncLabel() {
  if (!ls.get(K.clientId)) return 'not set up';
  if (sync.status === 'busy') return 'syncing…';
  if (sync.status === 'error') return 'error';
  if (!ls.get(K.fileId)) return 'not connected';
  return text === ls.get(K.base) ? 'synced' : 'local changes';
}

function renderSyncButton() {
  const b = document.getElementById('syncBtn');
  const label = syncLabel();
  b.textContent = { 'synced': '✓ Synced', 'local changes': '⟳ Sync', 'syncing…': '⟳ …', 'error': '⚠ Sync', 'not set up': '☁ Set up sync', 'not connected': '☁ Sync' }[label];
  b.className = label.replace(/\W/g, '');
}

let syncTimer = null;
function scheduleSync() {
  clearTimeout(syncTimer);
  if (ls.get(K.clientId) && ls.get(K.fileId) && drive.hasValidToken())
    syncTimer = setTimeout(() => syncNow(), 2000);
  else renderSyncButton();
}

async function syncNow() {
  const clientId = ls.get(K.clientId);
  if (!clientId) { view.tab = 'sync'; render(); return; }
  if (sync.status === 'busy') return;
  sync.status = 'busy'; sync.msg = ''; render();
  try {
    await drive.signIn(clientId);
    let fileId = ls.get(K.fileId);
    let meta = fileId ? await drive.getMeta(fileId) : null;
    if (!meta) {
      meta = await drive.findFile();
      if (meta) { fileId = meta.id; ls.set(K.version, null); ls.set(K.base, null); }
    }
    const local = text;
    const base = ls.get(K.base); // null = never synced with this file
    let result, version;
    if (!meta) {
      const r = await drive.create(local);
      fileId = r.id; version = r.version; result = local;
      sync.msg = 'created budget.txt in Drive';
    } else if (meta.version === ls.get(K.version)) {
      result = local; version = meta.version;
      if (local !== base) version = (await drive.update(fileId, local)).version;
    } else {
      const remote = await drive.download(fileId);
      result = local === base ? remote : core.merge(base, local, remote);
      version = result === remote ? meta.version : (await drive.update(fileId, result)).version;
      if (result !== local) setText(result);
      if (local !== base && result !== remote) sync.msg = 'merged changes from another device';
    }
    ls.set(K.fileId, fileId);
    ls.set(K.version, String(version));
    ls.set(K.base, result);
    ls.set(K.lastSync, String(Date.now()));
    sync.status = 'idle';
    // If the user edited during the sync, sync again.
    if (text !== result) scheduleSync();
  } catch (e) {
    sync.status = 'error';
    sync.msg = e.message;
  }
  render();
}

// ---------- events ----------

document.querySelector('nav.tabs').addEventListener('click', e => {
  const t = e.target.closest('button')?.dataset.tab;
  if (t) { view.tab = t; view.editTx = null; render(); window.scrollTo(0, 0); }
});
document.getElementById('syncBtn').addEventListener('click', () => syncNow());

const actions = {
  prevMonth() { if (--view.month < 0) { view.month = 11; view.year--; } view.editTx = null; },
  nextMonth() { if (++view.month > 11) { view.month = 0; view.year++; } view.editTx = null; },
  thisMonth() { view.year = today.getFullYear(); view.month = today.getMonth(); },
  prevYear() { view.year--; },
  nextYear() { view.year++; },
  goYear() { view.tab = 'year'; },
  goCats() { view.tab = 'cats'; },
  editTx(el) { view.editTx = budget.tx[+el.dataset.i]; window.scrollTo({ top: document.getElementById('txForm').offsetTop - 70, behavior: 'smooth' }); },
  cancelEdit() { view.editTx = null; },
  delTx(el) {
    const t = budget.tx[+el.dataset.i];
    if (!confirm(`Delete ${t.cat} ${money(t.amount)} on ${t.date}?`)) return false;
    budget.tx.splice(+el.dataset.i, 1);
    if (view.editTx === t) view.editTx = null;
    commit(); return false;
  },
  fillRow(el) {
    const row = core.planRow(budget, String(view.year), el.dataset.cat);
    const v = row.find(x => x) || 0;
    row.fill(v);
    commit(); return false;
  },
  copyPlan() {
    const y = String(view.year);
    if (budget.plans[y] && Object.values(budget.plans[y]).some(r => r.some(x => x))
      && !confirm(`Overwrite the ${y} plan with ${view.year - 1}'s?`)) return false;
    core.copyPlan(budget, String(view.year - 1), y);
    commit(); return false;
  },
  delCat(el) {
    const c = budget.categories[+el.dataset.i];
    const n = budget.tx.filter(t => t.cat === c.name).length;
    if (!confirm(`Delete category "${c.name}"${n ? ` and its ${n} transaction(s)` : ''} and its plans?`)) return false;
    core.deleteCategory(budget, c.name);
    commit(); return false;
  },
  rawApply() {
    const r = core.parse(document.getElementById('raw').value);
    if (r.errors.some(e => !e.warn) && !confirm(`${r.errors.length} line(s) have problems and will be dropped. Apply anyway?`)) {
      errors = r.errors; text = document.getElementById('raw').value; render(); text = ls.get(K.text); return false;
    }
    setText(document.getElementById('raw').value);
    errors = r.errors;
    scheduleSync();
  },
  rawRevert() { ({ errors } = core.parse(text)); },
  sync() { syncNow(); return false; },
  unlink() {
    if (!confirm('Stop syncing with Google Drive on this device? Your data stays here and in Drive.')) return false;
    drive.signOut();
    [K.fileId, K.version, K.base, K.lastSync].forEach(k => ls.set(k, null));
  },
  download() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = 'budget.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return false;
  },
};

main.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || !actions[el.dataset.act]) return;
  e.preventDefault();
  if (actions[el.dataset.act](el) !== false) render();
});

main.addEventListener('submit', e => {
  e.preventDefault();
  const f = new FormData(e.target);
  if (e.target.id === 'txForm') {
    let amount;
    try { amount = core.parseAmount(f.get('amount')); } catch { alert('Please enter a valid amount'); return; }
    const t = { date: f.get('date'), cat: f.get('cat'), amount, note: f.get('note').trim() };
    if (view.editTx) Object.assign(view.editTx, t); else budget.tx.push(t);
    core.sortTx(budget);
    view.editTx = null; view.draft = null; view.lastCat = t.cat;
    [view.year, view.month] = [+t.date.slice(0, 4), +t.date.slice(5, 7) - 1];
    commit();
    main.querySelector('input[name=amount]')?.focus();
  } else if (e.target.id === 'catForm') {
    const name = f.get('name').trim();
    if (!name || budget.categories.some(c => c.name === name)) { alert('Category exists or name is empty'); return; }
    budget.categories.push({ name, ...parseType(f.get('type')) });
    commit();
  }
});

// Keep unsaved form input when the screen re-renders (e.g. after a sync).
main.addEventListener('input', e => {
  const form = e.target.closest('#txForm');
  if (form && !view.editTx) view.draft = Object.fromEntries(new FormData(form));
});

main.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.plan !== undefined) {
    let v = 0;
    if (el.value.trim()) {
      try { v = core.parseAmount(el.value); } catch { el.classList.add('bad'); return; }
    }
    core.planRow(budget, String(view.year), el.dataset.cat)[+el.dataset.m] = v;
    commit({ deferRender: true });
  } else if (el.dataset.rename !== undefined) {
    const c = budget.categories[+el.dataset.rename];
    const name = el.value.trim();
    if (!name || budget.categories.some(x => x !== c && x.name === name)) { el.value = c.name; return; }
    core.renameCategory(budget, c.name, name);
    commit({ deferRender: true });
  } else if (el.dataset.ctype !== undefined) {
    Object.assign(budget.categories[+el.dataset.ctype], parseType(el.value));
    commit();
  } else if (el.id === 'currency') {
    if (/^[A-Za-z]{3}$/.test(el.value)) { budget.currency = el.value.toUpperCase(); commit(); }
  } else if (el.id === 'clientId') {
    ls.set(K.clientId, el.value.trim() || null);
    render();
  } else if (el.id === 'importFile' && el.files[0]) {
    el.files[0].text().then(t => {
      setText(core.merge(null, text, t));
      alert('Imported and merged.');
      scheduleSync();
    });
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && drive.hasValidToken() && ls.get(K.fileId)) syncNow();
});

if ('serviceWorker' in navigator && location.protocol !== 'file:')
  navigator.serviceWorker.register('sw.js').catch(() => {});

render();
if (drive.hasValidToken() && ls.get(K.fileId)) syncNow();
