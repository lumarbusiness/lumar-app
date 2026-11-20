// LUMAR – terugkeerpunt na inloggen bij Microsoft (OneDrive), Instagram, TikTok of Knab. Wordt door de browser aangeroepen.
import { admin, APP_URL, MS_AUTH, MS_SCOPES, CALLBACK_URL, IG_GRAPH, tiktokToken, TT_API, eb, BANK_STATE_ID } from '../_shared/common.ts';

const redirect = (hash: string, q: Record<string, string>) => Response.redirect(`${APP_URL}?${new URLSearchParams(q)}#${hash}`, 302);

Deno.serve(async req => {
  const url = new URL(req.url);
  const code = (url.searchParams.get('code') || '').replace(/#_$/, ''), state = url.searchParams.get('state');
  let hash = 'instellingen/settings';
  if (state) { const { data: pv } = await admin().from('oauth_states').select('provider').eq('nonce', state).maybeSingle(); if (pv?.provider === 'knab') hash = 'financien/bank'; }
  const back = (q: Record<string, string>) => redirect(hash, q);
  if (url.searchParams.get('error')) return back({ koppelfout: url.searchParams.get('error_description') || url.searchParams.get('error_reason') || url.searchParams.get('error')! });
  if (!code || !state) return back({ koppelfout: 'Onvolledig antwoord bij het koppelen' });
  const db = admin();
  const { data: st } = await db.from('oauth_states').select('*').eq('nonce', state).maybeSingle();
  await db.from('oauth_states').delete().eq('nonce', state);
  if (!st || Date.now() - new Date(st.created_at).getTime() > 15 * 60e3) return back({ koppelfout: 'Koppelverzoek verlopen, probeer opnieuw' });
  try {
    const row = await (st.provider === 'instagram' ? instagram(code) : st.provider === 'tiktok' ? tiktok(code) : st.provider === 'knab' ? knab(code, db) : onedrive(code));
    const { error } = await db.from('integrations').upsert({ ...row, connected_by: st.user_id, updated_at: new Date().toISOString() });
    if (error) throw error;
    return back({ connected: row.provider });
  } catch (e: any) { return back({ koppelfout: e?.message || String(e) }); }
});

async function onedrive(code: string) {
  const res = await fetch(`${MS_AUTH}/token`, { method: 'POST', body: new URLSearchParams({
    client_id: Deno.env.get('MS_CLIENT_ID')!, client_secret: Deno.env.get('MS_CLIENT_SECRET')!, grant_type: 'authorization_code', code, redirect_uri: CALLBACK_URL, scope: MS_SCOPES,
  }) });
  const t = await res.json();
  if (!res.ok) throw new Error(t.error_description || t.error || 'Token mislukt');
  const me = await fetch('https://graph.microsoft.com/v1.0/me', { headers: { Authorization: `Bearer ${t.access_token}` } }).then(r => r.json()).catch(() => ({}));
  return { provider: 'onedrive', account: me.userPrincipalName || me.mail || me.displayName || 'Microsoft-account', refresh_token: t.refresh_token, access_token: t.access_token,
    expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString() };
}

async function instagram(code: string) {
  const res = await fetch('https://api.instagram.com/oauth/access_token', { method: 'POST', body: new URLSearchParams({
    client_id: Deno.env.get('IG_APP_ID')!, client_secret: Deno.env.get('IG_APP_SECRET')!, grant_type: 'authorization_code', redirect_uri: CALLBACK_URL, code,
  }) });
  const s = await res.json();
  if (!res.ok || !s.access_token) throw new Error(s.error_message || s.error?.message || 'Instagram-token mislukt');
  // kort token → token van 60 dagen (wordt automatisch verlengd)
  const l = await fetch(`https://graph.instagram.com/access_token?${new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: Deno.env.get('IG_APP_SECRET')!, access_token: s.access_token })}`).then(r => r.json());
  if (!l.access_token) throw new Error(l.error?.message || 'Instagram-token verlengen mislukt');
  const me = await fetch(`${IG_GRAPH}/me?fields=user_id,username&access_token=${l.access_token}`).then(r => r.json()).catch(() => ({}));
  return { provider: 'instagram', account: me.username ? '@' + me.username : 'Instagram', access_token: l.access_token, refresh_token: l.access_token,
    expires_at: new Date(Date.now() + (l.expires_in || 5184000) * 1000).toISOString() };
}

async function tiktok(code: string) {
  const t = await tiktokToken({ code, grant_type: 'authorization_code', redirect_uri: CALLBACK_URL });
  const me = await fetch(`${TT_API}/user/info/?fields=display_name`, { headers: { Authorization: `Bearer ${t.access_token}` } }).then(r => r.json()).catch(() => ({}));
  return { provider: 'tiktok', account: me?.data?.user?.display_name || 'TikTok', access_token: t.access_token, refresh_token: t.refresh_token,
    expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString() };
}

async function knab(code: string, db: any) {
  const s = await eb('/sessions', { method: 'POST', body: { code } });
  const accounts = (s.accounts || []).map((a: any) => ({ uid: a.uid, iban: a.account_id?.iban || a.all_account_ids?.find((x: any) => x.scheme_name === 'IBAN')?.identification || '', name: a.name || a.product || '' }));
  if (!accounts.length) throw new Error('Knab gaf geen rekening terug. Probeer opnieuw en vink de rekening aan.');
  const old = await db.from('items').select('data').eq('id', BANK_STATE_ID).maybeSingle();
  await db.from('items').upsert({ id: BANK_STATE_ID, module: 'bankstate', data: { ...(old.data?.data || {}), accounts, valid_until: s.access?.valid_until, error: null }, updated_at: new Date().toISOString() });
  const ib = accounts[0].iban;
  return { provider: 'knab', account: `Knab${ib ? ' · ' + ib.replace(/(.{4})/g, '$1 ').trim() : ''}`, access_token: s.session_id, refresh_token: JSON.stringify(accounts), expires_at: s.access?.valid_until || null };
}
