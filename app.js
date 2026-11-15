import config from './config.js';
import { createStore } from './store.js';
import {
  n, round2, STATUS, ACTIVE, PLATFORMS, EXPENSE_CATEGORIES, BOX_PAPERS, BANK_TYPES, splitMoney, marginVat,
  watchProfit, calc, bankBalance, pendingPayments, partnerCapital, actionItems, daysBetween, monthlyResults,
  quarterlyVat, groupSold, linkedReturnCosts, toCsv, inPeriod, customerReturns, capitalizedSum, purchaseAmount,
  vatOwed, reconcile, receiptRecords, missingReceipts, MANUAL_BANK_TYPES,
  vatReturn, quarterOf, vatRef, incomeTax, taxPot, taxYear, hoursByPerson,
} from './logic.js';

// ───────────── Hulpjes ─────────────
let store;
let route = { mod: 'home', page: null };
const ui = { stockFilter: 'active', stockSearch: '', period: 'year', salesPeriod: 'year', expensePeriod: 'year', taskOwner: 'all', ideaFilter: 'open', wishFilter: 'searching', postFilter: 'open', calMonth: null, docFilter: 'all', receiptFilter: 'missing', vatYear: null, vatQ: null, taxYear: null, hoursPerson: 'all', mailFilter: 'new' };
const $ = (s, el = document) => el.querySelector(s);
const S = () => store.state;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
const euro = v => fmt.format(n(v));
const fdate = d => d ? new Date(d + 'T12:00').toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const watchById = id => S().watches.find(w => w.id === id);
const wname = w => w ? `${w.brand} ${w.model}` : 'Onbekend horloge';
const partners = () => S().settings.partners || ['Luuk', 'Marijn'];
const signed = v => `<b class="${n(v) < 0 ? 'bad' : 'good'}">${euro(v)}</b>`;
const hist = (w, text, date = today()) => [...(w?.history || []), { date, text, by: store.user?.name || '' }];
const statusChip = s => `<span class="chip st-${s}">${STATUS[s] || s}</span>`;
const options = (list, sel) => list.map(o => {
  const [v, l] = Array.isArray(o) ? o : [o, o];
  return `<option value="${esc(v)}" ${String(v) === String(sel ?? '') ? 'selected' : ''}>${esc(l)}</option>`;
}).join('');

function toast(msg, kind = '') {
  const t = $('#toast'); t.textContent = msg; t.className = `toast show ${kind}`;
  clearTimeout(toast.t); toast.t = setTimeout(() => t.className = 'toast', 3200);
}

function periodRange(key) {
  const t = today(), y = +t.slice(0, 4), m = +t.slice(5, 7);
  if (key === 'year') return { from: `${y}-01-01`, to: `${y}-12-31`, label: `${y}` };
  if (key === 'lastyear') return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31`, label: `${y - 1}` };
  if (key === 'quarter') { const q = Math.ceil(m / 3); return { from: `${y}-${String(q * 3 - 2).padStart(2, '0')}-01`, to: new Date(Date.UTC(y, q * 3, 0)).toISOString().slice(0, 10), label: `K${q} ${y}` }; }
  if (key === 'month') return { from: `${t.slice(0, 7)}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10), label: new Date(t).toLocaleDateString('nl-NL', { month: 'long', year: 'numeric' }) };
  return { from: '', to: '', label: 'Alles' };
}
const PERIODS = [['month', 'Deze maand'], ['quarter', 'Dit kwartaal'], ['year', 'Dit jaar'], ['lastyear', 'Vorig jaar'], ['all', 'Alles']];
const periodSelect = (key, uiKey) => `<select class="period" data-uikey="${uiKey}">${options(PERIODS, key)}</select>`;

async function compressImage(file, max = 1600) {
  if (!file || !file.type.startsWith('image/')) return file;
  const img = await createImageBitmap(file).catch(() => null);
  if (!img) return file;
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return await new Promise(r => c.toBlob(b => r(b || file), 'image/jpeg', 0.82));
}
const uploadPhoto = async f => f ? store.upload(await compressImage(f), 'photos') : null;
const uploadReceipt = async f => f ? store.upload(f.type.startsWith('image/') ? await compressImage(f, 2200) : f, 'receipts') : null;

// ───────────── Formulieren en panelen ─────────────
function fieldHtml(f) {
  if (f.type === 'html') return `<div class="field ${f.wide ? 'wide' : ''}" data-field="${f.name || ''}">${f.html}</div>`;
  if (f.type === 'section') return `<div class="field wide section-title" data-field="${f.name || ''}">${esc(f.label)}</div>`;
  const req = f.required ? 'required' : '';
  const v = f.value ?? '';
  let input;
  if (f.type === 'select') input = `<select name="${f.name}" ${req}>${options(f.options, v)}</select>`;
  else if (f.type === 'textarea') input = `<textarea name="${f.name}" rows="3" placeholder="${esc(f.placeholder || '')}">${esc(v)}</textarea>`;
  else if (f.type === 'money') input = `<input name="${f.name}" type="number" step="0.01" min="${f.allowNegative ? '' : '0'}" inputmode="decimal" value="${esc(v)}" placeholder="0,00" ${req}>`;
  else if (f.type === 'file') input = `<input name="${f.name}" type="file" accept="${f.accept || 'image/*,application/pdf'}" ${f.multiple ? 'multiple' : ''}>`;
  else if (f.type === 'checkbox') return `<label class="field check ${f.wide ? 'wide' : ''}" data-field="${f.name}"><input name="${f.name}" type="checkbox" ${v ? 'checked' : ''}> ${esc(f.label)}</label>`;
  else input = `<input name="${f.name}" type="${f.type || 'text'}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}" ${req} ${f.list ? `list="dl-${f.name}"` : ''}>${f.list ? `<datalist id="dl-${f.name}">${f.list.map(x => `<option value="${esc(x)}">`).join('')}</datalist>` : ''}`;
  return `<label class="field ${f.wide ? 'wide' : ''}" data-field="${f.name}"><span>${esc(f.label)}</span>${input}${f.hint ? `<small>${esc(f.hint)}</small>` : ''}</label>`;
}

function formValues(form) {
  const d = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'file') d[el.name] = el.multiple ? [...el.files] : el.files[0] || null;
    else if (el.type === 'checkbox') d[el.name] = el.checked;
    else d[el.name] = el.value;
  }
  return d;
}

function openDialog(inner, cls = '') {
  const dlg = document.createElement('dialog');
  dlg.className = `modal ${cls}`;
  dlg.innerHTML = inner;
  $('#modalRoot').append(dlg);
  dlg.addEventListener('click', e => { if (e.target === dlg || e.target.closest('[data-close]')) dlg.close(); });
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  return dlg;
}

function openForm({ eyebrow = '', title, intro = '', fields, submit = 'Opslaan', danger = false, onSubmit, onInput, onDelete }) {
  const dlg = openDialog(`<form class="modal-body" novalidate>
    <header><div><div class="eyebrow">${esc(eyebrow)}</div><h2>${esc(title)}</h2></div><button type="button" class="x" data-close aria-label="Sluiten">×</button></header>
    ${intro ? `<p class="muted intro">${intro}</p>` : ''}
    <div class="grid">${fields.map(fieldHtml).join('')}</div>
    <footer>${onDelete ? '<button type="button" class="btn ghost danger-text left" data-del>Verwijderen</button>' : ''}<button type="button" class="btn" data-close>Annuleren</button><button class="btn ${danger ? 'danger' : 'primary'}" type="submit">${esc(submit)}</button></footer>
  </form>`);
  const form = $('form', dlg);
  $('[data-del]', dlg)?.addEventListener('click', async () => { try { if (await onDelete() !== false) { dlg.close(); render(); } } catch (err) { toast(err.message, 'bad'); } });
  const sync = () => {
    const d = formValues(form);
    for (const f of fields) if (f.show && f.name) {
      const el = form.querySelector(`[data-field="${f.name}"]`); if (!el) continue;
      const vis = !!f.show(d);
      el.hidden = !vis;
      el.querySelectorAll('input,select,textarea').forEach(i => { i.disabled = !vis; });
    }
    onInput?.(formValues(form), form);
  };
  form.addEventListener('input', sync); form.addEventListener('change', sync); sync();
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const missing = [...form.querySelectorAll('[required]')].find(i => !i.disabled && !String(i.value).trim());
    if (missing) { missing.focus(); toast('Vul alle verplichte velden in', 'bad'); return; }
    const btn = form.querySelector('[type=submit]'); btn.disabled = true; btn.classList.add('busy');
    try {
      const res = await onSubmit(formValues(form), form);
      if (res !== false) { dlg.close(); render(); }
    } catch (err) { console.error(err); toast(err.message || 'Er ging iets mis', 'bad'); }
    finally { btn.disabled = false; btn.classList.remove('busy'); }
  });
  setTimeout(() => { if (!form.contains(document.activeElement)) form.querySelector('input:not([type=hidden]):not([disabled]),select')?.focus(); }, 30);
  return { dlg, form };
}

function confirmDialog(title, text, label = 'Verwijderen') {
  return new Promise(res => {
    let ok = false;
    const dlg = openDialog(`<div class="modal-body small"><header><div><h2>${esc(title)}</h2></div></header><p class="muted">${text}</p>
      <footer><button class="btn" data-close>Annuleren</button><button class="btn danger" data-ok>${esc(label)}</button></footer></div>`);
    $('[data-ok]', dlg).onclick = () => { ok = true; dlg.close(); };
    dlg.addEventListener('close', () => res(ok));
  });
}

// ───────────── Boekingen ─────────────
const addBank = (row) => store.insert('bank_entries', { date: today(), ...row, amount: round2(row.amount) });
async function removeBankRef(ref) {
  for (const e of S().bank_entries.filter(e => e.reference_id === ref)) await store.remove('bank_entries', e.id);
}
const paymentOptions = [['paid', 'Betaald vanaf zakelijke rekening'], ['pending', 'Nog te betalen'], ['private', 'Privé betaald door vennoot']];

// Inkoop (één horloge of bundel)
function purchaseForm(opts = {}) {
  const pre = opts.prefill || {};
  const watchFields = i => `
    <div class="batch-row" data-row="${i}">
      <div class="batch-no">${i + 1}</div>
      <input class="b-brand" placeholder="Merk" list="dl-brands">
      <input class="b-model" placeholder="Model">
      <input class="b-ref" placeholder="Referentie">
      <input class="b-price" type="number" step="0.01" min="0" placeholder="Inkoop €">
      <input class="b-est" type="number" step="0.01" min="0" placeholder="Waarde €">
      <input class="b-share" type="number" step="0.01" min="0" placeholder="Kosten €">
      <span class="b-alloc muted"></span>
      <button type="button" class="x b-del" title="Verwijderen">×</button>
    </div>`;
  const brands = [...new Set(S().watches.map(w => w.brand))].sort();
  const f = openForm({
    eyebrow: 'Nieuwe inkoop', title: 'Horloge inkopen', submit: 'Inkoop opslaan',
    fields: [
      { name: 'mode', label: 'Soort inkoop', type: 'select', options: [['single', 'Eén horloge'], ['batch', 'Bundel: meerdere horloges in één bestelling']], wide: true },
      { name: 'brand', label: 'Merk', required: true, list: brands, value: pre.brand, show: d => d.mode === 'single' },
      { name: 'model', label: 'Model', required: true, value: pre.model, show: d => d.mode === 'single' },
      { name: 'reference', label: 'Referentienummer', value: pre.reference, show: d => d.mode === 'single' },
      { name: 'serial', label: 'Serienummer', show: d => d.mode === 'single' },
      { name: 'year', label: 'Bouwjaar', placeholder: 'bv. 2019 of ca. 1975', show: d => d.mode === 'single' },
      { name: 'condition', label: 'Staat', type: 'select', options: ['', 'Nieuw', 'Als nieuw', 'Zeer goed', 'Goed', 'Redelijk', 'Defect / voor onderdelen'], show: d => d.mode === 'single' },
      { name: 'box_papers', label: 'Box & papieren', type: 'select', options: [['', '—'], ...Object.entries(BOX_PAPERS)], show: d => d.mode === 'single' },
      { type: 'section', label: 'Inkoop' },
      { name: 'purchase_date', label: 'Inkoopdatum', type: 'date', value: today(), required: true },
      { name: 'platform', label: 'Platform', type: 'select', options: PLATFORMS },
      { name: 'seller', label: 'Verkoper', placeholder: 'Naam of gebruikersnaam', show: d => d.mode === 'single' },
      { name: 'reference_no', label: 'Bestelnummer / notitie', show: d => d.mode === 'batch' },
      { name: 'purchase_price', label: 'Inkoopprijs (€)', type: 'money', required: true, value: pre.purchase_price, show: d => d.mode === 'single', hint: 'Wat je aan de verkoper betaalt' },
      { name: 'extra_costs', label: 'Extra kosten (€)', type: 'money', show: d => d.mode === 'single', hint: 'Verzending, kopersbescherming, service' },
      { name: 'estimated_value', label: 'Geschatte verkoopwaarde (€)', type: 'money', value: pre.estimated_value, show: d => d.mode === 'single' },
      { name: 'shipping', label: 'Verzendkosten (€)', type: 'money', show: d => d.mode === 'batch' },
      { name: 'protection', label: 'Kopersbescherming (€)', type: 'money', show: d => d.mode === 'batch' },
      { name: 'other', label: 'Overige gezamenlijke kosten (€)', type: 'money', show: d => d.mode === 'batch' },
      { name: 'allocation', label: 'Kosten verdelen', type: 'select', options: [['proportional', 'Naar verhouding van inkoopprijs'], ['equal', 'Gelijk verdelen'], ['manual', 'Handmatig']], show: d => d.mode === 'batch' },
      { name: 'rows', type: 'html', wide: true, show: d => d.mode === 'batch', html: `<div class="batch"><div class="batch-head"><span>Horloges in deze bestelling</span><button type="button" class="btn small" data-addrow>＋ Horloge</button></div><datalist id="dl-brands">${brands.map(b => `<option value="${esc(b)}">`).join('')}</datalist><div class="batch-rows">${watchFields(0)}${watchFields(1)}</div><div class="batch-sum muted"></div></div>` },
      { name: 'status', label: 'Status', type: 'select', options: [['incoming', 'Onderweg'], ['in_stock', 'Al binnen / op voorraad']] },
      { name: 'payment', label: 'Betaling', type: 'select', options: paymentOptions },
      { name: 'paid_by', label: 'Betaald door', type: 'select', options: partners(), value: store.user?.name, show: d => d.payment === 'private' },
      { name: 'vat_scheme', label: 'Btw-regeling bij verkoop', type: 'select', options: [['margin', 'Margeregeling (gekocht van particulier)'], ['none', 'Geen btw']], show: () => S().settings.vat_enabled },
      { name: 'photo', label: 'Foto', type: 'file', accept: 'image/*', show: d => d.mode === 'single' },
      { name: 'receipt', label: 'Bon / bestelbevestiging', type: 'file' },
      { name: 'notes', label: 'Notities', type: 'textarea', wide: true, show: d => d.mode === 'single' },
    ],
    onInput: (d, form) => updateBatch(d, form),
    onSubmit: async (d, form) => { const r = d.mode === 'batch' ? await saveBatch(d, form) : await saveSingle(d); if (r !== false) await opts.after?.(); return r; },
  });
  const rowsEl = $('.batch-rows', f.form);
  f.form.addEventListener('click', e => {
    if (e.target.closest('[data-addrow]')) { rowsEl.insertAdjacentHTML('beforeend', watchFields(rowsEl.children.length)); renumber(); updateBatch(formValues(f.form), f.form); }
    const del = e.target.closest('.b-del');
    if (del && rowsEl.children.length > 2) { del.closest('.batch-row').remove(); renumber(); updateBatch(formValues(f.form), f.form); }
  });
  const renumber = () => [...rowsEl.children].forEach((r, i) => { r.dataset.row = i; $('.batch-no', r).textContent = i + 1; });
}

function batchData(d, form) {
  const rows = [...form.querySelectorAll('.batch-row')].map(r => ({
    el: r, brand: $('.b-brand', r).value.trim(), model: $('.b-model', r).value.trim(), reference: $('.b-ref', r).value.trim(),
    price: n($('.b-price', r).value), est: n($('.b-est', r).value), manual: n($('.b-share', r).value),
  }));
  const shared = round2(n(d.shipping) + n(d.protection) + n(d.other));
  const shares = d.allocation === 'manual' ? rows.map(r => r.manual)
    : splitMoney(shared, d.allocation === 'equal' ? rows.map(() => 1) : rows.map(r => r.price));
  return { rows, shared, shares, items: round2(rows.reduce((a, r) => a + r.price, 0)) };
}
function updateBatch(d, form) {
  if (d.mode !== 'batch') return;
  const b = batchData(d, form);
  b.rows.forEach((r, i) => {
    $('.b-share', r.el).hidden = d.allocation !== 'manual';
    $('.b-alloc', r.el).textContent = d.allocation === 'manual' ? '' : `+ ${euro(b.shares[i])} = ${euro(r.price + b.shares[i])}`;
  });
  const manualSum = round2(b.shares.reduce((a, x) => a + x, 0));
  $('.batch-sum', form).innerHTML = `Horloges ${euro(b.items)} · gezamenlijke kosten ${euro(b.shared)} · <b>totaal ${euro(b.items + b.shared)}</b>` +
    (d.allocation === 'manual' && Math.abs(manualSum - b.shared) > 0.005 ? ` <span class="bad">· handmatig verdeeld: ${euro(manualSum)}</span>` : '');
}

async function saveSingle(d) {
  const total = round2(n(d.purchase_price) + n(d.extra_costs));
  const [photo_path, receipt_path] = await Promise.all([uploadPhoto(d.photo), uploadReceipt(d.receipt)]);
  const w = await store.insert('watches', {
    brand: d.brand.trim(), model: d.model.trim(), reference: d.reference, serial: d.serial, year: d.year,
    condition: d.condition, box_papers: d.box_papers || null, notes: d.notes, photo_path, receipt_path,
    status: d.status, purchase_date: d.purchase_date, purchase_platform: d.platform, seller: d.seller,
    purchase_price: n(d.purchase_price), extra_costs: n(d.extra_costs), total_cost: total,
    estimated_value: n(d.estimated_value), purchase_payment: d.payment, purchase_paid_by: d.payment === 'private' ? d.paid_by : null,
    vat_scheme: d.vat_scheme || 'margin',
    history: hist(null, `Ingekocht via ${d.platform} voor ${euro(total)}`, d.purchase_date),
  });
  if (d.payment === 'paid') await addBank({ date: d.purchase_date, description: `Inkoop ${wname(w)}`, amount: -total, type: 'purchase', reference_id: `purchase:${w.id}` });
  toast(`${wname(w)} toegevoegd`);
}

async function saveBatch(d, form) {
  const b = batchData(d, form);
  const rows = b.rows.filter(r => r.brand || r.model || r.price);
  if (rows.length < 2) { toast('Een bundel heeft minimaal twee horloges', 'bad'); return false; }
  if (rows.some(r => !r.brand || !r.model)) { toast('Vul merk en model van elk horloge in', 'bad'); return false; }
  if (d.allocation === 'manual' && Math.abs(b.shares.reduce((a, x) => a + x, 0) - b.shared) > 0.005) { toast(`De handmatige verdeling moet samen ${euro(b.shared)} zijn`, 'bad'); return false; }
  const idx = rows.map(r => b.rows.indexOf(r));
  const total = round2(b.items + b.shared);
  const receipt_path = await uploadReceipt(d.receipt);
  const batch = await store.insert('purchase_batches', {
    purchase_date: d.purchase_date, platform: d.platform, reference: d.reference_no, shipping_costs: n(d.shipping),
    buyer_protection: n(d.protection), other_costs: n(d.other), allocation_method: d.allocation,
    payment_status: d.payment, paid_by: d.payment === 'private' ? d.paid_by : null, total_cost: total, receipt_path,
  });
  for (const [k, r] of rows.entries()) {
    const share = b.shares[idx[k]] || 0;
    await store.insert('watches', {
      brand: r.brand, model: r.model, reference: r.reference, status: d.status, purchase_date: d.purchase_date,
      purchase_platform: d.platform, purchase_price: r.price, extra_costs: share, total_cost: round2(r.price + share),
      estimated_value: r.est, purchase_payment: 'batch', batch_id: batch.id, vat_scheme: d.vat_scheme || 'margin',
      history: hist(null, `Ingekocht in bundel via ${d.platform} (${rows.length} horloges) voor ${euro(r.price + share)}`, d.purchase_date),
    });
  }
  if (d.payment === 'paid') await addBank({ date: d.purchase_date, description: `${d.platform}-bestelling · ${rows.length} horloges`, amount: -total, type: 'purchase', reference_id: `batch:${batch.id}` });
  toast(`Bundel met ${rows.length} horloges opgeslagen`);
}

// Verkoop
function saleForm(watchId) {
  const avail = S().watches.filter(w => w.status === 'in_stock' || w.id === watchId && w.status === 'incoming');
  if (!avail.length) { toast('Er staan geen horloges op voorraad', 'bad'); return; }
  const s = S().settings;
  openForm({
    eyebrow: 'Nieuwe verkoop', title: 'Verkoop registreren', submit: 'Verkoop opslaan',
    fields: [
      { name: 'watch_id', label: 'Horloge', type: 'select', wide: true, value: watchId, options: avail.map(w => [w.id, `${wname(w)}${w.reference ? ' · ' + w.reference : ''} — kostprijs ${euro(w.total_cost)}`]) },
      { name: 'sale_date', label: 'Verkoopdatum', type: 'date', value: today(), required: true },
      { name: 'platform', label: 'Platform', type: 'select', options: PLATFORMS },
      { name: 'buyer', label: 'Koper', placeholder: 'Naam of gebruikersnaam' },
      { name: 'sale_price', label: 'Verkoopprijs (€)', type: 'money', required: true, hint: 'Wat de koper betaalt' },
      { name: 'sale_costs', label: 'Verkoopkosten (€)', type: 'money', hint: 'Platformkosten, verzending' },
      { name: 'payment', label: 'Betaling', type: 'select', options: [['received', 'Geld staat op de rekening'], ['pending', 'Nog te ontvangen']] },
      { name: 'preview', type: 'html', wide: true, html: '<div class="preview"></div>' },
    ],
    onInput: (d, form) => {
      const w = watchById(d.watch_id); if (!w) return;
      const tmp = { ...w, status: 'sold', sale_price: n(d.sale_price), sale_costs: n(d.sale_costs) };
      const vat = marginVat(tmp, s), profit = watchProfit(tmp, s);
      $('.preview', form).innerHTML = d.sale_price ? `<div>Kostprijs <b>${euro(w.total_cost)}</b></div>${s.vat_enabled && w.vat_scheme === 'margin' ? `<div>Btw (marge) <b>${euro(vat)}</b></div>` : ''}<div>Winst <b class="${profit < 0 ? 'bad' : 'good'}">${euro(profit)}</b></div><div>Marge <b>${n(d.sale_price) ? Math.round(profit / n(d.sale_price) * 100) : 0}%</b></div>` : '<span class="muted">Vul de verkoopprijs in om de winst te zien.</span>';
    },
    onSubmit: async d => {
      const w = watchById(d.watch_id);
      const net = round2(n(d.sale_price) - n(d.sale_costs));
      await store.update('watches', w.id, {
        status: 'sold', sale_date: d.sale_date, sale_platform: d.platform, buyer: d.buyer, sale_price: n(d.sale_price),
        sale_costs: n(d.sale_costs), sale_payment: d.payment,
        history: hist(w, `Verkocht via ${d.platform} voor ${euro(d.sale_price)}`, d.sale_date),
      });
      if (d.payment === 'received') await addBank({ date: d.sale_date, description: `Verkoop ${wname(w)}`, amount: net, type: 'sale', reference_id: `sale:${w.id}` });
      toast(`Verkocht · winst ${euro(watchProfit(watchById(w.id), s))}`);
    },
  });
}

