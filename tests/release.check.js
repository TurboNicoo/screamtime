// Controles vóór publicatie: gelijke versienummers, geen geheimen in de code.
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
let fails = 0;
const check = (ok, msg) => { console.log((ok ? "✓ " : "✗ ") + msg); if (!ok) fails++; };

const html = read("index.html");
const vers = [...html.matchAll(/<script src="[^"]+\?v=(\d+)"/g)].map((m) => m[1]);
check(vers.length >= 5 && new Set(vers).size === 1, `script-versies in index.html gelijk (${[...new Set(vers)].join(", ")})`);
const appVer = (read("app.js").match(/const VERSION = "([\d.]+)"/) || [])[1];
check(!!appVer && appVer.replace(/\./g, "") === vers[0], `VERSION in app.js (${appVer}) past bij ?v=${vers[0]}`);
check(/const CACHE = "screamtime-v\d+"/.test(read("sw.js")), "service worker heeft een cache-versie");

const files = fs.readdirSync(root).filter((f) => /\.(js|html|json|sql)$/.test(f)).concat(fs.readdirSync(path.join(root, "supabase")).map((f) => "supabase/" + f));
const leak = files.filter((f) => /sbp_[a-z0-9]{20,}|sb_secret_|service_role/i.test(read(f)) && !/release\.check/.test(f));
check(leak.length === 0, "geen geheime sleutels in de code" + (leak.length ? ": " + leak.join(", ") : ""));
const cfg = read("config.js");
check(/sb_publishable_|eyJ/.test(cfg) && !/sb_secret/.test(cfg), "config.js bevat alleen de publieke sleutel");

if (fails) { console.log(`\n${fails} controle(s) mislukt`); process.exit(1); } else console.log("\nRelease-controles geslaagd");
