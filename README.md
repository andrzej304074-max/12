# vinted-seller-mcp

Panel www i zdalny serwer MCP do sprzedazy na Vinted, jedno wdrozenie na Vercel.

- **Panel** (`/`) - minimalistyczna strona: laczysz konta, czytasz i piszesz
  wiadomosci, wystawiasz i edytujesz oferty, obserwujesz sprzedawcow, ustawiasz
  limity automatu.
- **MCP** (`/api/mcp`) - te same funkcje jako 42 narzedzia dla Claude Code i
  innych klientow MCP.

Panel nie dubluje logiki: kazde jego dzialanie wywoluje to samo narzedzie MCP
ta sama sciezka kodu. Konta, limity, obserwowani i szkice sa wspolne - co
ustawisz w panelu, widzi MCP, i odwrotnie.

Co robi: szuka porownywalnych ofert i wylicza cene, rozwiazuje kategorie i
marki, przygotowuje i publikuje oferty (ze zdjeciami), obsluguje skrzynke
wiadomosci, obserwuje wybranych sprzedawcow i zglasza ich nowe przedmioty z
cena negocjacyjna, a opcjonalnie sam polubia i sklada oferte -20% - w ramach
limitow ustawianych w locie.

Czego **nie** robi: nie udaje czlowieka. Klient przedstawia sie uczciwie, nie
rozwiazuje CAPTCHA i nie omija zabezpieczen Vinted; gdy Vinted zada weryfikacji,
zatrzymuje sie i mowi o tym wprost. Szczegoly: [docs/ACCOUNTS.md](docs/ACCOUNTS.md)
i [docs/ACTIONS.md](docs/ACTIONS.md).

## Wymagania

- Konto Vercel
- Upstash Redis (darmowy tier wystarcza) - bez niego konta, obserwowani i limity
  nie przetrwaja miedzy wywolaniami funkcji
- Konto Vinted (login, haslo i telefon do kodu SMS)

## Deploy na Vercel

```bash
npm i -g vercel
vercel link          # podepnij katalog do projektu na Vercel
vercel env add ADMIN_PASSWORD production      # haslo do panelu
vercel env add ENCRYPTION_KEY production      # openssl rand -hex 32
vercel env add MCP_AUTH_TOKEN production      # openssl rand -hex 32
vercel env add CRON_SECRET production         # dowolny dlugi sekret
vercel --prod
```

Upstash dodaj przez **Vercel → Storage → Upstash Redis**; zmienne
`UPSTASH_REDIS_REST_URL` i `UPSTASH_REDIS_REST_TOKEN` wstawia sam. Zrob to
**przed** podlaczeniem kont. Pelna lista zmiennych z opisami:
[`.env.example`](.env.example).

> `ENCRYPTION_KEY` szyfruje zapisane tokeny kont. Zmiana klucza oznacza
> ponowne podlaczenie wszystkich kont, wiec zachowaj jego kopie poza repozytorium.

## Pierwsze uruchomienie

1. Otworz adres projektu i zaloguj sie haslem z `ADMIN_PASSWORD`.
2. **Pulpit** pokazuje, czego jeszcze brakuje w konfiguracji (Upstash, klucz,
   tokeny). Uzupelnij, zrob redeploy.
3. **Konta → Dodaj konto**: rynek, login, haslo, potem kod SMS od Vinted.
   Szczegoly i ograniczenia: [docs/ACCOUNTS.md](docs/ACCOUNTS.md).
4. **Konta → Testuj** sprawdza sesje. Endpointy Vinted nie sa oficjalnym API i
   nie dalo sie ich sprawdzic na zywo przy pisaniu - pierwsze uruchomienie
   traktuj jak test.
5. **Obserwowani** → dodaj sprzedawce (ID albo link do profilu).
6. Dopiero na koncu, po sprawdzeniu endpointow zapisu
   ([docs/ACTIONS.md](docs/ACTIONS.md)), wlacz automat na Pulpicie.

## Panel

| Zakladka | Co robisz |
| --- | --- |
| **Wiadomosci** | Skrzynka jak komunikator, wszystkie konta naraz: rozmowy, dymki, oferty z przyciskami Akceptuj/Odrzuc, szybkie odpowiedzi, odswiezanie co 30 s |
| **Pulpit** | Stan konfiguracji, liczniki, glowny wylacznik automatu, reczny przebieg monitoringu |
| **Konta** | Podlaczanie (login + haslo + kod SMS), test sesji, ponowne logowanie, usuwanie, dziennik prob |
| **Obserwowani** | Sprzedawcy, rabat oferty, auto-polubienie, auto-oferta |
| **Znaleziska** | Nowe przedmioty z cena oferty -X%: Polub, Oferta, Polub + oferta, Zalatwione |
| **Research** | Podobne oferty, wycena (3 ceny + pewnosc), kategorie i marki |
| **Wystaw** | Zdjecia (zmniejszane w przegladarce), tytul, opis, kategoria, marka, cena z podpowiedzia, walidacja na zywo, szkice, publikacja |
| **Moje oferty** | Wyswietlenia, polubienia, edycja ceny/tytulu/opisu, usuwanie, duplikowanie jako szkic |
| **Automatyka** | Limity (doba/godzina), okno godzin, pauza, rabat - zmieniane w locie; kolejka i log akcji |
| **MCP** | Adres, polecenie podlaczenia klienta, lista narzedzi, reczne wywolanie narzedzia |

