# Podlaczanie kont Vinted

Konta podlaczasz w panelu: **Konta → Dodaj konto**. To jedyna sciezka dodawania
konta w panelu. Hasla nie przekazujesz przez MCP ani przez rozmowe z modelem.

## Jak to wyglada

1. Wybierasz rynek (vinted.pl, .de, .fr...), wpisujesz login (e-mail) i haslo.
2. Serwer loguje sie do Vinted jako klient. Jesli Vinted zada weryfikacji,
   panel pokazuje pole **Kod** (z zamaskowanym numerem, jesli Vinted go poda).
   Kod wpisujesz Ty - panel tylko przekazuje go dalej.
3. Po sukcesie serwer odczytuje profil (login, ID, avatar) i pokazuje
   „Polaczono jako @login". Konto jest gotowe do uzycia w panelu i w MCP.
4. **Testuj** w kazdej chwili sprawdza, czy sesja dziala.

## Co sie dzieje z haslem i tokenami

- **Haslo** jest uzyte jednorazowo w zapytaniu logowania i nigdzie nie jest
  zapisywane, logowane ani zwracane. Pole hasla jest czyszczone po kazdej probie.
  Krok z kodem nie wymaga hasla - wysyla tylko token wyzwania i kod.
- **Tokeny sesji** (`access_token`, `refresh_token`, ciasteczko sesji) sa
  szyfrowane AES-256-GCM kluczem `ENCRYPTION_KEY` i trzymane w Upstash.
  Bez klucza serwer w ogole nie przyjmie hasla - odmowi, zanim cokolwiek
  wysle.
- Stan posredni miedzy haslem a kodem (token wyzwania) jest szyfrowany i
  wygasa po 10 minutach.
