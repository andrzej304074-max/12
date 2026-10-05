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
`pro_cancel_order`, `pro_relist_orders`, `pro_list_actions`, `pro_raw_get`,
`pro_remove_account`.

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
