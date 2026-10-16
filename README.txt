blxstncord - system pluginow
============================

INSTALACJA (jedna dla wszystkiego, takze przy aktualizacji):
  1. Rozpakuj CALY zip (folder blxstncord z podfolderem plugins).
  2. Dwuklik install.bat. Odczekaj ~20 s po starcie Discorda.
  3. Ustawienia Discorda -> sekcja "blxstncord" -> zakladki Plugins, Logs i Credits.
  install.bat zamyka Discorda, wgrywa loader, renderer, media.ps1 i WSZYSTKIE pluginy z folderu plugins,
  instaluje watchera (auto-patch po aktualizacji Discorda) i uruchamia Discorda.
  Nowa wersja paczki = po prostu uruchom install.bat jeszcze raz. Nic wiecej.

W ZESTAWIE (folder plugins):
  Fake Mute / Deafen  (fake-voice.js)
  Silent Typing       (silent-typing.js)
  Custom CSS          (custom-css.js)
  Character Counter   (char-counter.js)
  Spotify Controls    (spotify.js)        - karta nad panelem uzytkownika, pasek-fala, miernik glosnosci
  Message Logger      (message-logger.js) - usuniete wiadomosci (DM i serwery, tez nieprzeczytane) zostaja w czacie
                                            na czerwono (DELETED) i trafiaja do zakladki Logs. Zakladka Logs ma
                                            przycisk "Clear all logs" (czyszczenie jednym przyciskiem) oraz x przy kazdej wiadomosci.

PLUGINY LEZA TUTAJ:   %APPDATA%\blxstncord\plugins\
  - Kazdy plik .js = jeden plugin. Nowy / zmieniony plik: Plugins -> "Rescan" (bez restartu).
  - Pliki zaczynajace sie od "_" sa ignorowane (np. _template.js).
  - Plugin z bledem pokazuje sie na czerwono, reszta dziala dalej.
  - Wlasne pluginy: skopiuj plugins\_template.js, zmien nazwe i id.

AUTOMATYCZNA AKTUALIZACJA (po update Discorda):
  - watcher.js startuje z Windowsem (ukryty) i sprawdza co ~10 s, czy Discord jest spatchowany.
    Po update patch nakladany jest sam, zadziala po NASTEPNYM starcie Discorda.
  - Auto-restart po patchu: utworz %APPDATA%\blxstncord\updater.json z trescia {"restartDiscord": true}
  - Log watchera: %APPDATA%\blxstncord\updater.log

SPOTIFY CONTROLS: korzysta z systemowych kontrolek multimediow Windows (lokalny, ukryty media.ps1, bez sieci).
  Spotify musi dzialac jako aplikacja desktopowa.

LOG: show-log.bat (co sie zaladowalo / co nie)
USUNIECIE: uninstall.bat

Uwaga: install.bat nadpisuje pluginy dostarczone w paczce. Twoje wlasne pliki w folderze plugins nie sa ruszane.
