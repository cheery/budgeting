import * as core from './core.js';
import * as drive from './drive.js';
import * as learn from './learn.js';
import { LANGS, LOCALE, translator, errorText } from './i18n.js';

// ---------- persistence ----------

const K = {
  text: 'budget.text', base: 'budget.syncBase', fileId: 'budget.driveFileId',
  version: 'budget.driveVersion', clientId: 'budget.clientId', lastSync: 'budget.lastSync',
  lang: 'budget.lang', learn: 'budget.learn',
};
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

// ---------- language ----------

function detectLang() {
  const l = ls.get(K.lang);
  if (l in LANGS) return l;
  return (navigator.language || '').toLowerCase().startsWith('fi') ? 'fi' : 'en';
}
let lang = detectLang();
let t = translator(lang);
let fmtCache = {};

function setLang(l, persist = true) {
  lang = l in LANGS ? l : 'en';
  t = translator(lang);
  fmtCache = {};
  if (persist) ls.set(K.lang, lang);  // until the user picks one, follow the browser
  document.documentElement.lang = lang;
}

// Starter categories are named in the language the app is first opened in.
function starterText() {
  const [salary, otherIncome, rent, ...expenses] = t('starter');
  return core.serialize({
    currency: 'EUR',
    categories: [
      { name: salary, type: 'income', certain: true },
      { name: otherIncome, type: 'income' },
      { name: rent, type: 'expense', certain: true },
      ...expenses.map(name => ({ name, type: 'expense' })),
    ],
    plans: {}, tx: [],
  });
}

let text = ls.get(K.text) ?? starterText();
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

function saveText(s) {
  text = s;
  ls.set(K.text, s);
}

// Model changed through the UI: re-serialize, store, re-render, sync.
function commit({ deferRender = false } = {}) {
  saveText(core.serialize(budget));
  errors = [];
  deferRender ? setTimeout(render, 0) : render();
  scheduleSync();
}

// Text changed from outside (raw editor, import, Drive).
function setText(s) {
  saveText(s);
  ({ budget, errors } = core.parse(s));
  render();
}

// ---------- formatting ----------

function money(n, whole = false) {
  const key = budget.currency + whole;
  if (!fmtCache[key]) {
    const opts = { style: 'currency', currency: budget.currency, ...(whole ? { maximumFractionDigits: 0, minimumFractionDigits: 0 } : {}) };
    try { fmtCache[key] = new Intl.NumberFormat(LOCALE[lang], opts); }
    catch { fmtCache[key] = { format: x => `${x.toFixed(whole ? 0 : 2)} ${budget.currency}` }; }
  }
  return fmtCache[key].format(n);
}
const money0 = n => money(n, true);
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const monthTitle = (y, m) => new Date(y, m, 1).toLocaleString(LOCALE[lang], { month: 'long', year: 'numeric' });
const fmtDate = iso => new Date(iso + 'T00:00:00').toLocaleDateString(LOCALE[lang]);

// ---------- rendering ----------

const main = document.getElementById('main');

function renderChrome() {
  document.title = document.querySelector('header h1').textContent = t('app.title');
  document.querySelectorAll('nav.tabs button').forEach(b => {
    b.textContent = t('tab.' + b.dataset.tab);
    b.classList.toggle('on', b.dataset.tab === view.tab);
  });
  const sel = document.getElementById('langSel');
  sel.setAttribute('aria-label', t('lang.label'));
  sel.title = t('lang.label');
  sel.value = lang;
  const back = document.getElementById('backToLesson');
  back.hidden = !(view.fromLesson && view.tab !== 'learn');
  back.textContent = learn.UI[lang].back;
  renderSyncButton();
}

function render() {
  const active = document.activeElement?.dataset?.focus;
  const sel = active && document.activeElement.selectionStart != null
    ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;

  document.body.dataset.tab = view.tab;
  main.innerHTML = { month: renderMonth, year: renderYear, cats: renderCats, text: renderText, sync: renderSync, learn: renderLearn }[view.tab]();
  renderChrome();

  if (active) {
    const el = main.querySelector(`[data-focus="${CSS.escape(active)}"]`);
    if (el) { el.focus(); if (sel) try { el.setSelectionRange(...sel); } catch {} }
  }
}

