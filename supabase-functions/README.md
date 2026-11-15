# LUMAR Edge Functions (Supabase)

| Functie | JWT | Doel |
| --- | --- | --- |
| `lumar-integrations` | ja | OneDrive koppelen/synchroniseren, Gmail-koppelcode maken, ontkoppelen |
| `lumar-oauth-callback` | nee | Terugkeerpunt na inloggen bij Microsoft |
| `lumar-gmail-inbox` | nee (eigen koppelcode) | Ontvangt mails vanuit het Google Apps Script |

Benodigde secrets (Supabase → Edge Functions → Secrets): `MS_CLIENT_ID`, `MS_CLIENT_SECRET`.
Redirect-URI in de Microsoft-app: `https://anrrlpnzvpujbhncwbud.supabase.co/functions/v1/lumar-oauth-callback`.
