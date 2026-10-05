# Wdrozenie na Vercel - krok po kroku

Wdrazasz jeden projekt: panel www (`/`), endpoint MCP (`/api/mcp`), backend
panelu (`/api/app/*`), odbiornik webhookow Vinted Pro (`/api/pro/webhook`) i
codzienny cron (`/api/cron/monitor`). Calosc to okolo 20-30 minut.

**Zanim zaczniesz** potrzebujesz konta Vinted Pro wpisanego przez Vinted na liste
dozwolonych (allowlist) i tokenu **sandbox** z portalu Pro. Bez tego wdrozenie
sie uda, ale nic nie polaczy sie z Vinted. Dokumentacja wymienia rynki AT, BE,
DE, ES, FR, IT, LU, NL, PT i UK; **Polski i PLN nie ma na tej liscie** - zapytaj
Vinted, czy Twoje konto jest obslugiwane. Szczegoly: [PRO.md](PRO.md).

## Co zostalo sprawdzone przed wdrozeniem, a czego nie

Sprawdzone lokalnie prawdziwym narzedziem Vercela (`vercel build`, CLI 62) na
czystej kopii repozytorium, w dwoch wariantach (ze zmienna `NODEJS_HELPERS=0` i
bez niej):

- instalacja z `package-lock.json`, `npm run build`, kompilacja piciu funkcji,
- `vercel.json` (funkcje, cron) przyjety bez ostrzezen, runtime `nodejs22.x`,
- zbudowane funkcje uruchomione w Node ze **wspolnym trwalym magazynem** (atrapa
  protokolu REST Upstasha, tak jak na Vercelu, gdzie kazda funkcja ma wlasna
  kopie kodu) i atrapa API Vinted Pro: panel (logowanie, token, narzedzia), MCP,
  `/api/health`, cron, oraz odbiornik webhookow z podpisanymi dostawami,
- obie postacie ciala zadania: sparsowane przez Vercela i surowe.

Tym sposobem wykryto i naprawiono dwie rzeczy: Vercel zamienia plik
`api/app/[...path].ts` w trase pasujaca do **jednego** segmentu sciezki (trasy
panelu sa jednosegmentowe, pilnuje tego `test/routes.test.ts`), a bez
`NODEJS_HELPERS=0` funkcja nie dostaje surowych bajtow ciala, ktore obejmuje
podpis webhooka (zob. krok 4).

Nie da sie sprawdzic bez prawdziwego Vercela i Vinted: wyglad ekranow Marketplace
(Upstash, Blob), Deployment Protection, faktyczne odpalenie crona, a przede
wszystkim **prawdziwe odpowiedzi Vinted Pro** (hosty `*.svc.vinted.com` byly
zablokowane w srodowisku budujacym). Jesli build zglosi blad, wklej jego log.

## Zanim zaczniesz

1. **Cron.** Harmonogram w `vercel.json` to `0 7 * * *` (raz dziennie); plan
   Hobby nie przyjmuje czestszych. To tylko uzgodnienie - wynik operacji
   przychodzi webhookiem na biezaco.
2. **Nazwy zmiennych Upstash.** Kod czyta `UPSTASH_REDIS_REST_URL` i
   `UPSTASH_REDIS_REST_TOKEN`, a jako zapas `KV_REST_API_URL` i
   `KV_REST_API_TOKEN`, ktore czesto wstawia integracja z Vercela.
3. **Galaz produkcyjna.** Domyslna galezia repozytorium na GitHubie to
   `claude/sharp-volta-8erp64` (jedyna), wiec Vercel uzyje jej jako produkcyjnej -
   nic nie musisz scalac do `main`. Sprawdz w **Settings -> Git -> Production
   Branch**. Kazdy push na te galaz uruchamia nowe wdrozenie produkcyjne.

## 1. Przygotuj sekrety

Zapisz je w menedzerze hasel.

| Zmienna | Co wpisac |
| --- | --- |
| `ADMIN_PASSWORD` | Dlugie haslo do panelu, wymyslone przez Ciebie |
| `ENCRYPTION_KEY` | Dokladnie 64 znaki szesnastkowe (0-9, a-f) |
| `MCP_AUTH_TOKEN` | 64 znaki szesnastkowe |
| `CRON_SECRET` | 64 znaki szesnastkowe |
| `NODEJS_HELPERS` | Dokladnie `0` (zob. krok 4) |

