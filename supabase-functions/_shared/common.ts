// Gedeelde hulpfuncties voor de LUMAR Edge Functions
import { createClient } from 'npm:@supabase/supabase-js@2';

export const APP_URL = 'https://lumarbusiness.github.io/lumar-app/';
export const BUCKET = 'lumar-files';
export const MS_SCOPES = 'offline_access Files.ReadWrite User.Read';
export const MS_AUTH = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
export const CALLBACK_URL = `${Deno.env.get('SUPABASE_URL')}/functions/v1/lumar-oauth-callback`;

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

export const admin = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

// Controleer dat de aanroeper een ingelogd LUMAR-lid is
export async function requireMember(req: Request) {
  const auth = req.headers.get('Authorization') || '';
  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: u } = await userClient.auth.getUser();
  if (!u?.user) throw new HttpError(401, 'Niet ingelogd');
  const { data: ok } = await userClient.rpc('is_member');
  if (!ok) throw new HttpError(403, 'Geen lid van LUMAR');
  return u.user;
}

export class HttpError extends Error { status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }

export async function sha256(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export const randomToken = (bytes = 24) => [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('');

// Bestandsnamen die OneDrive accepteert
export const safeName = (s: string) => String(s || 'bestand').replace(/[\\/:*?"<>|#%]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'bestand';

// ───── Instagram (Business Login for Instagram) en TikTok ─────
export const IG_SCOPES = 'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights';
export const IG_GRAPH = 'https://graph.instagram.com/v25.0';
export const TT_SCOPES = Deno.env.get('TIKTOK_SCOPES') || 'user.info.basic,user.info.stats,video.list,video.upload';
export const TT_API = 'https://open.tiktokapis.com/v2';

// Wisselt een TikTok-code of refresh-token in voor nieuwe tokens
export async function tiktokToken(params: Record<string, string>) {
  const res = await fetch(`${TT_API}/oauth/token/`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_key: Deno.env.get('TIKTOK_CLIENT_KEY')!, client_secret: Deno.env.get('TIKTOK_CLIENT_SECRET')!, ...params }) });
  const t = await res.json();
  if (!res.ok || t.error) throw new HttpError(400, t.error_description || t.error || 'TikTok-token mislukt');
  return t as { access_token: string; refresh_token: string; expires_in: number; open_id: string };
}

// ───── Knab via Enable Banking (alleen meelezen) ─────
export const EB_API = 'https://api.enablebanking.com';
export const BANK_STATE_ID = '00000000-0000-4000-8000-00000000b41a'; // vaste rij in items (module 'bankstate')
function der(len: number) { return len < 128 ? [len] : len < 256 ? [0x81, len] : [0x82, len >> 8, len & 255]; }
async function ebKey() {
  const pem = Deno.env.get('EB_PRIVATE_KEY') || '';
  if (!pem.trim()) throw new HttpError(400, 'EB_PRIVATE_KEY ontbreekt in de Supabase-secrets');
  const pkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  let body = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/[^A-Za-z0-9+/=]/g, '')), c => c.charCodeAt(0));
  if (pkcs1) { // PKCS#1 → PKCS#8 omzetten
    const algo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
    const oct = [0x04, ...der(body.length)], inner = [0x02, 0x01, 0x00, ...algo, ...oct];
    body = new Uint8Array([0x30, ...der(inner.length + body.length), ...inner, ...body]);
  }
  return crypto.subtle.importKey('pkcs8', body, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}
const b64u = (b: Uint8Array | string) => btoa(typeof b === 'string' ? unescape(encodeURIComponent(b)) : String.fromCharCode(...b)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
export async function ebJwt() {
  const kid = (Deno.env.get('EB_APP_ID') || '').trim();
  if (!kid) throw new HttpError(400, 'EB_APP_ID ontbreekt in de Supabase-secrets');
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64u(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid }))}.${b64u(JSON.stringify({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp: now + 3600 }))}`;
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await ebKey(), new TextEncoder().encode(data)));
  return `${data}.${b64u(sig)}`;
}
export async function eb(path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(EB_API + path, { method: init.method || 'GET', headers: { Authorization: `Bearer ${await ebJwt()}`, 'Content-Type': 'application/json' }, body: init.body ? JSON.stringify(init.body) : undefined });
  const t = await res.text(); let j: any = {}; try { j = t ? JSON.parse(t) : {}; } catch { j = { message: t }; }
  if (!res.ok) throw new HttpError(res.status === 401 || res.status === 403 ? 400 : res.status >= 500 ? 502 : 400, `Bank: ${j.message || j.detail || j.error || res.statusText}`);
  return j;
}
