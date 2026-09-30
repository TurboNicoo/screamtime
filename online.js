/* ScreamTime — online: account, ranglijsten en vrienden via Supabase.
 * De Supabase-bibliotheek wordt pas geladen als online-functies nodig zijn, zodat de app
 * altijd opstart, ook zonder internet.
 */
(function () {
  "use strict";
  const CFG = window.SCREAMTIME_CONFIG || {};
  const LIB = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js";
  let sb = null, loading = null, session = null, profile = null, ready = null;
  const listeners = new Set();

  const configured = () => !!(CFG.supabaseUrl && CFG.supabaseKey);

  // "Onthoud mij": aan = sessie in localStorage (blijft bewaard), uit = sessionStorage (weg na sluiten van de app).
  const REM = "screamtime-remember";
  const remember = () => { try { return localStorage.getItem(REM) !== "0"; } catch (e) { return true; } };
  const box = () => { try { return remember() ? localStorage : sessionStorage; } catch (e) { return null; } };
  const storage = {
    getItem: (k) => { try { return box().getItem(k); } catch (e) { return null; } },
    setItem: (k, v) => { try { box().setItem(k, v); } catch (e) { /* vol of geblokkeerd */ } },
    removeItem: (k) => { try { localStorage.removeItem(k); sessionStorage.removeItem(k); } catch (e) { /* geblokkeerd */ } },
  };
  const emit = (e) => listeners.forEach((f) => { try { f(e); } catch (err) { console.error(err); } });

  function loadLib() {
    if (window.supabase && window.supabase.createClient) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = LIB; s.async = true;
      s.onload = () => res();
      s.onerror = () => { loading = null; rej(new Error("Geen internetverbinding — online-functies niet beschikbaar")); };
      document.head.appendChild(s);
    });
    return loading;
  }

  function nl(e) {
    const m = (e && (e.message || e.error_description || e.msg)) || String(e);
    if (/Invalid login credentials/i.test(m)) return "Onjuist e-mailadres of wachtwoord";
    if (/already registered|already been registered|User already exists/i.test(m)) return "Er bestaat al een account met dit e-mailadres";
    if (/Password should be at least/i.test(m)) return "Kies een wachtwoord van minstens 6 tekens";
    if (/valid email|invalid format.*email|Unable to validate email/i.test(m)) return "Vul een geldig e-mailadres in";
    if (/rate limit|too many/i.test(m)) return "Te veel pogingen — probeer het over een paar minuten opnieuw";
    if (/Email not confirmed/i.test(m)) return "Bevestig eerst je e-mailadres via de link in je mail";
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "Geen internetverbinding";
    if (/profiles_username_lower|duplicate key/i.test(m)) return "Deze username is al bezet";
    return m;
  }
  async function q(p) { const r = await p; if (r.error) throw new Error(nl(r.error)); return r.data; }

  async function loadProfile() {
    profile = null;
    if (!session) return;
    const { data } = await sb.from("profiles").select("id,username").eq("id", session.user.id).maybeSingle();
    profile = data || null;
  }

  // Start de verbinding (één keer). Geeft de client terug of gooit een fout.
  function init() {
    if (!configured()) return Promise.reject(new Error("Online ranglijst is nog niet gekoppeld"));
    if (ready) return ready;
    ready = (async () => {
      await loadLib();
      sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "screamtime-auth", storage },
      });
      const { data } = await sb.auth.getSession();
      session = data.session;
      await loadProfile();
      sb.auth.onAuthStateChange((ev, s) => {
        session = s;
        // Supabase raadt aan hier niet te awaiten; profiel laden gebeurt los.
        setTimeout(async () => { await loadProfile().catch(() => {}); emit(ev === "PASSWORD_RECOVERY" ? "recovery" : "auth"); }, 0);
      });
      emit("auth");
      return sb;
    })().catch((e) => { ready = null; throw e; });
    return ready;
  }

  const escLike = (s) => String(s).replace(/[\\%_]/g, (c) => "\\" + c);
  const userId = () => (session ? session.user.id : null);

  // Fysieke ondergrens, gelijk aan de controle in de database (gemiddeld max 1,7 g).
  function minSplitTime(metric) {
    const g = 1.7 * 9.80665;
    if (metric.startsWith("S:")) {
      const [, u, p] = metric.split(":"); const [a, b] = p.split("-").map(Number);
      return b > a ? ((b - a) * (u === "mph" ? 0.44704 : 1 / 3.6)) / g : Infinity;
    }
    const d = { "D:60ft": 18.288, "D:100m": 100, "D:1/8": 201.168, "D:1000ft": 304.8, "D:1/4": 402.336, "D:1/2": 804.672, "D:1km": 1000, "D:1mi": 1609.344 }[metric];
    return d ? Math.sqrt((2 * d) / g) : Infinity;
  }

  const Online = {
    configured,
    init,
    on(f) { listeners.add(f); return () => listeners.delete(f); },
    get user() { return session ? session.user : null; },
    get profile() { return profile; },
    get loggedIn() { return !!(session && profile); },
    get remember() { return remember(); },
    setRemember(on) {
      try {
        const k = "screamtime-auth", from = on ? sessionStorage : localStorage, to = on ? localStorage : sessionStorage;
        localStorage.setItem(REM, on ? "1" : "0");
        const v = from.getItem(k); if (v != null) { to.setItem(k, v); from.removeItem(k); }
      } catch (e) { /* opslag geblokkeerd */ }
    },
    minSplitTime,

    async signUp({ email, password, username }) {
      await init();
      username = String(username || "").trim();
      if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw new Error("Username: 3–20 tekens, alleen letters, cijfers en _");
      const free = await q(sb.rpc("username_available", { name: username }));
      if (!free) throw new Error("Deze username is al bezet");
      const data = await q(sb.auth.signUp({ email: email.trim(), password, options: { data: { username }, emailRedirectTo: location.origin + location.pathname } }));
      session = data.session; await loadProfile(); emit("auth");
      return { needsConfirm: !data.session };
    },
    async signIn(email, password) {
      await init();
      const data = await q(sb.auth.signInWithPassword({ email: email.trim(), password }));
      session = data.session; await loadProfile(); emit("auth");
    },
    async signOut() { await init(); await sb.auth.signOut(); session = null; profile = null; emit("auth"); },
    async resetPassword(email) { await init(); await q(sb.auth.resetPasswordForEmail(email.trim(), { redirectTo: location.origin + location.pathname })); },
    async updatePassword(password) { await init(); await q(sb.auth.updateUser({ password })); },
    async deleteAccount() { await init(); await q(sb.rpc("delete_me")); await sb.auth.signOut().catch(() => {}); session = null; profile = null; emit("auth"); },

    // Run delen. Geeft {ok, splits} of gooit. Bestaat hij al (zelfde local_id), dan is dat ook goed.
    async uploadRun(row, splits) {
      await init();
      if (!userId()) throw new Error("Niet ingelogd");
      let runId;
      const ins = await sb.from("runs").insert(Object.assign({ user_id: userId() }, row)).select("id").single();
      if (ins.error) {
        if (ins.error.code !== "23505") throw new Error(nl(ins.error));
        const ex = await q(sb.from("runs").select("id").eq("user_id", userId()).eq("local_id", row.local_id).single());
        return { ok: true, id: ex.id, existed: true };
      }
      runId = ins.data.id;
      const good = splits.filter((s) => s.time_s >= minSplitTime(s.metric) && s.time_s <= 120).map((s) => ({ run_id: runId, user_id: userId(), metric: s.metric, time_s: +s.time_s.toFixed(3) }));
      if (good.length) {
        const r = await sb.from("splits").insert(good);
        if (r.error) for (const s of good) await sb.from("splits").insert(s); // los proberen: één afwijzing mag de rest niet tegenhouden
      }
      return { ok: true, id: runId, splits: good.length };
    },
    async deleteRun(localId) { await init(); if (!userId()) return; await q(sb.from("runs").delete().eq("user_id", userId()).eq("local_id", localId)); },

    async friendIds() {
      await init(); if (!userId()) return [];
      return (await q(sb.from("friends").select("friend_id"))).map((r) => r.friend_id);
    },
    async friends() {
      const ids = await Online.friendIds();
      if (!ids.length) return [];
      return q(sb.from("profiles").select("id,username").in("id", ids).order("username"));
    },
    async searchUsers(prefix) {
      await init();
      prefix = String(prefix || "").trim(); if (prefix.length < 2) return [];
      return q(sb.from("profiles").select("id,username").ilike("username", escLike(prefix) + "%").neq("id", userId() || "00000000-0000-0000-0000-000000000000").order("username").limit(8));
    },
    async addFriend(username) {
      await init();
      const rows = await q(sb.from("profiles").select("id,username").ilike("username", escLike(username.trim())).limit(1));
      if (!rows.length) throw new Error(`Geen gebruiker "${username}" gevonden`);
      if (rows[0].id === userId()) throw new Error("Jezelf toevoegen kan niet 😉");
      const r = await sb.from("friends").insert({ user_id: userId(), friend_id: rows[0].id });
      if (r.error && r.error.code !== "23505") throw new Error(nl(r.error));
      return rows[0];
    },
    async removeFriend(id) { await init(); await q(sb.from("friends").delete().eq("user_id", userId()).eq("friend_id", id)); },

    // Ranglijst voor een onderdeel. scope: "all" of "friends".
    async board(metric, scope) {
      await init();
      let query = metric === "top"
        ? sb.from("top_speeds").select("*").order("peak_kmh", { ascending: false })
        : sb.from("best_times").select("*").eq("metric", metric).order("time_s", { ascending: true });
      if (scope === "friends") { const ids = await Online.friendIds(); query = query.in("user_id", ids.concat(userId() ? [userId()] : [])); }
      return q(query.limit(100));
    },
    // Plaats van een tijd in de ranglijst (1 = snelste).
    async rank(metric, time, scope) {
      await init();
      let query = sb.from("best_times").select("user_id", { count: "exact", head: true }).eq("metric", metric).lt("time_s", time);
      if (userId()) query = query.neq("user_id", userId());
      if (scope === "friends") { const ids = await Online.friendIds(); if (!ids.length) return null; query = query.in("user_id", ids); }
      const r = await query;
      if (r.error) throw new Error(nl(r.error));
      return (r.count || 0) + 1;
    },
  };
  window.Online = Online;
})();
