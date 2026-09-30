// Meetkern-tests: gesimuleerde runs vs. de waarheid uit de simulator. Draai met: node tests/engine.test.js
const E = require("../engine.js");
let fails = 0;
const check = (ok, msg) => { console.log((ok ? "✓ " : "✗ ") + msg); if (!ok) fails++; };

// 1. acceleratie: max afwijking over meerdere seeds (ms)
for (const [car, hz, imu, lim] of [["screamer", 10, true, 60], ["screamer", 1, true, 150], ["screamer", 10, false, 120], ["hyper", 25, true, 60]]) {
  let worst = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const sim = E.simulate(car, { hz, imu, stopV: 205 / 3.6, seed: seed * 17 + hz, gpsNoise: hz >= 10 ? 0.05 : 0.15 });
    const res = E.analyze(sim, { standing: true, unit: "kmh" });
    const s = res.ok && res.speedSplits.find((x) => x.from === 0 && x.to === 100);
    const truth = (sim.truth.cross[100] - sim.truth.t0) / 1000;
    worst = Math.max(worst, s ? Math.abs(s.time - truth) * 1000 : 1e9);
  }
  check(worst <= lim, `0-100 ${car} ${hz} Hz ${imu ? "+IMU" : "GPS"}: max ${worst.toFixed(0)} ms (grens ${lim})`);
}

// 2. rolling 100-200
{
  const sim = E.simulate("screamer", { hz: 10, stopV: 210 / 3.6, seed: 5, rollFrom: 60 / 3.6 });
  const res = E.analyze(sim, { standing: false, unit: "kmh" });
  const s = res.speedSplits.find((x) => x.from === 100 && x.to === 200), truth = (sim.truth.cross[200] - sim.truth.cross[100]) / 1000;
  check(s && Math.abs(s.time - truth) < 0.06, `100-200 rolling: ${s && s.time} vs ${truth.toFixed(3)}`);
}

// 3. remtest 100-0
for (const [hz, imu, limT, limD] of [[10, true, 0.08, 1.0], [25, true, 0.06, 0.8], [1, true, 0.25, 3.0]]) {
  let wt = 0, wd = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const sim = E.simulate("screamer", { hz, imu, stopV: 112 / 3.6, brakeG: 1.05, brakeFrom: 100, seed: seed * 7 + hz, gpsNoise: hz >= 10 ? 0.05 : 0.15 });
    const res = E.analyze(sim, { standing: false, unit: "kmh", brakeFrom: 100 });
    const tT = (sim.truth.brakeStop - sim.truth.brakeCross) / 1000, tD = sim.truth.brakeStopD - sim.truth.brakeCrossD;
    if (!res.brake) { wt = 99; continue; }
    wt = Math.max(wt, Math.abs(res.brake.time - tT)); wd = Math.max(wd, Math.abs(res.brake.dist - tD));
  }
  check(wt <= limT && wd <= limD, `100-0 remmen ${hz} Hz: tijd max ${(wt * 1000).toFixed(0)} ms, afstand max ${wd.toFixed(2)} m`);
}

// 4. carModel/predict: fabriekstijden binnen marge
for (const [n, c, ref, tol] of [["C63 S", { hp: 510, kg: 1725, drive: "rwd", gearbox: "auto", vmax: 290 }, 4.0, 0.45], ["911 TS", { hp: 650, kg: 1640, drive: "awd", gearbox: "dct", vmax: 330 }, 2.7, 0.3]]) {
  const t = E.predict(E.carModel(c), { stopV: 105 / 3.6 }), p = (t.cross[100] - t.t0) / 1000;
  check(Math.abs(p - ref) <= tol, `voorspelling ${n}: ${p.toFixed(2)} s (fabriek ${ref})`);
}
// 5. helling: vlak = onbekend of ~0, 3% bergop wordt herkend bij een lange run
{
  const flat = E.analyze(E.simulate("screamer", { hz: 10, stopV: 205 / 3.6, seed: 11 }), { standing: true, unit: "kmh" });
  check(flat.slope == null || Math.abs(flat.slope) < 0.8, `vlakke weg: helling ${flat.slope}`);
  const up = E.analyze(E.simulate("screamer", { hz: 10, stopV: 205 / 3.6, seed: 12, altSlope: 3 }), { standing: true, unit: "kmh" });
  check(up.slope != null && Math.abs(up.slope - 3) < 0.8, `3% bergop: helling ${up.slope}`);
  const br = E.analyze(E.simulate("screamer", { hz: 1, stopV: 112 / 3.6, brakeG: 1.05, brakeFrom: 100, seed: 13, gpsNoise: 0.15 }), { standing: false, unit: "kmh", brakeFrom: 100 });
  check(br.slope == null || Math.abs(br.slope) < 1, `korte remrun: helling ${br.slope} (onbekend is goed)`);
}
if (fails) { console.log(`\n${fails} test(s) mislukt`); process.exit(1); } else console.log("\nAlle meetkern-tests geslaagd");
