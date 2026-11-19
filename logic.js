// LUMAR — rekenlogica (los van de interface, zodat het te testen is)
//
// Boekhoudprincipes:
// - Kostprijs horloge = inkoopprijs + extra kosten. Kosten die achteraf aan een horloge worden toegevoegd
//   (bv. service) zijn uitgaven met capitalized = true: ze verhogen de kostprijs en tellen NIET als bedrijfskosten.
// - Alles wat betaald/ontvangen is, staat precies één keer als bankmutatie met een reference_id.
// - Wat nog open staat (te betalen/ontvangen) zit in pendingPayments en nog niet in de bank.
// - reconcile() bewijst dat alles sluit: bank + voorraad + te ontvangen − te betalen − btw-schuld = eigen vermogen.

export const n = v => (v === null || v === undefined || v === '' || isNaN(+v)) ? 0 : +v;
export const round2 = v => Math.round(n(v) * 100) / 100;
const eq = (a, b) => Math.abs(round2(a) - round2(b)) < 0.005;

export const STATUS = {
  incoming: 'Onderweg',
  in_stock: 'Op voorraad',
  customer_returning: 'Retour onderweg',
  sold: 'Verkocht',
  returned: 'Terug naar verkoper',
  written_off: 'Afgeschreven',
};
export const ACTIVE = ['incoming', 'in_stock', 'customer_returning'];

export const PLATFORMS = ['Vinted', 'Marktplaats', 'Chrono24', 'Catawiki', 'eBay', 'Instagram', 'Leverancier', 'Particulier', 'Anders'];
export const EXPENSE_CATEGORIES = ['Algemeen', 'Verzending', 'Retourkosten', 'Verpakking', 'Reparatie & service', 'Website & software', 'Marketing', 'Abonnementen'];
export const BOX_PAPERS = { full: 'Box & papieren', box: 'Alleen box', papers: 'Alleen papieren', none: 'Geen' };
export const BANK_TYPES = {
  sale: 'Verkoop', purchase: 'Inkoop', expense: 'Uitgave', owner_deposit: 'Storting vennoot',
  owner_withdrawal: 'Opname vennoot', supplier_refund: 'Terugbetaling verkoper',
  customer_refund: 'Terugbetaling klant', income: 'Overige opbrengst', correction: 'Saldocorrectie',
  vat_payment: 'Btw-afdracht',
};
export const MANUAL_BANK_TYPES = ['owner_deposit', 'owner_withdrawal', 'income', 'correction', 'vat_payment'];

// Verdeel een bedrag over gewichten tot op de cent (restcenten naar grootste restwaarden)
export function splitMoney(total, weights) {
  const cents = Math.round(n(total) * 100);
  const safe = weights.map(x => Math.max(0, n(x)));
  const sum = safe.reduce((a, b) => a + b, 0);
  if (!safe.length) return [];
  const raw = safe.map(x => sum ? cents * x / sum : cents / safe.length);
  const parts = raw.map(Math.floor);
  let rest = cents - parts.reduce((a, b) => a + b, 0);
  raw.map((x, i) => ({ i, r: x - parts[i] })).sort((a, b) => b.r - a.r).slice(0, rest).forEach(x => parts[x.i]++);
  return parts.map(x => x / 100);
}

// Btw volgens de margeregeling (per horloge): marge = verkoopprijs − inkoopprijs; btw = marge × 21/121
export function marginVat(w, settings) {
  if (!settings?.vat_enabled || w.vat_scheme !== 'margin' || w.status !== 'sold') return 0;
  const rate = n(settings.vat_rate ?? 21);
  const margin = n(w.sale_price) - n(w.purchase_price);
  return margin > 0 ? round2(margin * rate / (100 + rate)) : 0;
}

export const watchProfit = (w, settings) =>
  round2(n(w.sale_price) - n(w.sale_costs) - n(w.total_cost) - marginVat(w, settings));

export const inPeriod = (date, from, to) => !!date && (!from || date >= from) && (!to || date <= to);
export const customerReturns = w => Array.isArray(w.customer_returns) ? w.customer_returns : [];

// Kosten die achteraf aan de kostprijs van een horloge zijn toegevoegd
export const capitalizedSum = (state, watchId) =>
  round2(state.expenses.filter(e => e.capitalized && e.watch_id === watchId).reduce((a, e) => a + n(e.amount), 0));