Generowanie (trzy razy, po jednej wartosci dla kazdej z trzech pozycji):

- Mac/Linux: `openssl rand -hex 32`
- Windows (PowerShell):
  ```
  $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ($b | ForEach-Object { $_.ToString("x2") }) -join ""
  ```

**Skopiuj `ENCRYPTION_KEY` poza Vercel.** Zgubiony lub zmieniony klucz oznacza
ponowne wpisanie tokenow Vinted Pro.

## 2. Zaimportuj repozytorium

1. vercel.com/signup -> zaloguj sie przez GitHub (plan Hobby jest darmowy).
2. **Add New... -> Project**.
3. Znajdz `andrzej304074-max/12` -> **Import**. Jesli go nie ma na liscie:
   **Adjust GitHub App Permissions** i daj Vercelowi dostep do repozytorium.

## 3. Ustawienia projektu (ekran importu)

- **Framework Preset:** Other.
- **Root Directory:** bez zmian.
- **Output Directory:** wlacz **Override** i wpisz `public` (tam lezy panel).
- **Build Command** i **Install Command:** bez zmian. Build to samo sprawdzenie
  typow (kilka sekund). Wersja Node (22.x) jest przypieta w `package.json`.

## 4. Zmienne srodowiskowe (ten sam ekran)

Dodaj `ADMIN_PASSWORD`, `ENCRYPTION_KEY`, `MCP_AUTH_TOKEN`, `CRON_SECRET` i
`NODEJS_HELPERS=0` (dla wszystkich srodowisk). Jesli jest przelacznik
**Sensitive**, wlacz go dla sekretow. Opcjonalnie `NOTIFY_WEBHOOK_URL`
(Discord/Slack) - powiadomienia o sprzedazy, zamowieniach i bledach.

**Po co `NODEJS_HELPERS=0`:** podpis webhooka Vinted obejmuje dokladne bajty
ciala, a Vercel domyslnie parsuje JSON, zanim funkcja go zobaczy. Ta zmienna to
wylacza. Kod nie uzywa zadnych pomocnikow Vercela, wiec nic innego sie nie
zmienia. Zmienna musi byc obecna **przy budowaniu**, wiec po jej dodaniu zrob
Redeploy. Bez niej dostawy z nietypowo sformatowanym JSON-em sa odrzucane
(bezpiecznie) i widac je w **Zdarzenia -> Odrzucone dostawy**.

Pelna lista zmiennych z opisami: [`.env.example`](../.env.example).

## 5. Pierwszy deploy

**Deploy** (1-2 minuty). Przy bledzie: nieudane wdrozenie -> **Build Logs** ->
skopiuj log i wklej.

## 6. Baza Upstash (przed wpisywaniem tokenow)

Bez niej konta, zdarzenia i pamiec podreczna gina po kazdym wywolaniu funkcji, a
blokada po blednych haslach do panelu nie dziala miedzy wywolaniami.

**Wariant A, z Vercela:**

1. W projekcie: **Storage -> Create Database -> Upstash -> Redis**, plan Free,
   region np. Frankfurt.
2. **Connect Project** -> wybierz ten projekt (nazwy przyciskow moga sie roznic).
3. Vercel dodaje zmienne, zwykle `KV_REST_API_URL` i `KV_REST_API_TOKEN` - kod
   rozpoznaje je tak samo jak `UPSTASH_REDIS_REST_*`. Uzywany jest token
   odczyt+zapis, nie `..._READ_ONLY_TOKEN`.

**Wariant B, bezposrednio w Upstash:**

1. console.upstash.com -> utworz baze Redis (region EU, plan Free).
2. W sekcji REST API skopiuj URL i token.
3. W Vercelu: **Settings -> Environment Variables** -> `UPSTASH_REDIS_REST_URL` i
   `UPSTASH_REDIS_REST_TOKEN`.

