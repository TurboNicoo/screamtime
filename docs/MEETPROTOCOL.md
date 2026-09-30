# Meetprotocol: ScreamTime vs. Dragy/RaceBox

Doel: aantonen hoe nauwkeurig ScreamTime in de praktijk is, zodat je die cijfers eerlijk kunt noemen.

## Voorbereiding
- **Locatie:** afgesloten terrein/circuit, vlak (< 0,5% helling), vrij zicht op de lucht, geen bomen of gebouwen langs de baan.
- **Apparatuur:** referentie (Dragy of RaceBox, 10–25 Hz) + telefoon met ScreamTime. Beide stevig vast, zo dicht mogelijk bij elkaar.
- **ScreamTime:** GPS-bron *Telefoon-GPS* voor serie A, *USB/RaceBox* voor serie B. 1 ft rollout: **zelfde instelling als de referentie** (Dragy: meestal aan voor ¼ mijl, uit voor 0–100).
- Noteer: temperatuur, bandenspanning, brandstof, of ESP/launch control aan stond.

## Series (per serie minimaal 10 geldige runs)
| Serie | ScreamTime-bron | Onderdelen |
|---|---|---|
| A | Telefoon-GPS + sensor | 0–100, 100–200, ¼ mijl, 100–0 remmen |
| B | 10–25 Hz ontvanger | idem |

Laat tussen runs de motor/remmen even afkoelen, zodat beide systemen dezelfde, realistische runs zien.

## Registreren
Per run één regel in een spreadsheet:

`datum | run | onderdeel | Dragy (s of m) | ScreamTime (s of m) | verschil | GPS Hz | helling | opmerking`

## Beoordelen
- **Gemiddelde afwijking** (systematisch: meet ScreamTime steeds iets sneller of trager?)
- **Spreiding** (standaarddeviatie van de verschillen)
- **Grootste afwijking**
- Doel (op basis van de simulaties): 0–100 binnen ± 0,05 s met telefoon + sensor, ± 0,03 s met ontvanger; remweg binnen ± 1 m.

Is er een systematische afwijking (bijv. altijd 0,04 s sneller), stuur dan de spreadsheet door: dan kan de startdetectie of rollout-correctie worden bijgesteld en daarna opnieuw getest.