function catOptions(selected) {
  const group = type => budget.categories.filter(c => c.type === type)
    .map(c => `<option ${c.name === selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  return `<optgroup label="${esc(t('h.expenses'))}">${group('expense')}</optgroup><optgroup label="${esc(t('h.income'))}">${group('income')}</optgroup>`;
}

function bar(r) {
  const pct = r.planned > 0 ? Math.min(100, (r.actual / r.planned) * 100) : (r.actual ? 100 : 0);
  const over = r.type === 'expense' && r.actual > r.planned;
  return `<div class="bar"><div class="${over ? 'over' : r.type}" style="width:${pct}%"></div></div>`;
}

function catRows(rows) {
  if (!rows.length) return `<p class="muted">${esc(t('cat.nothing'))}</p>`;
  return rows.map(r => {
    const left = r.planned - r.actual;
    const leftTxt = r.type === 'expense'
      ? (left >= 0 ? esc(t('cat.left', money(left))) : `<span class="neg">${esc(t('cat.over', money(-left)))}</span>`)
      : esc(left > 0 ? t('cat.toGo', money(left)) : t('cat.received'));
    const tag = r.certain
      ? ` <span class="tag" title="${esc(t('tag.title'))}">${esc(t('tag.certain'))}${r.auto ? ' · ' + esc(t('tag.auto')) : ''}</span>` : '';
    return `<div class="catrow${r.auto ? ' auto' : ''}">
      <div class="catline"><span class="name">${esc(r.cat)}${tag}</span>
        <span class="amt">${money(r.actual)} <span class="muted">/ ${money(r.planned)}</span></span></div>
      ${bar(r)}
      <div class="small muted right">${r.auto ? esc(t('cat.fromPlan')) + ' · ' : ''}${leftTxt}</div>
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

  const txs = s.tx.slice().reverse().map(tx => {
    const i = budget.tx.indexOf(tx);
    const type = budget.categories.find(c => c.name === tx.cat)?.type;
    return `<li class="${tx === e ? 'editing' : ''}">
      <span class="day">${+tx.date.slice(8)}</span>
      <span class="desc"><b>${esc(tx.cat)}</b>${tx.note ? `<br><span class="muted">${esc(tx.note)}</span>` : ''}</span>
      <span class="amt ${type === 'income' ? 'pos' : ''}">${type === 'income' ? '+' : ''}${money(tx.amount)}</span>
      <button class="icon" data-act="editTx" data-i="${i}" title="${esc(t('btn.edit'))}">✎</button>
      <button class="icon" data-act="delTx" data-i="${i}" title="${esc(t('btn.delete'))}">✕</button>
    </li>`;
  }).join('');

  return `${learnBanner()}
  <div class="pager">
    <button data-act="prevMonth" aria-label="${esc(t('month.prev'))}">‹</button>
    <h2>${esc(monthTitle(year, month))}</h2>
    <button data-act="nextMonth" aria-label="${esc(t('month.next'))}">›</button>
  </div>
  ${isCurrent ? '' : `<p class="center"><button class="link" data-act="thisMonth">${esc(t('month.backToCurrent'))}</button></p>`}
  <div class="cards">
    <div class="card"><div class="label">${esc(t('card.income'))}</div><div class="big pos">${money(s.income.actual)}</div><div class="muted small">${esc(t('card.ofPlanned', money(s.income.planned)))}</div></div>
    <div class="card"><div class="label">${esc(t('card.expenses'))}</div><div class="big">${money(s.expense.actual)}</div><div class="muted small">${esc(t('card.ofPlanned', money(s.expense.planned)))}</div></div>
    <div class="card"><div class="label">${esc(t('card.net'))}</div><div class="big ${net < 0 ? 'neg' : 'pos'}">${money(net)}</div><div class="muted small">${esc(t('card.planned', money(plannedNet)))}</div></div>
  </div>

  <form id="txForm" class="panel">
    <h3>${esc(t(e ? 'tx.edit' : 'tx.add'))}</h3>
    <div class="formgrid">
      <label>${esc(t('f.date'))}<input type="date" name="date" required value="${esc(e?.date ?? d.date ?? defDate)}"></label>
      <label>${esc(t('f.category'))}<select name="cat" required>${catOptions(fCat)}</select></label>
      <label>${esc(t('f.amount'))}<input name="amount" inputmode="decimal" required autocomplete="off" placeholder="${esc(t('f.amountPh'))}" value="${e ? core.fmtNum(e.amount) : esc(d.amount ?? '')}"></label>
      <label class="wide">${esc(t('f.note'))}<input name="note" autocomplete="off" placeholder="${esc(t('f.optional'))}" value="${esc(e?.note ?? d.note ?? '')}"></label>
    </div>
    <div class="actions">
      ${e ? `<button type="button" data-act="cancelEdit">${esc(t('btn.cancel'))}</button>` : ''}
      <button type="submit" class="primary">${esc(t(e ? 'btn.save' : 'btn.add'))}</button>
    </div>
  </form>

  ${visible.length === 0 && s.tx.length === 0
    ? `<p class="muted center">${esc(t('month.noPlan'))} <button class="link" data-act="goYear">${esc(t('month.planYear'))}</button></p>` : ''}
  <h3>${esc(t('h.expenses'))}</h3>${catRows(visible.filter(r => r.type === 'expense'))}
  <h3>${esc(t('h.income'))}</h3>${catRows(visible.filter(r => r.type === 'income'))}
  <h3>${esc(t('h.transactions'))}</h3>
  ${txs ? `<ul class="txlist">${txs}</ul>` : `<p class="muted">${esc(t('month.noTx'))}</p>`}`;
}

function renderYear() {
  const y = String(view.year);
  const plans = budget.plans[y] || {};
  const stats = core.yearStats(budget, y);
  const months = t('months');
  const curM = view.year === today.getFullYear() ? today.getMonth() : -1;
  const th = m => `<th class="${m === curM ? 'cur' : ''}">${esc(months[m])}</th>`;
  const head = `<tr><th class="sticky">${esc(t('year.category'))}</th>${months.map((_, m) => th(m)).join('')}<th>${esc(t('year.year'))}</th></tr>`;

  const section = type => {
    const cats = budget.categories.filter(c => c.type === type);
    const rows = cats.map(c => {
      const row = plans[c.name] || Array(12).fill(0);
      const cells = row.map((v, m) => `<td class="${m === curM ? 'cur' : ''}"><input data-plan data-cat="${esc(c.name)}" data-m="${m}"
        data-focus="p:${esc(c.name)}:${m}" inputmode="decimal" aria-label="${esc(c.name)} ${esc(months[m])}" value="${v ? core.fmtNum(v) : ''}"></td>`).join('');
      return `<tr><th class="sticky">${esc(c.name)}
        <button class="icon small" data-act="fillRow" data-cat="${esc(c.name)}" title="${esc(t('year.fillTitle'))}">⇉</button></th>
        ${cells}<td class="total">${money0(row.reduce((a, b) => a + b, 0))}</td></tr>`;
    }).join('');
    const tot = months.map((_, m) => stats[m][type].planned);
    return `<tr class="section"><th class="sticky">${esc(t(type === 'income' ? 'h.income' : 'h.expenses'))}</th><td colspan="13"></td></tr>${rows}
      <tr class="sum"><th class="sticky">${esc(t(type === 'income' ? 'year.totalIncome' : 'year.totalExpense'))}</th>${tot.map(v => `<td>${money0(v)}</td>`).join('')}<td>${money0(tot.reduce((a, b) => a + b, 0))}</td></tr>`;
  };

  const future = m => view.year > today.getFullYear() || (curM !== -1 && m > curM);
  let cum = 0, cumP = 0;
  const pNet = stats.map(s => s.plannedNet);
  const aNet = stats.map((s, m) => future(m) ? null : s.actualNet);
  const cumPlan = pNet.map(v => (cumP += v));
  const cumAct = aNet.map(v => v == null ? null : (cum += v));
  const sumRow = (label, vals, total) => `<tr class="sum"><th class="sticky">${esc(label)}</th>${vals.map(v =>
    `<td class="${v < 0 ? 'neg' : ''}">${v == null ? '' : money0(v)}</td>`).join('')}<td>${total == null ? '' : money0(total)}</td></tr>`;

  const hasPrev = !!budget.plans[String(view.year - 1)];
  const maxAbs = Math.max(1, ...stats.flatMap(s => [s.income.planned, s.expense.planned, s.income.actual, s.expense.actual]));
  const chart = stats.map((s, m) => `<div class="col ${m === curM ? 'cur' : ''}" title="${esc(months[m])}">
      <div class="bars">
        <div class="b inc" style="height:${(s.income.planned / maxAbs) * 100}%"></div>
        <div class="b incA" style="height:${future(m) ? 0 : (s.income.actual / maxAbs) * 100}%"></div>
        <div class="b exp" style="height:${(s.expense.planned / maxAbs) * 100}%"></div>
        <div class="b expA" style="height:${future(m) ? 0 : (s.expense.actual / maxAbs) * 100}%"></div>
      </div><div class="small">${esc(months[m][0].toUpperCase())}</div></div>`).join('');

  return `
  <div class="pager">
    <button data-act="prevYear" aria-label="${esc(t('year.prev'))}">‹</button>
    <h2>${esc(t('year.title', y))}</h2>
    <button data-act="nextYear" aria-label="${esc(t('year.next'))}">›</button>
  </div>
  <div class="actions left">
    ${hasPrev ? `<button data-act="copyPlan">${esc(t('year.copyPlan', view.year - 1))}</button>` : ''}
    <button data-act="goCats">${esc(t('year.editCats'))}</button>
  </div>
  <div class="cards">
    <div class="card"><div class="label">${esc(t('year.plannedIncome'))}</div><div class="big pos">${money(stats.reduce((a, s) => a + s.income.planned, 0))}</div></div>
    <div class="card"><div class="label">${esc(t('year.plannedExpenses'))}</div><div class="big">${money(stats.reduce((a, s) => a + s.expense.planned, 0))}</div></div>
    <div class="card"><div class="label">${esc(t('year.plannedNet'))}</div><div class="big">${money(pNet.reduce((a, b) => a + b, 0))}</div></div>
  </div>
  <div class="chart">${chart}</div>
  <div class="legend small"><span class="sw inc"></span>${esc(t('legend.incPlan'))} <span class="sw incA"></span>${esc(t('legend.actual'))}
    <span class="sw exp"></span>${esc(t('legend.expPlan'))} <span class="sw expA"></span>${esc(t('legend.actual'))}</div>
  <p class="muted small">${esc(t('year.hint'))}</p>
  <div class="gridwrap"><table class="grid">
    <thead>${head}</thead>
    <tbody>${section('income')}${section('expense')}</tbody>
    <tfoot>
      ${sumRow(t('year.plannedNet'), pNet, pNet.reduce((a, b) => a + b, 0))}
      ${sumRow(t('year.actualNet'), aNet, aNet.reduce((a, b) => a + (b || 0), 0))}
      ${sumRow(t('year.cumPlan'), cumPlan, null)}
      ${sumRow(t('year.cumActual'), cumAct, null)}
    </tfoot>
  </table></div>`;
}

function renderCats() {
  const uses = budget.categories.map(c => core.categoryUses(budget, c.name));
  const rows = budget.categories.map((c, i) => `<li>
      <input data-rename="${i}" data-focus="cat:${i}" value="${esc(c.name)}" aria-label="${esc(t('f.category'))}">
      <select data-ctype="${i}">${typeOptions(c)}</select>
      <span class="muted small" title="${esc(t('cats.usesTitle'))}">${uses[i]} x</span>
      <button class="icon" data-act="delCat" data-i="${i}" ${uses[i] ? `disabled title="${esc(t('cats.inUse', uses[i]))}"` : `title="${esc(t('btn.delete'))}"`}>✕</button>
    </li>`).join('');
  return `<h2>${esc(t('cats.title'))}</h2>
    <ul class="catlist">${rows}</ul>
    <form id="catForm" class="panel row">
      <input name="name" placeholder="${esc(t('cats.new'))}" required>
      <select name="type">${typeOptions({ type: 'expense' })}</select>
      <button class="primary">${esc(t('btn.add'))}</button>
    </form>
    <p class="muted small">${t('cats.usesHelp')}</p>
    <p class="muted small">${t('cats.certainHelp')}</p>
    <h3>${esc(t('cats.settings'))}</h3>
    <label class="row">${esc(t('cats.currency'))} <input id="currency" maxlength="3" size="4" value="${esc(budget.currency)}"></label>`;
}

const TYPES = [['expense', 'type.expense'], ['expense certain', 'type.expenseCertain'],
  ['income', 'type.income'], ['income certain', 'type.incomeCertain']];
function typeOptions(c) {
  const cur = c.type + (c.certain ? ' certain' : '');
  return TYPES.map(([v, k]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${esc(t(k))}</option>`).join('');
}
const parseType = v => ({ type: v.split(' ')[0], certain: v.endsWith(' certain') });

// ---------- training mode ----------

function learnState() {
  try { return { done: {}, dismissed: false, ...JSON.parse(ls.get(K.learn) || '{}') }; }
  catch { return { done: {}, dismissed: false }; }
}
function saveLearn(patch) { ls.set(K.learn, JSON.stringify({ ...learnState(), ...patch })); }
function lessonStatus(l) {
  const detected = learn.detect(l, budget, today) === true;
  const manual = !!learnState().done[l.id];
  return { detected, manual, done: detected || manual };
}
const doneCount = () => learn.LESSONS.filter(l => lessonStatus(l).done).length;
// Lesson text refers to UI labels as {key}, so it always matches the current translation.
const fillLabels = html => html.replace(/\{([\w.]+)\}/g, (_, k) => esc(t(k)));

function learnBanner() {
  if (learnState().dismissed || doneCount() > 0) return '';
  const u = learn.UI[lang];
  return `<div class="panel learnbanner">
    <span>🎓 ${esc(u.banner)}</span>
    <span class="actions"><button data-act="dismissLearn">${esc(u.notNow)}</button>
    <button class="primary" data-act="startLearn">${esc(u.start)}</button></span>
  </div>`;
}

function renderLearn() {
  const u = learn.UI[lang], total = learn.LESSONS.length, n = doneCount();
  if (view.lesson == null) view.lesson = learn.LESSONS.find(l => !lessonStatus(l).done)?.id || '';
  const items = learn.LESSONS.map((l, i) => {
    const c = l[lang], st = lessonStatus(l), open = view.lesson === l.id;
    return `<li class="lesson ${open ? 'open' : ''} ${st.done ? 'done' : ''}" id="lesson-${l.id}">
      <button class="lhead" data-act="openLesson" data-id="${l.id}" aria-expanded="${open}">
        <span class="check">${st.done ? '✓' : i + 1}</span><span class="ltitle">${esc(c.title)}</span><span class="chev">${open ? '▾' : '▸'}</span>
      </button>
      ${open ? `<div class="lbody">${fillLabels(c.body)}
        ${c.tip ? `<p class="tip"><b>${esc(u.tip)}:</b> ${fillLabels(esc(c.tip))}</p>` : ''}
        ${st.detected ? `<p class="small pos">✓ ${esc(u.detected)}</p>` : ''}
        <div class="actions left">
          ${l.action ? `<button class="primary" data-act="tryLesson" data-id="${l.id}">${esc(u.tryIt)}</button>` : ''}
          ${st.detected ? '' : `<button data-act="markLesson" data-id="${l.id}">${esc(st.manual ? u.undo : u.markDone)}</button>`}
          ${i < total - 1 ? `<button class="link" data-act="nextLesson" data-id="${l.id}">${esc(u.next)} →</button>` : ''}
        </div></div>` : ''}
    </li>`;
  }).join('');
  return `<h2>🎓 ${esc(t('tab.learn'))}</h2>
    <p>${esc(u.intro)}</p>
    <div class="bar"><div class="income" style="width:${(n / total) * 100}%"></div></div>
    <p class="small muted">${esc(u.progress(n, total))}</p>
    <ol class="lessons">${items}</ol>
    <p class="small muted">${esc(u.disclaimer)}</p>`;
}

function renderText() {
  return `<h2>${esc(t('text.title'))}</h2>
    <p class="muted small">${esc(t('text.help'))}</p>
    ${errors.length ? `<div class="errors">${errors.map(e =>
      `<div class="${e.warn ? 'warn' : 'err'}">${esc(t('text.line', e.line, errorText(t, e)))}</div>`).join('')}</div>` : ''}
    <textarea id="raw" spellcheck="false">${esc(text)}</textarea>
    <div class="actions">
      <button data-act="rawRevert">${esc(t('btn.revert'))}</button>
      <button class="primary" data-act="rawApply">${esc(t('btn.apply'))}</button>
    </div>`;
}

function renderSync() {
  const clientId = ls.get(K.clientId) || '';
  const last = ls.get(K.lastSync);
  const msg = sync.msg && (typeof sync.msg === 'string' ? t(sync.msg) : errorText(t, sync.msg));
  return `<h2>${esc(t('sync.title'))}</h2>
    <section class="panel">
      <h3>Google Drive</h3>
      <p class="small muted">${t('sync.driveHelp')}</p>
      <label>OAuth Client ID<input id="clientId" value="${esc(clientId)}" placeholder="xxxx.apps.googleusercontent.com"></label>
      <div class="actions left">
        <button class="primary" data-act="sync" ${clientId ? '' : 'disabled'}>${esc(t('sync.now'))}</button>
        ${ls.get(K.fileId) ? `<button data-act="unlink">${esc(t('sync.disconnect'))}</button>` : ''}
      </div>
      <p class="small">${esc(t('sync.status'))}: <b>${esc(t('status.' + syncState()))}</b>${msg ? ` - ${esc(msg)}` : ''}</p>
      ${last ? `<p class="small muted">${esc(t('sync.last', new Date(+last).toLocaleString(LOCALE[lang])))}</p>` : ''}
    </section>
    <section class="panel">
      <h3>${esc(t('sync.localFile'))}</h3>
      <div class="actions left">
        <button data-act="download">${esc(t('sync.download'))}</button>
        <label class="button">${esc(t('sync.import'))}<input type="file" id="importFile" accept=".txt,text/plain" hidden></label>
      </div>
      <p class="small muted">${esc(t('sync.importHelp'))}</p>
    </section>`;
}

// ---------- sync ----------

function syncState() {
  if (!ls.get(K.clientId)) return 'notSetUp';
  if (sync.status === 'busy') return 'busy';
  if (sync.status === 'error') return 'error';
  if (!ls.get(K.fileId)) return 'notConnected';
  return text === ls.get(K.base) ? 'synced' : 'local';
}

function renderSyncButton() {
  const b = document.getElementById('syncBtn');
  const s = syncState();
  b.textContent = t('syncBtn.' + s);
  b.className = s;
}

let syncTimer = null;
function scheduleSync() {
  clearTimeout(syncTimer);
  if (ls.get(K.clientId) && ls.get(K.fileId) && drive.hasValidToken())
    syncTimer = setTimeout(() => syncNow(), 2000);
  else renderSyncButton();
}

// sync.msg is either an i18n key (string) or an error object with key/args.
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
      sync.msg = 'sync.created';
    } else if (meta.version === ls.get(K.version)) {
      result = local; version = meta.version;
      if (local !== base) version = (await drive.update(fileId, local)).version;
    } else {
      const remote = await drive.download(fileId);
      result = local === base ? remote : core.merge(base, local, remote);
      version = result === remote ? meta.version : (await drive.update(fileId, result)).version;
      if (result !== local) setText(result);
      if (local !== base && result !== remote) sync.msg = 'sync.merged';
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
    sync.msg = { key: e.key, args: e.args, message: e.message };
  }
  render();
}

// ---------- events ----------

document.querySelector('nav.tabs').addEventListener('click', e => {
  const tab = e.target.closest('button')?.dataset.tab;
  if (tab) { if (tab === 'learn') view.fromLesson = null; view.tab = tab; view.editTx = null; render(); window.scrollTo(0, 0); }
});
document.getElementById('backToLesson').addEventListener('click', () => {
  view.lesson = view.fromLesson; view.fromLesson = null; view.tab = 'learn'; render();
  document.getElementById('lesson-' + view.lesson)?.scrollIntoView({ block: 'start' });
});
document.getElementById('syncBtn').addEventListener('click', () => syncNow());
const langSel = document.getElementById('langSel');
langSel.innerHTML = Object.entries(LANGS).map(([k, name]) => `<option value="${k}">${name}</option>`).join('');
langSel.addEventListener('change', () => { setLang(langSel.value); render(); });

const actions = {
  prevMonth() { if (--view.month < 0) { view.month = 11; view.year--; } view.editTx = null; },
  nextMonth() { if (++view.month > 11) { view.month = 0; view.year++; } view.editTx = null; },
  thisMonth() { view.year = today.getFullYear(); view.month = today.getMonth(); },
  prevYear() { view.year--; },
  nextYear() { view.year++; },
  goYear() { view.tab = 'year'; },
  goCats() { view.tab = 'cats'; },
  // ---- training mode ----
  startLearn() { view.tab = 'learn'; view.lesson = null; },
  dismissLearn() { saveLearn({ dismissed: true }); },
  openLesson(el) { view.lesson = view.lesson === el.dataset.id ? '' : el.dataset.id; },
  markLesson(el) {
    const done = { ...learnState().done };
    if (done[el.dataset.id]) delete done[el.dataset.id]; else done[el.dataset.id] = true;
    saveLearn({ done });
  },
  nextLesson(el) {
    const i = learn.LESSONS.findIndex(l => l.id === el.dataset.id);
    view.lesson = learn.LESSONS[i + 1]?.id || '';
    setTimeout(() => document.getElementById('lesson-' + view.lesson)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 0);
  },
  tryLesson(el) {
    const a = learn.LESSONS.find(l => l.id === el.dataset.id).action;
    view.fromLesson = el.dataset.id;
    view.tab = a.tab;
    view.year = today.getFullYear(); view.month = today.getMonth();
    if (a.prevMonth) actions.prevMonth();
    window.scrollTo(0, 0);
    if (a.focus) setTimeout(() => main.querySelector(`input[name=${a.focus}]`)?.focus(), 0);
  },
  // ---- editing ----
  editTx(el) { view.editTx = budget.tx[+el.dataset.i]; window.scrollTo({ top: document.getElementById('txForm').offsetTop - 70, behavior: 'smooth' }); },
  cancelEdit() { view.editTx = null; },
  delTx(el) {
    const tx = budget.tx[+el.dataset.i];
    if (!confirm(t('ask.delTx', tx.cat, money(tx.amount), fmtDate(tx.date)))) return false;
    budget.tx.splice(+el.dataset.i, 1);
    if (view.editTx === tx) view.editTx = null;
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
      && !confirm(t('ask.copyPlan', y, view.year - 1))) return false;
    core.copyPlan(budget, String(view.year - 1), y);
    commit(); return false;
  },
  delCat(el) {
    const c = budget.categories[+el.dataset.i];
    const n = core.categoryUses(budget, c.name);
    if (n) { alert(t('msg.catInUse', c.name, n)); return false; }
    if (!confirm(t('ask.delCat', c.name))) return false;
    core.deleteCategory(budget, c.name);
    commit(); return false;
  },
  rawApply() {
    const raw = document.getElementById('raw').value;
    const r = core.parse(raw);
    const bad = r.errors.filter(e => !e.warn).length;
    if (bad && !confirm(t('ask.rawProblems', bad))) {
      errors = r.errors; text = raw; render(); text = ls.get(K.text); return false;
    }
    setText(raw);
    errors = r.errors;
    scheduleSync();
  },
  rawRevert() { ({ errors } = core.parse(text)); },
  sync() { syncNow(); return false; },
  unlink() {
    if (!confirm(t('ask.unlink'))) return false;
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
    try { amount = core.parseAmount(f.get('amount')); } catch { alert(t('msg.badAmount')); return; }
    const tx = { date: f.get('date'), cat: f.get('cat'), amount, note: f.get('note').trim() };
    if (view.editTx) Object.assign(view.editTx, tx); else budget.tx.push(tx);
    core.sortTx(budget);
    view.editTx = null; view.draft = null; view.lastCat = tx.cat;
    [view.year, view.month] = [+tx.date.slice(0, 4), +tx.date.slice(5, 7) - 1];
    commit();
    main.querySelector('input[name=amount]')?.focus();
  } else if (e.target.id === 'catForm') {
    const name = f.get('name').trim();
    if (!name || budget.categories.some(c => c.name === name)) { alert(t('msg.catExists')); return; }
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
    if (/^[A-Za-z]{3}$/.test(el.value)) { budget.currency = el.value.toUpperCase(); fmtCache = {}; commit(); }
  } else if (el.id === 'clientId') {
    ls.set(K.clientId, el.value.trim() || null);
    render();
  } else if (el.id === 'importFile' && el.files[0]) {
    el.files[0].text().then(s => {
      setText(core.merge(null, text, s));
      alert(t('msg.imported'));
      scheduleSync();
    });
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && drive.hasValidToken() && ls.get(K.fileId)) syncNow();
});

if ('serviceWorker' in navigator && location.protocol !== 'file:')
  navigator.serviceWorker.register('sw.js').catch(() => {});

setLang(lang, false);
render();
if (drive.hasValidToken() && ls.get(K.fileId)) syncNow();
