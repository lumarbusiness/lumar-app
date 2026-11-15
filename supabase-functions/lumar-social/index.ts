// LUMAR – Instagram en TikTok: koppelen, posten/concepten en statistieken. Alleen voor ingelogde leden.
import { admin, cors, json, requireMember, HttpError, randomToken, BUCKET, CALLBACK_URL, IG_SCOPES, IG_GRAPH, TT_SCOPES, TT_API, tiktokToken } from '../_shared/common.ts';

type DB = ReturnType<typeof admin>;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const user = await requireMember(req);
    const body = await req.json().catch(() => ({}));
    const db = admin();
    switch (body.action) {
      case 'connect': return json({ url: await connectUrl(db, body.provider, user.id) });
      case 'ig-publish': return json(await igPublish(db, body.paths || [], String(body.caption || '')));
      case 'ig-finish': return json(await igFinish(await igToken(db), body.creation_id));
      case 'tt-draft': return json(await ttDraft(db, body.path));
      case 'tt-status': {
        const t = await ttToken(db);
        return json(await ttApi(t, '/post/publish/status/fetch/', { publish_id: body.publish_id }));
      }
      case 'disconnect': {
        if (!['instagram', 'tiktok'].includes(body.provider)) throw new HttpError(400, 'Onbekende koppeling');
        await db.from('integrations').delete().eq('provider', body.provider);
        return json({ ok: true });
      }
      case 'stats': {
        const out: Record<string, unknown> = {};
        const [ig, tt] = await Promise.allSettled([igStats(db), ttStats(db)]);
        out.instagram = ig.status === 'fulfilled' ? ig.value : { error: (ig.reason as Error)?.message };
        out.tiktok = tt.status === 'fulfilled' ? tt.value : { error: (tt.reason as Error)?.message };
        return json(out);
      }
      default: throw new HttpError(400, 'Onbekende actie');
    }
  } catch (e: any) {
    console.error(e);
    return json({ error: e?.message || String(e) }, e instanceof HttpError ? e.status : 500);
  }
});

async function connectUrl(db: DB, provider: string, userId: string) {
  const nonce = randomToken();
  if (provider === 'instagram') {
    if (!Deno.env.get('IG_APP_ID') || !Deno.env.get('IG_APP_SECRET')) throw new HttpError(400, 'Instagram is nog niet ingesteld (IG_APP_ID / IG_APP_SECRET ontbreken in Supabase).');
  } else if (provider === 'tiktok') {
    if (!Deno.env.get('TIKTOK_CLIENT_KEY') || !Deno.env.get('TIKTOK_CLIENT_SECRET')) throw new HttpError(400, 'TikTok is nog niet ingesteld (TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET ontbreken in Supabase).');
  } else throw new HttpError(400, 'Onbekende koppeling');
  await db.from('oauth_states').delete().lt('created_at', new Date(Date.now() - 3600e3).toISOString());
  const { error } = await db.from('oauth_states').insert({ nonce, provider, user_id: userId });
  if (error) throw error;
  if (provider === 'instagram') return 'https://www.instagram.com/oauth/authorize?' + new URLSearchParams({
    client_id: Deno.env.get('IG_APP_ID')!, redirect_uri: CALLBACK_URL, response_type: 'code', scope: IG_SCOPES, state: nonce, force_reauth: 'true' });
  return 'https://www.tiktok.com/v2/auth/authorize/?' + new URLSearchParams({
    client_key: Deno.env.get('TIKTOK_CLIENT_KEY')!, redirect_uri: CALLBACK_URL, response_type: 'code', scope: TT_SCOPES, state: nonce });
}

async function getRow(db: DB, provider: string) {
  const { data } = await db.from('integrations').select('*').eq('provider', provider).maybeSingle();
  if (!data?.access_token) throw new HttpError(400, `${provider === 'instagram' ? 'Instagram' : 'TikTok'} is niet gekoppeld`);
  return data;
}