// Wat er bij de inkoop zelf betaald is (kostprijs zonder later toegevoegde kosten)
export const purchaseAmount = (state, w) => round2(n(w.total_cost) - capitalizedSum(state, w.id));

export function linkedReturnCosts(state, watchId) {
  return round2(state.expenses.filter(e => e.watch_id === watchId && e.category === 'Retourkosten' && !e.capitalized && e.payment_status === 'offset')
    .reduce((a, e) => a + n(e.amount), 0));
}

// Resultaat over een periode (from/to als 'YYYY-MM-DD', leeg = alles)
export function calc(state, { from = '', to = '' } = {}) {
  const s = state.settings || {};
  const sold = state.watches.filter(w => w.status === 'sold' && inPeriod(w.sale_date, from, to));
  const revenue = sold.reduce((a, w) => a + n(w.sale_price), 0);
  const vat = sold.reduce((a, w) => a + marginVat(w, s), 0);
  const cogs = sold.reduce((a, w) => a + n(w.total_cost), 0);
  const saleCosts = sold.reduce((a, w) => a + n(w.sale_costs), 0);
  // Afschrijven = de volledige kostprijs gaat uit de voorraad naar het resultaat
  const writeOff = state.watches.filter(w => w.status === 'written_off' && inPeriod(w.write_off?.date, from, to))
    .reduce((a, w) => a + n(w.total_cost), 0);
  // Retour naar verkoper: verschil tussen terugbetaling en kostprijs
  const returnResult = state.watches.filter(w => w.status === 'returned' && inPeriod(w.supplier_return?.date, from, to))
    .reduce((a, w) => a + n(w.supplier_return?.refund) - n(w.total_cost), 0);
  // Retour van klant na betaling: wat we ontvingen minus wat we terugbetalen
  const customerReturnResult = state.watches.reduce((a, w) => a + customerReturns(w)
    .filter(r => inPeriod(r.date, from, to)).reduce((b, r) => b + n(r.received) - n(r.amount), 0), 0);
  const expenses = state.expenses.filter(e => !e.capitalized && inPeriod(e.date, from, to)).reduce((a, e) => a + n(e.amount), 0);
  const otherIncome = state.bank_entries.filter(e => e.type === 'income' && inPeriod(e.date, from, to)).reduce((a, e) => a + n(e.amount), 0);
  const corrections = state.bank_entries.filter(e => e.type === 'correction' && inPeriod(e.date, from, to)).reduce((a, e) => a + n(e.amount), 0);
  const stock = state.watches.filter(w => ACTIVE.includes(w.status)).reduce((a, w) => a + n(w.total_cost), 0);
  const stockEstimated = state.watches.filter(w => ACTIVE.includes(w.status))
    .reduce((a, w) => a + n(w.estimated_value || w.total_cost), 0);
  const netRevenue = revenue - vat;
  const grossProfit = netRevenue - cogs;
  const result = grossProfit - saleCosts - expenses - writeOff + returnResult + customerReturnResult + otherIncome + corrections;
  return {
    revenue: round2(revenue), vat: round2(vat), netRevenue: round2(netRevenue), cogs: round2(cogs),
    grossProfit: round2(grossProfit), saleCosts: round2(saleCosts), expenses: round2(expenses),
    writeOff: round2(writeOff), returnResult: round2(returnResult), customerReturnResult: round2(customerReturnResult),
    otherIncome: round2(otherIncome), corrections: round2(corrections), result: round2(result),
    stock: round2(stock), stockEstimated: round2(stockEstimated), soldCount: sold.length,
    stockCount: state.watches.filter(w => ACTIVE.includes(w.status)).length,
  };
}

export const bankBalance = state => round2(state.bank_entries.reduce((a, e) => a + n(e.amount), 0));

// Btw die nog afgedragen moet worden (berekend − al betaald)
export function vatOwed(state) {
  const s = state.settings || {};
  const due = state.watches.reduce((a, w) => a + marginVat(w, s), 0);
  const paid = state.bank_entries.filter(e => e.type === 'vat_payment').reduce((a, e) => a + Math.abs(n(e.amount)), 0);
  return round2(due - paid);
}

