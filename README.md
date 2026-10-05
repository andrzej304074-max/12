# vinted-seller-mcp

Panel www i zdalny serwer MCP do zarzadzania ofertami i zamowieniami na Vinted
przez **oficjalne API Vinted Pro Integrations**. Jedno wdrozenie na Vercel,
dziala serwerowo 24/7.

- **Panel** (`/`) - minimalistyczna strona: konta Pro, oferty, wystawianie,
  zamowienia z etykietami PDF, zdarzenia z webhookow.
- **MCP** (`/api/mcp`) - te same funkcje jako narzedzia dla Claude Code i innych
  klientow MCP.

Panel nie dubluje logiki: kazde jego dzialanie wywoluje to samo narzedzie MCP.

## Co to jest, a czego nie

Vinted nie ma publicznego API. Jedyne oficjalne API sprzedazowe to **Vinted Pro
Integrations**, dostepne tylko dla firm z kontem Vinted Pro, ktore Vinted wpisal
na liste dozwolonych (allowlist). Nie ma samodzielnej rejestracji ani
publicznych kluczy. Szczegoly, wymagania i ograniczenia:
**[docs/PRO.md](docs/PRO.md)**.

Robi: walidacje i tworzenie ofert (domyslnie jako szkice), edycje, usuwanie,
statusy, import ofert dodanych poza API, zamowienia, przesylki, **etykiete PDF**,
anulowanie i ponowne wystawienie, slowniki Vinted (kategorie, kolory, rozmiary
paczek, stany), sugestie cen, webhooki ze sprzedaza i wynikiem operacji.

Nie robi (API Pro tego nie obejmuje): szukania cudzych ofert, obserwowania
sprzedawcow, polubien, ofert cenowych ani skrzynki z kupujacymi. Te funkcje,
zbudowane na nieoficjalnym API konsumenckim, sa **domyslnie ukryte** - Vinted
blokuje z serwerow ruch do tego API, a dokumentacja Vinted Pro uznaje takie
automatyzowanie konta za naruszenie regulaminu. Zob. nizej.

## Wymagania

- Konto Vercel
- Upstash Redis (darmowy tier wystarcza) - bez niego konta, zdarzenia i pamiec
  podreczna nie przetrwaja miedzy wywolaniami funkcji
- **Konto Vinted Pro na allowliscie Vinted** i token z portalu Pro (osobny dla
  sandboxu i produkcji). **Polski i PLN nie ma na liscie rynkow w dokumentacji**
  (AT, BE, DE, ES, FR, IT, LU, NL, PT, UK) - zapytaj Vinted, czy Twoje konto jest
  obslugiwane.
- Opcjonalnie sklep Vercel Blob - zeby wgrywac zdjecia z panelu (API przyjmuje
  tylko publiczne adresy URL zdjec)

## Deploy na Vercel

Pelna instrukcja krok po kroku (import z GitHuba, zmienne, Upstash, sprawdzenie,
typowe problemy): **[docs/DEPLOY.md](docs/DEPLOY.md)**. Skrot dla CLI:

```bash
npm i -g vercel
vercel link          # podepnij katalog do projektu na Vercel
vercel env add ADMIN_PASSWORD production      # haslo do panelu
vercel env add ENCRYPTION_KEY production      # openssl rand -hex 32
vercel env add MCP_AUTH_TOKEN production      # openssl rand -hex 32
vercel env add CRON_SECRET production         # dowolny dlugi sekret
vercel env add NODEJS_HELPERS production      # wpisz 0 (patrz nizej)
vercel --prod
```

Upstash dodaj przez **Vercel -> Storage -> Upstash Redis**. Kod rozpoznaje
zmienne `UPSTASH_REDIS_REST_URL` / `_TOKEN` oraz `KV_REST_API_URL` / `_TOKEN`
(te drugie czesto wstawia integracja). Pelna lista zmiennych z opisami:
[`.env.example`](.env.example).

> **`NODEJS_HELPERS=0`:** webhooki Vinted sa podpisane po dokladnych bajtach
> ciala, a Vercel domyslnie parsuje JSON przed funkcja. Ta zmienna to wylacza
> (kod nie uzywa pomocnikow Vercela). Musi byc ustawiona przed budowaniem, wiec
> po jej dodaniu zrob Redeploy. Szczegoly: [docs/PRO.md](docs/PRO.md).

> **Cron:** raz dziennie (`0 7 * * *`, plan Hobby nie przyjmuje czestszych):
> uzgadnia oferty, ktorych wynik nie dotarl webhookiem, i odswieza slowniki.

> `ENCRYPTION_KEY` szyfruje zapisane tokeny. Zmiana klucza oznacza ponowne
> wpisanie tokenow, wiec zachowaj jego kopie poza repozytorium.

## Pierwsze uruchomienie