// Uitgave
const eqMoney = (a, b) => Math.abs(round2(a) - round2(b)) < 0.005;
const removeBankPrefix = async prefix => { for (const e of S().bank_entries.filter(e => e.reference_id === prefix || String(e.reference_id || '').startsWith(prefix + ':'))) await store.remove('bank_entries', e.id); };
async function syncBatch(batchId) {
  const b = S().purchase_batches.find(x => x.id === batchId); if (!b) return;
  const members = S().watches.filter(w => w.batch_id === batchId);
  if (!members.length) { await removeBankRef(`batch:${batchId}`); await store.remove('purchase_batches', batchId); return; }
  const total = round2(members.reduce((a, w) => a + purchaseAmount(S(), w), 0));
  if (!eqMoney(total, b.total_cost)) await store.update('purchase_batches', batchId, { total_cost: total });
  const be = S().bank_entries.find(e => e.reference_id === `batch:${batchId}`);
  if (be && !eqMoney(be.amount, -total)) await store.update('bank_entries', be.id, { amount: -total });
}

// Uitgave (ook: kosten achteraf bij een horloge)
function expenseForm(preset = {}) {
  const linkable = S().watches.filter(w => w.status !== 'written_off');
  const pw = preset.watch_id && watchById(preset.watch_id);
  openForm({
    eyebrow: preset.capitalized ? 'Kosten horloge' : 'Nieuwe uitgave', title: preset.capitalized && pw ? `Kosten voor ${wname(pw)}` : 'Kosten toevoegen', submit: 'Opslaan',
    intro: preset.capitalized ? 'Deze kosten worden opgeteld bij de kostprijs van het horloge (bijvoorbeeld service, reparatie of een nieuwe band). Ze tellen dan niet als losse bedrijfskosten, maar drukken de winst bij verkoop.' : '',
    fields: [
      { name: 'description', label: 'Omschrijving', required: true, wide: true, value: preset.description || '' },
      { name: 'date', label: 'Datum', type: 'date', value: today(), required: true },
      { name: 'amount', label: 'Bedrag (€)', type: 'money', required: true, value: preset.amount },
      { name: 'category', label: 'Categorie', type: 'select', options: EXPENSE_CATEGORIES, value: preset.category },
      { name: 'watch_id', label: 'Hoort bij horloge (optioneel)', type: 'select', value: preset.watch_id, options: [['', '—'], ...linkable.map(w => [w.id, `${wname(w)} · ${STATUS[w.status]}`])] },
      { name: 'capitalized', label: 'Optellen bij de kostprijs van dit horloge', type: 'checkbox', wide: true, value: preset.capitalized, show: d => d.watch_id && d.category !== 'Retourkosten' },
      { name: 'payment', label: 'Betaling', type: 'select', value: preset.payment, options: [...paymentOptions, ['offset', 'Verrekend met terugbetaling verkoper']] },
      { name: 'paid_by', label: 'Betaald door', type: 'select', options: partners(), value: store.user?.name, show: d => d.payment === 'private' },
      { name: 'receipt', label: preset.receipt_path ? 'Bon (uit de mail is al gekozen; kies alleen een ander bestand als dat nodig is)' : 'Bon', type: 'file' },
    ],
    onSubmit: async d => {
      const amt = round2(d.amount);
      if (amt <= 0) { toast('Vul een bedrag groter dan 0 in', 'bad'); return false; }
      const cap = !!d.capitalized && !!d.watch_id && d.category !== 'Retourkosten';
      if (d.payment === 'offset') {
        const w = watchById(d.watch_id);
        if (d.category !== 'Retourkosten' || !w || w.status !== 'returned' || w.supplier_return?.payment !== 'pending') {
          toast('Verrekenen kan alleen bij Retourkosten van een teruggestuurd horloge waarvan de terugbetaling nog open staat', 'bad'); return false;
        }
      }
      const receipt_path = (await uploadReceipt(d.receipt)) || preset.receipt_path || null;
      const e = await store.insert('expenses', {
        date: d.date, description: d.description, amount: amt, category: d.category, payment_status: d.payment,
        paid_by: d.payment === 'private' ? d.paid_by : null, watch_id: d.watch_id || null, receipt_path, capitalized: cap,
      });
      if (cap) {
        const w = watchById(d.watch_id);
        await store.update('watches', w.id, { extra_costs: round2(n(w.extra_costs) + amt), total_cost: round2(n(w.total_cost) + amt), history: hist(w, `Kosten toegevoegd: ${d.description} (${euro(amt)})`, d.date) });
      }
      if (d.payment === 'paid') await addBank({ date: d.date, description: d.description, amount: -amt, type: 'expense', reference_id: `expense:${e.id}` });
      try { await preset.after?.(); } catch (err) { console.warn(err); }
      toast(cap ? 'Kosten bij de kostprijs opgeteld' : 'Uitgave opgeslagen');
    },
  });
}

function editExpenseForm(id) {
  const e = S().expenses.find(x => x.id === id);
  const w = e.watch_id && watchById(e.watch_id);
  const locked = e.payment_status === 'offset' && w?.supplier_return?.payment === 'received';
  const payLabel = { paid: 'Betaald vanaf zakelijke rekening', pending: 'Nog te betalen', private: `Privé betaald door ${e.paid_by}`, offset: 'Verrekend met terugbetaling verkoper' }[e.payment_status];
  openForm({
    eyebrow: e.capitalized ? 'Kosten horloge' : 'Uitgave', title: e.description,
    intro: `Betaling: <b>${esc(payLabel)}</b>${w ? ` · horloge: <b>${esc(wname(w))}</b>` : ''}.${locked ? ' De terugbetaling is al verwerkt, daarom kan het bedrag niet meer veranderen.' : ''} Klopt de betaalwijze niet? Verwijder de uitgave en voer hem opnieuw in.`,
    fields: [
      { name: 'description', label: 'Omschrijving', required: true, wide: true, value: e.description },
      { name: 'date', label: 'Datum', type: 'date', required: true, value: e.date },
      { name: 'amount', label: 'Bedrag (€)', type: 'money', required: true, value: e.amount, show: () => !locked },
      { name: 'category', label: 'Categorie', type: 'select', options: EXPENSE_CATEGORIES, value: e.category, show: () => e.payment_status !== 'offset' && !e.capitalized },
      { name: 'receipt', label: e.receipt_path ? 'Bon vervangen' : 'Bon toevoegen', type: 'file' },
    ],
    onSubmit: async d => {
      const amt = locked ? n(e.amount) : round2(d.amount);
      if (amt <= 0) { toast('Vul een bedrag groter dan 0 in', 'bad'); return false; }
      const patch = { description: d.description, date: d.date, amount: amt };
      if (d.category) patch.category = d.category;
      if (d.receipt) patch.receipt_path = await uploadReceipt(d.receipt);
      const diff = round2(amt - n(e.amount));
      if (e.capitalized && diff && w) await store.update('watches', w.id, { extra_costs: round2(n(w.extra_costs) + diff), total_cost: round2(n(w.total_cost) + diff), history: hist(w, `Kosten "${d.description}" aangepast naar ${euro(amt)}`) });
      await store.update('expenses', id, patch);
      const be = S().bank_entries.find(x => x.reference_id === `expense:${id}`);
      if (be) await store.update('bank_entries', be.id, { amount: -amt, date: d.date, description: d.description });
      toast('Uitgave bijgewerkt');
    },
    onDelete: () => deleteExpense(id, true),
  });
}

// Horloge-acties
async function markArrived(id) {
  const w = watchById(id);
  const back = w.status === 'customer_returning';
  await store.update('watches', id, { status: 'in_stock', history: hist(w, back ? 'Retour van klant ontvangen' : 'Binnengekomen') });
  toast(`${wname(w)} staat op voorraad`); render(); if ($('dialog.detail')) { $('dialog.detail').close(); watchDetail(id); }
}

function editWatchForm(id) {
  const w = watchById(id);
  const sold = w.status === 'sold';
  const cap = capitalizedSum(S(), id);
  openForm({
    eyebrow: 'Bewerken', title: wname(w), submit: 'Wijzigingen opslaan',
    intro: cap ? `Let op: in de extra kosten zit ${euro(cap)} aan kosten die achteraf zijn toegevoegd. Pas die aan via Financiën → Uitgaven.` : '',
    fields: [
      { name: 'brand', label: 'Merk', value: w.brand, required: true },
      { name: 'model', label: 'Model', value: w.model, required: true },
      { name: 'reference', label: 'Referentienummer', value: w.reference },
      { name: 'serial', label: 'Serienummer', value: w.serial },
      { name: 'year', label: 'Bouwjaar', value: w.year },
      { name: 'condition', label: 'Staat', type: 'select', value: w.condition, options: ['', 'Nieuw', 'Als nieuw', 'Zeer goed', 'Goed', 'Redelijk', 'Defect / voor onderdelen'] },
      { name: 'box_papers', label: 'Box & papieren', type: 'select', value: w.box_papers, options: [['', '—'], ...Object.entries(BOX_PAPERS)] },
      { name: 'estimated_value', label: 'Geschatte waarde (€)', type: 'money', value: w.estimated_value },
      { type: 'section', label: 'Inkoop' },
      { name: 'purchase_date', label: 'Inkoopdatum', type: 'date', value: w.purchase_date },
      { name: 'purchase_platform', label: 'Platform', type: 'select', value: w.purchase_platform, options: PLATFORMS },
      { name: 'seller', label: 'Verkoper', value: w.seller },
      { name: 'purchase_price', label: 'Inkoopprijs (€)', type: 'money', value: w.purchase_price },
      { name: 'extra_costs', label: 'Extra kosten bij inkoop (€)', type: 'money', value: round2(n(w.extra_costs) - cap), hint: 'Service of reparatie achteraf? Gebruik "＋ Kosten" bij het horloge.' },
      { name: 'vat_scheme', label: 'Btw-regeling', type: 'select', value: w.vat_scheme, options: [['margin', 'Margeregeling'], ['none', 'Geen btw']] },
      ...(sold ? [
        { type: 'section', label: 'Verkoop' },
        { name: 'sale_date', label: 'Verkoopdatum', type: 'date', value: w.sale_date, required: true },
        { name: 'sale_platform', label: 'Platform', type: 'select', value: w.sale_platform, options: PLATFORMS },
        { name: 'buyer', label: 'Koper', value: w.buyer },
        { name: 'sale_price', label: 'Verkoopprijs (€)', type: 'money', value: w.sale_price, required: true },
        { name: 'sale_costs', label: 'Verkoopkosten (€)', type: 'money', value: w.sale_costs },
      ] : []),
      { name: 'photo', label: 'Nieuwe foto', type: 'file', accept: 'image/*' },
      { name: 'receipt', label: 'Bon toevoegen of vervangen', type: 'file', show: () => !w.batch_id },
      { name: 'notes', label: 'Notities', type: 'textarea', wide: true, value: w.notes },
    ],
    onSubmit: async d => {
      const patch = { ...d }; delete patch.photo; delete patch.receipt;
      for (const k of ['estimated_value', 'purchase_price', 'extra_costs', 'sale_price', 'sale_costs']) if (k in patch) patch[k] = round2(patch[k]);
      if (patch.extra_costs < 0) { toast('Extra kosten kunnen niet negatief zijn', 'bad'); return false; }
      patch.extra_costs = round2(patch.extra_costs + cap);
      patch.box_papers = patch.box_papers || null;
      patch.total_cost = round2(patch.purchase_price + patch.extra_costs);
      if (d.photo) patch.photo_path = await uploadPhoto(d.photo);
      if (d.receipt) patch.receipt_path = await uploadReceipt(d.receipt);
      if (!eqMoney(patch.total_cost, w.total_cost)) patch.history = hist(w, `Kostprijs aangepast van ${euro(w.total_cost)} naar ${euro(patch.total_cost)}`);
      await store.update('watches', id, patch);
      // Gekoppelde bankmutaties en bundel meenemen
      const pe = S().bank_entries.find(e => e.reference_id === `purchase:${id}`);
      const pAmt = -purchaseAmount(S(), watchById(id));
      if (pe && (!eqMoney(pe.amount, pAmt) || pe.date !== patch.purchase_date)) await store.update('bank_entries', pe.id, { amount: pAmt, date: patch.purchase_date || pe.date });
      if (w.batch_id) await syncBatch(w.batch_id);
      const se = S().bank_entries.find(e => e.reference_id === `sale:${id}`);
      if (se && sold) { const net = round2(patch.sale_price - patch.sale_costs); if (!eqMoney(se.amount, net)) await store.update('bank_entries', se.id, { amount: net, date: patch.sale_date }); }
      toast('Opgeslagen'); $('dialog.detail')?.close(); watchDetail(id);
    },
  });
}

function customerReturnForm(id) {
  const w = watchById(id);
  const paid = w.sale_payment === 'received';
  const saleEntry = S().bank_entries.find(e => e.reference_id === `sale:${id}`);
  const received = saleEntry ? n(saleEntry.amount) : round2(n(w.sale_price) - n(w.sale_costs));
  openForm({
    eyebrow: 'Retour van klant', title: wname(w), submit: 'Retour verwerken',
    intro: paid ? `De koper heeft al betaald (${euro(received)} ontvangen). De verkoop wordt teruggedraaid en de terugbetaling wordt geboekt. Een verschil tussen ontvangen en terugbetaald komt als kosten in het resultaat.` : 'De betaling is nog niet ontvangen. De verkoop wordt geannuleerd.',
    fields: [
      { name: 'date', label: 'Datum', type: 'date', value: today(), required: true },
      { name: 'reason', label: 'Reden', placeholder: 'bv. niet zoals beschreven' },
      { name: 'amount', label: 'Terug te betalen aan klant (€)', type: 'money', value: received, show: () => paid },
      { name: 'payment', label: 'Terugbetaling', type: 'select', options: [['paid', 'Al terugbetaald'], ['pending', 'Nog terug te betalen']], show: () => paid },
      { name: 'arrived', label: 'Horloge is al terug', type: 'select', options: [['no', 'Nee, onderweg terug'], ['yes', 'Ja, terug op voorraad']] },
    ],
    onSubmit: async d => {
      const patch = {
        status: d.arrived === 'yes' ? 'in_stock' : 'customer_returning',
        sale_date: null, sale_platform: null, buyer: null, sale_price: null, sale_costs: 0, sale_payment: null,
        history: hist(w, `Verkoop teruggedraaid (${d.reason || 'retour'}); was ${euro(w.sale_price)} via ${w.sale_platform}`, d.date),
      };
      let idx = -1;
      if (paid) {
        const list = [...customerReturns(w), { date: d.date, amount: round2(d.amount), received: round2(received), reason: d.reason, payment: d.payment, sale_price: w.sale_price, sale_date: w.sale_date, platform: w.sale_platform }];
        idx = list.length - 1; patch.customer_returns = list;
      }
      await store.update('watches', id, patch);
      if (!paid) await removeBankRef(`sale:${id}`);
      // De oorspronkelijke verkoopontvangst blijft in de bank staan, maar hoort nu bij deze retour
      if (paid && saleEntry) await store.update('bank_entries', saleEntry.id, { reference_id: `cr-sale:${id}:${idx}` });
      if (paid && d.payment === 'paid') await addBank({ date: d.date, description: `Terugbetaling klant · ${wname(w)}`, amount: -round2(d.amount), type: 'customer_refund', reference_id: `customer-return:${id}:${idx}` });
      toast('Retour verwerkt'); $('dialog.detail')?.close();
    },
  });
}

function supplierReturnForm(id) {
  const w = watchById(id);
  openForm({
    eyebrow: 'Terug naar verkoper', title: wname(w), submit: 'Retour opslaan',
    intro: 'Gebruik dit als je het horloge terugstuurt naar de verkoper. Retourverzendkosten voeg je toe als uitgave in de categorie Retourkosten. Zijn ze verrekend met de terugbetaling? Voeg ze dan toe vóórdat je de terugbetaling als ontvangen verwerkt.',
    fields: [
      { name: 'date', label: 'Datum', type: 'date', value: today(), required: true },
      { name: 'refund', label: 'Terugbetaling van verkoper (€)', type: 'money', value: w.total_cost },
      { name: 'payment', label: 'Terugbetaling', type: 'select', options: [['pending', 'Nog te ontvangen'], ['received', 'Al ontvangen']] },
      { name: 'reason', label: 'Reden' },
    ],
    onSubmit: async d => {
      await store.update('watches', id, {
        status: 'returned', supplier_return: { date: d.date, refund: round2(d.refund), payment: d.payment, reason: d.reason },
        history: hist(w, `Teruggestuurd naar verkoper${d.reason ? ` (${d.reason})` : ''}; terugbetaling ${euro(d.refund)}`, d.date),
      });
      if (d.payment === 'received') await addBank({ date: d.date, description: `Terugbetaling verkoper · ${wname(w)}`, amount: round2(n(d.refund) - linkedReturnCosts(S(), id)), type: 'supplier_refund', reference_id: `refund:${id}` });
      toast('Retour opgeslagen'); $('dialog.detail')?.close();
    },
  });
}

function writeOffForm(id) {
  const w = watchById(id);
  openForm({
    eyebrow: 'Afschrijven', title: wname(w), submit: 'Afschrijven', danger: true,
    intro: `Het horloge gaat uit de voorraad en de volledige kostprijs van <b>${euro(w.total_cost)}</b> komt als verlies in het resultaat.`,
    fields: [
      { name: 'date', label: 'Datum', type: 'date', value: today(), required: true },
      { name: 'reason', label: 'Reden', required: true, placeholder: 'bv. nep, kapot, kwijt' },
    ],
    onSubmit: async d => {
      await store.update('watches', id, { status: 'written_off', write_off: { date: d.date, amount: n(w.total_cost), reason: d.reason }, history: hist(w, `Afgeschreven: ${d.reason}`, d.date) });
      toast('Horloge afgeschreven'); $('dialog.detail')?.close();
    },
  });
}

async function deleteWatch(id) {
  const w = watchById(id);
  const linked = S().expenses.filter(e => e.watch_id === id && (e.capitalized || e.payment_status === 'offset'));
  if (!await confirmDialog('Horloge verwijderen?', `${esc(wname(w))} wordt definitief verwijderd, met alle bankmutaties${linked.length ? ` en ${linked.length} gekoppelde kostenpost(en)` : ''}. Gebruik dit alleen voor een foutieve invoer; gebruik anders Afschrijven of Terug naar verkoper.`)) return;
  for (const p of ['purchase', 'sale', 'refund']) await removeBankRef(`${p}:${id}`);
  await removeBankPrefix(`customer-return:${id}`); await removeBankPrefix(`cr-sale:${id}`);
  for (const e of linked) { await removeBankRef(`expense:${e.id}`); await store.remove('expenses', e.id); }
  for (const e of S().expenses.filter(e => e.watch_id === id)) await store.update('expenses', e.id, { watch_id: null });
  await store.remove('watches', id);
  for (const it of S().items.filter(x => x.data?.watch_id === id)) await saveItem(it.module, it.id, { watch_id: null });
  if (w.batch_id) await syncBatch(w.batch_id);
  $('dialog.detail')?.close(); toast('Verwijderd'); render();
}

async function deleteExpense(id, fromForm = false) {
  const e = S().expenses.find(x => x.id === id);
  const w = e.watch_id && watchById(e.watch_id);
  if (e.payment_status === 'offset' && w?.supplier_return?.payment === 'received') { toast('Deze kosten zijn al verrekend met een ontvangen terugbetaling en kunnen niet meer weg', 'bad'); return false; }
  if (!await confirmDialog('Uitgave verwijderen?', `${esc(e.description)} (${euro(e.amount)}) wordt verwijderd, inclusief de bankmutatie${e.capitalized && w ? ` en de verhoging van de kostprijs van ${esc(wname(w))}` : ''}.`)) return false;
  if (e.capitalized && w) await store.update('watches', w.id, { extra_costs: round2(Math.max(0, n(w.extra_costs) - n(e.amount))), total_cost: round2(n(w.total_cost) - n(e.amount)), history: hist(w, `Kosten "${e.description}" verwijderd`) });
  await removeBankRef(`expense:${id}`); await store.remove('expenses', id);
  if (w?.batch_id) await syncBatch(w.batch_id);
  toast('Verwijderd'); if (!fromForm) render();
  return true;
}

function addReceiptForm(table, id) {
  openForm({
    eyebrow: 'Bon toevoegen', title: 'Bon of factuur', submit: 'Opslaan',
    fields: [{ name: 'receipt', label: 'Bestand (foto of pdf)', type: 'file', wide: true }],
    onSubmit: async d => { if (!d.receipt) { toast('Kies een bestand', 'bad'); return false; } await store.update(table, id, { receipt_path: await uploadReceipt(d.receipt) }); toast('Bon opgeslagen'); },
  });
}

async function openFile(path) {
  const win = window.open('', '_blank');
  const url = await store.fileUrl(path);
  if (!url) { win?.close(); toast('Bestand niet gevonden', 'bad'); return; }
  if (win) { if (url.startsWith('data:')) win.document.write(`<iframe src="${url}" style="border:0;width:100%;height:100%"></iframe>`); else win.location = url; }
}

// Openstaande post verwerken (bedrag ligt vast, zodat bank en boekhouding altijd gelijk lopen)
function settleForm(pid) {
  const p = pendingPayments(S()).find(x => x.id === pid); if (!p) return;
  openForm({
    eyebrow: p.direction === 'in' ? 'Ontvangst verwerken' : 'Betaling verwerken', title: p.description, submit: 'Verwerken',
    intro: `Bedrag: <b>${euro(p.amount)}</b> ${p.direction === 'in' ? 'ontvangen op' : 'betaald vanaf'} de zakelijke rekening. Wijkt het echte bedrag af? Pas dan eerst de inkoop, verkoop of uitgave aan.`,
    fields: [{ name: 'date', label: 'Datum van de betaling', type: 'date', value: today(), required: true }],
    onSubmit: async d => {
      const amt = round2(p.amount), id = p.watchId || p.batchId || p.expenseId;
      const w = watchById(id);
      if (p.kind === 'sale') { await store.update('watches', id, { sale_payment: 'received', history: hist(w, 'Betaling ontvangen', d.date) }); await addBank({ date: d.date, description: `Verkoop ${wname(w)}`, amount: amt, type: 'sale', reference_id: `sale:${id}` }); }
      if (p.kind === 'refund') { await store.update('watches', id, { supplier_return: { ...w.supplier_return, payment: 'received' }, history: hist(w, 'Terugbetaling verkoper ontvangen', d.date) }); await addBank({ date: d.date, description: `Terugbetaling verkoper · ${wname(w)}`, amount: amt, type: 'supplier_refund', reference_id: `refund:${id}` }); }
      if (p.kind === 'customer-return') { const list = customerReturns(w).map((r, i) => i === p.index ? { ...r, payment: 'paid' } : r); await store.update('watches', id, { customer_returns: list, history: hist(w, 'Klant terugbetaald', d.date) }); await addBank({ date: d.date, description: `Terugbetaling klant · ${wname(w)}`, amount: -amt, type: 'customer_refund', reference_id: `customer-return:${id}:${p.index}` }); }
      if (p.kind === 'purchase') { await store.update('watches', id, { purchase_payment: 'paid', history: hist(w, 'Inkoop betaald', d.date) }); await addBank({ date: d.date, description: `Inkoop ${wname(w)}`, amount: -amt, type: 'purchase', reference_id: `purchase:${id}` }); }
      if (p.kind === 'batch') { await store.update('purchase_batches', id, { payment_status: 'paid' }); await addBank({ date: d.date, description: p.description, amount: -amt, type: 'purchase', reference_id: `batch:${id}` }); }
      if (p.kind === 'expense') { await store.update('expenses', id, { payment_status: 'paid' }); await addBank({ date: d.date, description: p.description, amount: -amt, type: 'expense', reference_id: `expense:${id}` }); }
      toast('Verwerkt');
    },
  });
}

