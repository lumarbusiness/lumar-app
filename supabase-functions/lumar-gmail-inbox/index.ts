// LUMAR – ontvangt mails vanuit het Google Apps Script en zet ze in Documenten → Mail.
import { admin, cors, json, sha256, safeName, BUCKET } from '../_shared/common.ts';

const MIME_OK = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain'];
const amountsIn = (text: string) => [...new Set([...String(text).matchAll(/€\s?(\d{1,3}(?:\.\d{3})*(?:,\d{2})|\d+(?:,\d{2})?)|(\d{1,3}(?:\.\d{3})*,\d{2})\s?(?:EUR|€)/g)]
  .map(m => +(m[1] || m[2]).replace(/\./g, '').replace(',', '.')).filter(x => x > 0 && x < 100000))].slice(0, 5);
const b64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Alleen POST' }, 405);
  try {
    const body = await req.json();
    const db = admin();
    const { data: row } = await db.from('integrations').select('secret_hash').eq('provider', 'gmail').maybeSingle();
    if (!row?.secret_hash || !body?.code || (await sha256(body.code)) !== row.secret_hash) return json({ error: 'Ongeldige koppelcode' }, 401);
    let stored = 0, skipped = 0;
    for (const m of (body.messages || []).slice(0, 30)) {
      if (!m?.id) continue;
      const { data: exists } = await db.from('items').select('id').eq('module', 'mail').eq('data->>gmail_id', m.id).maybeSingle();
      if (exists) { skipped++; continue; }
      const base = `mail/${safeName(m.id)}`;
      const attachments = [];
      for (const a of (m.attachments || []).slice(0, 10)) {
        const mime = String(a.mime || '').split(';')[0].toLowerCase();
        if (!MIME_OK.includes(mime) || !a.base64) continue;
        const path = `${base}/${crypto.randomUUID()}-${safeName(a.name)}`;
        const { error } = await db.storage.from(BUCKET).upload(path, b64(a.base64), { contentType: mime });
        if (!error) attachments.push({ path, name: a.name, mime });
      }
      let body_path = null;
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
