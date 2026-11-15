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