function bankEntryForm(preset = {}) {
  const owed = vatOwed(S());
  openForm({
    eyebrow: 'Bank', title: 'Mutatie toevoegen', submit: 'Opslaan',
    intro: 'Inkopen, verkopen en uitgaven worden automatisch geboekt. Gebruik dit alleen voor stortingen en opnames van vennoten, overige opbrengsten en btw-afdracht.',
    fields: [
      { name: 'type', label: 'Soort', type: 'select', value: preset.type, options: [['owner_deposit', 'Storting door vennoot (bv. startkapitaal)'], ['owner_withdrawal', 'Opname door vennoot'], ['income', 'Overige opbrengst (rente, cashback)'], ['vat_payment', 'Btw-afdracht aan Belastingdienst']] },
      { name: 'partner', label: 'Vennoot', type: 'select', options: partners(), value: store.user?.name, show: d => d.type.startsWith('owner') },
      { name: 'date', label: 'Datum', type: 'date', value: today(), required: true },
      { name: 'amount', label: 'Bedrag (€)', type: 'money', required: true, value: preset.amount, hint: owed > 0 ? `Nog af te dragen btw volgens de app: ${euro(owed)}` : '' },
      { name: 'description', label: 'Omschrijving', wide: true, value: preset.description },
    ],
    onSubmit: async d => {
      const amt = round2(d.amount);
      if (amt <= 0) { toast('Vul een bedrag groter dan 0 in', 'bad'); return false; }
      const out = ['owner_withdrawal', 'vat_payment'].includes(d.type);
      await addBank({ date: d.date, type: d.type, partner: d.type.startsWith('owner') ? d.partner : null, reference_id: d.type === 'vat_payment' && preset.reference_id ? preset.reference_id : null, amount: out ? -amt : amt, description: d.description || (BANK_TYPES[d.type] + (d.type.startsWith('owner') ? ` · ${d.partner}` : '')) });
      toast('Mutatie opgeslagen');
    },
  });
}

function balanceForm() {
  const cur = bankBalance(S());
  openForm({
    eyebrow: 'Bank', title: 'Saldo corrigeren', submit: 'Corrigeren',
    intro: `Volgens de app is het saldo <b>${euro(cur)}</b>. Vul het echte saldo uit je bankapp in; het verschil wordt geboekt als kasverschil en telt mee in het resultaat. Zoek eerst of er iets vergeten is (een uitgave, storting of verkoop), want dat is beter dan corrigeren. Startkapitaal? Gebruik dan "Storting door vennoot".`,
    fields: [{ name: 'balance', label: 'Werkelijk saldo (€)', type: 'money', allowNegative: true, required: true, value: cur }, { name: 'date', label: 'Datum', type: 'date', value: today() }],
    onSubmit: async d => {
      const diff = round2(n(d.balance) - cur); if (!diff) { toast('Saldo klopt al'); return; }
      await addBank({ date: d.date, type: 'correction', amount: diff, description: `Kasverschil (${diff > 0 ? '+' : ''}${euro(diff)})` }); toast('Saldo gecorrigeerd');
    },
  });
}

// Detailpaneel horloge
async function watchDetail(id) {
  const w = watchById(id); if (!w) return;
  const s = S().settings;
  const batch = w.batch_id && S().purchase_batches.find(b => b.id === w.batch_id);
  const days = w.purchase_date ? daysBetween(w.purchase_date, w.sale_date || today()) : null;
  const cap = capitalizedSum(S(), id), crs = customerReturns(w);
  const row = (l, v) => v === null || v === undefined || v === '' ? '' : `<div class="kv"><span>${l}</span><b>${v}</b></div>`;
  const acts = [];
  if (w.status === 'incoming' || w.status === 'customer_returning') acts.push(`<button class="btn primary" data-action="arrive" data-id="${id}">✓ Binnen</button>`);
  if (w.status === 'in_stock') acts.push(`<button class="btn primary" data-action="sale" data-id="${id}">Verkopen</button>`);
  if (w.status === 'sold') acts.push(`<button class="btn" data-action="customer-return" data-id="${id}">Retour van klant</button>`);
  if (['in_stock', 'incoming'].includes(w.status)) acts.push(`<button class="btn" data-action="supplier-return" data-id="${id}">Terug naar verkoper</button>`, `<button class="btn" data-action="write-off" data-id="${id}">Afschrijven</button>`);
  if (w.status !== 'written_off') acts.push(`<button class="btn" data-action="watch-cost" data-id="${id}">＋ Kosten</button>`);
  acts.push(`<button class="btn" data-action="edit-watch" data-id="${id}">Bewerken</button>`, `<button class="btn ghost danger-text" data-action="delete-watch" data-id="${id}">Verwijderen</button>`);
  const dlg = openDialog(`<div class="modal-body wide">
    <header><div><div class="eyebrow">${esc(w.reference || 'Horloge')}</div><h2>${esc(wname(w))}</h2><div>${statusChip(w.status)}</div></div><button class="x" data-close aria-label="Sluiten">×</button></header>
    <div class="detail-grid">
      <div class="photo big" data-photo="${esc(w.photo_path || '')}"><span>${esc(w.brand?.[0] || '◷')}</span></div>
      <div>
        ${(() => { const r = row('Referentie', esc(w.reference)) + row('Serienummer', esc(w.serial)) + row('Bouwjaar', esc(w.year)) + row('Staat', esc(w.condition)) + row('Box & papieren', BOX_PAPERS[w.box_papers]); return r ? `<h3>Horloge</h3>${r}` : ''; })()}
        <h3>Inkoop</h3>
        ${row('Datum', fdate(w.purchase_date))}${row('Platform', esc(w.purchase_platform))}${row('Verkoper', esc(w.seller))}
        ${row('Inkoopprijs', euro(w.purchase_price))}${row(batch ? 'Aandeel bundelkosten' : 'Extra kosten bij inkoop', euro(n(w.extra_costs) - cap))}${cap ? row('Kosten achteraf', `<button class="link" data-go="financien/expenses">${euro(cap)}</button>`) : ''}${row('Kostprijs', `<span class="big-num">${euro(w.total_cost)}</span>`)}
        ${row('Betaling', { paid: 'Betaald', pending: 'Nog te betalen', private: `Privé · ${esc(w.purchase_paid_by)}`, batch: batch ? `Via bundel (${batch.payment_status === 'pending' ? 'nog te betalen' : 'betaald'})` : 'Bundel' }[w.purchase_payment])}
        ${ACTIVE.includes(w.status) ? row('Geschatte waarde', w.estimated_value ? euro(w.estimated_value) : '—') + row('Dagen in bezit', days) : ''}
        ${w.status === 'sold' ? `<h3>Verkoop</h3>${row('Datum', fdate(w.sale_date))}${row('Platform', esc(w.sale_platform))}${row('Koper', esc(w.buyer))}${row('Verkoopprijs', euro(w.sale_price))}${row('Verkoopkosten', euro(w.sale_costs))}${s.vat_enabled && w.vat_scheme === 'margin' ? row('Btw (marge)', euro(marginVat(w, s))) : ''}${row('Winst', signed(watchProfit(w, s)))}${row('Doorlooptijd', `${days} dagen`)}${row('Betaling', w.sale_payment === 'pending' ? 'Nog te ontvangen' : 'Ontvangen')}` : ''}
        ${w.supplier_return ? `<h3>Retour naar verkoper</h3>${row('Datum', fdate(w.supplier_return.date))}${row('Terugbetaling', euro(w.supplier_return.refund))}${row('Status', w.supplier_return.payment === 'pending' ? 'Nog te ontvangen' : 'Ontvangen')}` : ''}
        ${crs.length ? `<h3>Retouren van klanten</h3>${crs.map(r => row(`${fdate(r.date)}${r.reason ? ' · ' + esc(r.reason) : ''}`, `${euro(r.received)} ontvangen · ${euro(r.amount)} terug${r.payment === 'pending' ? ' (open)' : ''}`)).join('')}` : ''}
        ${w.write_off ? `<h3>Afschrijving</h3>${row('Datum', fdate(w.write_off.date))}${row('Bedrag', euro(w.total_cost))}${row('Reden', esc(w.write_off.reason))}` : ''}
        <p class="row-actions">${(w.receipt_path || batch?.receipt_path) ? `<button class="link" data-action="file" data-path="${esc(w.receipt_path || batch.receipt_path)}">📎 Bon inkoop bekijken</button>` : `<button class="link" data-action="receipt-add" data-table="${batch ? 'purchase_batches' : 'watches'}" data-id="${batch ? batch.id : id}">＋ Bon inkoop toevoegen</button>`}</p>
        ${w.notes ? `<h3>Notities</h3><p class="notes">${esc(w.notes)}</p>` : ''}
        <h3>Documenten</h3>
        <div class="linked">${items('doc').filter(d => d.watch_id === id).map(d => `<button class="chip" data-action="file" data-path="${esc(d.path)}">📄 ${esc(d.name)}</button>`).join('')}<button class="btn small" data-action="doc" data-watch="${id}">＋ Document</button></div>
        <h3>Marketing & taken</h3>
        <div class="linked">${items('post').filter(p => p.watch_id === id).map(p => `<button class="chip ps-${p.status}" data-action="edit-post" data-id="${p.id}">${esc(p.channel || '')} · ${fdate(p.date)}</button>`).join('')}${items('task').filter(t => t.watch_id === id && t.status !== 'done').map(t => `<button class="chip" data-action="edit-task" data-id="${t.id}">☐ ${esc(t.title)}</button>`).join('')}
          <button class="btn small" data-action="post" data-watch="${id}">＋ Post</button><button class="btn small" data-action="task" data-watch="${id}">＋ Taak</button></div>
      </div>
    </div>
    ${(w.history || []).length ? `<h3>Geschiedenis</h3><ol class="timeline">${[...w.history].reverse().map(h => `<li><span>${fdate(h.date)}</span>${esc(h.text)}${h.by ? ` <em>· ${esc(h.by)}</em>` : ''}</li>`).join('')}</ol>` : ''}
    <footer class="actions">${acts.join('')}</footer>
  </div>`, 'detail');
  loadPhotos(dlg);
}

async function loadPhotos(root = document) {
  for (const el of root.querySelectorAll('[data-photo]:not([data-loaded])')) {
    el.dataset.loaded = '1';
    const path = el.dataset.photo; if (!path) continue;
    store.fileUrl(path).then(url => { if (url) { el.style.backgroundImage = `url("${url}")`; el.classList.add('has-photo'); } }).catch(() => {});
  }
}

// ───────────── Pagina's ─────────────
const head = (title, sub = '', actions = '') => `<header class="page-head"><div><h1>${title}</h1>${sub ? `<p class="muted">${sub}</p>` : ''}</div><div class="head-actions">${actions}</div></header>`;
const stat = (label, value, sub = '', action = '') => `<div class="stat" ${action}><span>${label}</span><strong>${value}</strong>${sub ? `<small>${sub}</small>` : ''}</div>`;
const empty = (text, action = '') => `<div class="empty"><p>${text}</p>${action}</div>`;

function barChart(data) {
  if (!data.some(d => d.result)) return empty('Nog geen resultaat om te tonen.');
  const W = 1100, H = 240, pad = 30, bw = (W - pad * 2) / data.length;
  const max = Math.max(1, ...data.map(d => Math.abs(d.result)));
  const hasNeg = data.some(d => d.result < 0);
  const short = v => (v < 0 ? '−' : '') + '€' + (Math.abs(v) >= 1000 ? (Math.abs(v) / 1000).toFixed(1).replace('.', ',') + 'k' : Math.round(Math.abs(v)));
  const zero = hasNeg ? H / 2 : H - pad;
  const scale = (hasNeg ? H / 2 - pad - 8 : H - pad * 2 - 10) / max;
  const bars = data.map((d, i) => {
    const h = Math.abs(d.result) * scale, x = pad + i * bw + bw * 0.18, y = d.result >= 0 ? zero - h : zero;
    const label = new Date(d.month + '-15').toLocaleDateString('nl-NL', { month: 'short' }).replace('.', '');
    return `<g><title>${label}: ${euro(d.result)}</title><rect x="${x}" y="${y}" width="${bw * 0.64}" height="${Math.max(h, d.result ? 1 : 0)}" rx="3" class="${d.result < 0 ? 'neg' : 'pos'}"/>
      ${d.result ? `<text x="${x + bw * 0.32}" y="${d.result >= 0 ? y - 6 : y + h + 14}" class="val">${short(d.result)}</text>` : ''}
      <text x="${x + bw * 0.32}" y="${H - 6}" class="axis">${label}</text></g>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Resultaat per maand"><line x1="${pad}" x2="${W - pad}" y1="${zero}" y2="${zero}" class="zero"/>${bars}</svg>`;
}

const pages = {
  dashboard() {
    const st = S(), y = periodRange('year'), c = calc(st, y), all = calc(st);
    const pend = pendingPayments(st), recv = pend.filter(p => p.direction === 'in').reduce((a, p) => a + p.amount, 0), pay = pend.filter(p => p.direction === 'out').reduce((a, p) => a + p.amount, 0);
    const bal = bankBalance(st), acts = actionItems(st);
    const recent = [...st.watches].sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at))).slice(0, 6);
    const rc = reconcile(st), owed = vatOwed(st);
    return head('Financieel overzicht', `Stand van zaken ${y.label}`) + `
      <a class="check-banner ${rc.ok ? 'ok' : 'bad'}" data-go="financien/check">${rc.ok ? '✓ De boekhouding sluit: bank, voorraad, openstaande posten en resultaat kloppen met elkaar.' : `⚠︎ De controle vond ${rc.issues.length} ${rc.issues.length === 1 ? 'punt' : 'punten'} om na te kijken.`} <span>Controle ›</span></a>
      <section class="stats">
        ${stat(`Resultaat ${y.label}`, signed(c.result), `${c.soldCount} verkocht · omzet ${euro(c.revenue)}`, 'data-go="reports"')}
        ${stat('Voorraad', euro(all.stock), `${all.stockCount} ${all.stockCount === 1 ? 'horloge' : 'horloges'} · geschat ${euro(all.stockEstimated)}`, 'data-go="stock"')}
        ${stat('Banksaldo', euro(bal), `verwacht ${euro(bal + recv - pay)}`, 'data-go="bank"')}
        ${stat('Openstaand', `<span class="good">+${euro(recv)}</span> <span class="bad">−${euro(pay)}</span>`, `te ontvangen / te betalen${st.settings.vat_enabled ? ` · btw af te dragen ${euro(owed)}` : ''}`, 'data-go="bank"')}
      </section>
      <section class="cols">
        <div class="card"><div class="card-head"><h2>Actie nodig</h2><span class="badge">${acts.length}</span></div>
          ${acts.length ? `<ul class="list">${acts.slice(0, 8).map(a => `<li ${a.watchId ? `data-action="watch" data-id="${a.watchId}"` : a.kind === 'receipt' ? `data-action="receipt-add" data-table="${a.table}" data-id="${a.recordId}"` : a.kind === 'vat' ? 'data-go="financien/vat"' : 'data-go="bank"'}><div><b>${esc(a.description)}</b><small>${a.reason} · ${fdate(a.date)}</small></div>${a.amount !== undefined ? `<span class="${a.direction === 'in' ? 'good' : 'bad'}">${a.direction === 'in' ? '+' : '−'}${euro(a.amount)}</span>` : '<span class="chev">›</span>'}</li>`).join('')}</ul>` : empty('Alles is bijgewerkt.')}
        </div>
        <div class="card"><div class="card-head"><h2>Recent</h2><a data-go="stock">Alle horloges ›</a></div>
          ${recent.length ? `<ul class="list">${recent.map(w => `<li data-action="watch" data-id="${w.id}"><div class="photo sm" data-photo="${esc(w.photo_path || '')}"><span>${esc(w.brand[0])}</span></div><div><b>${esc(wname(w))}</b><small>${STATUS[w.status]}</small></div><span>${w.status === 'sold' ? signed(watchProfit(w, st.settings)) : euro(w.total_cost)}</span></li>`).join('')}</ul>` : empty('Nog geen horloges. Begin met je eerste inkoop.', '<button class="btn primary" data-action="purchase">＋ Inkoop</button>')}
        </div>
      </section>
      <section class="card"><div class="card-head"><h2>Resultaat per maand</h2><small class="muted">laatste 12 maanden</small></div>${barChart(monthlyResults(st, today().slice(0, 7)))}</section>`;
  },

  stock() {
    const st = S(), q = ui.stockSearch.toLowerCase();
    const filters = [['active', 'Actief'], ['incoming', 'Onderweg'], ['in_stock', 'Op voorraad'], ['customer_returning', 'Retour onderweg'], ['sold', 'Verkocht'], ['returned', 'Terug naar verkoper'], ['written_off', 'Afgeschreven'], ['all', 'Alles']];
    const count = f => st.watches.filter(w => f === 'all' || (f === 'active' ? ACTIVE.includes(w.status) : w.status === f)).length;
    const list = st.watches.filter(w => (ui.stockFilter === 'all' || (ui.stockFilter === 'active' ? ACTIVE.includes(w.status) : w.status === ui.stockFilter)))
      .filter(w => !q || `${w.brand} ${w.model} ${w.reference} ${w.serial} ${w.notes}`.toLowerCase().includes(q))
      .sort((a, b) => String(b.purchase_date).localeCompare(String(a.purchase_date)));
    const c = calc(st);
    return head('Voorraad', `${c.stockCount} ${c.stockCount === 1 ? 'horloge' : 'horloges'} actief · kostprijs ${euro(c.stock)} · geschat ${euro(c.stockEstimated)}`, '<button class="btn primary" data-action="purchase">＋ Inkoop</button>') + `
      <div class="toolbar"><input class="search" id="stockSearch" placeholder="Zoek op merk, model, referentie…" value="${esc(ui.stockSearch)}">
        <div class="tabs">${filters.map(([k, l]) => `<button class="${ui.stockFilter === k ? 'on' : ''}" data-filter="${k}">${l} <small>${count(k)}</small></button>`).join('')}</div></div>
      ${list.length ? `<div class="watch-grid">${list.map(w => {
        const days = w.purchase_date ? daysBetween(w.purchase_date, w.sale_date || today()) : 0;
        return `<article class="watch" data-action="watch" data-id="${w.id}">
          <div class="photo" data-photo="${esc(w.photo_path || '')}"><span>${esc(w.brand[0])}</span>${statusChip(w.status)}</div>
          <div class="watch-body"><small class="muted">${esc(w.reference || '—')}</small><h3>${esc(w.brand)} <span>${esc(w.model)}</span></h3>
          <div class="watch-nums">${w.status === 'sold' ? `<div><small>Verkocht</small><b>${euro(w.sale_price)}</b></div><div><small>Winst</small>${signed(watchProfit(w, st.settings))}</div>` : `<div><small>Kostprijs</small><b>${euro(w.total_cost)}</b></div><div><small>Geschat</small><b>${w.estimated_value ? euro(w.estimated_value) : '—'}</b></div>`}</div>
          <small class="muted">${days} dagen${w.purchase_platform ? ' · ' + esc(w.purchase_platform) : ''}</small></div></article>`;
      }).join('')}</div>` : empty(st.watches.length ? 'Geen horloges gevonden met dit filter.' : 'Nog geen horloges in de voorraad.', '<button class="btn primary" data-action="purchase">＋ Eerste inkoop</button>')}`;
  },

  sales() {
    const st = S(), r = periodRange(ui.salesPeriod), s = st.settings;
    const list = st.watches.filter(w => w.status === 'sold' && inPeriod(w.sale_date, r.from, r.to)).sort((a, b) => b.sale_date.localeCompare(a.sale_date));
    const c = calc(st, r), vat = s.vat_enabled;
    return head('Verkopen', `${list.length} verkocht · ${r.label}`, `${periodSelect(ui.salesPeriod, 'salesPeriod')}<button class="btn primary" data-action="sale">＋ Verkoop</button>`) + `
      <section class="stats">${stat('Omzet', euro(c.revenue))}${vat ? stat('Btw (marge)', euro(c.vat)) : ''}${stat('Brutowinst', signed(c.grossProfit - c.saleCosts), 'na verkoopkosten')}${stat('Gem. winst per horloge', list.length ? signed((c.grossProfit - c.saleCosts) / list.length) : '—')}</section>
      ${list.length ? `<div class="card flush"><table class="table"><thead><tr><th>Datum</th><th>Horloge</th><th>Platform</th><th class="r">Kostprijs</th><th class="r">Verkoop</th><th class="r">Kosten</th>${vat ? '<th class="r">Btw</th>' : ''}<th class="r">Winst</th><th class="r">Marge</th><th></th></tr></thead><tbody>
        ${list.map(w => { const p = watchProfit(w, s); return `<tr data-action="watch" data-id="${w.id}"><td>${fdate(w.sale_date)}</td><td><b>${esc(wname(w))}</b><small class="muted"> ${esc(w.reference || '')}</small></td><td>${esc(w.sale_platform || '')}</td><td class="r">${euro(w.total_cost)}</td><td class="r">${euro(w.sale_price)}</td><td class="r">${euro(w.sale_costs)}</td>${vat ? `<td class="r">${euro(marginVat(w, s))}</td>` : ''}<td class="r">${signed(p)}</td><td class="r">${w.sale_price ? Math.round(p / w.sale_price * 100) : 0}%</td><td>${w.sale_payment === 'pending' ? '<span class="chip warn">open</span>' : ''}</td></tr>`; }).join('')}
      </tbody></table></div>` : empty('Nog geen verkopen in deze periode.')}`;
  },

  expenses() {
    const st = S(), r = periodRange(ui.expensePeriod);
    const list = st.expenses.filter(e => inPeriod(e.date, r.from, r.to)).sort((a, b) => b.date.localeCompare(a.date));
    const ops = list.filter(e => !e.capitalized);
    const byCat = EXPENSE_CATEGORIES.map(cat => [cat, ops.filter(e => e.category === cat).reduce((a, e) => a + n(e.amount), 0)]).filter(x => x[1]);
    const total = ops.reduce((a, e) => a + n(e.amount), 0), capTotal = list.filter(e => e.capitalized).reduce((a, e) => a + n(e.amount), 0);
    const pay = e => ({ paid: 'Zakelijk', pending: '<span class="chip warn">Te betalen</span>', private: `Privé · ${esc(e.paid_by)}`, offset: 'Verrekend' })[e.payment_status] || '';
    return head('Uitgaven', `${euro(total)} bedrijfskosten${capTotal ? ` · ${euro(capTotal)} opgeteld bij kostprijs horloges` : ''} · ${r.label}`, `${periodSelect(ui.expensePeriod, 'expensePeriod')}<button class="btn primary" data-action="expense">＋ Uitgave</button>`) + `
      ${byCat.length ? `<section class="pills">${byCat.map(([c, v]) => `<div><span>${esc(c)}</span><b>${euro(v)}</b></div>`).join('')}</section>` : ''}
      ${list.length ? `<div class="card flush"><table class="table"><thead><tr><th>Datum</th><th>Omschrijving</th><th>Categorie</th><th>Betaling</th><th>Bon</th><th class="r">Bedrag</th><th></th></tr></thead><tbody>
        ${list.map(e => `<tr data-action="edit-expense" data-id="${e.id}"><td>${fdate(e.date)}</td><td><b>${esc(e.description)}</b>${e.watch_id ? `<small class="muted"> · ${esc(wname(watchById(e.watch_id)))}</small>` : ''}${e.capitalized ? ' <span class="chip">bij kostprijs</span>' : ''}</td><td>${esc(e.category)}</td><td>${pay(e)}</td>
          <td>${e.receipt_path ? `<button class="link" data-action="file" data-path="${esc(e.receipt_path)}">📎 Bekijk</button>` : `<button class="link muted" data-action="receipt-add" data-table="expenses" data-id="${e.id}">＋ Bon</button>`}</td>
          <td class="r">${euro(e.amount)}</td><td class="r"><button class="x" data-action="delete-expense" data-id="${e.id}" title="Verwijderen">×</button></td></tr>`).join('')}
      </tbody></table></div>` : empty('Nog geen uitgaven in deze periode.')}`;
  },

  bank() {
    const st = S(), bal = bankBalance(st), pend = pendingPayments(st);
    const recv = pend.filter(p => p.direction === 'in').reduce((a, p) => a + p.amount, 0), pay = pend.filter(p => p.direction === 'out').reduce((a, p) => a + p.amount, 0);
    const entries = [...st.bank_entries].sort((a, b) => b.date.localeCompare(a.date) || String(b.created_at).localeCompare(String(a.created_at)));
    const manual = MANUAL_BANK_TYPES, owed = vatOwed(st);
    return head('Bank', 'Zakelijke rekening, bijgewerkt door elke betaalde inkoop, verkoop en uitgave.', '<button class="btn" data-action="balance">Saldo corrigeren</button><button class="btn primary" data-action="bank-entry">＋ Mutatie</button>') + `
      <section class="stats">${stat('Saldo', euro(bal))}${stat('Te ontvangen', `<span class="good">${euro(recv)}</span>`)}${stat('Te betalen', `<span class="bad">${euro(pay)}</span>`)}${stat('Verwacht saldo', euro(bal + recv - pay), st.settings.vat_enabled ? `daarna nog btw af te dragen: ${euro(owed)}` : '')}</section>
      <section class="card"><div class="card-head"><h2>Openstaand</h2></div>
        ${pend.length ? `<ul class="list">${pend.map(p => `<li><div><b>${esc(p.description)}</b><small>${p.direction === 'in' ? 'Te ontvangen' : 'Te betalen'} · ${fdate(p.date)}</small></div><span class="${p.direction === 'in' ? 'good' : 'bad'}">${p.direction === 'in' ? '+' : '−'}${euro(p.amount)}</span><button class="btn small" data-action="settle" data-id="${p.id}">Verwerken</button></li>`).join('')}</ul>` : empty('Niets openstaand.')}
      </section>
      <section class="card flush"><div class="card-head pad"><h2>Mutaties</h2></div>
        ${entries.length ? `<table class="table"><thead><tr><th>Datum</th><th>Omschrijving</th><th>Soort</th><th class="r">Bedrag</th><th></th></tr></thead><tbody>${entries.map(e => `<tr><td>${fdate(e.date)}</td><td>${esc(e.description)}</td><td><span class="chip">${BANK_TYPES[e.type] || e.type}</span></td><td class="r">${signed(e.amount)}</td><td class="r">${manual.includes(e.type) && !e.reference_id ? `<button class="x" data-action="delete-bank" data-id="${e.id}" title="Verwijderen">×</button>` : ''}</td></tr>`).join('')}</tbody></table>` : empty('Nog geen mutaties. Begin met de eerste storting van jullie startkapitaal.', '<button class="btn primary" data-action="bank-entry">＋ Storting</button>')}
      </section>`;
  },

  reports() {
    const st = S(), r = periodRange(ui.period), c = calc(st, r), s = st.settings;
    const line = (l, v, cls = '') => `<div class="statement-row ${cls}"><span>${l}</span><b>${v}</b></div>`;
    const group = (title, rows) => `<div class="card"><div class="card-head"><h2>${title}</h2></div>${rows.length ? `<table class="table compact"><thead><tr><th></th><th class="r">Aantal</th><th class="r">Omzet</th><th class="r">Winst</th><th class="r">Gem. dagen</th></tr></thead><tbody>${rows.map(g => `<tr><td>${esc(g.name)}</td><td class="r">${g.count}</td><td class="r">${euro(g.revenue)}</td><td class="r">${signed(g.profit)}</td><td class="r">${g.avgDays}</td></tr>`).join('')}</tbody></table>` : empty('Nog geen verkopen.')}</div>`;
    const year = +today().slice(0, 4);
    return head('Rapportages', `Periode: ${r.label}`, `${periodSelect(ui.period, 'period')}<div class="menu-wrap"><button class="btn" data-action="export">↓ Exporteren (CSV)</button></div>`) + `
      <section class="cols">
        <div class="card"><div class="card-head"><h2>Resultatenrekening</h2></div><div class="statement">
          ${line('Omzet', euro(c.revenue))}
          ${s.vat_enabled ? line('Btw margeregeling', `− ${euro(c.vat)}`) + line('Netto-omzet', euro(c.netRevenue), 'sub') : ''}
          ${line('Inkoopwaarde verkochte horloges', `− ${euro(c.cogs)}`)}
          ${line('Brutowinst', euro(c.grossProfit), 'sub')}
          ${line('Verkoopkosten', `− ${euro(c.saleCosts)}`)}
          ${line('Bedrijfskosten', `− ${euro(c.expenses)}`)}
          ${c.writeOff ? line('Afschrijvingen', `− ${euro(c.writeOff)}`) : ''}
          ${c.returnResult ? line('Resultaat retouren naar verkoper', euro(c.returnResult)) : ''}
          ${c.customerReturnResult ? line('Resultaat retouren van klanten', euro(c.customerReturnResult)) : ''}
          ${c.otherIncome ? line('Overige opbrengsten', euro(c.otherIncome)) : ''}
          ${c.corrections ? line('Kasverschillen (saldocorrecties)', euro(c.corrections)) : ''}
          ${line('Nettowinst', signed(c.result), 'total')}
        </div></div>
        <div class="card"><div class="card-head"><h2>Kerncijfers</h2></div><div class="statement">
          ${line('Verkochte horloges', c.soldCount)}
          ${line('Gemiddelde verkoopprijs', c.soldCount ? euro(c.revenue / c.soldCount) : '—')}
          ${line('Gemiddelde winst per horloge', c.soldCount ? euro((c.grossProfit - c.saleCosts) / c.soldCount) : '—')}
          ${line('Winstmarge', c.revenue ? Math.round(c.result / c.revenue * 100) + '%' : '—')}
          ${line('Voorraad tegen kostprijs (nu)', euro(c.stock))}
          ${line('Geschatte voorraadwaarde (nu)', euro(c.stockEstimated))}
        </div></div>
      </section>
      <section class="card"><div class="card-head"><h2>Resultaat per maand</h2><small class="muted">laatste 12 maanden</small></div>${barChart(monthlyResults(st, today().slice(0, 7)))}</section>
      <section class="cols">${group('Per merk', groupSold(st, 'brand', r))}${group('Per verkoopplatform', groupSold(st, 'sale_platform', r))}</section>
      ${s.vat_enabled ? `<section class="card"><div class="card-head"><h2>Btw per kwartaal ${year}</h2><small class="muted">margeregeling, indicatief — laat je aangifte controleren</small></div><table class="table compact"><thead><tr><th>Kwartaal</th><th class="r">Verkocht</th><th class="r">Omzet</th><th class="r">Btw (marge)</th><th class="r">Afgedragen in kwartaal</th></tr></thead><tbody>${quarterlyVat(st, year).map(q => `<tr><td>${q.quarter}</td><td class="r">${q.count}</td><td class="r">${euro(q.revenue)}</td><td class="r"><b>${euro(q.vat)}</b></td><td class="r">${euro(q.paid)}</td></tr>`).join('')}</tbody></table><p class="muted small-note">Nog af te dragen in totaal: <b>${euro(vatOwed(st))}</b>. Boek een betaling aan de Belastingdienst via Bank → ＋ Mutatie → Btw-afdracht.</p></section>` : ''}`;
  },

  partners() {
    const st = S(), cap = partnerCapital(st), c = calc(st);
    return head('Vennoten', 'Inbreng, opnames en winstaandeel per vennoot, over de hele looptijd.', '<button class="btn primary" data-action="bank-entry">＋ Storting / opname</button>') + `
      <section class="cols">${cap.map(p => `<div class="card partner"><div class="card-head"><h2>${esc(p.partner)}</h2><span class="badge">${p.share}%</span></div><div class="statement">
        <div class="statement-row"><span>Stortingen</span><b>${euro(p.deposits)}</b></div>
        <div class="statement-row"><span>Privé betaalde inkopen en kosten</span><b>${euro(p.privatePaid)}</b></div>
        <div class="statement-row"><span>Opnames</span><b>− ${euro(p.withdrawals)}</b></div>
        <div class="statement-row sub"><span>Netto inbreng</span><b>${euro(p.contribution)}</b></div>
        <div class="statement-row"><span>Winstaandeel (${p.share}% van ${euro(c.result)})</span><b>${signed(p.profitShare)}</b></div>
        <div class="statement-row total"><span>Kapitaal</span><b>${euro(p.capital)}</b></div></div></div>`).join('')}</section>
      <p class="muted small-note">Kapitaal = stortingen + privé betaalde zaken − opnames + winstaandeel. De winstverdeling stel je in bij Instellingen.</p>`;
  },

  settings() {
    const s = S().settings;
    return head('Instellingen') + settingsTeam() + `
      <section class="card"><div class="card-head"><h2>Btw</h2></div>
        <label class="check"><input type="checkbox" data-setting="vat_enabled" ${s.vat_enabled ? 'checked' : ''}> Btw berekenen volgens de margeregeling</label>
        <p class="muted">Per verkocht horloge: (verkoopprijs − inkoopprijs) × ${s.vat_rate}/${100 + n(s.vat_rate)}. Zet dit uit als jullie onder de kleineondernemersregeling (KOR) vallen. Laat dit altijd controleren door een boekhouder.</p>
      </section>
      <section class="card"><div class="card-head"><h2>Winstverdeling</h2></div>
        <div class="grid">${partners().map(p => `<label class="field"><span>${esc(p)} (%)</span><input type="number" min="0" max="100" step="1" data-share="${esc(p)}" value="${n(s.profit_shares?.[p] ?? 100 / partners().length)}"></label>`).join('')}</div>
        <p class="muted small-note">Samen altijd 100%: verander je het ene percentage, dan past het andere zich vanzelf aan. Wordt automatisch opgeslagen.</p>
      </section>
      ${settingsTax()}
      ${settingsIntegrations()}
      <section class="card"><div class="card-head"><h2>App</h2></div>
        <p>Ingelogd als <b>${esc(store.user?.name)}</b>${store.user?.email ? ` (${esc(store.user.email)})` : ''}.</p>
        <p class="muted">${store.mode === 'demo' ? '⚠︎ Demomodus: de gegevens staan alleen in deze browser. Koppel Supabase via config.js om samen te werken.' : 'Verbonden met de gedeelde LUMAR-database. Wijzigingen zijn direct zichtbaar voor jullie allebei.'}</p>
        <div class="row-actions">
          <button class="btn" data-action="install" ${window.__installPrompt ? '' : 'hidden'} id="installBtn">⤓ App installeren</button>
          <button class="btn" data-action="logout">Uitloggen</button>
          ${store.mode === 'demo' ? '<button class="btn ghost danger-text" data-action="reset-demo">Demogegevens wissen</button>' : ''}
        </div>
      </section>`;
  },
};

