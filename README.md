# LUMAR Watches — app

Een installeerbare web-app (PWA) voor de administratie van LUMAR Watches. Werkt op Windows en Mac, en Luuk en Marijn zien dezelfde gegevens.

**Startscherm met apps:** Voorraad, Financiën, Marketing, Ideeën, Taken, Branding, Documenten en Instellingen. Elke app heeft dezelfde opbouw en ze delen dezelfde gegevens (bijvoorbeeld: een wens op de wishlist wordt met één klik een inkoop, een post of taak hangt aan een horloge).

**Wat erin zit:** dashboard, voorraad (met foto's), inkoop van één horloge of een bundel (gezamenlijke kosten worden verdeeld), verkoop met winst- en btw-berekening, retouren (van klant en naar verkoper), afschrijven, uitgaven met bonnen, bank met openstaande posten, rapportages (resultatenrekening, per maand, per merk en platform, btw per kwartaal), kapitaal per vennoot en CSV-export.

**Zonder installatie uitproberen:** open de map met een lokale webserver (bijvoorbeeld `npx serve` of `python -m http.server`) en ga naar `http://localhost:8000`. Zonder Supabase-gegevens draait de app in demomodus: alles blijft dan in je eigen browser.

---

## Eenmalige installatie (± 20 minuten)

### 1. Supabase: de gedeelde database
1. Maak een gratis account aan op [supabase.com](https://supabase.com) en klik op **New project**. Noem het `lumar`, kies regio **West EU (Frankfurt/Amsterdam)** en bewaar het databasewachtwoord goed.
2. Ga naar **SQL Editor → New query**, plak de hele inhoud van `schema.sql` en klik op **Run**.
3. Ga naar **Authentication → Users → Add user → Create new user** en maak een account aan voor Luuk en een voor Marijn (e-mail + wachtwoord, en vink **Auto confirm user** aan).
4. Ga terug naar de **SQL Editor** en voer dit uit, met jullie eigen e-mailadressen:
   ```sql
   insert into public.members (user_id, display_name)
   select id, 'Luuk' from auth.users where email = 'luuk@voorbeeld.nl';
   insert into public.members (user_id, display_name)
   select id, 'Marijn' from auth.users where email = 'marijn@voorbeeld.nl';
   ```
5. Ga naar **Project Settings → API** (of **Data API**) en kopieer de **Project URL** en de **anon public key**. Plak ze in `config.js`.
   *De anon key mag in de code staan: alleen ingelogde leden kunnen gegevens zien, dat regelt de database zelf.*
6. Zet onder **Authentication → Sign In / Providers** de optie **Allow new users to sign up** uit, zodat niemand anders een account kan aanmaken.

### 1b. Update voor de apps (bestaande installatie)
Heb je de database al eerder ingericht? Voer dan `update-modules.sql` één keer uit in **SQL Editor → New query → Run**. Nodig voor Taken, Ideeën, Marketing en Branding.

### 2. GitHub: de code en het online zetten
1. Maak een (gratis) account op [github.com](https://github.com) en klik op **New repository**. Noem hem `lumar-app` en kies **Public** (gratis GitHub Pages werkt alleen met een openbare repository; jullie gegevens blijven privé, die staan achter de inlog in Supabase).
2. Klik op **uploading an existing file** en sleep de *inhoud* van deze map erin (dus `index.html`, `js/`, `supabase/` enzovoort, niet de map zelf). Klik op **Commit changes**.
3. Ga naar **Settings → Pages**. Kies bij **Source** voor **Deploy from a branch**, branch **main**, map **/ (root)** en klik op **Save**.
4. Na een minuut of twee staat de app op `https://<jouw-gebruikersnaam>.github.io/lumar-app/`. Een eigen domein is niet nodig.
5. Geef Marijn toegang via **Settings → Collaborators**, zodat hij ook wijzigingen kan doen.

Elke wijziging in de repository staat daarna automatisch binnen een paar minuten live.

### 4. Installeren op je laptop
- **Windows (Chrome of Edge):** open het adres, klik rechts in de adresbalk op het installatie-icoon (⊕ of "App beschikbaar") → **Installeren**. LUMAR staat daarna in het Startmenu en kun je aan de taakbalk vastmaken.
- **Mac (Chrome):** zelfde manier, het installatie-icoon in de adresbalk. **Mac (Safari):** menu **Archief → Voeg toe aan Dock**.

Daarna open je LUMAR gewoon via het icoon, als een normaal programma. Updates komen vanzelf binnen bij het opnieuw openen.

---

## Hoe de boekhouding werkt
- **Kostprijs** = inkoopprijs + extra kosten. Bij een bundel worden verzendkosten, kopersbescherming en overige kosten verdeeld naar verhouding van de inkoopprijs, gelijk of handmatig.
- **Winst per horloge** = verkoopprijs − verkoopkosten − kostprijs − btw (marge).
- **Btw margeregeling** (instelbaar): (verkoopprijs − inkoopprijs) × 21/121 per horloge. Indicatief: laat de aangifte controleren door een boekhouder. Uitzetten kan bij Instellingen, bijvoorbeeld bij de KOR.
- **Bank:** alles wat als *betaald* wordt ingevoerd, maakt automatisch een bankmutatie aan. *Nog te betalen/ontvangen* komt onder Openstaand en verwerk je later met één klik.
- **Privé betaald:** inkopen of kosten die een vennoot zelf voorschiet, tellen mee als inbreng van die vennoot.
- **Kapitaal per vennoot** = stortingen + privé betaald − opnames + winstaandeel (standaard 50/50).

## Controle (Financiën → Controle)
De app rekent bij elke wijziging na of de boekhouding sluit:
**bank + voorraad + nog te ontvangen − nog te betalen − btw-schuld = stortingen + privé voorgeschoten − opnames + resultaat.**
Daarnaast wordt elke inkoop, bundel, verkoop, retour en uitgave gecontroleerd op precies één juiste bankmutatie.
Staat er iets niet goed, dan zie je dat op het overzicht en op het blokje Financiën.

- **Kosten achteraf** (service, reparatie, band): open het horloge → **＋ Kosten**. Ze tellen bij de kostprijs, niet als losse bedrijfskosten.
- **Btw-afdracht** boek je via Bank → ＋ Mutatie → Btw-afdracht.
- **Saldocorrecties** tellen als kasverschil in het resultaat; zoek eerst naar een vergeten boeking.

## Bestanden
| Bestand | Inhoud |
| --- | --- |
| `index.html`, `styles.css` | Opbouw en vormgeving |
| `app.js` | Schermen en formulieren |
| `logic.js` | Alle berekeningen (winst, btw, bank, kapitaal) |
| `store.js` | Opslag: Supabase of demomodus |
| `config.js` | Supabase-gegevens |
| `schema.sql` | Databasetabellen en beveiliging |
| `sw.js`, `manifest.webmanifest`, `icon*` | Installeerbare app |
