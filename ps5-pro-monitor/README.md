# PS5 Pro-vakten

Et lite program som kjører på PC-en din, følger med på **PlayStation 5 Pro hos norske
nettbutikker**, og sender deg et varsel på **Discord** og/eller **Telegram** når noe endrer
seg: varen kommer på lager, blir utsolgt, prisen endres, eller en butikk legger ut en ny
produktside.

```
🟢 PÅ LAGER hos Komplett
PlayStation 5 Pro 2TB
Pris: 18 990 kr → 17 990 kr (−1 000 kr, −5,3 %)
Status: Utsolgt → På lager (50+ stk. på lager)
Kilder: JSON-LD ✓ · lagermarkør ✓ (2/2 enige)
https://www.komplett.no/product/1346176/…
```

## Kom i gang (Windows)

1. Installer [Python 3.11 eller nyere](https://www.python.org/downloads/) og huk av for
   **«Add python.exe to PATH»**.
2. Last ned denne mappen (`ps5-pro-monitor`) til PC-en.
3. Dobbeltklikk **`start.bat`**. Første gang settes alt opp, og `config.toml` åpnes i Notisblokk.
4. Lim inn en Discord-webhook og/eller Telegram-bot (se under), lagre, og kjør `start.bat` igjen.

Programmet sender en statusmelding når det har sjekket alle butikkene første gang, og er
deretter stille til noe faktisk endrer seg. La vinduet stå åpent.

På Linux/macOS: `./start.sh`.

### Discord

Kanalinnstillinger → **Integrasjoner** → **Webhooks** → **Ny webhook** → **Kopier webhook-URL**,
og lim den inn som `webhook_url` under `[discord]`. Sett `mention = "@everyone"` hvis du vil
bli pinget når noe kommer på lager.

### Telegram

1. Skriv til [@BotFather](https://t.me/BotFather), send `/newbot` og kopier tokenet til `bot_token`.
2. Send en melding til den nye boten din.
3. Åpne `https://api.telegram.org/bot<TOKEN>/getUpdates` i nettleseren og kopier tallet
   under `"chat": {"id": …}` til `chat_id`.

Med Telegram kan du også skrive `/status`, `/ping` og `/hjelp` til boten.

Sjekk at varslingen virker med `start.bat test-notify`.

## Kommandoer

| Kommando | Hva den gjør |
|---|---|
| `start.bat` | Kjører kontinuerlig (det vanlige). |
| `start.bat once` | Sjekker alt én gang og viser en tabell. Sender ingenting og lagrer ingenting. |
| `start.bat once --notify` | Én runde som lagrer status og varsler – for Oppgaveplanlegger/cron. |
| `start.bat status` | Viser sist lagrede status. |
| `start.bat check <URL>` | Viser hva programmet klarer å lese ut av én side. Nyttig for nye butikker. |
| `start.bat test-notify` | Sender et testvarsel. |

**Starte automatisk med Windows:** trykk `Win + R`, skriv `shell:startup`, og legg en snarvei
til `start.bat` i mappen som åpnes.

## Slik virker det

**Flere steder i kildekoden.** Hver produktside leses fra flere uavhengige steder, fordi ett
sted alene ofte er utdatert (cachet) eller mangler:

| Kilde | Hva det er |
|---|---|
| JSON-LD | Strukturerte produktdata (`schema.org/Product`) som butikken legger ut til søkemotorer. |
| meta-tagger | `product:price:amount`, `product:availability` og lignende. |
| microdata | `itemprop="price"` / `itemprop="availability"` i selve HTML-en. |
| lagerdata | Butikkens egne innebygde data: Elkjøps «sellability», Kjells nettlagerstatus, NetOnNets lagernivåer. Forankret i varenummeret, så tilbehør på samme side ikke forveksles. |
| lagermarkør | Mønstre rundt lagerstatusen på siden (f.eks. Kompletts «50+ stk. på lager»). |

Kildene stemmer over resultatet. Varselet viser hvem som var enige, og sier fra hvis de er uenige.

**Bekreftelse før varsel.** En endring må sees to ganger på rad (ny sjekk etter 20 sekunder)
før den varsles, så et cache-blaff gir ikke falsk alarm.

**Prisjakt som sikkerhetsnett.** Tilbudslisten på Prisjakts PS5 Pro-side leses også. Den dekker
butikker som ikke kan leses direkte og fanger opp nye butikker. Butikker som allerede overvåkes
direkte varsles ikke dobbelt – men hvis en av dem slutter å svare, tar Prisjakt over for den.

**Nye produktsider oppdages automatisk.** Butikkene oppretter ofte nye varenummer for nye
revisjoner og pakker. Kategorisidene skannes jevnlig, og nye PS5 Pro-sider legges til av seg selv
(tilbehør som deksler og kontrollere filtreres bort).

**Sier fra om seg selv.** Statusmelding ved oppstart, daglig oppsummering kl. 08:00, varsel når en
butikk ikke lar seg sjekke og når den virker igjen. Med `heartbeat_url` kan programmet i tillegg
pinge f.eks. healthchecks.io, slik at du får beskjed hvis PC-en slås av.

## Butikker

Status da dette ble testet 9. november 2026 (fra en skyserver – hjemmefra kan det se annerledes ut):

| Butikk | Direkte | Kilder |
|---|---|---|
| Elkjøp | ✅ | JSON-LD + lagerdata |
| Komplett | ✅ | JSON-LD + lagermarkør |
| Power | ✅ | JSON-LD + meta-tagger |
| Kjell & Company | ✅ | JSON-LD + meta-tagger + lagerdata |
| Elon | ✅ | microdata + meta-tagger |
| Clas Ohlson | ✅ | JSON-LD |
| MaxGaming | ✅ | JSON-LD + microdata |
| Computersalg (CS Megastore) | ✅ | microdata + lagermarkør |
| NetOnNet | ❌ avviser forespørselen | dekkes via Prisjakt |
| CDON | ❌ avviser forespørselen | dekkes via Prisjakt |
| Proshop | ❌ avviser forespørselen | dekkes via Prisjakt når de har et tilbud der |
| Dustin | ❌ avviser forespørselen | dekkes via Prisjakt når de har et tilbud der |
| Obs, HomeIT og andre | – | via Prisjakt |

Butikker som avviser automatiske forespørsler blir **ikke** forsøkt omgått. Programmet
presenterer seg ærlig, følger `robots.txt`, og prøver slike butikker sjeldnere (opptil hvert
30. minutt) i tilfelle de slipper det inn. De står med ⚠️ i statusmeldingen.

Ikke med: Multicom (pris og lager lastes med JavaScript og finnes ikke i kildekoden), og
Coolshop, Platekompaniet, Gamezone og Spaceworld (hadde ingen PS5 Pro-side da dette ble laget;
de fanges opp via Prisjakt hvis de legger ut en).

### Legge til en butikk eller side

Test siden først:

```
start.bat check https://butikk.no/produkt/playstation-5-pro
```

Viser den pris og status, legg den i `stores.local.toml` (samme format som `stores.toml`):

```toml
[[store]]
id = "minbutikk"
name = "Min butikk"
products = ["https://butikk.no/produkt/playstation-5-pro"]
```

## Innstillinger

Alt står forklart i `config.example.toml`. De viktigste:

| Innstilling | Standard | |
|---|---|---|
| `interval_seconds` | 90 | Hvor ofte hver produktside sjekkes. |
| `confirmations` | 2 | Antall like observasjoner før en endring varsles. |
| `notify_price_changes` | true | Varsle prisendringer (på minst `min_price_change` kr). |
| `notify_sold_out` | true | Varsle når noe blir utsolgt. |
| `daily_summary` | "08:00" | Daglig oppsummering. Tom streng slår den av. |
| `mention` (Discord) | "" | Hvem som pinges ved «på lager». |

Hold intervallet romslig. Butikkene tåler ikke masing, og for tette sjekker er den sikreste
måten å bli stengt ute på.

Discord-webhook og Telegram-token kan også gis som miljøvariabler:
`DISCORD_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

## Filer

| Fil | |
|---|---|
| `config.toml` | Dine innstillinger og hemmeligheter (lages fra `config.example.toml`, ikke i git). |
| `stores.toml` | Butikker og produktsider. |
| `state.json` | Siste kjente status – gjør at endringer mens programmet var av også varsles. |
| `history.jsonl` | Logg over alle endringer. |
| `monitor.log` | Programlogg. |

## Begrensninger

- Programmet varsler bare. Det legger ikke i handlekurv og kjøper ingenting.
- Data via Prisjakt er litt forsinket sammenlignet med direkte sjekk.
- Hvis en butikk legger om nettsiden, kan en kilde slutte å virke. Da varsles det
  («fant verken pris eller lagerstatus»), og `check`-kommandoen viser hva som fortsatt leses.

## Utvikling

```
python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m unittest discover -s tests -t .
```

Testene bruker en simulert nettbutikk og går ikke mot ekte nettsteder.
