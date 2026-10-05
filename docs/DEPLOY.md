# Wdrozenie na Vercel - krok po kroku

Wdrazasz jeden projekt: panel www (`/`), endpoint MCP (`/api/mcp`), backend
panelu (`/api/app/*`) i cron monitoringu (`/api/cron/monitor`). Calosc to okolo
20-30 minut.

## Co zostalo sprawdzone przed wdrozeniem, a czego nie

Sprawdzone lokalnie prawdziwym narzedziem Vercela (`vercel build`, CLI 62) na
czystej kopii repozytorium:

- instalacja z `package-lock.json`, `npm run build`, kompilacja czterech funkcji,
- `vercel.json` (funkcje, cron) przyjety bez ostrzezen, runtime `nodejs22.x`,
- zbudowane funkcje uruchomione w Node i wywolane jak przez klienta: panel
  (logowanie, sesja, narzedzia), MCP (`initialize`, `tools/list`, `tools/call`),
  `/api/health`, cron z sekretem i bez.

Tym sposobem wykryto i naprawiono jeden blad: Vercel zamienia plik
`api/app/[...path].ts` w trase pasujaca do **jednego** segmentu sciezki, wiec
trasy panelu sa jednosegmentowe (`/api/app/account-login`, nie
`/api/app/accounts/login`). Test w `test/routes.test.ts` pilnuje tej zasady.

Nie da sie sprawdzic bez prawdziwego Vercela: wyglad ekranow Marketplace
(Upstash), Deployment Protection, faktyczne odpalenie crona. Nie da sie tez
sprawdzic Vinted - patrz krok 9. Jesli build zglosi blad, wklej jego log.

## Zanim zaczniesz

1. **Cron.** Domyslny harmonogram w `vercel.json` to `0 7 * * *` (raz dziennie),
   bo plan Hobby (darmowy) nie przyjmuje czestszych. Na planie **Pro** zmien go na
   `*/10 * * * *`. Czestszy cron na Hobby konczy sie odrzuceniem wdrozenia.
2. **Nazwy zmiennych Upstash.** Kod czyta `UPSTASH_REDIS_REST_URL` i
   `UPSTASH_REDIS_REST_TOKEN`, a jako zapas `KV_REST_API_URL` i
   `KV_REST_API_TOKEN`, ktore czesto wstawia integracja z Vercela.
3. **Galaz produkcyjna.** Domyslna galezia repozytorium na GitHubie to
   `claude/sharp-volta-8erp64` (jedyna), wiec Vercel uzyje jej jako produkcyjnej -
   nic nie musisz scalac do `main`. Sprawdz w **Settings → Git → Production
   Branch**. Kazdy push na te galaz uruchamia nowe wdrozenie produkcyjne.

## 1. Przygotuj sekrety

Zapisz je w menedzerze hasel.

| Zmienna | Co wpisac |
| --- | --- |
| `ADMIN_PASSWORD` | Dlugie haslo do panelu, wymyslone przez Ciebie |
| `ENCRYPTION_KEY` | Dokladnie 64 znaki szesnastkowe (0-9, a-f) |
| `MCP_AUTH_TOKEN` | 64 znaki szesnastkowe |
| `CRON_SECRET` | 64 znaki szesnastkowe |

Generowanie (trzy razy, po jednej wartosci dla kazdej z trzech pozycji):

- Mac/Linux: `openssl rand -hex 32`
- Windows (PowerShell):
  ```
  $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ($b | ForEach-Object { $_.ToString("x2") }) -join ""
  ```

**Skopiuj `ENCRYPTION_KEY` poza Vercel.** Zgubiony lub zmieniony klucz oznacza
ponowne podlaczenie wszystkich kont Vinted.

## 2. Zaimportuj repozytorium

1. vercel.com/signup → zaloguj sie przez GitHub (plan Hobby jest darmowy).
2. **Add New… → Project**.
3. Znajdz `andrzej304074-max/12` → **Import**. Jesli go nie ma na liscie:
   **Adjust GitHub App Permissions** i daj Vercelowi dostep do repozytorium.

## 3. Ustawienia projektu (ekran importu)

- **Framework Preset:** Other.
- **Root Directory:** bez zmian.
- **Output Directory:** wlacz **Override** i wpisz `public` (tam lezy panel).
- **Build Command** i **Install Command:** bez zmian. Build to samo sprawdzenie
  typow (kilka sekund). Wersja Node (22.x) jest przypieta w `package.json`.

## 4. Zmienne srodowiskowe (ten sam ekran)

Dodaj `ADMIN_PASSWORD`, `ENCRYPTION_KEY`, `MCP_AUTH_TOKEN` i `CRON_SECRET`.
Zostaw domyslnie zaznaczone srodowiska; jesli jest przelacznik **Sensitive**,
wlacz go dla sekretow. Opcjonalnie `NOTIFY_WEBHOOK_URL` (Discord/Slack) -
powiadomienia o znaleziskach i nowych wiadomosciach.

Pelna lista zmiennych z opisami: [`.env.example`](../.env.example).

## 5. Pierwszy deploy

**Deploy** (1-2 minuty). Przy bledzie: nieudane wdrozenie → **Build Logs** →
skopiuj log i wklej.

## 6. Baza Upstash (przed podlaczaniem kont)

Bez niej konta, obserwowani i limity gina po kazdym wywolaniu funkcji, a blokada
po blednych haslach do panelu nie dziala miedzy wywolaniami.

**Wariant A, z Vercela:**

1. W projekcie: **Storage → Create Database → Upstash → Redis**, plan Free,
   region np. Frankfurt.
