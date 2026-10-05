# Vinted Pro - oficjalne API

Ten dokument opisuje integracje z **Vinted Pro Integrations**: oficjalnym,
serwerowym API Vinted dla sprzedawcow. Dziala na Vercelu 24/7, bez przegladarki
i bez obchodzenia czegokolwiek, bo to jedyna droga, ktora Vinted dla serwerow
przewiduje.

## Co to daje, a czego nie

Daje (zakres wedlug dokumentacji integratora):

- oferty: walidacja, tworzenie (domyslnie jako szkice), edycja, usuwanie,
  status, lista, import ofert dodanych poza API i nadawanie im referencji (SKU),
- zamowienia, przesylki i **etykieta PDF** (oplacona przez Vinted),
- anulowanie zamowienia i ponowne wystawienie,
- slowniki potrzebne do zbudowania oferty (kategorie, kolory, rozmiary paczek,
  stany, grupy rozmiarow) i sugestie cen.

Nie obejmuje: szukania cudzych ofert, obserwowania sprzedawcow, polubien, ofert
cenowych ani skrzynki z kupujacymi. Te funkcje (zbudowane na nieoficjalnym API
konsumenckim) sa domyslnie **ukryte**: Vinted blokuje z serwerow ruch do tego
API, a dokumentacja Vinted Pro uznaje automatyzowanie konta konsumenckiego za
naruszenie regulaminu. `ENABLE_UNOFFICIAL=true` je przywraca.

## Czego wymaga

1. **Konto Vinted Pro wpisane przez Vinted na liste dozwolonych (allowlist).**
   Nie ma samodzielnej rejestracji ani publicznych kluczy. Dostep przyznaje
   program partnerski Vinted.
2. **Obslugiwany rynek.** Dokumentacja wymienia AT, BE, DE, ES, FR, IT, LU, NL,
   PT i UK (EUR i GBP). **Polski i PLN nie ma na tej liscie.** Zapytaj Vinted,
   czy Twoje konto jest obslugiwane; jesli nie, API odpowie 403 i nic wiecej tu
   nie zadziala.