Dzialania wysylajace cos do Vinted pokazuja najpierw dokladnie co pojdzie
(publikacja, usuwanie, edycja, akceptacja oferty, usuniecie konta). Wiadomosc,
ktora piszesz recznie, i klikniete „Polub” wysylaja sie od razu - klikniecie jest
potwierdzeniem.

Wersja demo bez konta Vinted (atrapa Vinted w pamieci):

```bash
npm install
npm run demo        # http://localhost:3000, haslo do panelu: demo
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

Haslo do Vinted i kod SMS nigdy nie przechodza przez MCP ani przez rozmowe z
modelem - konta podlaczasz wylacznie w panelu.

## Narzedzia MCP

### Research

| Narzedzie | Do czego |
| --- | --- |
| `search_similar_items` | Porownywalne oferty z katalogu |
| `estimate_price` | Rozklad cen, trzy punkty cenowe, poziom pewnosci |
| `find_category` / `find_brand` | Nazwa → `catalog_id` / `brand_id` |
| `get_item`, `get_seller` | Pojedyncza oferta, profil sprzedawcy |

### Wiadomosci

| Narzedzie | Do czego |
| --- | --- |
| `list_conversations` | Rozmowy jednego konta albo wszystkich (`all_accounts`) |
| `get_conversation` | Cala rozmowa z wiadomosciami i ofertami |
| `reply_conversation` | Odpowiedz (`confirm: true`) |
| `respond_to_offer` | Akceptacja / odrzucenie oferty kupujacego (`confirm: true`) |
| `get_reply_templates`, `set_reply_templates` | Szybkie odpowiedzi |

### Wystawianie i oferty

| Narzedzie | Do czego |
| --- | --- |
| `draft_listing`, `validate_listing` | Sklada szkic i sprawdza go lokalnie - **nigdy nie publikuje** |
| `upload_photo` | Wgrywa zdjecie, zwraca `photo_id` |
| `publish_listing` | Publikacja (`confirm: true`, odrzuca szkic z blokerami) |
| `list_my_listings` | Wlasne oferty z wyswietleniami i polubieniami |
| `update_listing` | Zmiana tytulu/opisu/ceny (`confirm: true`) |
| `delete_listing` | Usuniecie oferty (`confirm: true`) |
| `save_draft`, `list_drafts`, `delete_draft` | Szkice zapisywane na koncie |

### Obserwowani i znaleziska

| Narzedzie | Do czego |
| --- | --- |
| `watch_seller`, `update_watch`, `unwatch_seller`, `list_watches` | Lista obserwowanych; `update_watch` zmienia flagi bez resetu „widzianych" |
| `list_new_finds`, `mark_find_handled` | Kolejka nowych przedmiotow z cena oferty |
| `like_item`, `make_offer`, `process_find`, `send_message` | Akcje na koncie (`confirm: true`) |
| `run_monitor_pass` | Przebieg od razu, bez czekania na crona |
| `preview_offer_price` | Sama arytmetyka rabatu |

### Konta, automat, diagnostyka

| Narzedzie | Do czego |
| --- | --- |
| `list_accounts`, `test_account`, `remove_account` | Konta (bez tokenow), test sesji, usuniecie (`confirm: true`) |
| `set_auto_actions_enabled` | Glowny wylacznik automatu |
| `set_automation_limits`, `get_automation_status`, `resume_automation` | Limity w locie, stan, zdjecie pauzy bezpiecznika |
| `diagnose_connection` | Sprawdza kazdy endpoint po kolei i mowi, ktory padl |

Kazde narzedzie zmieniajace cos na Vinted wywolane bez `confirm: true` zwraca
tylko podglad i niczego nie wysyla.

## Jak dziala monitoring

1. `watch_seller` zapisuje sprzedawce i **zaznacza jego obecne oferty jako juz
   widziane** - dzieki temu nie dostajesz na start calego archiwum.
2. Cron (`vercel.json`, domyslnie co 10 minut) odpytuje kazdego obserwowanego
   sprzedawce o najnowsze oferty, sprawdza nowe wiadomosci i odswieza sesje.
3. Nowe pozycje trafiaja do kolejki znalezisk razem z `suggestedOfferPrice`
   (domyslnie -20%; zmienisz w zakladce Automatyka albo przy sprzedawcy).
4. Nowe znaleziska i nieprzeczytane wiadomosci moga isc na webhook
   (`NOTIFY_WEBHOOK_URL`, np. Discord) - reagujesz z telefonu.
5. Jesli sprzedawca ma auto-polubienie / auto-oferte **i** automat jest wlaczony
   na Pulpicie, cron sam to robi - tylko w oknie godzin, w ramach limitu
   godzinowego i dziennego, i nie w czasie pauzy bezpiecznika. Nadmiar czeka w
   kolejce. Domyslnie automat jest wylaczony.

> **Uwaga o planie Vercel:** darmowy plan Hobby pozwala na crona raz na dobe i
> do 12 funkcji. Harmonogram `*/10 * * * *` wymaga planu Pro. Na Hobby zmien
> `schedule` w `vercel.json` na np. `0 9 * * *` albo uzywaj przycisku „Uruchom
> przebieg teraz". Panel jest jedna funkcja, wiec miesci sie w limicie.

## Bezpieczenstwo

- Panel: jedno haslo, podpisane ciasteczko sesji (HttpOnly, SameSite=Strict,
  Secure na produkcji, 7 dni), sprawdzanie `Origin` przy kazdej zmianie, blokada
  po 5 blednych hasel / 15 min. Blokada dziala miedzy wywolaniami tylko z
  Upstash.
- Hasla Vinted nie sa zapisywane ani logowane; tokeny sa szyfrowane
  (AES-256-GCM). Logi redaguja klucze typu `password`, `token`, `cookie`.
- Serwer wysyla zapytania z danymi konta **wylacznie** do hostow Vinted - zadne
  narzedzie nie moze skierowac ich gdzie indziej, nawet gdy tekst wiadomosci od
  obcego probuje do tego namowic model.
- Instrukcje MCP mowia modelowi, ze tresc wiadomosci i opisow to dane, a nie
  polecenia.

## Ograniczenia, o ktorych warto wiedziec

- **Endpointy Vinted nie sa oficjalnym API** i zadnego z nich - odczytu, zapisu,
  logowania, skrzynki ani wgrywania zdjec - nie dalo sie sprawdzic na zywo przy
  pisaniu (srodowisko budujace nie mialo dostepu do vinted.pl). Sciezki sa w
  `src/vinted/endpoints.ts`, pola logowania w `src/vinted/login.ts`.
  Procedura weryfikacji: [docs/ACCOUNTS.md](docs/ACCOUNTS.md) i
  [docs/ACTIONS.md](docs/ACTIONS.md).
- **Logowanie z serwera moze byc blokowane.** Vinted chroni logowanie przed
  botami, a Vercel to ruch z serwerowni. Jesli zazada CAPTCHA, panel powie to
  wprost i niczego nie bedzie obchodzil - konta wtedy nie podlaczysz, dopoki
  Vinted nie przepusci.
- **Ceny to ceny wywolawcze, nie transakcyjne.** `estimate_price` mowi to wprost.
- **Bez Upstash nic nie jest trwale** - Pulpit i widok Kont ostrzegaja.
- Automatyzacja akcji na koncie moze byc sprzeczna z regulaminem Vinted
  niezaleznie od tempa - sprawdz go dla swojego rynku.

## Rozwoj lokalny

```bash
npm install
npm run typecheck
npm test            # 286 testow, nie dotykaja sieci
npm run demo        # panel z atrapa Vinted
```

Testy pokrywaja m.in. szyfrowanie, konta, logowanie (kod SMS, blokada, limit
prob, odswiezanie sesji), sesje i ochrone panelu, bramke `confirm`, limity i
bezpiecznik, automat w cronie, skrzynke, wgrywanie zdjec, szkice oraz
ograniczenie hostow.

## Struktura

```
public/               # panel (HTML + vanilla JS, bez frameworka i bez builda)
  views/              # jeden plik na zakladke
api/
  mcp.ts              # endpoint MCP (Streamable HTTP, bezstanowy)
  app/[...path].ts    # backend panelu (jedna funkcja na wszystkie /api/app/*)
  cron/monitor.ts     # zaplanowany przebieg monitoringu
  health.ts           # liveness
src/
  app/router.ts       # trasy panelu: logowanie, sesja, /tool, konta
  mcp/                # protokol JSON-RPC, dyspozytor, definicje narzedzi
  vinted/             # klient HTTP, endpointy, logowanie, konta, skrzynka
  monitor/            # wykrywanie nowych ofert, limity, bezpiecznik, powiadomienia
  store/              # Upstash Redis albo pamiec procesu
  crypto.ts session.ts settings.ts
scripts/dev-server.ts # demo z atrapa Vinted (nie jest wdrazane)
docs/                 # ACCOUNTS.md, ACTIONS.md
```