- Dziennik prob logowania (Konta → „Pokaz dziennik") zawiera date, rynek,
  zamaskowany login (`a***@example.com`) i wynik. Nigdy hasla.

## Utrzymanie sesji

Serwer sam odnawia sesje z `refresh_token`: z wyprzedzeniem, gdy token zbliza
sie do wygasniecia, i jednorazowo po kazdym 401. Gdy odnowienie sie nie uda,
konto dostaje status **wymaga logowania**, cron je pomija, a webhook (jesli
ustawiony) wysyla powiadomienie. Klikasz **Zaloguj ponownie** - to samo
logowanie z haslem i kodem, konto zachowuje swoje ID, obserwowanych i limity.

## Co moze pojsc nie tak

### „Vinted zablokowal to polaczenie ochrona antybotowa" - przy kazdym hasle

To **nie jest blad hasla**. Ochrona antybotowa Vinted dziala **zanim** Vinted w
ogole sprawdzi haslo: ocenia samo polaczenie (adres IP, naglowki, ciasteczka,
ktore normalnie ustawia przegladarka). Zapytanie z serwera Vercela pochodzi z
centrum danych i nie ma przegladarki, wiec dostaje te sama odpowiedz niezaleznie
od tego, co wpiszesz. W przegladarce to sprawdzenie zwykle przechodzi sie w tle, bez Twojego udzialu.

Panel nazywa cos blokada **tylko na dowodach**: kod odpowiedzi 401/403/405/503
**oraz** znacznik, ktory wystepuje wylacznie na stronach wyzwan (naglowek
`x-datadome`, adres `captcha-delivery.com`, „Just a moment", `cf-chl`...). Samo
slowo „datadome" albo „captcha" na zwyklej stronie Vinted nic nie znaczy i nie
wystarcza. Dzieki temu rozne sytuacje daja rozne komunikaty:

| Komunikat w panelu | Co naprawde zwrocilo Vinted | Co to znaczy |
| --- | --- | --- |
| „zablokowal to polaczenie ochrona antybotowa, zanim sprawdzil haslo" | 403/503 ze znacznikiem wyzwania | Prawdziwa blokada adresu serwera |
| „odrzucil zapytanie i nie podal powodu" | 403/503 bez znacznikow | Zwykle to samo, ale nie da sie potwierdzic |
| „odpowiedzial strona internetowa zamiast danych logowania" | 200/404/405 lub przekierowanie, HTML | Zly adres logowania - blad po naszej stronie, nie hasla |
| „ogranicza liczbe zapytan" | 429 | Limit po stronie Vinted - sprobuj za kilka minut |
| „odrzucil login lub haslo" | JSON `invalid_grant` | Haslo lub login naprawde sie nie zgadza |

Kazdy blad logowania ma rozwijane **Szczegoly techniczne**: kod HTTP, serwer,
typ tresci, rozpoznane znaczniki i oczyszczony poczatek odpowiedzi (bez znacznikow
HTML, adresow e-mail i dlugich tokenow; haslo i login sa z niego usuwane nawet
gdyby Vinted je odeslal). Przycisk **Skopiuj** kopiuje je do schowka.

#### Sprawdz polaczenie z Vinted (bez hasla)

Na stronie **Konta** przycisk **Sprawdz polaczenie z Vinted** wysyla z serwera 3
nieszkodliwe zapytania i pokazuje, co odpowiedzialo Vinted: strone glowna,
adres logowania (z atrapa tokenu - bez hasla i bez zadnego konta) i publiczne
API. To samo robi narzedzie MCP `diagnose_login`. Limit: 10 sprawdzen na godzine.
Werdykty:

- **blokuje ten serwer** - prawdziwa blokada adresu (patrz nizej),
- **odpowiada na logowanie** - serwer jest przepuszczany; jesli logowanie mimo to
  pokazuje blokade, dzieje sie to dopiero przy kroku z haslem,
- **adres logowania zwraca strone internetowa** - adres sie zmienil, patrz
  „Unexpected response" nizej,
- **limit zapytan**, **blad sieci**, **niejednoznaczne** - przycisk **Skopiuj wynik**
  pozwala przeslac pelny wynik do oceny.

#### Co oznacza prawdziwa blokada

Jesli sprawdzenie pokazuje, ze Vinted blokuje ten serwer, to dotyczy to **wszystkich**
zapytan z Vercela do Vinted - nie tylko logowania, ale tez wyszukiwania, skrzynki
i monitoringu. Zmiana hasla ani ponawianie niczego nie zmienia.

Serwer **niczego nie omija**: nie rozwiazuje CAPTCHA, nie podszywa sie pod
przegladarke, nie rotuje adresow ani naglowkow, nie uzywa posrednikow z domowymi
adresami, nie ponawia prob w petli (zadanie z wyzwaniem nie jest powtarzane).
Uczciwa droga to wykonywac zapytania z **Twojej wlasnej przegladarki**, na Twoim
adresie i w Twojej sesji - np. rozszerzenie do Chrome, ktore realizuje zadania z
panelu. To osobna, wieksza zmiana; jesli sprawdzenie potwierdzi blokade, mozna ja
zaplanowac.

> Konto zdefiniowane w zmiennej `VINTED_ACCOUNTS` (token z DevTools po
> zalogowaniu w przegladarce, opis w `.env.example`) omija tylko samo logowanie
> hasla - zapytania z serwera nadal szlyby z adresu Vercela.

### „Unexpected response" przy logowaniu

Logowanie Vinted nie jest udokumentowanym API i nie dalo sie go sprawdzic na
zywo. Jesli odpowiedz ma nieoczekiwany ksztalt, serwer mowi to wprost i pokazuje
w **Szczegolach technicznych**, co dokladnie przyszlo (kod HTTP, typ tresci,
przekierowanie, fragment). Poprawka
to jedno miejsce - `LOGIN_FIELDS` w `src/vinted/login.ts` oraz
`endpoints.oauthToken` w `src/vinted/endpoints.ts`:

1. Zaloguj sie na vinted.pl w przegladarce z otwartym DevTools → Network.
2. Znajdz zapytanie logowania (POST) i porownaj: adres, nazwy pol w ciele
   (`grant_type`, `username`, `password`, `client_id`...) oraz ksztalt odpowiedzi.
3. Jesli jest weryfikacja kodem, sprawdz, ktore pola odpowiedzi musza wrocic
   z kodem (`LOGIN_FIELDS.challengeKeys`) i pod jakim kluczem idzie kod
   (`LOGIN_FIELDS.codeKey`).
4. Jesli krok z kodem wymaga takze hasla, trzeba to dopisac w `verifyLogin` -
   obecnie hasla tam nie ma, bo nie jest przechowywane.

To samo dotyczy skrzynki, wgrywania zdjec i edycji ofert (`src/vinted/inbox.ts`,
`endpoints.ts`): widok skrzynki jest pusty albo „dziwny", gdy sciezki odczytu
w normalizatorach nie zgadzaja sie z prawdziwa odpowiedzia.

## Limity ochronne

| Co | Limit |
| --- | --- |
| Proby logowania na jedno konto | 3 na godzine |
| Bledne kody weryfikacyjne | 5 na jedno wyzwanie |
| Bledne haslo do panelu | 5 na 15 minut z jednego adresu |

Limity zabezpieczaja przed zablokowaniem konta przez Vinted po serii pomylek.
Licza sie miedzy wywolaniami tylko z Upstash.

## Usuwanie konta

**Konta → Usun** (z podgladem) kasuje konto razem z wszystkim, co o nim
przechowuje serwer: tokeny, obserwowani, znaleziska, limity, szkice, stan
skrzynki. Nie wylogowuje sesji po stronie Vinted.
