import config from './config.js';
import { createStore } from './store.js';
import {
  n, round2, STATUS, ACTIVE, PLATFORMS, EXPENSE_CATEGORIES, BOX_PAPERS, BANK_TYPES, splitMoney, marginVat,
  watchProfit, calc, bankBalance, pendingPayments, partnerCapital, actionItems, daysBetween, monthlyResults,
  quarterlyVat, groupSold, linkedReturnCosts, toCsv, inPeriod,
} from './logic.js';

// ───────────── Hulpjes ─────────────
let store;
let page = 'dashboard';
const ui = { stockFilter: 'active', stockSearch: '', period: 'year', salesPeriod: 'year', expensePeriod: 'year' };
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
  else if (f.type === 'file') input = `<input name="${f.name}" type="file" accept="${f.accept || 'image/*,application/pdf'}">`;
  else if (f.type === 'checkbox') return `<label class="field check ${f.wide ? 'wide' : ''}" data-field="${f.name}"><input name="${f.name}" type="checkbox" ${v ? 'checked' : ''}> ${esc(f.label)}</label>`;
  else input = `<input name="${f.name}" type="${f.type || 'text'}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}" ${req} ${f.list ? `list="dl-${f.name}"` : ''}>${f.list ? `<datalist id="dl-${f.name}">${f.list.map(x => `<option value="${esc(x)}">`).join('')}</datalist>` : ''}`;
  return `<label class="field ${f.wide ? 'wide' : ''}" data-field="${f.name}"><span>${esc(f.label)}</span>${input}${f.hint ? `<small>${esc(f.hint)}</small>` : ''}</label>`;
}

function formValues(form) {
  const d = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'file') d[el.name] = el.files[0] || null;
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