Zuzycie: ontologia Vinted jest zapisywana skompresowana, a zdarzenia i dziennik
operacji maja po 100 pozycji na konto. Sprawdz aktualne limity swojego planu
Upstash (rozmiar pojedynczego zadania i liczbe polecen).

## 7. (Opcjonalnie) Wgrywanie zdjec: Vercel Blob

API Vinted Pro przyjmuje tylko **publiczne, trwale adresy URL** zdjec. Bez Bloba
wklejasz adresy zdjec, ktore juz sa w internecie. Zeby wgrywac zdjecia z panelu:

1. W projekcie: **Storage -> Create Database -> Blob**. Wybierz sklep **publiczny**
   (Public) - Vinted musi moc pobrac zdjecie spod jego adresu, a do sklepu
   prywatnego wgranie zdjecia sie nie uda. Potem **Connect Project**.
2. Vercel dodaje `BLOB_READ_WRITE_TOKEN`. Zrob Redeploy.

Pulpit pokazuje „Wgrywanie zdjec: ok". Panel zmniejsza zdjecia w przegladarce, a
serwer sprawdza format po bajtach (JPEG, PNG, WebP), nie po deklaracji.

## 8. Redeploy

Zmienne dzialaja dopiero po nowym wdrozeniu: **Deployments -> najnowsze -> ... ->
Redeploy**.

## 9. Sprawdz, czy dziala

1. Adres projektu: **Overview -> Domains** (np. `https://twoj-projekt.vercel.app`).
2. `https://twoj-projekt.vercel.app/api/health` -> `"status":"ok"`,
   `"authConfigured":true`, `"durableStorage":true`, `"unofficialEnabled":false`.
3. `https://twoj-projekt.vercel.app/` -> zaloguj sie haslem z `ADMIN_PASSWORD`.
4. **Pulpit -> Konfiguracja serwera:** klucz szyfrowania, Upstash, surowe cialo
   webhookow, token MCP i sekret crona maja miec „ok". Czego brakuje, dodaj i
   zrob Redeploy.

## 10. Podlacz konto Vinted Pro (sandbox)

1. **Konta -> Dodaj konto Vinted Pro**.
2. Nazwa, srodowisko **Sandbox**, token z portalu Pro (`klucz_dostepu,klucz_podpisu`).
3. Panel zapisuje token zaszyfrowany i od razu robi sprawdzenie. Wynik:
   - **Polaczenie dziala** - mozna isc dalej,
   - **401** - zly podpis albo token: sprawdz, czy token jest caly, czy jest z
     sandboxu i czy zegar serwera jest poprawny (wynik pokazuje jego czas),
   - **403** - konto poza allowlista albo rynek spoza listy (pamietaj o PL).

## 11. Webhook i test w sandboxie

1. **Zdarzenia -> Zarejestruj webhook** (podglad pokaze adres i zdarzenia).
2. **Wystaw**: wybierz kategorie, wypelnij formularz, **Waliduj**, **Utworz**
   (jako szkic). Wynik pojawi sie w **Oferty** i **Zdarzenia**.
3. **Zdarzenia -> Symuluj sprzedaz** z id oferty: przyjda `ITEM_SOLD`,
   `ORDER_CREATED` i `SHIPMENT_LABEL_CREATED`. W **Zamowienia** pobierz etykiete PDF.
4. Jesli dostawy sa odrzucane (Zdarzenia -> Odrzucone dostawy, `fromParsed`),
   brakuje `NODEJS_HELPERS=0` albo nie bylo Redeployu po jego dodaniu.

## 12. Podlacz klienta MCP

Zakladka **MCP** w panelu -> **Pokaz token w poleceniu**, potem w terminalu:

```bash
claude mcp add --transport http vinted \
  https://twoj-projekt.vercel.app/api/mcp \
  --header "Authorization: Bearer TWOJ_MCP_AUTH_TOKEN"
```

## 13. Produkcja dopiero na koncu

Gdy sandbox dziala: dodaj drugie konto Pro ze srodowiskiem **Produkcja** i tokenem
produkcyjnym (sandbox i produkcja maja osobne tokeny), zarejestruj jego webhook i
zacznij od jednej oferty jako szkicu.

## Gdy cos nie dziala