1. Otworz adres projektu i zaloguj sie haslem z `ADMIN_PASSWORD`.
2. **Pulpit** pokazuje, czego brakuje w konfiguracji. Uzupelnij, zrob Redeploy.
3. **Konta -> Dodaj konto Vinted Pro**: nazwa, srodowisko (zacznij od
   **sandboxu**), token z portalu. Panel od razu sprawdza polaczenie.
4. **Zdarzenia -> Zarejestruj webhook.**
5. **Wystaw**: szkic oferty, potem **Zdarzenia -> Symuluj sprzedaz** (sandbox)
   i **Zamowienia** z etykieta PDF.
6. Dopiero potem token produkcyjny.

## Panel

| Zakladka | Co robisz |
| --- | --- |
| **Pulpit** | Stan polaczenia, ostatnie zdarzenia i wysylki, konfiguracja serwera |
| **Oferty** | Lista z cursorem, status, zmiana ceny, szkic/publikacja, usuwanie, import i referencje (SKU) |
| **Wystaw** | Formularz ze slownikow Vinted (kategorie tylko koncowe, stan, paczka, kolory, rozmiar), zdjecia, walidacja z bledami przy polach, szkic |
| **Zamowienia** | Lista, szczegoly, przesylka, etykieta PDF, anulowanie z powodem, ponowne wystawienie |
| **Zdarzenia** | Webhook (rejestracja), symulacja sprzedazy w sandboxie, otrzymane i odrzucone dostawy |
| **Konta** | Tokeny Vinted Pro, sprawdzenie polaczenia |
| **MCP** | Adres, polecenie podlaczenia klienta, lista narzedzi, reczne wywolanie |

Dzialania zmieniajace cos u Vinted pokazuja najpierw dokladnie, co pojdzie
(tworzenie, edycja, usuwanie, anulowanie, ponowne wystawienie), i wymagaja
potwierdzenia.

Wersja demo bez konta Vinted (atrapa API Pro w pamieci, ktora sama weryfikuje
podpisy i wysyla podpisane webhooki):

```bash
npm install
npm run demo        # http://localhost:3000, haslo do panelu: demo
                    # token Pro: DEMO_ACCESS,demo-signing-secret
```

## Podlaczenie klienta MCP

Zakladka **MCP** w panelu podaje gotowe polecenie. Recznie:

```bash
claude mcp add --transport http vinted \
  https://TWOJ-PROJEKT.vercel.app/api/mcp \
  --header "Authorization: Bearer TWOJ_MCP_AUTH_TOKEN"
```

Sprawdzenie, czy serwer zyje (nie wymaga tokenu i nie zwraca sekretow):

```bash
curl https://TWOJ-PROJEKT.vercel.app/api/health
```

Token Vinted Pro wpisujesz wylacznie w panelu - nigdy w narzedziu MCP ani w
rozmowie z modelem.

## Narzedzia MCP

Wszystkie zapisy wymagaja `confirm: true`; bez niego narzedzie pokazuje podglad.

| Obszar | Narzedzia |
| --- | --- |
| Polaczenie | `diagnose_pro`, `pro_list_accounts`, `pro_remove_account` |
| Slowniki | `pro_get_ontology`, `pro_find_category`, `pro_price_suggestion` |
| Oferty | `pro_list_items`, `pro_get_item_status`, `pro_validate_items`, `pro_create_items`, `pro_update_items`, `pro_delete_items`, `pro_list_imported_items`, `pro_set_item_references` |
| Zamowienia | `pro_list_orders`, `pro_get_order`, `pro_get_shipment`, `pro_get_label`, `pro_cancel_order`, `pro_relist_orders` |
| Webhooki | `pro_list_webhooks`, `pro_register_webhook`, `pro_delete_webhook`, `pro_list_events`, `pro_simulate_sale` (sandbox) |
| Diagnostyka | `pro_raw_get` (surowy podpisany GET), `pro_list_actions` |

## Bezpieczenstwo

- Panel: jedno haslo, podpisane ciasteczko sesji (HttpOnly, SameSite=Strict,
  Secure na produkcji, 7 dni), sprawdzanie `Origin` przy kazdej zmianie, blokada
  po 5 blednych hasel / 15 min (miedzy wywolaniami tylko z Upstash).
- Token Vinted Pro (klucz dostepu i **klucz podpisu**) jest szyfrowany
  (AES-256-GCM), nigdy nie wraca z serwera, nie trafia do logow ani do bledow, a
  blad w tresci zadania nie cytuje jego fragmentow. Klucz podpisu nie jest
  wysylany nigdzie - sluzy tylko do liczenia podpisu kazdego zadania.
- Podpisane zadania ida **wylacznie** do dwoch hostow Vinted Pro; przekierowania
  nie sa sledzone, a sciezki i identyfikatory sa sprawdzane przed podpisaniem.
- Webhooki: dostawa jest przyjmowana tylko po zgodnym podpisie HMAC (porownanie
  w stalym czasie, okno 5 minut, jednokrotna obsluga powtorzen); z ciala ani z
  podpisu nic nie trafia do logow.
