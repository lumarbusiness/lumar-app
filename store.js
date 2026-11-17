// LUMAR — opslag. Met Supabase-gegevens in config.js: gedeelde clouddatabase.
// Zonder: demomodus in deze browser (localStorage), handig om de app uit te proberen.

export const TABLES = ['purchase_batches', 'watches', 'expenses', 'bank_entries'];
export const DEFAULT_SETTINGS = {
  vat_enabled: true,
  vat_rate: 21,
  partners: ['Luuk', 'Marijn'],
  profit_shares: { Luuk: 50, Marijn: 50 },
  company_name: 'LUMAR Watches',
};

const emptyState = () => ({ watches: [], expenses: [], bank_entries: [], purchase_batches: [], items: [], settings: { ...DEFAULT_SETTINGS } });
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2));

export async function createStore(config, onRemoteChange = () => {}) {
  const useCloud = !!(config.SUPABASE_URL && config.SUPABASE_ANON_KEY);
  return useCloud ? cloudStore(config, onRemoteChange) : demoStore();
}

// ───────────── Demo (lokaal) ─────────────
function demoStore() {
  const KEY = 'lumar-demo-v1', FILES = 'lumar-demo-files-v1';
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; } };
  let state = read() || emptyState();
  state.settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
  state.items = state.items || [];
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { console.warn(e); } };
  const files = () => { try { return JSON.parse(localStorage.getItem(FILES)) || {}; } catch { return {}; } };
  let signedIn = sessionStorage.getItem('lumar-demo-user');

  return {
    mode: 'demo',
    state,
    get user() { return signedIn ? { id: 'demo', name: signedIn } : null; },
    async init() { return !!signedIn; },
    async signIn(email) {
      signedIn = /marijn/i.test(email) ? 'Marijn' : 'Luuk';
      sessionStorage.setItem('lumar-demo-user', signedIn);
    },
    async signOut() { signedIn = null; sessionStorage.removeItem('lumar-demo-user'); },
    async reload() { return state; },
    async insert(table, row) {
      const r = { id: uuid(), created_at: new Date().toISOString(), created_by_name: signedIn, ...row };
      state[table].push(r); persist(); return r;
    },
    async update(table, id, patch) {
      const r = state[table].find(x => x.id === id); if (!r) throw new Error('Niet gevonden');
      Object.assign(r, patch, { updated_at: new Date().toISOString() }); persist(); return r;
    },
    async remove(table, id) { state[table] = state[table].filter(x => x.id !== id); this.state = state; persist(); },
    async setSetting(key, value) { state.settings[key] = value; persist(); },
    async upload(blob, folder) {
      const path = `${folder}/${uuid()}`;
      const data = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
      const all = files(); all[path] = data;
      try { localStorage.setItem(FILES, JSON.stringify(all)); } catch { throw new Error('Demo-opslag is vol. Koppel Supabase voor onbeperkte foto\'s.'); }
      return path;
    },
    async fileUrl(path) { return files()[path] || null; },
    async invoke() { throw new Error('Koppelingen werken alleen met de gedeelde database (niet in demomodus).'); },
    async rpc() { return []; },
    async resetDemo() { state = emptyState(); this.state = state; persist(); localStorage.removeItem(FILES); },
  };
}