// Openstaande betalingen (in = te ontvangen, out = te betalen)
export function pendingPayments(state) {
  const list = [];
  const name = w => `${w.brand} ${w.model}`;
  for (const w of state.watches) {
    if (w.status === 'sold' && w.sale_payment === 'pending')
      list.push({ id: `sale:${w.id}`, kind: 'sale', watchId: w.id, date: w.sale_date, description: `Verkoop ${name(w)}`, amount: round2(n(w.sale_price) - n(w.sale_costs)), direction: 'in' });
    if (w.status === 'returned' && w.supplier_return?.payment === 'pending')
      list.push({ id: `refund:${w.id}`, kind: 'refund', watchId: w.id, date: w.supplier_return.date, description: `Terugbetaling verkoper · ${name(w)}`, amount: round2(n(w.supplier_return.refund) - linkedReturnCosts(state, w.id)), direction: 'in' });
    customerReturns(w).forEach((r, i) => {
      if (r.payment === 'pending')
        list.push({ id: `customer-return:${w.id}:${i}`, kind: 'customer-return', watchId: w.id, index: i, date: r.date, description: `Terugbetaling klant · ${name(w)}`, amount: round2(r.amount), direction: 'out' });
    });
    if (!w.batch_id && w.purchase_payment === 'pending')
      list.push({ id: `purchase:${w.id}`, kind: 'purchase', watchId: w.id, date: w.purchase_date, description: `Inkoop ${name(w)}`, amount: purchaseAmount(state, w), direction: 'out' });
  }
  for (const b of state.purchase_batches.filter(b => b.payment_status === 'pending')) {
    const count = state.watches.filter(w => w.batch_id === b.id).length;
    list.push({ id: `batch:${b.id}`, kind: 'batch', batchId: b.id, date: b.purchase_date, description: `${b.platform || 'Bundel'}-bestelling · ${count} ${count === 1 ? 'horloge' : 'horloges'}`, amount: round2(b.total_cost), direction: 'out' });
  }
  for (const e of state.expenses.filter(e => e.payment_status === 'pending'))
    list.push({ id: `expense:${e.id}`, kind: 'expense', expenseId: e.id, date: e.date, description: e.description, amount: round2(e.amount), direction: 'out' });
  return list.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

// Privé voorgeschoten door een vennoot (telt als inbreng)
function privatePaidBy(state, p) {
  return round2(
    state.watches.filter(w => !w.batch_id && w.purchase_payment === 'private' && w.purchase_paid_by === p).reduce((a, w) => a + purchaseAmount(state, w), 0)
    + state.purchase_batches.filter(b => b.payment_status === 'private' && b.paid_by === p).reduce((a, b) => a + n(b.total_cost), 0)
    + state.expenses.filter(e => e.payment_status === 'private' && e.paid_by === p).reduce((a, e) => a + n(e.amount), 0));
}

// Kapitaal per vennoot: stortingen − opnames + privé betaalde kosten + winstaandeel
export function partnerCapital(state) {
  const s = state.settings || {};
  const partners = s.partners || ['Luuk', 'Marijn'];
  const shares = s.profit_shares || {};
  const result = calc(state).result;
  // Winst tot op de cent verdelen, zodat de som van de aandelen exact het resultaat is
  const shareList = partners.map(p => n(shares[p] ?? 100 / partners.length));
  const profitParts = splitMoney(Math.abs(result), shareList).map(x => result < 0 ? -x : x);
  return partners.map((p, i) => {
    const deposits = state.bank_entries.filter(e => e.type === 'owner_deposit' && e.partner === p).reduce((a, e) => a + n(e.amount), 0);
    const withdrawals = state.bank_entries.filter(e => e.type === 'owner_withdrawal' && e.partner === p).reduce((a, e) => a + Math.abs(n(e.amount)), 0);
    const priv = privatePaidBy(state, p);
    const share = shareList[i];
    const profitShare = profitParts[i];
    return {
      partner: p, deposits: round2(deposits), withdrawals: round2(withdrawals), privatePaid: round2(priv),
      contribution: round2(deposits + priv - withdrawals), share, profitShare: round2(profitShare),
      capital: round2(deposits + priv - withdrawals + profitShare),
    };
  });
}

// ───────────── Controle: sluit de boekhouding? ─────────────
export function reconcile(state) {
  const issues = [];
  const add = (area, text) => issues.push({ area, text });
  const name = w => `${w.brand} ${w.model}`;
  const byRef = new Map();
  for (const e of state.bank_entries) if (e.reference_id) { const l = byRef.get(e.reference_id) || []; l.push(e); byRef.set(e.reference_id, l); }
  const expectEntry = (ref, amount, label, area) => {
    const l = byRef.get(ref) || [];
    if (l.length === 0) add(area, `${label}: bankmutatie ontbreekt (verwacht ${amount.toFixed(2)})`);
    else if (l.length > 1) add(area, `${label}: ${l.length} bankmutaties in plaats van 1`);
    else if (!eq(l[0].amount, amount)) add(area, `${label}: bankmutatie is ${n(l[0].amount).toFixed(2)}, verwacht ${amount.toFixed(2)}`);
  };
  const expectNone = (ref, label, area) => { if ((byRef.get(ref) || []).length) add(area, `${label}: er staat een bankmutatie terwijl de betaling nog open staat`); };
  const watchIds = new Set(state.watches.map(w => w.id)), batchIds = new Set(state.purchase_batches.map(b => b.id)), expenseIds = new Set(state.expenses.map(e => e.id));

  for (const w of state.watches) {
    const label = name(w);
    if (!eq(w.total_cost, n(w.purchase_price) + n(w.extra_costs))) add('Voorraad', `${label}: kostprijs ${n(w.total_cost).toFixed(2)} ≠ inkoopprijs + extra kosten`);
    if (capitalizedSum(state, w.id) - n(w.extra_costs) > 0.005) add('Voorraad', `${label}: toegevoegde kosten zijn hoger dan de extra kosten`);
    if (!w.batch_id) {
      if (w.purchase_payment === 'paid') expectEntry(`purchase:${w.id}`, -purchaseAmount(state, w), `Inkoop ${label}`, 'Inkoop');
      else expectNone(`purchase:${w.id}`, `Inkoop ${label}`, 'Inkoop');
    } else if (!batchIds.has(w.batch_id)) add('Inkoop', `${label}: hoort bij een bundel die niet meer bestaat`);
    if (w.status === 'sold') {
      if (!w.sale_date || !n(w.sale_price)) add('Verkoop', `${label}: verkocht zonder datum of verkoopprijs`);
      if (w.sale_payment === 'received') expectEntry(`sale:${w.id}`, round2(n(w.sale_price) - n(w.sale_costs)), `Verkoop ${label}`, 'Verkoop');
      else expectNone(`sale:${w.id}`, `Verkoop ${label}`, 'Verkoop');
    } else if ((byRef.get(`sale:${w.id}`) || []).length) add('Verkoop', `${label}: niet verkocht maar er staat wel een verkoop in de bank`);
    if (w.status === 'returned') {
      const ref = `refund:${w.id}`;
      if (w.supplier_return?.payment === 'received') expectEntry(ref, round2(n(w.supplier_return.refund) - linkedReturnCosts(state, w.id)), `Terugbetaling ${label}`, 'Retouren');
      else expectNone(ref, `Terugbetaling ${label}`, 'Retouren');
    }
    customerReturns(w).forEach((r, i) => {
      const ref = `customer-return:${w.id}:${i}`;
      if (r.payment === 'paid') expectEntry(ref, -round2(r.amount), `Klantretour ${label}`, 'Retouren'); else expectNone(ref, `Klantretour ${label}`, 'Retouren');
      expectEntry(`cr-sale:${w.id}:${i}`, round2(r.received), `Oorspronkelijke verkoop (retour) ${label}`, 'Retouren');
    });
  }
  for (const b of state.purchase_batches) {
    const members = state.watches.filter(w => w.batch_id === b.id);
    const label = `Bundel ${b.platform || ''} ${b.purchase_date || ''}`.trim();
    if (!members.length) add('Inkoop', `${label}: bevat geen horloges meer`);
    const sum = round2(members.reduce((a, w) => a + purchaseAmount(state, w), 0));
    if (members.length && !eq(sum, b.total_cost)) add('Inkoop', `${label}: totaal ${n(b.total_cost).toFixed(2)} ≠ som van de horloges ${sum.toFixed(2)}`);
    if (b.payment_status === 'paid') expectEntry(`batch:${b.id}`, -round2(b.total_cost), label, 'Inkoop'); else expectNone(`batch:${b.id}`, label, 'Inkoop');
  }
  for (const e of state.expenses) {
    if (e.payment_status === 'paid') expectEntry(`expense:${e.id}`, -round2(e.amount), `Uitgave ${e.description}`, 'Uitgaven');
    else expectNone(`expense:${e.id}`, `Uitgave ${e.description}`, 'Uitgaven');
    if (e.capitalized && !watchIds.has(e.watch_id)) add('Uitgaven', `${e.description}: hoort bij de kostprijs van een horloge dat niet meer bestaat`);
    if (e.payment_status === 'offset') {
      const w = state.watches.find(x => x.id === e.watch_id);
      if (!w || w.status !== 'returned') add('Uitgaven', `${e.description}: verrekend met een terugbetaling, maar het horloge is niet teruggestuurd`);
    }
  }
  // Bankmutaties die naar iets verwijzen dat niet (meer) bestaat
  for (const e of state.bank_entries) {
    if (!e.reference_id) { if (!MANUAL_BANK_TYPES.includes(e.type)) add('Bank', `Mutatie "${e.description}" zonder koppeling`); continue; }
    const [kind, id] = e.reference_id.split(':');
    if (kind === 'vat') { if (e.type !== 'vat_payment') add('Bank', `Mutatie "${e.description}" is gekoppeld aan de btw maar is geen btw-afdracht`); continue; }
    const exists = { purchase: watchIds, sale: watchIds, refund: watchIds, 'customer-return': watchIds, 'cr-sale': watchIds, batch: batchIds, expense: expenseIds }[kind];
    if (!exists || !exists.has(id)) add('Bank', `Mutatie "${e.description}" (${n(e.amount).toFixed(2)}) verwijst naar iets dat niet meer bestaat`);
  }

  // Balans: wat het bedrijf heeft = wat de vennoten erin hebben + het resultaat
  const c = calc(state), pend = pendingPayments(state);
  const bank = bankBalance(state);
  const receivable = round2(pend.filter(p => p.direction === 'in').reduce((a, p) => a + p.amount, 0));
  const payable = round2(pend.filter(p => p.direction === 'out').reduce((a, p) => a + p.amount, 0));
  const vat = vatOwed(state);
  const partners = (state.settings?.partners || ['Luuk', 'Marijn']);
  const deposits = round2(state.bank_entries.filter(e => e.type === 'owner_deposit').reduce((a, e) => a + n(e.amount), 0));
  const withdrawals = round2(state.bank_entries.filter(e => e.type === 'owner_withdrawal').reduce((a, e) => a + Math.abs(n(e.amount)), 0));
  const privatePaid = round2(partners.reduce((a, p) => a + privatePaidBy(state, p), 0));
  const assets = round2(bank + c.stock + receivable - payable - vat);
  const equity = round2(deposits - withdrawals + privatePaid + c.result);
  const diff = round2(assets - equity);
  if (!eq(diff, 0)) add('Balans', `Balans sluit niet: verschil van ${diff.toFixed(2)}`);
  return { ok: issues.length === 0, issues, bank, stock: c.stock, receivable, payable, vat, assets, deposits, withdrawals, privatePaid, result: c.result, equity, diff };
}

// Wat moet er nog gebeuren
export function actionItems(state) {
  const items = pendingPayments(state).map(p => ({ ...p, reason: p.direction === 'in' ? 'Nog te ontvangen' : 'Nog te betalen' }));
  const today = new Date().toISOString().slice(0, 10);
  for (const w of state.watches) {
    if (w.status === 'incoming' && w.purchase_date && daysBetween(w.purchase_date, today) > 10)
      items.push({ id: `late:${w.id}`, kind: 'late', watchId: w.id, date: w.purchase_date, description: `${w.brand} ${w.model}`, reason: `Al ${daysBetween(w.purchase_date, today)} dagen onderweg` });
  }
  if (state.settings?.vat_enabled) {
    const y = +today.slice(0, 4), q = quarterOf(today);
    for (const [yy, qq] of [[q === 1 ? y - 1 : y, q === 1 ? 4 : q - 1], [y, q]]) {
      const v = vatReturn(state, yy, qq);
      const daysLeft = daysBetween(today, v.deadline);
      if (v.open > 0.005 && daysLeft <= 31 && today > v.to)
        items.push({ id: `vat:${yy}-${qq}`, kind: 'vat', date: v.deadline, description: `Btw-aangifte K${qq} ${yy}`, reason: daysLeft < 0 ? `Deadline ${-daysLeft} dagen verstreken` : `Uiterlijk over ${daysLeft} dagen`, amount: v.open, direction: 'out' });
    }
  }
  for (const r of missingReceipts(state))
    items.push({ id: `receipt:${r.table}:${r.id}`, kind: 'receipt', table: r.table, recordId: r.id, date: r.date, description: r.description, reason: 'Bon ontbreekt' });
  return items;
}

// Alle boekingen waar een bon bij hoort
export function receiptRecords(state) {
  const out = [];
  for (const w of state.watches.filter(w => !w.batch_id))
    out.push({ table: 'watches', id: w.id, date: w.purchase_date, description: `Inkoop ${w.brand} ${w.model}`, kind: 'Inkoop', amount: purchaseAmount(state, w), path: w.receipt_path });
  for (const b of state.purchase_batches)
    out.push({ table: 'purchase_batches', id: b.id, date: b.purchase_date, description: (c => `${b.platform || 'Bundel'}-bestelling · ${c} ${c === 1 ? 'horloge' : 'horloges'}`)(state.watches.filter(w => w.batch_id === b.id).length), kind: 'Inkoop (bundel)', amount: round2(b.total_cost), path: b.receipt_path });
  for (const e of state.expenses)
    out.push({ table: 'expenses', id: e.id, date: e.date, description: e.description, kind: e.capitalized ? 'Kosten horloge' : 'Uitgave', amount: round2(e.amount), path: e.receipt_path });
  return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}
export const missingReceipts = state => receiptRecords(state).filter(r => !r.path && r.amount >= 10);

export function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 864e5);
}

