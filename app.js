/* Screamer Launch — app (UI, meet-statemachine, gauges, resultaten). */
(function () {
  "use strict";
  const VERSION = "1.3.1";
  const KEY = "screamerlaunch_v1";
  const E = window.Engine, SR = window.Sources;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const TAU = Math.PI * 2;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const icon = (id, cls = "i") => `<svg class="${cls}"><use href="#${id}"/></svg>`;

  // ================= state =================
  const DEFAULT = {
    v: 1,
    settings: { unit: "kmh", gauge: "screamer", source: "phone", simCar: "screamer", usbHz: 25, usbBaud: 38400, rollout: false, sound: true, vibe: true, wake: true, hudMirror: true },
    cars: [{ id: "ss", name: "Street Screamer", make: "Mercedes-AMG C63 S", year: "", hp: 840, nm: 1190, kg: 1950, drive: "rwd", gearbox: "auto", tires: "street", vmax: 320, factory0100: "", photo: "img/car-hood-purple.jpg", logo: "", gauge: "default", accent: "#ff2f78", notes: "" }],
    activeCar: "ss", mode: "speed", sel: { speed: "0-100", dist: "1/4" }, custom: [], runs: [], backupAt: 0,
  };
  function load() {
    try {
      const j = JSON.parse(localStorage.getItem(KEY));
      if (j && j.v === 1) { j.settings = Object.assign({}, DEFAULT.settings, j.settings); j.sel = Object.assign({}, DEFAULT.sel, j.sel); return Object.assign(JSON.parse(JSON.stringify(DEFAULT)), j); }
    } catch (e) { /* eerste start of kapotte opslag */ }
    return JSON.parse(JSON.stringify(DEFAULT));
  }
  let S = load();
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast("Opslaan mislukt — geheugen vol? Maak een back-up en verwijder oude runs."); } }

  const unit = () => S.settings.unit;
  const uf = () => (unit() === "mph" ? E.MPH : E.KMH);
  const uLbl = () => (unit() === "mph" ? "mph" : "km/u");
  const distFmt = (m) => (unit() === "mph" ? Math.round(m * 3.28084) + " ft" : Math.round(m) + " m");
  const activeCar = () => S.cars.find((c) => c.id === S.activeCar) || S.cars[0];

  const SPEED_CHIPS = {
    kmh: ["0-50", "0-100", "0-150", "0-200", "0-250", "0-300", "0-350", "0-400", "0-450", "0-500", "60-100", "80-120", "100-200", "200-300"],
    mph: ["0-30", "0-60", "0-100", "0-130", "0-150", "0-200", "0-250", "0-300", "30-70", "60-130", "100-150"],
  };
  const DIST_CHIPS = ["60ft", "1/8", "1000ft", "1/4", "1/2", "1km", "1mi"];
  const speedChips = () => SPEED_CHIPS[unit()].concat(S.custom.filter((c) => c.unit === unit()).map((c) => c.v));

  function curTarget() {
    if (S.mode === "speed") {
      if (!speedChips().includes(S.sel.speed)) S.sel.speed = unit() === "mph" ? "0-60" : "0-100";
      const [a, b] = S.sel.speed.split("-").map(Number);
      return { type: "speed", from: a, to: b, standing: a === 0, key: `S:${unit()}:${a}-${b}`, label: `${a}–${b} ${uLbl()}` };
    }
    const d = E.DISTANCES.find((x) => x.id === S.sel.dist) || E.DISTANCES[4];
    return { type: "dist", m: d.m, id: d.id, standing: true, key: "D:" + d.id, label: d.label };
  }

  // ================= kleine UI-helpers =================
  let toastT = null;
  function toast(msg, ms = 2600) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), ms); }
  function openSheet(html, onMount) {
    $("#sheetBody").innerHTML = html; $("#sheet").classList.add("open"); $("#scrim").classList.add("open");
    $("#sheet").scrollTop = 0;
    if (onMount) onMount($("#sheetBody"));
  }
  let sheetClose = null;
  function closeSheet() { $("#sheet").classList.remove("open"); $("#scrim").classList.remove("open"); if (sheetClose) { const f = sheetClose; sheetClose = null; f(); } }
  $("#scrim").addEventListener("click", closeSheet);

  // geluid
  let AC = null;
  function unlockAudio() { try { if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)(); if (AC.state === "suspended") AC.resume(); } catch (e) { AC = null; } }
  function beep(f, d = 0.14, type = "square", vol = 0.07, when = 0) {
    if (!S.settings.sound || !AC) return;
    const t = AC.currentTime + when, o = AC.createOscillator(), g = AC.createGain();
    o.type = type; o.frequency.value = f; g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g).connect(AC.destination); o.start(t); o.stop(t + d + 0.03);
  }
  const vibe = (p) => { if (S.settings.vibe && navigator.vibrate) navigator.vibrate(p); };

  // scherm aan
  let wakeLock = null;
  async function requestWake() { if (!S.settings.wake || !("wakeLock" in navigator) || wakeLock) return; try { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => { wakeLock = null; }); } catch (e) { /* niet toegestaan */ } }

  // ================= bronnen =================
  const RING = { gps: [], imu: [] };
  const TEL = { aGps: 0, latA: 0, lonG: 0, latG: 0, trail: [], hp: 0, kN: 0, nm: 0, peakHp: 0, trace: [] };
  const SRC = { cur: null, imu: null, status: {}, hzTimes: [], lastFix: null, prevFix: null, sats: null, acc: null, nofix: true, hz: 0, gLive: 0, grav: null };

  function stopSource() {
    if (SRC.cur) { try { SRC.cur.stop(); } catch (e) { /* al gestopt */ } }
    if (SRC.imu) SRC.imu.stop();
    SRC.cur = null; SRC.imu = null; SRC.status = {}; SRC.lastFix = null; SRC.prevFix = null; SRC.hzTimes = []; SRC.nofix = true; SRC.hz = 0;
    updateChip();
  }
  function startImu() { SRC.imu = new SR.PhoneImu(onImu); SRC.imu.start(); }
  async function startSource(interactive) {
    stopSource();
    const k = S.settings.source;
    try {
      if (k === "phone") { SRC.cur = new SR.PhoneGps(onFix, onSrcStatus); SRC.cur.start(); startImu(); }
      else if (k === "sim") { SRC.cur = new SR.SimSource(onFix, onSrcStatus, onImu, { car: S.settings.simCar, hz: 10 }); SRC.cur.start(); }
      else if (k === "usb") {
        const u = new SR.UsbGnss(onFix, onSrcStatus, { hz: S.settings.usbHz, baud: S.settings.usbBaud });
        SRC.cur = u; startImu();
        await u.start(!!interactive);
      } else if (k === "racebox" || k === "ble") {
        if (!interactive) { SRC.status = { needConnect: true }; updateChip(); return; }
        const b = new SR.BleGnss(onFix, onSrcStatus, { racebox: k === "racebox" });
        SRC.cur = b; startImu();
        await b.start();
      }
    } catch (e) {
      SRC.status = { needConnect: true, error: e && e.message ? e.message : String(e) };
      if (interactive && e && e.name !== "NotFoundError") toast(SRC.status.error, 4000);
    }
    updateChip();
  }
  function onSrcStatus(st) { SRC.status = Object.assign({}, SRC.status, st); if (st.connected) SRC.status.needConnect = false; if (st.error && st.connected === false) SRC.status.needConnect = true; if (st.error) toast(st.error, 3500); updateChip(); }

  function onFix(f) {
    if (f.nofix) { SRC.nofix = true; if (f.sats != null) SRC.sats = f.sats; updateChipSoon(); return; }
    if (f.v == null && SRC.lastFix && f.lat != null && SRC.lastFix.lat != null) f.v = E.haversine(SRC.lastFix, f) / Math.max(0.05, (f.t - SRC.lastFix.t) / 1000);
    if (f.v == null) f.v = 0;
    SRC.nofix = false; SRC.prevFix = SRC.lastFix; SRC.lastFix = f; SRC.acc = f.acc; if (f.sats != null) SRC.sats = f.sats;
    SRC.hzTimes.push(f.t); while (SRC.hzTimes.length && SRC.hzTimes[0] < f.t - 3000) SRC.hzTimes.shift();
    SRC.hz = SRC.hzTimes.length > 1 ? (SRC.hzTimes.length - 1) / ((SRC.hzTimes[SRC.hzTimes.length - 1] - SRC.hzTimes[0]) / 1000) : 0;
    if (SRC.prevFix && f.t > SRC.prevFix.t) { const a = (f.v - SRC.prevFix.v) / ((f.t - SRC.prevFix.t) / 1000); TEL.aGps += (Math.max(-15, Math.min(20, a)) - TEL.aGps) * (SRC.hz >= 5 ? 0.35 : 0.8); }
    RING.gps.push(f); while (RING.gps.length && RING.gps[0].t < f.t - 15000) RING.gps.shift();
    if (M.rec) M.rec.gps.push(f);
    measureFix(f);
    camWatch(f);
    updateChipSoon();
  }

  let gEma = 0;
  function onImu(a) {
    RING.imu.push(a); while (RING.imu.length && RING.imu[0].t < a.t - 6000) RING.imu.shift();
    if (M.rec) M.rec.imu.push(a);
    let x = a.x, y = a.y, z = a.z;
    if (!a.lin) { // zwaartekracht langzaam volgen
      if (!SRC.grav) SRC.grav = { x, y, z };
      const k = 0.01; SRC.grav.x += (x - SRC.grav.x) * k; SRC.grav.y += (y - SRC.grav.y) * k; SRC.grav.z += (z - SRC.grav.z) * k;
      if (M.state === "ready" && M.grav) { x -= M.grav.x; y -= M.grav.y; z -= M.grav.z; } else { x -= SRC.grav.x; y -= SRC.grav.y; z -= SRC.grav.z; }
    }
    const mag = Math.hypot(x, y, z);
    gEma += (mag - gEma) * 0.25;
    SRC.gLive += (mag / E.G - SRC.gLive) * 0.08;
    if (a.w && a.g) { // gierhoeksnelheid × snelheid = zijdelingse versnelling
      const gl = Math.hypot(a.g.x, a.g.y, a.g.z) || 1;
      const yaw = (a.w.x * a.g.x + a.w.y * a.g.y + a.w.z * a.g.z) / gl;
      const v = SRC.lastFix ? SRC.lastFix.v : 0;
      TEL.latA += (v * yaw - TEL.latA) * 0.15;
    }
    measureImu(a.t, gEma);
  }

  let chipT = null;
  function updateChipSoon() { if (!chipT) chipT = setTimeout(() => { chipT = null; updateChip(); }, 400); }
  function updateChip() {
    const k = S.settings.source;
    const base = { phone: "GPS", usb: "USB", racebox: "BLE", ble: "BLE", sim: "DEMO" }[k] || "GPS";
    const dot = $("#gpsDot");
    dot.className = "dot";
    let lbl = base;
    if (k === "sim") { dot.classList.add("sim"); lbl = "DEMO"; }
    else if (SRC.status.needConnect) lbl = base + " · VERBIND";
    else if (SRC.lastFix && !SRC.nofix) { dot.classList.add(SRC.acc != null && SRC.acc > 15 ? "warn" : "ok"); if (SRC.hz > 0.3) lbl = `${base} ${SRC.hz >= 9.5 ? Math.round(SRC.hz) : SRC.hz.toFixed(1).replace(".0", "")} Hz`; }
    $("#gpsLbl").textContent = innerWidth < 400 ? lbl.replace(/^(GPS|USB|BLE) (?=\d)/, "") : lbl;
    $("#demoTag").style.display = k === "sim" ? "block" : "none";
    const live = $("#gnssLive");
    if (live) live.textContent = SRC.lastFix && !SRC.nofix ? `Live: ${SRC.hz.toFixed(1)} Hz${SRC.sats != null ? " · " + SRC.sats + " sat" : ""}${SRC.acc != null ? " · ±" + SRC.acc.toFixed(1) + " m" : ""}` : (SRC.status.needConnect ? "Niet verbonden" : "Wachten op GPS-fix…");
  }

  // ================= meten =================
  const M = { hist: [], state: "idle", rec: null, target: null, t0: null, peakV: 0, dist: 0, reachedAt: null, cand: null, greenAt: 0, redlight: false, lastRunFix: null, stillSince: null, imuLaunch: false, confirmed: false, final: null, treeTimers: [] };

  function setStatus(html) { $("#status").innerHTML = html; }
  function setTree(states) { $$("#tree i").forEach((el, i) => { el.className = states[i] || ""; }); }
  function clearTree() { M.treeTimers.forEach(clearTimeout); M.treeTimers = []; setTree([]); }
  function setGo(running) {
    const b = $("#goBtn");
    b.classList.toggle("stop", running);
    b.innerHTML = running ? `<svg><use href="#i-stop"/></svg><span>STOP</span>` : `<svg><use href="#i-play"/></svg><span>START</span>`;
  }

  function startMeasure() {
    unlockAudio();
    if (!SRC.cur || SRC.status.needConnect) { openSourceSheet(); toast("Verbind eerst je GPS-bron"); return; }
    M.target = curTarget();
    Object.assign(M, { liveSplits: [], rec: null, t0: null, peakV: 0, dist: 0, reachedAt: null, cand: null, redlight: false, lastRunFix: null, stillSince: null, imuLaunch: false, confirmed: false, final: null });
    requestWake();
    setGo(true);
    if (M.target.standing) {
      M.state = "arming"; M.stillWhy = "move"; M.lastStatus = ""; M.abortMsgUntil = 0; M.creepSince = null;
      armingStatus(performance.now());
    } else {
      M.state = "roll-wait";
      setStatus(`Rijd <b>onder ${M.target.from} ${uLbl()}</b>`);
      if (S.settings.source === "sim") SRC.cur.play({ rollFrom: Math.max(0, (M.target.from - 25) * uf()), stopV: (M.target.to + 6) * uf(), idle: 2.5 });
    }
    gaugeFlash();
  }

  function cancelMeasure(msg) {
    M.state = "idle"; M.rec = null; clearTree(); setGo(false);
    if (S.settings.source === "sim" && SRC.cur) { SRC.cur.cancel(); SRC.cur.idle(); }
    setStatus(msg || "Druk <b>START</b> om te beginnen");
  }

  function beginRecording() { const now = performance.now(); M.rec = { gps: RING.gps.filter((f) => f.t > now - 3500), imu: RING.imu.filter((a) => a.t > now - 3500) }; }

  function toReady() {
    M.state = "ready";
    beginRecording();
    // zwaartekracht vastleggen voor apparaten zonder lineaire versnelling
    const r = RING.imu.slice(-30);
    if (r.length && r[0].lin === false) { const n = r.length; M.grav = { x: r.reduce((s, a) => s + a.x, 0) / n, y: r.reduce((s, a) => s + a.y, 0) / n, z: r.reduce((s, a) => s + a.z, 0) / n }; }
    M.creepSince = null;
    setStatus("Stilstand bevestigd — <b>wacht op groen</b>"); beep(520, 0.08);
    const seq = [["amber"], ["amber", "amber"], ["amber", "amber", "amber"]];
    seq.forEach((st, i) => M.treeTimers.push(setTimeout(() => { if (M.state !== "ready") return; setTree(st); beep(640, 0.11); vibe(25); }, i * 420)));
    M.treeTimers.push(setTimeout(() => {
      if (M.state !== "ready") return;
      M.greenAt = performance.now();
      setTree(["", "", "", "green"]); beep(1280, 0.35, "square", 0.08); vibe(90);
      setStatus("<b>GO!</b> Timer start bij vertrek");
    }, 3 * 420));
    M.greenAt = performance.now() + 3 * 420;
    if (S.settings.source === "sim") {
      const t = M.target;
      SRC.cur.play(t.type === "speed" ? { stopV: (t.to + 6) * uf(), idle: 1.9 } : { stopV: 0, stopD: t.m + 40, idle: 1.9 });
    }
  }

  function launch(t0, viaImu) {
    M.liveSplits = []; TEL.trace = []; TEL.peakHp = 0; CAM.finalRun = null;
    M.hist = [];
    M.state = "running"; M.t0 = t0; M.imuLaunch = !!viaImu; M.confirmed = !viaImu; M.dist = 0; M.lastRunFix = null; M.peakV = 0;
    M.redlight = M.target.standing && t0 < M.greenAt - 30;
    clearTree();
    setTree(M.redlight ? ["", "", "", "", "red"] : ["", "", "", "green"]);
    setStatus(M.redlight ? "<b>Vroege start!</b> Timer loopt" : "<b>GAS!</b>");
    const w = $("#gaugeWrap"); w.classList.remove("shake"); void w.offsetWidth; w.classList.add("shake");
    vibe(40);
  }

  const STILL_V = 0.5, STILL_G = 0.04, STILL_MS = 2000, CREEP_V = 0.7;
  function imuAvailable() { return (SRC.imu && SRC.imu.active) || S.settings.source === "sim"; }
  // Gemiddelde versnellingsvector over de laatste ms (in g): trillingen middelen weg, echte beweging niet.
  function imuMeanG(ms) {
    const R = RING.imu; if (!R.length) return 0;
    const end = R[R.length - 1].t; let x = 0, y = 0, z = 0, n = 0;
    for (let i = R.length - 1; i >= 0 && end - R[i].t <= ms; i--) {
      const a = R[i]; let ax = a.x, ay = a.y, az = a.z;
      if (!a.lin && SRC.grav) { ax -= SRC.grav.x; ay -= SRC.grav.y; az -= SRC.grav.z; }
      x += ax; y += ay; z += az; n++;
    }
    return n ? Math.hypot(x / n, y / n, z / n) / E.G : 0;
  }
  function abortCountdown(why) {
    clearTree(); M.state = "arming"; M.stillSince = null; M.rec = null; M.cand = null; M.creepSince = null; M.stillWhy = "move";
    if (S.settings.source === "sim" && SRC.cur) { SRC.cur.cancel(); SRC.cur.idle(); }
    setStatus(`${why} — <b>opnieuw stilstaan</b>`); M.abortMsgUntil = performance.now() + 2500;
    beep(220, 0.25, "sawtooth", 0.06); vibe([40, 60, 40]);
  }
  function armingStatus(now) {
    if (M.state !== "arming" || now < (M.abortMsgUntil || 0)) return;
    let html;
    if (!SRC.lastFix || SRC.nofix || now - SRC.lastFix.t > 2500) html = "Wachten op <b>GPS-signaal</b>…";
    else if (M.stillSince != null) html = `Stilstand controleren… <b>${(Math.max(0, Math.min(STILL_MS, now - M.stillSince)) / 1000).toFixed(1)} / ${(STILL_MS / 1000).toFixed(1)} s</b>`;
    else if (M.stillWhy === "gps") html = `GPS meldt nog ${(M.stillV * 3.6).toFixed(1)} km/u — <b>even wachten</b>`;
    else html = "Kom tot <b>volledige stilstand</b>…";
    if (html !== M.lastStatus) { M.lastStatus = html; setStatus(html); }
  }

  function measureImu(t, mag) {
    if (M.state === "arming" && M.stillSince != null && imuMeanG(300) > 0.06) { M.stillSince = null; M.stillWhy = "move"; return; }
    if (M.state !== "ready") return;
    if (performance.now() < M.greenAt && !M.cand) { // langzaam wegrollen tijdens het aftellen
      if (imuMeanG(500) > 0.06 && mag < 0.15 * E.G) { if (M.creepSince == null) M.creepSince = t; else if (t - M.creepSince > 600) { abortCountdown("Beweging tijdens het aftellen"); return; } }
      else M.creepSince = null;
    }
    if (mag > 0.15 * E.G) { if (!M.cand) M.cand = t; else if (t - M.cand >= 120) launch(M.cand, true); }
    else if (mag < 0.1 * E.G) M.cand = null;
  }

  function measureFix(f) {
    const T = M.target;
    switch (M.state) {
      case "arming": {
        // Echte stilstand: GPS onder 1,8 km/u én (als er een bewegingssensor is) geen versnelling, 2 s aaneengesloten.
        const imuOk = !imuAvailable() || imuMeanG(400) < STILL_G;
        if (f.v < STILL_V && imuOk) {
          if (M.stillSince == null) { M.stillSince = f.t; M.stillFixes = 0; }
          M.stillFixes++;
          if (f.t - M.stillSince >= STILL_MS && M.stillFixes >= 3) toReady();
        } else { M.stillSince = null; M.stillWhy = !imuOk ? "move" : f.v >= 1.5 ? "move" : "gps"; M.stillV = f.v; }
        break;
      }
      case "ready":
        // Langzaam wegrollen zonder echte launch (voor of na groen) is geen geldige staande start.
        if (f.v > CREEP_V && imuAvailable() && !M.cand && imuMeanG(300) < 0.12) { abortCountdown("Auto rolde weg"); break; }
        if (f.v > 1.5) launch(SRC.prevFix && SRC.prevFix.v < 0.6 ? Math.max(SRC.prevFix.t, f.t - (f.v / 5) * 1000) : f.t - (f.v / 5) * 1000, false);
        break;
      case "roll-wait":
        if (f.v < T.from * uf() - 2 * E.KMH) { M.state = "roll-armed"; beginRecording(); setStatus(`<b>Vol gas!</b> Timer start bij ${T.from} ${uLbl()}`); beep(900, 0.12); vibe(40); }
        break;
      case "roll-armed": {
        const p = SRC.prevFix, S0 = T.from * uf();
        if (f.v >= S0) { const tc = p && p.v < S0 ? p.t + ((S0 - p.v) / (f.v - p.v)) * (f.t - p.t) : f.t; launch(tc, false); M.lastRunFix = f; M.peakV = f.v; }
        break;
      }
      case "running": {
        if (M.imuLaunch && !M.confirmed) {
          if (f.v > 1.0) M.confirmed = true;
          else if (f.t - M.t0 > 2500) { // schok zonder vertrek: terug naar klaar
            M.state = "ready"; M.cand = null; setTree(["", "", "", "green"]); setStatus("Beweging zonder vertrek — <b>opnieuw klaar</b>"); break;
          }
        }
        if (M.lastRunFix) M.dist += 0.5 * (M.lastRunFix.v + f.v) * Math.max(0, (f.t - M.lastRunFix.t) / 1000);
        else if (f.t > M.t0) M.dist += 0.5 * f.v * (f.t - M.t0) / 1000;
        M.lastRunFix = f;
        M.peakV = Math.max(M.peakV, f.v);
        M.hist.push([f.t, f.v]); while (M.hist.length && M.hist[0][0] < f.t - 3000) M.hist.shift();
        TEL.trace.push([(f.t - M.t0) / 1000, f.v]);
        { const p = SRC.prevFix;
          if (p && T.standing) for (const [a, b] of E.SPEED_PAIRS[unit()]) {
            const Sv = b * uf();
            if (a === 0 && p.v < Sv && f.v >= Sv && !M.liveSplits.some((s) => s.key === b)) M.liveSplits.push({ key: b, label: `0–${b}`, time: (p.t + ((Sv - p.v) / (f.v - p.v)) * (f.t - p.t) - M.t0) / 1000, at: performance.now() });
          }
          for (const D of E.DISTANCES) if (T.standing && M.dist >= D.m && !M.liveSplits.some((s) => s.key === D.id)) M.liveSplits.push({ key: D.id, label: D.label, time: (f.t - M.t0) / 1000, at: performance.now() });
        }
        const hit = T.type === "speed" ? f.v >= T.to * uf() : M.dist >= T.m;
        if (hit && M.reachedAt == null) M.reachedAt = f.t;
        if (M.reachedAt != null && f.t - M.reachedAt >= 250) finish("target");
        else if (M.reachedAt == null && liftDetected(M.hist, f, M.peakV)) finish("lift");
        else if (M.reachedAt == null && M.peakV < 4 && f.t - M.t0 > 4000 && f.v < 1.5) { // valse start (GPS-ruis of stukje rollen)
          M.state = "arming"; M.stillSince = null; M.rec = null; clearTree(); setStatus("Geen echte start — kom tot <b>stilstand</b>…");
        }
        else if (f.t - M.t0 > 150000) finish("timeout");
        break;
      }
    }
  }

  // Gas los: duidelijk terugvallen t.o.v. de piek, of ruim een seconde aanhoudend vertragen.
  function liftDetected(hist, f, peak) {
    if (peak < 15 * E.KMH) return false;
    if (peak - f.v >= 8 * E.KMH) return true;
    const old = hist.find((x) => x[0] >= f.t - 1300);
    return !!old && f.t - old[0] >= 700 && old[1] - f.v >= 3 * E.KMH && f.v > 15 * E.KMH;
  }

  function goPressed() {
    if (M.state === "idle") startMeasure();
    else if (M.state === "running") finish("stop");
    else cancelMeasure();
  }

  function finish(reason) {
    const rec = M.rec, T = M.target;
    M.state = "idle"; M.rec = null; setGo(false); clearTree();
    setStatus("Druk <b>START</b> om te beginnen");
    if (!rec) return;
    const res = E.analyze(rec, { standing: T.standing, rollout: S.settings.rollout && T.standing, unit: unit(), extraPairs: T.type === "speed" && T.from > 0 ? [[T.from, T.to]] : T.type === "speed" ? [[0, T.to]] : [] });
    if (!res.ok) { toast(res.reason || "Geen geldige meting"); return; }
    const prim = T.type === "speed" ? res.speedSplits.find((s) => s.from === T.from && s.to === T.to) : res.distSplits.find((s) => s.id === T.id);
    if (!prim && !res.speedSplits.length && !res.distSplits.length) { toast(reason === "stop" ? "Gestopt — geen tijd gemeten" : "Doel niet gehaald — geen tijd gemeten"); return; }
    const sim = S.settings.source === "sim";
    const car = sim ? { id: "demo:" + S.settings.simCar, name: "Demo · " + E.SIM_CARS[S.settings.simCar].name } : activeCar();
    const run = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: Date.now(), carId: car.id, carName: car.name, unit: unit(),
      target: T, primary: prim ? { key: T.key, label: T.label, time: prim.time } : null, res, src: S.settings.source, sim, redlight: M.redlight, mass: carMass(),
    };
    M.final = prim ? prim.time : null;
    S.runs.unshift(run);
    if (S.runs.length > 600) S.runs.length = 600;
    save();
    if (CAM.on) { // eerst de resultaatkaart in beeld (en in de video), daarna het resultaatscherm
      CAM.finalRun = run; CAM.finalAt = performance.now();
      // live schattingen vervangen door de definitieve analyse
      const at = performance.now() + 4500;
      M.liveSplits = res.speedSplits.filter((s) => s.from === 0).map((s) => ({ key: s.to, label: `0–${s.to}`, time: s.time, at }))
        .concat(res.distSplits.map((s) => ({ key: s.id, label: s.label, time: s.time, at }))).sort((a, b) => a.time - b.time);
      burstAt(innerWidth / 2, innerHeight * 0.35, 120);
      [880, 1175, 1568, 2093].forEach((f, i) => beep(f, 0.18, "triangle", 0.09, i * 0.09)); vibe([60, 40, 140]);
      CAM.awaitEnd = { t: performance.now(), run }; CAM.peak = M.peakV; CAM.hist = [];
      if (reason !== "target") startOutro(); // al gas los of gestopt: meteen afronden
      else CAM.autoStopT = setTimeout(startOutro, 25000); // vangnet
    } else showResult(run, true);
  }

  // ================= gauge =================
  const LOGOS = {};
  function carLogo(c) {
    if (!c || !c.logo) return null;
    if (!LOGOS[c.id] || LOGOS[c.id].src !== c.logo) { const im = new Image(); im.src = c.logo; LOGOS[c.id] = im; }
    return LOGOS[c.id];
  }
  function gaugeOpts() {
    const sim = S.settings.source === "sim", c = activeCar();
    const style = !sim && c.gauge && c.gauge !== "default" ? c.gauge : S.settings.gauge;
    return { style, accent: c.accent, logo: sim ? null : carLogo(c) };
  }
  const MAXES = { kmh: [[80, 10], [120, 20], [160, 20], [200, 20], [240, 40], [280, 40], [320, 40], [400, 50], [500, 50], [600, 100]], mph: [[60, 10], [80, 10], [100, 20], [140, 20], [180, 20], [200, 20], [250, 50], [300, 50], [350, 50]] };
  const pickMax = (need) => { const L = MAXES[unit()]; return L.find((m) => m[0] >= need) || L[L.length - 1]; };
  const GA = { v: 0, max: 160, want: [160, 20], trail: [], sparks: [], last: performance.now(), flash: 0 };
  function gaugeFlash() { GA.flash = 1; }

  function liveSpeed(now) {
    const f = SRC.lastFix;
    if (!f || SRC.nofix) return 0;
    let v = f.v;
    const p = SRC.prevFix;
    if (p && (M.state === "running" || M.state === "roll-armed") && f.t > p.t) {
      const a = (f.v - p.v) / ((f.t - p.t) / 1000);
      v += a * Math.min(Math.max(0, (now - f.t) / 1000), 1.1 * (f.t - p.t) / 1000);
    }
    return Math.max(0, v);
  }

  function arcPath(ctx, cx, cy, r, a1, a2) { ctx.beginPath(); ctx.arc(cx, cy, r, a1, a2); }
  const segColor = (f) => { // paars → roze → oranje → wit-geel
    const stops = [[0, [92, 26, 166]], [0.35, [162, 56, 255]], [0.62, [255, 47, 120]], [0.85, [255, 122, 61]], [1, [255, 214, 140]]];
    for (let i = 1; i < stops.length; i++) if (f <= stops[i][0]) { const [p0, c0] = stops[i - 1], [p1, c1] = stops[i]; const k = (f - p0) / (p1 - p0); return `rgb(${c0.map((c, j) => Math.round(c + (c1[j] - c) * k)).join(",")})`; }
    return "rgb(255,214,140)";
  };

  // Kleurenpaletten voor de 'klassieke' wijzertellers (incl. merk-geïnspireerde stijlen, zonder logo's).
  const PAL = {
    classic: { disc: ["#221338", "#0f0819", "#06030b"], ring: "rgba(193,132,255,.32)", track: "rgba(255,255,255,.06)", tick: "rgba(244,238,251,.62)", tickOn: "#fff", hot: "#e2264d", label: "rgba(244,238,251,.9)", digits: "#fff", unit: "rgba(173,158,196,.8)", needle: ["#fff", "#e2264d"], zone: "rgba(226,38,77,.5)" },
    rosso: { disc: ["#b3122a", "#6d0a18", "#2a040a"], ring: "rgba(255,214,140,.4)", track: "rgba(0,0,0,.18)", tick: "rgba(255,240,240,.75)", tickOn: "#fff", hot: "#ffd68c", label: "#fff", digits: "#fff", unit: "rgba(255,220,220,.8)", needle: ["#fff", "#ffd68c"], zone: "rgba(255,214,140,.45)" },
    wit: { disc: ["#f4f1f8", "#d9d3e3", "#9d95ad"], ring: "rgba(20,12,30,.35)", track: "rgba(20,12,30,.08)", tick: "rgba(20,12,30,.7)", tickOn: "#000", hot: "#e2264d", label: "#1a1024", digits: "#1a1024", unit: "rgba(26,16,36,.7)", needle: ["#ff5a1f", "#ff2f00"], zone: "rgba(226,38,77,.5)" },
    affalterbach: { disc: ["#34343a", "#16161a", "#050506"], ring: "rgba(210,210,220,.55)", track: "rgba(255,255,255,.07)", tick: "#bfbfc9", tickOn: "#fff", hot: "#e10600", label: "#ececf2", digits: "#fff", unit: "#9a9aa6", needle: ["#f2f2f2", "#e10600"], zone: "rgba(225,6,0,.5)", carbon: true },
    munchen: { disc: ["#1d2536", "#0c1018", "#04060a"], ring: "rgba(90,150,230,.5)", track: "rgba(255,255,255,.06)", tick: "#d6dcea", tickOn: "#fff", hot: "#e4002b", label: "#e8ecf5", digits: "#fff", unit: "#8e9ab3", needle: ["#ff7a1a", "#ff5a00"], zone: "rgba(228,0,43,.5)", stripes: ["#5ab4e5", "#1c3f94", "#e4002b"] },
    maranello: { disc: ["#ffd84a", "#f2b705", "#a87600"], ring: "#222", track: "rgba(0,0,0,.12)", tick: "rgba(0,0,0,.75)", tickOn: "#000", hot: "#c00000", label: "#111", digits: "#111", unit: "rgba(0,0,0,.65)", needle: ["#c00000", "#c00000"], zone: "rgba(204,0,0,.5)" },
    zuffenhausen: { disc: ["#1c1c1c", "#0d0d0d", "#000"], ring: "rgba(255,255,255,.35)", track: "rgba(255,255,255,.06)", tick: "#e6e6e6", tickOn: "#fff", hot: "#d5001c", label: "#f2f2f2", digits: "#fff", unit: "#9b9b9b", needle: ["#fff", "#d5001c"], zone: "rgba(213,0,28,.45)" },
    santagata: { disc: ["#141a0e", "#090c06", "#020302"], ring: "rgba(184,255,60,.5)", track: "rgba(184,255,60,.07)", tick: "#a8e84a", tickOn: "#d9ff8a", hot: "#ff8a00", label: "#e8ffd0", digits: "#b8ff3c", unit: "#7f9a60", needle: ["#fff", "#ff8a00"], zone: "rgba(255,138,0,.5)", hex: true },
  };
  function gaugePal(style, accent) {
    if (style === "eigen") {
      const a = accent || "#ff2f78";
      return Object.assign({}, PAL.classic, { ring: a + "88", hot: a, needle: ["#fff", a], zone: a + "80", tickOn: "#fff" });
    }
    return PAL[style];
  }

  function drawGauge(ctx, W, o) {
    const cx = W / 2, cy = W / 2, R = W * 0.46, a0 = Math.PI * 0.75, sweep = Math.PI * 1.5;
    const ang = (v) => a0 + sweep * Math.max(0, Math.min(1.02, v / o.max));
    const step = o.step, minor = step / (step % 4 === 0 || step === 20 ? 4 : 5);
    const tgt = o.target;
    ctx.clearRect(0, 0, W, W);
    ctx.save();
    const fontD = (px) => `${px}px Anton, Impact, sans-serif`;
    const style = o.style;
    const pal = gaugePal(style, o.accent), CL = !!pal;
    if (style === "gforce") {
      const gg = o.g || { lat: TEL.latG, lon: TEL.lonG, trail: TEL.trail };
      drawGBall(ctx, cx, cy, R * 0.97, gg.lat, gg.lon, gg.trail, { solid: true });
      if (W > 140) {
        ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; ctx.font = fontD(R * 0.2); ctx.fillStyle = "#fff"; ctx.shadowColor = "#ff2f78"; ctx.shadowBlur = R * 0.06;
        ctx.fillText(String(Math.round(o.v)), cx, cy + R * 0.66); ctx.shadowBlur = 0;
        ctx.font = `700 ${R * 0.05}px Inter, sans-serif`; ctx.fillStyle = "rgba(173,158,196,.9)"; ctx.fillText(o.unit.toUpperCase(), cx, cy + R * 0.74);
        ctx.font = `700 ${R * 0.065}px "JetBrains Mono", monospace`; ctx.fillStyle = "#ffd68c";
        ctx.fillText(`${gg.lon >= 0 ? "+" : ""}${gg.lon.toFixed(2)} G`, cx, cy - R * 0.62);
      }
      ctx.restore();
      return { cx, cy, R };
    }

    // achtergrondschijf
    const g = ctx.createRadialGradient(cx, cy * 0.85, R * 0.05, cx, cy, R * 1.06);
    if (style === "hyper") { g.addColorStop(0, "rgba(40,20,60,.55)"); g.addColorStop(1, "rgba(7,4,13,0)"); }
    else if (pal) { g.addColorStop(0, pal.disc[0]); g.addColorStop(0.7, pal.disc[1]); g.addColorStop(1, pal.disc[2]); }
    else { g.addColorStop(0, "#221338"); g.addColorStop(0.65, "#0f0819"); g.addColorStop(1, "#06030b"); }
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.05, 0, TAU); ctx.fillStyle = g; ctx.fill();
    if (pal && (pal.carbon || pal.hex)) { // textuur: carbon-weefsel of hexagons
      ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R * 1.04, 0, TAU); ctx.clip();
      const cs = R * (pal.hex ? 0.09 : 0.05);
      ctx.strokeStyle = pal.hex ? "rgba(184,255,60,.07)" : "rgba(255,255,255,.035)"; ctx.lineWidth = Math.max(1, R * 0.006);
      if (pal.hex) { for (let yy = cy - R; yy < cy + R; yy += cs * 1.5) for (let xx = cx - R, k = 0; xx < cx + R; xx += cs * 1.732, k++) { const ox = (Math.round((yy - cy + R) / (cs * 1.5)) % 2) * cs * 0.866; ctx.beginPath(); for (let i = 0; i < 6; i++) { const aa = Math.PI / 3 * i + Math.PI / 6; ctx.lineTo(xx + ox + Math.cos(aa) * cs, yy + Math.sin(aa) * cs); } ctx.closePath(); ctx.stroke(); } }
      else { for (let yy = cy - R; yy < cy + R; yy += cs) for (let xx = cx - R; xx < cx + R; xx += cs) { const f = ((xx + yy) / cs) % 2 < 1; ctx.fillStyle = f ? "rgba(255,255,255,.028)" : "rgba(0,0,0,.12)"; ctx.fillRect(xx, yy, cs, cs); } }
      ctx.restore();
    }
    if (style !== "hyper") {
      ctx.lineWidth = Math.max(1, W * 0.004); ctx.strokeStyle = pal ? pal.ring : "rgba(193,132,255,.32)"; ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, R * 1.05 - W * 0.012, 0, TAU); ctx.strokeStyle = "rgba(255,255,255,.04)"; ctx.stroke();
    }
    if (GA.flash > 0 && o.live) { ctx.beginPath(); ctx.arc(cx, cy, R * 1.05, 0, TAU); ctx.strokeStyle = `rgba(255,47,120,${GA.flash * 0.8})`; ctx.lineWidth = W * 0.012; ctx.shadowColor = "#ff2f78"; ctx.shadowBlur = W * 0.06 * GA.flash; ctx.stroke(); ctx.shadowBlur = 0; }

    const bandR = style === "hyper" ? R * 0.9 : R * 0.84, bandW = style === "hyper" ? R * 0.04 : R * 0.075;
    const tgtV = tgt ? tgt : null;

    if (style === "villain") {
      const N = 60, gap = 0.28;
      for (let i = 0; i < N; i++) {
        const f1 = i / N, f2 = (i + 1 - gap) / N, vMid = ((i + 0.5) / N) * o.max;
        const lit = vMid <= o.v;
        arcPath(ctx, cx, cy, bandR, a0 + sweep * f1, a0 + sweep * f2);
        ctx.lineWidth = R * 0.12;
        if (lit) { ctx.strokeStyle = segColor(f1); ctx.shadowColor = segColor(f1); ctx.shadowBlur = R * 0.08; }
        else { ctx.strokeStyle = tgtV && vMid >= tgtV ? "rgba(255,47,120,.16)" : "rgba(255,255,255,.055)"; ctx.shadowBlur = 0; }
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    } else {
      arcPath(ctx, cx, cy, bandR, a0, a0 + sweep); ctx.lineWidth = bandW; ctx.strokeStyle = pal ? pal.track : "rgba(255,255,255,.06)"; ctx.stroke();
      if (tgtV && tgtV < o.max) {
        arcPath(ctx, cx, cy, bandR, ang(tgtV), a0 + sweep); ctx.strokeStyle = pal ? pal.zone : "rgba(255,47,120,.2)"; ctx.stroke();
      }
      if (o.v > 0.2 && !CL) {
        const cg = ctx.createConicGradient ? ctx.createConicGradient(a0, cx, cy) : null;
        if (cg) { cg.addColorStop(0, "#5c1aa6"); cg.addColorStop(0.24, "#a238ff"); cg.addColorStop(0.46, "#ff2f78"); cg.addColorStop(0.64, "#ff7a3d"); cg.addColorStop(0.75, "#ffd68c"); cg.addColorStop(0.76, "#5c1aa6"); cg.addColorStop(1, "#5c1aa6"); }
        arcPath(ctx, cx, cy, bandR, a0, ang(o.v));
        ctx.strokeStyle = cg || "#ff2f78"; ctx.lineWidth = bandW; ctx.lineCap = "round";
        ctx.shadowColor = "#ff2f78"; ctx.shadowBlur = R * 0.1; ctx.stroke(); ctx.shadowBlur = 0; ctx.lineCap = "butt";
      }
    }

    // streepjes + cijfers
    const tickR = style === "villain" ? R * 1.0 : style === "hyper" ? R * 0.99 : R * 0.985;
    for (let v = 0; v <= o.max + 0.001; v += minor) {
      const a = ang(v), major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
      const hot = tgtV && v >= tgtV - 1e-6;
      const passed = v <= o.v;
      if (style === "villain" && !major) continue;
      if (style === "hyper") {
        ctx.beginPath(); ctx.arc(cx + Math.cos(a) * tickR, cy + Math.sin(a) * tickR, major ? R * 0.016 : R * 0.007, 0, TAU);
        ctx.fillStyle = hot ? "#ff2f78" : passed ? "#fff" : "rgba(244,238,251,.4)"; ctx.fill();
      } else {
        const r1 = major ? R * (style === "villain" ? 0.95 : 0.9) : R * 0.935, r2 = tickR;
        ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
        ctx.lineWidth = major ? R * 0.022 : R * 0.009; ctx.lineCap = "round";
        ctx.strokeStyle = pal ? (hot ? pal.hot : passed && o.v > 0 ? pal.tickOn : pal.tick) : hot ? "#ff4f8a" : passed && o.v > 0 ? "#fff" : "rgba(244,238,251,.62)";
        ctx.stroke(); ctx.lineCap = "butt";
      }
      if (major && W > 140) {
        const lr = style === "villain" ? R * 0.64 : style === "hyper" ? R * 0.76 : R * 0.69;
        ctx.font = style === "hyper" ? `700 ${R * 0.075}px "JetBrains Mono", monospace` : fontD(R * (o.max >= 400 ? 0.082 : 0.095));
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillStyle = pal ? (hot ? pal.hot : pal.label) : hot ? "#ff5a8f" : "rgba(244,238,251,.9)";
        ctx.fillText(String(Math.round(v)), cx + Math.cos(a) * lr, cy + Math.sin(a) * lr);
      }
    }

    // doel-markering
    if (tgtV && tgtV <= o.max && style !== "villain") {
      const a = ang(tgtV), pulse = o.live ? 0.6 + 0.4 * Math.sin(performance.now() / 260) : 1;
      const r = R * 1.09;
      ctx.save(); ctx.translate(cx + Math.cos(a) * r, cy + Math.sin(a) * r); ctx.rotate(a + Math.PI / 2);
      ctx.beginPath(); ctx.moveTo(0, R * 0.05); ctx.lineTo(-R * 0.04, -R * 0.02); ctx.lineTo(R * 0.04, -R * 0.02); ctx.closePath();
      ctx.fillStyle = `rgba(255,47,120,${pulse})`; ctx.shadowColor = "#ff2f78"; ctx.shadowBlur = R * 0.06; ctx.fill(); ctx.restore();
    }

    if (pal && pal.stripes) { // drie strepen onderin, in de opening van de wijzerplaat
      pal.stripes.forEach((c, i) => { ctx.beginPath(); ctx.arc(cx, cy, R * (0.93 - i * 0.035), Math.PI * 0.36, Math.PI * 0.64); ctx.strokeStyle = c; ctx.lineWidth = R * 0.025; ctx.stroke(); });
    }
    if (o.logo && o.logo.complete && o.logo.naturalWidth && W > 140) { // eigen merklogo van de gebruiker
      const lw = R * 0.5, lh = R * 0.24, sc2 = Math.min(lw / o.logo.naturalWidth, lh / o.logo.naturalHeight);
      const dw = o.logo.naturalWidth * sc2, dh = o.logo.naturalHeight * sc2;
      const ly = style === "villain" || style === "hyper" ? cy - R * 0.45 : cy - R * 0.36;
      ctx.globalAlpha = 0.92; ctx.drawImage(o.logo, cx - dw / 2, ly - dh / 2, dw, dh); ctx.globalAlpha = 1;
    }
    // centrale cijfers
    const digits = String(Math.round(o.v));
    if (style === "villain" || style === "hyper") {
      ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
      ctx.font = fontD(R * (style === "hyper" ? 0.56 : 0.52));
      ctx.fillStyle = "#fff"; ctx.shadowColor = style === "villain" ? "#a238ff" : "#ff2f78"; ctx.shadowBlur = R * 0.12;
      ctx.fillText(digits, cx, cy + R * 0.18); ctx.shadowBlur = 0;
      ctx.font = `700 ${R * 0.07}px Inter, sans-serif`; ctx.fillStyle = "rgba(173,158,196,.9)";
      ctx.fillText(o.unit.toUpperCase().split("").join(" "), cx, cy + R * 0.32);
      if (style === "hyper" && tgtV) {
        const bw = R * 0.95, bh = R * 0.04, bx = cx - bw / 2, by = cy + R * 0.46;
        ctx.fillStyle = "rgba(255,255,255,.07)"; ctx.fillRect(bx, by, bw, bh);
        const f = Math.min(1, o.v / tgtV);
        const lg = ctx.createLinearGradient(bx, 0, bx + bw, 0); lg.addColorStop(0, "#a238ff"); lg.addColorStop(0.6, "#ff2f78"); lg.addColorStop(1, "#ff7a3d");
        ctx.fillStyle = lg; ctx.shadowColor = "#ff2f78"; ctx.shadowBlur = R * 0.06; ctx.fillRect(bx, by, bw * f, bh); ctx.shadowBlur = 0;
        ctx.font = `700 ${R * 0.06}px "JetBrains Mono", monospace`; ctx.fillStyle = "rgba(244,238,251,.7)";
        ctx.fillText(`DOEL ${Math.round(tgtV)}`, cx, by + bh + R * 0.1);
      } else if (style === "villain" && tgtV) {
        ctx.font = `700 ${R * 0.06}px "JetBrains Mono", monospace`; ctx.fillStyle = "rgba(193,132,255,.8)";
        ctx.fillText(`DOEL ${Math.round(tgtV)}`, cx, cy + R * 0.46);
      }
    } else {
      ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
      const lightFace = pal && (style === "wit" || style === "maranello");
      ctx.font = fontD(R * 0.34); ctx.fillStyle = pal ? pal.digits : "#fff"; ctx.shadowColor = lightFace ? "transparent" : "rgba(255,47,120,.6)"; ctx.shadowBlur = R * 0.08;
      ctx.fillText(digits, cx, cy + R * 0.52); ctx.shadowBlur = 0;
      ctx.font = `500 ${R * 0.075}px Inter, sans-serif`; ctx.fillStyle = pal ? pal.unit : "rgba(173,158,196,.8)";
      ctx.fillText(o.unit.split("").join(" "), cx, cy + R * 0.66);
    }

    // naald
    if (style === "screamer" || CL) {
      const a = ang(o.v);
      const trail = o.trail || [];
      trail.forEach((ta, i) => {
        const al = ((i + 1) / trail.length) * 0.18;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(ta) * R * 0.8, cy + Math.sin(ta) * R * 0.8);
        ctx.strokeStyle = `rgba(255,47,120,${al})`; ctx.lineWidth = R * 0.03; ctx.stroke();
      });
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(a);
      const L = R * 0.82, b = R * 0.028;
      const ng = ctx.createLinearGradient(-R * 0.14, 0, L, 0);
      if (pal) { ng.addColorStop(0, pal.needle[0]); ng.addColorStop(0.6, pal.needle[0]); ng.addColorStop(0.62, pal.needle[1]); ng.addColorStop(1, pal.needle[1]); }
      else { ng.addColorStop(0, "#fff"); ng.addColorStop(0.55, "#fff"); ng.addColorStop(0.8, "#ff7a3d"); ng.addColorStop(1, "#ff2f78"); }
      ctx.beginPath(); ctx.moveTo(-R * 0.14, -b * 1.2); ctx.lineTo(L, -b * 0.25); ctx.lineTo(L, b * 0.25); ctx.lineTo(-R * 0.14, b * 1.2); ctx.closePath();
      ctx.fillStyle = ng; ctx.shadowColor = "rgba(255,47,120,.9)"; ctx.shadowBlur = R * 0.07; ctx.fill(); ctx.restore(); ctx.shadowBlur = 0;
      // naaf
      ctx.beginPath(); ctx.arc(cx, cy, R * 0.075, 0, TAU); ctx.fillStyle = "#170d25"; ctx.fill();
      ctx.lineWidth = R * 0.018; ctx.strokeStyle = "#2e1d45"; ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, R * 0.035, 0, TAU); ctx.fillStyle = "#ff2f78"; ctx.shadowColor = "#ff2f78"; ctx.shadowBlur = R * 0.06; ctx.fill(); ctx.shadowBlur = 0;
    }

    // vonken
    if (o.sparks && o.sparks.length) {
      ctx.globalCompositeOperation = "lighter";
      for (const p of o.sparks) {
        const al = Math.max(0, p.life);
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035);
        ctx.strokeStyle = `rgba(${p.c},${al})`; ctx.lineWidth = p.w; ctx.stroke();
      }
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.restore();
    return { cx, cy, R, bandR, ang };
  }

  const gCanvas = $("#gauge"), gCtx = gCanvas.getContext("2d");
  let gSize = 0;
  function sizeGauge() {
    const r = gCanvas.getBoundingClientRect(), dpr = Math.min(3, window.devicePixelRatio || 1);
    gSize = r.width; gCanvas.width = Math.round(r.width * dpr); gCanvas.height = Math.round(r.width * dpr);
    gCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function frame() {
    try { frameBody(); } catch (e) { console.error(e); }
    requestAnimationFrame(frame);
  }
  function frameBody() {
    const now = performance.now(), dt = Math.min(0.1, (now - GA.last) / 1000); GA.last = now;
    const running = M.state === "running";
    const vDisp = liveSpeed(now) / uf();
    GA.v += (vDisp - GA.v) * (1 - Math.exp(-dt * (running ? 14 : 8)));
    if (GA.v < 0.05) GA.v = 0;
    // schaal
    const T = curTargetCached();
    const need = Math.max(T.type === "speed" ? T.to * (T.to >= 300 ? 1.2 : 1.3) : (unit() === "mph" ? 130 : 200), GA.v * 1.12);
    GA.want = pickMax(need);
    GA.max += (GA.want[0] - GA.max) * (1 - Math.exp(-dt * 4));
    GA.flash = Math.max(0, GA.flash - dt * 1.6);
    updateTel(dt);
    armingStatus(now);

    if (CAM.on) { const a = Math.PI * 0.75 + Math.PI * 1.5 * Math.max(0, Math.min(1.02, GA.v / GA.max)); GA.trail.push(a); if (GA.trail.length > 7) GA.trail.shift(); }
    else if (document.visibilityState === "visible" && $("#v-meten").classList.contains("active") && gSize) {
      const R = gSize * 0.46;
      const a = Math.PI * 0.75 + Math.PI * 1.5 * Math.max(0, Math.min(1.02, GA.v / GA.max));
      GA.trail.push(a); if (GA.trail.length > 7) GA.trail.shift();
      // vonken bij de kop van de boog tijdens acceleratie
      const accel = SRC.prevFix && SRC.lastFix ? (SRC.lastFix.v - SRC.prevFix.v) / Math.max(0.04, (SRC.lastFix.t - SRC.prevFix.t) / 1000) : 0;
      if (running && accel > 1 && GA.v > 1) {
        const n = Math.min(6, 1 + accel / 3);
        const bandR = gaugeOpts().style === "hyper" ? R * 0.9 : R * 0.84;
        for (let i = 0; i < n; i++) {
          const x = gSize / 2 + Math.cos(a) * bandR, y = gSize / 2 + Math.sin(a) * bandR;
          const sp = 60 + Math.random() * 220, dir = a + Math.PI * 0.5 + (Math.random() - 0.5) * 1.3;
          const cols = ["255,122,61", "255,47,120", "255,214,140", "193,132,255"];
          GA.sparks.push({ x, y, vx: Math.cos(dir) * sp, vy: Math.sin(dir) * sp, life: 1, w: 1 + Math.random() * 2, c: cols[(Math.random() * cols.length) | 0] });
        }
      }
      for (const p of GA.sparks) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 260 * dt; p.vx *= 0.985; p.life -= dt * 1.8; }
      GA.sparks = GA.sparks.filter((p) => p.life > 0);
      if (GA.sparks.length > 220) GA.sparks.splice(0, GA.sparks.length - 220);
      drawGauge(gCtx, gSize, Object.assign(gaugeOpts(), { v: GA.v, max: GA.max, step: GA.want[1], target: T.type === "speed" ? T.to : null, unit: uLbl(), trail: GA.trail.slice(0, -1), sparks: GA.sparks, live: true }));
      // live getallen
      let tEl = 0;
      if (running) tEl = (now - M.t0) / 1000;
      else if (M.final != null) tEl = M.final;
      $("#lsTime").textContent = tEl.toFixed(2);
      $("#lsG").textContent = TEL.lonG.toFixed(2);
      $("#lsDist").textContent = distFmt(running ? M.dist : 0);
    }
    if ($("#hud").classList.contains("open")) {
      $("#hudSpd").textContent = Math.round(GA.v);
      $("#hudSub").textContent = (running ? ((now - M.t0) / 1000).toFixed(2) : (M.final != null ? M.final.toFixed(2) : "0.00")) + " s";
    }
  }
  let _tc = null, _tcKey = "";
  function curTargetCached() { const k = S.mode + S.sel.speed + S.sel.dist + unit(); if (k !== _tcKey) { _tcKey = k; _tc = curTarget(); } return _tc; }

  // ================= meten-scherm =================
  function renderMeten() {
    const c = activeCar();
    const sim = S.settings.source === "sim";
    $("#carThumb").style.backgroundImage = `url("${sim ? "img/car-burnout-smoke.jpg" : c.photo || "img/car-hood-purple.jpg"}")`;
    $("#carName").textContent = sim ? "Demo · " + E.SIM_CARS[S.settings.simCar].name : c.name;
    $("#carSpec").textContent = sim ? "gesimuleerde run" : [c.make, c.hp ? c.hp + " pk" : "", c.nm ? c.nm + " Nm" : ""].filter(Boolean).join(" · ");
    $$("#modeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === S.mode));
    const chips = $("#chips");
    if (S.mode === "speed") {
      chips.innerHTML = speedChips().map((k) => `<button data-k="${k}" class="${k === S.sel.speed ? "on" : ""} ${k.startsWith("0-") ? "" : "rolling"}">${k.replace("-", "–")}</button>`).join("") + `<button class="add" id="addChip">+ eigen</button>`;
    } else {
      chips.innerHTML = DIST_CHIPS.map((id) => { const d = E.DISTANCES.find((x) => x.id === id); return `<button data-k="${id}" class="${id === S.sel.dist ? "on" : ""}">${d.label}</button>`; }).join("");
    }
    const on = chips.querySelector(".on"); if (on) on.scrollIntoView({ inline: "center", block: "nearest" });
  }
  $("#modeSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b || M.state !== "idle") return; S.mode = b.dataset.mode; save(); renderMeten(); });
  $("#chips").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (M.state !== "idle") { toast("Stop eerst de lopende meting"); return; }
    if (b.id === "addChip") { openCustomSheet(); return; }
    if (S.mode === "speed") S.sel.speed = b.dataset.k; else S.sel.dist = b.dataset.k;
    save(); renderMeten(); gaugeFlash();
  });
  $("#goBtn").addEventListener("click", goPressed);
  $("#carPill").addEventListener("click", () => { if (S.settings.source === "sim") { openSourceSheet(); return; } openCarPicker(); });

  function openCustomSheet() {
    const mine = S.custom.filter((c) => c.unit === unit());
    openSheet(`<h2>Eigen traject</h2>
      <div class="grid3" style="grid-template-columns:1fr 1fr"><label class="field"><span>Van (${uLbl()})</span><input id="cFrom" type="number" inputmode="numeric" value="100"></label><label class="field"><span>Tot (${uLbl()})</span><input id="cTo" type="number" inputmode="numeric" value="250"></label></div>
      <p class="note">Van 0 = staande start. Hoger dan 0 = rolling start (timer start als je die snelheid passeert).</p>
      <div style="height:10px"></div><button class="btn pri" id="cAdd">Toevoegen</button>
      ${mine.length ? `<div class="h-eyebrow">Mijn trajecten</div><div class="card rows">${mine.map((c) => `<div class="row"><div class="tx"><b>${c.v.replace("-", "–")} ${uLbl()}</b></div><button class="icon-btn" data-del="${c.v}">${icon("i-trash")}</button></div>`).join("")}</div>` : ""}`, (b) => {
      $("#cAdd", b).onclick = () => {
        const f = parseInt($("#cFrom", b).value, 10), t = parseInt($("#cTo", b).value, 10);
        if (!(f >= 0 && t > f && t <= (unit() === "mph" ? 380 : 600))) { toast("Kies een geldig traject"); return; }
        const v = f + "-" + t;
        if (!speedChips().includes(v)) S.custom.push({ unit: unit(), v });
        S.sel.speed = v; save(); closeSheet(); renderMeten();
      };
      $$("[data-del]", b).forEach((x) => x.onclick = () => { S.custom = S.custom.filter((c) => !(c.unit === unit() && c.v === x.dataset.del)); save(); renderMeten(); openCustomSheet(); });
    });
  }

  // ================= GPS-bron sheet =================
  function openSourceSheet() {
    const k = S.settings.source;
    const usbOk = SR.UsbGnss.supported(), bleOk = SR.BleGnss.supported();
    const pill = (id) => {
      if (id === "phone") return k === id ? `<span class="pill">Actief</span>` : "";
      if (id === "sim") return k === id ? `<span class="pill">Actief</span>` : "";
      if ((id === "usb" && !usbOk) || ((id === "racebox" || id === "ble") && !bleOk)) return `<span class="pill off">Niet ondersteund</span>`;
      if (k !== id) return "";
      return SRC.status.needConnect ? `<span class="pill warn">Verbind</span>` : `<span class="pill">Verbonden</span>`;
    };
    const opt = (id, ic, t, d) => `<button class="card opt ${k === id ? "on" : ""}" data-src="${id}">${icon(ic, "i ic")}<div class="tx"><b>${t}</b><span>${d}</span></div>${pill(id)}</button>`;
    openSheet(`<h2>GPS-bron</h2>
      ${opt("phone", "i-phone", "Telefoon-GPS", "Ingebouwde ontvanger + bewegingssensor. Meestal 1 Hz.")}
      ${opt("usb", "i-usb", "USB-C GNSS-ontvanger", "u-blox M8/M9/M10 via USB-C — tot 25 Hz. Aanbevolen voor hypercars.")}
      ${opt("racebox", "i-bt", "RaceBox (Bluetooth)", "RaceBox Mini / Mini S / Micro — 25 Hz.")}
      ${opt("ble", "i-bt", "Bluetooth NMEA-ontvanger", "Andere BLE-ontvanger met Nordic UART-service.")}
      ${opt("sim", "i-demo", "Demo-modus", "Gesimuleerde runs — probeer de app zonder te rijden.")}
      ${k === "usb" ? `<div class="card" style="padding:16px;margin-bottom:10px"><b>Verversingssnelheid</b><p class="note" style="margin:4px 0 12px">25 Hz vereist een u-blox M10; M8 haalt maximaal 10 Hz. Het dynamische model blijft op 'Portable' (tot 1100 km/u) — 'Automotive' begrenst op 360 km/u.</p>
        <div class="mini-seg" id="hzSeg"><button data-hz="10" class="${S.settings.usbHz === 10 ? "on" : ""}">10 Hz</button><button data-hz="25" class="${S.settings.usbHz === 25 ? "on" : ""}">25 Hz</button></div>
        <b style="display:block;margin-top:14px">Baudrate</b><p class="note" style="margin:4px 0 10px">Alleen voor ontvangers met een CP210x/CH340-chip. u-blox native USB negeert dit.</p>
        <div class="mini-seg" id="baudSeg">${[9600, 38400, 115200].map((b) => `<button data-b="${b}" class="${S.settings.usbBaud === b ? "on" : ""}">${b}</button>`).join("")}</div></div>` : ""}
      ${k === "sim" ? `<div class="card" style="padding:16px;margin-bottom:10px"><b>Demo-auto</b><div class="mini-seg" id="simSeg2" style="margin-top:10px;justify-content:space-between">${Object.keys(E.SIM_CARS).map((c) => `<button data-c="${c}" class="${S.settings.simCar === c ? "on" : ""}">${{ screamer: "C63 840 pk", super: "Supercar", hyper: "Hypercar" }[c]}</button>`).join("")}</div></div>` : ""}
      <div class="gnss-live" id="gnssLive"></div>
      ${k === "usb" || k === "racebox" || k === "ble" ? `<button class="btn pri" id="srcConnect" style="margin-top:10px">${icon(k === "usb" ? "i-usb" : "i-bt")}${SRC.status.needConnect ? "Verbinden" : "Opnieuw verbinden"}</button>
        <p class="note">${k === "usb" ? "Steek de ontvanger in de USB-C-poort en sta USB-toegang toe. Hij wordt dan automatisch gebruikt tijdens een meting." : "Zet de ontvanger aan, tik op Verbinden en kies hem in de lijst."}</p>` : ""}`, (b) => {
      $$("[data-src]", b).forEach((x) => x.onclick = async () => {
        if (M.state !== "idle") { toast("Stop eerst de lopende meting"); return; }
        const id = x.dataset.src;
        if ((id === "usb" && !usbOk) || ((id === "racebox" || id === "ble") && !bleOk)) { toast("Niet ondersteund in deze browser — gebruik Chrome op Android"); return; }
        S.settings.source = id; save();
        await startSource(id === "phone" || id === "sim" ? false : true);
        renderAll(); openSourceSheet();
      });
      const c = $("#srcConnect", b); if (c) c.onclick = async () => { await startSource(true); openSourceSheet(); };
      const hz = $("#hzSeg", b); if (hz) hz.onclick = (e) => { const t = e.target.closest("button"); if (!t) return; S.settings.usbHz = +t.dataset.hz; save(); openSourceSheet(); if (SRC.cur && SRC.cur.dev) startSource(false); };
      const bd = $("#baudSeg", b); if (bd) bd.onclick = (e) => { const t = e.target.closest("button"); if (!t) return; S.settings.usbBaud = +t.dataset.b; save(); openSourceSheet(); };
      const sm = $("#simSeg2", b); if (sm) sm.onclick = (e) => { const t = e.target.closest("button"); if (!t) return; setSimCar(t.dataset.c); openSourceSheet(); };
      updateChip();
    });
  }
  function setSimCar(c) { S.settings.simCar = c; save(); if (S.settings.source === "sim") startSource(false); renderAll(); }
  $("#gpsChip").addEventListener("click", openSourceSheet);
  $("#rowSource").addEventListener("click", openSourceSheet);

  // ================= auto-keuze =================
  function openCarPicker() {
    openSheet(`<h2>Kies auto</h2>${S.cars.map((c) => `<button class="card opt ${c.id === S.activeCar ? "on" : ""}" data-car="${c.id}"><div class="thumb" style="width:54px;height:54px;border-radius:14px;background:var(--card-2) url('${esc(c.photo || "img/car-hood-purple.jpg")}') center/cover;flex:none"></div><div class="tx"><b>${esc(c.name)}</b><span>${esc([c.make, c.hp ? c.hp + " pk" : ""].filter(Boolean).join(" · "))}</span></div>${c.id === S.activeCar ? `<span class="pill">Actief</span>` : ""}</button>`).join("")}
      <button class="btn sec" id="toGarage">${icon("i-car")}Garage beheren</button>`, (b) => {
      $$("[data-car]", b).forEach((x) => x.onclick = () => { S.activeCar = x.dataset.car; save(); closeSheet(); renderAll(); });
      $("#toGarage", b).onclick = () => { closeSheet(); showTab("garage"); };
    });
  }

  // ================= garage =================
  function renderGarage() {
    $("#carList").innerHTML = S.cars.map((c) => {
      const n = S.runs.filter((r) => r.carId === c.id).length;
      return `<div class="card car ${c.id === S.activeCar ? "active" : ""}"><div class="bg" style="background-image:url('${esc(c.photo || "img/car-hood-purple.jpg")}')"></div>
        ${c.id === S.activeCar ? `<span class="tag gold badge">ACTIEF</span>` : ""}
        <div class="acts">${c.id !== S.activeCar ? `<button data-pick="${c.id}">Kies</button>` : ""}<button data-edit="${c.id}">Bewerk</button></div>
        ${c.logo ? `<img class="car-logo" src="${esc(c.logo)}" alt="">` : ""}
        <h3>${esc(c.name)}</h3><div class="mk">${esc([c.make, c.year, { rwd: "achterwiel", awd: "vierwiel", fwd: "voorwiel" }[c.drive], { auto: "automaat", dct: "DCT", manual: "handbak" }[c.gearbox]].filter(Boolean).join(" · "))}</div>
        <div class="specs">${c.hp ? `<span>${c.hp} PK</span>` : ""}${c.nm ? `<span>${c.nm} NM</span>` : ""}${c.kg ? `<span>${c.kg} KG</span>` : ""}${c.hp && c.kg ? `<span>${(c.kg / c.hp).toFixed(2)} KG/PK</span>` : ""}<span>${n} RUNS</span></div>
        ${c.notes ? `<div class="mk" style="margin-top:8px">${esc(c.notes)}</div>` : ""}</div>`;
    }).join("");
  }
  $("#carList").addEventListener("click", (e) => {
    const p = e.target.closest("[data-pick]"), ed = e.target.closest("[data-edit]");
    if (p) { S.activeCar = p.dataset.pick; save(); renderAll(); toast("Actieve auto gewijzigd"); }
    if (ed) openCarEditor(ed.dataset.edit);
  });
  $("#addCar").addEventListener("click", () => openCarEditor(null));

  function openCarEditor(id) {
    const c = id ? Object.assign({}, S.cars.find((x) => x.id === id)) : { id: null, name: "", make: "", year: "", hp: "", nm: "", kg: "", photo: "", notes: "" };
    let photo = c.photo, logo = c.logo || "";
    openSheet(`<h2>${id ? "Auto bewerken" : "Auto toevoegen"}</h2>
      <label class="photo-pick" id="pp" style="${photo ? `background-image:url('${esc(photo)}')` : ""}"><input type="file" accept="image/*" id="ppIn" hidden><span style="display:flex;gap:8px;align-items:center;background:rgba(10,7,18,.6);padding:8px 12px;border-radius:10px">${icon("i-cam")}Foto kiezen</span></label>
      <label class="field"><span>Naam</span><input id="fName" value="${esc(c.name)}" placeholder="bijv. Street Screamer"></label>
      <label class="field"><span>Merk & model</span><input id="fMake" value="${esc(c.make)}" placeholder="bijv. Mercedes-AMG C63 S"></label>
      <div class="grid3"><label class="field"><span>Vermogen (pk)</span><input id="fHp" type="number" inputmode="numeric" value="${esc(c.hp)}"></label>
      <label class="field"><span>Koppel (Nm)</span><input id="fNm" type="number" inputmode="numeric" value="${esc(c.nm)}"></label>
      <label class="field"><span>Gewicht (kg)</span><input id="fKg" type="number" inputmode="numeric" value="${esc(c.kg)}"></label></div>
      <div class="grid3" style="grid-template-columns:1fr"><label class="field"><span>Aandrijving</span><select id="fDrive">${[["rwd", "Achterwiel"], ["awd", "Vierwiel"], ["fwd", "Voorwiel"]].map(([v, n]) => `<option value="${v}" ${(c.drive || "rwd") === v ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      <label class="field"><span>Versnellingsbak</span><select id="fBox">${[["auto", "Automaat"], ["dct", "DCT / MCT"], ["manual", "Handgeschakeld"]].map(([v, n]) => `<option value="${v}" ${(c.gearbox || "auto") === v ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      <label class="field"><span>Banden</span><select id="fTires">${[["street", "Straat (zomer)"], ["semi", "Semi-slick"], ["drag", "Drag radial"], ["winter", "Winter"]].map(([v, n]) => `<option value="${v}" ${(c.tires || "street") === v ? "selected" : ""}>${n}</option>`).join("")}</select></label></div>
      <div class="grid3"><label class="field"><span>Top (km/u)</span><input id="fVmax" type="number" inputmode="numeric" value="${esc(c.vmax)}"></label>
      <label class="field"><span>Fabriek 0–100</span><input id="fFac" type="number" step="0.1" inputmode="decimal" value="${esc(c.factory0100)}" placeholder="s"></label>
      <label class="field"><span>Bouwjaar</span><input id="fYear" inputmode="numeric" value="${esc(c.year)}"></label></div>
      <div class="h-eyebrow" style="margin-top:14px">Jouw teller</div>
      <div class="logo-row"><label class="logo-pick" id="lp">${logo ? `<img src="${esc(logo)}" alt="">` : `${icon("i-upload")}<span>Eigen logo</span>`}<input type="file" accept="image/*" id="lpIn" hidden></label>
        <div style="flex:1;min-width:0"><label class="field"><span>Tellerstijl</span><select id="fGauge"><option value="default">Volg instellingen</option>${GAUGE_STYLES.concat([["eigen", "Eigen kleur"]]).map(([v, n]) => `<option value="${v}" ${c.gauge === v ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        <label class="field"><span>Accentkleur</span><input id="fAccent" type="color" value="${esc(c.accent || "#ff2f78")}"></label></div></div>
      <canvas id="gPrev" width="360" height="360" class="gprev"></canvas>
      <p class="note">Logo: upload een PNG met transparante achtergrond. Het blijft alleen op deze telefoon. ${logo ? `<button class="linkbtn" id="lpDel">Logo verwijderen</button>` : ""}</p>
      <label class="field"><span>Modificaties / notities</span><textarea id="fNotes" placeholder="bijv. Stage 3, downpipes, E85">${esc(c.notes)}</textarea></label>
      <button class="btn pri" id="fSave">Opslaan</button>
      ${id && S.cars.length > 1 ? `<div style="height:10px"></div><button class="btn danger" id="fDel">${icon("i-trash")}Auto verwijderen</button>` : ""}`, (b) => {
      $("#ppIn", b).onchange = async (e) => {
        const f = e.target.files[0]; if (!f) return;
        try { photo = await shrinkImage(f, 1000, 0.8); $("#pp", b).style.backgroundImage = `url('${photo}')`; } catch (err) { toast("Kon foto niet lezen"); }
      };
      const prev = () => {
        const cv = $("#gPrev", b); if (!cv) return; const x = cv.getContext("2d"); x.setTransform(2, 0, 0, 2, 0, 0);
        const gsel = $("#fGauge", b).value, st = gsel === "default" ? S.settings.gauge : gsel;
        let im = null; if (logo) { im = new Image(); im.src = logo; im.onload = () => { if (im === prevImg) draw(); }; }
        prevImg = im;
        const draw = () => drawGauge(x, 180, { v: 138, max: 200, step: 20, target: 100, style: st, unit: uLbl(), trail: [], sparks: [], accent: $("#fAccent", b).value, logo: im, g: { lat: 0.3, lon: 0.7, trail: [] } });
        draw();
      };
      let prevImg = null;
      prev();
      $("#fGauge", b).onchange = prev; $("#fAccent", b).oninput = prev;
      $("#lpIn", b).onchange = async (e) => {
        const f = e.target.files[0]; if (!f) return;
        try { logo = await shrinkImage(f, 400, 0.9, "image/png"); $("#lp", b).innerHTML = `<img src="${logo}" alt=""><input type="file" accept="image/*" id="lpIn2" hidden>`; if ($("#fGauge", b).value === "default") $("#fGauge", b).value = S.settings.gauge; prev(); } catch (err) { toast("Kon logo niet lezen"); }
      };
      const ld = $("#lpDel", b); if (ld) ld.onclick = (e) => { e.preventDefault(); logo = ""; $("#lp", b).innerHTML = `${icon("i-upload")}<span>Eigen logo</span>`; prev(); };
      $("#fSave", b).onclick = () => {
        const name = $("#fName", b).value.trim(); if (!name) { toast("Geef je auto een naam"); return; }
        const num = (s) => { const v = parseInt($(s, b).value, 10); return isFinite(v) ? v : ""; };
        const fac = parseFloat(($("#fFac", b).value || "").replace(",", "."));
        const car = { id: id || "c" + Date.now().toString(36), name, make: $("#fMake", b).value.trim(), year: $("#fYear", b).value.trim(), hp: num("#fHp"), nm: num("#fNm"), kg: num("#fKg"),
          drive: $("#fDrive", b).value, gearbox: $("#fBox", b).value, tires: $("#fTires", b).value, vmax: num("#fVmax"), factory0100: isFinite(fac) ? fac : "",
          photo, logo, gauge: $("#fGauge", b).value, accent: $("#fAccent", b).value, notes: $("#fNotes", b).value.trim() };
        if (id) S.cars[S.cars.findIndex((x) => x.id === id)] = car; else { S.cars.push(car); S.activeCar = car.id; }
        save(); closeSheet(); renderAll();
      };
      const d = $("#fDel", b);
      if (d) d.onclick = () => {
        if (!confirm(`"${c.name}" verwijderen? Je runs blijven bewaard.`)) return;
        S.cars = S.cars.filter((x) => x.id !== id); if (S.activeCar === id) S.activeCar = S.cars[0].id;
        save(); closeSheet(); renderAll();
      };
    });
  }
  function shrinkImage(file, max, q, type) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => { const im = new Image(); im.onload = () => { const s = Math.min(1, max / Math.max(im.width, im.height)); const c = document.createElement("canvas"); c.width = Math.round(im.width * s); c.height = Math.round(im.height * s); c.getContext("2d").drawImage(im, 0, 0, c.width, c.height); res(c.toDataURL(type || "image/jpeg", q)); }; im.onerror = rej; im.src = fr.result; };
      fr.onerror = rej; fr.readAsDataURL(file);
    });
  }

  // ================= resultaten =================
  let resFilter = "active";
  function runSplits(r) { // alle tijden uit een run: key → tijd
    const out = {};
    if (!r.res) return out;
    for (const s of r.res.speedSplits) out[`S:${r.unit}:${s.from}-${s.to}`] = s.time;
    for (const s of r.res.distSplits) out["D:" + s.id] = s.time;
    return out;
  }
  function metricLabel(key) {
    if (key.startsWith("S:")) { const [, u, p] = key.split(":"); return p.replace("-", "–") + " " + (u === "mph" ? "mph" : "km/u"); }
    const d = E.DISTANCES.find((x) => "D:" + x.id === key); return d ? d.label : key;
  }
  function filteredRuns() {
    if (resFilter === "all") return S.runs.filter((r) => !r.sim);
    if (resFilter === "demo") return S.runs.filter((r) => r.sim);
    if (resFilter === "active") return S.runs.filter((r) => r.carId === S.activeCar);
    return S.runs.filter((r) => r.carId === resFilter);
  }
  function pbTable(runs) {
    const pb = {};
    for (const r of runs) {
      const sp = runSplits(r);
      for (const k in sp) if (!pb[k] || sp[k] < pb[k].time) pb[k] = { time: sp[k], run: r };
    }
    return pb;
  }
  function renderResults() {
    const hasDemo = S.runs.some((r) => r.sim);
    const f = [["active", activeCar().name]].concat(S.cars.filter((c) => c.id !== S.activeCar).map((c) => [c.id, c.name]), [["all", "Alle auto's"]], hasDemo ? [["demo", "Demo"]] : []);
    if (!f.some((x) => x[0] === resFilter)) resFilter = "active";
    $("#resFilters").innerHTML = f.map(([id, n]) => `<button data-f="${id}" class="${id === resFilter ? "on" : ""}">${esc(n)}</button>`).join("");
    const runs = filteredRuns();
    const pb = pbTable(runs);
    const u = unit();
    const keys = [`S:${u}:0-${u === "mph" ? 60 : 100}`, `S:${u}:0-${u === "mph" ? 100 : 200}`, `S:${u}:${u === "mph" ? "60-130" : "100-200"}`, `S:${u}:0-${u === "mph" ? 150 : 300}`, `S:${u}:0-${u === "mph" ? 200 : 400}`, `S:${u}:0-${u === "mph" ? 300 : 500}`, "D:1/4", "D:1/8", "D:60ft", "D:1/2", "D:1mi"];
    const tiles = keys.filter((k) => pb[k]).map((k) => `<button class="card pb" data-run="${pb[k].run.id}"><div class="l">${metricLabel(k).toUpperCase()}</div><div class="v">${pb[k].time.toFixed(2)}<small>s</small></div><div class="d">${fmtDate(pb[k].run.ts, true)}</div></button>`);
    let top = null; for (const r of runs) if (r.res && (!top || r.res.peakV > top.res.peakV)) top = r;
    if (top) tiles.push(`<button class="card pb" data-run="${top.id}"><div class="l">TOPSNELHEID</div><div class="v">${Math.round(top.res.peakV / uf())}<small>${uLbl()}</small></div><div class="d">${fmtDate(top.ts, true)}</div></button>`);
    $("#pbGrid").innerHTML = tiles.length ? tiles.join("") : `<div class="card empty" style="grid-column:1/-1">${icon("i-trophy")}<div>Nog geen records. Tijd om te launchen!</div></div>`;
    $("#runList").innerHTML = runs.length ? runs.slice(0, 200).map((r) => {
      const p = r.primary;
      const isPb = p && pb[p.key] && pb[p.key].run.id === r.id;
      const slope = r.res && r.res.slope != null && Math.abs(r.res.slope) > 1;
      return `<button class="card run" data-run="${r.id}"><div class="big">${p ? p.time.toFixed(2) : "—"}<small>s</small></div>
        <div class="meta"><b>${esc(p ? p.label : "Onvolledig")} ${isPb ? `<span class="tag gold">${icon("i-trophy", "i")} PB</span>` : ""}${r.sim ? ` <span class="tag demo">DEMO</span>` : ""}${slope ? ` <span class="tag warn">${r.res.slope > 0 ? "+" : ""}${r.res.slope.toFixed(1)}%</span>` : ""}</b>
        <span>${esc(r.carName)} · ${fmtDate(r.ts)}</span><span>top ${Math.round((r.res ? r.res.peakV : 0) / (r.unit === "mph" ? E.MPH : E.KMH))} ${r.unit === "mph" ? "mph" : "km/u"} · ${r.res ? r.res.hz : "?"} Hz</span></div>${icon("i-chev", "i")}</button>`;
    }).join("") : `<div class="card empty">${icon("i-flag")}<div>Nog geen runs voor deze selectie.</div></div>`;
  }
  $("#resFilters").addEventListener("click", (e) => { const b = e.target.closest("[data-f]"); if (!b) return; resFilter = b.dataset.f; renderResults(); });
  $("#v-results").addEventListener("click", (e) => { const b = e.target.closest("[data-run]"); if (!b) return; const r = S.runs.find((x) => x.id === b.dataset.run); if (r) showResult(r, false); });

  function fmtDate(ts, short) {
    const d = new Date(ts);
    return short ? d.toLocaleDateString("nl-NL", { day: "numeric", month: "short", year: "2-digit" }) : d.toLocaleDateString("nl-NL", { weekday: "short", day: "numeric", month: "short" }) + " " + d.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
  }

  // ================= tips: zo word je sneller =================
  const SIM_META = {
    screamer: { hp: 840, nm: 1190, kg: 1950, drive: "rwd", gearbox: "auto", tires: "street" },
    super: { hp: 800, nm: 720, kg: 1480, drive: "rwd", gearbox: "dct", tires: "semi" },
    hyper: { hp: 1600, nm: 1500, kg: 1420, drive: "awd", gearbox: "dct", tires: "semi" },
  };
  function specFor(run) {
    if (run.sim) {
      const k = run.carId.split(":")[1] || "screamer";
      return { car: SIM_META[k], model: (o) => Object.assign({}, E.SIM_CARS[k], { launch0: 0.8 }, o || {}), sim: true };
    }
    const c = S.cars.find((x) => x.id === run.carId);
    if (!c || !c.hp || !c.kg) return null;
    return { car: c, model: (o) => E.carModel(Object.assign({}, c, o || {})) };
  }
  function predTime(truth, key, unitName) {
    const toK = (x) => Math.round(unitName === "mph" ? x * 1.609344 : x);
    if (key.startsWith("S:")) {
      const [a, b] = key.split(":")[2].split("-").map(Number);
      const tb = truth.cross[toK(b)], ta = a ? truth.cross[toK(a)] : truth.t0;
      return tb != null && ta != null ? (tb - ta) / 1000 : null;
    }
    const d = truth.dist[key.slice(2)];
    return d ? (d.t - truth.t0) / 1000 : null;
  }
  function stopFor(key, unitName) {
    if (key.startsWith("S:")) { const b = +key.split("-")[1]; return { stopV: ((unitName === "mph" ? b * 1.609344 : b) + 4) / 3.6 }; }
    const D = E.DISTANCES.find((x) => "D:" + x.id === key); return { stopD: (D ? D.m : 402) + 15 };
  }
  function shiftDips(tr) { // schakelmomenten: korte dalen in de versnelling
    const A = [];
    for (let i = 0, j = 0; i < tr.length; i++) { while (j < tr.length - 1 && tr[j][0] < tr[i][0] + 0.12) j++; const dt = tr[j][0] - tr[i][0]; if (dt > 0.05) A.push([tr[i][0], (tr[j][1] - tr[i][1]) / dt, tr[i][1]]); }
    const dips = [];
    for (let i = 3; i < A.length - 3; i++) {
      if (A[i][2] < 6) continue;
      const around = Math.max(...A.slice(Math.max(0, i - 12), i - 2).map((x) => x[1]), ...A.slice(i + 3, i + 13).map((x) => x[1]));
      if (A[i][1] < around * 0.55 && A[i][1] <= A[i - 1][1] && A[i][1] <= A[i + 1][1] && (!dips.length || A[i][0] - dips[dips.length - 1].t > 0.6)) {
        let k0 = i, k1 = i; while (k0 > 0 && A[k0][1] < around * 0.8) k0--; while (k1 < A.length - 1 && A[k1][1] < around * 0.8) k1++;
        dips.push({ t: A[i][0], ms: Math.round((A[k1][0] - A[k0][0]) * 1000) });
      }
    }
    return dips;
  }
  function tipsFor(run) {
    const p = run.primary, r = run.res, out = [];
    if (!p) return { head: null, tips: [{ ic: "i-flag", t: "Doel niet gehaald", x: "Houd het gas vol tot voorbij de doelsnelheid of -afstand. De meting stopt als je meer dan 15 km/u terugvalt." }] };
    const sp = specFor(run);
    const u = run.unit;
    let head = null;
    if (sp) {
      const stop = stopFor(p.key, u);
      const base = E.predict(sp.model(), stop);
      const pt = predTime(base, p.key, u);
      const gain = (o, extra) => { const t = predTime(E.predict(sp.model(o), stop), p.key, u); return t != null && pt != null ? pt - t : 0; };
      if (pt != null) {
        const gap = p.time - pt;
        head = { pt, gap, factory: p.key === `S:kmh:0-100` && sp.car.factory0100 ? +sp.car.factory0100 : null };
        // launch-fase
        const s50m = r.speedSplits.find((s) => s.from === 0 && s.to === (u === "mph" ? 30 : 50));
        const p50 = predTime(base, u === "mph" ? `S:mph:0-30` : `S:kmh:0-50`, u);
        const launchGap = s50m && p50 != null ? s50m.time - p50 : null;
        const drive = sp.car.drive || "rwd", nm = +sp.car.nm || 0;
        const muExp = ({ street: 1.15, semi: 1.35, drag: 1.7, winter: 0.8 }[sp.car.tires || "street"]) * ({ rwd: 0.73, awd: 1, fwd: 0.47 }[drive]);
        if (r.standing && launchGap != null && launchGap > 0.08) {
          const how = {
            rwd: `Achterwielaandrijving${nm > 600 ? ` met ${nm} Nm` : ""}: grip is de grens. Gebruik launch control (Race Start), launch met iets lagere toeren, zet ESP op Sport in plaats van helemaal uit en rij de achterbanden warm.`,
            awd: "Vierwielaandrijving: gebruik launch control en laat de elektronica het werk doen. Houd rem en gas vast tot de toeren stabiel zijn en laat de rem in één keer los.",
            fwd: "Voorwielaandrijving: wielspin kost hier de meeste tijd. Bouw het gas geleidelijk op in de eerste meters, launch met lage toeren en laat de tractiecontrole aan.",
          }[drive];
          out.push({ ic: "i-flame", t: "Tijd te winnen bij de launch", x: `0–${u === "mph" ? 30 : 50} ${u === "mph" ? "mph" : "km/u"} duurde ${s50m.time.toFixed(2)} s; haalbaar is ≈ ${p50.toFixed(2)} s. ${how}${r.peakG < muExp * 0.8 ? ` Je piek was ${r.peakG.toFixed(2)} G, terwijl ≈ ${muExp.toFixed(2)} G mogelijk is.` : ""}`, g: launchGap });
        }
        // banden
        const next = { winter: "street", street: "semi", semi: "drag" }[sp.car.tires || "street"];
        if (next && !sp.sim) {
          const g = gain({ tires: next });
          if (g > 0.03) out.push({ ic: "i-car", t: { street: "Zomerbanden", semi: "Semi-slicks", drag: "Drag radials" }[next] + " erop", x: { street: "Winterbanden kosten veel grip bij de launch. Op zomerbanden ben je meteen sneller.", semi: "Semi-slicks (bijv. Cup 2 of R888R) geven merkbaar meer grip bij het wegrijden. Op straatbanden helpt het ook om ze op te warmen en de bandenspanning iets te verlagen (binnen veilige grenzen).", drag: "Drag radials zijn de ultieme launchbanden. Alleen voor de dragstrip." }[next], g });
        }
        // schakelen
        // alleen betrouwbaar met IMU-fusie of snelle GPS; bij 1 Hz verzint de interpolatie vorm tussen de fixes
        const dips = r.fusion === "imu" || r.hz >= 8 ? shiftDips(r.trace).filter((d) => d.ms <= 1000) : [];
        if (dips.length) {
          const avg = Math.round(dips.reduce((a, d) => a + d.ms, 0) / dips.length);
          const box = sp.car.gearbox || "auto";
          const g = box === "manual" ? gain({ gearbox: "dct" }) : Math.max(0, dips.length * avg / 1000 * 0.25);
          out.push({ ic: "i-gauge", t: `${dips.length} schakelmoment${dips.length > 1 ? "en" : ""} · ≈ ${avg} ms per schakeling`, x: box === "manual" ? "Schakel sneller en koppel korter. Bij een handbak zit hier veel tijd, dus oefen powershifts niet te agressief." : "Zet de bak in de snelste modus (Race/S+) en laat hem vlak voor de begrenzer opschakelen. Schakel je handmatig, doe het dan net voor de begrenzer, niet erop.", g });
        }
        // gewicht
        const gw = gain({ kg: (+sp.car.kg || 1600) - 50 });
        if (gw > 0.01) out.push({ ic: "i-trophy", t: "Elke 50 kg telt", x: "Een lege kofferbak, een halve tank en geen passagier schelen al snel 50–80 kg.", g: gw });
        // vermogensfase
        const powerGap = launchGap != null ? head.gap - launchGap : head.gap;
        if (p.key.startsWith("S:") && powerGap > 0.25 && !sp.sim) out.push({ ic: "i-sun", t: "Vermogen blijft achter", x: `Boven de ${u === "mph" ? 30 : 50} ${u === "mph" ? "mph" : "km/u"} verlies je ≈ ${powerGap.toFixed(2)} s op wat ${sp.car.hp} pk zou moeten halen. Controleer: trage schakelmomenten (Race-modus aan), heat soak (laat de motor tussen runs afkoelen), 98/102 RON brandstof en de luchttemperatuur. Of de auto levert minder dan opgegeven.`, g: powerGap });
      }
    } else {
      out.push({ ic: "i-car", t: "Vul je auto aan in de garage", x: "Met pk, gewicht, aandrijving, bak en banden berekent de app wat haalbaar is en waar jij tijd verliest." });
    }
    // omstandigheden & meting
    if (r.slope != null && r.slope > 0.4) out.push({ ic: "i-flag", t: `Je reed bergop (+${r.slope.toFixed(1)}%)`, x: "Een helling kost tijd. Zoek een vlak stuk voor een eerlijke vergelijking.", g: null });
    if (r.slope != null && r.slope < -0.4) out.push({ ic: "i-flag", t: `Let op: bergaf (${r.slope.toFixed(1)}%)`, x: "Deze tijd is geflatteerd. Voor een echte record: meet op een vlak stuk of rij beide kanten en neem het gemiddelde.", g: null });
    if (r.hz < 5 && !run.sim) out.push({ ic: "i-sat", t: "Nauwkeuriger meten", x: `Je telefoon-GPS gaf ${r.hz} Hz. Een externe 10–25 Hz ontvanger (u-blox M10 via USB-C of een RaceBox) maakt vooral hoge snelheden veel preciezer.`, g: null });
    if (r.standing && !r.rolloutMs && p.key.startsWith("D:")) out.push({ ic: "i-info", t: "Vergelijken met de dragstrip?", x: "Zet in Instellingen '1 ft rollout' aan. Dragstrip-tijden starten pas na 30 cm, dat scheelt ≈ 0,2–0,3 s.", g: null });
    if (head) for (const t of out) if (t.g != null) t.g = Math.min(t.g, Math.max(0, head.gap));
    out.sort((a, b) => (b.g || 0) - (a.g || 0));
    return { head, tips: out.slice(0, 6) };
  }
  function renderTips(run) {
    const { head, tips } = tipsFor(run);
    let h = `<h4>ZO WORD JE SNELLER</h4>`;
    if (head) {
      const good = head.gap < 0.06;
      h += `<div class="pot"><div><span>JOUW TIJD</span><b>${run.primary.time.toFixed(2)} s</b></div><div><span>≈ HAALBAAR</span><b class="fl">${head.pt.toFixed(2)} s</b></div>${head.factory ? `<div><span>FABRIEK</span><b>${head.factory.toFixed(1)} s</b></div>` : `<div><span>MARGE</span><b>${good ? "—" : "−" + Math.max(0, head.gap).toFixed(2) + " s"}</b></div>`}</div>
        <p class="tipnote">${good ? "🔥 Je zit op het maximum van wat deze auto op papier kan. Sneller gaat alleen met meer grip, minder gewicht of meer vermogen." : `Op basis van ${esc(run.carName)}: vermogen, gewicht, aandrijving, bak en banden. De schatting gaat uit van een perfecte launch op een vlakke weg.`}</p>`;
    }
    h += tips.map((t) => `<div class="tip">${icon(t.ic, "i ic")}<div><b>${esc(t.t)}${t.g > 0.01 ? ` <span class="gain">≈ −${t.g.toFixed(2)} s</span>` : ""}</b><p>${esc(t.x)}</p></div></div>`).join("");
    $("#resTips").innerHTML = h;
  }

  // ================= resultaat-scherm =================
  let curRun = null;
  function showResult(run, fresh, quiet) {
    curRun = run;
    const r = run.res, uF = run.unit === "mph" ? E.MPH : E.KMH, uL = run.unit === "mph" ? "mph" : "km/u";
    const p = run.primary;
    // PB-vergelijking met eerdere runs van dezelfde auto
    const others = S.runs.filter((x) => x.id !== run.id && x.carId === run.carId && x.ts < run.ts);
    const prevPb = p ? pbTable(others)[p.key] : null;
    const isPb = p && (!prevPb || p.time < prevPb.time);
    $("#resEb").textContent = p ? p.label : "Doel niet gehaald";
    $("#resCar").textContent = run.carName;
    $("#resWhen").textContent = fmtDate(run.ts);
    const tags = [];
    if (p && isPb && others.some((x) => runSplits(x)[p.key] != null)) tags.push(`<span class="tag gold">${icon("i-trophy")} NIEUW RECORD${prevPb ? " · −" + (prevPb.time - p.time).toFixed(2) + " s" : ""}</span>`);
    else if (p && isPb) tags.push(`<span class="tag gold">${icon("i-trophy")} EERSTE RECORD</span>`);
    else if (p && prevPb) tags.push(`<span class="tag warn">+${(p.time - prevPb.time).toFixed(2)} s t.o.v. record</span>`);
    if (run.sim) tags.push(`<span class="tag demo">DEMO</span>`);
    if (run.redlight) tags.push(`<span class="tag warn">VROEGE START</span>`);
    if (r.slope != null && Math.abs(r.slope) > 1) tags.push(`<span class="tag warn">HELLING ${r.slope > 0 ? "+" : ""}${r.slope.toFixed(1)}%</span>`);
    $("#resTags").innerHTML = tags.join("");
    const dy = dyno(run);
    $("#resKpis").innerHTML = [["TOP", Math.round(r.peakV / uF), uL], ["PIEK G", r.peakG.toFixed(2), "g"], ["GPS", r.hz, "Hz"], ["≈ WIELVERM.", dy.hp, "pk"], ["≈ WIELKOPPEL", dy.nm, "Nm"], ["HELLING", r.slope == null ? "—" : (r.slope > 0 ? "+" : "") + r.slope.toFixed(1), r.slope == null ? "" : "%"]]
      .map(([l, v, s]) => `<div class="card"><span>${l}</span><b>${v}<small style="font-size:10px;color:var(--muted)"> ${s}</small></b></div>`).join("");
    const pk = p ? p.key : "";
    const sRows = r.speedSplits.map((s) => { const k = `S:${run.unit}:${s.from}-${s.to}`; return `<div class="split ${k === pk ? "prim" : ""}"><span class="n">${s.from}–${s.to} ${uL}</span><span class="t">${s.time.toFixed(2)} s</span><span class="x2">${run.unit === "mph" ? Math.round(s.dist * 3.28084) + " ft" : Math.round(s.dist) + " m"}</span></div>`; }).join("");
    const dRows = r.distSplits.map((s) => `<div class="split ${"D:" + s.id === pk ? "prim" : ""}"><span class="n">${s.label}</span><span class="t">${s.time.toFixed(2)} s</span><span class="x2">@ ${Math.round(s.trap / uF)} ${uL}</span></div>`).join("");
    $("#resSplits").innerHTML = (sRows ? `<h4>SNELHEID</h4>${sRows}` : "") + (dRows ? `<h4>AFSTAND</h4>${dRows}` : "");
    const srcName = { phone: "Telefoon-GPS", usb: "USB GNSS", racebox: "RaceBox", ble: "BLE GNSS", sim: "Simulator" }[run.src] || run.src;
    $("#resQual").textContent = `${srcName} · ${r.hz} Hz · ${r.fusion === "imu" ? "GPS + IMU-fusie" : "alleen GPS"} · start via ${r.t0Method === "imu" ? "IMU" : r.t0Method === "gps" ? "GPS" : "rolling"}${r.rolloutMs ? " · rollout " + r.rolloutMs + " ms" : ""}${r.meanAcc != null ? " · ±" + r.meanAcc + " m" : ""}`;
    $("#resBtns").innerHTML = `<button class="btn sec" id="rShare">${icon("i-share")}Delen</button>` + (fresh ? `<button class="btn pri" id="rAgain">${icon("i-play")}Opnieuw</button>` : `<button class="btn danger" id="rDel">${icon("i-trash")}Verwijder</button>`);
    if (fresh && CAM.lastVideo && quiet) $("#resBtns").insertAdjacentHTML("afterbegin", `<button class="btn pri" id="rVid" style="grid-column:1/-1">${icon("i-save")}Video met overlay opslaan</button>`);
    const rv = $("#rVid"); if (rv) rv.onclick = saveVideo;
    $("#rShare").onclick = () => shareRun(run);
    if (fresh) $("#rAgain").onclick = () => { closeResult(); setTimeout(startMeasure, 250); };
    else $("#rDel").onclick = () => { if (!confirm("Deze run verwijderen?")) return; S.runs = S.runs.filter((x) => x.id !== run.id); save(); closeResult(); renderResults(); };
    $("#result").classList.add("open");
    $("#result").scrollTop = 0;
    requestAnimationFrame(() => drawChart(run));
    try { renderTips(run); } catch (e) { console.error(e); $("#resTips").innerHTML = ""; }
    // tijd-teller
    const target = p ? p.time : 0, el = $("#resTime");
    if (fresh && p) {
      const t0 = performance.now(), D = 1100;
      const step = () => { const k = Math.min(1, (performance.now() - t0) / D), e = 1 - Math.pow(2, -10 * k); el.textContent = (target * e).toFixed(2); if (k < 1) requestAnimationFrame(step); else el.textContent = target.toFixed(2); };
      step();
      setTimeout(() => burst(isPb ? 260 : 150), 450);
      if (!quiet) { [880, 1175, 1568, 2093].forEach((f, i) => beep(f, 0.18, "triangle", 0.09, 0.45 + i * 0.09)); vibe([60, 40, 140]); }
    } else el.textContent = p ? p.time.toFixed(2) : "—";
    history.pushState({ result: 1 }, "");
  }
  function closeResult() { $("#result").classList.remove("open"); curRun = null; renderMeten(); }
  $("#resClose").addEventListener("click", () => { if (history.state && history.state.result) history.back(); else closeResult(); });
  window.addEventListener("popstate", () => { if ($("#result").classList.contains("open")) closeResult(); else if ($("#sheet").classList.contains("open")) closeSheet(); else if ($("#hud").classList.contains("open")) closeHud(); else if (CAM.on) closeCam(); });

  // snelheid-tijd grafiek met scrubben
  let chartState = null;
  function drawChart(run, scrubX) {
    const cv = $("#resChart"), ctx = cv.getContext("2d"), dpr = Math.min(3, devicePixelRatio || 1);
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w) return;
    cv.width = w * dpr; cv.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const uF = run.unit === "mph" ? E.MPH : E.KMH, tr = run.res.trace.filter((p) => p[0] >= -0.05);
    if (tr.length < 2) return;
    const pl = 34, pr = 10, pt = 14, pb = 24;
    const tMax = tr[tr.length - 1][0], vMaxRaw = Math.max(...tr.map((p) => p[1] / uF));
    const vStep = vMaxRaw > 300 ? 100 : vMaxRaw > 120 ? 50 : 20, vMax = Math.ceil(vMaxRaw / vStep) * vStep || 100;
    const X = (t) => pl + (t / tMax) * (w - pl - pr), Y = (v) => h - pb - (v / vMax) * (h - pt - pb);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '500 10px "JetBrains Mono", monospace'; ctx.fillStyle = "rgba(173,158,196,.8)"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let v = 0; v <= vMax; v += vStep) { ctx.strokeStyle = "rgba(244,238,251,.07)"; ctx.beginPath(); ctx.moveTo(pl, Y(v)); ctx.lineTo(w - pr, Y(v)); ctx.stroke(); ctx.fillText(v, pl - 6, Y(v)); }
    const tStep = tMax > 30 ? 10 : tMax > 12 ? 2 : 1;
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let t = 0; t <= tMax; t += tStep) ctx.fillText(t + "s", X(t), h - pb + 6);
    // vulling
    const fg = ctx.createLinearGradient(0, pt, 0, h - pb); fg.addColorStop(0, "rgba(255,47,120,.45)"); fg.addColorStop(1, "rgba(162,56,255,0)");
    ctx.beginPath(); ctx.moveTo(X(tr[0][0]), Y(0)); tr.forEach((p) => ctx.lineTo(X(p[0]), Y(p[1] / uF))); ctx.lineTo(X(tr[tr.length - 1][0]), Y(0)); ctx.closePath(); ctx.fillStyle = fg; ctx.fill();
    const lg = ctx.createLinearGradient(pl, 0, w - pr, 0); lg.addColorStop(0, "#a238ff"); lg.addColorStop(0.5, "#ff2f78"); lg.addColorStop(1, "#ff7a3d");
    ctx.beginPath(); tr.forEach((p, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(p[0]), Y(p[1] / uF)));
    ctx.strokeStyle = lg; ctx.lineWidth = 2.5; ctx.shadowColor = "#ff2f78"; ctx.shadowBlur = 12; ctx.stroke(); ctx.shadowBlur = 0;
    // primaire split markeren
    const p = run.primary;
    if (p) {
      const t = run.res.standing || p.key.startsWith("D:") ? p.time : null;
      if (t != null && t <= tMax) {
        const v = E.linInterp(tr.map((q) => q[0]), tr.map((q) => q[1] / uF), t);
        ctx.setLineDash([4, 4]); ctx.strokeStyle = "rgba(255,214,140,.6)"; ctx.beginPath(); ctx.moveTo(X(t), pt); ctx.lineTo(X(t), h - pb); ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(X(t), Y(v), 5, 0, TAU); ctx.fillStyle = "#ffd68c"; ctx.shadowColor = "#ff7a3d"; ctx.shadowBlur = 12; ctx.fill(); ctx.shadowBlur = 0;
        ctx.fillStyle = "#ffd68c"; ctx.font = '700 11px "JetBrains Mono", monospace'; ctx.textAlign = X(t) > w - 80 ? "right" : "left"; ctx.textBaseline = "bottom";
        ctx.fillText(p.time.toFixed(2) + " s", X(t) + (ctx.textAlign === "left" ? 7 : -7), Y(v) - 4);
      }
    }
    if (scrubX != null) {
      const t = Math.max(0, Math.min(tMax, ((scrubX - pl) / (w - pl - pr)) * tMax));
      const ts = tr.map((q) => q[0]);
      const v = E.linInterp(ts, tr.map((q) => q[1] / uF), t), d = E.linInterp(ts, tr.map((q) => q[2]), t);
      ctx.strokeStyle = "rgba(255,255,255,.5)"; ctx.beginPath(); ctx.moveTo(X(t), pt); ctx.lineTo(X(t), h - pb); ctx.stroke();
      ctx.beginPath(); ctx.arc(X(t), Y(v), 5, 0, TAU); ctx.fillStyle = "#fff"; ctx.fill();
      const txt = `${t.toFixed(2)} s · ${Math.round(v)} ${run.unit === "mph" ? "mph" : "km/u"} · ${run.unit === "mph" ? Math.round(d * 3.28084) + " ft" : Math.round(d) + " m"}`;
      ctx.font = '700 11px "JetBrains Mono", monospace'; const tw = ctx.measureText(txt).width + 16;
      const bx = Math.max(pl, Math.min(w - pr - tw, X(t) - tw / 2));
      ctx.fillStyle = "rgba(20,12,31,.92)"; ctx.strokeStyle = "rgba(255,47,120,.6)"; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(bx, pt - 2, tw, 22, 7) : ctx.rect(bx, pt - 2, tw, 22); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#fff"; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillText(txt, bx + 8, pt + 9);
    }
    chartState = run;
  }
  const chartEl = $("#resChart");
  const scrub = (e) => { if (!chartState) return; const r = chartEl.getBoundingClientRect(); const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left; drawChart(chartState, x); };
  chartEl.addEventListener("pointerdown", (e) => { chartEl.setPointerCapture(e.pointerId); scrub(e); });
  chartEl.addEventListener("pointermove", (e) => { if (e.buttons || e.pointerType === "touch") scrub(e); });
  chartEl.addEventListener("pointerup", () => chartState && drawChart(chartState));

  // vuurwerk
  const fx = $("#fx"), fxc = fx.getContext("2d");
  let parts = [], fxOn = false;
  function burst(n) { const tEl = $("#resTime").getBoundingClientRect(); burstAt(tEl.left + tEl.width / 2, tEl.top + tEl.height / 2, n); }
  function burstAt(cx, cy, n) {
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (!fxOn) { fx.width = innerWidth * dpr; fx.height = innerHeight * dpr; fxc.setTransform(dpr, 0, 0, dpr, 0, 0); }
    const cols = ["255,122,61", "255,47,120", "255,214,140", "193,132,255", "162,56,255", "255,255,255"];
    for (let i = 0; i < n; i++) { const a = Math.random() * TAU, s = 180 + Math.random() * 620; parts.push({ x: cx, y: cy, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 200, life: 1, dec: 0.45 + Math.random() * 0.5, w: 1.5 + Math.random() * 2.5, c: cols[(Math.random() * cols.length) | 0] }); }
    if (!fxOn) { fxOn = true; let last = performance.now(); const loop = () => { const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now; fxc.clearRect(0, 0, innerWidth, innerHeight); fxc.globalCompositeOperation = "lighter"; for (const p of parts) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 520 * dt; p.vx *= 0.99; p.life -= dt * p.dec; fxc.beginPath(); fxc.moveTo(p.x, p.y); fxc.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03); fxc.strokeStyle = `rgba(${p.c},${Math.max(0, p.life)})`; fxc.lineWidth = p.w; fxc.stroke(); } fxc.globalCompositeOperation = "source-over"; parts = parts.filter((p) => p.life > 0); if (parts.length) requestAnimationFrame(loop); else { fxOn = false; fxc.clearRect(0, 0, innerWidth, innerHeight); } }; loop(); }
  }

  // deelkaart
  function loadImg(src) { return new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src; }); }
  async function shareRun(run) {
    const c = await makeCard(run), p = run.primary;
    const blob = await new Promise((res) => c.toBlob(res, "image/png"));
    const file = new File([blob], `screamtime-${(p ? p.label : "run").replace(/[^a-z0-9]+/gi, "-")}.png`, { type: "image/png" });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: "ScreamTime", text: `${p ? p.label + " in " + p.time.toFixed(2) + " s" : "Run"} — ${run.carName}` }); return; }
    } catch (e) { if (e && e.name === "AbortError") return; }
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast("Afbeelding opgeslagen");
  }
  async function makeCard(run) {
    const W = 1080, H = 1350, c = document.createElement("canvas"); c.width = W; c.height = H;
    const x = c.getContext("2d");
    await (document.fonts ? document.fonts.ready : Promise.resolve());
    const car = S.cars.find((k) => k.id === run.carId);
    const im = await loadImg(run.sim ? "img/car-burnout-smoke.jpg" : (car && car.photo) || "img/car-hood-purple.jpg");
    x.fillStyle = "#07040d"; x.fillRect(0, 0, W, H);
    if (im) { const s = Math.max(W / im.width, (H * 0.72) / im.height); x.globalAlpha = 0.72; x.drawImage(im, (W - im.width * s) / 2, 0, im.width * s, im.height * s); x.globalAlpha = 1; }
    let g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, "rgba(7,4,13,.2)"); g.addColorStop(0.45, "rgba(7,4,13,.55)"); g.addColorStop(0.72, "#07040d"); x.fillStyle = g; x.fillRect(0, 0, W, H);
    g = x.createRadialGradient(W / 2, H * 0.45, 10, W / 2, H * 0.45, W * 0.7); g.addColorStop(0, "rgba(255,47,120,.28)"); g.addColorStop(1, "rgba(255,47,120,0)"); x.fillStyle = g; x.fillRect(0, 0, W, H);
    // logo
    const lg = x.createLinearGradient(60, 0, 380, 0); lg.addColorStop(0, "#ff7a3d"); lg.addColorStop(0.55, "#ff2f78"); lg.addColorStop(1, "#a238ff");
    x.lineWidth = 9; x.lineCap = "round"; x.strokeStyle = lg; x.beginPath(); x.arc(108, 110, 38, Math.PI * 0.75, Math.PI * 2.25); x.stroke();
    x.strokeStyle = "#fff"; x.lineWidth = 6; x.beginPath(); x.moveTo(96, 124); x.lineTo(130, 88); x.stroke();
    x.font = "44px Anton, Impact"; x.fillStyle = "#fff"; x.textBaseline = "middle"; x.fillText("SCREAM", 168, 102);
    x.fillStyle = lg; x.fillText("TIME", 168 + x.measureText("SCREAM").width, 102);
    x.font = "700 15px Inter, sans-serif"; x.fillStyle = "rgba(244,238,251,.7)"; x.fillText("S T R E E T   S C R E A M E R", 170, 138);
    // tijd
    const p = run.primary, uF = run.unit === "mph" ? E.MPH : E.KMH, uL = run.unit === "mph" ? "MPH" : "KM/U";
    x.textAlign = "center"; x.textBaseline = "alphabetic";
    x.font = "800 34px Inter, sans-serif"; x.fillStyle = "#ffd0b8"; x.fillText((p ? p.label : "RUN").toUpperCase().split("").join(" "), W / 2, 560);
    x.font = "300px Anton, Impact"; const tg = x.createLinearGradient(0, 600, 0, 880); tg.addColorStop(0, "#fff"); tg.addColorStop(0.55, "#ffc2a3"); tg.addColorStop(1, "#ff2f78");
    x.shadowColor = "rgba(255,47,120,.7)"; x.shadowBlur = 60; x.fillStyle = tg;
    const ts = p ? p.time.toFixed(2) : "—", tw = x.measureText(ts).width;
    x.fillText(ts, W / 2 - 30, 880); x.shadowBlur = 0;
    x.font = "90px Anton, Impact"; x.fillStyle = "rgba(244,238,251,.7)"; x.textAlign = "left"; x.fillText("s", W / 2 - 30 + tw / 2 + 10, 880);
    x.textAlign = "center";
    const lgc = car && car.logo ? await loadImg(car.logo) : null;
    if (lgc) { const lh = 90, lw = Math.min(260, lh * lgc.width / lgc.height); x.drawImage(lgc, W - 60 - lw, 60, lw, lw * lgc.height / lgc.width); }
    x.font = "700 40px Inter, sans-serif"; x.fillStyle = "#fff"; x.fillText(run.carName, W / 2, 960);
    x.font = "500 26px 'JetBrains Mono', monospace"; x.fillStyle = "rgba(173,158,196,.9)"; x.fillText(fmtDate(run.ts), W / 2, 1004);
    // kpi's
    const r = run.res, kp = [["TOP", Math.round(r.peakV / uF) + " " + uL], ["PIEK", r.peakG.toFixed(2) + " G"], ["GPS", r.hz + " HZ"]];
    const splits = r.speedSplits.filter((s) => s.from === 0).slice(-3).map((s) => [`0-${s.to}`, s.time.toFixed(2) + " s"]).concat(r.distSplits.filter((s) => ["60ft", "1/8", "1/4"].includes(s.id)).map((s) => [s.label.toUpperCase(), s.time.toFixed(2) + " s"])).slice(0, 3);
    const rowsDraw = (items, y) => items.forEach(([l, v], i) => {
      const cx = W / 2 + (i - (items.length - 1) / 2) * 320;
      x.fillStyle = "rgba(34,21,51,.85)"; x.strokeStyle = "rgba(244,238,251,.12)"; x.lineWidth = 2;
      x.beginPath(); x.roundRect ? x.roundRect(cx - 145, y, 290, 118, 26) : x.rect(cx - 145, y, 290, 118); x.fill(); x.stroke();
      x.font = "800 20px Inter, sans-serif"; x.fillStyle = "rgba(173,158,196,.9)"; x.fillText(l.split("").join(" "), cx, y + 42);
      x.font = "700 40px 'JetBrains Mono', monospace"; x.fillStyle = "#fff"; x.fillText(v, cx, y + 92);
    });
    rowsDraw(kp, 1052);
    if (splits.length) rowsDraw(splits, 1190);
    return c;
  }

  // ================= instellingen =================
  const GAUGE_STYLES = [["screamer", "Screamer"], ["villain", "Villain"], ["hyper", "Hyper"], ["gforce", "G-Force"], ["classic", "Classic"], ["rosso", "Rosso"], ["wit", "Wit"], ["affalterbach", "Affalterbach"], ["munchen", "München"], ["maranello", "Maranello"], ["zuffenhausen", "Zuffenhausen"], ["santagata", "Sant'Agata"]];
  function renderSettings() {
    const k = S.settings.source;
    $("#srcDesc").textContent = { phone: "Telefoon-GPS", usb: "USB-C GNSS-ontvanger", racebox: "RaceBox (Bluetooth)", ble: "Bluetooth NMEA-ontvanger", sim: "Demo-modus" }[k];
    $$("#unitSeg button").forEach((b) => b.classList.toggle("on", b.dataset.u === unit()));
    $$("#simSeg button").forEach((b) => b.classList.toggle("on", b.dataset.c === S.settings.simCar));
    $("#setRollout").checked = S.settings.rollout; $("#setSound").checked = S.settings.sound; $("#setVibe").checked = S.settings.vibe; $("#setWake").checked = S.settings.wake;
    $("#ver").textContent = VERSION;
    $("#backupInfo").textContent = S.backupAt ? `Laatste back-up: ${fmtDate(S.backupAt, true)} · ${S.runs.length} runs` : `Nog geen back-up · ${S.runs.length} runs`;
    const styles = GAUGE_STYLES;
    const list = $("#styleList");
    if (!list.children.length) list.innerHTML = styles.map(([id, n]) => `<button data-st="${id}"><canvas width="192" height="192"></canvas>${n}</button>`).join("");
    $$("button", list).forEach((b) => {
      b.classList.toggle("on", b.dataset.st === S.settings.gauge);
      const cv = b.querySelector("canvas"), cx = cv.getContext("2d"); cx.setTransform(2, 0, 0, 2, 0, 0);
      drawGauge(cx, 96, { v: unit() === "mph" ? 88 : 138, max: unit() === "mph" ? 140 : 200, step: unit() === "mph" ? 20 : 20, target: unit() === "mph" ? 60 : 100, style: b.dataset.st, unit: uLbl(), trail: [], sparks: [], g: { lat: 0.35, lon: 0.7, trail: [[0, 0], [0.05, 0.3], [0.15, 0.55], [0.35, 0.7]] } });
    });
  }
  $("#styleList").addEventListener("click", (e) => { const b = e.target.closest("[data-st]"); if (!b) return; S.settings.gauge = b.dataset.st; save(); renderSettings(); });
  $("#unitSeg").addEventListener("click", (e) => { const b = e.target.closest("[data-u]"); if (!b || M.state !== "idle") return; S.settings.unit = b.dataset.u; save(); _tcKey = ""; renderAll(); });
  $("#simSeg").addEventListener("click", (e) => { const b = e.target.closest("[data-c]"); if (!b) return; setSimCar(b.dataset.c); });
  [["#setRollout", "rollout"], ["#setSound", "sound"], ["#setVibe", "vibe"], ["#setWake", "wake"]].forEach(([s, k]) => $(s).addEventListener("change", (e) => { S.settings[k] = e.target.checked; save(); if (k === "wake" && e.target.checked) requestWake(); }));

  $("#rowExport").addEventListener("click", async () => {
    S.backupAt = Date.now(); save();
    const blob = new Blob([JSON.stringify(S)], { type: "application/json" });
    const name = `screamtime-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([blob], name, { type: "application/json" });
    try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: "ScreamTime back-up" }); renderSettings(); return; } } catch (e) { if (e && e.name === "AbortError") return; }
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    renderSettings(); toast("Back-up opgeslagen");
  });
  $("#importFile").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      if (!j || j.v !== 1 || !Array.isArray(j.runs) || !Array.isArray(j.cars)) throw new Error("bad");
      if (!confirm(`Back-up terugzetten? ${j.cars.length} auto's en ${j.runs.length} runs. Dit vervangt je huidige gegevens.`)) return;
      localStorage.setItem(KEY, JSON.stringify(j)); S = load(); renderAll(); toast("Back-up teruggezet");
    } catch (err) { toast("Dit is geen geldig back-upbestand"); }
    e.target.value = "";
  });

  // ================= telemetrie (G-bol, vermogen, kracht, koppel) =================
  const WHEEL_R = 0.345, CDA = 0.7, CRR = 0.012;
  function carMass() { const m = S.settings.source === "sim" ? E.SIM_CARS[S.settings.simCar].m : +activeCar().kg || 1700; return m + 80; }
  function roadForce(m, a, v) { return m * a + 0.5 * 1.2 * CDA * v * v + CRR * m * E.G; }
  function updateTel(dt) {
    const v = SRC.lastFix && !SRC.nofix ? SRC.lastFix.v : 0;
    let lon = TEL.aGps;
    if (SRC.imu && SRC.imu.active && v > 1) {
      const lat = TEL.latA, imuLon = Math.sign(TEL.aGps || 1) * Math.sqrt(Math.max(0, gEma * gEma - lat * lat));
      lon = 0.5 * TEL.aGps + 0.5 * imuLon;
    }
    if (v < 0.5 && M.state !== "running") lon = 0;
    const k = 1 - Math.exp(-dt * 8);
    TEL.lonG += (lon / E.G - TEL.lonG) * k;
    TEL.latG += ((v > 2 ? TEL.latA : 0) / E.G - TEL.latG) * k;
    TEL.trail.push([TEL.latG, TEL.lonG]); if (TEL.trail.length > 70) TEL.trail.shift();
    const m = carMass();
    const F = v > 2 && lon > 0 ? roadForce(m, lon, v) : 0;
    TEL.kN += (F / 1000 - TEL.kN) * k;
    TEL.hp += ((F * v) / 735.5 - TEL.hp) * k;
    TEL.nm += (F * WHEEL_R - TEL.nm) * k;
    if (M.state === "running") { TEL.peakHp = Math.max(TEL.peakHp, TEL.hp); }
  }
  function dyno(run) {
    const tr = run.res.trace, m = run.mass || 1780;
    let hp = 0, F = 0;
    for (let i = 0, j = 0; i < tr.length; i++) {
      while (j < tr.length - 1 && tr[j][0] < tr[i][0] + 0.3) j++;
      const dt = tr[j][0] - tr[i][0];
      if (dt < 0.2 || tr[i][0] < 0) continue;
      const a = (tr[j][1] - tr[i][1]) / dt, vm = (tr[i][1] + tr[j][1]) / 2;
      if (a <= 0 || vm < 3) continue;
      const f = roadForce(m, a, vm);
      F = Math.max(F, f); hp = Math.max(hp, (f * vm) / 735.5);
    }
    return { hp: Math.round(hp), kN: F / 1000, nm: Math.round(F * WHEEL_R) };
  }

  function drawGBall(ctx, cx, cy, r, latG, lonG, trail, opt) {
    opt = opt || {};
    const maxG = 1.5, sc = r / maxG;
    ctx.save();
    const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 1.08);
    bg.addColorStop(0, opt.solid ? "#1d1030" : "rgba(29,16,48,.62)"); bg.addColorStop(1, opt.solid ? "#07040d" : "rgba(7,4,13,.72)");
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.08, 0, TAU); ctx.fillStyle = bg; ctx.fill();
    ctx.lineWidth = Math.max(1, r * 0.012); ctx.strokeStyle = "rgba(193,132,255,.45)"; ctx.stroke();
    [0.5, 1, 1.5].forEach((g) => { ctx.beginPath(); ctx.arc(cx, cy, g * sc, 0, TAU); ctx.strokeStyle = g === 1 ? "rgba(255,47,120,.45)" : "rgba(244,238,251,.14)"; ctx.lineWidth = Math.max(1, r * 0.008); ctx.stroke(); });
    ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r); ctx.strokeStyle = "rgba(244,238,251,.12)"; ctx.stroke();
    ctx.font = `800 ${Math.max(8, r * 0.085)}px Inter, sans-serif`; ctx.fillStyle = "rgba(173,158,196,.85)"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("ACCEL", cx, cy - r * 0.86); ctx.fillText("REM", cx, cy + r * 0.86);
    ctx.font = `500 ${Math.max(7, r * 0.07)}px "JetBrains Mono", monospace`; ctx.fillStyle = "rgba(255,90,143,.8)"; ctx.fillText("1G", cx + sc * 0.72, cy - sc * 0.72);
    const P = (lat, lon) => [cx + Math.max(-maxG, Math.min(maxG, lat)) * sc, cy - Math.max(-maxG, Math.min(maxG, lon)) * sc];
    if (trail && trail.length > 1) {
      for (let i = 1; i < trail.length; i++) {
        const [x1, y1] = P(trail[i - 1][0], trail[i - 1][1]), [x2, y2] = P(trail[i][0], trail[i][1]);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.strokeStyle = `rgba(255,122,61,${(i / trail.length) * 0.7})`; ctx.lineWidth = r * 0.03; ctx.lineCap = "round"; ctx.stroke();
      }
    }
    const [bx, by] = P(latG, lonG);
    ctx.beginPath(); ctx.arc(bx, by, r * 0.075, 0, TAU); ctx.fillStyle = "#ffd68c"; ctx.shadowColor = "#ff2f78"; ctx.shadowBlur = r * 0.2; ctx.fill(); ctx.shadowBlur = 0;
    ctx.beginPath(); ctx.arc(bx, by, r * 0.035, 0, TAU); ctx.fillStyle = "#fff"; ctx.fill();
    ctx.restore();
  }

  // ================= camera-modus =================
  const CAM = { awaitEnd: null, outro: null, peak: 0, hist: [], moved: false, stillSince: null, on: false, stream: null, rec: null, chunks: [], recStart: 0, facing: "environment", lastVideo: null, finalRun: null, finalAt: 0, autoStopT: null, gCv: document.createElement("canvas"), W: 0, H: 0 };
  const camCv = $("#camCanvas"), camCtx = camCv.getContext("2d"), camVid = $("#camVideo");
  function sizeCam() {
    if (CAM.rec) return; // tijdens opname niet van formaat wisselen
    const w = innerWidth, h = innerHeight, s = 1280 / Math.max(w, h);
    CAM.W = Math.round(w * s); CAM.H = Math.round(h * s); camCv.width = CAM.W; camCv.height = CAM.H;
  }
  async function startCamStream() {
    if (CAM.stream) CAM.stream.getTracks().forEach((t) => t.stop());
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("camera wordt niet ondersteund");
    const video = { facingMode: { ideal: CAM.facing }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
    let st;
    try { st = await navigator.mediaDevices.getUserMedia({ video, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
    catch (e) { st = await navigator.mediaDevices.getUserMedia({ video, audio: false }); }
    CAM.stream = st; camVid.srcObject = st; await camVid.play().catch(() => {});
  }
  async function openCam() {
    unlockAudio();
    $("#cam").classList.add("open"); sizeCam(); CAM.on = true; requestWake();
    $("#camAuto").classList.toggle("on", S.settings.autoRec !== false);
    history.pushState({ cam: 1 }, "");
    camLoop();
    try { await startCamStream(); } catch (e) { toast("Camera niet beschikbaar — " + (e.name === "NotAllowedError" ? "sta cameratoegang toe" : e.message), 4000); }
  }
  function closeCam() {
    CAM.awaitEnd = null; CAM.outro = null; clearTimeout(CAM.autoStopT);
    if (CAM.rec) stopRec();
    CAM.on = false; $("#cam").classList.remove("open");
    if (CAM.stream) CAM.stream.getTracks().forEach((t) => t.stop()); CAM.stream = null;
  }
  function camLoop() { if (!CAM.on) return; try { drawCam(); } catch (e) { console.error(e); } requestAnimationFrame(camLoop); }

  function startRec() {
    if (CAM.rec || !window.MediaRecorder) { if (!window.MediaRecorder) toast("Opnemen wordt niet ondersteund"); return; }
    const vs = camCv.captureStream(30), tracks = vs.getVideoTracks();
    const at = CAM.stream && CAM.stream.getAudioTracks()[0]; if (at) tracks.push(at);
    const types = ["video/mp4;codecs=avc1,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    const mt = types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
    try { CAM.rec = new MediaRecorder(new MediaStream(tracks), mt ? { mimeType: mt, videoBitsPerSecond: 8e6 } : undefined); }
    catch (e) { toast("Opnemen mislukt: " + e.message); return; }
    CAM.chunks = []; CAM.recStart = performance.now();
    CAM.rec.ondataavailable = (e) => { if (e.data && e.data.size) CAM.chunks.push(e.data); };
    CAM.rec.onstop = () => {
      const type = CAM.rec.mimeType || mt || "video/webm", ext = type.includes("mp4") ? "mp4" : "webm";
      const blob = new Blob(CAM.chunks, { type });
      const d = new Date(), pad = (n) => String(n).padStart(2, "0");
      CAM.lastVideo = { blob, name: `screamtime-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`, type };
      CAM.rec = null; $("#camRec").classList.remove("on");
      const b = $("#camSave"); b.hidden = false; b.querySelector("span").textContent = `Video opslaan (${(blob.size / 1048576).toFixed(0)} MB)`;
    };
    CAM.rec.start(1000); $("#camRec").classList.add("on"); $("#camSave").hidden = true; vibe(30);
  }
  function stopRec() { if (CAM.rec && CAM.rec.state !== "inactive") CAM.rec.stop(); clearTimeout(CAM.autoStopT); }
  // Na de finish filmt de camera door tot je gas los laat of stilstaat, toont dan 3 s de uitslag en stopt.
  function startOutro() {
    if (!CAM.awaitEnd || CAM.outro) return;
    clearTimeout(CAM.autoStopT);
    CAM.outro = performance.now();
    CAM.autoStopT = setTimeout(endCamRun, 3000);
  }
  function endCamRun() {
    const a = CAM.awaitEnd; CAM.awaitEnd = null; CAM.outro = null; clearTimeout(CAM.autoStopT);
    if (CAM.rec) stopRec();
    if (a && CAM.on) showResult(a.run, true, true);
  }
  function camWatch(f) {
    if (!CAM.on) return;
    if (CAM.awaitEnd && !CAM.outro) {
      CAM.peak = Math.max(CAM.peak, f.v);
      CAM.hist.push([f.t, f.v]); while (CAM.hist.length && CAM.hist[0][0] < f.t - 3000) CAM.hist.shift();
      if (f.v < 3 * E.KMH || liftDetected(CAM.hist, f, CAM.peak)) startOutro();
    } else if (CAM.rec && M.state === "idle" && !CAM.awaitEnd) { // handmatige opname: stoppen bij stilstand na een rit
      if (f.v > 20 * E.KMH) CAM.moved = true;
      if (CAM.moved && f.v < 3 * E.KMH) {
        if (CAM.stillSince == null) CAM.stillSince = f.t;
        else if (f.t - CAM.stillSince > 2500) { stopRec(); CAM.moved = false; CAM.stillSince = null; toast("Stilstand — opname gestopt"); }
      } else CAM.stillSince = null;
    }
  }
  async function saveVideo() {
    const v = CAM.lastVideo; if (!v) return;
    const file = new File([v.blob], v.name, { type: v.type });
    try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: "ScreamTime" }); return; } } catch (e) { if (e && e.name === "AbortError") return; }
    const a = document.createElement("a"); a.href = URL.createObjectURL(v.blob); a.download = v.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast("Video opgeslagen in Downloads");
  }
  $("#camBtn").addEventListener("click", openCam);
  $("#camBtn2").addEventListener("click", openCam);
  $("#camClose").addEventListener("click", () => { if (history.state && history.state.cam) history.back(); else closeCam(); });
  $("#camFlip").addEventListener("click", async () => { if (CAM.rec) { toast("Wissel niet tijdens opnemen"); return; } CAM.facing = CAM.facing === "environment" ? "user" : "environment"; try { await startCamStream(); } catch (e) { toast("Kon niet wisselen"); } });
  $("#camRec").addEventListener("click", () => { unlockAudio(); if (CAM.rec) stopRec(); else startRec(); });
  $("#camAuto").addEventListener("click", () => { S.settings.autoRec = S.settings.autoRec === false; save(); $("#camAuto").classList.toggle("on", S.settings.autoRec !== false); toast(S.settings.autoRec ? "Auto-opname aan: filmt vanaf START tot na de finish" : "Auto-opname uit"); });
  $("#camGo").addEventListener("click", () => {
    if (CAM.awaitEnd) { const a = CAM.awaitEnd; CAM.awaitEnd = null; CAM.outro = null; clearTimeout(CAM.autoStopT); if (CAM.rec) stopRec(); void a; }
    if (M.state === "idle" && S.settings.autoRec !== false && !CAM.rec && CAM.stream) startRec();
    goPressed();
  });
  $("#camSave").addEventListener("click", saveVideo);
  window.addEventListener("resize", () => { if (CAM.on) sizeCam(); });

  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); }
  function panel(ctx, x, y, w, h, r) { roundRect(ctx, x, y, w, h, r); ctx.fillStyle = "rgba(10,7,18,.58)"; ctx.fill(); ctx.strokeStyle = "rgba(244,238,251,.14)"; ctx.lineWidth = 1.5; ctx.stroke(); }

  function drawCam() {
    const W = CAM.W, H = CAM.H, ctx = camCtx, now = performance.now();
    const $go = $("#camGo"), running = M.state !== "idle";
    if ($go.classList.contains("stop") !== running) { $go.classList.toggle("stop", running); $go.innerHTML = running ? `<svg><use href="#i-stop"/></svg><span>STOP</span>` : `<svg><use href="#i-play"/></svg><span>START</span>`; }
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    const vw = camVid.videoWidth, vh = camVid.videoHeight;
    if (vw && vh) {
      const s = Math.max(W / vw, H / vh), dw = vw * s, dh = vh * s;
      ctx.save();
      if (CAM.facing === "user") { ctx.translate(W, 0); ctx.scale(-1, 1); }
      ctx.drawImage(camVid, (W - dw) / 2, (H - dh) / 2, dw, dh);
      ctx.restore();
    }
    const port = H > W, u = Math.min(W, H) / 100;
    // leesbaarheid: verloop boven en onder
    let g = ctx.createLinearGradient(0, 0, 0, H * 0.22); g.addColorStop(0, "rgba(7,4,13,.75)"); g.addColorStop(1, "rgba(7,4,13,0)"); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H * 0.22);
    g = ctx.createLinearGradient(0, H * (port ? 0.5 : 0.45), 0, H); g.addColorStop(0, "rgba(7,4,13,0)"); g.addColorStop(1, "rgba(7,4,13,.85)"); ctx.fillStyle = g; ctx.fillRect(0, H * 0.45, W, H * 0.55);

    // --- kop: logo, auto, doel ---
    const pad = u * 4, top = pad + (port ? u * 2 : 0);
    const lg = ctx.createLinearGradient(pad, 0, pad + u * 60, 0); lg.addColorStop(0, "#ff7a3d"); lg.addColorStop(0.55, "#ff2f78"); lg.addColorStop(1, "#a238ff");
    ctx.lineWidth = u * 1.1; ctx.lineCap = "round"; ctx.strokeStyle = lg; ctx.beginPath(); ctx.arc(pad + u * 4.5, top + u * 4.5, u * 4, Math.PI * 0.75, Math.PI * 2.25); ctx.stroke();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = u * 0.7; ctx.beginPath(); ctx.moveTo(pad + u * 3, top + u * 6); ctx.lineTo(pad + u * 6.5, top + u * 2.5); ctx.stroke();
    ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.font = `${u * 5}px Anton, Impact`; ctx.fillStyle = "#fff";
    ctx.fillText("SCREAM", pad + u * 11, top + u * 3.4);
    const w1 = ctx.measureText("SCREAM").width, w2 = ctx.measureText("TIME").width;
    ctx.fillStyle = lg; ctx.fillText("TIME", pad + u * 11 + w1, top + u * 3.4);
    ctx.font = `800 ${u * 1.5}px Inter, sans-serif`; ctx.fillStyle = "rgba(244,238,251,.7)";
    ctx.fillText("BY STREET SCREAMER", pad + u * 12.5 + w1 + w2, top + u * 4.4);
    const T = curTargetCached();
    const carN = S.settings.source === "sim" ? "Demo · " + E.SIM_CARS[S.settings.simCar].name : activeCar().name;
    // rechtsboven: REC en GPS-status
    ctx.textAlign = "right";
    const gpsTxt = $("#gpsLbl").textContent + (SRC.acc != null ? ` ±${SRC.acc.toFixed(1)} m` : "");
    if (CAM.rec) {
      const el = (now - CAM.recStart) / 1000, on = Math.floor(now / 500) % 2 === 0;
      ctx.font = `700 ${u * 3}px "JetBrains Mono", monospace`; ctx.fillStyle = "#fff";
      const rt = `REC ${String(Math.floor(el / 60)).padStart(2, "0")}:${String(Math.floor(el % 60)).padStart(2, "0")}`;
      ctx.fillText(rt, W - pad, top + u * 3.4);
      ctx.fillStyle = on ? "#e2264d" : "rgba(226,38,77,.4)"; ctx.beginPath(); ctx.arc(W - pad - ctx.measureText(rt).width - u * 2.4, top + u * 3.4, u * 1.4, 0, TAU); ctx.fill();
    }
    ctx.font = `600 ${u * 2.4}px "JetBrains Mono", monospace`; ctx.fillStyle = "rgba(173,158,196,.95)";
    ctx.fillText(gpsTxt, W - pad, top + u * 8);
    const gpsW = ctx.measureText(gpsTxt).width;
    ctx.textAlign = "left"; ctx.font = `700 ${u * 2.6}px Inter, sans-serif`; ctx.fillStyle = "rgba(244,238,251,.85)";
    let line = `${carN}  ·  ${T.label}`; const maxW = W - pad * 2 - u * 11 - gpsW - u * 3;
    while (line.length > 4 && ctx.measureText(line).width > maxW) line = line.slice(0, -2);
    if (line !== `${carN}  ·  ${T.label}`) line = line.trimEnd() + "…";
    ctx.fillText(line, pad + u * 11, top + u * 8);
    const lgImg = S.settings.source === "sim" ? null : carLogo(activeCar());
    if (lgImg && lgImg.complete && lgImg.naturalWidth) { // eigen logo linksonder boven de teller
      const lh = u * 9, lw = Math.min(u * 26, lh * lgImg.naturalWidth / lgImg.naturalHeight);
      ctx.globalAlpha = 0.95; ctx.drawImage(lgImg, pad, top + u * 12, lw, lw * lgImg.naturalHeight / lgImg.naturalWidth); ctx.globalAlpha = 1;
    }

    const gs = port ? W * 0.44 : H * 0.44; // tellergrootte
    const by = port ? H - pad - u * 20 - gs : H - pad * 0.7 - gs; // staand: boven de knoppen; liggend: in de hoeken
    // --- live splits (rechts) ---
    const bhS = u * 5.4, gapS = u * 1.2, y0S = H * 0.2;
    const nFit = Math.max(1, Math.floor(((port ? H * 0.5 : by - u * 2) - y0S) / (bhS + gapS)));
    const spl = (M.liveSplits || []).slice(-Math.min(6, nFit));
    const cardUp = CAM.finalRun && (now - CAM.finalAt < 4500 || !!CAM.outro);
    if (spl.length && !cardUp) {
      const bw = u * 30, bh = bhS, x0 = W - pad - bw, y0 = y0S;
      spl.forEach((s, i) => {
        const age = Math.max(0, (now - s.at) / 1000), y = y0 + i * (bh + gapS), slide = Math.min(1, age * 4);
        ctx.globalAlpha = slide;
        panel(ctx, x0 + (1 - slide) * u * 12, y, bw, bh, u * 1.6);
        ctx.textAlign = "left"; ctx.font = `700 ${u * 2.5}px Inter, sans-serif`; ctx.fillStyle = "rgba(244,238,251,.8)"; ctx.fillText(s.label, x0 + u * 2, y + bh / 2);
        ctx.textAlign = "right"; ctx.font = `700 ${u * 3}px "JetBrains Mono", monospace`; ctx.fillStyle = age < 1.2 ? "#ffd68c" : "#fff"; ctx.fillText(s.time.toFixed(2) + " s", x0 + bw - u * 2, y + bh / 2);
        ctx.globalAlpha = 1;
      });
    }

    // --- onderste instrumenten ---
    const gx = pad * 0.6, bx = W - pad * 0.6 - gs;
    // snelheidsmeter via offscreen canvas
    const gc = CAM.gCv, dpr = 1.5;
    if (gc.width !== Math.round(gs * dpr)) { gc.width = gc.height = Math.round(gs * dpr); }
    const gctx = gc.getContext("2d"); gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const go = gaugeOpts(); if (go.style === "gforce") go.style = "screamer";
    drawGauge(gctx, gs, Object.assign(go, { v: GA.v, max: GA.max, step: GA.want[1], target: T.type === "speed" ? T.to : null, unit: uLbl(), trail: GA.trail.slice(0, -1), sparks: [], live: true }));
    ctx.globalAlpha = 0.97; ctx.drawImage(gc, gx, by, gs, gs); ctx.globalAlpha = 1;
    // G-bol
    const gr = gs * 0.4;
    drawGBall(ctx, bx + gs / 2, by + gs / 2, gr, TEL.latG, TEL.lonG, TEL.trail);
    ctx.textAlign = "center"; ctx.font = `700 ${u * 2.6}px "JetBrains Mono", monospace`; ctx.fillStyle = "#fff";
    ctx.fillText(`${TEL.lonG >= 0 ? "+" : ""}${TEL.lonG.toFixed(2)} G  ·  ${Math.abs(TEL.latG).toFixed(2)} LAT`, bx + gs / 2, by + gs / 2 + gr * 1.08 + u * 3);

    // tijd + lampen (midden)
    const cx = W / 2, ty = port ? by - u * 16 : H - pad - u * 33;
    let tEl = 0; if (M.state === "running") tEl = (now - M.t0) / 1000; else if (M.final != null) tEl = M.final;
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    ctx.font = `${u * (port ? 13 : 11)}px Anton, Impact`;
    const tg = ctx.createLinearGradient(0, ty - u * 12, 0, ty); tg.addColorStop(0, "#fff"); tg.addColorStop(1, M.state === "running" ? "#ff7a3d" : "#ffc2a3");
    ctx.fillStyle = tg; ctx.shadowColor = "rgba(255,47,120,.8)"; ctx.shadowBlur = u * 3;
    ctx.fillText(tEl.toFixed(2), cx, ty); ctx.shadowBlur = 0;
    ctx.font = `800 ${u * 2.2}px Inter, sans-serif`; ctx.fillStyle = "rgba(244,238,251,.75)";
    const stTxt = CAM.outro ? "OPNAME STOPT" : CAM.awaitEnd ? "FINISH ✓  FILMT TOT GAS LOS" : M.state === "arming" && M.stillSince != null ? "STILSTAND CONTROLEREN " + Math.min(2, (now - M.stillSince) / 1000).toFixed(1) + " S" : { idle: "KLAAR VOOR START", arming: "STILSTAAN…", ready: "WACHT OP GROEN", running: "GAS!", "roll-wait": "RIJD ONDER " + (T.from || ""), "roll-armed": "VOL GAS BIJ " + (T.from || "") }[M.state] || "";
    ctx.fillText(stTxt.split("").join(" ").replace(/ {3}/g, "   "), cx, ty + u * 3.8);
    const lights = $$("#tree i").map((el) => el.className);
    if (M.state === "ready" || M.state === "running") lights.forEach((c, i) => {
      if (i > 4) return;
      const lx = cx + (i - 2) * u * 5, ly = ty - u * (port ? 17 : 15);
      ctx.beginPath(); ctx.arc(lx, ly, u * 1.6, 0, TAU);
      const col = c === "amber" ? "#ffb020" : c === "green" ? "#33d17a" : c === "red" ? "#e2264d" : "rgba(40,28,56,.8)";
      ctx.fillStyle = col; if (c) { ctx.shadowColor = col; ctx.shadowBlur = u * 3; } ctx.fill(); ctx.shadowBlur = 0;
    });
    // kracht / vermogen / koppel
    const chips = [["≈ VERMOGEN", Math.round(Math.max(0, TEL.hp)) + " pk"], ["≈ KRACHT", Math.max(0, TEL.kN).toFixed(1) + " kN"], ["≈ WIELKOPPEL", Math.round(Math.max(0, TEL.nm)) + " Nm"], ["AFSTAND", distFmt(M.state === "running" ? M.dist : 0)]];
    const cw = port ? (W - pad * 2 - u * 3) / 4 : u * 22, ch = u * 8.5;
    const cy0 = port ? by - u * 11.5 : H - pad - u * 16 - ch;
    const cxs = port ? pad : cx - (cw * 4 + u * 3) / 2;
    chips.forEach(([l, v], i) => {
      const x = cxs + i * (cw + u);
      panel(ctx, x, cy0, cw, ch, u * 1.8);
      ctx.textAlign = "center"; ctx.font = `800 ${u * 1.6}px Inter, sans-serif`; ctx.fillStyle = "rgba(173,158,196,.9)"; ctx.fillText(l, x + cw / 2, cy0 + u * 3);
      ctx.font = `700 ${u * 2.9}px "JetBrains Mono", monospace`; ctx.fillStyle = "#fff"; ctx.fillText(v, x + cw / 2, cy0 + u * 6.9);
    });
    // mini-grafiek snelheid
    const tr = TEL.trace;
    if (tr.length > 1 && !port) {
      const gw = u * 50, gh = u * 9, gx0 = cx - gw / 2, gy0 = ty - u * 31;
      const tmax = Math.max(5, tr[tr.length - 1][0]), vmax = Math.max(...tr.map((p) => p[1])) * 1.1 || 1;
      ctx.beginPath(); tr.forEach((p, i) => { const x = gx0 + (p[0] / tmax) * gw, y = gy0 + gh - (p[1] / vmax) * gh; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.strokeStyle = "#ff2f78"; ctx.lineWidth = u * 0.5; ctx.shadowColor = "#ff2f78"; ctx.shadowBlur = u * 2; ctx.stroke(); ctx.shadowBlur = 0;
    }
    // resultaatkaart na de finish (komt mee in de video)
    if (cardUp) {
      const r = CAM.finalRun, p = r.primary, k = Math.min(1, (now - CAM.finalAt) / 350);
      ctx.globalAlpha = k;
      const pw = Math.min(W * 0.86, u * 80), ph = u * 34, px = (W - pw) / 2, py = H * (port ? 0.26 : 0.18);
      roundRect(ctx, px, py, pw, ph, u * 3); ctx.fillStyle = "rgba(10,7,18,.82)"; ctx.fill(); ctx.strokeStyle = "#ff2f78"; ctx.lineWidth = u * 0.4; ctx.shadowColor = "#ff2f78"; ctx.shadowBlur = u * 5; ctx.stroke(); ctx.shadowBlur = 0;
      ctx.textAlign = "center"; ctx.font = `800 ${u * 2.6}px Inter, sans-serif`; ctx.fillStyle = "#ffd0b8";
      ctx.fillText((p ? p.label : "RUN").toUpperCase().split("").join(" "), W / 2, py + u * 7);
      ctx.font = `${u * 16}px Anton, Impact`; ctx.fillStyle = "#fff"; ctx.shadowColor = "rgba(255,47,120,.9)"; ctx.shadowBlur = u * 4;
      ctx.fillText(p ? p.time.toFixed(2) + " s" : "—", W / 2, py + u * 24); ctx.shadowBlur = 0;
      ctx.font = `700 ${u * 2.6}px "JetBrains Mono", monospace`; ctx.fillStyle = "rgba(244,238,251,.8)";
      const dy = dyno(r);
      ctx.fillText(`TOP ${Math.round(r.res.peakV / uf())} ${uLbl()} · ${r.res.peakG.toFixed(2)} G · ≈${dy.hp} pk`, W / 2, py + u * 30);
      ctx.globalAlpha = 1;
    }
  }

  // ================= HUD =================
  function openHud() { $("#hud").classList.add("open"); $("#hud").classList.toggle("mirror", S.settings.hudMirror); requestWake(); history.pushState({ hud: 1 }, ""); }
  function closeHud() { $("#hud").classList.remove("open"); }
  $("#hudBtn").addEventListener("click", openHud);
  $("#hudClose").addEventListener("click", () => { if (history.state && history.state.hud) history.back(); else closeHud(); });
  $("#hudMirror").addEventListener("click", () => { S.settings.hudMirror = !S.settings.hudMirror; save(); $("#hud").classList.toggle("mirror", S.settings.hudMirror); });

  // ================= tabs =================
  function showTab(t) {
    $$(".tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === "v-" + t));
    if (t === "results") { if (S.settings.source === "sim" && S.runs.some((r) => r.sim)) resFilter = "demo"; renderResults(); }
    if (t === "garage") renderGarage();
    if (t === "settings") renderSettings();
    if (t === "meten") { renderMeten(); requestAnimationFrame(sizeGauge); }
    window.scrollTo(0, 0);
  }
  $(".tabbar").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) showTab(b.dataset.tab); });

  function renderAll() {
    renderMeten(); updateChip();
    if ($("#v-results").classList.contains("active")) renderResults();
    if ($("#v-garage").classList.contains("active")) renderGarage();
    if ($("#v-settings").classList.contains("active")) renderSettings();
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { requestWake(); if (!SRC.cur && S.settings.source !== "racebox" && S.settings.source !== "ble") startSource(false); }
    else if (M.state === "idle" && (S.settings.source === "phone" || S.settings.source === "sim")) stopSource();
  });
  window.addEventListener("resize", sizeGauge);

  // ================= installeren als app =================
  const isStandalone = () => matchMedia("(display-mode: standalone)").matches || matchMedia("(display-mode: fullscreen)").matches || navigator.standalone === true;
  let installEvt = null;
  // Bewust geen preventDefault: dan toont Chrome zelf de installeer-melding (zoals bij MuscleScreamer).
  window.addEventListener("beforeinstallprompt", (e) => { installEvt = e; if (!isStandalone()) $("#installBar").hidden = false; });
  window.addEventListener("appinstalled", () => { $("#installBar").hidden = true; toast("ScreamTime is geïnstalleerd — open hem vanaf je startscherm", 4000); });
  $("#installBtn").addEventListener("click", async () => {
    if (installEvt) { installEvt.prompt(); const r = await installEvt.userChoice.catch(() => null); if (r && r.outcome === "accepted") $("#installBar").hidden = true; installEvt = null; return; }
    openSheet(`<h2>Installeer als app</h2><div class="card about">
      <p><b style="color:var(--ink)">1.</b> Tik in Chrome rechtsboven op <b style="color:var(--ink)">⋮</b></p>
      <p><b style="color:var(--ink)">2.</b> Kies <b style="color:var(--ink)">App installeren</b> (of <i>Installeren</i>) — níet 'Snelkoppeling toevoegen'.</p>
      <p><b style="color:var(--ink)">3.</b> Open ScreamTime vanaf je startscherm: volledig scherm, zonder adresbalk.</p>
      <p>Staat er nog een oude snelkoppeling of de oude link (…/screamerlaunch) op je startscherm? Verwijder die eerst.</p></div>`);
  });
  $("#installX").addEventListener("click", () => { $("#installBar").hidden = true; });
  if (!isStandalone()) setTimeout(() => { $("#installBar").hidden = false; }, 1200);

  // ================= start =================
  renderAll();
  sizeGauge();
  startSource(false);
  requestAnimationFrame(frame);
  const hideSplash = () => $("#splash").classList.add("gone");
  (document.fonts ? Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1200))]) : Promise.resolve()).then(() => setTimeout(hideSplash, 350));
  document.addEventListener("click", unlockAudio, { once: true });

  // alleen voor tests
  window.__SL = { inject: { fix: onFix, imu: onImu }, stopSource, makeCard, S: () => S, M, SRC, TEL, CAM, openCam, drawCam, drawGauge, showResult, startMeasure, showTab, openSourceSheet };
})();