function render() {
  if (!store?.user) return;
  const home = route.mod === 'home';
  $('#sidebar').innerHTML = sidebarHtml();
  const main = $('#main');
  const scroll = main.scrollTop;
  main.innerHTML = home ? launcher() : pages[route.page]();
  main.scrollTop = scroll;
  loadPhotos(main);
  const os = $('#odSearch');
  if (os) os.onkeydown = async ev => { if (ev.key !== 'Enter') return; ui.odQuery = os.value.trim(); if (!ui.odQuery) { od.search = null; render(); return; } od.search = { children: [] }; render(); try { od.search = await store.invoke('lumar-integrations', { action: 'od-search', q: ui.odQuery }); } catch (e) { toast(e.message, 'bad'); od.search = null; } render(); };
  const ou = $('#odUpload');
  if (ou) ou.onchange = () => odUpload([...ou.files]).catch(e => toast(e.message, 'bad'));
  const ms = $('#mailSearch');
  if (ms) ms.oninput = () => { ui.mailSearch = ms.value; const pos = ms.selectionStart; render(); const m2 = $('#mailSearch'); m2.focus(); m2.setSelectionRange(pos, pos); };
  const search = $('#stockSearch');
  if (search) search.oninput = () => { ui.stockSearch = search.value; const pos = search.selectionStart; render(); const s2 = $('#stockSearch'); s2.focus(); s2.setSelectionRange(pos, pos); };
}

const routeHash = () => route.mod === 'home' ? 'home' : `${route.mod}/${route.page}`;
function go(target = 'home') {
  let [mod, pg] = String(target || 'home').split('/');
  if (!MODULES[mod]) { const m = moduleOf(mod); if (m) { pg = mod; mod = m; } else { mod = 'home'; pg = null; } }
  if (mod !== 'home' && !MODULES[mod].pages.some(([k]) => k === pg)) pg = MODULES[mod].pages[0][0];
  const changed = mod !== route.mod || pg !== route.page;
  route = { mod, page: pg };
  if (location.hash.slice(1) !== routeHash()) location.hash = routeHash();
  if (changed) $('#main').scrollTop = 0;
  render();
}

function exportCsv() {
  const st = S();
  const files = {
    'lumar-horloges.csv': st.watches.map(w => ({ ...w, winst: w.status === 'sold' ? watchProfit(w, st.settings) : '', btw_marge: marginVat(w, st.settings), history: undefined, photo_path: undefined })),
    'lumar-uitgaven.csv': st.expenses, 'lumar-bank.csv': st.bank_entries,
  };
  for (const [name, rows] of Object.entries(files)) {
    if (!rows.length) continue;
    const clean = rows.map(r => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + toCsv(clean)], { type: 'text/csv;charset=utf-8' }));
    a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  toast('Export gedownload');
}

