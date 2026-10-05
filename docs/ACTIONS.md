# Akcje na Vinted i automatyka

Ten dokument opisuje wszystko, co serwer moze zmienic na Vinted: jak to dziala,
jakie ma zabezpieczenia i co sprawdzic, zanim wlaczysz automat.

## Akcje reczne

| Narzedzie | Co robi |
| --- | --- |
| `like_item` | Dodaje przedmiot do ulubionych |
| `make_offer` | Wysyla oferte cenowa; bez `price` = cena wywolawcza minus rabat (domyslnie 20%) |
| `process_find` | Dla znaleziska z `list_new_finds`: polubienie + oferta, potem oznacza jako zalatwione |
| `send_message` | Wiadomosc w rozmowie o przedmiocie |
| `publish_listing` | Publikuje oferte (najpierw te same kontrole co `validate_listing`) |
| `delete_listing` | Usuwa Twoja oferte. Nieodwracalne |

**Bramka potwierdzenia.** Kazde z tych narzedzi wywolane bez `confirm: true`
niczego nie wysyla - zwraca podglad: co poszloby do Vinted i czy limity na to
pozwalaja. Dopiero ponowne wywolanie z `confirm: true` wysyla.

`publish_listing` nie wgrywa zdjec. Wgraj je w Vinted i podaj ich `photo_ids`.

## Automatyka

Automatyczne polubienie i oferta na nowych przedmiotach obserwowanych
sprzedawcow. Wymaga dwoch rzeczy naraz:

1. `watch_seller` z `auto_like: true` i/lub `auto_offer: true` - per sprzedawca,
2. `AUTO_ACTIONS_ENABLED=true` w zmiennych na Vercel - glowny wylacznik.

Co sie dzieje przy kazdym przebiegu crona:

1. Wykrycie nowych przedmiotow, zapis znalezisk z cena oferty.
2. Powiadomienie na webhook (jesli ustawiony).
3. Kolejka automatycznych akcji - od najstarszych:
   - **poza oknem godzin** (`ACTIVE_HOURS`) - nic nie wychodzi, czeka;
   - **limit godzinowy** wyczerpany - reszta czeka do nastepnej godziny;
   - **limit dzienny** wyczerpany - ta akcja czeka do jutra;
   - **pauza bezpiecznika** - nic nie wychodzi do konca pauzy.

Nic z kolejki nie przepada przez limity - tylko sie przesuwa w czasie.

### Bezpiecznik

Gdy Vinted przy akcji odpowie 403, 429 albo zwroci strone (np. captcha) zamiast
danych, automat dla tego konta staje na `AUTOPAUSE_HOURS` (domyslnie 24 h).
Akcje reczne nadal dzialaja. Przyczyne zobaczysz w `get_automation_status`,
wznowienie: `resume_automation`.

Akcja zapisu nigdy nie jest ponawiana automatycznie po bledzie sieci lub 5xx -
nie wiadomo, czy doszla, a powtorka mogla by wyslac oferte dwa razy.

### Limity - ustawiane w locie

Zmienne srodowiskowe to tylko wartosci domyslne. Kazde konto mozesz
przestawic w rozmowie, bez redeployu:

```
set_automation_limits {
  "account_id": "main",
  "likes_per_day": 50,
  "offers_per_day": 15,
  "actions_per_hour": 10,
  "active_hours": "9-21",
  "autopause_hours": 12,
  "discount_pct": 25
}
```

Zmieniaja sie tylko podane pola. `0` wylacza dana akcje. `reset: true` wraca
do wartosci z Vercela. `get_automation_status` pokazuje, ktora wartosc
obowiazuje i skad pochodzi.

Dzienne limity dotycza takze akcji recznych; okno godzin i limit godzinowy -
tylko automatu.

## Zanim wlaczysz automat - weryfikacja endpointow

Sciezki zapisu w `src/vinted/endpoints.ts` sa oznaczone **UNVERIFIED** - nie
dalo sie ich sprawdzic na zywo przy pisaniu. Kolejnosc:

1. `diagnose_connection` - czy odczyt dziala.
2. Na Vinted w przegladarce, z otwartym DevTools (zakladka Network), polub
   przedmiot i zloz oferte recznie. Porownaj metode, sciezke i body z
   `endpoints.ts` i `src/vinted/actions.ts`; popraw, jesli sie roznia.
3. Jedna reczna `make_offer` z `confirm: true` na testowym przedmiocie.
4. Dopiero wtedy `AUTO_ACTIONS_ENABLED=true`.

## Czego tu nie ma

Warstwy maskujacej automat: podszywania sie pod przegladarke, losowania
opoznien i ruchow pod detektory botow, omijania CAPTCHA czy 2FA. Klient
przedstawia sie uczciwie w User-Agent i zatrzymuje sie, gdy Vinted protestuje.
Rolę ochrony konta pelnia zamiast tego umiarkowane limity, okno godzin,
rozlozenie akcji w czasie i bezpiecznik.

Sprawdz tez regulamin Vinted dla swojego rynku - automatyzacja akcji na
koncie moze byc z nim sprzeczna niezaleznie od tempa.
