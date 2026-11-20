// LUMAR – AI-hulp: een bon of bestelbevestiging lezen en omzetten naar een inkoop. Alleen voor ingelogde leden.
import { admin, cors, json, requireMember, HttpError, BUCKET } from '../_shared/common.ts';

// Gratis: Google Gemini (GEMINI_API_KEY). Optioneel betaald: Anthropic (ANTHROPIC_API_KEY).
const GEMINI_MODELS = [Deno.env.get('AI_MODEL'), 'gemini-flash-latest', 'gemini-2.5-flash'].filter(Boolean) as string[];

const ORDER_TOOL = {
  name: 'record_order',
  description: 'Leg de gegevens van een inkoopbon of bestelbevestiging van horloges vast.',
  input_schema: {
    type: 'object',
    properties: {
      supplier: { type: 'string', description: 'Naam van de winkel, leverancier of verkoper (bijv. TicDistribution.eu, Vinted-gebruikersnaam)' },
      platform: { type: 'string', description: 'Platform als het via een marktplaats ging: Vinted, Marktplaats, Chrono24, Catawiki, eBay. Anders leeg.' },
      order_number: { type: 'string' },
      order_date: { type: 'string', description: 'Besteldatum als YYYY-MM-DD, leeg als onbekend' },
      currency: { type: 'string', description: 'ISO-valuta, bijv. EUR' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            brand: { type: 'string', description: 'Horlogemerk, bijv. Tissot. Leid af uit referentie of omschrijving als het er niet letterlijk staat.' },
            model: { type: 'string', description: 'Modellijn, kort, bijv. PRX, Seastar, Seamaster 300M. Leid af uit de referentie als je die herkent.' },
            reference: { type: 'string', description: 'Referentienummer precies zoals op de bon' },
            description: { type: 'string' },
            quantity: { type: 'integer', minimum: 1 },
            unit_price: { type: 'number', description: 'Prijs per stuk vóór de orderkorting, zoals op de bon' },
          },
          required: ['brand', 'model', 'quantity', 'unit_price'],
        },
      },
      discount: { type: 'number', description: 'Totale korting op de producten (positief getal). Verzendkorting hoort hier NIET bij.' },
      shipping: { type: 'number', description: 'Verzendkosten NA verzendkorting (gratis verzending = 0)' },
      buyer_protection: { type: 'number', description: 'Garantie, kopersbescherming, verzekering' },
      other_costs: { type: 'number', description: 'Overige kosten: invoerrechten, duty paid delivery, douane, servicekosten, transactiekosten' },
      total: { type: 'number', description: 'Eindbedrag dat betaald moet worden' },
      notes: { type: 'string', description: 'Korte opmerking in het Nederlands als iets onzeker is, anders leeg' },
    },
    required: ['items', 'total'],
  },
};

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    await requireMember(req);
    const body = await req.json().catch(() => ({}));
    if (body.action !== 'scan-receipt') throw new HttpError(400, 'Onbekende actie');
    if (!Deno.env.get('GEMINI_API_KEY') && !Deno.env.get('ANTHROPIC_API_KEY')) throw new HttpError(400, 'De AI is nog niet ingesteld: zet GEMINI_API_KEY in de Supabase-secrets.');
    const db = admin();
    let path = body.path as string | undefined, mime = body.mime as string | undefined, extraText = '';
    if (body.mail_id) {
      const { data: it } = await db.from('items').select('data').eq('id', body.mail_id).maybeSingle();
      if (!it) throw new HttpError(404, 'Mail niet gevonden');
      const m = it.data as any;
      const att = (m.attachments || []).find((a: any) => /pdf|image/.test(a.mime));
      if (att) { path = att.path; mime = att.mime; }
      else if (m.body_path) { path = m.body_path; mime = 'text/plain'; }
      extraText = `Mail van: ${m.from || ''}\nOnderwerp: ${m.subject || ''}\nDatum: ${m.date || ''}`;
    }
    if (!path) throw new HttpError(400, 'Geen bon gevonden om te lezen');
    const { data: file, error } = await db.storage.from(BUCKET).download(path);
    if (error) throw error;
    const bytes = new Uint8Array(await file.arrayBuffer());
    mime = (mime || file.type || '').split(';')[0] || (path.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
    const prompt = `${extraText}\n\nDit is een bon of bestelbevestiging van een horloge-inkoop voor LUMAR Watches. Lees alle horloges uit (één regel per referentie, met aantal), de orderkorting, verzendkosten na verzendkorting, garantie/kopersbescherming, overige kosten zoals invoerrechten, en het eindbedrag. Controleer dat som(aantal × prijs) − korting + verzending + garantie + overige = eindbedrag; zet anders een opmerking in notes.`;
    const isText = !(mime === 'application/pdf' || mime.startsWith('image/'));
    const order = Deno.env.get('GEMINI_API_KEY') ? await gemini(bytes, mime, isText, prompt) : await claude(bytes, mime, isText, prompt);
    return json({ order, source_path: path });
  } catch (e: any) {
    console.error(e);
    return json({ error: e?.message || String(e) }, e instanceof HttpError ? e.status : 500);
  }
});