// ───────────── Apps (startscherm en modules) ─────────────
const ICON = {
  voorraad: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="m3 7.5 9 4.5 9-4.5M12 12v9"/>',
  financien: '<path d="M3.5 20.5h17"/><path d="M6.5 17v-5M11 17V7.5M15.5 17v-7M20 17V4.5"/>',
  marketing: '<path d="M4 10v4h3l7 5V5l-7 5z"/><path d="M17.5 9a4 4 0 0 1 0 6"/>',
  ideeen: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5.6 1.2.6 2.2h6c0-1 0-1.7.6-2.2A6 6 0 0 0 12 3z"/>',
  taken: '<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><path d="m8 12.5 2.8 2.8L16.5 9"/>',
  branding: '<circle cx="12" cy="12" r="9"/><circle cx="7.8" cy="11" r="1.2"/><circle cx="10.5" cy="7.2" r="1.2"/><circle cx="15.2" cy="8" r="1.2"/><path d="M13 21c-1.7 0-2.3-1.2-2.3-2.2 0-1.3 1-2.1 2.3-2.1h2.2A3.8 3.8 0 0 0 19 13"/>',
  documenten: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
  instellingen: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  apps: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
};
const icon = (k, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k] || ''}</svg>`;

const MODULES = {
  voorraad: { name: 'Voorraad', desc: 'Horloges, inkoop en verkoop', color: '#8a6a35', pages: [['stock', 'Voorraad'], ['sales', 'Verkopen']], quick: [['purchase', '＋ Inkoop', 'primary'], ['sale', '＋ Verkoop']] },
  financien: { name: 'Financiën', desc: 'Resultaat, uitgaven, bank en vennoten', color: '#2f6b4f', pages: [['dashboard', 'Overzicht'], ['expenses', 'Uitgaven'], ['bank', 'Bank'], ['reports', 'Rapportages'], ['partners', 'Vennoten'], ['vat', 'Btw-aangifte'], ['tax', 'Belastingen'], ['check', 'Controle']], quick: [['expense', '＋ Uitgave', 'primary'], ['bank-entry', '＋ Mutatie']] },
  marketing: { name: 'Marketing', desc: 'Contentkalender en posts', color: '#9a4a3a', pages: [['mk-overview', 'Overzicht'], ['calendar', 'Kalender'], ['posts', 'Alle posts'], ['tiktok', 'TikTok']], quick: [['post', '＋ Post', 'primary']] },
  ideeen: { name: 'Ideeën', desc: 'Ideeënbord en wishlist', color: '#a2802a', pages: [['ideas', 'Ideeënbord'], ['wishlist', 'Wishlist']], quick: [['idea', '＋ Idee', 'primary'], ['wish', '＋ Wens']] },
  taken: { name: 'Taken', desc: 'Wie doet wat, en wanneer', color: '#3c5f8a', pages: [['tasks', 'Takenbord'], ['hours', 'Uren']], quick: [['task', '＋ Taak', 'primary'], ['hours-add', '＋ Uren']] },
  branding: { name: 'Branding', desc: "Kleuren, logo's en vaste teksten", color: '#6b4f8a', pages: [['brand', 'Merkkit']], quick: [] },
  documenten: { name: 'Documenten', desc: 'Bonnen, mail, documenten en OneDrive', color: '#46696a', pages: [['receipts', 'Bonnen'], ['inbox', 'Mail'], ['docs', 'Documenten'], ['onedrive', 'OneDrive']], quick: [['doc', '＋ Document', 'primary']] },
  instellingen: { name: 'Instellingen', desc: 'Btw, winstverdeling en account', color: '#5f5a50', pages: [['settings', 'Instellingen']], quick: [] },
};
const moduleOf = p => Object.keys(MODULES).find(m => MODULES[m].pages.some(([k]) => k === p));

const meHtml = () => `<div class="me" data-go="instellingen" title="Instellingen"><span class="avatar">${esc(store.user.name[0])}</span><div><b>${esc(store.user.name)}</b><small>${store.mode === 'demo' ? 'Demomodus' : 'Verbonden'}</small></div></div>`;
function sidebarHtml() {
  const home = route.mod === 'home', m = MODULES[route.mod];
  return `<a class="wordmark small" data-go="home">LUMAR<span>Watches</span></a>
    <nav id="nav">
      <a data-go="home" class="app ${home ? 'on' : ''}"><span class="app-ico">${icon('apps')}</span><span>Start</span></a>
      ${Object.entries(MODULES).map(([k, mod]) => {
        const open = route.mod === k;
        return `<a data-go="${k}" class="app ${open ? 'open' : ''}" style="--c:${mod.color}"><span class="app-ico">${icon(k)}</span><span>${mod.name}</span></a>
        ${open ? `<div class="sub">${mod.pages.map(([pk, l]) => `<a data-go="${k}/${pk}" class="${pk === route.page ? 'on' : ''}">${l}</a>`).join('')}</div>` : ''}`;
      }).join('')}
    </nav>
    <div class="sidebar-foot">${meHtml()}</div>`;
}

// Gegevens van Taken, Ideeën, Marketing en Branding
const items = mod => (S().items || []).filter(i => i.module === mod).map(i => ({ ...i.data, id: i.id, created_at: i.created_at, created_by_name: i.created_by_name }));
const itemById = id => { const i = (S().items || []).find(x => x.id === id); return i ? { ...i.data, id: i.id, created_at: i.created_at, created_by_name: i.created_by_name } : null; };
async function saveItem(module, id, data) {
  if (store.itemsMissing) throw new Error('Voer eerst update-modules.sql uit in Supabase (zie README).');
  if (id) { const cur = S().items.find(x => x.id === id); return store.update('items', id, { data: { ...cur.data, ...data }, updated_at: new Date().toISOString() }); }
  return store.insert('items', { module, data });
}
async function deleteItem(id, label) {
  if (!await confirmDialog(`${label} verwijderen?`, 'Dit kan niet ongedaan worden gemaakt.')) return false;
  await store.remove('items', id); toast('Verwijderd'); return true;
}
const itemsBanner = () => store.itemsMissing ? '<div class="banner">Dit onderdeel heeft een kleine database-update nodig: voer <b>update-modules.sql</b> één keer uit in Supabase → SQL Editor.</div>' : '';
const watchOptions = (cur = '') => [['', '—'], ...S().watches.filter(w => w.status !== 'written_off' || w.id === cur).map(w => [w.id, `${wname(w)}${w.reference ? ' · ' + w.reference : ''} · ${STATUS[w.status]}`])];
const addDays = (d, k) => { const x = new Date(d + 'T12:00'); x.setDate(x.getDate() + k); return x.toISOString().slice(0, 10); };
const avatar = name => `<span class="avatar xs" title="${esc(name)}">${esc((name || '?')[0])}</span>`;
const longDate = () => { const t = new Date().toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); return t[0].toUpperCase() + t.slice(1); };

// Taken
const TASK_STATUS = [['todo', 'Te doen'], ['doing', 'Bezig'], ['done', 'Klaar']];
const AREAS = ['Algemeen', 'Inkoop', 'Verkoop', 'Financiën', 'Marketing', 'Branding'];
const PRIO = [['low', 'Laag'], ['normal', 'Normaal'], ['high', 'Hoog']];
const prioRank = t => ({ high: 2, normal: 1, low: 0 })[t.priority] ?? 1;
function dueChip(t) {
  if (!t.due) return '';
  const late = t.status !== 'done' && t.due < today();
  const label = t.due === today() ? 'Vandaag' : t.due === addDays(today(), 1) ? 'Morgen' : fdate(t.due);
  return `<span class="chip ${late ? 'late' : t.due === today() ? 'warn' : ''}">${late ? 'Te laat · ' : ''}${label}</span>`;
}
function taskForm(id, preset = {}) {
  const t = id ? itemById(id) : { status: 'todo', owner: store.user.name, priority: 'normal', area: 'Algemeen', ...preset };
  openForm({
    eyebrow: id ? 'Taak' : 'Nieuwe taak', title: id ? t.title : 'Taak toevoegen',
    fields: [
      { name: 'title', label: 'Taak', required: true, wide: true, value: t.title },
      { name: 'owner', label: 'Wie', type: 'select', options: [...partners(), 'Samen'], value: t.owner },
      { name: 'due', label: 'Deadline', type: 'date', value: t.due },
      { name: 'status', label: 'Status', type: 'select', options: TASK_STATUS, value: t.status },
      { name: 'priority', label: 'Prioriteit', type: 'select', options: PRIO, value: t.priority },
      { name: 'area', label: 'Onderdeel', type: 'select', options: AREAS, value: t.area },
      { name: 'watch_id', label: 'Horloge (optioneel)', type: 'select', options: watchOptions(t.watch_id), value: t.watch_id },
      { name: 'notes', label: 'Toelichting', type: 'textarea', wide: true, value: t.notes },
    ],
    onSubmit: async d => { await saveItem('task', id, { ...d, done_at: d.status === 'done' ? (t.done_at || today()) : null }); toast('Taak opgeslagen'); },
    onDelete: id ? () => deleteItem(id, 'Taak') : null,
  });
}
async function moveTask(id, dir) {
  const t = itemById(id), order = TASK_STATUS.map(x => x[0]);
  const next = order[Math.max(0, Math.min(2, order.indexOf(t.status) + dir))];
  await saveItem('task', id, { status: next, done_at: next === 'done' ? today() : null });
  if (next === 'done') toast('Taak afgerond ✓');
  render();
}

// Ideeën en wishlist
const IDEA_STATUS = [['new', 'Nieuw'], ['working', 'Uitwerken'], ['done', 'Gedaan'], ['rejected', 'Afgewezen']];
const IDEA_CATS = ['Product', 'Marketing', 'Branding', 'Proces', 'Overig'];
const WISH_STATUS = [['searching', 'Zoeken'], ['bought', 'Gekocht'], ['dropped', 'Vervallen']];
function ideaForm(id) {
  const i = id ? itemById(id) : { status: 'new', category: 'Product' };
  openForm({
    eyebrow: id ? 'Idee' : 'Nieuw idee', title: id ? i.title : 'Idee toevoegen',
    fields: [
      { name: 'title', label: 'Idee', required: true, wide: true, value: i.title },
      { name: 'category', label: 'Categorie', type: 'select', options: IDEA_CATS, value: i.category },
      { name: 'status', label: 'Status', type: 'select', options: IDEA_STATUS, value: i.status },
      { name: 'description', label: 'Uitwerking', type: 'textarea', wide: true, value: i.description },
    ],
    onSubmit: async d => { await saveItem('idea', id, d); toast('Idee opgeslagen'); },
    onDelete: id ? () => deleteItem(id, 'Idee') : null,
  });
}
function wishForm(id) {
  const w = id ? itemById(id) : { status: 'searching', priority: 'normal' };
  openForm({
    eyebrow: id ? 'Wishlist' : 'Nieuwe wens', title: id ? `${w.brand} ${w.model}` : 'Horloge op de wishlist',
    fields: [
      { name: 'brand', label: 'Merk', required: true, value: w.brand, list: [...new Set(S().watches.map(x => x.brand))] },
      { name: 'model', label: 'Model', required: true, value: w.model },
      { name: 'reference', label: 'Referentie', value: w.reference },
      { name: 'priority', label: 'Prioriteit', type: 'select', options: PRIO, value: w.priority },
      { name: 'max_price', label: 'Max. inkoopprijs (€)', type: 'money', value: w.max_price },
      { name: 'expected_sale', label: 'Verwachte verkoopprijs (€)', type: 'money', value: w.expected_sale },
      { name: 'link', label: 'Link (advertentie of voorbeeld)', type: 'url', wide: true, value: w.link, placeholder: 'https://' },
      { name: 'status', label: 'Status', type: 'select', options: WISH_STATUS, value: w.status },
      { name: 'notes', label: 'Notities', type: 'textarea', wide: true, value: w.notes },
    ],
    onSubmit: async d => { await saveItem('wish', id, { ...d, max_price: n(d.max_price), expected_sale: n(d.expected_sale) }); toast('Wishlist bijgewerkt'); },
    onDelete: id ? () => deleteItem(id, 'Wens') : null,
  });
}

// Marketing
const POST_STATUS = [['idea', 'Idee'], ['prep', 'In voorbereiding'], ['planned', 'Ingepland'], ['posted', 'Gepost']];
const CHANNELS = ['Instagram', 'TikTok', 'Facebook', 'Vinted', 'Marktplaats', 'Chrono24', 'Website', 'Overig'];
const postLabel = s => (POST_STATUS.find(x => x[0] === s) || [s, s])[1];
function postForm(id, preset = {}) {
  const p = id ? itemById(id) : { status: 'idea', channel: 'Instagram', owner: store.user.name, ...preset };
  openForm({
    eyebrow: id ? 'Post' : 'Nieuwe post', title: id ? p.title : 'Post plannen',
    fields: [
      { name: 'title', label: 'Onderwerp', required: true, wide: true, value: p.title, placeholder: 'bv. Wrist shot Omega Seamaster' },
      { name: 'channel', label: 'Kanaal', type: 'select', options: CHANNELS, value: p.channel },
      { name: 'status', label: 'Status', type: 'select', options: POST_STATUS, value: p.status },
      { name: 'date', label: 'Datum', type: 'date', value: p.date },
      { name: 'time', label: 'Tijd', type: 'time', value: p.time },
      { name: 'owner', label: 'Wie', type: 'select', options: [...partners(), 'Samen'], value: p.owner },
      { name: 'watch_id', label: 'Horloge', type: 'select', options: watchOptions(p.watch_id), value: p.watch_id },
      { name: 'caption', label: 'Tekst / caption', type: 'textarea', wide: true, value: p.caption },
      { name: 'media', label: "Foto's / video", type: 'file', multiple: true, wide: true, accept: 'image/jpeg,image/png,image/webp,video/mp4,video/quicktime',
        hint: (p.media?.length ? `Nu ${p.media.length} ${p.media.length === 1 ? 'bestand' : 'bestanden'}. Kies nieuwe om ze te vervangen. ` : '') + "Tot 10 foto's (carrousel) of 1 video, max. 50 MB per bestand." },
      { name: 'publish_ig', label: 'Nu plaatsen op Instagram', type: 'checkbox', wide: true, show: d => d.channel === 'Instagram' && integ?.instagram?.connected && !p.ig_id },
      { name: 'send_tt', label: 'Als concept naar TikTok sturen (daarna afmaken en plaatsen in de TikTok-app)', type: 'checkbox', wide: true, value: preset.send_tt, show: d => d.channel === 'TikTok' && integ?.tiktok?.connected },
      { type: 'html', name: 'linked', wide: true, html: p.ig_id || p.tt_id ? `<div class="banner">${p.ig_id ? 'Geplaatst op Instagram' : 'Gekoppeld aan TikTok'}${p.url ? ` · <a class="link" href="${esc(p.url)}" target="_blank" rel="noopener">bekijk post ↗</a>` : ''}. Cijfers worden automatisch bijgewerkt onder Statistieken.</div>` : '' },
      { type: 'section', label: 'Resultaat (na plaatsen)', name: 'stats-head', show: d => d.status === 'posted' },
      { name: 'url', label: 'Link naar de post', type: 'url', wide: true, value: p.url, placeholder: 'https://', show: d => d.status === 'posted' },
      { name: 'views', label: 'Weergaven', type: 'number', value: p.views, show: d => d.status === 'posted' },
      { name: 'likes', label: 'Likes', type: 'number', value: p.likes, show: d => d.status === 'posted' },
      { name: 'comments', label: 'Reacties', type: 'number', value: p.comments, show: d => d.status === 'posted' },
      { name: 'saves', label: 'Bewaard / gedeeld', type: 'number', value: p.saves, show: d => d.status === 'posted' },
    ],
    onSubmit: async d => {
      const data = { ...d }; delete data.media; delete data.publish_ig; delete data.send_tt;
      const files = d.media || [];
      if (files.length) {
        const vids = files.filter(f => f.type.startsWith('video/'));
        if (files.length > 10) { toast("Maximaal 10 bestanden", 'bad'); return false; }
        if (vids.length && files.length > 1 && d.channel === 'TikTok') { toast('Voor TikTok: kies één video', 'bad'); return false; }
        if (files.some(f => f.size > 50 * 1024 * 1024)) { toast('Een bestand is groter dan 50 MB', 'bad'); return false; }
        toast('Bestanden uploaden…');
        data.media = [];
        for (const f of files) data.media.push(f.type.startsWith('image/') ? await store.upload(await compressImage(f, 1440), 'posts') : await store.upload(f, 'posts'));
      }
      const media = data.media || p.media || [];
      const row = await saveItem('post', id, data); const pid = id || row.id;
      if (d.publish_ig) {
        if (!media.length) { toast('Post opgeslagen, maar zonder foto of video kan hij niet op Instagram', 'bad'); return; }
        toast('Plaatsen op Instagram… (bij video kan dit een minuut duren)');
        let r = await store.invoke('lumar-social', { action: 'ig-publish', paths: media, caption: d.caption || '' });
        for (let i = 0; r.pending && r.creation_id && i < 6; i++) { await new Promise(res => setTimeout(res, 10000)); r = await store.invoke('lumar-social', { action: 'ig-finish', creation_id: r.creation_id }); }
        if (r.pending) { toast('Instagram is de video nog aan het verwerken. Probeer het zo nog een keer.', 'bad'); return; }
        await saveItem('post', pid, { ig_id: r.id, url: r.permalink || data.url || '', status: 'posted', date: d.date || today() });
        toast('Geplaatst op Instagram');
      } else if (d.send_tt) {
        const vid = media.find(m => /\.(mp4|mov|m4v)$/i.test(m));
        if (!vid) { toast('Post opgeslagen, maar voor TikTok is een video nodig', 'bad'); return; }
        toast('Video naar TikTok sturen…');
        const r = await store.invoke('lumar-social', { action: 'tt-draft', path: vid });
        await saveItem('post', pid, { tt_publish_id: r.publish_id, status: d.status === 'posted' ? 'posted' : 'planned' });
        toast('Staat klaar in TikTok: open de app, kijk bij je meldingen/inbox en plaats hem daar');
      } else toast('Post opgeslagen');
    },
    onDelete: id ? () => deleteItem(id, 'Post') : null,
  });
}

// Branding
const BRAND_KINDS = { color: 'Kleur', font: 'Lettertype', asset: 'Bestand', text: 'Tekst' };
function brandForm(kind, id) {
  const b = id ? itemById(id) : { kind, hex: '#b08d4f' };
  const fields = {
    color: [{ name: 'name', label: 'Naam', required: true, value: b.name, placeholder: 'bv. LUMAR goud' }, { name: 'hex', label: 'Kleur', type: 'color', value: b.hex }, { name: 'usage', label: 'Gebruik', wide: true, value: b.usage, placeholder: 'bv. accenten, knoppen' }],
    font: [{ name: 'name', label: 'Lettertype', required: true, value: b.name }, { name: 'usage', label: 'Gebruik', value: b.usage, placeholder: 'bv. koppen' }, { name: 'link', label: 'Link', type: 'url', wide: true, value: b.link }, { name: 'notes', label: 'Notities', type: 'textarea', wide: true, value: b.notes }],
    asset: [{ name: 'name', label: 'Naam', required: true, value: b.name, placeholder: 'bv. Logo zwart' }, { name: 'file', label: id ? 'Nieuw bestand (optioneel)' : 'Bestand', type: 'file', accept: 'image/*,application/pdf' }, { name: 'notes', label: 'Notities', type: 'textarea', wide: true, value: b.notes }],
    text: [{ name: 'name', label: 'Titel', required: true, value: b.name, placeholder: 'bv. Instagram-bio' }, { name: 'text', label: 'Tekst', type: 'textarea', wide: true, required: true, value: b.text }],
  }[kind];
  openForm({
    eyebrow: 'Merkkit', title: id ? b.name : `${BRAND_KINDS[kind]} toevoegen`, fields,
    onSubmit: async d => {
      const data = { ...d, kind }; delete data.file;
      if (kind === 'asset') {
        if (!d.file && !id) { toast('Kies een bestand', 'bad'); return false; }
        if (d.file) { data.path = await store.upload(d.file, 'brand'); data.mime = d.file.type; data.filename = d.file.name; }
      }
      await saveItem('brand', id, data); toast('Opgeslagen');
    },
    onDelete: id ? () => deleteItem(id, BRAND_KINDS[kind]) : null,
  });
}

const tabsHtml = (key, opts) => `<div class="tabs">${opts.map(([v, l, c]) => `<button class="${ui[key] === v ? 'on' : ''}" data-action="set-ui" data-key="${key}" data-value="${v}">${l}${c !== undefined ? ` <small>${c}</small>` : ''}</button>`).join('')}</div>`;

function launcher() {
  const st = S(), y = periodRange('year'), c = calc(st, y), all = calc(st), me = store.user.name;
  const tasks = items('task'), open = tasks.filter(t => t.status !== 'done');
  const mine = open.filter(t => t.owner === me || t.owner === 'Samen').sort((a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999')) || prioRank(b) - prioRank(a));
  const late = open.filter(t => t.due && t.due < today()).length;
  const week = addDays(today(), 7);
  const upcoming = items('post').filter(p => p.status !== 'posted' && p.date && p.date >= today() && p.date <= week).sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  const ideas = items('idea').filter(i => ['new', 'working'].includes(i.status)), wishes = items('wish').filter(w => w.status === 'searching');
  const brand = items('brand'), acts = actionItems(st);
  const stat = {
    voorraad: `${all.stockCount} actief · ${st.watches.filter(w => w.status === 'incoming').length} onderweg`,
    financien: `Resultaat ${y.label}: ${euro(c.result)}`,
    marketing: `${upcoming.length} ${upcoming.length === 1 ? 'post' : 'posts'} deze week`,
    ideeen: `${ideas.length} ideeën · ${wishes.length} op wishlist`,
    taken: `${open.length} open · ${mine.length} voor jou`,
    branding: (c => `${brand.filter(b => b.kind === 'color').length} kleuren · ${c} ${c === 1 ? 'bestand' : 'bestanden'}`)(brand.filter(b => b.kind === 'asset').length),
    documenten: `${items('doc').length} ${items('doc').length === 1 ? 'document' : 'documenten'} · ${missingReceipts(st).length} ${missingReceipts(st).length === 1 ? 'bon ontbreekt' : 'bonnen ontbreken'}`,
    instellingen: `Ingelogd als ${me}`,
  };
  const rc = reconcile(st);
  const badge = { financien: rc.ok ? pendingPayments(st).length : '!', taken: late, documenten: missingReceipts(st).length };
  const h = new Date().getHours(), greet = h < 6 ? 'Goedenacht' : h < 12 ? 'Goedemorgen' : h < 18 ? 'Goedemiddag' : 'Goedenavond';
  return `<div class="launch">
    <div class="launch-hello"><h1>${greet}, ${esc(me)}</h1><p class="muted">${longDate()}</p></div>
    ${itemsBanner()}
    <div class="tiles">${Object.entries(MODULES).map(([k, m]) => `<a class="tile" data-go="${k}" style="--c:${m.color}">
      <span class="tile-ico">${icon(k)}</span>${badge[k] ? `<span class="tile-badge ${k === 'taken' || badge[k] === '!' ? 'bad' : ''}">${badge[k]}</span>` : ''}
      <h2>${m.name}</h2><p>${m.desc}</p><small>${stat[k]}</small></a>`).join('')}</div>
    <section class="cols">
      <div class="card"><div class="card-head"><h2>Jouw taken</h2><a data-go="taken">Takenbord ›</a></div>
        ${mine.length ? `<ul class="list">${mine.slice(0, 6).map(t => `<li data-action="edit-task" data-id="${t.id}"><div><b>${esc(t.title)}</b><small>${esc(t.area || '')}${t.owner === 'Samen' ? ' · samen' : ''}</small></div>${dueChip(t)}</li>`).join('')}</ul>` : empty('Geen open taken voor jou.', '<button class="btn small" data-action="task">＋ Taak</button>')}</div>
      <div class="card"><div class="card-head"><h2>Posts deze week</h2><a data-go="marketing/calendar">Kalender ›</a></div>
        ${upcoming.length ? `<ul class="list">${upcoming.slice(0, 6).map(p => `<li data-action="edit-post" data-id="${p.id}"><div><b>${esc(p.title)}</b><small>${esc(p.channel)} · ${fdate(p.date)}${p.time ? ' ' + p.time : ''}</small></div><span class="chip ps-${p.status}">${postLabel(p.status)}</span></li>`).join('')}</ul>` : empty('Niets gepland deze week.', '<button class="btn small" data-action="post">＋ Post</button>')}</div>
      <div class="card"><div class="card-head"><h2>Actie nodig</h2><a data-go="financien/bank">Bank ›</a></div>
        ${acts.length ? `<ul class="list">${acts.slice(0, 6).map(a => `<li ${a.watchId ? `data-action="watch" data-id="${a.watchId}"` : a.kind === 'receipt' ? `data-action="receipt-add" data-table="${a.table}" data-id="${a.recordId}"` : a.kind === 'vat' ? 'data-go="financien/vat"' : 'data-go="financien/bank"'}><div><b>${esc(a.description)}</b><small>${a.reason}</small></div>${a.amount !== undefined ? `<span class="${a.direction === 'in' ? 'good' : 'bad'}">${a.direction === 'in' ? '+' : '−'}${euro(a.amount)}</span>` : '<span class="chev">›</span>'}</li>`).join('')}</ul>` : empty('Alles is bijgewerkt.')}</div>
    </section></div>`;
}

Object.assign(pages, {
  tasks() {
    const me = store.user.name, f = ui.taskOwner;
    let list = items('task');
    if (f === 'me') list = list.filter(t => t.owner === me || t.owner === 'Samen');
    else if (f !== 'all') list = list.filter(t => t.owner === f);
    const col = s => list.filter(t => t.status === s).sort((a, b) => s === 'done' ? String(b.done_at).localeCompare(String(a.done_at)) : prioRank(b) - prioRank(a) || String(a.due || '9999').localeCompare(String(b.due || '9999')));
    const card = t => `<article class="task prio-${t.priority || 'normal'}" data-action="edit-task" data-id="${t.id}">
      <div class="task-top"><span class="chip">${esc(t.area || 'Algemeen')}</span>${dueChip(t)}</div>
      <b>${esc(t.title)}</b>${t.notes ? `<p>${esc(t.notes)}</p>` : ''}
      ${t.watch_id && watchById(t.watch_id) ? `<small class="muted">⌚ ${esc(wname(watchById(t.watch_id)))}</small>` : ''}
      <div class="task-foot">${avatar(t.owner)}<small>${esc(t.owner || '')}</small><span class="move">${t.status !== 'todo' ? `<button class="x" data-action="task-move" data-id="${t.id}" data-dir="-1" title="Terug">‹</button>` : ''}${t.status !== 'done' ? `<button class="x" data-action="task-move" data-id="${t.id}" data-dir="1" title="Volgende stap">›</button>` : ''}</span></div></article>`;
    return head('Takenbord', 'Klik op een taak om hem te bewerken, gebruik ‹ › om hem te verplaatsen.', '<button class="btn primary" data-action="task">＋ Taak</button>') + itemsBanner() + `
      <div class="toolbar">${tabsHtml('taskOwner', [['all', 'Iedereen'], ['me', 'Mijn taken'], ...partners().map(p => [p, p]), ['Samen', 'Samen']])}</div>
      <div class="board">${TASK_STATUS.map(([s, l]) => { const c = col(s); return `<section class="lane"><header><h2>${l}</h2><span class="badge">${c.length}</span></header>${c.slice(0, s === 'done' ? 15 : 200).map(card).join('') || '<p class="muted lane-empty">Leeg</p>'}${s === 'todo' ? '<button class="lane-add" data-action="task">＋ Taak toevoegen</button>' : ''}</section>`; }).join('')}</div>`;
  },

  ideas() {
    const f = ui.ideaFilter, all = items('idea');
    const sets = { open: ['new', 'working'], done: ['done'], rejected: ['rejected'], all: IDEA_STATUS.map(x => x[0]) };
    const list = all.filter(i => sets[f].includes(i.status)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const cnt = k => all.filter(i => sets[k].includes(i.status)).length;
    return head('Ideeënbord', 'Alles wat jullie te binnen schiet: producten, marketing, branding, processen.', '<button class="btn primary" data-action="idea">＋ Idee</button>') + itemsBanner() + `
      <div class="toolbar">${tabsHtml('ideaFilter', [['open', 'Open', cnt('open')], ['done', 'Gedaan', cnt('done')], ['rejected', 'Afgewezen', cnt('rejected')], ['all', 'Alles', cnt('all')]])}</div>
      ${list.length ? `<div class="note-grid">${list.map(i => `<article class="note" data-action="edit-idea" data-id="${i.id}">
        <div class="task-top"><span class="chip">${esc(i.category)}</span><span class="chip is-${i.status}">${(IDEA_STATUS.find(x => x[0] === i.status) || [])[1] || ''}</span></div>
        <h3>${esc(i.title)}</h3>${i.description ? `<p>${esc(i.description)}</p>` : ''}
        <div class="task-foot">${avatar(i.created_by_name)}<small>${esc(i.created_by_name || '')} · ${fdate(String(i.created_at).slice(0, 10))}</small><span class="move"><button class="btn small" data-action="idea-task" data-id="${i.id}">→ Taak</button></span></div></article>`).join('')}</div>` : empty('Nog geen ideeën hier.', '<button class="btn primary" data-action="idea">＋ Eerste idee</button>')}`;
  },

  wishlist() {
    const all = items('wish'), f = ui.wishFilter;
    const list = all.filter(w => f === 'all' || w.status === f).sort((a, b) => prioRank(b) - prioRank(a) || String(b.created_at).localeCompare(String(a.created_at)));
    return head('Wishlist', 'Horloges waar jullie op jagen, met de prijs waarvoor het interessant is.', '<button class="btn primary" data-action="wish">＋ Wens</button>') + itemsBanner() + `
      <div class="toolbar">${tabsHtml('wishFilter', [['searching', 'Zoeken', all.filter(w => w.status === 'searching').length], ['bought', 'Gekocht', all.filter(w => w.status === 'bought').length], ['dropped', 'Vervallen'], ['all', 'Alles', all.length]])}</div>
      ${list.length ? `<div class="card flush"><table class="table"><thead><tr><th>Horloge</th><th>Prioriteit</th><th class="r">Max. inkoop</th><th class="r">Verwacht verkoop</th><th class="r">Potentiële winst</th><th>Link</th><th></th></tr></thead><tbody>
        ${list.map(w => { const pot = n(w.expected_sale) - n(w.max_price); return `<tr data-action="edit-wish" data-id="${w.id}"><td><b>${esc(w.brand)} ${esc(w.model)}</b>${w.reference ? `<small class="muted"> · ${esc(w.reference)}</small>` : ''}${w.notes ? `<br><small class="muted">${esc(w.notes)}</small>` : ''}</td>
          <td><span class="chip pr-${w.priority}">${(PRIO.find(x => x[0] === w.priority) || [])[1] || ''}</span></td><td class="r">${w.max_price ? euro(w.max_price) : '—'}</td><td class="r">${w.expected_sale ? euro(w.expected_sale) : '—'}</td>
          <td class="r">${w.max_price && w.expected_sale ? signed(pot) : '—'}</td><td>${w.link ? `<a href="${esc(w.link)}" target="_blank" rel="noopener" class="link" onclick="event.stopPropagation()">Openen ↗</a>` : ''}</td>
          <td class="r">${w.status === 'searching' ? `<button class="btn small" data-action="wish-bought" data-id="${w.id}">Gekocht → inkoop</button>` : `<span class="chip">${(WISH_STATUS.find(x => x[0] === w.status) || [])[1]}</span>`}</td></tr>`; }).join('')}
      </tbody></table></div>` : empty('De wishlist is leeg.', '<button class="btn primary" data-action="wish">＋ Wens toevoegen</button>')}`;
  },

  'mk-overview'() {
    const st = S(), posts = items('post'), month = today().slice(0, 7);
    const postedMonth = posts.filter(p => p.status === 'posted' && String(p.date).startsWith(month)).length;
    const planned = posts.filter(p => p.status !== 'posted' && p.date && p.date >= today());
    const spend = st.expenses.filter(e => e.category === 'Marketing' && String(e.date).startsWith(month)).reduce((a, e) => a + n(e.amount), 0);
    const withPost = new Set(posts.map(p => p.watch_id).filter(Boolean));
    const noPost = st.watches.filter(w => w.status === 'in_stock' && !withPost.has(w.id));
    const next = [...planned].sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || ''))).slice(0, 8);
    const ideasNoDate = posts.filter(p => p.status !== 'posted' && !p.date);
    return head('Marketing', 'Wat er gepland staat en welke horloges nog aandacht nodig hebben.', '<button class="btn primary" data-action="post">＋ Post</button>') + itemsBanner() + `
      <section class="stats">${stat('Gepost deze maand', postedMonth)}${stat('Gepland', planned.length, `${ideasNoDate.length} ideeën zonder datum`)}${stat('Marketingkosten deze maand', euro(spend), 'uit Financiën → Uitgaven', 'data-go="financien/expenses"')}${stat('Op voorraad zonder post', noPost.length, 'kansen voor content')}</section>
      <section class="cols">
        <div class="card"><div class="card-head"><h2>Komende posts</h2><a data-go="marketing/calendar">Kalender ›</a></div>
          ${next.length ? `<ul class="list">${next.map(p => `<li data-action="edit-post" data-id="${p.id}"><div><b>${esc(p.title)}</b><small>${esc(p.channel)} · ${fdate(p.date)}${p.time ? ' ' + p.time : ''} · ${esc(p.owner || '')}</small></div><span class="chip ps-${p.status}">${postLabel(p.status)}</span></li>`).join('')}</ul>` : empty('Nog niets gepland.', '<button class="btn small" data-action="post">＋ Post plannen</button>')}</div>
        <div class="card"><div class="card-head"><h2>Horloges zonder post</h2><a data-go="voorraad/stock">Voorraad ›</a></div>
          ${noPost.length ? `<ul class="list">${noPost.slice(0, 8).map(w => `<li data-action="watch" data-id="${w.id}"><div class="photo sm" data-photo="${esc(w.photo_path || '')}"><span>${esc(w.brand[0])}</span></div><div><b>${esc(wname(w))}</b><small>${daysBetween(w.purchase_date || today(), today())} dagen op voorraad</small></div><button class="btn small" data-action="post" data-watch="${w.id}">＋ Post</button></li>`).join('')}</ul>` : empty('Elk horloge op voorraad heeft al een post.')}</div>
      </section>${postResultsHtml()}`;
  },

  calendar() {
    const ym = ui.calMonth || today().slice(0, 7), [y, m] = ym.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1)), startDow = (first.getUTCDay() + 6) % 7;
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const posts = items('post').filter(p => String(p.date).startsWith(ym));
    const cells = [];
    for (let i = 0; i < startDow; i++) cells.push('<div class="cal-cell out"></div>');
    for (let d = 1; d <= days; d++) {
      const date = `${ym}-${String(d).padStart(2, '0')}`;
      const dp = posts.filter(p => p.date === date).sort((a, b) => String(a.time).localeCompare(String(b.time)));
      cells.push(`<div class="cal-cell ${date === today() ? 'today' : ''}" data-action="cal-day" data-date="${date}"><span class="cal-day">${d}</span>${dp.map(p => `<button class="cal-post ps-${p.status}" data-action="edit-post" data-id="${p.id}" title="${esc(p.title)}">${p.time ? p.time + ' ' : ''}${esc(p.title)}</button>`).join('')}</div>`);
    }
    while (cells.length % 7) cells.push('<div class="cal-cell out"></div>');
    const label = first.toLocaleDateString('nl-NL', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    return head('Contentkalender', 'Klik op een dag om een post te plannen.', `<button class="btn" data-action="cal-move" data-dir="-1">‹</button><button class="btn" data-action="cal-move" data-dir="0">Vandaag</button><button class="btn" data-action="cal-move" data-dir="1">›</button>`) + itemsBanner() + `
      <div class="card cal"><div class="card-head"><h2 class="cap">${label}</h2><div class="legend">${POST_STATUS.map(([k, l]) => `<span class="chip ps-${k}">${l}</span>`).join('')}</div></div>
      <div class="cal-grid">${['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'].map(d => `<div class="cal-dow">${d}</div>`).join('')}${cells.join('')}</div></div>`;
  },

  posts() {
    const all = items('post'), f = ui.postFilter;
    const list = all.filter(p => f === 'all' || (f === 'open' ? p.status !== 'posted' : p.status === f)).sort((a, b) => String(b.date || '9999').localeCompare(String(a.date || '9999')));
    return head('Alle posts', `${all.length} posts in totaal`, '<button class="btn primary" data-action="post">＋ Post</button>') + itemsBanner() + `
      <div class="toolbar">${tabsHtml('postFilter', [['open', 'Nog te doen', all.filter(p => p.status !== 'posted').length], ['posted', 'Gepost', all.filter(p => p.status === 'posted').length], ['all', 'Alles', all.length]])}</div>
      ${list.length ? `<div class="card flush"><table class="table"><thead><tr><th>Datum</th><th>Onderwerp</th><th>Kanaal</th><th>Horloge</th><th>Wie</th><th>Status</th></tr></thead><tbody>
        ${list.map(p => `<tr data-action="edit-post" data-id="${p.id}"><td>${p.date ? fdate(p.date) : '<span class="muted">geen datum</span>'}${p.time ? ' ' + p.time : ''}</td><td><b>${esc(p.title)}</b></td><td>${esc(p.channel)}</td><td>${p.watch_id && watchById(p.watch_id) ? esc(wname(watchById(p.watch_id))) : ''}</td><td>${esc(p.owner || '')}</td><td><span class="chip ps-${p.status}">${postLabel(p.status)}</span></td></tr>`).join('')}
      </tbody></table></div>` : empty('Geen posts in deze lijst.')}`;
  },

  brand() {
    const b = items('brand'), of = k => b.filter(x => x.kind === k);
    const section = (kind, title, body) => `<section class="card"><div class="card-head"><h2>${title}</h2><button class="btn small" data-action="brand-add" data-kind="${kind}">＋ ${BRAND_KINDS[kind]}</button></div>${body}</section>`;
    return head('Merkkit', 'De huisstijl van LUMAR op één plek, zodat alles er hetzelfde uitziet.') + itemsBanner() +
      section('color', 'Kleuren', of('color').length ? `<div class="swatches">${of('color').map(c => `<div class="swatch" data-action="edit-brand" data-id="${c.id}"><span style="background:${esc(c.hex)}"></span><b>${esc(c.name)}</b><small>${esc(c.hex)}${c.usage ? ' · ' + esc(c.usage) : ''}</small><button class="link" data-action="copy" data-id="${c.id}">Kopieer</button></div>`).join('')}</div>` : empty('Nog geen kleuren.')) +
      section('font', 'Lettertypes', of('font').length ? `<ul class="list">${of('font').map(f => `<li data-action="edit-brand" data-id="${f.id}"><div><b style="font-family:'${esc(f.name)}', var(--serif);font-size:18px">${esc(f.name)}</b><small>${esc(f.usage || '')}${f.notes ? ' · ' + esc(f.notes) : ''}</small></div>${f.link ? `<a class="link" href="${esc(f.link)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Link ↗</a>` : ''}</li>`).join('')}</ul>` : empty('Nog geen lettertypes.')) +
      section('asset', "Logo's en bestanden", of('asset').length ? `<div class="assets">${of('asset').map(a => `<div class="asset" data-action="edit-brand" data-id="${a.id}"><div class="photo contain" ${String(a.mime).startsWith('image/') ? `data-photo="${esc(a.path)}"` : ''}><span>${String(a.mime).includes('pdf') ? 'PDF' : '◇'}</span></div><b>${esc(a.name)}</b><button class="link" data-action="file" data-path="${esc(a.path)}">Openen ↗</button></div>`).join('')}</div>` : empty("Nog geen logo's of bestanden.")) +
      section('text', 'Vaste teksten', of('text').length ? `<div class="texts">${of('text').map(t => `<div class="text-card" data-action="edit-brand" data-id="${t.id}"><div class="card-head"><b>${esc(t.name)}</b><button class="link" data-action="copy" data-id="${t.id}">Kopieer</button></div><p>${esc(t.text)}</p></div>`).join('')}</div>` : empty('Bijvoorbeeld je Instagram-bio of een standaard advertentietekst.'));
  },
});

