# ScreamTime in de Google Play Store

De app is een PWA. Google Play accepteert die als "Trusted Web Activity" (TWA): een echte Android-app die de website volledig scherm opent. Updates blijven gewoon via GitHub lopen; de Play-app hoeft alleen opnieuw als icoon/naam wijzigen.

## 1. Account (eenmalig)
1. Maak een ontwikkelaarsaccount op https://play.google.com/console (eenmalig $25, identiteitscontrole).
2. Nieuwe apps van persoonlijke accounts moeten eerst **14 dagen met minimaal 12 testers** in een gesloten test. Vraag vrienden (met Android) om mee te testen.

## 2. Android-pakket maken (± 10 minuten)
1. Ga naar https://www.pwabuilder.com en vul in: `https://turbonicoo.github.io/screamtime/`
2. Kies **Package for stores → Android → Google Play**.
   - Package ID: `io.github.turbonicoo.screamtime`
   - App name: `ScreamTime by Street Screamer`, launcher name: `ScreamTime`
   - Status bar / navigatiekleur: `#0a0712`
3. Download het pakket. Je krijgt een `.aab` (voor Play) en een **signing key**. Bewaar de key + wachtwoorden goed: kwijt = nooit meer updaten.
4. In de download staat `assetlinks.json`. Stuur mij die (of de SHA-256 fingerprint). Ik zet hem op `/.well-known/assetlinks.json`, zodat de app zonder adresbalk opent.
   - Let op: bij "Play App Signing" komt er een tweede fingerprint bij (Play Console → Setup → App signing). Beide moeten in `assetlinks.json`.

## 3. Winkelvermelding
- **Korte beschrijving (max 80):** `0–500 km/u timer met GPS + sensorfusie, remtest, camera-overlay en ranglijst.`
- **Volledige beschrijving:**

  > Meet de acceleratie van je auto zoals de pro's. ScreamTime combineert GPS met de bewegingssensor van je telefoon voor tijden tot op honderdsten — van 0–100 tot 0–500 km/u.
  >
  > • Snelheid: 0–50 tot 0–500, rolling 60–100, 100–200, 200–300 of je eigen traject
  > • Afstand: 60 ft, ⅛ mijl, ¼ mijl, ½ mijl, 1 km, 1 mijl — met trap speed
  > • Remtest 100–0 met remweg en vertraging
  > • Startlampen, strenge stilstand-controle en automatische start
  > • Camera-modus: film je run met live teller, G-kracht, splits en vermogen in beeld
  > • Tips per auto: wat is haalbaar met jouw pk, gewicht, aandrijving en banden?
  > • Runs vergelijken, weercorrectie (SAE J1349), records en historie
  > • Online ranglijst per vermogensklasse, topsnelheden en vrienden
  > • 10–25 Hz GPS-ontvangers via USB-C (u-blox) of Bluetooth (RaceBox) voor verified-tijden
  > • 15 tellerstijlen en je eigen logo
  >
  > Meet alleen op een afgesloten terrein of circuit.

- **Categorie:** Auto's en voertuigen · **Tags:** prestaties, GPS, timer
- **Afbeeldingen:** `icon-512.png`, `store/feature-graphic.png`, screenshots `store/s1…s6.png` (1080×1920)
- **Privacybeleid-URL:** https://turbonicoo.github.io/screamtime/privacy.html
- **Contact-e-mail:** verplicht; dit is ook het contactadres uit de privacyverklaring.

## 4. Formulier "Gegevensveiligheid" (Data safety)
| Vraag | Antwoord |
|---|---|
| Verzamelt of deelt de app gegevens? | Ja, verzamelt |
| Versleuteld tijdens verzending? | Ja (HTTPS) |
| Kan de gebruiker verwijdering aanvragen? | Ja, in de app (Account verwijderen) |
| Persoonlijke info → e-mailadres | Verzameld, verplicht voor account, voor accountbeheer |
| Persoonlijke info → gebruikers-ID (username) | Verzameld, voor app-functionaliteit (ranglijst) |
| Locatie → bij benadering | Verzameld, niet opgeslagen, voor weercorrectie (± 1 km naar Open-Meteo) |
| Locatie → exact | Niet verzameld (blijft op het toestel) |
| App-activiteit → andere door gebruiker gemaakte content | Gedeelde runs (tijden, auto, snelheidscurve), voor app-functionaliteit |
| App-info en prestaties → crashlogs | Verzameld, voor analyse/foutoplossing |
| Foto's/video's, audio | Niet verzameld (blijft op het toestel) |
| Gedeeld met derden | Nee (Supabase en Open-Meteo zijn verwerkers) |

## 5. Overige formulieren
- **Contentclassificatie:** geen geweld/gokken; de app toont snelheidsmetingen → meestal PEGI 3 / "Iedereen".
- **Doelgroep:** 18+ (of 16+) — geen kinderen.
- **Advertenties:** nee.

## Wat Google soms vraagt
Apps rond hoge snelheden worden kritisch bekeken. De app toont daarom bij eerste gebruik een veiligheidsakkoord, heeft voorwaarden met "alleen op afgesloten terrein", en de beschrijving zegt dat ook. Houd screenshots en tekst in die lijn.
