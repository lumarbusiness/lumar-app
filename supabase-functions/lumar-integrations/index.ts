// LUMAR – koppelingen beheren (OneDrive, Gmail). Alleen voor ingelogde leden.
import { admin, cors, json, requireMember, HttpError, randomToken, sha256, safeName, BUCKET, MS_AUTH, MS_SCOPES, CALLBACK_URL } from '../_shared/common.ts';

const PER_CALL = 15; // bestanden per aanroep (blijft ruim binnen de tijdslimiet)

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const user = await requireMember(req);
    const body = await req.json().catch(() => ({}));
    const db = admin();
    switch (body.action) {
      case 'onedrive-connect': {
        const clientId = Deno.env.get('MS_CLIENT_ID');
        if (!clientId || !Deno.env.get('MS_CLIENT_SECRET')) throw new HttpError(400, 'OneDrive is nog niet ingesteld (MS_CLIENT_ID / MS_CLIENT_SECRET ontbreken in Supabase).');
        const nonce = randomToken();
        await db.from('oauth_states').delete().lt('created_at', new Date(Date.now() - 3600e3).toISOString());
        const { error } = await db.from('oauth_states').insert({ nonce, provider: 'onedrive', user_id: user.id });
        if (error) throw error;
        const url = `${MS_AUTH}/authorize?` + new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: CALLBACK_URL, response_mode: 'query', scope: MS_SCOPES, state: nonce, prompt: 'select_account' });
        return json({ url });
      }
      case 'onedrive-sync': return json(await syncOneDrive(db));
      case 'gmail-secret': {
        const secret = randomToken(20);
        const { error } = await db.from('integrations').upsert({ provider: 'gmail', account: 'info.lumarbusiness@gmail.com', secret_hash: await sha256(secret), connected_by: user.id, updated_at: new Date().toISOString() });
        if (error) throw error;
        return json({ secret });
      }
      case 'disconnect': {
        if (!['onedrive', 'gmail'].includes(body.provider)) throw new HttpError(400, 'Onbekende koppeling');
        await db.from('integrations').delete().eq('provider', body.provider);
        return json({ ok: true });
      }
      default: throw new HttpError(400, 'Onbekende actie');
    }
  } catch (e: any) {
    const status = e instanceof HttpError ? e.status : 500;
    console.error(e);
    return json({ error: e?.message || String(e) }, status);
  }
});

// ───────── OneDrive ─────────
async function msToken(db: ReturnType<typeof admin>) {
  const { data: row } = await db.from('integrations').select('*').eq('provider', 'onedrive').maybeSingle();
  if (!row?.refresh_token) throw new HttpError(400, 'OneDrive is niet gekoppeld');
  if (row.access_token && row.expires_at && new Date(row.expires_at).getTime() > Date.now() + 120e3) return row.access_token as string;
  const res = await fetch(`${MS_AUTH}/token`, { method: 'POST', body: new URLSearchParams({
    client_id: Deno.env.get('MS_CLIENT_ID')!, client_secret: Deno.env.get('MS_CLIENT_SECRET')!, grant_type: 'refresh_token', refresh_token: row.refresh_token, scope: MS_SCOPES,
  }) });
  const t = await res.json();
  if (!res.ok) throw new HttpError(400, 'Toegang tot OneDrive verlopen, koppel opnieuw: ' + (t.error_description || t.error));
  await db.from('integrations').update({ access_token: t.access_token, refresh_token: t.refresh_token || row.refresh_token, expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(), updated_at: new Date().toISOString() }).eq('provider', 'onedrive');
  return t.access_token as string;
}

const ext = (path: string, mime?: string) => (path.match(/\.[a-z0-9]{2,5}$/i)?.[0] || ({ 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'text/plain': '.txt' } as Record<string, string>)[mime || ''] || '');
const quarter = (d: string) => `K${Math.ceil(+String(d).slice(5, 7) / 3)}`;