// Documenten
const DOC_CATS = ['KvK & bedrijf', 'Contract', 'Garantiebewijs', 'Certificaat', 'Factuur', 'Belasting', 'Overig'];
function docForm(id, preset = {}) {
  const d0 = id ? itemById(id) : { category: 'Overig', date: today(), ...preset };
  openForm({
    eyebrow: id ? 'Document' : 'Nieuw document', title: id ? d0.name : 'Document toevoegen',
    fields: [
      { name: 'name', label: 'Naam', required: true, wide: true, value: d0.name, placeholder: 'bv. KvK-uittreksel of garantiebewijs Omega' },
      { name: 'category', label: 'Soort', type: 'select', options: DOC_CATS, value: d0.category },
      { name: 'date', label: 'Datum', type: 'date', value: d0.date },
      { name: 'valid_until', label: 'Geldig tot (optioneel)', type: 'date', value: d0.valid_until },
      { name: 'watch_id', label: 'Hoort bij horloge (optioneel)', type: 'select', options: watchOptions(d0.watch_id), value: d0.watch_id },
      { name: 'file', label: id ? 'Nieuw bestand (optioneel)' : 'Bestand', type: 'file', accept: 'image/*,application/pdf,.docx,.xlsx' },
      { name: 'notes', label: 'Notities', type: 'textarea', wide: true, value: d0.notes },
    ],
    onSubmit: async d => {
      if (!d.file && !id) { toast('Kies een bestand', 'bad'); return false; }
      const data = { ...d }; delete data.file;
      if (d.file) { data.path = await store.upload(d.file, 'documents'); data.mime = d.file.type; data.filename = d.file.name; }
      await saveItem('doc', id, data); toast('Document opgeslagen');
    },
    onDelete: id ? () => deleteItem(id, 'Document') : null,
  });
}

Object.assign(pages, {
  check() {
    const st = S(), r = reconcile(st);
    const line = (l, v, cls = '') => `<div class="statement-row ${cls}"><span>${l}</span><b>${v}</b></div>`;
    return head('Controle', 'Rekent na of alle boekingen op elkaar aansluiten. Deze controle draait automatisch bij elke wijziging.') + `
      <div class="check-banner big ${r.ok ? 'ok' : 'bad'}">${r.ok ? '✓ Alles klopt. De boekhouding sluit tot op de cent.' : `⚠︎ ${r.issues.length} ${r.issues.length === 1 ? 'punt' : 'punten'} om na te kijken. Zie de lijst hieronder.`}</div>
      <section class="cols">
        <div class="card"><div class="card-head"><h2>Wat LUMAR heeft</h2></div><div class="statement">
          ${line('Banksaldo', euro(r.bank))}${line('Voorraad tegen kostprijs', euro(r.stock))}${line('Nog te ontvangen', euro(r.receivable))}
          ${line('Nog te betalen', `− ${euro(r.payable)}`)}${line('Btw nog af te dragen', `− ${euro(r.vat)}`)}${line('Totaal', euro(r.assets), 'total')}
        </div></div>
        <div class="card"><div class="card-head"><h2>Waar dat vandaan komt</h2></div><div class="statement">
          ${line('Stortingen vennoten', euro(r.deposits))}${line('Privé voorgeschoten door vennoten', euro(r.privatePaid))}${line('Opnames vennoten', `− ${euro(r.withdrawals)}`)}
          ${line('Resultaat tot nu toe', signed(r.result))}${line('Totaal', euro(r.equity), 'total')}
        </div></div>
      </section>
      <section class="card"><div class="card-head"><h2>Verschil</h2><b class="${r.diff ? 'bad' : 'good'}">${euro(r.diff)}</b></div>
        <p class="muted">Beide totalen moeten precies gelijk zijn. Elke euro die het bedrijf heeft, komt van een storting, iets wat een vennoot heeft voorgeschoten of van de winst. Daarnaast wordt elke inkoop, verkoop, retour en uitgave gecontroleerd op de juiste bankmutatie.</p>
        ${r.issues.length ? `<table class="table compact"><thead><tr><th>Onderdeel</th><th>Bevinding</th></tr></thead><tbody>${r.issues.map(i => `<tr><td><span class="chip late">${esc(i.area)}</span></td><td>${esc(i.text)}</td></tr>`).join('')}</tbody></table>` : ''}
      </section>`;
  },

  docs() {
    const all = items('doc'), f = ui.docFilter || 'all';
    const list = all.filter(d => f === 'all' || d.category === f).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const soon = addDays(today(), 30);
    const validity = d => !d.valid_until ? '' : d.valid_until < today() ? `<span class="chip late">Verlopen ${fdate(d.valid_until)}</span>` : d.valid_until <= soon ? `<span class="chip warn">Tot ${fdate(d.valid_until)}</span>` : `<span class="chip">Tot ${fdate(d.valid_until)}</span>`;
    return head('Documenten', 'KvK, contracten, garantiebewijzen, certificaten en andere belangrijke papieren.', '<button class="btn primary" data-action="doc">＋ Document</button>') + itemsBanner() + `
      <div class="toolbar">${tabsHtml('docFilter', [['all', 'Alles', all.length], ...DOC_CATS.filter(c => all.some(d => d.category === c)).map(c => [c, c, all.filter(d => d.category === c).length])])}</div>
      ${list.length ? `<div class="card flush"><table class="table"><thead><tr><th>Naam</th><th>Soort</th><th>Datum</th><th>Horloge</th><th>Geldigheid</th><th></th></tr></thead><tbody>
        ${list.map(d => `<tr data-action="edit-doc" data-id="${d.id}"><td><b>${esc(d.name)}</b>${d.notes ? `<br><small class="muted">${esc(d.notes)}</small>` : ''}</td><td>${esc(d.category)}</td><td>${fdate(d.date)}</td><td>${d.watch_id && watchById(d.watch_id) ? esc(wname(watchById(d.watch_id))) : ''}</td><td>${validity(d)}</td><td class="r"><button class="link" data-action="file" data-path="${esc(d.path)}">Openen ↗</button></td></tr>`).join('')}
      </tbody></table></div>` : empty('Nog geen documenten.', '<button class="btn primary" data-action="doc">＋ Eerste document</button>')}`;
  },

  receipts() {
    const all = receiptRecords(S()), f = ui.receiptFilter || 'missing';
    const missing = all.filter(r => !r.path), list = f === 'missing' ? missing : all;
    return head('Bonnen', 'Alle inkopen en uitgaven met hun bon of factuur. Bewaar deze minimaal 7 jaar voor de Belastingdienst.') + `
      <section class="stats">${stat('Boekingen', all.length)}${stat('Met bon', all.length - missing.length)}${stat('Bon ontbreekt', `<span class="${missing.length ? 'bad' : 'good'}">${missing.length}</span>`)}</section>
      <div class="toolbar">${tabsHtml('receiptFilter', [['missing', 'Bon ontbreekt', missing.length], ['all', 'Alles', all.length]])}</div>
      ${list.length ? `<div class="card flush"><table class="table"><thead><tr><th>Datum</th><th>Omschrijving</th><th>Soort</th><th class="r">Bedrag</th><th>Bon</th></tr></thead><tbody>
        ${list.map(r => `<tr><td>${fdate(r.date)}</td><td><b>${esc(r.description)}</b></td><td>${esc(r.kind)}</td><td class="r">${euro(r.amount)}</td><td>${r.path ? `<button class="link" data-action="file" data-path="${esc(r.path)}">📎 Bekijk</button>` : `<button class="btn small" data-action="receipt-add" data-table="${r.table}" data-id="${r.id}">＋ Bon</button>`}</td></tr>`).join('')}
      </tbody></table></div>` : empty(f === 'missing' ? 'Van alle boekingen is een bon aanwezig.' : 'Nog geen boekingen.')}`;
  },
});

// ───────────── Belastingen, uren, statistieken, koppelingen ─────────────
const curQuarter = () => ({ y: +today().slice(0, 4), q: quarterOf(today()) });
const progress = (val, max) => `<div class="bar"><span style="width:${Math.min(100, max ? val / max * 100 : 0)}%"></span></div>`;

const HOUR_ACTIVITIES = ['Inkoop & zoeken', 'Verkoop & klanten', 'Marketing & content', 'Administratie', 'Service & onderhoud', 'Overig'];
function hoursForm(id, preset = {}) {
  const h = id ? itemById(id) : { date: today(), person: store.user.name, activity: 'Inkoop & zoeken', ...preset };
  openForm({
    eyebrow: 'Urenregistratie', title: id ? 'Uren bewerken' : 'Uren schrijven',
    intro: 'Voor de zelfstandigenaftrek moet ieder van jullie minimaal 1.225 uur per jaar aan LUMAR besteden. Schrijf je uren daarom bij, ook voor zoeken, fotograferen en administratie.',
    fields: [
      { name: 'date', label: 'Datum', type: 'date', required: true, value: h.date },
      { name: 'person', label: 'Wie', type: 'select', options: partners(), value: h.person },
      { name: 'hours', label: 'Uren', type: 'number', required: true, value: h.hours, placeholder: 'bv. 2,5' },
      { name: 'activity', label: 'Soort werk', type: 'select', options: HOUR_ACTIVITIES, value: h.activity },
      { name: 'note', label: 'Omschrijving', wide: true, value: h.note, placeholder: 'bv. Vinted afgezocht naar Seiko 5' },
    ],
    onSubmit: async d => {
      const hrs = round2(String(d.hours).replace(',', '.'));
      if (hrs <= 0 || hrs > 24) { toast('Vul een aantal uren tussen 0 en 24 in', 'bad'); return false; }
      await saveItem('hours', id, { ...d, hours: hrs }); toast('Uren opgeslagen');
    },
    onDelete: id ? () => deleteItem(id, 'Urenregel') : null,
  });
}

function settingsTax() {
  const s = S().settings;
  return `<section class="card"><div class="card-head"><h2>Belastingen</h2></div>
    <div class="grid"><label class="field"><span>Reserve inkomstenbelasting (% van de belastbare winst)</span><input type="number" min="0" max="60" data-setting-num="tax_reserve_pct" value="${n(s.tax_reserve_pct ?? 35)}"><small>Hoeveel je opzij zet voor de inkomstenbelasting. Bespreek dit percentage met je boekhouder.</small></label></div>
    <p class="muted">Startersaftrek (eerste jaren, alleen met urencriterium):</p>
    <div class="row-actions">${partners().map(p => `<label class="check"><input type="checkbox" data-starter="${esc(p)}" ${s.starters?.[p] ? 'checked' : ''}> ${esc(p)} heeft recht op startersaftrek</label>`).join('')}</div>
  </section>`;
}

let team = null; // leden met e-mail en laatste login
async function loadTeam() {
  if (store.mode !== 'cloud') { team = [{ user_id: 'demo', display_name: store.user?.name, email: '', last_sign_in_at: new Date().toISOString() }]; return; }
  try { team = await store.rpc('team_overview'); } catch { team = null; }
}
const ago = iso => {
  if (!iso) return 'nog nooit ingelogd';
  const d = new Date(iso), min = Math.round((Date.now() - d) / 60000);
  if (min < 2) return 'zojuist';
  if (min < 60) return `${min} min geleden`;
  if (min < 60 * 24 && d.toDateString() === new Date().toDateString()) return `vandaag ${d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}`;
  return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
};
function settingsTeam() {
  const s = S().settings, ps = partners();
  const rows = team || [];
  const isPartner = name => ps.includes(name);
  const body = !team ? '<p class="muted">Team laden…</p>' : rows.map(m => {
    const me = m.user_id === store.user?.id, online = me || store.online?.has(m.user_id);
    const share = isPartner(m.display_name) ? n(s.profit_shares?.[m.display_name] ?? 100 / ps.length) : null;
    return `<div class="member">
      <span class="avatar">${esc((m.display_name || '?')[0].toUpperCase())}<i class="dot ${online ? 'on' : ''}"></i></span>
      <div class="member-main"><b>${esc(m.display_name)}</b>${me ? ' <span class="badge">jij</span>' : ''}
        <div class="muted small">${esc(m.email || '')}</div></div>
      <div class="member-meta"><span class="badge ${share !== null ? '' : 'plain'}">${share !== null ? `Vennoot · ${share}%` : 'Lid'}</span>
        <div class="muted small">${online ? '<span class="online-txt">● Nu online</span>' : 'Laatst ingelogd: ' + ago(m.last_sign_in_at)}</div></div>
    </div>`;
  }).join('');
  return `<section class="card"><div class="card-head"><h2>Team</h2><span class="muted small">${rows.length} ${rows.length === 1 ? 'lid' : 'leden'}</span></div>
    <div class="members">${body}</div>
    <p class="muted small-note">Iemand toevoegen? Maak een gebruiker aan in Supabase (Authentication → Users) en voeg die toe aan de tabel <code>members</code>. Vraag het gerust aan Claude.</p>
  </section>`;
}

let integ = null; // status van koppelingen
// Het Gmail-script meldt zich elke 15 minuten; na een uur stilte klopt er iets niet
const gmailStale = () => !!integ?.gmail?.connected && Date.now() - new Date(integ.gmail.updated_at).getTime() > 60 * 60e3;
const GMAIL_STALE_HTML = `<div class="banner warn">Het Gmail-script heeft al meer dan een uur niets van zich laten horen, dus nieuwe mails komen niet binnen. Open <b>script.google.com</b> → je LUMAR-project → links het <b>wekker-icoon (Triggers)</b>. Staat daar geen trigger voor <code>lumarSync</code>, kies dan bovenaan de functie <b>installeer</b> en klik op <b>Uitvoeren</b>. Kijk bij <b>Uitvoeringen</b> of er een foutmelding staat.</div>`;
async function loadIntegrations() {
  if (store.mode !== 'cloud') { integ = { unavailable: true }; return; }
  try { const rows = await store.rpc('integration_status'); integ = Object.fromEntries((rows || []).map(r => [r.provider, r])); }
  catch { integ = { unavailable: true }; }
}
let syncTimer = null;
function scheduleOneDriveSync() {
  if (!integ?.onedrive?.connected) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => store.invoke('lumar-integrations', { action: 'onedrive-sync' }).catch(e => console.warn('OneDrive', e)), 4000);
}

function settingsIntegrations() {
  const pending = !integ || integ.unavailable;
  const od = integ?.onedrive, gm = integ?.gmail;
  const status = (c, txt) => `<span class="chip ${c ? 'ps-posted' : ''}">${c ? '● Gekoppeld' : '○ Niet gekoppeld'}</span>${txt ? ` <small class="muted">${esc(txt)}</small>` : ''}`;
  return `<section class="card"><div class="card-head"><h2>Koppelingen</h2></div>
    ${pending ? '<div class="banner">De koppelingen zijn klaar in de app, maar moeten nog één keer worden aangezet in Supabase (database-update en serverfuncties). Dat doen we samen.</div>' : ''}
    <div class="integ">
      <div class="integ-row"><div><b>OneDrive</b><p class="muted">Bekijk al je OneDrive-bestanden in Documenten → OneDrive. Bonnen, documenten en logo's gaan daarnaast automatisch naar <code>LUMAR/Bonnen/&lt;jaar&gt;/&lt;kwartaal&gt;/</code>, <code>LUMAR/Documenten/</code> en <code>LUMAR/Branding/</code>.</p>${status(od?.connected, od?.account)}</div>
        <div class="row-actions">${od?.connected ? '<button class="btn" data-action="onedrive-sync">Nu synchroniseren</button><button class="btn ghost danger-text" data-action="integ-disconnect" data-provider="onedrive">Ontkoppelen</button>' : `<button class="btn primary" data-action="onedrive-connect" ${pending ? 'disabled' : ''}>Koppel OneDrive</button>`}</div></div>
      <div class="integ-row"><div><b>Gmail</b><p class="muted">Mails komen binnen onder Documenten → Mail, waar je ze als bon koppelt.</p><label class="field inline"><span>Welke mails</span><select data-setting="gmail_scope">${options([['all', 'Alles uit de inbox (+ label LUMAR)'], ['nopromo', 'Inbox zonder Reclame en Sociaal'], ['receipts', 'Alleen bonnen, facturen en bestellingen']], S().settings.gmail_scope || 'all')}</select></label>${status(gm?.connected, gm?.connected ? `info.lumarbusiness@gmail.com · laatste contact ${ago(gm.updated_at)}` : '')}${gmailStale() ? GMAIL_STALE_HTML : ''}</div>
        <div class="row-actions">${gm?.connected ? '<button class="btn" data-action="gmail-setup">Nieuwe koppelcode</button><button class="btn ghost danger-text" data-action="integ-disconnect" data-provider="gmail">Ontkoppelen</button>' : `<button class="btn primary" data-action="gmail-setup" ${pending ? 'disabled' : ''}>Koppel Gmail</button>`}</div></div>
      ${['instagram', 'tiktok'].map(pv => { const x = integ?.[pv]; const nm = pv === 'instagram' ? 'Instagram' : 'TikTok';
        const txt = pv === 'instagram' ? 'Plaats posts (foto, carrousel of reel) rechtstreeks vanuit Marketing. Volgers, weergaven en likes komen vanzelf binnen onder Marketing → Statistieken.' : 'Stuur video\'s vanuit Marketing als concept naar TikTok; daar kies je geluid en plaats je hem. Volgers en weergaven komen vanzelf binnen onder Marketing → Statistieken.';
        return `<div class="integ-row"><div><b>${nm}</b><p class="muted">${txt}</p>${status(x?.connected, x?.account)}</div>
        <div class="row-actions">${x?.connected ? `<button class="btn" data-go="marketing/${pv === 'tiktok' ? 'tiktok' : 'mk-overview'}">Bekijken</button><button class="btn ghost danger-text" data-action="integ-disconnect" data-provider="${pv}">Ontkoppelen</button>` : `<button class="btn primary" data-action="social-connect" data-provider="${pv}" ${pending ? 'disabled' : ''}>Koppel ${nm}</button>`}</div></div>`; }).join('')}
    </div></section>`;
}