// ───────────── Supabase (gedeeld) ─────────────
async function cloudStore(config, onRemoteChange) {
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  const sb = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  const BUCKET = 'lumar-files';
  const urlCache = new Map();
  let user = null, members = [], channel = null, timer = null, presence = null;
  const store = { mode: 'cloud', state: emptyState(), online: new Set() };

  const check = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
  const memberName = id => members.find(m => m.user_id === id)?.display_name || '';
  const decorate = r => ({ ...r, created_by_name: memberName(r.created_by) });
  // numeric komt als string terug uit Postgres → naar getallen
  const NUM = ['purchase_price', 'extra_costs', 'total_cost', 'estimated_value', 'sale_price', 'sale_costs', 'amount', 'shipping_costs', 'buyer_protection', 'other_costs'];
  const normalize = r => { const o = decorate(r); for (const k of NUM) if (o[k] !== null && o[k] !== undefined) o[k] = +o[k]; return o; };
  const clean = row => { const o = { ...row }; delete o.created_by_name; delete o.id; delete o.created_at; delete o.created_by; for (const k in o) if (o[k] === '' || o[k] === undefined) o[k] = null; return o; };

  // Elk apparaat heeft een eigen geheime sleutel; de database laat alleen gekoppelde apparaten toe (max. 2 per persoon)
  function deviceKey() {
    let k = localStorage.getItem('lumar_device_key');
    if (!k || k.length < 64) { k = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join(''); localStorage.setItem('lumar_device_key', k); }
    return k;
  }
  function deviceName() {
    const ua = navigator.userAgent;
    const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Computer';
    const br = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'browser';
    const app = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    return `${os} · ${app ? 'app' : br}`;
  }
  async function claimDevice() {
    const r = check(await sb.rpc('claim_device', { p_secret: deviceKey(), p_name: deviceName() }));
    if (r?.ok) return;
    await sb.auth.signOut(); user = null;
    if (r?.reason === 'limiet') throw new Error(`Dit apparaat heeft geen toegang. Aan jouw account zijn al ${r.max} apparaten gekoppeld. Verwijder eerst een oud apparaat via Instellingen → Apparaten op een gekoppeld apparaat, en log hier daarna opnieuw in.`);
    throw new Error(`Dit apparaat heeft geen toegang (${r?.reason || 'onbekend'}).`);
  }

  async function setUser(session) {
    if (!session?.user) { user = null; return false; }
    await claimDevice();
    members = check(await sb.from('members').select('*'));
    const me = members.find(m => m.user_id === session.user.id);
    if (!me) { await sb.auth.signOut(); throw new Error('Dit account is nog niet toegevoegd als lid van LUMAR. Zie de installatiehandleiding.'); }
    user = { id: session.user.id, name: me.display_name, email: session.user.email };
    return true;
  }

  function subscribe() {
    if (channel) return;
    channel = sb.channel('lumar-sync');
    for (const t of [...TABLES, 'items', 'settings'])
      channel.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => {
        clearTimeout(timer); timer = setTimeout(async () => { await store.reload(); onRemoteChange(); }, 400);
      });
    channel.subscribe();
    // Wie is er nu online (Realtime Presence)
    presence = sb.channel('lumar-presence', { config: { presence: { key: user.id } } });
    presence.on('presence', { event: 'sync' }, () => {
      store.online = new Set(Object.keys(presence.presenceState()));
      store.onPresence?.();
    });
    presence.subscribe(st => { if (st === 'SUBSCRIBED') presence.track({ name: user.name, at: new Date().toISOString() }); });
  }

  Object.defineProperty(store, 'user', { get: () => user });
  Object.assign(store, {
    async init() {
      const { data } = await sb.auth.getSession();
      const ok = await setUser(data.session);
      if (ok) { await store.reload(); subscribe(); }
      return ok;
    },
    async signIn(email, password) {
      const data = check(await sb.auth.signInWithPassword({ email, password }));
      await setUser(data.session); await store.reload(); subscribe();
    },
    async signOut() { if (channel) { sb.removeChannel(channel); channel = null; } if (presence) { sb.removeChannel(presence); presence = null; } await sb.auth.signOut(); user = null; },
    async reload() {
      const results = await Promise.all(TABLES.map(t => sb.from(t).select('*').order('created_at')));
      const st = emptyState();
      TABLES.forEach((t, i) => { st[t] = check(results[i]).map(normalize); });
      // items (Taken, Ideeën, Marketing, Branding): werkt ook als de update-SQL nog niet is uitgevoerd
      const it = await sb.from('items').select('*').order('created_at');
      store.itemsMissing = !!it.error;
      st.items = it.error ? [] : it.data.map(normalize);
      const settings = check(await sb.from('settings').select('*'));
      for (const s of settings) st.settings[s.key] = s.value;
      store.state = st;
      return st;
    },
    async insert(table, row) {
      const r = normalize(check(await sb.from(table).insert(clean(row)).select().single()));
      store.state[table].push(r); return r;
    },
    async update(table, id, patch) {
      const p = clean(patch); if (table === 'watches') p.updated_at = new Date().toISOString();
      const r = normalize(check(await sb.from(table).update(p).eq('id', id).select().single()));
      const i = store.state[table].findIndex(x => x.id === id); if (i >= 0) store.state[table][i] = r;
      return r;
    },
    async remove(table, id) {
      check(await sb.from(table).delete().eq('id', id));
      store.state[table] = store.state[table].filter(x => x.id !== id);
    },
    async setSetting(key, value) {
      check(await sb.from('settings').upsert({ key, value, updated_at: new Date().toISOString() }));
      store.state.settings[key] = value;
    },
    async upload(blob, folder) {
      const ext = (blob.type.split('/')[1] || 'bin').replace('jpeg', 'jpg').replace('quicktime', 'mov').replace('x-m4v', 'm4v');
      const path = `${folder}/${uuid()}.${ext}`;
      check(await sb.storage.from(BUCKET).upload(path, blob, { contentType: blob.type, upsert: false }));
      store.onUploaded?.(path);
      return path;
    },
    async invoke(name, body = {}) {
      const { data, error } = await sb.functions.invoke(name, { body });
      if (error) {
        let msg = error.message;
        try { const j = await error.context?.json?.(); if (j?.error) msg = j.error; } catch { /* geen json */ }
        const e = new Error(msg); e.code = error.context?.status; throw e;
      }
      return data;
    },
    async rpc(name, args) { return check(await sb.rpc(name, args)); },
    async fileUrl(path) {
      if (!path) return null;
      const c = urlCache.get(path); if (c && c.until > Date.now()) return c.url;
      const data = check(await sb.storage.from(BUCKET).createSignedUrl(path, 3600));
      urlCache.set(path, { url: data.signedUrl, until: Date.now() + 3300e3 });
      return data.signedUrl;
    },
  });
  return store;
}
