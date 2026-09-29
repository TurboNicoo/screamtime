/* Screamer Launch — databronnen.
 * Elke bron roept onFix({t,v,lat,lon,alt,acc,sats}) aan met t op de performance.now()-klok (ms)
 * en v in m/s. De IMU roept onImu({t,x,y,z,lin}) aan (m/s²).
 */
(function () {
  "use strict";

  // Tijdstempels van een ontvanger (ms binnen de week/dag) omzetten naar de performance-klok.
  // De ondergrens van (aankomst − ontvangertijd) volgt de vaste offset; jitter over USB/BLE valt weg.
  function clockMapper() {
    let off = null, lastRx = null;
    return function (rxMs) {
      const now = performance.now();
      if (lastRx != null && Math.abs(rxMs - lastRx) > 5000) off = null; // sprong (nieuwe dag / reset)
      lastRx = rxMs;
      const cand = now - rxMs;
      if (off == null || cand < off) off = cand;
      else off += 0.02 * (cand - off) * 0.05; // heel langzaam meeschuiven bij klokdrift
      return rxMs + off;
    };
  }

  // ---------- telefoon-GPS ----------
  class PhoneGps {
    constructor(onFix, onStatus) { this.onFix = onFix; this.onStatus = onStatus; this.id = null; this.kind = "phone"; }
    start() {
      if (!("geolocation" in navigator)) { this.onStatus({ error: "Geen GPS beschikbaar in deze browser" }); return; }
      this.id = navigator.geolocation.watchPosition((p) => {
        const epochOff = Date.now() - performance.now();
        let t = p.timestamp - epochOff;
        const now = performance.now();
        if (!(t <= now + 50 && t > now - 3000)) t = now; // onbetrouwbare tijdstempel
        const c = p.coords;
        this.onFix({ t, v: c.speed, lat: c.latitude, lon: c.longitude, alt: c.altitude, acc: c.accuracy, src: "phone" });
      }, (e) => {
        this.onStatus({ error: e.code === 1 ? "Locatietoegang geweigerd — sta locatie toe voor deze app" : "GPS-fout: " + e.message });
      }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
    }
    stop() { if (this.id != null) navigator.geolocation.clearWatch(this.id); this.id = null; }
  }

  // ---------- IMU (accelerometer van de telefoon) ----------
  class PhoneImu {
    constructor(onImu) { this.onImu = onImu; this.h = null; this.active = false; }
    async start() {
      if (typeof DeviceMotionEvent === "undefined") return false;
      try { if (typeof DeviceMotionEvent.requestPermission === "function") { const r = await DeviceMotionEvent.requestPermission(); if (r !== "granted") return false; } } catch (e) { /* Android vraagt niets */ }
      this.h = (e) => {
        const a = e.acceleration, g = e.accelerationIncludingGravity;
        const t = e.timeStamp || performance.now();
        const r = e.rotationRate;
        // gyroscoop (rad/s, apparaat-assen x,y,z) + zwaartekrachtrichting voor de gierhoeksnelheid
        const extra = {};
        if (r && r.alpha != null) extra.w = { x: (r.beta || 0) * Math.PI / 180, y: (r.gamma || 0) * Math.PI / 180, z: (r.alpha || 0) * Math.PI / 180 };
        if (a && a.x != null && g && g.x != null) extra.g = { x: g.x - a.x, y: g.y - a.y, z: g.z - a.z };
        else if (g && g.x != null) extra.g = { x: g.x, y: g.y, z: g.z };
        if (a && a.x != null) { this.active = true; this.onImu(Object.assign({ t, x: a.x, y: a.y, z: a.z, lin: true }, extra)); }
        else if (g && g.x != null) { this.active = true; this.onImu(Object.assign({ t, x: g.x, y: g.y, z: g.z, lin: false }, extra)); }
      };
      window.addEventListener("devicemotion", this.h);
      return true;
    }
    stop() { if (this.h) window.removeEventListener("devicemotion", this.h); this.h = null; }
  }

  // ---------- UBX / NMEA ----------
  function ubx(cls, id, payload) {
    const len = payload.length, b = new Uint8Array(8 + len);
    b[0] = 0xb5; b[1] = 0x62; b[2] = cls; b[3] = id; b[4] = len & 255; b[5] = len >> 8;
    b.set(payload, 6);
    let a = 0, c = 0;
    for (let i = 2; i < 6 + len; i++) { a = (a + b[i]) & 255; c = (c + a) & 255; }
    b[6 + len] = a; b[7 + len] = c;
    return b;
  }
  function valset(items) { // [[key, bytes, value]]
    const parts = [0, 1, 0, 0]; // versie 0, laag RAM
    for (const [key, n, val] of items) {
      parts.push(key & 255, (key >>> 8) & 255, (key >>> 16) & 255, (key >>> 24) & 255);
      for (let i = 0; i < n; i++) parts.push((val >>> (8 * i)) & 255);
    }
    return ubx(0x06, 0x8a, new Uint8Array(parts));
  }
  function ubloxConfig(hz) {
    const ms = Math.round(1000 / hz);
    return [
      // u-blox M9/M10: meetinterval + NAV-PVT op UART1 en USB
      valset([[0x30210001, 2, ms], [0x20910007, 1, 1], [0x20910009, 1, 1]]),
      // u-blox M8 en ouder: CFG-RATE + CFG-MSG NAV-PVT op alle poorten
      ubx(0x06, 0x08, new Uint8Array([ms & 255, ms >> 8, 1, 0, 1, 0])),
      ubx(0x06, 0x01, new Uint8Array([0x01, 0x07, 1, 1, 1, 1, 1, 0])),
    ];
  }

  // Stroomparser: haalt UBX-pakketten en NMEA-zinnen uit een bytestroom.
  class GnssParser {
    constructor(onFix) {
      this.onFix = onFix; this.buf = new Uint8Array(0); this.map = clockMapper(); this.nmeaMap = clockMapper();
      this.gotPvt = false; this.lastAlt = null; this.sats = null;
    }
    push(chunk) {
      const b = new Uint8Array(this.buf.length + chunk.length); b.set(this.buf); b.set(chunk, this.buf.length); this.buf = b;
      let i = 0;
      while (i < this.buf.length) {
        const x = this.buf[i];
        if (x === 0xb5) {
          if (this.buf.length - i < 8) break;
          if (this.buf[i + 1] !== 0x62) { i++; continue; }
          const len = this.buf[i + 4] | (this.buf[i + 5] << 8);
          if (len > 1024) { i++; continue; }
          if (this.buf.length - i < 8 + len) break;
          let a = 0, c = 0;
          for (let k = i + 2; k < i + 6 + len; k++) { a = (a + this.buf[k]) & 255; c = (c + a) & 255; }
          if (a === this.buf[i + 6 + len] && c === this.buf[i + 7 + len]) this.ubxMsg(this.buf[i + 2], this.buf[i + 3], this.buf.subarray(i + 6, i + 6 + len));
          i += 8 + len;
        } else if (x === 0x24) { // '$'
          let e = i;
          while (e < this.buf.length && this.buf[e] !== 0x0a) e++;
          if (e >= this.buf.length) { if (this.buf.length - i > 200) { i++; continue; } break; }
          this.nmea(String.fromCharCode.apply(null, this.buf.subarray(i, e)).trim());
          i = e + 1;
        } else i++;
      }
      this.buf = this.buf.slice(i);
    }
    ubxMsg(cls, id, p) {
      const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
      if (cls === 0x01 && id === 0x07 && p.length >= 92) { // NAV-PVT
        this.gotPvt = true;
        const fixType = p[20], ok = p[21] & 1;
        if (!ok || fixType < 2) { this.onFix({ nofix: true, sats: p[23] }); return; }
        this.onFix({
          t: this.map(dv.getUint32(0, true)), v: dv.getInt32(60, true) / 1000,
          lon: dv.getInt32(24, true) * 1e-7, lat: dv.getInt32(28, true) * 1e-7, alt: dv.getInt32(36, true) / 1000,
          acc: dv.getUint32(40, true) / 1000, sAcc: dv.getUint32(68, true) / 1000, sats: p[23],
        });
      } else if (cls === 0xff && id === 0x01 && p.length >= 80) { // RaceBox data message
        this.gotPvt = true;
        const fixType = p[20], ok = p[21] & 1;
        if (!ok || fixType < 2) { this.onFix({ nofix: true, sats: p[23] }); return; }
        this.onFix({
          t: this.map(dv.getUint32(0, true)), v: dv.getInt32(48, true) / 1000,
          lon: dv.getInt32(24, true) * 1e-7, lat: dv.getInt32(28, true) * 1e-7, alt: dv.getInt32(36, true) / 1000,
          acc: dv.getUint32(40, true) / 1000, sAcc: dv.getUint32(56, true) / 1000, sats: p[23], battery: p[67] & 0x7f,
        });
      }
    }
    nmea(line) {
      if (this.gotPvt) return;
      const star = line.indexOf("*");
      const f = (star > 0 ? line.slice(0, star) : line).split(",");
      const type = f[0].slice(3);
      if (type === "GGA") { this.lastAlt = f[9] ? parseFloat(f[9]) : null; this.sats = f[7] ? parseInt(f[7], 10) : null; }
      if (type === "RMC") {
        if (f[2] !== "A") { this.onFix({ nofix: true, sats: this.sats }); return; }
        const hms = f[1];
        const ms = ((+hms.slice(0, 2) * 60 + +hms.slice(2, 4)) * 60 + parseFloat(hms.slice(4))) * 1000;
        const dm = (s, h, deg) => { if (!s) return null; const d = parseInt(s.slice(0, deg), 10), m = parseFloat(s.slice(deg)); const v = d + m / 60; return h === "S" || h === "W" ? -v : v; };
        this.onFix({ t: this.nmeaMap(ms), v: parseFloat(f[7] || "0") * 0.514444, lat: dm(f[3], f[4], 2), lon: dm(f[5], f[6], 3), alt: this.lastAlt, acc: null, sats: this.sats });
      }
    }
  }

  // ---------- USB (WebUSB) — u-blox native, CP210x, CH340 ----------
  class UsbGnss {
    constructor(onFix, onStatus, opts) { this.onFix = onFix; this.onStatus = onStatus; this.opts = opts || {}; this.dev = null; this.kind = "usb"; this.running = false; }
    static supported() { return !!navigator.usb; }
    static filters() { return [{ vendorId: 0x1546 }, { vendorId: 0x10c4 }, { vendorId: 0x1a86 }, { vendorId: 0x067b }, { vendorId: 0x0403 }]; }
    async connect(request) {
      if (!navigator.usb) throw new Error("WebUSB wordt niet ondersteund in deze browser (gebruik Chrome op Android)");
      let dev = null;
      if (!request) { const list = await navigator.usb.getDevices(); dev = list[0] || null; if (!dev) throw new Error("Geen gekoppelde USB-ontvanger"); }
      else dev = await navigator.usb.requestDevice({ filters: UsbGnss.filters() });
      this.dev = dev;
      await dev.open();
      if (!dev.configuration) await dev.selectConfiguration(1);
      const baud = this.opts.baud || 38400;
      let dataIf = null, commIf = null, inEp = null, outEp = null;
      for (const itf of dev.configuration.interfaces) {
        const alt = itf.alternates[0];
        if (alt.interfaceClass === 2) commIf = itf.interfaceNumber;
        const bi = alt.endpoints.find((e) => e.type === "bulk" && e.direction === "in");
        const bo = alt.endpoints.find((e) => e.type === "bulk" && e.direction === "out");
        if (bi && dataIf == null) { dataIf = itf.interfaceNumber; inEp = bi.endpointNumber; outEp = bo ? bo.endpointNumber : null; }
      }
      if (dataIf == null) throw new Error("Geen datakanaal gevonden op dit USB-apparaat");
      if (commIf != null && commIf !== dataIf) { try { await dev.claimInterface(commIf); } catch (e) { /* niet nodig op alle apparaten */ } }
      await dev.claimInterface(dataIf);
      const vid = dev.vendorId;
      const ctl = (type, recipient, request, value, index, data) => dev.controlTransferOut({ requestType: type, recipient, request, value, index }, data);
      try {
        if (vid === 0x10c4) { // CP210x
          await ctl("vendor", "interface", 0x00, 0x0001, dataIf);
          await ctl("vendor", "interface", 0x1e, 0, dataIf, new Uint32Array([baud]).buffer);
          await ctl("vendor", "interface", 0x03, 0x0800, dataIf);
          await ctl("vendor", "interface", 0x07, 0x0303, dataIf);
        } else if (vid === 0x1a86) { // CH340 / CH341
          const tbl = { 9600: [0xb202, 0x0013], 19200: [0xd902, 0x000d], 38400: [0x6403, 0x000a], 57600: [0x9803, 0x0008], 115200: [0xcc03, 0x0008] };
          const [b1, b2] = tbl[baud] || tbl[38400];
          await ctl("vendor", "device", 0xa1, 0, 0);
          await ctl("vendor", "device", 0x9a, 0x1312, b1);
          await ctl("vendor", "device", 0x9a, 0x0f2c, b2);
          await ctl("vendor", "device", 0x9a, 0x2518, 0x00c3);
          await ctl("vendor", "device", 0xa4, 0xff9f, 0);
        } else { // CDC-ACM (u-blox native USB, PL2303-klonen negeren dit gewoon)
          const lc = new Uint8Array([baud & 255, (baud >> 8) & 255, (baud >> 16) & 255, (baud >> 24) & 255, 0, 0, 8]);
          const idx = commIf != null ? commIf : 0;
          await ctl("class", "interface", 0x20, 0, idx, lc);
          await ctl("class", "interface", 0x22, 0x03, idx);
        }
      } catch (e) { /* sommige chips accepteren niet alle commando's; data komt vaak toch door */ }
      this.inEp = inEp; this.outEp = outEp;
      this.parser = new GnssParser((f) => this.onFix(Object.assign({ src: "usb" }, f)));
      this.onStatus({ connected: true, name: dev.productName || "USB GNSS" });
      return dev;
    }
    async start(request) {
      if (!this.dev) await this.connect(request);
      this.running = true;
      if (this.outEp != null) {
        const hz = this.opts.hz || 25;
        for (const m of ubloxConfig(hz)) { try { await this.dev.transferOut(this.outEp, m); } catch (e) { /* alleen-lezen ontvanger */ } }
      }
      this.loop();
    }
    async loop() {
      while (this.running && this.dev) {
        try {
          const r = await this.dev.transferIn(this.inEp, 512);
          if (r.data && r.data.byteLength) this.parser.push(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength));
        } catch (e) {
          this.running = false;
          this.onStatus({ connected: false, error: "USB-verbinding verbroken" });
        }
      }
    }
    async stop() { this.running = false; try { if (this.dev) await this.dev.close(); } catch (e) { /* al dicht */ } this.dev = null; }
  }

  // ---------- Bluetooth LE (RaceBox Mini/Micro, of NUS-ontvanger die NMEA stuurt) ----------
  const NUS = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
  const NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
  class BleGnss {
    constructor(onFix, onStatus, opts) { this.onFix = onFix; this.onStatus = onStatus; this.opts = opts || {}; this.dev = null; this.kind = "ble"; }
    static supported() { return !!(navigator.bluetooth && navigator.bluetooth.requestDevice); }
    async start() {
      if (!BleGnss.supported()) throw new Error("Web Bluetooth wordt niet ondersteund in deze browser (gebruik Chrome op Android)");
      const req = this.opts.racebox
        ? { filters: [{ namePrefix: "RaceBox" }], optionalServices: [NUS] }
        : { acceptAllDevices: true, optionalServices: [NUS] };
      this.dev = await navigator.bluetooth.requestDevice(req);
      this.dev.addEventListener("gattserverdisconnected", () => this.onStatus({ connected: false, error: "Bluetooth-verbinding verbroken" }));
      const server = await this.dev.gatt.connect();
      const svc = await server.getPrimaryService(NUS);
      const ch = await svc.getCharacteristic(NUS_TX);
      this.parser = new GnssParser((f) => this.onFix(Object.assign({ src: "ble" }, f)));
      ch.addEventListener("characteristicvaluechanged", (e) => {
        const dv = e.target.value;
        this.parser.push(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
      });
      await ch.startNotifications();
      this.onStatus({ connected: true, name: this.dev.name || "BLE GNSS" });
    }
    stop() { try { if (this.dev && this.dev.gatt.connected) this.dev.gatt.disconnect(); } catch (e) { /* al weg */ } this.dev = null; }
  }

  // ---------- simulator (demo) ----------
  class SimSource {
    constructor(onFix, onStatus, onImu, opts) { this.onFix = onFix; this.onStatus = onStatus; this.onImu = onImu; this.opts = opts || {}; this.kind = "sim"; this.timers = []; this.idleTimer = null; }
    start() { this.idle(); this.onStatus({ connected: true, name: "Demo" }); }
    idle() { // stilstaande auto: fixes op de gekozen frequentie
      clearInterval(this.idleTimer);
      const hz = this.opts.hz || 10;
      this.idleTimer = setInterval(() => this.onFix({ t: performance.now(), v: Math.abs(Math.random() * 0.06), lat: 52.1, lon: 5.1, alt: 10, acc: 2.5, src: "sim", sats: 18 }), 1000 / hz);
    }
    // Speelt een hele run realtime af. stopV/stopD in m/s / m.
    play(stop) {
      this.cancel();
      clearInterval(this.idleTimer);
      const sim = Engine.simulate(this.opts.car || "screamer", Object.assign({ hz: this.opts.hz || 10, idle: 2.8, seed: (Math.random() * 1e9) | 0, gpsNoise: 0.06 }, stop));
      const base = performance.now();
      const events = sim.gps.map((f) => ["g", f]).concat(sim.imu.map((a) => ["i", a])).sort((a, b) => a[1].t - b[1].t);
      let k = 0;
      const tick = () => {
        const el = performance.now() - base;
        while (k < events.length && events[k][1].t <= el) {
          const [type, e] = events[k++];
          const ev = Object.assign({}, e, { t: e.t + base });
          if (type === "g") this.onFix(Object.assign(ev, { src: "sim", sats: 18 })); else this.onImu(ev);
        }
        if (k < events.length) this.timers.push(setTimeout(tick, 8));
        else this.idle();
      };
      tick();
      return sim;
    }
    cancel() { this.timers.forEach(clearTimeout); this.timers = []; }
    stop() { this.cancel(); clearInterval(this.idleTimer); }
  }

  window.Sources = { PhoneGps, PhoneImu, UsbGnss, BleGnss, SimSource, GnssParser, ubloxConfig, ubx };
})();