| Objaw | Co zrobic |
| --- | --- |
| Deploy odrzucony z powodu crona | Plan Hobby: zostaw `0 7 * * *` w `vercel.json` |
| Strona prosi o logowanie do Vercela | **Settings -> Deployment Protection** -> wylacz Vercel Authentication dla produkcji albo uzyj adresu z Overview -> Domains, nie adresu konkretnego wdrozenia. Webhooki Vinted tez nie przejda przez te ochrone |
| Logowanie: „Panel jest wylaczony" | Brak `ADMIN_PASSWORD` - dodaj, Redeploy |
| Konta: nie mozna zapisac tokenu | Brak `ENCRYPTION_KEY` - dodaj, Redeploy |
| Sprawdzenie polaczenia: 401 | Zly/niepelny token, token z innego srodowiska albo zly czas serwera |
| Sprawdzenie polaczenia: 403 | Konto poza allowlista Vinted albo rynek spoza listy (PL!) |
| Pulpit: Upstash „brak" | Dodaj zmienne Upstash (krok 6), Redeploy |
| Zdarzenia: odrzucone dostawy z `fromParsed` | Dodaj `NODEJS_HELPERS=0` i zrob Redeploy |
| Zdarzenia: odrzucone dostawy bez `fromParsed` | Zly klucz podpisu (zarejestruj webhook ponownie), stary znacznik czasu (zegar) albo inny adres niz zarejestrowany |
| Wystaw: „Photo upload is not set up" | Dodaj sklep Blob (krok 7) albo wklej adresy zdjec |
| Wystaw: „The photo store refused the upload" | Sklep Blob jest prywatny, wylaczony albo nalezy do innego projektu - utworz publiczny, polacz z tym projektem, Redeploy |
| Klient MCP dostaje blad 500 / „no shared secret" | Brak `MCP_AUTH_TOKEN` - dodaj, Redeploy |
| Cron zwraca 401 | Brak `CRON_SECRET` (Vercel wysyla go sam) - dodaj, Redeploy |
| Cron zwraca „skipped" | Brak Upstash - dodaj baze |
| Konta ze statusem „token odrzucony" po zmianie klucza | Zmieniony `ENCRYPTION_KEY` nie odczyta starych tokenow - wpisz je ponownie |
| Panel laduje sie, ale przyciski nic nie robia, w konsoli bledy 404 na `/api/app/...` | Trasa panelu z wiecej niz jednym segmentem - zob. `test/routes.test.ts` |

## Funkcje nieoficjalne (domyslnie ukryte)

Widoki i narzedzia zbudowane na nieoficjalnym API konsumenckim wlaczysz
zmienna `ENABLE_UNOFFICIAL=true`. Pamietaj: Vinted blokuje z serwerow ruch do
tego API (HTTP 403 z ochrona antybotowa, jeszcze przed sprawdzeniem hasla), a
dokumentacja Vinted Pro uznaje takie automatyzowanie konta za naruszenie
regulaminu. Opis i diagnostyka: [ACCOUNTS.md](ACCOUNTS.md).

## Jak powtorzyc lokalna weryfikacje builda

W czystym katalogu (kopia repozytorium bez `node_modules`):

```bash
npm ci
mkdir -p .vercel
cat > .vercel/project.json <<'EOF'
{"projectId":"prj_localcheck000000000000000000","orgId":"team_localcheck00000000000000","settings":{"framework":null,"devCommand":null,"installCommand":null,"buildCommand":null,"outputDirectory":"public","rootDirectory":null,"nodeVersion":"22.x","directoryListing":false}}
EOF
VERCEL_TELEMETRY_DISABLED=1 CI=1 npx vercel build --prod --yes   # wynik w .vercel/output
# z wylaczonymi pomocnikami (tak buduje Vercel ze zmienna NODEJS_HELPERS=0):
NODEJS_HELPERS=0 VERCEL_TELEMETRY_DISABLED=1 CI=1 npx vercel build --prod --yes
```

W `.vercel/output/functions/**/.vc-config.json` pole `shouldAddHelpers` powinno
byc `false` w drugim wariancie. Katalog `.vercel/` jest w `.gitignore`. Build nie
loguje sie do Vercela i niczego nie wdraza.
