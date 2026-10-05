# Wdrozenie na Vercel - krok po kroku

Wdrazasz jeden projekt, ktory zawiera panel www (`/`), endpoint MCP
(`/api/mcp`) i cron monitoringu (`/api/cron/monitor`).

> Pierwszego wdrozenia na prawdziwym Vercelu nie dalo sie sprawdzic przy
> pisaniu kodu. Jesli build zglosi blad, wklej jego log - to najszybsza droga
> do poprawki.

## Zanim zaczniesz

Trzy rzeczy, o ktore potykaja sie pierwsze wdrozenia:

1. **Cron.** Domyslny harmonogram w `vercel.json` to `0 7 * * *` (raz dziennie),
   bo plan Hobby (darmowy) nie przyjmuje czestszych. Na planie **Pro** zmien go
   na `*/10 * * * *` (co 10 minut). Czestszy cron na Hobby konczy sie odrzuceniem
   wdrozenia.
2. **Nazwy zmiennych Upstash.** Kod czyta `UPSTASH_REDIS_REST_URL` i
   `UPSTASH_REDIS_REST_TOKEN`, a jako zapas rowniez `KV_REST_API_URL` i
   `KV_REST_API_TOKEN`, ktore czesto wstawia integracja z Vercel. Jedne albo
   drugie wystarcza.
3. **Galaz produkcyjna.** Vercel domyslnie wdraza produkcje z `main`. Kod jest na
   `claude/sharp-volta-8erp64`. Albo scal ja do `main`, albo w
   **Settings → Git → Production Branch** wpisz te galaz.

## 1. Wygeneruj sekrety

Zapisz je w menedzerze hasel.

- Mac/Linux: `openssl rand -hex 32` (uruchom trzy razy).
- Windows (PowerShell 7):
  `[Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))`

Potrzebujesz:

| Zmienna | Skad |
| --- | --- |
| `ENCRYPTION_KEY` | 64 znaki hex z generatora |
| `MCP_AUTH_TOKEN` | 64 znaki hex z generatora |
| `CRON_SECRET` | 64 znaki hex z generatora |
| `ADMIN_PASSWORD` | Wymysl dlugie haslo do panelu |

**Skopiuj `ENCRYPTION_KEY` w bezpieczne miejsce.** Zgubiony klucz oznacza
koniecznosc ponownego podlaczenia wszystkich kont Vinted.

## 2. Zaimportuj projekt

1. Wejdz na vercel.com/new i zaloguj sie przez GitHub.
2. Wybierz repozytorium `andrzej304074-max/12` → **Import**.
3. **Framework Preset**: „Other". Katalog glowny i komendy zostaw domyslne
   (`npm run build` to tylko sprawdzenie typow).
4. **Jeszcze nie klikaj Deploy** - najpierw zmienne.

## 3. Dodaj zmienne srodowiskowe

W formularzu importu (sekcja Environment Variables) albo pozniej w
Settings → Environment Variables. Srodowisko: **Production**.

- `ADMIN_PASSWORD`
- `ENCRYPTION_KEY`
- `MCP_AUTH_TOKEN`
- `CRON_SECRET`
- opcjonalnie `NOTIFY_WEBHOOK_URL` - adres webhooka Discorda lub Slacka, na
  ktory przyjda powiadomienia o znaleziskach i nowych wiadomosciach

Pelna lista zmiennych z opisami: [`.env.example`](../.env.example).

## 3a. Dodaj baze Upstash (zrob to przed podlaczaniem kont)

1. W projekcie: **Storage → Create Database** (lub Marketplace → Upstash) →
   **Upstash Redis**. Plan darmowy wystarczy.
2. Wybierz region blisko funkcji (np. Frankfurt) i podlacz baze do projektu.
3. Sprawdz w Settings → Environment Variables, jakie nazwy zmiennych zostaly
   dodane. `UPSTASH_REDIS_REST_*` albo `KV_REST_API_*` - oba warianty dzialaja.

Bez Upstash konta, obserwowani i limity ginaja po kazdym wywolaniu funkcji, a
blokada po blednych haslach do panelu nie dziala miedzy wywolaniami.

## 4. Deploy

1. Kliknij **Deploy** (1-2 minuty).
2. Zmiana zmiennych po wdrozeniu wymaga **Redeploy**: Deployments → trzy kropki
   przy ostatnim wdrozeniu → Redeploy.
3. Przy bledzie builda otworz log i sprawdz: „Cannot find module ... .js"
   (problem z importami) albo komunikat o `maxDuration` lub o cronie.

## 5. Sprawdz, czy dziala

1. `https://TWOJ-PROJEKT.vercel.app/api/health` → `"status":"ok"`.
2. `https://TWOJ-PROJEKT.vercel.app/` → zaloguj sie haslem z `ADMIN_PASSWORD`.
3. **Pulpit → Konfiguracja serwera**: Upstash, klucz szyfrowania i token MCP
   powinny miec „ok". Czego brakuje, dodaj i zrob Redeploy.

## 6. Podlacz konto Vinted

**Konta → Dodaj konto**: rynek, login, haslo, kod SMS. Potem **Testuj**.

Endpointy Vinted nie sa oficjalnym API i nie dalo sie ich sprawdzic na zywo.
Vinted moze tez zablokowac logowanie z serwera (CAPTCHA) - panel zatrzyma sie
wtedy po jednej probie i napisze o tym. Szczegoly i procedura korekty pol
logowania: [ACCOUNTS.md](ACCOUNTS.md).

## 7. Podlacz klienta MCP

Zakladka **MCP** w panelu podaje gotowe polecenie:

```bash
claude mcp add --transport http vinted \
  https://TWOJ-PROJEKT.vercel.app/api/mcp \
  --header "Authorization: Bearer TWOJ_MCP_AUTH_TOKEN"
```

## 8. Automat wlaczaj na samym koncu

Najpierw jedna reczna oferta (`make_offer` z `confirm: true`) na testowym
przedmiocie, zeby sprawdzic sciezki zapisu (procedura w
[ACTIONS.md](ACTIONS.md)). Dopiero potem przelacznik na Pulpicie.

## Czestsze problemy

| Objaw | Co zrobic |
| --- | --- |
| Deploy odrzucony z powodu crona | Plan Hobby: zostaw `0 7 * * *` w `vercel.json` |
| Pulpit: Upstash „brak" | Dodaj `UPSTASH_REDIS_REST_URL` i `_TOKEN` (albo `KV_REST_API_*`), Redeploy |
| Panel: „Panel jest wylaczony" | Ustaw `ADMIN_PASSWORD`, Redeploy |
| Konta: nie mozna dodac konta | Ustaw `ENCRYPTION_KEY`, Redeploy |
| Klient MCP dostaje 500 / „no shared secret" | Ustaw `MCP_AUTH_TOKEN`, Redeploy |
| Cron zwraca 401 | Ustaw `CRON_SECRET` (Vercel wysyla go sam), Redeploy |
| Cron zwraca „skipped" | Brak Upstash - dodaj baze |
| Po wygasnieciu funkcji znikaja konta | Brak Upstash |
| Zmieniles `ENCRYPTION_KEY` i konta maja status „wymaga logowania" | Podlacz je ponownie (stary klucz nie odczyta zapisanych danych) |