// Resultaat per maand voor de laatste `count` maanden tot en met `endMonth` ('YYYY-MM')
export function monthlyResults(state, endMonth, count = 12) {
  const [y, m] = endMonth.split('-').map(Number);
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const key = d.toISOString().slice(0, 7);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const c = calc(state, { from: `${key}-01`, to: last });
    out.push({ month: key, result: c.result, revenue: c.revenue });
  }
  return out;
}

export function quarterlyVat(state, year) {
  const s = state.settings || {};
  return [1, 2, 3, 4].map(q => {
    const from = `${year}-${String(q * 3 - 2).padStart(2, '0')}-01`;
    const to = new Date(Date.UTC(year, q * 3, 0)).toISOString().slice(0, 10);
    const sold = state.watches.filter(w => w.status === 'sold' && inPeriod(w.sale_date, from, to));
    const paid = state.bank_entries.filter(e => e.type === 'vat_payment' && inPeriod(e.date, from, to)).reduce((a, e) => a + Math.abs(n(e.amount)), 0);
    return { quarter: `K${q} ${year}`, count: sold.length, vat: round2(sold.reduce((a, w) => a + marginVat(w, s), 0)), revenue: round2(sold.reduce((a, w) => a + n(w.sale_price), 0)), paid: round2(paid) };
  });
}

