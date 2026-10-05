# vinted-seller-mcp

Zdalny serwer MCP dla sprzedazy na Vinted, uruchamiany na Vercel.

Szuka porownywalnych ofert, wylicza sensowna cene, rozwiazuje kategorie i marki,
przygotowuje i sprawdza tresc oferty, a takze obserwuje wybranych sprzedawcow i
zglasza ich nowe przedmioty wraz z cena negocjacyjna.

Umie tez dzialac na koncie: publikowac i usuwac oferty, polubiac, wysylac
oferty cenowe i wiadomosci - zawsze po `confirm: true`. Opcjonalnie sam polubia
i sklada oferte -20% na nowych przedmiotach wybranych sprzedawcow, w ramach
limitow ustawianych w locie. Szczegoly: [docs/ACTIONS.md](docs/ACTIONS.md).

## Wymagania

- Konto Vercel
- Upstash Redis (darmowy tier wystarcza) - bez niego monitoring nie przetrwa
  miedzy wywolaniami funkcji
- Konto Vinted, na ktore logujesz sie **recznie** w przegladarce

## Deploy na Vercel

```bash
npm i -g vercel
vercel link          # podepnij katalog do projektu na Vercel
vercel env add MCP_AUTH_TOKEN production
vercel env add VINTED_ACCOUNTS production
vercel env add CRON_SECRET production
vercel --prod
```

Upstash dodaj przez **Vercel → Storage → Upstash Redis**; zmienne
`UPSTASH_REDIS_REST_URL` i `UPSTASH_REDIS_REST_TOKEN` wstawia sam.

Pelna lista zmiennych z opisami: [`.env.example`](.env.example).

### Skad wziac `accessToken`

1. Zaloguj sie na Vinted w przegladarce (recznie - serwer nigdy nie prosi o haslo).
2. DevTools → Application → Cookies → wartosc ciasteczka `access_token_web`.
3. Wklej do `VINTED_ACCOUNTS`:

```json
[{ "id": "main", "label": "Moj sklep", "accessToken": "eyJ...", "userId": 12345678 }]
```

Token wygasa co jakis czas. Gdy narzedzia zaczna zwracac blad 401,
`diagnose_connection` powie to wprost - wtedy podmien wartosc i zrob redeploy.

Mozesz podpiac kilka kont naraz; narzedzia przyjmuja `account_id`.

## Podlaczenie klienta MCP

Claude Code:

```bash
claude mcp add --transport http vinted \
  https://TWOJ-PROJEKT.vercel.app/api/mcp \
  --header "Authorization: Bearer TWOJ_MCP_AUTH_TOKEN"
```

Sprawdzenie, czy serwer zyje (endpoint nie wymaga tokenu i nie zwraca sekretow):

```bash
curl https://TWOJ-PROJEKT.vercel.app/api/health
```

## Narzedzia

### Research

| Narzedzie | Do czego |
| --- | --- |
| `search_similar_items` | Porownywalne oferty z katalogu |
| `estimate_price` | Rozklad cen, trzy punkty cenowe, poziom pewnosci |
| `find_category` | Nazwa kategorii → `catalog_id` wraz z pelna sciezka |
| `find_brand` | Nazwa marki → `brand_id` |
| `get_item` | Pojedyncza oferta |
| `get_seller` | Profil sprzedawcy: liczba ofert, obserwujacy, reputacja |

### Przygotowanie oferty

| Narzedzie | Do czego |
| --- | --- |
| `draft_listing` | Sklada wersje robocza i raportuje braki |
| `validate_listing` | Sprawdza limity pol i wymagane dane - **nigdy nie publikuje** |

Obie dzialaja lokalnie i nie wysylaja niczego do Vinted.

### Monitoring sprzedawcow

| Narzedzie | Do czego |
| --- | --- |
| `watch_seller` | Dodaje sprzedawce do obserwowanych |
| `unwatch_seller` | Usuwa z obserwowanych |
| `list_watches` | Kogo obserwujesz i z jakim rabatem |
| `list_new_finds` | Nowe przedmioty + policzona cena negocjacyjna |
| `mark_find_handled` | Oznacza znalezisko jako zalatwione |
| `run_monitor_pass` | Odpala przebieg od razu, bez czekania na crona |
| `preview_offer_price` | Sama arytmetyka rabatu |

### Akcje na koncie (wymagaja `confirm: true`)

| Narzedzie | Do czego |
| --- | --- |
| `like_item` | Polubienie przedmiotu |
| `make_offer` | Oferta cenowa (domyslnie cena wywolawcza -20%) |
| `process_find` | Polubienie + oferta dla znaleziska, potem oznacza je jako zalatwione |
| `send_message` | Wiadomosc do sprzedawcy |
| `publish_listing` | Publikacja oferty (zdjecia wgrane wczesniej, podajesz `photo_ids`) |
| `delete_listing` | Usuniecie wlasnej oferty |

