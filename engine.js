/* Screamer Launch — meet-kern.
 * Puur rekenwerk (geen DOM): analyse van een opgenomen run (GPS-fixes + IMU-samples)
 * en een fysieke auto-simulator voor demo en tests. Werkt in de browser (window.Engine)
 * en in Node (module.exports).
 *
 * Tijd is overal in milliseconden op de performance.now()-klok, snelheid in m/s.
 */
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else root.Engine = m;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const G = 9.80665;
  const KMH = 1 / 3.6;
  const MPH = 0.44704;

  // Snelheidstrajecten die automatisch uit elke run worden gehaald (in de gekozen eenheid).
  const SPEED_PAIRS = {
    kmh: [[0, 50], [0, 60], [0, 100], [0, 120], [0, 150], [0, 200], [0, 250], [0, 300], [0, 350], [0, 400], [0, 450], [0, 500],
      [60, 100], [80, 120], [100, 150], [100, 200], [150, 250], [200, 300], [100, 300], [300, 400], [400, 500]],
    mph: [[0, 30], [0, 60], [0, 100], [0, 130], [0, 150], [0, 200], [0, 250], [0, 300],
      [30, 70], [60, 130], [100, 150], [150, 200], [200, 250], [250, 300]],
  };

  const DISTANCES = [
    { id: "60ft", m: 18.288, label: "60 ft" },
    { id: "100m", m: 100, label: "100 m" },
    { id: "1/8", m: 201.168, label: "⅛ mijl" },
    { id: "1000ft", m: 304.8, label: "1000 ft" },
    { id: "1/4", m: 402.336, label: "¼ mijl" },
    { id: "1/2", m: 804.672, label: "½ mijl" },
    { id: "1km", m: 1000, label: "1 km" },
    { id: "1mi", m: 1609.344, label: "1 mijl" },
  ];

  const ROLLOUT_M = 0.3048; // 1 ft, zoals op de dragstrip

  // ---------- helpers ----------
  function haversine(a, b) {
    const R = 6371008.8, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function bsearch(xs, x) { // grootste i met xs[i] <= x
    let lo = 0, hi = xs.length - 1;
    if (x <= xs[0]) return 0;
    if (x >= xs[hi]) return hi;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
    return lo;
  }

  function linInterp(xs, ys, x) {
    const n = xs.length;
    if (!n) return 0;
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    const i = bsearch(xs, x), f = (x - xs[i]) / (xs[i + 1] - xs[i]);
    return ys[i] + f * (ys[i + 1] - ys[i]);
  }

  // Monotone kubische interpolatie (Fritsch–Carlson): geen overshoot tussen GPS-fixes.
  function pchip(x, y) {
    const n = x.length;
    if (n === 1) return () => y[0];
    const h = [], d = [];
    for (let i = 0; i < n - 1; i++) { h[i] = x[i + 1] - x[i]; d[i] = (y[i + 1] - y[i]) / h[i]; }
    const m = new Array(n);
    if (n === 2) { m[0] = m[1] = d[0]; } else {
      for (let i = 1; i < n - 1; i++) {
        if (d[i - 1] * d[i] <= 0) m[i] = 0;
        else { const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1]; m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]); }
      }
      const end = (h0, h1, d0, d1) => {
        let s = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
        if (Math.sign(s) !== Math.sign(d0)) s = 0;
        else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(s) > Math.abs(3 * d0)) s = 3 * d0;
        return s;
      };
      m[0] = end(h[0], h[1], d[0], d[1]);
      m[n - 1] = end(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
    }
    return function (t) {
      if (t <= x[0]) return y[0];
      if (t >= x[n - 1]) return y[n - 1];
      const i = bsearch(x, t), hh = h[i], s = (t - x[i]) / hh, s2 = s * s, s3 = s2 * s;
      return (2 * s3 - 3 * s2 + 1) * y[i] + (s3 - 2 * s2 + s) * hh * m[i] + (-2 * s3 + 3 * s2) * y[i + 1] + (s3 - s2) * hh * m[i + 1];
    };
  }

  function solve(A, b) { // Gauss met pivot, klein stelsel
    const n = b.length, M = A.map((r, i) => r.concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-9) return null;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((r, i) => r[n] / r[i]);
  }

  // ---------- voorbewerking ----------
  function prepGps(raw) {
    const g = raw.slice().filter((f) => f && isFinite(f.t)).sort((a, b) => a.t - b.t);
    const out = [];
    for (const f of g) {
      if (out.length && f.t - out[out.length - 1].t < 1) continue;
      let v = typeof f.v === "number" && isFinite(f.v) && f.v >= 0 ? f.v : null;
      if (v === null && out.length && f.lat != null) {
        const p = out[out.length - 1];
        if (p.lat != null) v = haversine(p, f) / ((f.t - p.t) / 1000);
      }
      if (v === null) continue;
      out.push({ t: f.t, v, lat: f.lat, lon: f.lon, alt: f.alt, acc: f.acc });
    }
    return out;
  }

  function prepImu(raw) {
    if (!raw || raw.length < 30) return null;
    const s = raw.slice().filter((a) => isFinite(a.x) && isFinite(a.y) && isFinite(a.z)).sort((a, b) => a.t - b.t);
    if (s.length < 30) return null;
    const lin = s[0].lin !== false;
    let gx = 0, gy = 0, gz = 0;
    if (!lin) { // zwaartekracht = gemiddelde van de eerste 0,5 s (auto staat dan stil of rijdt constant)
      let n = 0;
      for (const a of s) { if (a.t - s[0].t > 500) break; gx += a.x; gy += a.y; gz += a.z; n++; }
      gx /= n; gy /= n; gz /= n;
    }
    return s.map((a) => ({ t: a.t, x: a.x - gx, y: a.y - gy, z: a.z - gz }));
  }

  function smoothMag(imu, winMs) {
    const out = new Array(imu.length);
    let j = 0, sx = 0, sy = 0, sz = 0;
    for (let i = 0; i < imu.length; i++) {
      sx += imu[i].x; sy += imu[i].y; sz += imu[i].z;
      while (imu[i].t - imu[j].t > winMs) { sx -= imu[j].x; sy -= imu[j].y; sz -= imu[j].z; j++; }
      const n = i - j + 1;
      out[i] = Math.hypot(sx / n, sy / n, sz / n);
    }
    return out;
  }

  function meanVec(imu, t1, t2) {
    let x = 0, y = 0, z = 0, n = 0;
    for (const a of imu) { if (a.t < t1) continue; if (a.t > t2) break; x += a.x; y += a.y; z += a.z; n++; }
    return n ? { x: x / n, y: y / n, z: z / n, n } : null;
  }

  // ---------- analyse ----------
  /**
   * @param raw  { gps:[{t,v,lat,lon,alt,acc}], imu:[{t,x,y,z,lin}] }
   * @param opts { standing:bool, rollout:bool, unit:'kmh'|'mph' }
   */
  function analyze(raw, opts) {
    opts = Object.assign({ standing: true, rollout: false, unit: "kmh" }, opts || {});
    const gps = prepGps(raw.gps || []);
    if (gps.length < 2) return { ok: false, reason: "Te weinig GPS-data" };
    const imu = prepImu(raw.imu);
    const unitF = opts.unit === "mph" ? MPH : KMH;
    const MOVE = 1.0; // m/s — boven deze snelheid rijdt de auto echt

    // --- 1. starttijd bepalen ---
    let t0 = null, t0Method = "rolling";
    let firstMove = gps.findIndex((f) => f.v > MOVE);
    if (opts.standing) {
      if (firstMove < 0) return { ok: false, reason: "Geen vertrek gedetecteerd" };
      // stilstaan vóór de start is vereist
      if (firstMove === 0) return { ok: false, reason: "Auto stond niet stil bij de start" };
      const fm = gps[firstMove];
      // laatste fix waarop de auto écht nog stilstond
      let still = firstMove - 1;
      while (still > 0 && gps[still].v > 0.35) still--;
      const prevStill = gps[still];
      // GPS-schatting: lijn door de eerste rijdende fixes (tot ~4 m/s) terug-extrapoleren naar v = 0
      const pts = [];
      for (let k = still + 1; k < gps.length && pts.length < 8; k++) {
        if (gps[k].v > 0.35) pts.push(gps[k]);
        if (gps[k].v > 4 && pts.length >= 2) break;
      }
      let tGps = fm.t - (fm.t - prevStill.t) / 2;
      if (pts.length >= 2) {
        const n = pts.length, mt = pts.reduce((s, f) => s + f.t, 0) / n, mv = pts.reduce((s, f) => s + f.v, 0) / n;
        let sxy = 0, sxx = 0;
        for (const f of pts) { sxy += (f.t - mt) * (f.v - mv); sxx += (f.t - mt) ** 2; }
        const a = sxx > 0 ? sxy / sxx : 0;
        if (a > 0) tGps = mt - mv / a;
      }
      tGps = Math.max(prevStill.t, Math.min(pts[0] ? pts[0].t : fm.t, tGps));
      t0 = tGps; t0Method = "gps";

      if (imu) { // IMU-onset: de laatste 'rustig → actief'-overgang vóór de eerste rijdende fix
        const mag = smoothMag(imu, 60);
        const ON = 0.1 * G;
        let onset = -1;
        for (let i = 1; i < imu.length; i++) {
          if (imu[i].t > fm.t) break;
          if (imu[i].t < fm.t - 3500) continue;
          if (mag[i] >= ON && mag[i - 1] < ON) onset = i;
          if (mag[i] < ON * 0.6 && onset >= 0 && fm.t - imu[i].t > 150) onset = -1; // weer rustig → geen launch
        }
        if (onset >= 0) {
          const dir = meanVec(imu, imu[onset].t, imu[onset].t + 500);
          if (dir) {
            const L = Math.hypot(dir.x, dir.y, dir.z) || 1;
            const ux = dir.x / L, uy = dir.y / L, uz = dir.z / L;
            let i = onset;
            // terugwandelen tot de voorwaartse versnelling echt ~0 is
            while (i > 0) {
              const along = imu[i].x * ux + imu[i].y * uy + imu[i].z * uz;
              if (along < 0.03 * G) break;
              i--;
            }
            // naar voren tot de eerste sample die de drempel haalt (ruis-robuust)
            const tI = imu[Math.min(i + 1, imu.length - 1)].t;
            if (tI >= prevStill.t - 400 && tI <= fm.t) { t0 = tI; t0Method = "imu"; }
          }
        }
      }
    }

    const tStart = opts.standing ? t0 : gps[0].t;
    const anchorsT = [], anchorsV = [];
    if (opts.standing) { anchorsT.push(t0); anchorsV.push(0); }
    for (const f of gps) if (f.t > tStart + (opts.standing ? 1 : -1)) { anchorsT.push(f.t); anchorsV.push(f.v); }
    const tEnd = anchorsT[anchorsT.length - 1];
    if (anchorsT.length < 2 || tEnd - tStart < 200) return { ok: false, reason: "Run te kort" };

    // --- 2. snelheidsverloop: IMU-integratie gecorrigeerd op GPS, of PCHIP op GPS alleen ---
    let fusion = "gps";
    let imuLong = null; // {t[], a[]}
    if (imu) {
      const seg = imu.filter((a) => a.t >= tStart - 50 && a.t <= tEnd + 50);
      const cover = seg.length ? (Math.min(tEnd, seg[seg.length - 1].t) - Math.max(tStart, seg[0].t)) / (tEnd - tStart) : 0;
      if (seg.length > 20 && cover > 0.9) {
        // regressie: GPS dv/dt ≈ a·w + c over de intervallen tussen fixes
        const rows = [], rhs = [];
        for (let k = 0; k < anchorsT.length - 1; k++) {
          const mv = meanVec(seg, anchorsT[k], anchorsT[k + 1]);
          if (!mv || mv.n < 3) continue;
          rows.push([mv.x, mv.y, mv.z, 1]);
          rhs.push((anchorsV[k + 1] - anchorsV[k]) / ((anchorsT[k + 1] - anchorsT[k]) / 1000));
        }
        let w = null, c = 0;
        if (rows.length >= 8) {
          const AtA = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => rows.reduce((s, r) => s + r[i] * r[j], 0)));
          const Atb = [0, 1, 2, 3].map((i) => rows.reduce((s, r, k) => s + r[i] * rhs[k], 0));
          const sol = solve(AtA, Atb);
          if (sol) {
            const mean = rhs.reduce((s, x) => s + x, 0) / rhs.length;
            let ssr = 0, sst = 0;
            rows.forEach((r, k) => { const p = r[0] * sol[0] + r[1] * sol[1] + r[2] * sol[2] + sol[3]; ssr += (rhs[k] - p) ** 2; sst += (rhs[k] - mean) ** 2; });
            if (sst > 0 && 1 - ssr / sst > 0.6) { w = sol.slice(0, 3); c = sol[3]; }
          }
        }
        if (!w) { // te weinig intervallen: richting = gemiddelde versnelling in de eerste 0,6 s
          const mv = meanVec(seg, tStart, tStart + 600);
          if (mv) {
            const L = Math.hypot(mv.x, mv.y, mv.z);
            if (L > 0.05 * G) w = [mv.x / L, mv.y / L, mv.z / L];
          }
        }
        if (w) {
          const T = [], A = [];
          for (const a of seg) {
            T.push(a.t);
            A.push(opts.standing && a.t < t0 ? 0 : a.x * w[0] + a.y * w[1] + a.z * w[2] + c);
          }
          // integreer
          const Vi = [0];
          let v = opts.standing ? 0 : anchorsV[0];
          for (let i = 1; i < T.length; i++) {
            const dt = (T[i] - T[i - 1]) / 1000;
            if (!(opts.standing && T[i] <= t0)) v += 0.5 * (A[i] + A[i - 1]) * dt;
            Vi.push(v);
          }
          if (!opts.standing) { const off = anchorsV[0] - linInterp(T, Vi, anchorsT[0]); for (let i = 0; i < Vi.length; i++) Vi[i] += off; }
          // controle: voorspelt de IMU de snelheidswinst per interval redelijk?
          const E = anchorsT.map((t, k) => anchorsV[k] - linInterp(T, Vi, t));
          let bad = 0, tot = 0;
          for (let k = 0; k < anchorsT.length - 1; k++) {
            const dvG = anchorsV[k + 1] - anchorsV[k];
            const dvI = linInterp(T, Vi, anchorsT[k + 1]) - linInterp(T, Vi, anchorsT[k]);
            if (Math.abs(dvG) > 0.5) { tot++; if (Math.abs(dvI - dvG) > Math.max(1.0, Math.abs(dvG) * 0.5)) bad++; }
          }
          if (tot === 0 || bad / tot < 0.3) {
            fusion = "imu";
            imuLong = { T, A, Vi, E };
          }
        }
      }
    }

    // raster van 5 ms
    const STEP = 5;
    const TT = [], VV = [];
    const vGps = pchip(anchorsT, anchorsV);
    for (let t = tStart; t <= tEnd + 0.001; t += STEP) {
      let v;
      if (imuLong) v = linInterp(imuLong.T, imuLong.Vi, t) + linInterp(anchorsT, imuLong.E, t);
      else v = vGps(t);
      TT.push(t); VV.push(Math.max(0, v));
    }
    if (opts.standing) VV[0] = 0;
    const DD = [0];
    for (let i = 1; i < TT.length; i++) DD.push(DD[i - 1] + 0.5 * (VV[i] + VV[i - 1]) * (TT[i] - TT[i - 1]) / 1000);

    const crossAt = (arr, S, from = 0) => {
      for (let i = Math.max(1, from); i < arr.length; i++) {
        if (arr[i - 1] < S && arr[i] >= S) {
          const f = (S - arr[i - 1]) / (arr[i] - arr[i - 1] || 1);
          return { t: TT[i - 1] + f * (TT[i] - TT[i - 1]), i };
        }
      }
      return null;
    };

    // referentietijd: t0 of na 1 ft rollout
    let tRef = tStart, rolloutMs = 0;
    if (opts.standing && opts.rollout) {
      const r = crossAt(DD, ROLLOUT_M);
      if (r) { rolloutMs = r.t - t0; tRef = r.t; }
    }
    const distAt = (t) => linInterp(TT, DD, t);
    const speedAt = (t) => linInterp(TT, VV, t);

    // --- 3. splits ---
    const speedSplits = [];
    const pairs = (SPEED_PAIRS[opts.unit] || SPEED_PAIRS.kmh).slice();
    for (const p of opts.extraPairs || []) if (!pairs.some((q) => q[0] === p[0] && q[1] === p[1])) pairs.push(p);
    for (const [from, to] of pairs) {
      const Sto = to * unitF;
      if (from === 0) {
        if (!opts.standing) continue;
        const c = crossAt(VV, Sto);
        if (c) speedSplits.push({ from, to, time: (c.t - tRef) / 1000, dist: distAt(c.t) - distAt(tRef), tEnd: c.t });
      } else {
        const a = crossAt(VV, from * unitF);
        if (!a) continue;
        const b = crossAt(VV, Sto, a.i);
        if (b) speedSplits.push({ from, to, time: (b.t - a.t) / 1000, dist: distAt(b.t) - distAt(a.t), tEnd: b.t });
      }
    }
    const distSplits = [];
    if (opts.standing) {
      for (const D of DISTANCES) {
        const c = crossAt(DD, D.m + (tRef > tStart ? distAt(tRef) : 0));
        if (c) distSplits.push({ id: D.id, label: D.label, m: D.m, time: (c.t - tRef) / 1000, trap: speedAt(c.t), tEnd: c.t });
      }
    }

    // --- 4. extra's ---
    let peakG = 0;
    if (imuLong) {
      const { T, A } = imuLong;
      let j = 0, s = 0;
      for (let i = 0; i < T.length; i++) {
        s += A[i];
        while (T[i] - T[j] > 150) { s -= A[j]; j++; }
        if (T[i] >= tStart) peakG = Math.max(peakG, s / (i - j + 1) / G);
      }
    } else {
      const W = 40; // 200 ms
      for (let i = W; i < VV.length; i++) peakG = Math.max(peakG, (VV[i] - VV[i - W]) / ((TT[i] - TT[i - W]) / 1000) / G);
    }
    let peakV = 0;
    for (const v of VV) peakV = Math.max(peakV, v);

    const nearestFix = (t) => { let best = null; for (const f of gps) if (!best || Math.abs(f.t - t) < Math.abs(best.t - t)) best = f; return best; };
    let slope = null;
    const lastSplitT = Math.max(...speedSplits.map((s) => s.tEnd), ...distSplits.map((s) => s.tEnd), tStart);
    const fa = nearestFix(tStart), fb = nearestFix(lastSplitT);
    const dRun = distAt(lastSplitT) - distAt(tStart);
    if (fa && fb && fa.alt != null && fb.alt != null && dRun > 30) slope = ((fb.alt - fa.alt) / dRun) * 100;

    const fixesInRun = gps.filter((f) => f.t >= tStart && f.t <= tEnd).length;
    const hz = fixesInRun > 1 ? (fixesInRun - 1) / ((tEnd - tStart) / 1000) : 0;
    const accs = gps.filter((f) => f.acc != null).map((f) => f.acc);
    const meanAcc = accs.length ? accs.reduce((s, x) => s + x, 0) / accs.length : null;

    // trace voor grafiek (max ~320 punten), tijd in s t.o.v. tRef
    const trace = [];
    const every = Math.max(1, Math.ceil(TT.length / 320));
    for (let i = 0; i < TT.length; i += every) trace.push([+((TT[i] - tRef) / 1000).toFixed(3), +VV[i].toFixed(2), +DD[i].toFixed(1)]);
    const li = TT.length - 1;
    if ((li % every) !== 0) trace.push([+((TT[li] - tRef) / 1000).toFixed(3), +VV[li].toFixed(2), +DD[li].toFixed(1)]);

    speedSplits.forEach((s) => { s.time = +s.time.toFixed(3); s.dist = +s.dist.toFixed(1); delete s.tEnd; });
    distSplits.forEach((s) => { s.time = +s.time.toFixed(3); s.trap = +s.trap.toFixed(2); delete s.tEnd; });

    return {
      ok: true, standing: opts.standing, unit: opts.unit, t0Method, fusion, rolloutMs: Math.round(rolloutMs),
      speedSplits, distSplits, peakV: +peakV.toFixed(2), peakG: +peakG.toFixed(2),
      slope: slope == null ? null : +slope.toFixed(2), hz: +hz.toFixed(1), meanAcc: meanAcc == null ? null : +meanAcc.toFixed(1),
      duration: +((tEnd - tRef) / 1000).toFixed(2), trace,
    };
  }

  // ---------- simulator ----------
  const SIM_CARS = {
    screamer: { name: "Street Screamer · C63 S 840 pk", P: 840 * 735.5 * 0.86, m: 1950, mu: 1.3, drive: 0.66, CdA: 0.74, crr: 0.012, vmax: 322 / 3.6,
      shifts: [64, 104, 146, 190, 236, 280], shiftT: 0.11 },
    super: { name: "Supercar · 800 pk", P: 800 * 735.5 * 0.88, m: 1480, mu: 1.3, drive: 0.75, CdA: 0.62, crr: 0.012, vmax: 340 / 3.6,
      shifts: [85, 135, 180, 225, 270, 310], shiftT: 0.06 },
    hyper: { name: "Hypercar · 1600 pk AWD", P: 1600 * 735.5 * 0.9, m: 1420, mu: 1.35, drive: 1.0, CdA: 0.5, crr: 0.011, vmax: 531 / 3.6,
      shifts: [92, 146, 200, 262, 330, 410], shiftT: 0.04 },
  };

  function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296); }; }
  function gauss(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }

  /**
   * Simuleer een run. Levert dezelfde ruwe data die de echte bronnen leveren + de waarheid.
   * opts: { hz, imuHz, idle(s), stopV(m/s), stopD(m), rollFrom(m/s) , seed, gpsNoise, imuNoise, gpsLatency(ms) }
   */
  function simulate(carId, opts) {
    const car = typeof carId === "object" && carId ? carId : SIM_CARS[carId] || SIM_CARS.screamer;
    opts = Object.assign({ hz: 10, imuHz: 60, idle: 2.5, stopV: 110 * KMH, stopD: 0, rollFrom: 0, seed: 7, gpsNoise: 0.08, imuNoise: 0.25, imu: true, altSlope: 0 }, opts || {});
    const r = rng(opts.seed);
    const dt = 0.0005;
    // willekeurige telefoonoriëntatie
    const th = r() * Math.PI * 2, ph = (r() - 0.5) * 1.2;
    const fwd = { x: Math.cos(th) * Math.cos(ph), y: Math.sin(th) * Math.cos(ph), z: Math.sin(ph) };
    const up = (() => { const z = { x: 0, y: 0, z: 1 }; const d = fwd.x * z.x + fwd.y * z.y + fwd.z * z.z; const u = { x: z.x - d * fwd.x, y: z.y - d * fwd.y, z: z.z - d * fwd.z }; const L = Math.hypot(u.x, u.y, u.z); return { x: u.x / L, y: u.y / L, z: u.z / L }; })();

    let t = 0, v = opts.rollFrom, d = 0, phase = opts.rollFrom > 0 ? "cruise" : "idle";
    let shiftUntil = -1, gear = 0, launched = null, lifted = null;
    const truth = { t0: null, cross: {}, dist: {} };
    const gps = [], imu = [];
    const gpsDt = 1 / opts.hz, imuDt = 1 / opts.imuHz;
    let nextGps = r() * gpsDt, nextImu = 0;
    const lat0 = 52.1, lon0 = 5.1, head = r() * Math.PI * 2;
    const rho = 1.2;
    const stopT = 200;
    while (t < stopT) {
      let a = 0;
      if (phase === "idle") { if (t >= opts.idle) { phase = "go"; launched = t; truth.t0 = t * 1000; } }
      else if (phase === "cruise") { if (t >= opts.idle) { phase = "go"; launched = t; } else a = 0; }
      if (phase === "go") {
        const drag = 0.5 * rho * car.CdA * v * v + car.crr * car.m * G;
        const trac = car.mu * car.m * G * car.drive;
        let F = Math.min(trac, car.P / Math.max(v, 0.5));
        // simpele launch-opbouw (koppeling/traction control)
        F *= Math.min(1, (car.launch0 != null ? car.launch0 : 0.55) + (t - launched) * 3);
        if (gear < car.shifts.length && v * 3.6 >= car.shifts[gear]) { gear++; shiftUntil = t + car.shiftT; }
        if (t < shiftUntil) F *= 0.25;
        if (v >= car.vmax) F = Math.min(F, drag);
        a = (F - drag) / car.m;
        if ((opts.stopV && v >= opts.stopV) || (opts.stopD && d >= opts.stopD) || v >= car.vmax * 0.997) { phase = "lift"; lifted = t; }
      } else if (phase === "lift") {
        a = -0.5 * G;
        if (v <= 0 || t - lifted > 4) break;
      }
      const vPrev = v;
      v = Math.max(0, v + a * dt);
      d += 0.5 * (v + vPrev) * dt;
      t += dt;
      // waarheid: kruisingen per km/u en afstand
      const kPrev = Math.floor(vPrev * 3.6), kNow = Math.floor(v * 3.6);
      if (phase !== "lift" && kNow > kPrev) for (let k = kPrev + 1; k <= kNow; k++) if (!(k in truth.cross)) truth.cross[k] = t * 1000;
      for (const D of DISTANCES) if (!(D.id in truth.dist) && d >= D.m && launched != null) truth.dist[D.id] = { t: t * 1000, v };

      if (opts.imu && t >= nextImu) {
        nextImu += imuDt;
        const vib = (0.08 + v / 100 * 0.1) * G;
        const n = () => gauss(r) * opts.imuNoise + Math.sin(t * 2 * Math.PI * 31) * vib * 0.3;
        imu.push({ t: t * 1000, x: fwd.x * a + n(), y: fwd.y * a + n(), z: fwd.z * a + up.z * 0 + n(), lin: true });
      }
      if (t >= nextGps) {
        nextGps += gpsDt * (1 + gauss(r) * 0.01);
        const lat = lat0 + (d * Math.cos(head)) / 111320, lon = lon0 + (d * Math.sin(head)) / (111320 * Math.cos(lat0 * Math.PI / 180));
        gps.push({ t: t * 1000, v: Math.max(0, v + gauss(r) * opts.gpsNoise), lat, lon, alt: 10 + d * opts.altSlope / 100 + gauss(r) * 0.4, acc: 3 + r() });
      }
    }
    if (opts.rollFrom > 0) truth.t0 = null;
    return { gps, imu, truth, car };
  }

  // Fysisch model van een echte auto op basis van de garage-gegevens.
  function carModel(c) {
    const drive = c.drive || "rwd", box = c.gearbox || "auto", tires = c.tires || "street";
    const hp = +c.hp || 300, kg = (+c.kg || 1600) + 80;
    const loss = { rwd: 0.86, awd: 0.8, fwd: 0.88 }[drive] || 0.85;
    const mu = { street: 1.15, semi: 1.35, drag: 1.7, winter: 0.8 }[tires] || 1.1;
    const df = { rwd: 0.73, awd: 1.0, fwd: 0.47 }[drive] || 0.62; // effectief gewicht op de aangedreven as bij het wegrijden
    const vmax = (+c.vmax || Math.min(420, 150 + hp * 0.22)) / 3.6;
    const shiftT = { dct: 0.06, auto: 0.13, manual: 0.32 }[box] || 0.13;
    const nG = box === "manual" ? 6 : 8;
    const shifts = []; for (let i = 1; i < nG; i++) shifts.push(vmax * 3.6 * Math.pow(i / nG, 0.8));
    // luchtweerstand afgeleid van topsnelheid: vermogen = weerstand bij vmax
    const P = hp * 735.5 * loss;
    // luchtweerstand: standaard sportauto (0,7 m²); lager als de opgegeven topsnelheid anders onhaalbaar is
    const cdaTop = (P - 0.012 * kg * G * vmax) / (0.5 * 1.2 * vmax ** 3) * 0.95;
    const CdA = Math.max(0.3, Math.min(0.7, cdaTop));
    return { name: c.name || "", P, m: kg, mu, drive: df, CdA, crr: 0.012, vmax: vmax * 1.01, shifts, shiftT, launch0: c.launch0 != null ? c.launch0 : 0.8 };
  }
  // Theoretische tijden (geen sensorruis). stop: {stopV (m/s)} of {stopD (m)}
  function predict(model, stop) {
    const sim = simulate(model, Object.assign({ hz: 1, imu: false, idle: 0.01, stopV: 0, stopD: 0, gpsNoise: 0 }, stop));
    return sim.truth;
  }

  return { carModel, predict, G, KMH, MPH, SPEED_PAIRS, DISTANCES, ROLLOUT_M, analyze, simulate, SIM_CARS, haversine, pchip, linInterp };
});