function openForm({ eyebrow = '', title, intro = '', fields, submit = 'Opslaan', danger = false, onSubmit, onInput }) {
  const dlg = openDialog(`<form class="modal-body" novalidate>
    <header><div><div class="eyebrow">${esc(eyebrow)}</div><h2>${esc(title)}</h2></div><button type="button" class="x" data-close aria-label="Sluiten">×</button></header>
    ${intro ? `<p class="muted intro">${intro}</p>` : ''}
    <div class="grid">${fields.map(fieldHtml).join('')}</div>
    <footer><button type="button" class="btn" data-close>Annuleren</button><button class="btn ${danger ? 'danger' : 'primary'}" type="submit">${esc(submit)}</button></footer>
  </form>`);
  const form = $('form', dlg);
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
  setTimeout(() => form.querySelector('input:not([type=hidden]):not([disabled]),select')?.focus(), 30);
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
function purchaseForm() {
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
      { name: 'brand', label: 'Merk', required: true, list: brands, show: d => d.mode === 'single' },
      { name: 'model', label: 'Model', required: true, show: d => d.mode === 'single' },
      { name: 'reference', label: 'Referentienummer', show: d => d.mode === 'single' },
      { name: 'serial', label: 'Serienummer', show: d => d.mode === 'single' },
      { name: 'year', label: 'Bouwjaar', placeholder: 'bv. 2019 of ca. 1975', show: d => d.mode === 'single' },
      { name: 'condition', label: 'Staat', type: 'select', options: ['', 'Nieuw', 'Als nieuw', 'Zeer goed', 'Goed', 'Redelijk', 'Defect / voor onderdelen'], show: d => d.mode === 'single' },
      { name: 'box_papers', label: 'Box & papieren', type: 'select', options: [['', '—'], ...Object.entries(BOX_PAPERS)], show: d => d.mode === 'single' },
      { type: 'section', label: 'Inkoop' },
      { name: 'purchase_date', label: 'Inkoopdatum', type: 'date', value: today(), required: true },
      { name: 'platform', label: 'Platform', type: 'select', options: PLATFORMS },
      { name: 'seller', label: 'Verkoper', placeholder: 'Naam of gebruikersnaam', show: d => d.mode === 'single' },
      { name: 'reference_no', label: 'Bestelnummer / notitie', show: d => d.mode === 'batch' },
      { name: 'purchase_price', label: 'Inkoopprijs (€)', type: 'money', required: true, show: d => d.mode === 'single', hint: 'Wat je aan de verkoper betaalt' },
      { name: 'extra_costs', label: 'Extra kosten (€)', type: 'money', show: d => d.mode === 'single', hint: 'Verzending, kopersbescherming, service' },
      { name: 'estimated_value', label: 'Geschatte verkoopwaarde (€)', type: 'money', show: d => d.mode === 'single' },
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
    onSubmit: async (d, form) => d.mode === 'batch' ? saveBatch(d, form) : saveSingle(d),
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
function expenseForm(preset = {}) {
  const returnable = S().watches.filter(w => ['returned', 'in_stock', 'incoming', 'customer_returning', 'sold'].includes(w.status));
  openForm({
    eyebrow: 'Nieuwe uitgave', title: 'Kosten toevoegen', submit: 'Uitgave opslaan',
    fields: [
      { name: 'description', label: 'Omschrijving', required: true, wide: true, value: preset.description || '' },
      { name: 'date', label: 'Datum', type: 'date', value: today(), required: true },
      { name: 'amount', label: 'Bedrag (€)', type: 'money', required: true },
      { name: 'category', label: 'Categorie', type: 'select', options: EXPENSE_CATEGORIES, value: preset.category },
      { name: 'watch_id', label: 'Hoort bij horloge (optioneel)', type: 'select', value: preset.watch_id, options: [['', '—'], ...returnable.map(w => [w.id, `${wname(w)} · ${STATUS[w.status]}`])] },
      { name: 'payment', label: 'Betaling', type: 'select', value: preset.payment, options: [...paymentOptions, ['offset', 'Verrekend met terugbetaling verkoper']] },
      { name: 'paid_by', label: 'Betaald door', type: 'select', options: partners(), value: store.user?.name, show: d => d.payment === 'private' },
      { name: 'receipt', label: 'Bon', type: 'file' },
    ],
    onSubmit: async d => {
      if (d.payment === 'offset' && !d.watch_id) { toast('Kies het horloge waarvan de terugbetaling wordt verrekend', 'bad'); return false; }
      const receipt_path = await uploadReceipt(d.receipt);
      const e = await store.insert('expenses', {
        date: d.date, description: d.description, amount: n(d.amount), category: d.category, payment_status: d.payment,
        paid_by: d.payment === 'private' ? d.paid_by : null, watch_id: d.watch_id || null, receipt_path,
      });
      if (d.payment === 'paid') await addBank({ date: d.date, description: d.description, amount: -n(d.amount), type: 'expense', reference_id: `expense:${e.id}` });
      toast('Uitgave opgeslagen');
    },
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
  openForm({
    eyebrow: 'Bewerken', title: wname(w), submit: 'Wijzigingen opslaan',
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
      { name: 'extra_costs', label: 'Extra kosten (€)', type: 'money', value: w.extra_costs, hint: 'Ook service of reparatie achteraf' },
      { name: 'vat_scheme', label: 'Btw-regeling', type: 'select', value: w.vat_scheme, options: [['margin', 'Margeregeling'], ['none', 'Geen btw']] },
      ...(sold ? [
        { type: 'section', label: 'Verkoop' },
        { name: 'sale_date', label: 'Verkoopdatum', type: 'date', value: w.sale_date },
        { name: 'sale_platform', label: 'Platform', type: 'select', value: w.sale_platform, options: PLATFORMS },
        { name: 'buyer', label: 'Koper', value: w.buyer },
        { name: 'sale_price', label: 'Verkoopprijs (€)', type: 'money', value: w.sale_price },
        { name: 'sale_costs', label: 'Verkoopkosten (€)', type: 'money', value: w.sale_costs },
      ] : []),
      { name: 'photo', label: 'Nieuwe foto', type: 'file', accept: 'image/*' },
      { name: 'receipt', label: 'Bon toevoegen of vervangen', type: 'file' },
      { name: 'notes', label: 'Notities', type: 'textarea', wide: true, value: w.notes },
    ],
    onSubmit: async d => {
      const patch = { ...d }; delete patch.photo; delete patch.receipt;
      for (const k of ['estimated_value', 'purchase_price', 'extra_costs', 'sale_price', 'sale_costs']) if (k in patch) patch[k] = n(patch[k]);
      patch.box_papers = patch.box_papers || null;
      patch.total_cost = round2(patch.purchase_price + patch.extra_costs);
      if (d.photo) patch.photo_path = await uploadPhoto(d.photo);
      if (d.receipt) patch.receipt_path = await uploadReceipt(d.receipt);
      if (patch.total_cost !== n(w.total_cost)) patch.history = hist(w, `Kostprijs aangepast van ${euro(w.total_cost)} naar ${euro(patch.total_cost)}`);
      await store.update('watches', id, patch);
      // Gekoppelde bankmutaties meenemen
      const pe = S().bank_entries.find(e => e.reference_id === `purchase:${id}`);
      if (pe && n(pe.amount) !== -patch.total_cost) await store.update('bank_entries', pe.id, { amount: -patch.total_cost });
      const se = S().bank_entries.find(e => e.reference_id === `sale:${id}`);
      if (se && sold) { const net = round2(patch.sale_price - patch.sale_costs); if (n(se.amount) !== net) await store.update('bank_entries', se.id, { amount: net }); }
      toast('Opgeslagen'); $('dialog.detail')?.close(); watchDetail(id);
    },
  });
}

function customerReturnForm(id) {
  const w = watchById(id);
  const paid = w.sale_payment === 'received';
  openForm({
    eyebrow: 'Retour van klant', title: wname(w), submit: 'Retour verwerken',
    intro: paid ? 'De koper heeft al betaald. De verkoop wordt teruggedraaid en de terugbetaling wordt geboekt.' : 'De betaling is nog niet ontvangen. De verkoop wordt geannuleerd.',
    fields: [
      { name: 'date', label: 'Datum', type: 'date', value: today(), required: true },
      { name: 'reason', label: 'Reden', placeholder: 'bv. niet zoals beschreven' },
      { name: 'amount', label: 'Terug te betalen aan klant (€)', type: 'money', value: round2(n(w.sale_price) - n(w.sale_costs)), show: () => paid },
      { name: 'payment', label: 'Terugbetaling', type: 'select', options: [['paid', 'Al terugbetaald'], ['pending', 'Nog terug te betalen']], show: () => paid },
      { name: 'arrived', label: 'Horloge is al terug', type: 'select', options: [['no', 'Nee, onderweg terug'], ['yes', 'Ja, terug op voorraad']] },
    ],
    onSubmit: async d => {
      const prev = { date: w.sale_date, platform: w.sale_platform, price: w.sale_price, costs: w.sale_costs, buyer: w.buyer };
      const patch = {
        status: d.arrived === 'yes' ? 'in_stock' : 'customer_returning',
        sale_date: null, sale_platform: null, buyer: null, sale_price: null, sale_costs: 0, sale_payment: null,
        history: [...hist(w, `Verkoop teruggedraaid (${d.reason || 'retour'}); was ${euro(prev.price)} via ${prev.platform}`, d.date)],
      };
      if (paid) patch.customer_return = { date: d.date, amount: n(d.amount), reason: d.reason, payment: d.payment };
      await store.update('watches', id, patch);
      if (!paid) await removeBankRef(`sale:${id}`);
      if (paid && d.payment === 'paid') await addBank({ date: d.date, description: `Terugbetaling klant · ${wname(w)}`, amount: -n(d.amount), type: 'customer_refund', reference_id: `customer-return:${id}` });
      toast('Retour verwerkt'); $('dialog.detail')?.close();
    },
  });
}

function supplierReturnForm(id) {
  const w = watchById(id);
  openForm({
    eyebrow: 'Terug naar verkoper', title: wname(w), submit: 'Retour opslaan',
    intro: 'Gebruik dit als je het horloge terugstuurt naar de verkoper. Retourverzendkosten voeg je daarna toe als uitgave in de categorie Retourkosten.',
    fields: [
      { name: 'date', label: 'Datum', type: 'date', value: today(), required: true },
      { name: 'refund', label: 'Terugbetaling van verkoper (€)', type: 'money', value: w.total_cost },
      { name: 'payment', label: 'Terugbetaling', type: 'select', options: [['pending', 'Nog te ontvangen'], ['received', 'Al ontvangen']] },
      { name: 'reason', label: 'Reden' },
    ],
    onSubmit: async d => {
      await store.update('watches', id, {
        status: 'returned', supplier_return: { date: d.date, refund: n(d.refund), payment: d.payment, reason: d.reason },
        history: hist(w, `Teruggestuurd naar verkoper${d.reason ? ` (${d.reason})` : ''}; terugbetaling ${euro(d.refund)}`, d.date),
      });
      if (d.payment === 'received') await addBank({ date: d.date, description: `Terugbetaling verkoper · ${wname(w)}`, amount: n(d.refund) - linkedReturnCosts(S(), id), type: 'supplier_refund', reference_id: `refund:${id}` });
      toast('Retour opgeslagen'); $('dialog.detail')?.close();
    },
  });
}

function writeOffForm(id) {
  const w = watchById(id);
  openForm({
    eyebrow: 'Afschrijven', title: wname(w), submit: 'Afschrijven', danger: true,
    intro: 'Het horloge gaat uit de voorraad en het bedrag komt als verlies in het resultaat.',
    fields: [
      { name: 'date', label: 'Datum', type: 'date', value: today(), required: true },
      { name: 'amount', label: 'Af te schrijven bedrag (€)', type: 'money', value: w.total_cost },
      { name: 'reason', label: 'Reden', required: true, placeholder: 'bv. nep, kapot, kwijt' },
    ],
    onSubmit: async d => {
      await store.update('watches', id, { status: 'written_off', write_off: { date: d.date, amount: n(d.amount), reason: d.reason }, history: hist(w, `Afgeschreven: ${d.reason}`, d.date) });
      toast('Horloge afgeschreven'); $('dialog.detail')?.close();
    },
  });
}

async function deleteWatch(id) {
  const w = watchById(id);
  if (!await confirmDialog('Horloge verwijderen?', `${esc(wname(w))} en de gekoppelde bankmutaties worden definitief verwijderd. Gebruik dit alleen voor een foutieve invoer.`)) return;
  for (const p of ['purchase', 'sale', 'refund', 'customer-return']) await removeBankRef(`${p}:${id}`);
  await store.remove('watches', id);
  $('dialog.detail')?.close(); toast('Verwijderd'); render();
}

async function deleteExpense(id) {
  const e = S().expenses.find(x => x.id === id);
  if (!await confirmDialog('Uitgave verwijderen?', `${esc(e.description)} (${euro(e.amount)}) wordt verwijderd, inclusief de bankmutatie.`)) return;
  await removeBankRef(`expense:${id}`); await store.remove('expenses', id); toast('Verwijderd'); render();
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

// Openstaande post verwerken
function settleForm(pid) {
  const p = pendingPayments(S()).find(x => x.id === pid); if (!p) return;
  openForm({
    eyebrow: p.direction === 'in' ? 'Ontvangst verwerken' : 'Betaling verwerken', title: p.description, submit: 'Verwerken',
    fields: [
      { name: 'date', label: 'Datum', type: 'date', value: today(), required: true },
      { name: 'amount', label: 'Bedrag (€)', type: 'money', value: p.amount, hint: p.direction === 'in' ? 'Ontvangen op de rekening' : 'Afgeschreven van de rekening' },
    ],
    onSubmit: async d => {
      const amt = n(d.amount), [kind, id] = [p.kind, p.watchId || p.batchId || p.expenseId];
      const w = watchById(id);
      if (kind === 'sale') { await store.update('watches', id, { sale_payment: 'received', history: hist(w, 'Betaling ontvangen', d.date) }); await addBank({ date: d.date, description: `Verkoop ${wname(w)}`, amount: amt, type: 'sale', reference_id: `sale:${id}` }); }
      if (kind === 'refund') { await store.update('watches', id, { supplier_return: { ...w.supplier_return, payment: 'received' }, history: hist(w, 'Terugbetaling verkoper ontvangen', d.date) }); await addBank({ date: d.date, description: `Terugbetaling verkoper · ${wname(w)}`, amount: amt, type: 'supplier_refund', reference_id: `refund:${id}` }); }
      if (kind === 'customer-return') { await store.update('watches', id, { customer_return: { ...w.customer_return, payment: 'paid' } }); await addBank({ date: d.date, description: `Terugbetaling klant · ${wname(w)}`, amount: -amt, type: 'customer_refund', reference_id: `customer-return:${id}` }); }
      if (kind === 'purchase') { await store.update('watches', id, { purchase_payment: 'paid' }); await addBank({ date: d.date, description: `Inkoop ${wname(w)}`, amount: -amt, type: 'purchase', reference_id: `purchase:${id}` }); }
      if (kind === 'batch') { await store.update('purchase_batches', id, { payment_status: 'paid' }); await addBank({ date: d.date, description: p.description, amount: -amt, type: 'purchase', reference_id: `batch:${id}` }); }
      if (kind === 'expense') { await store.update('expenses', id, { payment_status: 'paid' }); await addBank({ date: d.date, description: p.description, amount: -amt, type: 'expense', reference_id: `expense:${id}` }); }
      toast('Verwerkt');
    },
  });
}

function bankEntryForm() {
  openForm({
    eyebrow: 'Bank', title: 'Mutatie toevoegen', submit: 'Opslaan',
    intro: 'Voor stortingen en opnames van vennoten en overige ontvangsten. Inkopen, verkopen en uitgaven worden automatisch geboekt.',
    fields: [
      { name: 'type', label: 'Soort', type: 'select', options: [['owner_deposit', 'Storting door vennoot'], ['owner_withdrawal', 'Opname door vennoot'], ['income', 'Overige ontvangst'], ['expense', 'Overige afschrijving (geen kosten)']] },
      { name: 'partner', label: 'Vennoot', type: 'select', options: partners(), value: store.user?.name, show: d => d.type.startsWith('owner') },
      { name: 'date', label: 'Datum', type: 'date', value: today(), required: true },
      { name: 'amount', label: 'Bedrag (€)', type: 'money', required: true },
      { name: 'description', label: 'Omschrijving', wide: true },
    ],
    onSubmit: async d => {
      const out = ['owner_withdrawal', 'expense'].includes(d.type);
      await addBank({ date: d.date, type: d.type, partner: d.type.startsWith('owner') ? d.partner : null, amount: Math.abs(n(d.amount)) * (out ? -1 : 1), description: d.description || (BANK_TYPES[d.type] + (d.type.startsWith('owner') ? ` · ${d.partner}` : '')) });
      toast('Mutatie opgeslagen');
    },
  });
}

function balanceForm() {
  const cur = bankBalance(S());
  openForm({
    eyebrow: 'Bank', title: 'Saldo corrigeren', submit: 'Corrigeren',
    intro: `Volgens de app is het saldo <b>${euro(cur)}</b>. Vul het echte saldo uit je bankapp in; het verschil wordt als correctie geboekt.`,
    fields: [{ name: 'balance', label: 'Werkelijk saldo (€)', type: 'money', allowNegative: true, required: true, value: cur }, { name: 'date', label: 'Datum', type: 'date', value: today() }],
    onSubmit: async d => {
      const diff = round2(n(d.balance) - cur); if (!diff) { toast('Saldo klopt al'); return; }
      await addBank({ date: d.date, type: 'correction', amount: diff, description: `Saldocorrectie (${diff > 0 ? '+' : ''}${euro(diff)})` }); toast('Saldo gecorrigeerd');
    },
  });
}

// Detailpaneel horloge
async function watchDetail(id) {
  const w = watchById(id); if (!w) return;
  const s = S().settings;
  const batch = w.batch_id && S().purchase_batches.find(b => b.id === w.batch_id);
  const days = w.purchase_date ? daysBetween(w.purchase_date, w.sale_date || today()) : null;
  const row = (l, v) => v === null || v === undefined || v === '' ? '' : `<div class="kv"><span>${l}</span><b>${v}</b></div>`;
  const acts = [];
  if (w.status === 'incoming' || w.status === 'customer_returning') acts.push(`<button class="btn primary" data-action="arrive" data-id="${id}">✓ Binnen</button>`);
  if (w.status === 'in_stock') acts.push(`<button class="btn primary" data-action="sale" data-id="${id}">Verkopen</button>`);
  if (w.status === 'sold') acts.push(`<button class="btn" data-action="customer-return" data-id="${id}">Retour van klant</button>`);
  if (['in_stock', 'incoming'].includes(w.status)) acts.push(`<button class="btn" data-action="supplier-return" data-id="${id}">Terug naar verkoper</button>`, `<button class="btn" data-action="write-off" data-id="${id}">Afschrijven</button>`);
  acts.push(`<button class="btn" data-action="edit-watch" data-id="${id}">Bewerken</button>`, `<button class="btn ghost danger-text" data-action="delete-watch" data-id="${id}">Verwijderen</button>`);
  const dlg = openDialog(`<div class="modal-body wide">
    <header><div><div class="eyebrow">${esc(w.reference || 'Horloge')}</div><h2>${esc(wname(w))}</h2><div>${statusChip(w.status)}</div></div><button class="x" data-close aria-label="Sluiten">×</button></header>
    <div class="detail-grid">
      <div class="photo big" data-photo="${esc(w.photo_path || '')}"><span>${esc(w.brand?.[0] || '◷')}</span></div>
      <div>
        ${(() => { const r = row('Referentie', esc(w.reference)) + row('Serienummer', esc(w.serial)) + row('Bouwjaar', esc(w.year)) + row('Staat', esc(w.condition)) + row('Box & papieren', BOX_PAPERS[w.box_papers]); return r ? `<h3>Horloge</h3>${r}` : ''; })()}
        <h3>Inkoop</h3>
        ${row('Datum', fdate(w.purchase_date))}${row('Platform', esc(w.purchase_platform))}${row('Verkoper', esc(w.seller))}
        ${row('Inkoopprijs', euro(w.purchase_price))}${row(batch ? 'Aandeel bundelkosten' : 'Extra kosten', euro(w.extra_costs))}${row('Kostprijs', `<span class="big-num">${euro(w.total_cost)}</span>`)}
        ${row('Betaling', { paid: 'Betaald', pending: 'Nog te betalen', private: `Privé · ${esc(w.purchase_paid_by)}`, batch: batch ? `Via bundel (${batch.payment_status === 'pending' ? 'nog te betalen' : 'betaald'})` : 'Bundel' }[w.purchase_payment])}
        ${ACTIVE.includes(w.status) ? row('Geschatte waarde', w.estimated_value ? euro(w.estimated_value) : '—') + row('Dagen in bezit', days) : ''}
        ${w.status === 'sold' ? `<h3>Verkoop</h3>${row('Datum', fdate(w.sale_date))}${row('Platform', esc(w.sale_platform))}${row('Koper', esc(w.buyer))}${row('Verkoopprijs', euro(w.sale_price))}${row('Verkoopkosten', euro(w.sale_costs))}${s.vat_enabled && w.vat_scheme === 'margin' ? row('Btw (marge)', euro(marginVat(w, s))) : ''}${row('Winst', signed(watchProfit(w, s)))}${row('Doorlooptijd', `${days} dagen`)}${row('Betaling', w.sale_payment === 'pending' ? 'Nog te ontvangen' : 'Ontvangen')}` : ''}
        ${w.supplier_return ? `<h3>Retour naar verkoper</h3>${row('Datum', fdate(w.supplier_return.date))}${row('Terugbetaling', euro(w.supplier_return.refund))}${row('Status', w.supplier_return.payment === 'pending' ? 'Nog te ontvangen' : 'Ontvangen')}` : ''}
        ${w.write_off ? `<h3>Afschrijving</h3>${row('Datum', fdate(w.write_off.date))}${row('Bedrag', euro(w.write_off.amount))}${row('Reden', esc(w.write_off.reason))}` : ''}
        ${(w.receipt_path || batch?.receipt_path) ? `<p><button class="link" data-action="file" data-path="${esc(w.receipt_path || batch.receipt_path)}">📎 Bon bekijken</button></p>` : ''}
        ${w.notes ? `<h3>Notities</h3><p class="notes">${esc(w.notes)}</p>` : ''}
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
    const h = new Date().getHours(), greet = h < 12 ? 'Goedemorgen' : h < 18 ? 'Goedemiddag' : 'Goedenavond';
    const recent = [...st.watches].sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at))).slice(0, 6);
    return head(`${greet}, ${esc(store.user?.name || '')}`, 'Zo staat LUMAR ervoor.') + `
      <section class="stats">
        ${stat(`Resultaat ${y.label}`, signed(c.result), `${c.soldCount} verkocht · omzet ${euro(c.revenue)}`, 'data-go="reports"')}
        ${stat('Voorraad', euro(all.stock), `${all.stockCount} ${all.stockCount === 1 ? 'horloge' : 'horloges'} · geschat ${euro(all.stockEstimated)}`, 'data-go="stock"')}
        ${stat('Banksaldo', euro(bal), `verwacht ${euro(bal + recv - pay)}`, 'data-go="bank"')}
        ${stat('Openstaand', `<span class="good">+${euro(recv)}</span> <span class="bad">−${euro(pay)}</span>`, 'te ontvangen / te betalen', 'data-go="bank"')}
      </section>
      <section class="cols">
        <div class="card"><div class="card-head"><h2>Actie nodig</h2><span class="badge">${acts.length}</span></div>
          ${acts.length ? `<ul class="list">${acts.slice(0, 8).map(a => `<li ${a.watchId ? `data-action="watch" data-id="${a.watchId}"` : a.kind === 'receipt' ? `data-action="receipt-expense" data-id="${a.expenseId}"` : 'data-go="bank"'}><div><b>${esc(a.description)}</b><small>${a.reason} · ${fdate(a.date)}</small></div>${a.amount !== undefined ? `<span class="${a.direction === 'in' ? 'good' : 'bad'}">${a.direction === 'in' ? '+' : '−'}${euro(a.amount)}</span>` : '<span class="chev">›</span>'}</li>`).join('')}</ul>` : empty('Alles is bijgewerkt.')}
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
    const byCat = EXPENSE_CATEGORIES.map(cat => [cat, list.filter(e => e.category === cat).reduce((a, e) => a + n(e.amount), 0)]).filter(x => x[1]);
    const total = list.reduce((a, e) => a + n(e.amount), 0);
    const pay = e => ({ paid: 'Zakelijk', pending: '<span class="chip warn">Te betalen</span>', private: `Privé · ${esc(e.paid_by)}`, offset: 'Verrekend' })[e.payment_status] || '';
    return head('Uitgaven', `${euro(total)} · ${r.label}`, `${periodSelect(ui.expensePeriod, 'expensePeriod')}<button class="btn primary" data-action="expense">＋ Uitgave</button>`) + `
      ${byCat.length ? `<section class="pills">${byCat.map(([c, v]) => `<div><span>${esc(c)}</span><b>${euro(v)}</b></div>`).join('')}</section>` : ''}
      ${list.length ? `<div class="card flush"><table class="table"><thead><tr><th>Datum</th><th>Omschrijving</th><th>Categorie</th><th>Betaling</th><th>Bon</th><th class="r">Bedrag</th><th></th></tr></thead><tbody>
        ${list.map(e => `<tr><td>${fdate(e.date)}</td><td><b>${esc(e.description)}</b>${e.watch_id ? `<small class="muted"> · ${esc(wname(watchById(e.watch_id)))}</small>` : ''}</td><td>${esc(e.category)}</td><td>${pay(e)}</td>
          <td>${e.receipt_path ? `<button class="link" data-action="file" data-path="${esc(e.receipt_path)}">📎 Bekijk</button>` : `<button class="link muted" data-action="receipt-expense" data-id="${e.id}">＋ Bon</button>`}</td>
          <td class="r">${euro(e.amount)}</td><td class="r"><button class="x" data-action="delete-expense" data-id="${e.id}" title="Verwijderen">×</button></td></tr>`).join('')}
      </tbody></table></div>` : empty('Nog geen uitgaven in deze periode.')}`;
  },

  bank() {
    const st = S(), bal = bankBalance(st), pend = pendingPayments(st);
    const recv = pend.filter(p => p.direction === 'in').reduce((a, p) => a + p.amount, 0), pay = pend.filter(p => p.direction === 'out').reduce((a, p) => a + p.amount, 0);
    const entries = [...st.bank_entries].sort((a, b) => b.date.localeCompare(a.date) || String(b.created_at).localeCompare(String(a.created_at)));
    const manual = ['owner_deposit', 'owner_withdrawal', 'income', 'correction', 'expense'];
    return head('Bank', 'Zakelijke rekening, bijgewerkt door elke betaalde inkoop, verkoop en uitgave.', '<button class="btn" data-action="balance">Saldo corrigeren</button><button class="btn primary" data-action="bank-entry">＋ Mutatie</button>') + `
      <section class="stats">${stat('Saldo', euro(bal))}${stat('Te ontvangen', `<span class="good">${euro(recv)}</span>`)}${stat('Te betalen', `<span class="bad">${euro(pay)}</span>`)}${stat('Verwacht saldo', euro(bal + recv - pay))}</section>
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
      ${s.vat_enabled ? `<section class="card"><div class="card-head"><h2>Btw per kwartaal ${year}</h2><small class="muted">margeregeling, indicatief — laat je aangifte controleren</small></div><table class="table compact"><thead><tr><th>Kwartaal</th><th class="r">Verkocht</th><th class="r">Omzet</th><th class="r">Af te dragen btw</th></tr></thead><tbody>${quarterlyVat(st, year).map(q => `<tr><td>${q.quarter}</td><td class="r">${q.count}</td><td class="r">${euro(q.revenue)}</td><td class="r"><b>${euro(q.vat)}</b></td></tr>`).join('')}</tbody></table></section>` : ''}`;
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
    return head('Instellingen') + `
      <section class="card"><div class="card-head"><h2>Btw</h2></div>
        <label class="check"><input type="checkbox" data-setting="vat_enabled" ${s.vat_enabled ? 'checked' : ''}> Btw berekenen volgens de margeregeling</label>
        <p class="muted">Per verkocht horloge: (verkoopprijs − inkoopprijs) × ${s.vat_rate}/${100 + n(s.vat_rate)}. Zet dit uit als jullie onder de kleineondernemersregeling (KOR) vallen. Laat dit altijd controleren door een boekhouder.</p>
      </section>
      <section class="card"><div class="card-head"><h2>Winstverdeling</h2></div>
        <div class="grid">${partners().map(p => `<label class="field"><span>${esc(p)} (%)</span><input type="number" min="0" max="100" data-share="${esc(p)}" value="${n(s.profit_shares?.[p] ?? 100 / partners().length)}"></label>`).join('')}</div>
        <button class="btn" data-action="save-shares">Verdeling opslaan</button>
      </section>
      <section class="card"><div class="card-head"><h2>App</h2></div>
        <p>Ingelogd als <b>${esc(store.user?.name)}</b>${store.user?.email ? ` (${esc(store.user.email)})` : ''}.</p>
        <p class="muted">${store.mode === 'demo' ? '⚠︎ Demomodus: de gegevens staan alleen in deze browser. Koppel Supabase via js/config.js om samen te werken.' : 'Verbonden met de gedeelde LUMAR-database. Wijzigingen zijn direct zichtbaar voor jullie allebei.'}</p>
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
  const main = $('#main');
  const scroll = main.scrollTop;
  main.innerHTML = pages[page]();
  main.scrollTop = scroll;
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.page === page));
  loadPhotos(main);
  const search = $('#stockSearch');
  if (search) search.oninput = () => { ui.stockSearch = search.value; const pos = search.selectionStart; render(); const s2 = $('#stockSearch'); s2.focus(); s2.setSelectionRange(pos, pos); };
}

function go(p) { page = pages[p] ? p : 'dashboard'; location.hash = page; $('#main').scrollTop = 0; render(); }

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

document.addEventListener('change', async e => {
  const p = e.target.closest('select.period');
  if (p) { ui[p.dataset.uikey] = p.value; render(); return; }
  const s = e.target.closest('[data-setting]');
  if (s) { try { await store.setSetting(s.dataset.setting, s.type === 'checkbox' ? s.checked : s.value); toast('Opgeslagen'); render(); } catch (err) { toast(err.message, 'bad'); } }
});

// ───────────── Start ─────────────
function showAuth(msg = '') {
  $('#app').hidden = true; $('#auth').hidden = false; $('#authStatus').textContent = msg;
}
function showApp() {
  $('#auth').hidden = true; $('#app').hidden = false;
  $('#me').innerHTML = `<span class="avatar">${esc(store.user.name[0])}</span><div><b>${esc(store.user.name)}</b><small>${store.mode === 'demo' ? 'Demomodus' : 'Verbonden'}</small></div>`;
  go(location.hash.slice(1) || 'dashboard');
}

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const d = formValues(e.target), btn = $('button', e.target);
  btn.disabled = true; $('#authStatus').textContent = 'Bezig met inloggen…';
  try { await store.signIn(d.email.trim(), d.password); showApp(); }
  catch (err) { $('#authStatus').textContent = /invalid/i.test(err.message) ? 'E-mailadres of wachtwoord klopt niet.' : err.message; }
  finally { btn.disabled = false; }
});

window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); window.__installPrompt = e; const b = $('#installBtn'); if (b) b.hidden = false; });
window.addEventListener('hashchange', () => { const p = location.hash.slice(1); if (p && p !== page && pages[p]) go(p); });

async function boot() {
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
  try { store = await createStore(config, () => { if (!document.querySelector('dialog[open] form')) render(); }); }
  catch (err) { showAuth('Kan de database niet bereiken. Controleer je internetverbinding. (' + err.message + ')'); return; }
  if (store.mode === 'demo') {
    $('#authHint').innerHTML = '<b>Demomodus</b> — er is nog geen database gekoppeld. Gegevens blijven alleen in deze browser. Vul je naam in als e-mail (bv. <i>luuk@lumar.nl</i>); een wachtwoord is niet nodig.';
    $('#loginForm [name=email]').type = 'text';
  }
  let ok = false;
  try { ok = await store.init(); } catch (err) { showAuth(err.message); return; }
  ok ? showApp() : showAuth();
}
boot();