// Groepeer verkochte horloges (bv. per merk of platform)
export function groupSold(state, key, { from = '', to = '' } = {}) {
  const s = state.settings || {};
  const map = new Map();
  for (const w of state.watches.filter(w => w.status === 'sold' && inPeriod(w.sale_date, from, to))) {
    const k = (typeof key === 'function' ? key(w) : w[key]) || 'Onbekend';
    const g = map.get(k) || { name: k, count: 0, revenue: 0, profit: 0, days: 0 };
    g.count++; g.revenue += n(w.sale_price); g.profit += watchProfit(w, s);
    g.days += w.purchase_date && w.sale_date ? daysBetween(w.purchase_date, w.sale_date) : 0;
    map.set(k, g);
  }
  return [...map.values()].map(g => ({ ...g, revenue: round2(g.revenue), profit: round2(g.profit), avgDays: Math.round(g.days / g.count) }))
    .sort((a, b) => b.profit - a.profit);
}

export function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = v => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(';'), ...rows.map(r => cols.map(c => esc(r[c])).join(';'))].join('\n');
}

// ───────────── Btw-aangifte (margeregeling) ─────────────
export const quarterOf = date => Math.ceil(+String(date).slice(5, 7) / 3);
export function quarterRange(year, q) {
  return { from: `${year}-${String(q * 3 - 2).padStart(2, '0')}-01`, to: new Date(Date.UTC(year, q * 3, 0)).toISOString().slice(0, 10) };
}
// Uiterste datum aangifte + betaling: laatste dag van de maand na het kwartaal
export const vatDeadline = (year, q) => new Date(Date.UTC(year, q * 3 + 1, 0)).toISOString().slice(0, 10);
export const vatRef = (year, q) => `vat:${year}-K${q}`;