// ───── Instagram ─────
async function igToken(db: DB) {
  const row = await getRow(db, 'instagram');
  const left = new Date(row.expires_at).getTime() - Date.now(), age = Date.now() - new Date(row.updated_at).getTime();
  if (left < 0) throw new HttpError(400, 'De Instagram-koppeling is verlopen. Koppel opnieuw bij Instellingen.');
  if (left < 20 * 864e5 && age > 864e5) { // token van 60 dagen tijdig verlengen
    const r = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${row.access_token}`).then(r => r.json()).catch(() => ({}));
    if (r.access_token) {
      await db.from('integrations').update({ access_token: r.access_token, refresh_token: r.access_token, expires_at: new Date(Date.now() + (r.expires_in || 5184000) * 1000).toISOString(), updated_at: new Date().toISOString() }).eq('provider', 'instagram');
      return r.access_token as string;
    }
  }
  return row.access_token as string;
}
async function ig(token: string, path: string, params: Record<string, string> = {}, method = 'GET') {
  const qs = new URLSearchParams({ ...params, access_token: token });
  const res = method === 'GET' ? await fetch(`${IG_GRAPH}${path}?${qs}`) : await fetch(`${IG_GRAPH}${path}`, { method, body: qs });
  const d = await res.json();
  if (!res.ok || d.error) throw new HttpError(400, 'Instagram: ' + (d.error?.error_user_msg || d.error?.message || res.statusText));
  return d;
}
const isVideo = (p: string) => /\.(mp4|mov|m4v)$/i.test(p);
async function signed(db: DB, path: string) {
  const { data, error } = await db.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (error) throw error;
  return data.signedUrl;
}
async function waitReady(token: string, id: string, maxMs: number) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    const s = await ig(token, `/${id}`, { fields: 'status_code,status' });
    if (s.status_code === 'FINISHED') return true;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new HttpError(400, 'Instagram kon de media niet verwerken: ' + (s.status || s.status_code));
    await sleep(3000);
  }
  return false;
}
async function igPublish(db: DB, paths: string[], caption: string) {
  if (!paths.length) throw new HttpError(400, 'Voeg eerst een foto of video toe aan de post');
  if (paths.length > 10) throw new HttpError(400, 'Instagram staat maximaal 10 foto\'s of video\'s per post toe');
  const token = await igToken(db);
  let creation: string;
  if (paths.length === 1) {
    const url = await signed(db, paths[0]);
    creation = (await ig(token, '/me/media', isVideo(paths[0]) ? { media_type: 'REELS', video_url: url, caption } : { image_url: url, caption }, 'POST')).id;
  } else {
    const kids: string[] = [];
    for (const p of paths) {
      const url = await signed(db, p);
      kids.push((await ig(token, '/me/media', isVideo(p) ? { media_type: 'VIDEO', video_url: url, is_carousel_item: 'true' } : { image_url: url, is_carousel_item: 'true' }, 'POST')).id);
    }
    for (const k of kids) if (!await waitReady(token, k, 60e3)) return { pending: true, creation_id: null, note: 'Video wordt nog verwerkt, probeer het zo opnieuw' };
    creation = (await ig(token, '/me/media', { media_type: 'CAROUSEL', children: kids.join(','), caption }, 'POST')).id;
  }
  if (!await waitReady(token, creation, 100e3)) return { pending: true, creation_id: creation };
  return await igFinish(token, creation);
}
async function igFinish(token: string, creation: string) {
  if (!creation) throw new HttpError(400, 'Geen post om af te ronden');
  if (!await waitReady(token, creation, 20e3)) return { pending: true, creation_id: creation };
  const pub = await ig(token, '/me/media_publish', { creation_id: creation }, 'POST');
  const m = await ig(token, `/${pub.id}`, { fields: 'id,permalink,timestamp' }).catch(() => ({ id: pub.id }));
  return { id: pub.id, permalink: m.permalink || null };
}
async function igStats(db: DB) {
  const token = await igToken(db);
  const profile = await ig(token, '/me', { fields: 'user_id,username,name,profile_picture_url,followers_count,follows_count,media_count' });
  const media = (await ig(token, '/me/media', { fields: 'id,caption,media_type,media_product_type,permalink,timestamp,thumbnail_url,media_url,like_count,comments_count', limit: '30' })).data || [];
  await Promise.all(media.map(async (m: any) => {
    for (const metric of ['views,reach,saved,shares', 'reach,saved']) {
      try {
        const r = await ig(token, `/${m.id}/insights`, { metric });
        for (const x of r.data || []) m[x.name] = x.values?.[0]?.value ?? x.total_value?.value ?? null;
        break;
      } catch { /* niet elke soort post heeft alle cijfers */ }
    }
  }));
  return { profile, media };
}

// ───── TikTok ─────
async function ttToken(db: DB) {
  const row = await getRow(db, 'tiktok');
  if (new Date(row.expires_at).getTime() - Date.now() > 5 * 60e3) return row.access_token as string;
  const t = await tiktokToken({ grant_type: 'refresh_token', refresh_token: row.refresh_token });
  await db.from('integrations').update({ access_token: t.access_token, refresh_token: t.refresh_token || row.refresh_token, expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(), updated_at: new Date().toISOString() }).eq('provider', 'tiktok');
  return t.access_token;
}
async function ttApi(token: string, path: string, body?: unknown) {
  const res = await fetch(`${TT_API}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || (d.error?.code && d.error.code !== 'ok')) throw new HttpError(400, 'TikTok: ' + (d.error?.message || d.error?.code || res.statusText));
  return d.data;
}
async function ttDraft(db: DB, path: string) {
  if (!path || !isVideo(path)) throw new HttpError(400, 'Naar TikTok kan alleen een video (mp4 of mov)');
  const token = await ttToken(db);
  const { data: file, error } = await db.storage.from(BUCKET).download(path);
  if (error) throw error;
  const bytes = new Uint8Array(await file.arrayBuffer()), size = bytes.length;
  // TikTok: stukken van 5–64 MB; kleiner dan 64 MB gaat in één keer
  const chunk = size <= 64e6 ? size : 10_000_000, count = size <= 64e6 ? 1 : Math.floor(size / chunk);
  const init = await ttApi(token, '/post/publish/inbox/video/init/', { source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunk, total_chunk_count: count } });
  for (let i = 0; i < count; i++) {
    const start = i * chunk, end = i === count - 1 ? size : start + chunk;
    const r = await fetch(init.upload_url, { method: 'PUT', headers: { 'Content-Type': /\.mov$/i.test(path) ? 'video/quicktime' : 'video/mp4', 'Content-Range': `bytes ${start}-${end - 1}/${size}`, 'Content-Length': String(end - start) }, body: bytes.slice(start, end) });
    if (!r.ok) throw new HttpError(400, `TikTok-upload mislukt (${r.status})`);
  }
  return { publish_id: init.publish_id };
}
async function ttStats(db: DB) {
  const token = await ttToken(db);
  let profile: any = {};
  try { profile = (await ttApi(token, '/user/info/?fields=open_id,display_name,avatar_url,follower_count,following_count,likes_count,video_count')).user; }
  catch { profile = (await ttApi(token, '/user/info/?fields=open_id,display_name,avatar_url')).user; }
  const fields = 'id,title,video_description,create_time,cover_image_url,share_url,view_count,like_count,comment_count,share_count';
  const v = await ttApi(token, `/video/list/?fields=${fields}`, { max_count: 20 });
  return { profile, videos: v?.videos || [] };
}
