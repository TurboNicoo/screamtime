# ScreamTime by Street Screamer

0–500 km/u acceleratietimer in Street Screamer-stijl (Dragy/Launchly-achtig), als installeerbare PWA.

- `engine.js` — meetkern: GPS + IMU-fusie, starttijd-detectie, splits, simulator
- `sources.js` — telefoon-GPS/IMU, u-blox via WebUSB, RaceBox/NMEA via Web Bluetooth, demo
- `app.js` — UI, meet-statemachine, gauges, camera-overlay met opname, resultaten, garage
- Geen build-stap: GitHub Pages serveert direct vanaf `main`.
