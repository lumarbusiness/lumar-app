// LUMAR — rekenlogica (los van de interface, zodat het te testen is)

export const n = v => (v === null || v === undefined || v === '' || isNaN(+v)) ? 0 : +v;
export const round2 = v => Math.round(n(v) * 100) / 100;

export const STATUS = {
  incoming: 'Onderweg',
  in_stock: 'Op voorraad',
  customer_returning: 'Retour onderweg',
  sold: 'Verkocht',
  returned: 'Terug naar verkoper',
  written_off: 'Afgeschreven',
};
export const ACTIVE = ['incoming', 'in_stock', 'customer_returning'];

export const PLATFORMS = ['Vinted', 'Marktplaats', 'Chrono24', 'Catawiki', 'eBay', 'Instagram', 'Particulier', 'Anders'];
export const EXPENSE_CATEGORIES = ['Algemeen', 'Verzending', 'Retourkosten', 'Verpakking', 'Reparatie & service', 'Website & software', 'Marketing', 'Abonnementen'];
export const BOX_PAPERS = { full: 'Box & papieren', box: 'Alleen box', papers: 'Alleen papieren', none: 'Geen' };
export const BANK_TYPES = {
  sale: 'Verkoop', purchase: 'Inkoop', expense: 'Uitgave', owner_deposit: 'Storting vennoot',
  owner_withdrawal: 'Opname vennoot', supplier_refund: 'Terugbetaling verkoper',
  customer_refund: 'Terugbetaling klant', income: 'Overige ontvangst', correction: 'Saldocorrectie',
};

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

export function linkedReturnCosts(state, watchId) {
  return state.expenses.filter(e => e.watch_id === watchId && e.category === 'Retourkosten')
    .reduce((a, e) => a + n(e.amount), 0);
}

// Resultaat over een periode (from/to als 'YYYY-MM-DD', leeg = alles)
export function calc(state, { from = '', to = '' } = {}) {
  const s = state.settings || {};
  const sold = state.watches.filter(w => w.status === 'sold' && inPeriod(w.sale_date, from, to));
  const revenue = sold.reduce((a, w) => a + n(w.sale_price), 0);
  const vat = sold.reduce((a, w) => a + marginVat(w, s), 0);
  const cogs = sold.reduce((a, w) => a + n(w.total_cost), 0);
  const saleCosts = sold.reduce((a, w) => a + n(w.sale_costs), 0);
  const writeOff = state.watches.filter(w => w.status === 'written_off' && inPeriod(w.write_off?.date, from, to))
    .reduce((a, w) => a + n(w.write_off?.amount ?? w.total_cost), 0);
  // Retour naar verkoper: verschil tussen terugbetaling en kostprijs
  const returnResult = state.watches.filter(w => w.status === 'returned' && inPeriod(w.supplier_return?.date, from, to))
    .reduce((a, w) => a + n(w.supplier_return?.refund) - n(w.total_cost), 0);
  const expenses = state.expenses.filter(e => inPeriod(e.date, from, to)).reduce((a, e) => a + n(e.amount), 0);
  const stock = state.watches.filter(w => ACTIVE.includes(w.status)).reduce((a, w) => a + n(w.total_cost), 0);
  const stockEstimated = state.watches.filter(w => ACTIVE.includes(w.status))
    .reduce((a, w) => a + n(w.estimated_value || w.total_cost), 0);
  const netRevenue = revenue - vat;
  const grossProfit = netRevenue - cogs;
  const result = grossProfit - saleCosts - expenses - writeOff + returnResult;
  return {
    revenue: round2(revenue), vat: round2(vat), netRevenue: round2(netRevenue), cogs: round2(cogs),
    grossProfit: round2(grossProfit), saleCosts: round2(saleCosts), expenses: round2(expenses),
    writeOff: round2(writeOff), returnResult: round2(returnResult), result: round2(result),
    stock: round2(stock), stockEstimated: round2(stockEstimated), soldCount: sold.length,
    stockCount: state.watches.filter(w => ACTIVE.includes(w.status)).length,
  };
}

export const bankBalance = state => round2(state.bank_entries.reduce((a, e) => a + n(e.amount), 0));