- Instrukcje MCP mowia modelowi, ze tresc zwracana przez Vinted (tytuly, opisy,
  dane zamowien) to dane, a nie polecenia.

## Ograniczenia, o ktorych warto wiedziec

- **Dostep nie jest samoobslugowy.** Bez wpisu na allowliste Vinted API odpowiada
  403, a portal z tokenami nie dziala. **Rynek PL/PLN nie jest wymieniony w
  dokumentacji** - jesli Twoje konto nie jest obslugiwane, nic tu nie zadziala,
  dopoki Vinted tego nie potwierdzi.
- **Dokumentacja integratora zostala zlozona z fragmentow**, a nie z samej
  specyfikacji OpenAPI, i wiele punktow ma w niej oznaczenie „prawdopodobne" albo
  „niepotwierdzone". Zaden nie dal sie sprawdzic na zywo przy pisaniu (hosty Vinted
  byly zablokowane w srodowisku budujacym). Wszystkie takie punkty sa w
  `src/pro/endpoints.ts` i `src/pro/schema.ts`; `pro_raw_get` pokazuje prawdziwa
  odpowiedz bez zmiany kodu. Dodaj `docs/vinted-pro/api.yml`, a test kontraktowy
  porowna z nia kod. Pierwszy test na prawdziwym sandboxie moze wymagac drobnych
  poprawek.
- **Tworzenie, edycja i usuwanie sa asynchroniczne** - odpowiedz oznacza tylko
  przyjecie, wynik przychodzi webhookiem (albo przy codziennym uzgodnieniu).
- **Zdjecia tylko jako publiczne, trwale adresy URL.**
- **Brak opublikowanego limitu zapytan** - klient trzyma odstepy, ponawia tylko
  to, co bezpiecznie powtorzyc, i szanuje `Retry-After`.
- **Bez Upstash nic nie jest trwale** - Pulpit i widok Kont ostrzegaja.

## Funkcje nieoficjalne (domyslnie ukryte)

W repozytorium zostaly narzedzia i widoki zbudowane na nieoficjalnym API
konsumenckim Vinted: research cen, obserwowani sprzedawcy i znaleziska,
polubienia i oferty cenowe (takze automatyczne), skrzynka wiadomosci, logowanie
haslem. **Sa ukryte, dopoki nie ustawisz `ENABLE_UNOFFICIAL=true`.** Powody:

- Vinted blokuje z serwerow ruch do tego API (potwierdzone: HTTP 403 z ochrona
  antybotowa przed sprawdzeniem hasla),
- oficjalne API ich nie obejmuje,
- dokumentacja Vinted Pro uznaje automatyzowanie konta konsumenckiego za
  naruszenie regulaminu.

Panel niczego tu nie omija. Opis, diagnostyka blokady i dawne instrukcje:
[docs/ACCOUNTS.md](docs/ACCOUNTS.md), [docs/ACTIONS.md](docs/ACTIONS.md).

## Rozwoj lokalny

```bash
npm install
npm run typecheck
npm test            # testy nie dotykaja sieci
npm run demo        # panel z atrapa Vinted Pro
```

Testy pokrywaja m.in. podpisywanie (znane odpowiedzi policzone poza kodem),
klienta Pro (ponowienia, bledy, brak wyciekow), konta i szyfrowanie, narzedzia z
atrapa API, ktora sama weryfikuje kazdy podpis, odbiornik webhookow (podpis,
powtorzenia, surowe ciala), trasy panelu, bramke funkcji nieoficjalnych oraz -
gdy dodasz `api.yml` - zgodnosc sciezek ze specyfikacja Vinted.

## Struktura

```
public/               # panel (HTML + vanilla JS, bez frameworka i bez builda)
  views/              # jeden plik na zakladke (pro-*.js: Vinted Pro)
api/
  mcp.ts              # endpoint MCP (Streamable HTTP, bezstanowy)
  app/[...path].ts    # backend panelu (jedna funkcja; trasy jednosegmentowe, zob. docs/DEPLOY.md)
  pro/webhook.ts      # odbiornik webhookow Vinted Pro
  cron/monitor.ts     # codzienne uzgodnienie (i monitoring, gdy wlaczono funkcje nieoficjalne)
  health.ts           # liveness
src/
  pro/                # Vinted Pro: podpis, klient, konta, ontologie, oferty, zamowienia, webhooki
  app/router.ts       # trasy panelu: logowanie, sesja, /tool, tokeny, ontologia, etykieta, zdjecia
  mcp/                # protokol JSON-RPC, dyspozytor, definicje narzedzi
  vinted/ monitor/    # nieoficjalne API konsumenckie (domyslnie ukryte)
  store/              # Upstash Redis albo pamiec procesu
  crypto.ts session.ts settings.ts features.ts
scripts/              # dev-server.ts (demo) i fake-pro.ts (atrapa API Pro; nie wdrazane)
docs/                 # PRO.md, DEPLOY.md, ACCOUNTS.md, ACTIONS.md
```
