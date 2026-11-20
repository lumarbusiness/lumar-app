// LUMAR – Knab-rekening (alleen meelezen) via Enable Banking. Alleen voor ingelogde leden.
import { admin, cors, json, requireMember, HttpError, randomToken, sha256, CALLBACK_URL, eb, BANK_STATE_ID } from '../_shared/common.ts';

const DAY = 86400e3;

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const user = await requireMember(req);
    const body = await req.json().catch(() => ({}));
    const db = admin();
    if (body.action === 'connect') return json(await connect(db, user.id));
    if (body.action === 'sync') return json(await sync(db, !!body.full));
    if (body.action === 'disconnect') return json(await disconnect(db));
    throw new HttpError(400, 'Onbekende actie');
  } catch (e: any) {
    console.error(e);
    return json({ error: e?.message || String(e) }, e instanceof HttpError ? e.status : 500);
  }
});

async function connect(db: any, userId: string) {
  const list = await eb('/aspsps?country=NL&psu_type=personal');
  const knab = (list.aspsps || []).find((a: any) => /knab/i.test(a.name));
  if (!knab) throw new HttpError(400, 'Knab staat (tijdelijk) niet in de lijst van Enable Banking');
  const secs = Math.min(knab.maximum_consent_validity || 180 * 86400, 180 * 86400) - 3600;
  const nonce = randomToken();
  await db.from('oauth_states').delete().lt('created_at', new Date(Date.now() - 3600e3).toISOString());
  const { error } = await db.from('oauth_states').insert({ nonce, provider: 'knab', user_id: userId });
  if (error) throw error;
  const r = await eb('/auth', { method: 'POST', body: {
    access: { valid_until: new Date(Date.now() + secs * 1000).toISOString() },
    aspsp: { name: knab.name, country: 'NL' }, state: nonce, redirect_url: CALLBACK_URL, psu_type: 'personal', language: 'nl',
  } });
  return { url: r.url };
}

async function getState(db: any) {
  const { data } = await db.from('items').select('data').eq('id', BANK_STATE_ID).maybeSingle();
  return (data?.data || {}) as any;
}
async function setState(db: any, patch: any) {
  const cur = await getState(db);
  await db.from('items').upsert({ id: BANK_STATE_ID, module: 'bankstate', data: { ...cur, ...patch }, updated_at: new Date().toISOString() });
}

async function uuidFrom(text: string) {
  const h = await sha256(text);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function sync(db: any, full: boolean) {
  const { data: integ } = await db.from('integrations').select('*').eq('provider', 'knab').maybeSingle();
  if (!integ) throw new HttpError(400, 'Knab is nog niet gekoppeld');
  const accounts = JSON.parse(integ.refresh_token || '[]');
  const st = await getState(db);
  try {
    let added = 0, seen = 0, balance: number | null = null, balanceDate = '';
    for (const acc of accounts) {
      // eerste keer: zo ver mogelijk terug; daarna vanaf 10 dagen vóór de vorige keer
      const from = !full && st.last_sync ? new Date(new Date(st.last_sync).getTime() - 10 * DAY) : new Date(Date.now() - 730 * DAY);
      let txs: any[] = [];
      try { txs = await fetchAll(acc.uid, from); }
      catch (e) { if (st.last_sync && !full) throw e; txs = await fetchAll(acc.uid, new Date(Date.now() - 89 * DAY)); }
      const rows: any[] = [], occ: Record<string, number> = {};
      for (const t of txs) {
        if (t.status && t.status !== 'BOOK') continue;
        const amt = Math.abs(Number(t.transaction_amount?.amount || 0)) * (t.credit_debit_indicator === 'DBIT' ? -1 : 1);
        const date = t.booking_date || t.value_date || t.transaction_date || '';
        const desc = (t.remittance_information || []).join(' ').replace(/\s+/g, ' ').trim();
        const other = t.credit_debit_indicator === 'DBIT' ? t.creditor : t.debtor;
        const otherAcc = t.credit_debit_indicator === 'DBIT' ? t.creditor_account : t.debtor_account;
        const ref = t.entry_reference || t.transaction_id || '';
        let key = `${acc.uid}|${ref || `${date}|${amt}|${desc}|${other?.name || ''}`}`;
        occ[key] = (occ[key] || 0) + 1; if (!ref && occ[key] > 1) key += `|${occ[key]}`;
        rows.push({ id: await uuidFrom(key), module: 'banktx', data: {
          account: acc.uid, iban: acc.iban, date, amount: Math.round(amt * 100) / 100, currency: t.transaction_amount?.currency || 'EUR',
          counterparty: other?.name || '', counterparty_iban: otherAcc?.iban || '', description: desc, ref, matched: null,
        } });
      }
      seen += rows.length;
      for (let i = 0; i < rows.length; i += 200) {
        const part = rows.slice(i, i + 200);
        const { data: existing } = await db.from('items').select('id').in('id', part.map(r => r.id));
        const have = new Set((existing || []).map((r: any) => r.id));
        const fresh = part.filter(r => !have.has(r.id));
        if (fresh.length) { const { error } = await db.from('items').insert(fresh); if (error) throw error; added += fresh.length; }
      }
      const b = await eb(`/accounts/${acc.uid}/balances`).catch(() => null);
      const pick = (b?.balances || []).sort((x: any, y: any) => rank(x.balance_type) - rank(y.balance_type))[0];
      if (pick) { balance = (balance || 0) + Number(pick.balance_amount?.amount || 0); balanceDate = pick.reference_date || pick.last_change_date_time || ''; }
    }
    await setState(db, { last_sync: new Date().toISOString(), balance, balance_date: balanceDate, error: null });
    return { added, seen, balance };
  } catch (e: any) {
    const msg = e?.message || String(e);
    const expired = /expired|revoked|consent|unauthori|session/i.test(msg);
    await setState(db, { error: expired ? 'De toestemming bij Knab is verlopen of ingetrokken. Koppel Knab opnieuw.' : msg, error_at: new Date().toISOString() });
    throw new HttpError(400, expired ? 'De toestemming bij Knab is verlopen. Koppel Knab opnieuw.' : msg);
  }
}
const rank = (t: string) => ['CLBD', 'ITBD', 'XPCD', 'ITAV', 'CLAV', 'OPBD'].indexOf(t) + 1 || 99;

async function fetchAll(uid: string, from: Date) {
  const out: any[] = []; let key = '';
  for (let i = 0; i < 40; i++) {
    const q = new URLSearchParams({ date_from: from.toISOString().slice(0, 10) });
    if (key) q.set('continuation_key', key);
    const r = await eb(`/accounts/${uid}/transactions?${q}`);
    out.push(...(r.transactions || []));
    key = r.continuation_key || '';
    if (!key) break;
  }
  return out;
}

async function disconnect(db: any) {
  const { data: integ } = await db.from('integrations').select('access_token').eq('provider', 'knab').maybeSingle();
  if (integ?.access_token) await eb(`/sessions/${integ.access_token}`, { method: 'DELETE' }).catch(() => null);
  await db.from('integrations').delete().eq('provider', 'knab');
  await setState(db, { accounts: [], valid_until: null, error: null });
  return { ok: true };
}