3. **Token z portalu Vinted Pro** (https://pro-portal.svc.vinted.com/): jeden
   ciag `klucz_dostepu,klucz_podpisu`. Sandbox i produkcja maja **osobne**
   tokeny.

## Podlaczenie

1. W panelu: **Konta -> Vinted Pro -> Dodaj konto Vinted Pro**.
2. Wpisz nazwe, wybierz srodowisko (zacznij od **sandboxu**) i wklej token.
3. Panel zapisuje token **zaszyfrowany** (`ENCRYPTION_KEY`) i od razu robi
   sprawdzenie: jedno podpisane zapytanie `GET /api/v1/ontologies`.

Token wpisujesz tylko tutaj. Zaden endpoint, narzedzie MCP ani odpowiedz go nie
zwraca, a blad w tresci zadania nie cytuje jego fragmentow.

### Jak czytac wynik sprawdzenia

| Werdykt | Co znaczy | Co zrobic |
|---|---|---|
| ok | Podpis i token przyjete, ontologia pobrana | Mozna wystawiac |
| 401 (`unauthorized`) | Zly podpis albo token | Sprawdz, czy token jest caly, czy ma to samo srodowisko co konto, i czy zegar serwera jest poprawny (znacznik czasu jest w podpisie; wynik pokazuje czas serwera) |
| 403 (`forbidden`) | Konto poza allowlista albo rynek spoza listy | Zapytaj Vinted; pamietaj, ze PL nie ma w dokumentacji |
| 429 | Limit zapytan | Odczekaj; klient sam ponawia z uwzglednieniem `Retry-After` |
| siec | Serwer nie siega Vinted Pro | Sprawdz status uslugi |

## Jak to dziala (skrot)

- Kazde zadanie jest podpisane HMAC-SHA256 kluczem podpisu, ktory **nigdy nie
  jest wysylany**. Podpisywany jest dokladnie ten sam tekst, ktory idzie w sieci
  (sciezka z query i cialo). Przy ponowieniu podpis liczony jest od nowa.
- Zapisy (tworzenie, edycja, usuwanie, anulowanie, ponowne wystawienie) wymagaja
  `confirm: true`; bez niego narzedzie pokazuje podglad i niczego nie wysyla.
- Oferty tworzone sa jako **szkice**, dopoki nie podasz `publish: true`.
  Walidacja Vinted dziala przed tworzeniem; blad zatrzymuje tworzenie.
- Tworzenie, edycja i usuwanie sa **asynchroniczne**: odpowiedz oznacza tylko
  przyjecie zlecenia, a wynik przychodzi pozniej (status oferty albo webhook).
- Paczki maja najwyzej 100 pozycji; wieksze listy sa dzielone i wysylane po
  kolei. Gdy pozniejsza paczka zawiedzie, wynik mowi, ile poszlo wczesniej.
- Klient ponawia tylko to, co bezpiecznie powtorzyc (GET, PUT, DELETE). POST nie,
  bo dwukrotne utworzenie jest gorsze niz jeden blad; wyjatek to 429, ktore
  oznacza odmowe zanim cokolwiek sie stalo.

## Narzedzia MCP

`diagnose_pro`, `pro_list_accounts`, `pro_get_ontology`, `pro_find_category`,
`pro_price_suggestion`, `pro_list_items`, `pro_get_item_status`,
`pro_validate_items`, `pro_create_items`, `pro_update_items`,
`pro_delete_items`, `pro_list_imported_items`, `pro_set_item_references`,
`pro_list_orders`, `pro_get_order`, `pro_get_shipment`, `pro_get_label`,
`pro_cancel_order`, `pro_relist_orders`, `pro_list_webhooks`,
`pro_register_webhook`, `pro_delete_webhook`, `pro_list_events`,
`pro_simulate_sale` (tylko sandbox), `pro_list_actions`, `pro_raw_get`,
`pro_remove_account`.

## Webhooki

Tworzenie, edycja i usuwanie ofert sa asynchroniczne, wiec wynik (i sprzedaz,
zamowienia, gotowa etykieta) przychodzi do Ciebie webhookiem.

1. Zarejestruj webhook: narzedzie `pro_register_webhook` (bez `confirm` pokazuje
   podglad). Adres to `https://<twoja-domena>/api/pro/webhook`; serwer sam
   dopisuje `?account=<id konta>`. Na Vercelu adres produkcyjny jest domyslny.
2. Vinted odpowiada **kluczem podpisu** tego webhooka. Jest zapisywany
   zaszyfrowany i uzywany wylacznie do sprawdzania dostaw; zadna odpowiedz go nie
   pokazuje.
3. Kazda dostawa jest przyjmowana tylko, gdy jej podpis (HMAC-SHA256 po
   `<t>.<surowe cialo>`) sie zgadza, a `t` jest nie starsze niz 5 minut.
   Powtorzona dostawa jest obslugiwana raz (10 minut). Odpowiedz 2xx wraca od
   razu.
4. Zdarzenia widac w `pro_list_events` (ostatnie 100) i w indeksie ofert
   (`pro_list_items` -> `tracked`). O sprzedazy, zamowieniach, etykiecie,
   anulowaniu i bledach powiadamia `NOTIFY_WEBHOOK_URL`, jesli jest ustawiony.

### Wazne: `NODEJS_HELPERS=0`

Podpis obejmuje **dokladne bajty** ciala. Domyslnie Vercel parsuje JSON przed
uruchomieniem funkcji i te bajty znikaja. Ustaw w projekcie na Vercelu
(Settings -> Environment Variables, wszystkie srodowiska) zmienna
`NODEJS_HELPERS=0` i zrob Redeploy: funkcje dostana wtedy surowy strumien. Ten
projekt nie uzywa zadnych pomocnikow Vercela (`req.body`, `req.query`, `res.json`),
wiec nic innego sie nie zmienia. Sprawdzone prawdziwym `vercel build`: ze zmienna
zbudowane funkcje maja `shouldAddHelpers: false`.

Bez niej odbiornik odbudowuje cialo z sparsowanego JSON-u. To weryfikuje sie
tylko wtedy, gdy JSON od Vinted jest bajt w bajt taki jak `JSON.stringify`;
inaczej dostawa jest **odrzucana** (bezpiecznie), a `pro_list_events` pokazuje ja
w `refusedDeliveries` z `fromParsed: true` i powodem.

### Test w sandboxie

Dodaj oferte (`pro_create_items`), poczekaj az przejdzie z `IN_PROGRESS`, potem
`pro_simulate_sale` z jej id: Vinted wysle `ITEM_SOLD`, `ORDER_CREATED` i
`SHIPMENT_LABEL_CREATED`. Po nich `pro_list_orders` pokaze zamowienie, a
`pro_get_label` zwroci etykiete PDF.

## Codzienne uzgodnienie (cron)

Raz dziennie (Vercel Cron, plan Hobby pozwala na taka czestotliwosc) serwer:

- pyta o status ofert, ktore od ponad 5 minut sa `IN_PROGRESS` (gdyby webhook
  zginal), nie wiecej niz 40 na konto,
- odswieza pamiec podreczna ontologii, gdy ma ponad 20 godzin.

Konto z odrzuconym tokenem jest pomijane. Funkcje nieoficjalne (monitoring
sprzedawcow) dzialaja w tym cronie tylko przy `ENABLE_UNOFFICIAL=true`.

## Co jest niepewne i jak to sprawdzic

Dokumentacja integratora zostala zlozona z fragmentow oficjalnej dokumentacji i
dwoch niezaleznych klientow, a nie z samej specyfikacji. Wszystko, co oznaczono
w niej jako prawdopodobne lub niepotwierdzone, jest w kodzie zebrane w jednym
miejscu (`src/pro/endpoints.ts` i `src/pro/schema.ts`), a kazdy taki punkt mozna
obejrzec bez zmieniania kodu:

- **`pro_raw_get`** wysyla jedno podpisane zapytanie GET i pokazuje surowa
  odpowiedz, z bledami wlacznie. Tak sprawdzisz np. nazwe parametru kursora
  zamowien (`after-id` czy `after_id`) albo ksztalt odpowiedzi listy ofert.
- **`pro_get_ontology` z `key`** pokazuje dowolna sekcje slownika tak, jak
  przyslal ja Vinted (np. `colors`, `statuses`).
- Oficjalna specyfikacja OpenAPI: https://pro-docs.svc.vinted.com/downloads/api.yml
  Dodaj ja do repozytorium jako `docs/vinted-pro/api.yml`, a test kontraktowy
  porowna z nia sciezki i pola uzywane w kodzie.

Czego nie da sie sprawdzic poza prawdziwym Vinted: ksztaltu odpowiedzi, formatu
pola `price`, nazwy pola rozmiaru, wartosci statusow ofert, polityki ponowien
webhookow. Pierwszy test na prawdziwym sandboxie moze wiec wymagac drobnych
poprawek stalych.

## Zdjecia

API przyjmuje wylacznie **publiczne, trwale adresy URL** (`photo_urls`); Vinted
sam je pobiera. Nie uzywaj adresow, ktore wygasaja, ani zdjec z innych
marketplace'ow.
