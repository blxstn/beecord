# beecord

Beecord to otwartoźródłowa (open-source) modyfikacja Discorda na komputery (Desktop).

## Struktura projektu

- `installer.bat` – jedyny główny instalator w katalogu głównym (instalacja, deinstalacja, podgląd logów)
- `data/` – pliki systemowe i moduły odpowiedzialne za uruchamianie i działanie moda:
  - `loader.js` – moduł wstrzykiwany w główny proces Discorda, ładujący renderer i pluginy
  - `renderer.js` – rdzeń modyfikacji działający w oknie Discorda, zakładka ustawień Beecord
  - `media.ps1` – skrypt PowerShell integrujący kontrolki multimedialne Spotify z Windows
  - `watcher.js` – usługa w tle dbająca o zachowanie modyfikacji po aktualizacjach Discorda
  - `install.js` – silnik instalatora/deinstalatora
  - `show-log.bat` – skrypt wyświetlający logi
  - `uninstall.bat` – skrypt usuwający modyfikację
- `plugins/` – katalog z wszystkimi dostępnymi pluginami:
  - `beebadge.js` – odznaka pszczoły (BeeBadge) w profilu Discorda
  - `char-counter.js` – licznik znaków na żywo podczas pisania wiadomości
  - `custom-css.js` – edytor własnego CSS stosowanego na żywo
  - `device-detector.js` – ikony urządzeń (PC / telefon / przeglądarka / konsola) na awatarach
  - `fake-voice.js` – fałszywe wyciszenie / ogłuszenie (przycisk obok mikrofonu)
  - `friendship-notifier.js` – powiadomienia i logi o usunięciu/zablokowaniu oraz zaproszeniach do znajomych
  - `mark-all-read.js` – przycisk oznaczania wszystkich kanałów i DM jako przeczytane jednym kliknięciem
  - `message-logger.js` – zapisywanie usuniętych wiadomości oraz multimediów (DELETED w czacie i panel Logs)
  - `silent-typing.js` – ukrywanie wskaźnika pisania wiadomości przed innymi
  - `spotify.js` – karta odtwarzacza Spotify nad panelem użytkownika z pełną kontrolą i falą dźwiękową
  - `_template.js` – szablon do tworzenia własnych pluginów

## Instalacja

1. Uruchom dwuklikiem plik `installer.bat` znajdujący się w głównym folderze `beecord`.
2. Wybierz opcję `[1]` (lub naciśnij Enter).
3. Instalator zamknie Discorda, wgra pliki do `%APPDATA%\beecord`, skopiuje pluginy i ponownie uruchomi Discorda.
4. W ustawieniach Discorda pojawi się sekcja **beecord**.
