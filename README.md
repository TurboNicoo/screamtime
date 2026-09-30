# ScreamTime by Street Screamer

0–500 km/u acceleratietimer in Street Screamer-stijl (Dragy/Launchly-achtig), als installeerbare PWA.

- `engine.js` — meetkern: GPS + IMU-fusie, starttijd-detectie, splits, simulator
- `sources.js` — telefoon-GPS/IMU, u-blox via WebUSB, RaceBox/NMEA via Web Bluetooth, demo
- `app.js` — UI, meet-statemachine, gauges, camera-overlay met opname, resultaten, garage
- `online.js` + `config.js` — account, ranglijst, vrienden (Supabase); `supabase/schema.sql` = volledige database (idempotent)
- `tests/` — meetkern-tests en release-controles; draaien automatisch via `.github/workflows/deploy.yml` vóór elke publicatie
- `privacy.html`, `voorwaarden.html` — juridische pagina's; `store/` — Play Store-materiaal + stappenplan; `docs/MEETPROTOCOL.md`
- Publiceren: push naar `main` → GitHub Actions test → pas daarna live op GitHub Pages.