const GMAIL_SCRIPT = (secret) => `// LUMAR – mail uit Gmail naar de LUMAR-app (Documenten → Mail)
// Welke mails worden meegenomen stel je in de app in: Instellingen → Koppelingen.
const LUMAR_URL = '${config.SUPABASE_URL}/functions/v1/lumar-gmail-inbox';
const LUMAR_CODE = '${secret}';

function stuur(data) {
  return UrlFetchApp.fetch(LUMAR_URL, { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify(Object.assign({ code: LUMAR_CODE }, data)) });
}

function lumarSync() {
  const props = PropertiesService.getScriptProperties();
  const cfgRes = stuur({ config: true });
  if (cfgRes.getResponseCode() !== 200) { console.log(cfgRes.getContentText()); return; }
  const cfg = JSON.parse(cfgRes.getContentText());
  const start = Date.now();
  const laatste = Number(props.getProperty('laatste') || 0);
  const vanaf = laatste ? Math.floor(laatste / 1000) - 900 : Math.floor(start / 1000) - cfg.days * 86400;
  let offset = 0, klaar = false;
  while (Date.now() - start < 4 * 60 * 1000) {
    const threads = GmailApp.search(cfg.query + ' after:' + vanaf, offset, 20);
    if (!threads.length) { klaar = true; break; }
    for (const t of threads) {
      const berichten = t.getMessages().filter(m => m.getDate().getTime() / 1000 >= vanaf).map(m => ({
        id: m.getId(), subject: m.getSubject(), from: m.getFrom(), date: m.getDate().toISOString(),
        body: m.getPlainBody().slice(0, 20000),
        attachments: m.getAttachments({ includeInlineImages: false }).filter(a => a.getSize() < 8000000)
          .map(a => ({ name: a.getName(), mime: a.getContentType(), base64: Utilities.base64Encode(a.getBytes()) })),
      }));
      if (!berichten.length) continue;
      const r = stuur({ messages: berichten });
      if (r.getResponseCode() !== 200) { console.log(r.getContentText()); return; }
    }
    offset += threads.length;
  }
  if (klaar) props.setProperty('laatste', String(start));
}

function installeer() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('lumarSync').timeBased().everyMinutes(15).create();
  PropertiesService.getScriptProperties().deleteProperty('laatste');
  lumarSync();
}
`;

async function gmailSetup() {
  const res = await store.invoke('lumar-integrations', { action: 'gmail-secret' });
  const code = GMAIL_SCRIPT(res.secret);
  const dlg = openDialog(`<div class="modal-body wide"><header><div><div class="eyebrow">Koppelen</div><h2>Gmail koppelen</h2></div><button class="x" data-close>×</button></header>
    <ol class="steps">
      <li>Log in op Gmail met <b>info.lumarbusiness@gmail.com</b> en ga naar <b>script.google.com</b> → <b>Nieuw project</b>.</li>
      <li>Open het bestaande project (of maak een nieuw project), selecteer alle code, verwijder die en plak de code hieronder erin (knop <b>Kopiëren</b>). Klik op 💾 opslaan.</li>
      <li>Kies bovenaan de functie <b>installeer</b> en klik op <b>Uitvoeren</b>. Geef toestemming (Geavanceerd → Ga naar project).</li>
      <li>Klaar: elke 15 minuten komen nieuwe mails binnen onder Documenten → Mail. De eerste keer worden de mails van de afgelopen 30 dagen opgehaald.</li>
    </ol>
    <p class="muted">Deze code bevat een geheime sleutel en is alleen nu zichtbaar. Maak je later een nieuwe code, dan werkt de oude niet meer.</p>
    <textarea class="code" readonly rows="14">${esc(code)}</textarea>
    <footer><button class="btn primary" data-copy>Kopiëren</button><button class="btn" data-close>Sluiten</button></footer></div>`);
  $('[data-copy]', dlg).onclick = async () => { await navigator.clipboard.writeText(code); toast('Code gekopieerd'); };
  await loadIntegrations(); render();
}

// Mail-inbox: bijlagen koppelen als bon
const mailFiles = m => [...(m.attachments || []), ...(m.body_path ? [{ path: m.body_path, name: 'E-mail (tekst)', mime: 'text/plain' }] : [])];
// Mailtekst leesbaar maken: geen lange links, geen [image: …]-plaatshouders
function cleanMail(text, oneLine = false) {
  let t = String(text || '')
    .replace(/\[image:[^\]]*\]/gi, '')
    .replace(/<\s*(?:https?:\/\/|mailto:)[^>]*>/gi, '')
    .replace(/(?:https?:\/\/|www\.)\S+/gi, '')
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]+/g, ' ');
  if (oneLine) return t.replace(/\s+/g, ' ').trim();
  return t.split('\n').map(l => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
const mailSender = from => { const m = String(from || '').match(/^\s*"?([^"<]+?)"?\s*</); return (m ? m[1] : String(from || '')).trim(); };

async function openMail(id) {
  const m = itemById(id);
  const files = mailFiles(m).filter(f => f.mime !== 'text/plain');
  const dlg = openDialog(`<div class="modal-body wide"><header><div><div class="eyebrow">${esc(m.from || '')}</div><h2>${esc(m.subject || '(geen onderwerp)')}</h2><small class="muted">${new Date(m.date).toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short' })}</small></div><button class="x" data-close>×</button></header>
    ${m.amounts?.length ? `<div class="linked">${m.amounts.map(a => `<span class="chip">${euro(a)}</span>`).join('')}</div>` : ''}
    ${files.length ? `<div class="linked" style="margin-top:8px">${files.map(a => `<button class="chip" data-action="file" data-path="${esc(a.path)}">📎 ${esc(a.name)}</button>`).join('')}</div>` : ''}
    <pre class="mail-body">${esc(cleanMail(m.snippet))}…</pre>
    <footer class="actions">${(m.status || 'new') === 'new' ? `<button class="btn primary" data-action="mail-link" data-id="${id}">Koppelen als bon</button><button class="btn" data-action="mail-expense" data-id="${id}">Nieuwe uitgave</button><button class="btn" data-action="mail-ignore" data-id="${id}">Negeren</button>` : `<span class="chip">${m.status === 'linked' ? '✓ Gekoppeld' : 'Genegeerd'}</span>`}</footer></div>`, 'detail');
  if (m.body_path) {
    try { const url = await store.fileUrl(m.body_path); const txt = url.startsWith('data:') ? atob(url.split(',')[1]) : await (await fetch(url)).text(); $('.mail-body', dlg).textContent = cleanMail(txt.replace(/^Van:.*\n.*\n.*\n\n/, '')); }
    catch { /* laat het fragment staan */ }
  }
}

function linkMailForm(id) {
  const m = itemById(id), files = mailFiles(m);
  const recs = receiptRecords(S());
  const open = recs.filter(r => !r.path), rest = recs.filter(r => r.path);
  const label = r => `${fdate(r.date)} · ${r.description} · ${euro(r.amount)}`;
  openForm({
    eyebrow: 'Mail koppelen', title: m.subject || '(geen onderwerp)',
    intro: `${esc(m.from || '')}${m.amounts?.length ? ` · bedragen in de mail: ${m.amounts.map(a => euro(a)).join(', ')}` : ''}`,
    fields: [
      { name: 'file', label: 'Welk bestand is de bon?', type: 'select', wide: true, options: files.map((f, i) => [i, f.name]) },
      { name: 'target', label: 'Koppelen aan', type: 'select', wide: true, options: [['', '— kies een inkoop of uitgave —'], ...open.map(r => [`${r.table}:${r.id}`, '⚠︎ ' + label(r)]), ...rest.map(r => [`${r.table}:${r.id}`, label(r) + ' (heeft al een bon)'])] },
    ],
    submit: 'Koppelen',
    onSubmit: async d => {
      if (!d.target) { toast('Kies waar de bon bij hoort', 'bad'); return false; }
      const [table, rid] = d.target.split(':');
      const f = files[+d.file];
      await store.update(table, rid, { receipt_path: f.path });
      await saveItem('mail', id, { status: 'linked', linked: d.target, linked_file: f.path });
      toast('Bon gekoppeld'); scheduleOneDriveSync();
    },
  });
}

Object.assign(pages, {
  vat() {
    const st = S(), cq = curQuarter();
    // Standaard: vorig kwartaal zolang de deadline daarvan nog niet voorbij is, anders het huidige
    const prev = cq.q === 1 ? { y: cq.y - 1, q: 4 } : { y: cq.y, q: cq.q - 1 };
    const def = today() <= vatReturn(st, prev.y, prev.q).deadline ? prev : cq;
    const yy = +(ui.vatYear || def.y), q = +(ui.vatQ || def.q);
    const v = vatReturn(st, yy, q);
    const daysLeft = daysBetween(today(), v.deadline);
    const years = [...new Set([cq.y, cq.y - 1, ...st.watches.filter(w => w.sale_date).map(w => +w.sale_date.slice(0, 4))])].sort((a, b) => b - a);
    if (!st.settings.vat_enabled) return head('Btw-aangifte') + `<div class="banner">De btw-berekening staat uit (bijvoorbeeld omdat jullie de kleineondernemersregeling gebruiken). Zet hem aan bij Instellingen als jullie btw moeten afdragen.</div>`;
    const state = v.vat <= 0 ? ['ok', 'Niets af te dragen in dit kwartaal. Doe wel aangifte (met € 0) als de Belastingdienst die heeft klaargezet.'] : v.open <= 0.005 ? ['ok', `Afgedragen: ${euro(v.paid)}. Dit kwartaal is klaar.`] : today() <= v.to ? ['', `Het kwartaal loopt nog. Tot nu toe ${euro(v.vat)} btw.`] : daysLeft < 0 ? ['bad', `De deadline (${fdate(v.deadline)}) is ${-daysLeft} dagen verstreken. Nog af te dragen: ${euro(v.open)}.`] : ['bad', `Nog ${daysLeft} dagen: aangifte en betaling uiterlijk ${fdate(v.deadline)}. Nog af te dragen: ${euro(v.open)}.`];
    return head('Btw-aangifte', 'Per kwartaal, volgens de margeregeling. Aangifte doe je in Mijn Belastingdienst Zakelijk.', `<select class="period" data-uikey="vatYear">${options(years.map(x => [x, x]), yy)}</select>`) + `
      <div class="toolbar"><div class="tabs">${[1, 2, 3, 4].map(k => `<button class="${k === q ? 'on' : ''}" data-action="set-ui" data-key="vatQ" data-value="${k}">K${k} <small>${fdate(vatReturn(st, yy, k).deadline)}</small></button>`).join('')}</div></div>
      <div class="check-banner big ${state[0]}">${state[1]}</div>
      <section class="cols">
        <div class="card"><div class="card-head"><h2>Invullen bij de aangifte</h2><span class="badge">K${q} ${yy}</span></div><div class="statement">
          <div class="statement-row"><span>Rubriek 1a · omzet (winstmarges excl. btw)</span><b>${euro(v.omzet)}</b></div>
          <div class="statement-row"><span>Rubriek 1a · btw</span><b>${euro(v.vat)}</b></div>
          <div class="statement-row"><span>Overige rubrieken</span><b>€ 0</b></div>
          <div class="statement-row total"><span>Te betalen (rubriek 5)</span><b>${euro(v.vat)}</b></div></div>
          <p class="muted small-note">In de aangifte vul je hele euro's in. Bij de margeregeling geef je in rubriek 1a de winstmarge zonder btw op en daarnaast de btw. Een negatieve marge (verlies op een horloge) mag je niet aftrekken van andere horloges${v.negatives ? ` — dit kwartaal ${v.negatives}×` : ''}. Btw die jullie zelf betalen op zakelijke kosten (voorbelasting, rubriek 5b) houdt de app nog niet bij: vraag je boekhouder hoe je die meeneemt.</p>
        </div>
        <div class="card"><div class="card-head"><h2>Betaling</h2></div><div class="statement">
          <div class="statement-row"><span>Btw dit kwartaal</span><b>${euro(v.vat)}</b></div>
          <div class="statement-row"><span>Al afgedragen</span><b>− ${euro(v.paid)}</b></div>
          <div class="statement-row total"><span>Nog te betalen</span><b class="${v.open > 0.005 ? 'bad' : 'good'}">${euro(Math.max(0, v.open))}</b></div></div>
          ${v.open > 0.005 && today() > v.to ? `<p><button class="btn primary" data-action="vat-pay" data-y="${yy}" data-q="${q}">Betaling aan Belastingdienst boeken</button></p>` : ''}
          <p class="muted small-note">Uiterste datum aangifte én betaling: <b>${fdate(v.deadline)}</b> (laatste dag van de maand na het kwartaal). Boek de betaling hier pas als het geld echt is overgemaakt.</p>
        </div>
      </section>
      <section class="card flush"><div class="card-head pad"><h2>Verkochte horloges in K${q} ${yy}</h2></div>
        ${v.rows.length ? `<table class="table"><thead><tr><th>Datum</th><th>Horloge</th><th class="r">Inkoopprijs</th><th class="r">Verkoopprijs</th><th class="r">Marge</th><th class="r">Marge excl. btw</th><th class="r">Btw</th></tr></thead><tbody>${v.rows.map(r => `<tr data-action="watch" data-id="${r.id}"><td>${fdate(r.date)}</td><td><b>${esc(r.name)}</b></td><td class="r">${euro(r.purchase)}</td><td class="r">${euro(r.sale)}</td><td class="r">${signed(r.margin)}</td><td class="r">${euro(r.marginExcl)}</td><td class="r">${euro(r.vat)}</td></tr>`).join('')}
          <tr class="sum"><td></td><td><b>Totaal</b></td><td></td><td></td><td></td><td class="r"><b>${euro(v.omzet)}</b></td><td class="r"><b>${euro(v.vat)}</b></td></tr></tbody></table>` : empty('Geen verkopen onder de margeregeling in dit kwartaal.')}
        ${v.noScheme ? `<p class="muted pad">${v.noScheme} verkocht horloge(s) staan op "Geen btw" en tellen hier niet mee.</p>` : ''}
      </section>`;
  },

  tax() {
    const st = S(), cy = +today().slice(0, 4), y = +(ui.taxYear || cy), t = taxYear(y);
    const pot = taxPot(st, y), bal = bankBalance(st);
    const years = [...new Set([cy, cy - 1])];
    return head('Belastingen', 'Belastingpotje en een indicatie van de inkomstenbelasting per vennoot.', `<select class="period" data-uikey="taxYear">${options(years.map(x => [x, x]), y)}</select>`) + `
      <section class="stats">${stat('Belastingpotje', euro(pot.total), 'opzij zetten voor btw + inkomstenbelasting')}${stat('Btw nog af te dragen', euro(pot.vat), '', 'data-go="financien/vat"')}${stat(`Reserve inkomstenbelasting ${y}`, euro(pot.ib), `${pot.perPartner[0]?.reservePct ?? 35}% van de belastbare winst`)}${stat('Vrij besteedbaar', signed(bal - pot.total), 'banksaldo min belastingpotje')}</section>
      <section class="cols">${pot.perPartner.map(p => `<div class="card"><div class="card-head"><h2>${esc(p.partner)}</h2><span class="badge">${y}</span></div><div class="statement">
        <div class="statement-row"><span>Winstaandeel</span><b>${signed(p.profit)}</b></div>
        <div class="statement-row"><span>Uren (urencriterium ${t.hours})</span><b class="${p.meetsHours ? 'good' : ''}">${Math.round(p.hours)} uur ${p.meetsHours ? '✓' : ''}</b></div>
        ${progress(p.hours, t.hours)}
        <div class="statement-row"><span>Zelfstandigenaftrek ${p.meetsHours ? '' : '(alleen met urencriterium)'}</span><b>− ${euro(p.selfEmployed)}</b></div>
        <div class="statement-row"><span>Startersaftrek</span><b>− ${euro(p.starter)}</b></div>
        <div class="statement-row"><span>Mkb-winstvrijstelling (${t.mkb}%)</span><b>− ${euro(p.mkb)}</b></div>
        <div class="statement-row sub"><span>Belastbare winst</span><b>${euro(p.taxable)}</b></div>
        <div class="statement-row total"><span>Reserve (${p.reservePct}%)</span><b>${euro(p.reserve)}</b></div></div></div>`).join('')}</section>
      <section class="card"><div class="card-head"><h2>Goed om te weten</h2></div><ul class="plain">
        <li>In een vof doet ieder van jullie <b>zelf</b> aangifte inkomstenbelasting over het eigen winstaandeel.</li>
        <li>Bedragen ${y}: zelfstandigenaftrek ${euro(t.selfEmployed)}, startersaftrek ${euro(t.starter)} (alleen met recht op zelfstandigenaftrek, maximaal 3× in de eerste 5 jaar), mkb-winstvrijstelling ${t.mkb}% (ook zonder urencriterium).</li>
        <li>Urencriterium: minimaal ${t.hours} uur per jaar per persoon. Schrijf je uren bij in <a class="link" data-go="taken/hours">Taken → Uren</a>.</li>
        <li>Dit is een <b>indicatie</b>: ander inkomen, heffingskortingen, de inkomensafhankelijke bijdrage Zvw en de werkelijke tarieven zijn niet meegerekend. Pas het reservepercentage aan bij Instellingen en laat de aangifte controleren door een boekhouder.</li>
      </ul></section>`;
  },

  hours() {
    const all = items('hours'), y = +today().slice(0, 4), f = ui.hoursPerson, t = taxYear(y);
    const totals = hoursByPerson(S().items || [], y);
    const list = all.filter(h => f === 'all' || h.person === f).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const daysIn = daysBetween(`${y}-01-01`, today()) + 1, pace = Math.round(t.hours * daysIn / 365);
    return head('Uren', `Urenregistratie ${y} voor het urencriterium (${t.hours} uur per persoon).`, '<button class="btn primary" data-action="hours-add">＋ Uren</button>') + itemsBanner() + `
      <section class="cols">${partners().map(p => `<div class="card"><div class="card-head"><h2>${esc(p)}</h2><b>${Math.round(totals[p] || 0)} / ${t.hours} uur</b></div>${progress(totals[p] || 0, t.hours)}<p class="muted small-note">${(totals[p] || 0) >= pace ? 'Op schema' : `Achter op schema: rond deze datum zou je op ±${pace} uur moeten zitten`}.</p></div>`).join('')}</section>
      <div class="toolbar">${tabsHtml('hoursPerson', [['all', 'Iedereen'], ...partners().map(p => [p, p])])}</div>
      ${list.length ? `<div class="card flush"><table class="table"><thead><tr><th>Datum</th><th>Wie</th><th>Soort werk</th><th>Omschrijving</th><th class="r">Uren</th></tr></thead><tbody>${list.slice(0, 300).map(h => `<tr data-action="edit-hours" data-id="${h.id}"><td>${fdate(h.date)}</td><td>${esc(h.person)}</td><td>${esc(h.activity)}</td><td>${esc(h.note || '')}</td><td class="r"><b>${String(h.hours).replace('.', ',')}</b></td></tr>`).join('')}</tbody></table></div>` : empty('Nog geen uren geschreven.', '<button class="btn primary" data-action="hours-add">＋ Eerste uren</button>')}`;
  },

  tiktok() {
    const con = integ?.tiktok?.connected;
    if (con && !social.data && !social.loading) loadSocial();
    const btns = `${con ? `<button class="btn" data-action="social-refresh" ${social.loading ? 'disabled' : ''}>${social.loading ? 'Bijwerken…' : '↻ Bijwerken'}</button>` : ''}<button class="btn primary" data-action="tt-new">＋ Nieuwe TikTok</button>`;
    const intro = 'Jullie TikTok-account: volgers, video\'s en wat er nog klaarstaat. De cijfers worden automatisch opgehaald.';
    if (!integ) return head('TikTok', intro, btns) + '<div class="banner">Laden…</div>';
    if (!con) return head('TikTok', intro, btns) + `<div class="banner">TikTok is nog niet gekoppeld. Dat doe je bij <a class="link" data-go="instellingen/settings">Instellingen → Koppelingen</a>.</div>`;
    const tt = social.data?.tiktok, prof = tt?.profile, vids = tt?.videos || [];
    const fmt = x => n(x).toLocaleString('nl-NL');
    const snaps = items('socialstat').filter(x => x.tt_followers != null).sort((a, b) => a.date.localeCompare(b.date));
    const base = snaps.find(x => x.date >= addDays(today(), -30)) || snaps[0];
    const growth = prof?.follower_count != null && base && base.date < today() ? `${prof.follower_count - base.tt_followers >= 0 ? '+' : ''}${fmt(prof.follower_count - base.tt_followers)} sinds ${fdate(base.date)}` : 'groei zie je na een paar dagen';
    const views = vids.reduce((a, v) => a + n(v.view_count), 0);
    const waiting = items('post').filter(p => p.channel === 'TikTok' && p.status !== 'posted').sort((a, b) => String(a.date || '9').localeCompare(String(b.date || '9')));
    const postOf = id => items('post').find(p => p.tt_id === id);
    return head('TikTok', intro, btns) + itemsBanner() +
      (tt?.error ? `<div class="banner">TikTok gaf een fout: ${esc(tt.error)}</div>` : '') +
      (!tt && social.loading ? '<div class="banner">Cijfers van TikTok ophalen…</div>' : '') +
      (prof ? `<section class="stats">${stat(`Volgers · ${esc(prof.display_name || '')}`, prof.follower_count != null ? fmt(prof.follower_count) : '—', growth)}${stat('Likes in totaal', prof.likes_count != null ? fmt(prof.likes_count) : '—', 'op al jullie video\'s')}${stat('Weergaven', fmt(views), `laatste ${vids.length} video's`)}${stat('Gem. per video', vids.length ? fmt(Math.round(views / vids.length)) : '—', 'weergaven')}</section>` : '') + `
      <div class="card"><div class="card-head"><h2>Klaar om te plaatsen</h2><small class="muted">${waiting.length}</small></div>
        ${waiting.length ? `<ul class="list">${waiting.map(p => `<li data-action="edit-post" data-id="${p.id}"><div><b>${esc(p.title)}</b><small>${p.date ? fdate(p.date) : 'geen datum'}${p.watch_id && watchById(p.watch_id) ? ' · ' + esc(wname(watchById(p.watch_id))) : ''}${p.tt_publish_id ? ' · staat in je TikTok-inbox' : ''}</small></div><span class="chip ps-${p.status}">${p.tt_publish_id ? 'Concept verstuurd' : postLabel(p.status)}</span></li>`).join('')}</ul>` : `<p class="muted">Niets klaargezet. Klik op <b>＋ Nieuwe TikTok</b>: kies je video, de app zet hem als concept in TikTok, en daar kies je geluid en plaats je hem.</p>`}
      </div>
      <div class="card flush"><div class="card-head pad"><h2>Video's op TikTok</h2><small class="muted">${social.at ? 'bijgewerkt ' + social.at.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }) : ''}</small></div>
        ${vids.length ? `<div class="tt-grid">${vids.map(v => { const p = postOf(v.id); return `<a class="tt-card" href="${esc(v.share_url || '#')}" target="_blank" rel="noopener">
          <div class="tt-cover">${v.cover_image_url ? `<img src="${esc(v.cover_image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}<span class="tt-views">▶ ${fmt(v.view_count)}</span></div>
          <div class="tt-body"><b>${esc((v.title || v.video_description || 'Video').split('\n')[0])}</b><small class="muted">${fdate(new Date(v.create_time * 1000).toISOString().slice(0, 10))}${p?.watch_id && watchById(p.watch_id) ? ' · ⌚ ' + esc(wname(watchById(p.watch_id))) : ''}</small>
          <small>♥ ${fmt(v.like_count)} · 💬 ${fmt(v.comment_count)} · ↗ ${fmt(v.share_count)}</small></div></a>`; }).join('')}</div>` : empty(social.loading ? 'Laden…' : 'Nog geen video\'s gevonden.')}
      </div>`;
  },

  inbox() {
    const all = items('mail'), f = ui.mailFilter;
    const q = (ui.mailSearch || '').toLowerCase();
    const list = all.filter(m => (m.status || 'new') === f || f === 'all').filter(m => !q || `${m.subject} ${m.from} ${m.snippet}`.toLowerCase().includes(q)).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const cnt = s => all.filter(m => (m.status || 'new') === s).length;
    const ready = integ?.gmail?.connected;
    return head('Mail', 'Bonnen en bevestigingen uit Gmail. Koppel ze aan een inkoop of uitgave.') + itemsBanner() + `
      ${gmailStale() ? GMAIL_STALE_HTML : ''}
      ${!ready ? `<div class="banner">Gmail is nog niet gekoppeld. Dat doe je bij <a class="link" data-go="instellingen/settings">Instellingen → Koppelingen</a>.</div>` : ''}
      <div class="toolbar"><input class="search" id="mailSearch" placeholder="Zoek op onderwerp, afzender of tekst…" value="${esc(ui.mailSearch || '')}">${tabsHtml('mailFilter', [['new', 'Nieuw', cnt('new')], ['linked', 'Gekoppeld', cnt('linked')], ['ignored', 'Genegeerd', cnt('ignored')], ['all', 'Alles', all.length]])}</div>
      ${list.length ? `<div class="card flush mail-list">${list.slice(0, 200).map(m => `<div class="mail-row ${(m.status || 'new') !== 'new' ? 'done' : ''}" data-action="mail-open" data-id="${m.id}">
          <div class="mail-from">${esc(mailSender(m.from))}</div>
          <div class="mail-main"><b>${esc(m.subject || '(geen onderwerp)')}</b> <span class="muted">— ${esc(cleanMail(m.snippet, true).slice(0, 160))}</span></div>
          <div class="mail-meta">${mailFiles(m).some(f => f.mime !== 'text/plain') ? '<span title="Bijlage">📎</span>' : ''}${m.amounts?.length ? `<span class="badge">${euro(m.amounts[0])}</span>` : ''}${m.status === 'linked' ? '<span class="chip ps-posted">gekoppeld</span>' : ''}<small>${fdate(String(m.date).slice(0, 10))}</small></div>
        </div>`).join('')}</div>${list.length > 200 ? '<p class="muted">De nieuwste 200 worden getoond. Gebruik de zoekbalk om oudere mails te vinden.</p>' : ''}` : empty(ready ? 'Geen mails in deze lijst.' : 'Nog geen mails binnengekomen.')}`;
  },
});

function postResultsHtml() {
  const posts = items('post').filter(p => p.status === 'posted');
  if (!posts.length) return '';
  const eng = p => n(p.likes) + n(p.comments) + n(p.saves);
  const byCh = CHANNELS.map(c => { const l = posts.filter(p => p.channel === c); return { c, count: l.length, views: l.reduce((a, p) => a + n(p.views), 0), eng: l.reduce((a, p) => a + eng(p), 0) }; }).filter(x => x.count);
  const top = [...posts].sort((a, b) => eng(b) - eng(a) || n(b.views) - n(a.views)).slice(0, 8);
  return `<section class="cols">
      <div class="card"><div class="card-head"><h2>Resultaat per kanaal</h2></div><table class="table compact"><thead><tr><th>Kanaal</th><th class="r">Posts</th><th class="r">Weergaven</th><th class="r">Interacties</th></tr></thead><tbody>${byCh.map(x => `<tr><td>${x.c}</td><td class="r">${x.count}</td><td class="r">${x.views.toLocaleString('nl-NL')}</td><td class="r">${x.eng.toLocaleString('nl-NL')}</td></tr>`).join('')}</tbody></table></div>
      <div class="card"><div class="card-head"><h2>Beste posts</h2></div><ul class="list">${top.map(p => `<li data-action="edit-post" data-id="${p.id}"><div><b>${esc(p.title)}</b><small>${esc(p.channel)} · ${fdate(p.date)} · ${n(p.views).toLocaleString('nl-NL')} weergaven</small></div><span>${eng(p)} ♥</span></li>`).join('')}</ul></div>
    </section>`;
}

// ───────────── Instagram & TikTok ─────────────
const social = { data: null, loading: false, at: null };
const igViews = m => n(m.views ?? m.reach);
async function loadSocial(force = false) {
  if (social.loading || (!force && social.data)) return;
  social.loading = true; if (route.page === 'tiktok') render();
  try {
    const d = await store.invoke('lumar-social', { action: 'stats' });
    social.data = d; social.at = new Date();
    await syncSocialPosts(d);
    if (d.instagram?.error && integ?.instagram?.connected) toast(d.instagram.error, 'bad');
    if (d.tiktok?.error && integ?.tiktok?.connected) toast(d.tiktok.error, 'bad');
  } catch (e) { toast(e.message, 'bad'); }
  finally { social.loading = false; if (route.page === 'tiktok') render(); }
}
// Werk cijfers van gekoppelde posts bij en bewaar één momentopname per dag (voor de groei)
async function syncSocialPosts(d) {
  const posts = items('post');
  for (const m of d.instagram?.media || []) {
    const p = posts.find(x => x.ig_id === m.id || (m.permalink && x.url === m.permalink));
    if (!p) continue;
    const patch = { ig_id: m.id, url: m.permalink || p.url, views: igViews(m), likes: n(m.like_count), comments: n(m.comments_count), saves: n(m.saved) + n(m.shares), status: 'posted' };
    if (['views', 'likes', 'comments', 'saves', 'url', 'ig_id'].some(k => String(p[k] ?? '') !== String(patch[k] ?? '')) || p.status !== 'posted') await saveItem('post', p.id, patch);
  }
  for (const v of d.tiktok?.videos || []) {
    const day = new Date(v.create_time * 1000).toISOString().slice(0, 10);
    let p = posts.find(x => x.tt_id === v.id);
    if (!p) { const cands = posts.filter(x => x.channel === 'TikTok' && !x.tt_id && x.tt_publish_id && x.date === day); if (cands.length === 1) p = cands[0]; }
    if (!p) continue;
    const patch = { tt_id: v.id, url: v.share_url || p.url, views: n(v.view_count), likes: n(v.like_count), comments: n(v.comment_count), saves: n(v.share_count), status: 'posted' };
    if (['views', 'likes', 'comments', 'saves', 'url', 'tt_id'].some(k => String(p[k] ?? '') !== String(patch[k] ?? '')) || p.status !== 'posted') await saveItem('post', p.id, patch);
  }
  const snap = { date: today(), ig_followers: d.instagram?.profile?.followers_count ?? null, ig_posts: d.instagram?.profile?.media_count ?? null, tt_followers: d.tiktok?.profile?.follower_count ?? null, tt_likes: d.tiktok?.profile?.likes_count ?? null };
  if (snap.ig_followers === null && snap.tt_followers === null) return;
  const cur = items('socialstat').find(x => x.date === snap.date);
  if (!cur || cur.ig_followers !== snap.ig_followers || cur.tt_followers !== snap.tt_followers) await saveItem('socialstat', cur?.id, snap);
}
// ───────────── OneDrive-verkenner ─────────────
const od = { cache: {}, loading: null, error: null, search: null };
const odCur = () => (ui.odStack ||= [{ id: '', name: 'OneDrive' }])[ui.odStack.length - 1];
async function odLoad(id, force = false) {
  if (!force && od.cache[id]) return;
  od.loading = id; od.error = null;
  try { od.cache[id] = await store.invoke('lumar-integrations', { action: 'od-list', itemId: id || undefined }); }
  catch (e) { od.error = e.message; }
  finally { od.loading = null; if (route.page === 'onedrive') render(); }
}
const fileIcon = f => f.folder ? '📁' : /pdf/i.test(f.mime || f.name) ? '📕' : /^image\//.test(f.mime || '') ? '🖼️' : /sheet|excel|\.xlsx?$|\.csv$/i.test(f.mime + f.name) ? '📊' : /word|\.docx?$/i.test(f.mime + f.name) ? '📝' : /video/.test(f.mime || '') ? '🎞️' : '📄';
const fileSize = b => b == null ? '' : b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} kB` : `${(b / 1048576).toFixed(1).replace('.', ',')} MB`;
const toBase64 = file => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });

async function odUpload(files) {
  const cur = odCur();
  for (const f of files) {
    if (f.size > 15 * 1048576) { toast(`${f.name} is groter dan 15 MB`, 'bad'); continue; }
    toast(`Uploaden: ${f.name}…`);
    await store.invoke('lumar-integrations', { action: 'od-upload', parentId: cur.id || null, name: f.name, mime: f.type, base64: await toBase64(f) });
  }
  toast('Geüpload naar OneDrive'); await odLoad(cur.id, true);
}

Object.assign(pages, {
  onedrive() {
    const connected = integ?.onedrive?.connected;
    if (!connected) return head('OneDrive', 'Bekijk en beheer jullie OneDrive-bestanden vanuit de app.') + `<div class="banner">OneDrive is nog niet gekoppeld. Dat doe je bij <a class="link" data-go="instellingen/settings">Instellingen → Koppelingen</a>.</div>`;
    const cur = odCur();
    const searching = od.search !== null;
    const data = searching ? od.search : od.cache[cur.id];
    if (!searching && !data && od.loading !== cur.id && !od.error) setTimeout(() => odLoad(cur.id), 0);
    const items = (data?.children || []).slice().sort((a, b) => (b.folder - a.folder) || a.name.localeCompare(b.name, 'nl'));
    return head('OneDrive', 'Jullie bestanden, rechtstreeks uit OneDrive.', `<button class="btn" data-action="od-refresh" title="Vernieuwen">↻</button><button class="btn" data-action="od-mkdir">＋ Map</button><label class="btn primary">⤒ Uploaden<input type="file" id="odUpload" multiple hidden></label>`) + `
      <div class="toolbar"><input class="search" id="odSearch" placeholder="Zoek in OneDrive… (Enter)" value="${esc(ui.odQuery || '')}">
        <div class="crumbs">${searching ? `<button class="link" data-action="od-clear">← Terug naar mappen</button> <span class="muted">Zoekresultaten voor "${esc(ui.odQuery)}"</span>` : ui.odStack.map((c, i) => `${i ? '<span class="muted">›</span>' : ''}<button class="link ${i === ui.odStack.length - 1 ? 'here' : ''}" data-action="od-crumb" data-i="${i}">${esc(c.name)}</button>`).join(' ')}</div></div>
      ${od.error ? `<div class="banner">${esc(od.error)}</div>` : ''}
      ${!data ? empty('Laden…') : items.length ? `<div class="card flush"><table class="table files"><thead><tr><th>Naam</th><th>Gewijzigd</th><th class="r">Grootte</th><th></th></tr></thead><tbody>
        ${items.map(f => `<tr data-action="${f.folder ? 'od-open' : 'od-file'}" data-id="${esc(f.id)}" data-name="${esc(f.name)}"><td><span class="ficon">${fileIcon(f)}</span><b>${esc(f.name)}</b>${f.folder && f.childCount != null ? ` <small class="muted">${f.childCount} items</small>` : ''}${searching && f.path ? `<br><small class="muted">${esc(decodeURIComponent(String(f.path).replace(/^\/drive\/root:?/, '') || '/'))}</small>` : ''}</td><td>${f.modified ? new Date(f.modified).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' }) : ''}</td><td class="r">${f.folder ? '' : fileSize(f.size)}</td><td class="r">${f.folder ? '<span class="chev">›</span>' : `<button class="link" data-action="od-dl" data-id="${esc(f.id)}" title="Downloaden">⤓</button>`}</td></tr>`).join('')}
      </tbody></table></div>` : empty(searching ? 'Niets gevonden.' : 'Deze map is leeg.')}`;
  },
});