// Openstaande betalingen (in = te ontvangen, out = te betalen)
export function pendingPayments(state) {
  const list = [];
  const name = w => `${w.brand} ${w.model}`;
  for (const w of state.watches) {
    if (w.status === 'sold' && w.sale_payment === 'pending')
      list.push({ id: `sale:${w.id}`, kind: 'sale', watchId: w.id, date: w.sale_date, description: `Verkoop ${name(w)}`, amount: round2(n(w.sale_price) - n(w.sale_costs)), direction: 'in' });
    if (w.status === 'returned' && w.supplier_return?.payment === 'pending') {
      const costs = linkedReturnCosts(state, w.id);
      list.push({ id: `refund:${w.id}`, kind: 'refund', watchId: w.id, date: w.supplier_return.date, description: `Terugbetaling verkoper · ${name(w)}`, amount: round2(Math.max(0, n(w.supplier_return.refund) - costs)), direction: 'in' });
    }
    if (w.customer_return?.payment === 'pending')
      list.push({ id: `customer-return:${w.id}`, kind: 'customer-return', watchId: w.id, date: w.customer_return.date, description: `Terugbetaling klant · ${name(w)}`, amount: round2(n(w.customer_return.amount)), direction: 'out' });
    if (!w.batch_id && w.purchase_payment === 'pending')
      list.push({ id: `purchase:${w.id}`, kind: 'purchase', watchId: w.id, date: w.purchase_date, description: `Inkoop ${name(w)}`, amount: round2(w.total_cost), direction: 'out' });
  }
  for (const b of state.purchase_batches.filter(b => b.payment_status === 'pending')) {
    const count = state.watches.filter(w => w.batch_id === b.id).length;
    list.push({ id: `batch:${b.id}`, kind: 'batch', batchId: b.id, date: b.purchase_date, description: `${b.platform || 'Bundel'}-bestelling · ${count} horloges`, amount: round2(b.total_cost), direction: 'out' });
  }
  for (const e of state.expenses.filter(e => e.payment_status === 'pending'))
    list.push({ id: `expense:${e.id}`, kind: 'expense', expenseId: e.id, date: e.date, description: e.description, amount: round2(e.amount), direction: 'out' });
  return list.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

// Kapitaal per vennoot: stortingen − opnames + privé betaalde kosten + winstaandeel
export function partnerCapital(state) {
  const s = state.settings || {};
  const partners = s.partners || ['Luuk', 'Marijn'];
  const shares = s.profit_shares || {};
  const result = calc(state).result;
  return partners.map(p => {
    const deposits = state.bank_entries.filter(e => e.type === 'owner_deposit' && e.partner === p).reduce((a, e) => a + n(e.amount), 0);
    const withdrawals = state.bank_entries.filter(e => e.type === 'owner_withdrawal' && e.partner === p).reduce((a, e) => a + Math.abs(n(e.amount)), 0);
    const priv = state.watches.filter(w => w.purchase_payment === 'private' && w.purchase_paid_by === p).reduce((a, w) => a + n(w.total_cost), 0)
      + state.purchase_batches.filter(b => b.payment_status === 'private' && b.paid_by === p).reduce((a, b) => a + n(b.total_cost), 0)
      + state.expenses.filter(e => e.payment_status === 'private' && e.paid_by === p).reduce((a, e) => a + n(e.amount), 0);
    const share = n(shares[p] ?? 100 / partners.length);
    const profitShare = result * share / 100;
    return {
      partner: p, deposits: round2(deposits), withdrawals: round2(withdrawals), privatePaid: round2(priv),
      contribution: round2(deposits + priv - withdrawals), share, profitShare: round2(profitShare),
      capital: round2(deposits + priv - withdrawals + profitShare),
    };
  });
}

// Wat moet er nog gebeuren
export function actionItems(state) {
  const items = pendingPayments(state).map(p => ({ ...p, reason: p.direction === 'in' ? 'Nog te ontvangen' : 'Nog te betalen' }));
  const today = new Date().toISOString().slice(0, 10);
  for (const w of state.watches) {
    if (w.status === 'incoming' && w.purchase_date && daysBetween(w.purchase_date, today) > 10)
      items.push({ id: `late:${w.id}`, kind: 'late', watchId: w.id, date: w.purchase_date, description: `${w.brand} ${w.model}`, reason: `Al ${daysBetween(w.purchase_date, today)} dagen onderweg` });
  }
  for (const e of state.expenses.filter(e => !e.receipt_path && n(e.amount) >= 10))
    items.push({ id: `receipt:${e.id}`, kind: 'receipt', expenseId: e.id, date: e.date, description: e.description, reason: 'Bon ontbreekt' });
  return items;
}

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
    return { quarter: `K${q} ${year}`, count: sold.length, vat: round2(sold.reduce((a, w) => a + marginVat(w, s), 0)), revenue: round2(sold.reduce((a, w) => a + n(w.sale_price), 0)) };
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