function b64(bytes: Uint8Array) {
  let s = ''; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

// Gemini (gratis laag via Google AI Studio)
function toGemini(x: any): any {
  if (Array.isArray(x)) return x.map(toGemini);
  if (!x || typeof x !== 'object') return x;
  const o: any = {};
  for (const [k, v] of Object.entries(x)) {
    if (k === 'minimum') continue;
    o[k] = k === 'type' ? String(v).toUpperCase() : toGemini(v);
  }
  return o;
}
async function gemini(bytes: Uint8Array, mime: string, isText: boolean, prompt: string) {
  const parts: unknown[] = isText ? [{ text: new TextDecoder().decode(bytes).slice(0, 40000) }] : [{ inline_data: { mime_type: mime === 'image/jpg' ? 'image/jpeg' : mime, data: b64(bytes) } }];
  parts.push({ text: prompt });
  const body = JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: toGemini(ORDER_TOOL.input_schema) } });
  let last = '';
  for (const model of GEMINI_MODELS) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': Deno.env.get('GEMINI_API_KEY')!, 'content-type': 'application/json' }, body });
    const out = await res.json();
    if (res.status === 404) { last = out?.error?.message || 'model niet gevonden'; continue; }
    if (res.status === 429) throw new HttpError(429, 'De gratis AI-limiet is even bereikt. Probeer het over een minuut opnieuw.');
    if (!res.ok) throw new HttpError(400, 'AI: ' + (out?.error?.message || res.statusText));
    const text = out?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || '';
    try { return JSON.parse(text); } catch { throw new HttpError(400, 'De AI kon de bon niet lezen'); }
  }
  throw new HttpError(400, 'AI: ' + last);
}

// Anthropic (alleen als je die sleutel zelf instelt; betaald)
async function claude(bytes: Uint8Array, mime: string, isText: boolean, prompt: string) {
  const content: unknown[] = [];
  if (mime === 'application/pdf') content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64(bytes) } });
  else if (!isText) content.push({ type: 'image', source: { type: 'base64', media_type: mime === 'image/jpg' ? 'image/jpeg' : mime, data: b64(bytes) } });
  else content.push({ type: 'text', text: new TextDecoder().decode(bytes).slice(0, 40000) });
  content.push({ type: 'text', text: prompt + ' Gebruik de tool record_order.' });
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: Deno.env.get('CLAUDE_MODEL') || 'claude-sonnet-5-5', max_tokens: 2000, tools: [ORDER_TOOL], tool_choice: { type: 'tool', name: 'record_order' }, messages: [{ role: 'user', content }] }),
  });
  const out = await res.json();
  if (!res.ok) throw new HttpError(400, 'AI: ' + (out?.error?.message || res.statusText));
  const tool = (out.content || []).find((c: any) => c.type === 'tool_use');
  if (!tool) throw new HttpError(400, 'De AI kon de bon niet lezen');
  return tool.input;
}