async function wantedFiles(db: ReturnType<typeof admin>) {
  const out: { path: string; remote: string }[] = [];
  const bon = (date: string, label: string, path: string) => {
    const d = date || new Date().toISOString().slice(0, 10);
    out.push({ path, remote: `LUMAR/Bonnen/${d.slice(0, 4)}/${quarter(d)}/${safeName(`${d} ${label}`)}${ext(path)}` });
  };
  const [w, b, e, it] = await Promise.all([
    db.from('watches').select('id,brand,model,purchase_date,receipt_path').not('receipt_path', 'is', null),
    db.from('purchase_batches').select('id,platform,purchase_date,receipt_path').not('receipt_path', 'is', null),
    db.from('expenses').select('id,description,date,receipt_path').not('receipt_path', 'is', null),
    db.from('items').select('module,data').in('module', ['doc', 'brand']),
  ]);
  for (const r of w.data || []) bon(r.purchase_date, `Inkoop ${r.brand} ${r.model}`, r.receipt_path);
  for (const r of b.data || []) bon(r.purchase_date, `Inkoop ${r.platform || 'bundel'} bestelling`, r.receipt_path);
  for (const r of e.data || []) bon(r.date, r.description, r.receipt_path);
  for (const r of it.data || []) {
    const d = r.data || {};
    if (!d.path) continue;
    if (r.module === 'doc') out.push({ path: d.path, remote: `LUMAR/Documenten/${safeName(d.category || 'Overig')}/${safeName(d.name)}${ext(d.path, d.mime)}` });
    if (r.module === 'brand' && d.kind === 'asset') out.push({ path: d.path, remote: `LUMAR/Branding/${safeName(d.name)}${ext(d.path, d.mime)}` });
  }
  return out;
}

async function uploadToOneDrive(token: string, remote: string, bytes: Uint8Array, mime: string) {
  const enc = remote.split('/').map(encodeURIComponent).join('/');
  if (bytes.length <= 4 * 1024 * 1024) {
    const r = await fetch(`https://graph.microsoft.com/v1.0/me/drive/root:/${enc}:/content?@microsoft.graph.conflictBehavior=replace`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': mime || 'application/octet-stream' }, body: bytes });
    const j = await r.json(); if (!r.ok) throw new Error(j?.error?.message || 'Upload mislukt'); return j.id as string;
  }
  const s = await fetch(`https://graph.microsoft.com/v1.0/me/drive/root:/${enc}:/createUploadSession`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }) });
  const sj = await s.json(); if (!s.ok) throw new Error(sj?.error?.message || 'Upload starten mislukt');
  const chunk = 327680 * 12; let last: any = null;
  for (let start = 0; start < bytes.length; start += chunk) {
    const part = bytes.subarray(start, Math.min(start + chunk, bytes.length));
    const r = await fetch(sj.uploadUrl, { method: 'PUT', headers: { 'Content-Range': `bytes ${start}-${start + part.length - 1}/${bytes.length}` }, body: part });
    last = await r.json().catch(() => ({})); if (!r.ok) throw new Error(last?.error?.message || 'Upload mislukt');
  }
  return last?.id as string;
}

async function syncOneDrive(db: ReturnType<typeof admin>) {
  const token = await msToken(db);
  const wanted = await wantedFiles(db);
  const { data: done } = await db.from('sync_log').select('path,remote_path').eq('provider', 'onedrive');
  const doneMap = new Map((done || []).map(d => [d.path, d.remote_path]));
  const todo = wanted.filter(f => doneMap.get(f.path) !== f.remote);
  const errors: string[] = []; let uploaded = 0;
  for (const f of todo.slice(0, PER_CALL)) {
    try {
      const { data: blob, error } = await db.storage.from(BUCKET).download(f.path);
      if (error || !blob) throw new Error(error?.message || 'Bestand niet gevonden');
      const id = await uploadToOneDrive(token, f.remote, new Uint8Array(await blob.arrayBuffer()), blob.type);
      await db.from('sync_log').upsert({ path: f.path, provider: 'onedrive', remote_path: f.remote, remote_id: id, synced_at: new Date().toISOString() });
      uploaded++;
    } catch (e: any) { errors.push(`${f.remote}: ${e?.message || e}`); }
  }
  return { uploaded, remaining: Math.max(0, todo.length - PER_CALL), errors };
}