export function vatReturn(state, year, q) {
  const s = state.settings || {};
  const { from, to } = quarterRange(year, q);
  const rows = state.watches.filter(w => w.status === 'sold' && w.vat_scheme === 'margin' && inPeriod(w.sale_date, from, to))
    .map(w => {
      const margin = round2(n(w.sale_price) - n(w.purchase_price));
      const vat = marginVat(w, s);
      return { id: w.id, name: `${w.brand} ${w.model}`, date: w.sale_date, purchase: n(w.purchase_price), sale: n(w.sale_price), margin, vat, marginExcl: margin > 0 ? round2(margin - vat) : 0 };
    }).sort((a, b) => a.date.localeCompare(b.date));
  const noScheme = state.watches.filter(w => w.status === 'sold' && w.vat_scheme !== 'margin' && inPeriod(w.sale_date, from, to)).length;
  const omzet = round2(rows.reduce((a, r) => a + r.marginExcl, 0));
  const vat = round2(rows.reduce((a, r) => a + r.vat, 0));
  const paid = round2(state.bank_entries.filter(e => e.type === 'vat_payment' && e.reference_id === vatRef(year, q)).reduce((a, e) => a + Math.abs(n(e.amount)), 0));
  return { year, q, from, to, rows, noScheme, omzet, vat, omzetRounded: Math.floor(omzet), vatRounded: Math.floor(vat), paid, open: round2(vat - paid), deadline: vatDeadline(year, q), negatives: rows.filter(r => r.margin < 0).length };
}

