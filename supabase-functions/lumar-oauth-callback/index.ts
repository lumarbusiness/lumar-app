// LUMAR – terugkeerpunt na inloggen bij Microsoft (OneDrive). Wordt door de browser aangeroepen.
import { admin, APP_URL, MS_AUTH, MS_SCOPES, CALLBACK_URL } from '../_shared/common.ts';

const back = (q: Record<string, string>) => Response.redirect(`${APP_URL}?${new URLSearchParams(q)}#instellingen/settings`, 302);

Deno.serve(async req => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code'), state = url.searchParams.get('state');
  if (url.searchParams.get('error')) return back({ koppelfout: url.searchParams.get('error_description') || url.searchParams.get('error')! });
  if (!code || !state) return back({ koppelfout: 'Onvolledig antwoord van Microsoft' });
  const db = admin();
  const { data: st } = await db.from('oauth_states').select('*').eq('nonce', state).maybeSingle();
  await db.from('oauth_states').delete().eq('nonce', state);
  if (!st || Date.now() - new Date(st.created_at).getTime() > 15 * 60e3) return back({ koppelfout: 'Koppelverzoek verlopen, probeer opnieuw' });
  const res = await fetch(`${MS_AUTH}/token`, { method: 'POST', body: new URLSearchParams({
    client_id: Deno.env.get('MS_CLIENT_ID')!, client_secret: Deno.env.get('MS_CLIENT_SECRET')!, grant_type: 'authorization_code', code, redirect_uri: CALLBACK_URL, scope: MS_SCOPES,
  }) });
  const t = await res.json();
  if (!res.ok) return back({ koppelfout: t.error_description || t.error || 'Token mislukt' });
  const me = await fetch('https://graph.microsoft.com/v1.0/me', { headers: { Authorization: `Bearer ${t.access_token}` } }).then(r => r.json()).catch(() => ({}));
  const { error } = await db.from('integrations').upsert({
    provider: 'onedrive', account: me.userPrincipalName || me.mail || me.displayName || 'Microsoft-account', refresh_token: t.refresh_token, access_token: t.access_token,
    expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(), connected_by: st.user_id, updated_at: new Date().toISOString(),
  });
  if (error) return back({ koppelfout: error.message });
  return back({ connected: 'onedrive' });
});