2. **Connect Project** → wybierz ten projekt (nazwy przyciskow moga sie roznic).
3. Vercel dodaje zmienne, zwykle `KV_REST_API_URL` i `KV_REST_API_TOKEN` - kod
   rozpoznaje je tak samo jak `UPSTASH_REDIS_REST_*`. Uzywany jest token
   odczyt+zapis, nie `..._READ_ONLY_TOKEN`.

**Wariant B, bezposrednio w Upstash:**

1. console.upstash.com → utworz baze Redis (region EU, plan Free).
2. W sekcji REST API skopiuj URL i token.
3. W Vercelu: **Settings → Environment Variables** → `UPSTASH_REDIS_REST_URL` i
   `UPSTASH_REDIS_REST_TOKEN`.

## 7. Redeploy

Zmienne dzialaja dopiero po nowym wdrozeniu: **Deployments → najnowsze → ⋯ →
Redeploy**.

## 8. Sprawdz, czy dziala

1. Adres projektu: **Overview → Domains** (np. `https://twoj-projekt.vercel.app`).
2. `https://twoj-projekt.vercel.app/api/health` → `"status":"ok"`,
   `"authConfigured":true`, `"durableStorage":true`.
3. `https://twoj-projekt.vercel.app/` → zaloguj sie haslem z `ADMIN_PASSWORD`.
4. **Pulpit → Konfiguracja serwera:** Upstash, klucz szyfrowania, token MCP i
   sekret crona maja miec „ok". Czego brakuje, dodaj i zrob Redeploy.

## 9. Podlacz konto Vinted

1. **Konta → Dodaj konto**.
2. Rynek (np. `www.vinted.pl`), login (e-mail), haslo, nazwa → **Zaloguj**. Jesli
   Vinted zada kodu, wpisz kod z SMS. Po sukcesie: „Polaczono jako @login".
3. **Testuj**.

Mozliwe problemy:

- **„Vinted zazadal weryfikacji antybotowej":** Vinted zablokowal logowanie z
  serwera. Panel niczego nie omija i zatrzymuje sie po jednej probie. Sprobuj
  pozniej.
- **„Unexpected response":** logowanie Vinted nie jest udokumentowanym API i nie
  dalo sie go sprawdzic na zywo. Poprawka: [ACCOUNTS.md](ACCOUNTS.md).

## 10. Podlacz klienta MCP

Zakladka **MCP** w panelu → **Pokaz token w poleceniu**, potem w terminalu:

```bash
claude mcp add --transport http vinted \
  https://twoj-projekt.vercel.app/api/mcp \
  --header "Authorization: Bearer TWOJ_MCP_AUTH_TOKEN"
```

## 11. Monitoring

1. **Obserwowani** → dodaj sprzedawce (ID albo link do profilu).
2. Cron dziala raz dziennie o 7:00 UTC (plan Hobby). Na planie Pro zmien
   `schedule` w `vercel.json` na `*/10 * * * *`.
3. Reczny przebieg: przycisk **Uruchom przebieg teraz** na Pulpicie.

## 12. Automat wlaczaj na samym koncu

Najpierw jedna reczna oferta (`make_offer` z `confirm: true`) na testowym
przedmiocie, zeby sprawdzic sciezki zapisu - procedura w
[ACTIONS.md](ACTIONS.md). Dopiero potem przelacznik na Pulpicie.

## Gdy cos nie dziala

| Objaw | Co zrobic |
| --- | --- |
| Deploy odrzucony z powodu crona | Plan Hobby: zostaw `0 7 * * *` w `vercel.json` |
| Strona prosi o logowanie do Vercela | **Settings → Deployment Protection** → wylacz Vercel Authentication dla produkcji albo uzyj adresu z Overview → Domains, nie adresu konkretnego wdrozenia |
| Logowanie: „Panel jest wylaczony" | Brak `ADMIN_PASSWORD` - dodaj, Redeploy |
| Konta: nie mozna dodac konta | Brak `ENCRYPTION_KEY` - dodaj, Redeploy |
| Pulpit: Upstash „brak" | Dodaj zmienne Upstash (krok 6), Redeploy |
| Klient MCP dostaje blad 500 / „no shared secret" | Brak `MCP_AUTH_TOKEN` - dodaj, Redeploy |
| Cron zwraca 401 | Brak `CRON_SECRET` (Vercel wysyla go sam) - dodaj, Redeploy |
| Cron zwraca „skipped" | Brak Upstash - dodaj baze |
| Po wygasnieciu funkcji znikaja konta | Brak Upstash |
| Konta maja status „wymaga logowania" po zmianie klucza | Zmieniony `ENCRYPTION_KEY` nie odczyta starych danych - podlacz konta ponownie |
| Panel laduje sie, ale przyciski nic nie robia, w konsoli bledy 404 na `/api/app/...` | Trasa panelu z wiecej niz jednym segmentem - zob. `test/routes.test.ts` |

## Jak powtorzyc lokalna weryfikacje builda

W czystym katalogu (kopia repozytorium bez `node_modules`):

```bash
npm ci
mkdir -p .vercel
cat > .vercel/project.json <<'EOF'
{"projectId":"prj_localcheck000000000000000000","orgId":"team_localcheck00000000000000","settings":{"framework":null,"devCommand":null,"installCommand":null,"buildCommand":null,"outputDirectory":"public","rootDirectory":null,"nodeVersion":"22.x","directoryListing":false}}
EOF
VERCEL_TELEMETRY_DISABLED=1 CI=1 npx vercel build --prod --yes   # wynik w .vercel/output
```

Katalog `.vercel/` jest w `.gitignore`. Build nie loguje sie do Vercela i niczego
nie wdraza.