Bez `confirm: true` kazde z nich zwraca tylko podglad i niczego nie wysyla.

### Automatyka i limity

| Narzedzie | Do czego |
| --- | --- |
| `set_automation_limits` | Limity na dobe/godzine, okno godzin, pauza, rabat - w locie, per konto |
| `get_automation_status` | Limity i ich zrodlo, zuzycie, kolejka, pauza, ostatnie akcje |
| `resume_automation` | Zdejmuje pauze bezpiecznika |

### Diagnostyka

| Narzedzie | Do czego |
| --- | --- |
| `list_accounts` | Podpiete konta (bez tokenow) |
| `diagnose_connection` | Sprawdza kazdy endpoint po kolei i mowi, ktory padl |

## Jak dziala monitoring

1. `watch_seller` zapisuje sprzedawce i **zaznacza jego obecne oferty jako juz
   widziane** - dzieki temu nie dostajesz na start calego archiwum.
2. Cron (`vercel.json`, domyslnie co 10 minut) odpytuje kazdego obserwowanego
   sprzedawce o najnowsze oferty.
3. Nowe pozycje trafiaja do kolejki znalezisk razem z `suggestedOfferPrice`
   (domyslnie -20%, zmienisz przez `OFFER_DISCOUNT_PCT` globalnie albo
   `discount_pct` przy pojedynczym sprzedawcy).
4. `list_new_finds` pokazuje kolejke. Otwierasz link, decydujesz, a potem
   `mark_find_handled` zeby zniknelo z listy.

5. Jesli sprzedawca ma `auto_like` / `auto_offer` **i** `AUTO_ACTIONS_ENABLED=true`,
   cron sam polubia i sklada oferte - tylko w oknie godzin, w ramach limitu
   godzinowego i dziennego, i nie w czasie pauzy bezpiecznika. Nadmiar czeka w
   kolejce. Domyslnie automat jest wylaczony.

> **Uwaga o planie Vercel:** darmowy plan Hobby pozwala na crona raz na dobe.
> Harmonogram `*/10 * * * *` wymaga planu Pro. Na Hobby zmien `schedule` w
> `vercel.json` na np. `0 9 * * *` albo wolaj `run_monitor_pass` recznie.

## Ograniczenia, o ktorych warto wiedziec

- **Endpointy Vinted nie sa oficjalnym API.** Sciezki potrafia sie zmienic bez
  zapowiedzi. Wszystkie siedza w `src/vinted/endpoints.ts`, a
  `diagnose_connection` wskaze, ktora przestala odpowiadac.
- **Nie udalo sie ich sprawdzic na zywo** przy pisaniu (srodowisko budujace nie
  mialo dostepu do vinted.pl), wiec pierwsze uruchomienie zacznij od
  `diagnose_connection`.
- **Endpointy zapisu (polubienie, oferta, publikacja...) sa niezweryfikowane.**
  Zanim wlaczysz automat, sprawdz je w DevTools i zrob jedna reczna oferte -
  procedura w [docs/ACTIONS.md](docs/ACTIONS.md).
- **Ceny to ceny wywolawcze, nie transakcyjne.** Vinted nie udostepnia publicznie
  cen sprzedazy, wiec `estimate_price` opisuje, czego chca sprzedajacy - i mowi
  to wprost w polu `notes`.
- **Bez Upstash monitoring nie dziala** miedzy wywolaniami. Serwer mowi o tym w
  odpowiedzi `watch_seller` i `list_watches` (pole `durableStorage`).

## Rozwoj lokalny

```bash
npm install
npm run typecheck
npm test
```

Testy (135) pokrywaja statystyke wyceny, arytmetyke rabatu, parsowanie
konfiguracji, uwierzytelnianie, redakcje sekretow w logach, warstwe protokolu
MCP, silnik monitoringu, akcje zapisu (bramka `confirm`, limity, bezpiecznik,
brak ponawiania), automatyke w cronie i sam endpoint HTTP. Nie dotykaja sieci.

## Struktura

```
api/
  mcp.ts              # endpoint MCP (Streamable HTTP, bezstanowy)
  cron/monitor.ts     # zaplanowany przebieg monitoringu
  health.ts           # liveness
src/
  mcp/                # protokol JSON-RPC, dyspozytor, definicje narzedzi
  vinted/             # klient HTTP, endpointy, wyszukiwanie, statystyka cen
  monitor/engine.ts   # wykrywanie nowych ofert
  store/              # Upstash Redis albo pamiec procesu
```
