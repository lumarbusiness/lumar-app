// LUMAR – AI-hulp: een bon of bestelbevestiging lezen en omzetten naar een inkoop. Alleen voor ingelogde leden.
import { admin, cors, json, requireMember, HttpError, BUCKET } from '../_shared/common.ts';

const MODEL = Deno.env.get('AI_MODEL') || 'claude-sonnet-5-5';

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
    if (!Deno.env.get('ANTHROPIC_API_KEY')) throw new HttpError(400, 'De AI is nog niet ingesteld: ANTHROPIC_API_KEY ontbreekt in Supabase.');
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
    const content: unknown[] = [];
    if (mime === 'application/pdf') content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64(bytes) } });
    else if (mime.startsWith('image/')) content.push({ type: 'image', source: { type: 'base64', media_type: mime === 'image/jpg' ? 'image/jpeg' : mime, data: b64(bytes) } });
    else content.push({ type: 'text', text: new TextDecoder().decode(bytes).slice(0, 40000) });
    content.push({ type: 'text', text: `${extraText}\n\nDit is een bon of bestelbevestiging van een horloge-inkoop voor LUMAR Watches. Lees alle horloges uit (één regel per referentie, met aantal), de orderkorting, verzendkosten na verzendkorting, garantie/kopersbescherming, overige kosten zoals invoerrechten, en het eindbedrag. Controleer dat som(aantal × prijs) − korting + verzending + garantie + overige = eindbedrag; zet anders een opmerking in notes. Gebruik de tool record_order.` });
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 2000, tools: [ORDER_TOOL], tool_choice: { type: 'tool', name: 'record_order' }, messages: [{ role: 'user', content }] }),
    });
    const out = await res.json();
    if (!res.ok) throw new HttpError(400, 'AI: ' + (out?.error?.message || res.statusText));
    const tool = (out.content || []).find((c: any) => c.type === 'tool_use');
    if (!tool) throw new HttpError(400, 'De AI kon de bon niet lezen');
    return json({ order: tool.input, source_path: path });
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
