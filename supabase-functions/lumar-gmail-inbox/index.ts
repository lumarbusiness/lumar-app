// LUMAR – ontvangt mails vanuit het Google Apps Script en zet ze in Documenten → Mail.
import { admin, cors, json, sha256, BUCKET } from '../_shared/common.ts';

const MIME_OK = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain'];
// Bedragen herkennen in NL- en EN-notatie: €21.78, € 21,78, 1.234,56 EUR, €1,234.56, EUR 18
const amountsIn = (text: string) => {
  const re = /(?:€|EUR\b|euro\b)\s?(\d[\d.,]*\d|\d)|(\d[\d.,]*\d|\d)\s?(?:€|EUR\b|euro\b)(?!\s?\d)/gi;
  const out: number[] = [];
  for (const m of String(text).matchAll(re)) {
    let s = m[1] || m[2];
    const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
    let dec = '';
    if (lastDot >= 0 && lastComma >= 0) dec = lastDot > lastComma ? '.' : ',';
    else if (lastDot >= 0 || lastComma >= 0) { const sep = lastDot >= 0 ? '.' : ','; const tail = s.length - s.lastIndexOf(sep) - 1; if (tail === 2 || (tail === 1 && s.split(sep).length === 2)) dec = sep; }
    const thou = dec === '.' ? ',' : '.';
    s = s.split(thou).join(''); if (dec) s = s.replace(dec, '.'); else s = s.replace(/[.,]/g, '');
    const v = Math.round(parseFloat(s) * 100) / 100;
    if (v > 0 && v < 1000000 && !out.includes(v)) out.push(v);
  }
  return out.slice(0, 6);
};

const b64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Alleen POST' }, 405);
  try {
    const body = await req.json();
    const db = admin();
    const { data: row } = await db.from('integrations').select('secret_hash').eq('provider', 'gmail').maybeSingle();
    if (!row?.secret_hash || !body?.code || (await sha256(body.code)) !== row.secret_hash) return json({ error: 'Ongeldige koppelcode' }, 401);
    // Het script vraagt eerst welke mails het moet sturen (instelbaar in de app)
    if (body.config) {
      const { data: st } = await db.from('settings').select('value').eq('key', 'gmail_scope').maybeSingle();
      const scope = (st?.value as string) || 'all';
      const query = ({
        all: '(in:inbox OR label:LUMAR)',
        nopromo: '(in:inbox OR label:LUMAR) -category:promotions -category:social',
        receipts: '(label:LUMAR OR from:(vinted OR chrono24 OR catawiki) OR subject:(bon OR factuur OR invoice OR receipt OR bestelling OR order OR betaling OR betaald))',
      } as Record<string, string>)[scope] || '(in:inbox OR label:LUMAR)';
      return json({ query, days: 30 });
    }
    let stored = 0, skipped = 0;
    for (const m of (body.messages || []).slice(0, 30)) {
      if (!m?.id) continue;
      const { data: exists } = await db.from('items').select('id').eq('module', 'mail').eq('data->>gmail_id', m.id).maybeSingle();
      if (exists) { skipped++; continue; }
      const base = `mail/${String(m.id).replace(/[^A-Za-z0-9_-]/g, '')}`;
      const attachments: { path: string; name: string; mime: string }[] = [];
      for (const a of (m.attachments || []).slice(0, 10)) {
        const mime = String(a.mime || '').split(';')[0].toLowerCase();
        if (!MIME_OK.includes(mime) || !a.base64) continue;
        const path = `${base}/${crypto.randomUUID()}-${String(a.name || 'bijlage').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80)}`;
        const { error } = await db.storage.from(BUCKET).upload(path, b64(a.base64), { contentType: mime });
        if (!error) attachments.push({ path, name: a.name, mime });
      }
      let body_path: string | null = null;
      if (m.body) {
        const text = `Van: ${m.from}\nDatum: ${m.date}\nOnderwerp: ${m.subject}\n\n${m.body}`;
        const path = `${base}/mail.txt`;
        const { error } = await db.storage.from(BUCKET).upload(path, new TextEncoder().encode(text), { contentType: 'text/plain', upsert: true });
        if (!error) body_path = path;
      }
      const { error } = await db.from('items').insert({ module: 'mail', data: {
        gmail_id: m.id, subject: m.subject, from: m.from, date: m.date, snippet: String(m.body || '').replace(/\s+/g, ' ').slice(0, 400),
        amounts: amountsIn(`${m.subject} ${m.body}`), attachments, body_path, status: 'new',
      } });
      if (error) throw error;
      stored++;
    }
    return json({ stored, skipped });
  } catch (e: any) {
    console.error(e);
    return json({ error: e?.message || String(e) }, 500);
  }
});
