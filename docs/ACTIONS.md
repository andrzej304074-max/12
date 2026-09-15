# Dlaczego serwer nie wykonuje akcji na Vinted

Ten serwer czyta i monitoruje. Nie publikuje ofert, nie usuwa ich, nie polubia
przedmiotow, nie wysyla wiadomosci ani ofert cenowych. To swiadoma granica, a
nie brak czasu - ponizej co dokladnie jest, czego nie ma i co trzeba rozstrzygnac,
zanim dolozy sie reszte.

## Co jest zaimplementowane

| Obszar | Narzedzia |
| --- | --- |
| Research | `search_similar_items`, `estimate_price`, `find_category`, `find_brand`, `get_item`, `get_seller` |
| Przygotowanie oferty | `draft_listing`, `validate_listing` (obie czysto lokalne) |
| Monitoring | `watch_seller`, `unwatch_seller`, `list_watches`, `list_new_finds`, `mark_find_handled`, `run_monitor_pass`, `preview_offer_price` |
| Diagnostyka | `list_accounts`, `diagnose_connection` |

Monitoring wykrywa nowe przedmioty u obserwowanych sprzedawcow i dolicza do
kazdego cene negocjacyjna (domyslnie 20% ponizej ceny wywolawczej). Wynik ladu-
je w kolejce `list_new_finds`. Kliknieciem w link otwierasz oferte i decydujesz
sam.

## Czego nie ma

`publish_listing`, `delete_listing`, `like_item`, `make_offer`, `send_message`.

Powody, w kolejnosci wagi:

1. **Nieodwracalne zobowiazania wobec osob trzecich.** Oferta cenowa i wiadomosc
   trafiaja do konkretnego czlowieka i sa wiazace w praktyce. Automat, ktory
   wysyla je bez przeczytania oferty przez czlowieka, generuje zobowiazania,
   ktorych nikt nie sprawdzil.
2. **Skala zmienia charakter dzialania.** Jedna propozycja -20% to negocjacja.
   Ta sama propozycja wysylana automatycznie do kazdej nowej oferty kilkunastu
   obserwowanych sprzedawcow to zalew powiadomien dla ludzi, ktorzy o to nie
   prosili.
3. **Endpointow zapisu nie dalo sie zweryfikowac.** Sciezki write API Vinted sa
   nieudokumentowane i nie bylo mozliwosci sprawdzenia ich na zywo podczas
   pisania. Kod, ktory wysyla oferte cenowa pod nieprzetestowany endpoint, to
   kod, ktory moze wyslac zla kwote.
4. **Regulamin.** Vinted nie udostepnia publicznego API do dzialan sprzedazowych.
   Odczyt katalogu to jedno, automatyczne skladanie ofert w cudzym imieniu -
   drugie.

## Czego nie ma i nie bedzie

Warstwy anty-detekcyjnej: podszywania sie pod fingerprint przegladarki, rotacji
User-Agentow, losowania opoznien pod detektory botow, omijania CAPTCHA czy 2FA.

Klient w `src/vinted/client.ts` robi odwrotnie - przedstawia sie uczciwie w
User-Agent i honoruje `429` oraz `Retry-After`. Odstep miedzy zapytaniami
(`VINTED_MIN_REQUEST_INTERVAL_MS`) jest po to, zeby nie obciazac cudzego
serwisu, a nie zeby ukryc, ze to automat.

Warto wiedziec, ze `vinted-seller-mcp`, od ktorego zaczal sie ten projekt, sam
deklaruje to samo: CAPTCHA i 2FA nigdy nie sa obchodzone, logowanie jest reczne,
a publikacja, usuwanie i wiadomosci wymagaja jawnego potwierdzenia.

## Jesli mimo to chcesz dolozyc akcje zapisu

To Twoje repo i Twoja decyzja. Zanim dolozysz:

1. **Zweryfikuj endpointy.** Otworz DevTools na Vinted, wykonaj akcje recznie i
   spisz faktyczna sciezke, metode oraz ksztalt body. Dopisz je do
   `src/vinted/endpoints.ts` - to jedyne miejsce ze sciezkami.
2. **Zachowaj bramke potwierdzenia.** Kazde narzedzie piszace powinno wymagac
   `confirm: true` w argumentach i miec `destructiveHint: true` w adnotacjach,
   tak jak robi to oryginalny serwer.
3. **Nie wpinaj tego w crona.** `api/cron/monitor.ts` celowo tylko wykrywa.
   Harmonogram, ktory sam zaczepia obcych ludzi, to inna kategoria programu.
4. **Dodaj dzienne limity.** `MAX_LIKES_PER_DAY` i `MAX_OFFERS_PER_DAY` sa juz w
   konfiguracji (`src/config.ts`) i czekaja na uzycie - liczniki z wygasaniem
   dobowym sa w `src/store/index.ts` (`keys.likeCount`, `keys.offerCount`).
5. **Sprawdz regulamin Vinted** dla swojego rynku i swojego typu konta.
