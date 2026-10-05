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

### Vinted zada CAPTCHA albo blokuje serwer

Vinted chroni logowanie przed botami, a Vercel to ruch z serwerowni, wiec
blokada jest realna. Wtedy panel pokazuje: „Vinted zazadal weryfikacji
antybotowej (CAPTCHA lub limit), ktorej serwer nie przejdzie".

Serwer **niczego nie omija**: nie rozwiazuje CAPTCHA, nie podszywa sie pod
przegladarke, nie rotuje adresow ani naglowkow, nie ponawia prob w petli.
Zatrzymuje sie po jednej probie. Mozesz sprobowac pozniej. Konta nie podlaczysz,
dopoki Vinted nie przepusci logowania z tego adresu.

> Jedyna alternatywa poza panelem to konto zdefiniowane w zmiennej
> `VINTED_ACCOUNTS` (token z DevTools po zalogowaniu w przegladarce, opis w
> `.env.example`). Takie konta panel oznacza „zmienna srodowiskowa" i nie ma dla
> nich formularza dodawania.

### „Unexpected response" przy logowaniu

Logowanie Vinted nie jest udokumentowanym API i nie dalo sie go sprawdzic na
zywo. Jesli odpowiedz ma nieoczekiwany ksztalt, serwer mowi to wprost. Poprawka
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