// ───────────── Inkomstenbelasting (indicatief) ─────────────
export const TAX_YEARS = {
  2025: { selfEmployed: 2470, starter: 2123, mkb: 12.7, hours: 1225 },
  2026: { selfEmployed: 1200, starter: 2123, mkb: 12.7, hours: 1225 },
};
export const taxYear = y => TAX_YEARS[y] || TAX_YEARS[Math.max(...Object.keys(TAX_YEARS).map(Number))];

export function hoursByPerson(items, year) {
  const out = {};
  for (const h of items.filter(i => i.module === 'hours' && String(i.data?.date).startsWith(String(year)))) out[h.data.person] = round2((out[h.data.person] || 0) + n(h.data.hours));
  return out;
}

export function incomeTax(state, year) {
  const s = state.settings || {};
  const partners = s.partners || ['Luuk', 'Marijn'];
  const shares = s.profit_shares || {};
  const t = taxYear(year);
  const result = calc(state, { from: `${year}-01-01`, to: `${year}-12-31` }).result;
  const parts = splitMoney(Math.abs(result), partners.map(p => n(shares[p] ?? 100 / partners.length))).map(x => result < 0 ? -x : x);
  const hours = hoursByPerson(state.items || [], year);
  const reservePct = n(s.tax_reserve_pct ?? 35);
  return partners.map((p, i) => {
    const profit = parts[i];
    const h = hours[p] || 0;
    const meetsHours = h >= t.hours;
    const selfEmployed = meetsHours && profit > 0 ? Math.min(t.selfEmployed, profit) : 0;
    const starter = meetsHours && s.starters?.[p] && profit > 0 ? Math.min(t.starter, profit - selfEmployed) : 0;
    const afterDeductions = round2(profit - selfEmployed - starter);
    const mkb = round2(afterDeductions * t.mkb / 100);
    const taxable = round2(afterDeductions - mkb);
    const reserve = taxable > 0 ? round2(taxable * reservePct / 100) : 0;
    return { partner: p, profit, hours: h, hoursNeeded: t.hours, meetsHours, selfEmployed, starter, mkb, taxable, reservePct, reserve };
  });
}

export function taxPot(state, year) {
  const it = incomeTax(state, year);
  const vat = state.settings?.vat_enabled ? Math.max(0, vatOwed(state)) : 0;
  const ib = round2(it.reduce((a, p) => a + p.reserve, 0));
  return { vat, ib, total: round2(vat + ib), perPartner: it };
}