// ───────────── Klikken ─────────────
document.addEventListener('click', async e => {
  const nav = e.target.closest('[data-page],[data-go]');
  if (nav && !e.target.closest('dialog')) { e.preventDefault(); go(nav.dataset.page || nav.dataset.go); return; }
  if (nav && e.target.closest('dialog')) { e.target.closest('dialog').close(); go(nav.dataset.page || nav.dataset.go); return; }
  const f = e.target.closest('[data-filter]');
  if (f) { ui.stockFilter = f.dataset.filter; render(); return; }
  const a = e.target.closest('[data-action]'); if (!a) return;
  const id = a.dataset.id;
  const inDetail = a.closest('dialog.detail');
  try {
    switch (a.dataset.action) {
      case 'purchase': purchaseForm(); break;
      case 'hours-add': hoursForm(); break;
      case 'edit-hours': hoursForm(id); break;
      case 'vat-pay': { const v = vatReturn(S(), +a.dataset.y, +a.dataset.q); bankEntryForm({ type: 'vat_payment', amount: v.open, description: `Btw-afdracht K${v.q} ${v.year}`, reference_id: vatRef(v.year, v.q) }); break; }
      case 'mail-link': $('dialog.detail')?.close(); linkMailForm(id); break;
      case 'mail-open': await openMail(id); break;
      case 'od-open': ui.odStack.push({ id, name: a.dataset.name }); render(); $('#main').scrollTop = 0; break;
      case 'od-crumb': ui.odStack = ui.odStack.slice(0, +a.dataset.i + 1); render(); break;
      case 'od-refresh': await odLoad(odCur().id, true); toast('Vernieuwd'); break;
      case 'od-clear': od.search = null; ui.odQuery = ''; render(); break;
      case 'od-file': case 'od-dl': { const win = window.open('', '_blank'); try { const r = await store.invoke('lumar-integrations', { action: 'od-download', itemId: id }); const u = a.dataset.action === 'od-dl' ? r.url : (r.webUrl || r.url); if (win && u) win.location = u; else win?.close(); } catch (err) { win?.close(); throw err; } break; }
      case 'od-mkdir': openForm({ eyebrow: 'OneDrive', title: 'Nieuwe map', submit: 'Aanmaken', fields: [{ name: 'name', label: 'Naam van de map', required: true, wide: true }], onSubmit: async d => { await store.invoke('lumar-integrations', { action: 'od-mkdir', parentId: odCur().id || null, name: d.name }); await odLoad(odCur().id, true); toast('Map aangemaakt'); } }); break;
      case 'mail-expense': { $('dialog.detail')?.close(); const m = itemById(id); const f = mailFiles(m).find(x => x.mime !== 'text/plain') || mailFiles(m)[0]; expenseForm({ description: m.subject, amount: m.amounts?.[0], receipt_path: f?.path, after: () => saveItem('mail', id, { status: 'linked', linked_file: f?.path }) }); break; }
      case 'mail-ignore': $('dialog.detail')?.close(); await saveItem('mail', id, { status: 'ignored' }); render(); break;
      case 'mail-reset': await saveItem('mail', id, { status: 'new' }); render(); break;
      case 'gmail-setup': await gmailSetup(); break;
      case 'onedrive-connect': { const r = await store.invoke('lumar-integrations', { action: 'onedrive-connect' }); location.href = r.url; break; }
      case 'onedrive-sync': { toast('Bezig met synchroniseren…'); let total = 0; for (let i = 0; i < 20; i++) { const r = await store.invoke('lumar-integrations', { action: 'onedrive-sync' }); total += r.uploaded || 0; if (!r.remaining) break; } toast(`OneDrive bijgewerkt: ${total} bestand(en)`); break; }
      case 'social-connect': { const r = await store.invoke('lumar-social', { action: 'connect', provider: a.dataset.provider }); location.href = r.url; break; }
      case 'social-refresh': await loadSocial(true); break;
      case 'tt-new': postForm(null, { channel: 'TikTok', status: 'prep', date: today(), send_tt: !!integ?.tiktok?.connected }); break;
      case 'integ-disconnect': if (await confirmDialog('Koppeling verbreken?', 'De app stopt met deze koppeling. Bestaande bestanden blijven staan.', 'Ontkoppelen')) { await store.invoke(['instagram', 'tiktok'].includes(a.dataset.provider) ? 'lumar-social' : 'lumar-integrations', { action: 'disconnect', provider: a.dataset.provider }); social.data = null; await loadIntegrations(); render(); } break;
      case 'task': inDetail?.close(); taskForm(null, a.dataset.watch ? { watch_id: a.dataset.watch, area: 'Verkoop' } : {}); break;
      case 'edit-task': inDetail?.close(); taskForm(id); break;
      case 'task-move': await moveTask(id, +a.dataset.dir); break;
      case 'idea': ideaForm(); break;
      case 'edit-idea': ideaForm(id); break;
      case 'idea-task': { const i = itemById(id); taskForm(null, { title: i.title, notes: i.description, area: AREAS.includes(i.category) ? i.category : 'Algemeen' }); break; }
      case 'wish': wishForm(); break;
      case 'edit-wish': wishForm(id); break;
      case 'wish-bought': { const w = itemById(id); purchaseForm({ prefill: { brand: w.brand, model: w.model, reference: w.reference, purchase_price: w.max_price, estimated_value: w.expected_sale }, after: () => saveItem('wish', id, { status: 'bought' }) }); break; }
      case 'post': inDetail?.close(); postForm(null, { watch_id: a.dataset.watch || '', date: a.dataset.date || today() }); break;
      case 'edit-post': inDetail?.close(); postForm(id); break;
      case 'cal-day': postForm(null, { date: a.dataset.date }); break;
      case 'cal-move': { const [y, m] = (ui.calMonth || today().slice(0, 7)).split('-').map(Number); const d = a.dataset.dir === '0' ? new Date() : new Date(Date.UTC(y, m - 1 + +a.dataset.dir, 1)); ui.calMonth = a.dataset.dir === '0' ? today().slice(0, 7) : d.toISOString().slice(0, 7); render(); break; }
      case 'brand-add': brandForm(a.dataset.kind); break;
      case 'edit-brand': brandForm(itemById(id).kind, id); break;
      case 'copy': { const i = itemById(id); await navigator.clipboard.writeText(i.kind === 'color' ? i.hex : i.text || ''); toast('Gekopieerd'); break; }
      case 'set-ui': ui[a.dataset.key] = a.dataset.value; render(); break;
      case 'sale': inDetail?.close(); saleForm(id); break;
      case 'expense': expenseForm(); break;
      case 'watch': watchDetail(id); break;
      case 'arrive': await markArrived(id); break;
      case 'edit-watch': inDetail?.close(); editWatchForm(id); break;
      case 'customer-return': customerReturnForm(id); break;
      case 'supplier-return': supplierReturnForm(id); break;
      case 'write-off': writeOffForm(id); break;
      case 'delete-watch': await deleteWatch(id); break;
      case 'delete-expense': await deleteExpense(id); break;
      case 'receipt-expense': addReceiptForm('expenses', id); break;
      case 'receipt-add': inDetail?.close(); addReceiptForm(a.dataset.table, id); break;
      case 'edit-expense': editExpenseForm(id); break;
      case 'watch-cost': inDetail?.close(); expenseForm({ watch_id: id, capitalized: true, category: 'Reparatie & service' }); break;
      case 'doc': inDetail?.close(); docForm(null, a.dataset.watch ? { watch_id: a.dataset.watch } : {}); break;
      case 'edit-doc': inDetail?.close(); docForm(id); break;
      case 'file': await openFile(a.dataset.path); break;
      case 'settle': settleForm(id); break;
      case 'bank-entry': bankEntryForm(); break;
      case 'balance': balanceForm(); break;
      case 'delete-bank': if (await confirmDialog('Mutatie verwijderen?', 'Deze bankmutatie wordt verwijderd.')) { await store.remove('bank_entries', id); render(); } break;
      case 'export': exportCsv(); break;
      case 'save-shares': {
        const shares = {}; document.querySelectorAll('[data-share]').forEach(i => { shares[i.dataset.share] = n(i.value); });
        const sum = Object.values(shares).reduce((x, y) => x + y, 0);
        if (Math.abs(sum - 100) > 0.01) { toast(`De verdeling moet samen 100% zijn (nu ${sum}%)`, 'bad'); break; }
        await store.setSetting('profit_shares', shares); toast('Winstverdeling opgeslagen'); render(); break;
      }
      case 'install': window.__installPrompt?.prompt(); break;
      case 'logout': await store.signOut(); showAuth(); break;
      case 'reset-demo': if (await confirmDialog('Demogegevens wissen?', 'Alle gegevens in deze browser worden gewist.', 'Wissen')) { await store.resetDemo(); render(); } break;
    }
  } catch (err) { console.error(err); toast(err.message || 'Er ging iets mis', 'bad'); }
});

document.addEventListener('input', e => {
  const sh = e.target.closest('[data-share]');
  if (!sh || sh.value === '') return;
  const inputs = [...document.querySelectorAll('[data-share]')];
  if (inputs.length === 2) { const o = inputs.find(i => i !== sh); o.value = round2(100 - Math.max(0, Math.min(100, n(sh.value)))); }
});
document.addEventListener('change', async e => {
  const p = e.target.closest('select.period');
  if (p) { ui[p.dataset.uikey] = p.value; render(); return; }
  const sh = e.target.closest('[data-share]');
  if (sh) {
    const inputs = [...document.querySelectorAll('[data-share]')];
    const v = Math.max(0, Math.min(100, round2(sh.value))); sh.value = v;
    const others = inputs.filter(i => i !== sh);
    const restOld = others.reduce((a, i) => a + n(i.value), 0), rest = round2(100 - v);
    others.forEach((i, k) => { i.value = k === others.length - 1 ? round2(rest - others.slice(0, -1).reduce((a, o) => a + n(o.value), 0)) : round2(restOld ? n(i.value) / restOld * rest : rest / others.length); });
    const shares = Object.fromEntries(inputs.map(i => [i.dataset.share, n(i.value)]));
    await store.setSetting('profit_shares', shares); toast('Winstverdeling opgeslagen'); return;
  }
  const sn = e.target.closest('[data-setting-num]');
  if (sn) { await store.setSetting(sn.dataset.settingNum, n(sn.value)); toast('Opgeslagen'); render(); return; }
  const st = e.target.closest('[data-starter]');
  if (st) { await store.setSetting('starters', { ...(S().settings.starters || {}), [st.dataset.starter]: st.checked }); toast('Opgeslagen'); render(); return; }
  const s = e.target.closest('[data-setting]');
  if (s) { try { await store.setSetting(s.dataset.setting, s.type === 'checkbox' ? s.checked : s.value); toast('Opgeslagen'); render(); } catch (err) { toast(err.message, 'bad'); } }
});

// ───────────── Start ─────────────
function showAuth(msg = '') {
  $('#app').hidden = true; $('#auth').hidden = false; $('#authStatus').textContent = msg;
}
function showApp() {
  $('#auth').hidden = true; $('#app').hidden = false;
  store.onUploaded = () => scheduleOneDriveSync();
  const qs = new URLSearchParams(location.search);
  if (qs.get('connected')) { toast(({ onedrive: 'OneDrive', instagram: 'Instagram', tiktok: 'TikTok' }[qs.get('connected')] || 'Koppeling') + ' is gekoppeld'); history.replaceState(null, '', location.pathname + location.hash); }
  if (qs.get('koppelfout')) { toast('Koppelen mislukt: ' + qs.get('koppelfout'), 'bad'); history.replaceState(null, '', location.pathname + location.hash); }
  go(location.hash.slice(1) || 'home');
  loadIntegrations().then(() => { if (['settings', 'inbox', 'tiktok'].includes(route.page)) render(); });
  loadTeam().then(() => { if (route.page === 'settings') render(); });
  store.onPresence = () => { if (route.page === 'settings' && !$('#modalRoot').children.length && !document.activeElement?.matches('input,select,textarea')) render(); };
}

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const d = formValues(e.target), btn = $('button', e.target);
  btn.disabled = true; $('#authStatus').textContent = 'Bezig met inloggen…';
  try { await store.signIn(d.email.trim(), d.password); showApp(); }
  catch (err) { $('#authStatus').textContent = /invalid login credentials/i.test(err.message) ? 'E-mailadres of wachtwoord klopt niet.' : `Inloggen mislukt: ${err.message}`; }
  finally { btn.disabled = false; }
});

window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); window.__installPrompt = e; const b = $('#installBtn'); if (b) b.hidden = false; });
window.addEventListener('hashchange', () => { const h = location.hash.slice(1) || 'home'; if (store?.user && h !== routeHash()) go(h); });

async function boot() {
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(r => r.update()).catch(() => {});
    // Nieuwe versie actief? Dan één keer automatisch herladen
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded && !document.querySelector('dialog[open] form')) { reloaded = true; location.reload(); } });
  }
  try { store = await createStore(config, () => { if (!document.querySelector('dialog[open] form')) render(); }); }
  catch (err) { showAuth('Kan de database niet bereiken. Controleer je internetverbinding. (' + err.message + ')'); return; }
  if (store.mode === 'demo') {
    $('#authHint').innerHTML = '<b>Demomodus</b> — er is nog geen database gekoppeld. Gegevens blijven alleen in deze browser. Vul je naam in als e-mail (bv. <i>luuk@lumar.nl</i>); een wachtwoord is niet nodig.';
    $('#loginForm [name=email]').type = 'text';
  }
  window.lumar = { state: () => store.state }; // voor controles en tests
  let ok = false;
  try { ok = await store.init(); } catch (err) { showAuth(err.message); return; }
  ok ? showApp() : showAuth();
}
boot();
