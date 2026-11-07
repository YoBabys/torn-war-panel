// ==UserScript==
// @name         Torn War Panel
// @namespace    https://github.com/YoBabys/torn-war-panel
// @version      1.5.9
// @description  War panel: chain alerts, enemy roster, FF/retals, medCD, revives, status lights, TornStats
// @author       YBD
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @downloadURL  https://raw.githubusercontent.com/YoBabys/torn-war-panel/main/war-panel.user.js
// @updateURL    https://raw.githubusercontent.com/YoBabys/torn-war-panel/main/war-panel.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      api.torn.com
// @connect      www.tornstats.com
// @connect      tornstats.com
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // Immediate proof the file is executing (before any GM / state work)
  function twpBeacon(msg, isError) {
    try {
      console.log('[War Panel]', msg);
      var id = 'twp-alive-beacon';
      var el = document.getElementById(id);
      if (!el) {
        el = document.createElement('div');
        el.id = id;
        el.style.cssText =
          'position:fixed!important;bottom:10px!important;left:10px!important;z-index:2147483647!important;' +
          'max-width:420px;padding:8px 12px;border-radius:8px;font:12px/1.4 Consolas,monospace;' +
          'box-shadow:0 6px 20px rgba(0,0,0,.5);pointer-events:none;';
        (document.body || document.documentElement).appendChild(el);
      }
      el.style.background = isError ? '#5a1010' : '#0d3d1f';
      el.style.color = isError ? '#ffd0d0' : '#d8ffe0';
      el.style.border = isError ? '1px solid #c44' : '1px solid #2a8f5c';
      el.textContent = String(msg);
    } catch (_) {
      /* ignore */
    }
  }

  function showBootError(err) {
    try {
      console.error('[War Panel] boot failed', err);
      twpBeacon('War Panel FAILED: ' + (err && err.message ? err.message : String(err)), true);
      var existing = document.getElementById('twp-boot-error');
      if (existing) existing.remove();
      var el = document.createElement('div');
      el.id = 'twp-boot-error';
      el.textContent = 'War Panel failed: ' + (err && err.message ? err.message : String(err));
      el.style.cssText =
        'position:fixed;top:12px;right:12px;z-index:2147483647;max-width:360px;' +
        'background:#4a1515;color:#ffe0e0;border:1px solid #a33;border-radius:8px;' +
        'padding:10px 12px;font:12px/1.4 sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.45);';
      (document.body || document.documentElement).appendChild(el);
    } catch (_) {
      /* ignore */
    }
  }

  twpBeacon('War Panel 1.5.5 script file running…');

  if (typeof GM_getValue !== 'function' || typeof GM_xmlhttpRequest !== 'function') {
    showBootError(
      new Error('Tampermonkey GM_* APIs missing — reinstall the userscript with grants enabled')
    );
    return;
  }

  function safeGet(key, fallback) {
    try {
      var v = GM_getValue(key, fallback);
      return v == null ? fallback : v;
    } catch (e) {
      console.warn('[War Panel] GM_getValue failed', key, e);
      return fallback;
    }
  }

  const STORAGE = {
    tornKey: 'twp_torn_key',
    tsKey: 'twp_ts_key',
    collapsed: 'twp_collapsed',
    filter: 'twp_filter',
    sort: 'twp_sort',
    spiesCache: 'twp_spies_cache',
    ffCache: 'twp_ff_cache',
    sounds: 'twp_sounds',
    flash: 'twp_flash',
    panelPos: 'twp_panel_pos',
    miniPos: 'twp_mini_pos',
    activity: 'twp_activity',
    medCd: 'twp_med_cd',
    retalMode: 'twp_retal_mode',
    sessionCache: 'twp_session_cache',
  };

  const SESSION_CACHE_MAX_AGE_MS = 45 * 60 * 1000;

  const CHAIN_POLL_MS = 5000;
  const ROSTER_POLL_MS = 20000;
  const ATTACKS_POLL_MS = 15000;
  const UI_TICK_MS = 1000;
  const CHAT_INSET_PX = 56;
  const COMMENT = 'TornWarPanel';
  const RETAL_WINDOW_SEC = 5 * 60;

  let state;
  try {
    state = {
      me: null,
      chain: null,
      chainFetchedAt: 0,
      chainEndsAt: 0,
      war: null,
      members: [],
      spies: {},
      assists: {},
      retals: [],
      retalsError: null,
      ff: safeGet(STORAGE.ffCache, {}) || {},
      activity: safeGet(STORAGE.activity, {}) || {},
      medCd: safeGet(STORAGE.medCd, {}) || {},
      hospSeen: {},
      filter: safeGet(STORAGE.filter, 'all'),
      sort: safeGet(STORAGE.sort, 'hosp'),
      retalMode: safeGet(STORAGE.retalMode, 'war') === 'all' ? 'all' : 'war',
      soundsOn: safeGet(STORAGE.sounds, true),
      flashOn: safeGet(STORAGE.flash, true),
      error: null,
      lastRosterAt: 0,
      alert45: false,
      alert90: false,
    };
  } catch (e) {
    showBootError(e);
    return;
  }

  let rootEl = null;
  let timers = { chain: null, roster: null, ui: null, attacks: null };
  let audioCtx = null;

  // ---------------------------------------------------------------------------
  // Storage / settings
  // ---------------------------------------------------------------------------
  function getTornKey() {
    return String(safeGet(STORAGE.tornKey, '') || '').trim();
  }
  function getTsKey() {
    return String(safeGet(STORAGE.tsKey, '') || '').trim();
  }

  function saveSessionCache() {
    if (!state.me || !getTornKey()) return;
    try {
      GM_setValue(STORAGE.sessionCache, {
        at: Date.now(),
        me: state.me,
        chain: state.chain,
        chainEndsAt: state.chainEndsAt,
        war: state.war,
        members: state.members,
        retals: state.retals,
        assists: state.assists,
        lastRosterAt: state.lastRosterAt,
        retalMode: state.retalMode,
      });
    } catch (e) {
      console.warn('[War Panel] session cache save failed', e);
    }
  }

  function hydrateFromSessionCache() {
    if (!getTornKey()) return false;
    let cache = null;
    try {
      cache = GM_getValue(STORAGE.sessionCache, null);
    } catch {
      return false;
    }
    if (!cache || !cache.me) return false;
    state.me = cache.me;
    const age = Date.now() - (cache.at || 0);
    if (age > SESSION_CACHE_MAX_AGE_MS) return true; // identity only
    state.chain = cache.chain || null;
    state.chainEndsAt = cache.chainEndsAt || 0;
    state.war = cache.war || null;
    state.members = Array.isArray(cache.members) ? cache.members : [];
    state.retals = Array.isArray(cache.retals) ? cache.retals : [];
    state.assists = cache.assists && typeof cache.assists === 'object' ? cache.assists : {};
    state.lastRosterAt = cache.lastRosterAt || 0;
    if (cache.retalMode === 'all' || cache.retalMode === 'war') {
      state.retalMode = cache.retalMode;
    }
    return true;
  }

  function saveFf() {
    GM_setValue(STORAGE.ffCache, state.ff);
  }
  function saveActivity() {
    GM_setValue(STORAGE.activity, state.activity);
  }
  function saveMedCd() {
    GM_setValue(STORAGE.medCd, state.medCd);
  }

  // ---------------------------------------------------------------------------
  // Sounds
  // ---------------------------------------------------------------------------
  function ensureAudio() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  function beep({ freq = 880, duration = 0.18, type = 'sine', gain = 0.08, repeats = 1, gap = 0.12 }) {
    if (!state.soundsOn) return;
    const ctx = ensureAudio();
    if (!ctx) return;
    let t = ctx.currentTime;
    for (let i = 0; i < repeats; i++) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      g.gain.value = gain;
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(t);
      g.gain.exponentialRampToValueAtTime(0.001, t + duration);
      osc.stop(t + duration + 0.02);
      t += duration + gap;
    }
  }

  function soundChain90() {
    // Mid warning at 1:30 — softer double tone
    beep({ freq: 640, duration: 0.28, type: 'triangle', gain: 0.09, repeats: 2, gap: 0.16 });
  }

  function soundChain45() {
    // Urgent short triple beep
    beep({ freq: 1200, duration: 0.12, type: 'square', gain: 0.07, repeats: 3, gap: 0.08 });
  }

  function checkChainAlerts() {
    const remaining = chainRemaining();
    if (remaining > 90) state.alert90 = false;
    if (remaining > 45) state.alert45 = false;
    if (remaining > 0 && remaining <= 90 && !state.alert90) {
      state.alert90 = true;
      soundChain90();
    }
    if (remaining > 0 && remaining <= 45 && !state.alert45) {
      state.alert45 = true;
      soundChain45();
    }
  }

  // ---------------------------------------------------------------------------
  // HTTP
  // ---------------------------------------------------------------------------
  function parseResponseBody(text) {
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  function gmRequest(method, url, { headers = {}, body = null, anonymous = true } = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        data: body,
        anonymous,
        timeout: 20000,
        onload: (res) => {
          resolve({
            status: res.status,
            data: parseResponseBody(res.responseText),
            text: res.responseText,
          });
        },
        onerror: (err) => {
          const detail = err && (err.error || err.statusText || err.responseText);
          reject(new Error(detail ? `Network error: ${url} (${detail})` : `Network error: ${url}`));
        },
        ontimeout: () => reject(new Error(`Timeout: ${url}`)),
      });
    });
  }

  async function tornGet(path) {
    const key = getTornKey();
    if (!key) throw new Error('Add your Torn API key in War Panel settings');
    const ts = Math.floor(Date.now() / 1000);
    const url = `https://api.torn.com/v2/${path}${path.includes('?') ? '&' : '?'}comment=${COMMENT}&timestamp=${ts}&key=${encodeURIComponent(key)}`;
    const { data } = await gmRequest('GET', url);
    if (data && data.error) {
      const msg = data.error.error || JSON.stringify(data.error);
      throw new Error(`Torn API: ${msg}`);
    }
    return data;
  }

  async function tornStatsFactionSpies(factionId) {
    const key = getTsKey();
    if (!key) return null;
    const url = `https://www.tornstats.com/api/v2/${encodeURIComponent(key)}/spy/faction/${factionId}`;
    const { data } = await gmRequest('GET', url);
    return data;
  }

  // ---------------------------------------------------------------------------
  // Torn data
  // ---------------------------------------------------------------------------
  async function loadIdentity() {
    const data = await tornGet('user');
    let id = data.profile?.id ?? data.id ?? data.player_id;
    let name = data.profile?.name ?? data.name;
    let factionId = data.faction?.id ?? data.faction_id ?? null;
    let factionName = data.faction?.name ?? null;

    if (!factionId || !name || !id) {
      try {
        const faction = await tornGet('user/faction');
        const f = faction.faction || faction;
        factionId = factionId ?? f.id ?? f.faction_id ?? null;
        factionName = factionName ?? f.name ?? null;
      } catch {
        /* ignore */
      }
    }

    if (!id || !name) throw new Error('Could not resolve your Torn profile from the API key');
    state.me = {
      id: Number(id),
      name: String(name),
      factionId: factionId != null ? Number(factionId) : null,
      factionName,
    };
    return state.me;
  }

  async function loadChain() {
    const started = Date.now();
    const data = await tornGet('faction/chain');
    const received = Date.now();
    const rtt = Math.max(0, received - started);
    state.chain = data.chain || null;
    state.chainFetchedAt = received;
    // timeout is server "seconds left" at response time; subtract RTT so local
    // countdown isn't ~1–2s behind Torn's live timer
    const timeoutSec = Number(state.chain?.timeout || 0);
    state.chainEndsAt = received + timeoutSec * 1000 - rtt;
    return state.chain;
  }

  async function loadWarAndRoster() {
    const wars = await tornGet('faction/wars');
    const ranked = wars.wars?.ranked;
    const war = Array.isArray(ranked) ? ranked[0] : ranked;
    if (!war) {
      state.war = null;
      state.members = [];
      return;
    }

    const myFid = state.me?.factionId;
    const factions = Array.isArray(war.factions)
      ? war.factions
      : Object.values(war.factions || {});
    const enemy = factions.find((f) => (f.id ?? f.faction_id) !== myFid) || null;
    const mine = factions.find((f) => (f.id ?? f.faction_id) === myFid) || null;
    if (!enemy) {
      state.war = null;
      state.members = [];
      return;
    }

    const enemyId = enemy.id ?? enemy.faction_id;
    state.war = {
      warId: war.war_id ?? war.id,
      enemyId: Number(enemyId),
      enemyName: enemy.name,
      enemyScore: enemy.score,
      myScore: mine?.score,
      target: war.target,
      start: war.start,
    };

    const membersData = await tornGet(`faction/${enemyId}/members`);
    const raw = membersData.members;
    let list = [];
    if (Array.isArray(raw)) list = raw;
    else if (raw && typeof raw === 'object') {
      list = Object.entries(raw).map(([id, m]) => ({ ...m, id: m.id ?? Number(id) }));
    }

    const nowSec = Math.floor(Date.now() / 1000);
    state.members = list.map((m) => {
      const id = Number(m.id ?? m.user_id);
      const member = {
        id,
        name: m.name || 'Unknown',
        level: m.level || 0,
        status: m.status || { state: 'Okay', until: 0 },
        last_action: m.last_action || null,
        revive_setting: m.revive_setting || m.reviveSetting || 'Unknown',
        is_revivable: Boolean(m.is_revivable),
      };
      trackActivity(member, nowSec);
      trackMedCd(member, nowSec);
      return member;
    });
    state.lastRosterAt = Date.now();
    saveActivity();
    saveMedCd();

    await loadSpiesIfNeeded(enemyId);
  }

  function trackActivity(member, nowSec) {
    const id = String(member.id);
    const la = member.last_action || {};
    const ts = Number(la.timestamp || 0);
    const status = String(la.status || '').toLowerCase();
    const prev = state.activity[id] || { hits: 0, lastTs: 0, onlineHits: 0, samples: 0 };
    const next = {
      hits: prev.hits,
      lastTs: ts || prev.lastTs,
      onlineHits: prev.onlineHits,
      samples: (prev.samples || 0) + 1,
      status,
      name: member.name,
    };
    if (ts && ts !== prev.lastTs) next.hits = (prev.hits || 0) + 1;
    if (status === 'online' || status === 'idle') next.onlineHits = (prev.onlineHits || 0) + 1;
    state.activity[id] = next;
  }

  /**
   * Med CD estimate from hosp stay length.
   * Longer hosp ≈ more damage ≈ longer estimated medical cooldown after exit.
   * Shown as an estimate only — Torn does not expose enemy med CD directly.
   */
  function estimateMedCdSeconds(hospDurationSec) {
    // Rough war heuristic: ~40% of hosp time, clamped 45s–6m
    return Math.min(360, Math.max(45, Math.round(hospDurationSec * 0.4)));
  }

  function trackMedCd(member, nowSec) {
    const id = String(member.id);
    const st = member.status || {};
    const stateName = st.state || 'Okay';
    const until = Number(st.until || 0);
    const prev = state.hospSeen[id] || state.medCd[id] || null;

    if (stateName === 'Hospital' && until > nowSec) {
      const entered = prev?.entered || nowSec;
      const duration = Math.max(0, until - entered);
      state.hospSeen[id] = {
        entered,
        until,
        duration,
        inHosp: true,
      };
      state.medCd[id] = {
        ...state.medCd[id],
        inHosp: true,
        hospUntil: until,
        hospDuration: duration,
        estMedCdSec: estimateMedCdSeconds(duration),
        medCdUntil: null,
        exitHpNote: hpNoteFromStatus(st),
      };
      return;
    }

    // Left hospital
    if (prev && prev.inHosp) {
      const duration = prev.duration || Math.max(0, (prev.until || nowSec) - (prev.entered || nowSec));
      const est = estimateMedCdSeconds(duration);
      state.medCd[id] = {
        inHosp: false,
        hospUntil: 0,
        hospDuration: duration,
        estMedCdSec: est,
        medCdUntil: nowSec + est,
        leftAt: nowSec,
        exitHpNote: hpNoteFromStatus(st) || state.medCd[id]?.exitHpNote || null,
      };
      state.hospSeen[id] = { inHosp: false, entered: 0, until: 0, duration };
    }
  }

  function hpNoteFromStatus(st) {
    const desc = String(st.description || st.details || '');
    const m = desc.match(/(\d+)\s*\/\s*(\d+)/);
    if (m) return `${m[1]}/${m[2]} HP`;
    return null;
  }

  async function loadSpiesIfNeeded(factionId) {
    const tsKey = getTsKey();
    if (!tsKey || !factionId) return;

    const cached = GM_getValue(STORAGE.spiesCache, null);
    if (
      cached &&
      cached.factionId === factionId &&
      Date.now() - cached.at < 30 * 60 * 1000
    ) {
      state.spies = cached.spies || {};
      return;
    }

    try {
      const data = await tornStatsFactionSpies(factionId);
      const spies = {};
      const members = data?.faction?.members || data?.spies || {};
      for (const [id, entry] of Object.entries(members)) {
        const spy = entry.spy || entry;
        if (!spy) continue;
        spies[id] = {
          strength: spy.strength,
          defense: spy.defense,
          speed: spy.speed,
          dexterity: spy.dexterity,
          total: spy.total,
          timestamp: spy.timestamp,
        };
      }
      state.spies = spies;
      GM_setValue(STORAGE.spiesCache, { factionId, at: Date.now(), spies });
    } catch (e) {
      console.warn('[War Panel] TornStats:', e);
    }
  }

  function normalizeAttacks(payload) {
    const raw = payload.attacks || payload;
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object') {
      return Object.entries(raw).map(([code, a]) => ({ code, ...a }));
    }
    return [];
  }

  function normalizeAttackEnded(raw) {
    let ended = Number(raw || 0);
    if (!Number.isFinite(ended) || ended <= 0) return 0;
    // ms → seconds
    if (ended > 1e12) ended = Math.floor(ended / 1000);
    return ended;
  }

  function attackPlayers(a) {
    // v2 nested or v1 flat
    const attackerId = a.attacker?.id ?? a.attacker_id ?? null;
    const attackerName = a.attacker?.name ?? a.attacker_name ?? 'Unknown';
    const defenderId = a.defender?.id ?? a.defender_id ?? null;
    const defenderName = a.defender?.name ?? a.defender_name ?? 'Unknown';
    const attackerFaction =
      a.attacker?.faction?.id ?? a.attacker_faction ?? a.attacker?.faction_id ?? null;
    const defenderFaction =
      a.defender?.faction?.id ?? a.defender_faction ?? a.defender?.faction_id ?? null;
    const ff =
      a.modifiers?.fair_fight ??
      a.modifiers?.fairFight ??
      a.fair_fight ??
      null;
    const ended = normalizeAttackEnded(
      a.ended ?? a.timestamp_ended ?? a.timestamp ?? a.started ?? 0
    );
    const result = a.result || '';
    return {
      attackerId: attackerId != null ? Number(attackerId) : null,
      attackerName,
      defenderId: defenderId != null ? Number(defenderId) : null,
      defenderName,
      attackerFaction: attackerFaction != null ? Number(attackerFaction) : null,
      defenderFaction: defenderFaction != null ? Number(defenderFaction) : null,
      ff: ff != null ? Number(ff) : null,
      ended,
      result: String(result),
      ranked: Boolean(a.is_ranked_war ?? a.ranked_war),
    };
  }

  function setRetalMode(mode) {
    state.retalMode = mode === 'all' ? 'all' : 'war';
    GM_setValue(STORAGE.retalMode, state.retalMode);
    const btn = rootEl?.querySelector('#twp-retal-mode');
    if (btn) {
      btn.textContent = state.retalMode === 'all' ? 'Retals: All' : 'Retals: War';
      btn.title =
        state.retalMode === 'all'
          ? 'Showing retals for any hit on faction mates'
          : 'Showing retals only from the war enemy faction';
    }
  }

  function buildRetalList(candidates, nowSec) {
    const myFactionId = state.me?.factionId != null ? Number(state.me.factionId) : null;
    const enemyId = state.war?.enemyId != null ? Number(state.war.enemyId) : null;
    const mode = state.retalMode;
    const myId = state.me?.id != null ? Number(state.me.id) : null;

    let list = candidates.filter((a) => {
      if (!a.attackerId || !a.ended) return false;
      if (a.ended < nowSec - RETAL_WINDOW_SEC) return false;
      const onMe = myId != null && Number(a.defenderId) === myId;
      // Hits on our faction (defender in our faction) or personally on you
      const onUs =
        onMe ||
        (myFactionId != null && Number(a.defenderFaction) === myFactionId);
      if (!onUs) return false;
      // Don't list ourselves as the attacker
      if (myId != null && Number(a.attackerId) === myId) return false;
      // Hits on YOU always count (works without AA / without an active war)
      if (onMe) return true;
      if (mode === 'war') {
        if (!enemyId) return false;
        if (Number(a.attackerFaction) === enemyId) return true;
        // News scrape often has no attackerFaction — match enemy roster IDs
        if (state.members?.length) {
          return state.members.some((m) => Number(m.id) === Number(a.attackerId));
        }
        return a.attackerFaction == null;
      }
      return true;
    });

    // Dedupe by attacker — keep newest hit
    const byAttacker = new Map();
    for (const a of list) {
      const prev = byAttacker.get(a.attackerId);
      if (!prev || a.ended > prev.ended) byAttacker.set(a.attackerId, a);
    }
    return [...byAttacker.values()]
      .sort((a, b) => b.ended - a.ended)
      .slice(0, 15);
  }

  async function loadAttacks() {
    if (!state.me) return;
    const nowSec = Math.floor(Date.now() / 1000);
    const from = nowSec - 60 * 60;

    let outgoing = [];
    let personalIncoming = [];
    try {
      const outData = await tornGet(`user/attacks?filters=outgoing&from=${from}&limit=100`);
      outgoing = normalizeAttacks(outData).map(attackPlayers);
    } catch (e) {
      console.warn('[War Panel] outgoing attacks', e);
    }
    try {
      const inData = await tornGet(`user/attacks?filters=incoming&from=${from}&limit=100`);
      personalIncoming = normalizeAttacks(inData).map(attackPlayers);
    } catch (e) {
      try {
        const all = await tornGet(`user/attacks?from=${from}&limit=100`);
        const list = normalizeAttacks(all).map(attackPlayers);
        outgoing = list.filter((a) => a.attackerId === state.me.id);
        personalIncoming = list.filter((a) => a.defenderId === state.me.id);
      } catch (e2) {
        console.warn('[War Panel] attacks', e2);
      }
    }

    // Record FF from our attacks on targets
    for (const a of outgoing) {
      if (!a.defenderId || a.ff == null) continue;
      const id = String(a.defenderId);
      const prev = state.ff[id];
      if (!prev || a.ended >= (prev.at || 0)) {
        state.ff[id] = {
          ff: a.ff,
          at: a.ended,
          result: a.result,
          name: a.defenderName,
        };
      }
    }
    saveFf();

    // Faction-wide retals need Faction API Access (AA). Without it: personal only.
    let factionHits = [];
    let nextRetalsError = null;
    const factionId = state.me.factionId;
    if (factionId) {
      const paths = [
        `faction/attacks?from=${from}&limit=100`,
        `faction/${factionId}/attacks?from=${from}&limit=100`,
      ];
      let loaded = false;
      let lastErr = null;
      for (const path of paths) {
        try {
          const data = await tornGet(path);
          factionHits = normalizeAttacks(data).map(attackPlayers);
          loaded = true;
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!loaded) {
        nextRetalsError = friendlyFactionAttacksError(lastErr);
        console.warn('[War Panel] faction attacks', lastErr);
      }
    } else {
      nextRetalsError = 'Join a faction for faction-wide retals (personal hits still work).';
    }
    state.retalsError = nextRetalsError;

    const byKey = new Map();
    for (const a of [...factionHits, ...personalIncoming]) {
      if (!a.attackerId || !a.ended) continue;
      const key = `${a.attackerId}:${a.defenderId || 0}:${a.ended}`;
      if (!byKey.has(key)) byKey.set(key, a);
    }
    state.retals = buildRetalList([...byKey.values()], nowSec);
  }

  function friendlyFactionAttacksError(err) {
    const msg = String(err && err.message ? err.message : err || '');
    if (
      /incorrect id-entity relation/i.test(msg) ||
      /\berror\s*7\b/i.test(msg) ||
      /code["\s:]*7\b/i.test(msg)
    ) {
      return 'Faction-wide retals need Faction API Access (ask leadership). Showing hits on you only.';
    }
    if (!msg) return 'Could not load faction attacks. Showing hits on you only.';
    return `${msg} Showing hits on you only.`;
  }

  // Also scrape FF from attack page DOM if present
  function scrapeAttackPageFf() {
    const targetId = getAttackTargetId();
    if (!targetId) return;
    const text = document.body?.innerText || '';
    const m =
      text.match(/Fair\s*Fight[^0-9]*([0-9]+(?:\.[0-9]+)?)/i) ||
      text.match(/FF[^0-9]*([0-9]+(?:\.[0-9]+)?)/i);
    if (!m) return;
    const ff = Number(m[1]);
    if (!(ff >= 1 && ff <= 3)) return;
    const id = String(targetId);
    state.ff[id] = {
      ff,
      at: Math.floor(Date.now() / 1000),
      result: 'scrape',
      name: state.members.find((x) => x.id === targetId)?.name || state.ff[id]?.name,
    };
    saveFf();
  }

  // ---------------------------------------------------------------------------
  // Formatting / derived
  // ---------------------------------------------------------------------------
  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function formatHms(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${pad2(m)}:${pad2(sec)}`;
    return `${m}:${pad2(sec)}`;
  }

  function formatShortNumber(n) {
    if (n == null || Number.isNaN(Number(n))) return '—';
    const v = Number(n);
    if (v >= 1e9) return `${(v / 1e9).toFixed(2)}b`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(2)}m`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
    return String(Math.round(v));
  }

  function chainRemaining() {
    if (!state.chain) return 0;
    if (state.chainEndsAt) {
      return Math.max(0, Math.floor((state.chainEndsAt - Date.now()) / 1000));
    }
    const timeout = Number(state.chain.timeout || 0);
    const elapsed = Math.floor((Date.now() - state.chainFetchedAt) / 1000);
    return Math.max(0, timeout - elapsed);
  }

  function chainColor(seconds) {
    if (seconds <= 0) return '#888';
    // Critical bands (also used when flash is off)
    if (seconds <= 10) return '#ff1010';
    if (seconds <= 30) return '#ffffff';
    if (seconds <= 60) return '#ff3030';
    if (seconds <= 90) return '#ff8c00'; // orange 1:30 → 1:00
    if (seconds <= 120) return '#ffd000';
    return '#3ddc84';
  }

  function memberStatus(member, nowSec) {
    const st = member.status || {};
    const stateName = st.state || 'Okay';
    const until = Number(st.until || 0);
    const remaining = until > nowSec ? until - nowSec : 0;

    if (stateName === 'Hospital') {
      return {
        key: remaining > 0 ? 'hosp' : 'okay',
        label: remaining > 0 ? `Hosp ${formatHms(remaining)}` : 'Okay',
        remaining,
        until,
      };
    }
    if (stateName === 'Jail' || stateName === 'Federal') {
      return {
        key: 'jail',
        label: remaining > 0 ? `Jail ${formatHms(remaining)}` : stateName,
        remaining,
        until,
      };
    }
    if (stateName === 'Abroad' || stateName === 'Traveling') {
      const place = travelPlaceFromDescription(st.description || st.details || '');
      const flying = stateName === 'Traveling' || remaining > 0;
      let label = flying ? 'Travel' : 'Abroad';
      if (remaining > 0) label += ` ${formatHms(remaining)}`;
      if (place) label += flying ? ` → ${place}` : ` ${place}`;
      return { key: 'travel', label, remaining, until, place };
    }
    return { key: 'okay', label: 'Okay', remaining: 0, until: 0 };
  }

  function stripHtmlText(str) {
    return String(str || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function travelPlaceFromDescription(raw) {
    const text = stripHtmlText(raw);
    if (!text) return '';
    const patterns = [
      /returning to torn from\s+(.+)$/i,
      /traveling to\s+(.+)$/i,
      /travelling to\s+(.+)$/i,
      /in\s+(.+)$/i,
      /from\s+(.+)$/i,
      /to\s+(.+)$/i,
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m && m[1]) {
        return m[1]
          .replace(/\.$/, '')
          .replace(/\s+by\s+.+$/i, '')
          .trim();
      }
    }
    return '';
  }

  function reviveInfo(member) {
    const raw = String(member.revive_setting || 'Unknown');
    const enabled =
      Boolean(member.is_revivable) ||
      (/everyone|friends|faction/i.test(raw) && !/no\s*one|nobody|off|disabled/i.test(raw));

    return {
      on: enabled,
      label: enabled ? 'Rev-On' : 'Rev-Off',
      title: `Revive setting: ${raw}`,
    };
  }

  function presenceStatus(member, nowSec) {
    const la = member.last_action || {};
    const ts = Number(la.timestamp || state.activity[String(member.id)]?.lastTs || 0);
    const age = ts ? nowSec - ts : 999999;
    const status = String(la.status || state.activity[String(member.id)]?.status || '').toLowerCase();
    const hist = state.activity[String(member.id)];

    let level = 'offline';
    let label = 'Offline';
    if (status === 'online') {
      level = 'online';
      label = 'Online';
    } else if (status === 'idle') {
      level = 'away';
      label = 'Away';
    } else {
      level = 'offline';
      label = 'Offline';
    }

    return {
      level,
      age,
      label,
      title: `${label} · last action ${ts ? new Date(ts * 1000).toLocaleTimeString() : 'unknown'}${age < 999999 ? ` (${formatHms(age)} ago)` : ''}; samples ${hist?.hits || 0}/${hist?.samples || 0}`,
    };
  }

  function attackUrlFor(userId) {
    return `https://www.torn.com/page.php?sid=attack&user2ID=${userId}`;
  }

  function showCopyToast(message) {
    let toast = document.getElementById('twp-copy-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'twp-copy-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(showCopyToast._t);
    showCopyToast._t = setTimeout(() => toast.classList.remove('visible'), 1800);
  }

  function openAttackPage(userId, ev) {
    if (ev) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    if (!userId) return;
    const url = attackUrlFor(userId);
    // Prefer same-tab navigation with the correct Torn attack URL
    try {
      window.location.assign(url);
    } catch (e) {
      console.warn('[War Panel] navigate failed', e);
      showCopyToast('Could not open — attack URL copied');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).catch(() => {});
      }
    }
  }

  function bindAttackLinks(container) {
    if (!container) return;
    container.querySelectorAll('a.twp-attack-link').forEach((a) => {
      a.title = a.title || 'Open attack page';
      a.addEventListener('click', (ev) => {
        const id = a.dataset.userId || (a.href.match(/user2ID=(\d+)/i) || [])[1];
        openAttackPage(id, ev);
      });
    });
  }

  function medCdInfo(member, nowSec) {
    const info = state.medCd[String(member.id)];
    if (!info) return null;
    if (info.inHosp) {
      return {
        label: `med~${formatHms(info.estMedCdSec || 0)}`,
        title: `Est. med CD after exit ~${formatHms(info.estMedCdSec || 0)} (from ~${formatHms(info.hospDuration || 0)} hosp)${info.exitHpNote ? ` · ${info.exitHpNote}` : ''}`,
        active: false,
      };
    }
    if (info.medCdUntil && info.medCdUntil > nowSec) {
      return {
        label: `mCD ${formatHms(info.medCdUntil - nowSec)}`,
        title: `Estimated med CD remaining${info.exitHpNote ? ` · left hosp ${info.exitHpNote}` : ''}`,
        active: true,
      };
    }
    return null;
  }

  function filteredSortedMembers() {
    const nowSec = Math.floor(Date.now() / 1000);
    let list = state.members.map((m) => {
      const status = memberStatus(m, nowSec);
      const spy = state.spies[String(m.id)] || null;
      const ff = state.ff[String(m.id)] || null;
      const presence = presenceStatus(m, nowSec);
      const med = medCdInfo(m, nowSec);
      const revive = reviveInfo(m);
      return {
        ...m,
        _status: status,
        _spy: spy,
        _ff: ff,
        _presence: presence,
        _med: med,
        _revive: revive,
      };
    });

    if (state.filter !== 'all') {
      list = list.filter((m) => m._status.key === state.filter);
    }

    const sort = state.sort;
    list.sort((a, b) => {
      if (sort === 'hosp') {
        const rem = (m) =>
          m._status.key === 'hosp' || (m._status.key === 'travel' && m._status.remaining > 0)
            ? m._status.remaining
            : Infinity;
        const aH = rem(a);
        const bH = rem(b);
        if (aH !== bH) return aH - bH;
        return a.name.localeCompare(b.name);
      }
      if (sort === 'status') {
        const order = { okay: 0, hosp: 1, jail: 2, travel: 3 };
        const d = (order[a._status.key] ?? 9) - (order[b._status.key] ?? 9);
        if (d !== 0) return d;
        return a.name.localeCompare(b.name);
      }
      if (sort === 'level') return b.level - a.level || a.name.localeCompare(b.name);
      if (sort === 'bs') {
        const at = a._spy?.total ?? -1;
        const bt = b._spy?.total ?? -1;
        return bt - at || a.name.localeCompare(b.name);
      }
      if (sort === 'ff') {
        const af = a._ff?.ff ?? -1;
        const bf = b._ff?.ff ?? -1;
        return bf - af || a.name.localeCompare(b.name);
      }
      if (sort === 'heat') {
        const order = { online: 0, away: 1, offline: 2 };
        const d = (order[a._presence.level] ?? 9) - (order[b._presence.level] ?? 9);
        if (d !== 0) return d;
        return a._presence.age - b._presence.age;
      }
      return a.name.localeCompare(b.name);
    });
    return list;
  }

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------
  function injectStyles() {
    if (document.getElementById('twp-styles')) return;
    const style = document.createElement('style');
    style.id = 'twp-styles';
    style.textContent = `
      #twp-root {
        position: fixed !important; top: 0 !important; right: 0 !important;
        bottom: ${CHAT_INSET_PX}px !important; z-index: 2147483000 !important;
        width: 400px; max-width: 46vw; height: auto;
        max-height: none;
        background: #1a1d23; color: #e8eaed;
        font-family: "Segoe UI", Tahoma, sans-serif; font-size: 12px;
        box-shadow: -4px 0 24px rgba(0,0,0,.45);
        display: flex !important; flex-direction: column;
        border: 1px solid #2e3440;
        border-radius: 0;
        animation: twpFadeIn 0.18s ease-out;
        visibility: visible !important; opacity: 1 !important;
      }
      @keyframes twpFadeIn {
        from { opacity: 0; transform: translateX(8px); }
        to { opacity: 1; transform: translateX(0); }
      }
      #twp-root.twp-moved {
        right: auto; bottom: auto; border-radius: 10px;
        height: min(calc(100vh - ${CHAT_INSET_PX}px), 900px);
        max-height: calc(100vh - ${CHAT_INSET_PX}px);
        box-shadow: 0 8px 28px rgba(0,0,0,.45);
      }
      #twp-root.twp-collapsed {
        display: none !important;
        visibility: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }
      #twp-root * { box-sizing: border-box; }
      #twp-mini {
        position: fixed; top: 72px; right: 12px; z-index: 999999;
        display: none; align-items: center; gap: 10px;
        background: #1a1d23; color: #e8eaed;
        border: 1px solid #2e3440; border-radius: 10px;
        padding: 8px 10px 8px 12px;
        box-shadow: 0 6px 20px rgba(0,0,0,.4);
        font-family: "Segoe UI", Tahoma, sans-serif;
        user-select: none;
      }
      #twp-mini.twp-moved { right: auto; }
      #twp-mini.visible { display: flex; }
      #twp-mini .twp-mini-timer {
        font-size: 22px; font-weight: 800; font-variant-numeric: tabular-nums; line-height: 1;
      }
      #twp-mini .twp-mini-meta { font-size: 11px; color: #9aa0a6; }
      #twp-mini .twp-mini-expand,
      #twp-mini .twp-mini-mute {
        background: #2a3140; border: 1px solid #3a4254; color: #e8eaed;
        border-radius: 6px; padding: 4px 8px; cursor: pointer; font-size: 11px;
      }
      #twp-mini .twp-mini-expand:hover,
      #twp-mini .twp-mini-mute:hover { background: #343c4f; }
      #twp-mini .twp-mini-mute.muted { color: #ff8a8a; border-color: #6a3030; }
      #twp-mini-timer.flash-red { animation: twpFlashRed 0.7s ease-in-out infinite; }
      #twp-mini-timer.flash-white { animation: twpFlashWhite 0.55s ease-in-out infinite; }
      #twp-mini-timer.flash-red-urgent { animation: twpFlashRedUrgent 0.4s ease-in-out infinite; }
      .twp-header {
        padding: 10px 12px; border-bottom: 1px solid #2e3440;
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        cursor: grab; touch-action: none;
      }
      .twp-header:active { cursor: grabbing; }
      .twp-header .twp-btn,
      .twp-header .twp-chip-btn { cursor: pointer; }
      #twp-mini .twp-mini-drag {
        cursor: grab; flex: 1; min-width: 0;
      }
      #twp-mini .twp-mini-drag:active { cursor: grabbing; }
      .twp-title { font-weight: 700; font-size: 14px; }
      .twp-meta { color: #9aa0a6; font-size: 11px; }
      .twp-chip-btn {
        background: #2a3140; color: #e8eaed; border: 1px solid #3a4254;
        border-radius: 4px; height: 26px; padding: 0 8px; cursor: pointer;
        font-size: 11px; font-weight: 600; line-height: 24px; white-space: nowrap;
      }
      .twp-chip-btn:hover { background: #343c4f; }
      .twp-chip-btn.off {
        color: #ff8a8a; border-color: #6a3030; background: #2a1a1a;
      }
      .twp-chip-btn.flash-off {
        color: #f0c674; border-color: #6a5a30; background: #2a2418;
      }
      .twp-btn {
        background: #2a3140; color: #e8eaed; border: 1px solid #3a4254;
        border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 11px;
      }
      .twp-btn:hover { background: #343c4f; }
      .twp-btn.primary { background: #2f6fed; border-color: #2f6fed; }
      .twp-btn.danger { background: #8b2e2e; border-color: #a33; }
      .twp-btn.active { background: #1f6b45; border-color: #2a8f5c; }
      .twp-chain { padding: 12px; text-align: center; border-bottom: 1px solid #2e3440; }
      .twp-chain-timer {
        font-size: 42px; font-weight: 800; line-height: 1;
        font-variant-numeric: tabular-nums;
      }
      .twp-chain-timer.flash-red {
        animation: twpFlashRed 0.7s ease-in-out infinite;
      }
      .twp-chain-timer.flash-white {
        animation: twpFlashWhite 0.55s ease-in-out infinite;
      }
      .twp-chain-timer.flash-red-urgent {
        animation: twpFlashRedUrgent 0.4s ease-in-out infinite;
      }
      @keyframes twpFlashRed {
        0%, 100% { color: #ff3030; text-shadow: 0 0 8px rgba(255,48,48,.35); }
        50% { color: #7a1010; text-shadow: none; }
      }
      @keyframes twpFlashWhite {
        0%, 100% { color: #ffffff; text-shadow: 0 0 10px rgba(255,255,255,.45); }
        50% { color: #8a8a8a; text-shadow: none; }
      }
      @keyframes twpFlashRedUrgent {
        0%, 100% { color: #ff1010; text-shadow: 0 0 14px rgba(255,16,16,.7); }
        50% { color: #ffffff; text-shadow: 0 0 8px rgba(255,255,255,.3); }
      }
      .twp-chain-count { margin-top: 6px; font-size: 15px; font-weight: 600; color: #c5c9d0; }
      .twp-section {
        padding: 8px 12px; border-bottom: 1px solid #2e3440; display: none;
      }
      .twp-section.visible { display: block; }
      .twp-section h3 {
        margin: 0 0 6px; font-size: 11px; text-transform: uppercase;
        letter-spacing: .06em; color: #9aa0a6;
      }
      .twp-retals { background: #2a1515; }
      .twp-retals a { color: #ff8a8a; font-weight: 700; text-decoration: none; }
      .twp-retals a:hover { text-decoration: underline; }
      .twp-retals-note {
        display: none; padding: 6px 12px; font-size: 11px; color: #f0c674;
        background: #241c10; border-bottom: 1px solid #2e3440;
      }
      .twp-retals-note.visible { display: block; }
      .twp-assists { background: #3a2410; }
      .twp-assists strong { color: #ffb040; }
      .twp-toolbar {
        padding: 8px 12px; display: flex; flex-wrap: wrap; gap: 6px;
        border-bottom: 1px solid #2e3440; align-items: center;
      }
      .twp-toolbar select, .twp-settings input {
        background: #12151a; color: #e8eaed; border: 1px solid #3a4254;
        border-radius: 4px; padding: 4px 6px; font-size: 11px;
      }
      .twp-roster { flex: 1; overflow: auto; padding: 0; }
      .twp-row {
        display: grid;
        grid-template-columns: 14px 1fr 30px 52px 78px 48px;
        gap: 3px; align-items: center;
        padding: 5px 8px; border-bottom: 1px solid #242830;
      }
      .twp-row:hover { background: #22262e; }
      .twp-row a {
        color: #7eb6ff; text-decoration: none; font-weight: 600;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        display: inline-block; max-width: 100%;
      }
      .twp-row a:hover { text-decoration: underline; }
      .twp-status-okay { color: #3ddc84; }
      .twp-status-hosp { color: #ff5c5c; font-variant-numeric: tabular-nums; }
      .twp-status-jail { color: #c9a0ff; }
      .twp-status-travel {
        color: #8ab4f8; font-variant-numeric: tabular-nums;
        font-size: 10px; line-height: 1.25; white-space: normal;
      }
      .twp-bs, .twp-ff { color: #f0c674; font-variant-numeric: tabular-nums; text-align: right; font-size: 11px; }
      .twp-tags { display: flex; gap: 3px; flex-wrap: wrap; }
      .twp-tag {
        font-size: 9px; padding: 1px 4px; border-radius: 3px;
        background: #2a3140; color: #c5c9d0; font-weight: 700;
      }
      .twp-tag.rev-on { background: transparent; color: #3ddc84; padding: 0; }
      .twp-tag.rev-off { background: transparent; color: #ff5c5c; padding: 0; }
      .twp-tag.med { background: #1e3a4a; color: #7ec8e3; font-weight: 600; }
      .twp-presence {
        width: 10px; height: 10px; border-radius: 50%;
        justify-self: center;
      }
      .twp-presence.online { background: #22c55e; box-shadow: 0 0 6px rgba(34,197,94,.55); }
      .twp-presence.away { background: #eab308; box-shadow: 0 0 6px rgba(234,179,8,.4); }
      .twp-presence.offline { background: #ef4444; }
      .twp-ff.juicy { color: #7CFF6B; font-weight: 700; }
      .twp-settings {
        padding: 12px; border-top: 1px solid #2e3440; display: none; background: #14171c;
        max-height: 45vh; overflow: auto;
      }
      .twp-settings.open { display: block; }
      .twp-settings label { display: block; margin: 8px 0 4px; color: #9aa0a6; font-size: 11px; }
      .twp-settings input[type="text"],
      .twp-settings input[type="password"],
      .twp-settings input[type="url"],
      .twp-settings input[type="number"] { width: 100%; }
      .twp-settings .row { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
      .twp-settings .hint { color: #6b7280; font-size: 10px; margin-top: 8px; line-height: 1.4; }
      .twp-footer {
        padding: 6px 12px; border-top: 1px solid #2e3440; color: #6b7280;
        font-size: 10px; display: flex; justify-content: space-between;
      }
      .twp-empty { padding: 20px 12px; text-align: center; color: #9aa0a6; }
      .twp-error { color: #ff7b7b; padding: 6px 12px; font-size: 11px; }
      .twp-assist-fab {
        position: fixed; bottom: 24px; right: 420px; z-index: 999998;
        background: #c45c12; color: #fff; border: none; border-radius: 8px;
        padding: 10px 14px; font-weight: 700; cursor: pointer;
        box-shadow: 0 4px 16px rgba(0,0,0,.35); display: none;
      }
      .twp-assist-fab.visible { display: block; }
      body.twp-is-minimized .twp-assist-fab { right: 24px; }
      #twp-copy-toast {
        position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%) translateY(12px);
        z-index: 1000000; background: #111827; color: #e8eaed;
        border: 1px solid #3a4254; border-radius: 8px; padding: 10px 14px;
        font-family: "Segoe UI", Tahoma, sans-serif; font-size: 12px; font-weight: 600;
        box-shadow: 0 8px 24px rgba(0,0,0,.45); opacity: 0; pointer-events: none;
        transition: opacity .15s ease, transform .15s ease;
      }
      #twp-copy-toast.visible {
        opacity: 1; transform: translateX(-50%) translateY(0);
      }
    `;
    document.head.appendChild(style);
  }

  function isMinimized() {
    return Boolean(GM_getValue(STORAGE.collapsed, false));
  }

  function setMinimized(on) {
    GM_setValue(STORAGE.collapsed, Boolean(on));
    applyMinimized();
  }

  function applyMinimized() {
    const mini = document.getElementById('twp-mini');
    const minimized = isMinimized();
    if (rootEl) {
      rootEl.classList.toggle('twp-collapsed', minimized);
      // Must use !important — base #twp-root styles force display/visibility/opacity
      if (minimized) {
        rootEl.style.setProperty('display', 'none', 'important');
        rootEl.style.setProperty('visibility', 'hidden', 'important');
        rootEl.style.setProperty('opacity', '0', 'important');
      } else {
        rootEl.style.removeProperty('display');
        rootEl.style.removeProperty('visibility');
        rootEl.style.removeProperty('opacity');
      }
    }
    if (mini) mini.classList.toggle('visible', minimized);
    document.body.classList.toggle('twp-is-minimized', minimized);
    renderMini();
  }

  function clampPos(left, top, width, height) {
    const usableH = Math.max(0, window.innerHeight - CHAT_INSET_PX);
    const maxL = Math.max(0, window.innerWidth - Math.min(width, window.innerWidth));
    const maxT = Math.max(0, usableH - Math.min(height, usableH));
    return {
      left: Math.min(maxL, Math.max(0, left)),
      top: Math.min(maxT, Math.max(0, top)),
    };
  }

  function applySavedPosition(el, storageKey) {
    if (!el) return;
    const pos = GM_getValue(storageKey, null);
    if (!pos || typeof pos.left !== 'number' || typeof pos.top !== 'number') return;
    const rect = el.getBoundingClientRect();
    const clamped = clampPos(pos.left, pos.top, rect.width || 400, rect.height || 80);
    el.style.left = `${clamped.left}px`;
    el.style.top = `${clamped.top}px`;
    el.style.right = 'auto';
    el.classList.add('twp-moved');
  }

  function makeDraggable(el, handle, storageKey) {
    if (!el || !handle || handle.dataset.twpDragBound === '1') return;
    handle.dataset.twpDragBound = '1';
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;
    let moved = false;

    const onMove = (ev) => {
      if (!dragging) return;
      const point = ev.touches ? ev.touches[0] : ev;
      const dx = point.clientX - startX;
      const dy = point.clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      const rect = el.getBoundingClientRect();
      const next = clampPos(origLeft + dx, origTop + dy, rect.width, rect.height);
      el.style.left = `${next.left}px`;
      el.style.top = `${next.top}px`;
      el.style.right = 'auto';
      el.classList.add('twp-moved');
      if (ev.cancelable) ev.preventDefault();
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
      const rect = el.getBoundingClientRect();
      GM_setValue(storageKey, { left: rect.left, top: rect.top });
    };

    const onDown = (ev) => {
      if (ev.button != null && ev.button !== 0) return;
      if (ev.target.closest('button, a, input, select, textarea, label')) return;
      const point = ev.touches ? ev.touches[0] : ev;
      const rect = el.getBoundingClientRect();
      dragging = true;
      moved = false;
      startX = point.clientX;
      startY = point.clientY;
      origLeft = rect.left;
      origTop = rect.top;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onUp);
    };

    handle.addEventListener('mousedown', onDown);
    handle.addEventListener('touchstart', onDown, { passive: true });

    // If this handle also has a click action, ignore click after a drag
    handle.addEventListener(
      'click',
      (ev) => {
        if (moved) {
          ev.preventDefault();
          ev.stopPropagation();
          moved = false;
        }
      },
      true
    );
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  function ensurePanel() {
    if (rootEl && document.body.contains(rootEl)) return rootEl;

    // Tear down stale nodes from a previous broken inject so we never wire half-UI
    try {
      document.getElementById('twp-root')?.remove();
      document.getElementById('twp-mini')?.remove();
      document.getElementById('twp-assist-fab')?.remove();
    } catch {
      /* ignore */
    }

    injectStyles();
    rootEl = document.createElement('div');
    rootEl.id = 'twp-root';
    rootEl.innerHTML = `
      <div class="twp-header" title="Drag to move">
        <div>
          <div class="twp-title">War Panel</div>
          <div class="twp-meta" id="twp-user-meta">Not signed in</div>
        </div>
        <div style="display:flex;gap:6px;align-items:center;">
          <button class="twp-btn" type="button" id="twp-refresh">Refresh</button>
          <button class="twp-btn" type="button" id="twp-settings-btn">Settings</button>
          <button class="twp-chip-btn" type="button" id="twp-mute" title="Mute alerts">Sound</button>
          <button class="twp-chip-btn" type="button" id="twp-flash-btn" title="Toggle timer flash">Flash</button>
          <button class="twp-chip-btn" type="button" id="twp-minimize" title="Minimize">Min</button>
        </div>
      </div>
      <div class="twp-chain">
        <div class="twp-chain-timer" id="twp-chain-timer">--:--</div>
        <div class="twp-chain-count" id="twp-chain-count">Chain —</div>
      </div>
      <div class="twp-section twp-retals" id="twp-retals"></div>
      <div class="twp-section twp-assists" id="twp-assists"></div>
      <div class="twp-toolbar">
        <select id="twp-filter">
          <option value="all">All</option>
          <option value="okay">Okay</option>
          <option value="hosp">Hosp</option>
          <option value="jail">Jail</option>
          <option value="travel">Travel</option>
        </select>
        <select id="twp-sort">
          <option value="hosp">Sort: Hosp out</option>
          <option value="status">Sort: Status</option>
          <option value="ff">Sort: FF</option>
          <option value="heat">Sort: Activity</option>
          <option value="level">Sort: Level</option>
          <option value="bs">Sort: Battle stats</option>
          <option value="name">Sort: Name</option>
        </select>
        <button class="twp-chip-btn" type="button" id="twp-retal-mode" title="Toggle war vs all faction retals">Retals: War</button>
      </div>
      <div class="twp-retals-note" id="twp-retals-note" hidden></div>
      <div class="twp-error" id="twp-error" hidden></div>
      <div class="twp-roster" id="twp-roster"><div class="twp-empty">Sign in with your Torn API key</div></div>
      <div class="twp-settings" id="twp-settings">
        <label>Torn API key (Full recommended — needs attacks for FF/retals)</label>
        <input id="twp-torn-key" type="password" autocomplete="off" placeholder="Torn API key" />
        <label>TornStats API key (optional)</label>
        <input id="twp-ts-key" type="password" autocomplete="off" placeholder="TornStats API key" />
        <div class="row">
          <label style="margin:0;display:flex;gap:6px;align-items:center;">
            <input id="twp-sounds" type="checkbox" /> Chain alert sounds
          </label>
        </div>
        <div class="row">
          <label style="margin:0;display:flex;gap:6px;align-items:center;">
            <input id="twp-flash" type="checkbox" /> Flash timer under 60s (off = solid color only)
          </label>
        </div>
        <div style="margin-top:10px;display:flex;gap:6px;">
          <button class="twp-btn primary" type="button" id="twp-save">Save</button>
          <button class="twp-btn danger" type="button" id="twp-clear">Clear keys</button>
          <button class="twp-btn" type="button" id="twp-test-sound">Test sound</button>
          <button class="twp-btn" type="button" id="twp-reset-pos">Reset position</button>
        </div>
        <p class="hint">
          Click a name to open their attack page. Lights: green Online, yellow Away, red Offline.
          1:30 chain → warning beep (orange timer until 1:00). 45s → urgent beep.
        </p>
      </div>
      <div class="twp-footer">
        <span>War Panel</span>
        <span id="twp-updated">—</span>
      </div>
    `;
    document.body.appendChild(rootEl);

    if (!document.getElementById('twp-mini')) {
      const mini = document.createElement('div');
      mini.id = 'twp-mini';
      mini.title = 'Click to expand War Panel';
      mini.innerHTML = `
        <div class="twp-mini-drag" id="twp-mini-drag" title="Drag to move">
          <div class="twp-mini-timer" id="twp-mini-timer">--:--</div>
          <div class="twp-mini-meta" id="twp-mini-meta">War Panel</div>
        </div>
        <button class="twp-mini-mute" type="button" id="twp-mini-mute" title="Mute alerts">Sound</button>
        <button class="twp-mini-mute" type="button" id="twp-mini-flash" title="Toggle timer flash">Flash</button>
        <button class="twp-mini-expand" type="button" id="twp-expand">Open</button>
      `;
      document.body.appendChild(mini);
    }

    if (!document.getElementById('twp-assist-fab')) {
      const fab = document.createElement('button');
      fab.className = 'twp-assist-fab';
      fab.id = 'twp-assist-fab';
      fab.type = 'button';
      fab.textContent = 'Request assist';
      document.body.appendChild(fab);
    }

    if (rootEl.dataset.twpWired !== '1') {
      rootEl.dataset.twpWired = '1';
      try {
        wireEvents();
      } catch (e) {
        console.error('[War Panel] wireEvents failed', e);
        showBootError(e);
      }
    }
    try {
      applySavedPosition(rootEl, STORAGE.panelPos);
      applySavedPosition(document.getElementById('twp-mini'), STORAGE.miniPos);
      makeDraggable(rootEl, rootEl.querySelector('.twp-header'), STORAGE.panelPos);
      makeDraggable(
        document.getElementById('twp-mini'),
        document.getElementById('twp-mini-drag'),
        STORAGE.miniPos
      );
    } catch (e) {
      console.warn('[War Panel] position/drag setup', e);
    }
    try {
      applyMinimized();
    } catch (e) {
      console.warn('[War Panel] applyMinimized', e);
      // Last resort: force panel visible
      rootEl.classList.remove('twp-collapsed');
      rootEl.style.display = 'flex';
    }
    return rootEl;
  }

  function setSoundsOn(on) {
    state.soundsOn = Boolean(on);
    GM_setValue(STORAGE.sounds, state.soundsOn);
    syncHeaderToggles();
    const soundsCb = rootEl?.querySelector('#twp-sounds');
    if (soundsCb) soundsCb.checked = state.soundsOn;
  }

  function setFlashOn(on) {
    state.flashOn = Boolean(on);
    GM_setValue(STORAGE.flash, state.flashOn);
    syncHeaderToggles();
    const flashCb = rootEl?.querySelector('#twp-flash');
    if (flashCb) flashCb.checked = state.flashOn;
    renderChain();
  }

  function syncHeaderToggles() {
    const muteBtn = rootEl?.querySelector('#twp-mute');
    if (muteBtn) {
      muteBtn.textContent = state.soundsOn ? 'Sound' : 'Muted';
      muteBtn.title = state.soundsOn ? 'Mute alerts' : 'Unmute alerts';
      muteBtn.classList.toggle('off', !state.soundsOn);
    }
    const flashBtn = rootEl?.querySelector('#twp-flash-btn');
    if (flashBtn) {
      flashBtn.textContent = state.flashOn ? 'Flash' : 'Solid';
      flashBtn.title = state.flashOn ? 'Disable timer flash' : 'Enable timer flash';
      flashBtn.classList.toggle('flash-off', !state.flashOn);
    }
    const miniMute = document.getElementById('twp-mini-mute');
    if (miniMute) {
      miniMute.textContent = state.soundsOn ? 'Sound' : 'Muted';
      miniMute.title = state.soundsOn ? 'Mute alerts' : 'Unmute alerts';
      miniMute.classList.toggle('muted', !state.soundsOn);
    }
    const miniFlash = document.getElementById('twp-mini-flash');
    if (miniFlash) {
      miniFlash.textContent = state.flashOn ? 'Flash' : 'Solid';
      miniFlash.title = state.flashOn ? 'Disable timer flash' : 'Enable timer flash';
      miniFlash.classList.toggle('muted', !state.flashOn);
    }
  }

  function applyChainFlash(el, remaining) {
    if (!el) return;
    el.classList.remove('flash-red', 'flash-white', 'flash-red-urgent');
    if (!state.flashOn || remaining <= 0) return;
    if (remaining <= 10) el.classList.add('flash-red-urgent');
    else if (remaining <= 30) el.classList.add('flash-white');
    else if (remaining <= 60) el.classList.add('flash-red');
  }

  function on(el, event, handler, opts) {
    if (!el) return;
    el.addEventListener(event, handler, opts);
  }

  function wireEvents() {
    on(rootEl.querySelector('#twp-minimize'), 'click', () => {
      setMinimized(true);
      ensureAudio();
    });

    on(rootEl.querySelector('#twp-mute'), 'click', () => {
      setSoundsOn(!state.soundsOn);
      ensureAudio();
    });
    on(rootEl.querySelector('#twp-flash-btn'), 'click', () => {
      setFlashOn(!state.flashOn);
      ensureAudio();
    });

    const mini = document.getElementById('twp-mini');
    const expand = () => {
      setMinimized(false);
      ensureAudio();
    };
    on(mini?.querySelector('#twp-expand'), 'click', (e) => {
      e.stopPropagation();
      expand();
    });
    on(mini?.querySelector('#twp-mini-mute'), 'click', (e) => {
      e.stopPropagation();
      setSoundsOn(!state.soundsOn);
      ensureAudio();
    });
    on(mini?.querySelector('#twp-mini-flash'), 'click', (e) => {
      e.stopPropagation();
      setFlashOn(!state.flashOn);
      ensureAudio();
    });
    on(mini?.querySelector('#twp-mini-drag'), 'dblclick', expand);
    syncHeaderToggles();

    on(rootEl.querySelector('#twp-settings-btn'), 'click', () => {
      const el = rootEl.querySelector('#twp-settings');
      if (!el) return;
      el.classList.toggle('open');
      if (el.classList.contains('open')) fillSettingsForm();
      ensureAudio();
    });

    on(rootEl.querySelector('#twp-save'), 'click', async () => {
      GM_setValue(STORAGE.tornKey, rootEl.querySelector('#twp-torn-key')?.value.trim() || '');
      GM_setValue(STORAGE.tsKey, rootEl.querySelector('#twp-ts-key')?.value.trim() || '');
      setSoundsOn(!!rootEl.querySelector('#twp-sounds')?.checked);
      setFlashOn(!!rootEl.querySelector('#twp-flash')?.checked);
      GM_deleteValue('twp_sync_url');
      GM_deleteValue('twp_sync_token');
      GM_deleteValue(STORAGE.spiesCache);
      rootEl.querySelector('#twp-settings')?.classList.remove('open');
      await boot();
    });

    on(rootEl.querySelector('#twp-clear'), 'click', () => {
      GM_deleteValue(STORAGE.tornKey);
      GM_deleteValue(STORAGE.tsKey);
      GM_deleteValue('twp_sync_url');
      GM_deleteValue('twp_sync_token');
      GM_deleteValue(STORAGE.spiesCache);
      GM_deleteValue(STORAGE.sessionCache);
      fillSettingsForm();
      state.me = null;
      state.members = [];
      state.chain = null;
      state.war = null;
      state.retals = [];
      render();
    });

    on(rootEl.querySelector('#twp-test-sound'), 'click', () => {
      ensureAudio();
      soundChain90();
      setTimeout(() => soundChain45(), 700);
    });

    on(rootEl.querySelector('#twp-reset-pos'), 'click', () => {
      GM_deleteValue(STORAGE.panelPos);
      GM_deleteValue(STORAGE.miniPos);
      rootEl.classList.remove('twp-moved');
      rootEl.style.left = '';
      rootEl.style.top = '';
      rootEl.style.right = '';
      const miniEl = document.getElementById('twp-mini');
      if (miniEl) {
        miniEl.classList.remove('twp-moved');
        miniEl.style.left = '';
        miniEl.style.top = '';
        miniEl.style.right = '';
      }
    });

    on(rootEl.querySelector('#twp-refresh'), 'click', async () => {
      try {
        await Promise.all([loadChain(), loadWarAndRoster(), loadAttacks()]);
        scrapeAttackPageFf();
        render();
      } catch (e) {
        state.error = e.message;
        render();
      }
    });

    const filterEl = rootEl.querySelector('#twp-filter');
    const sortEl = rootEl.querySelector('#twp-sort');
    if (filterEl) {
      filterEl.value = state.filter;
      on(filterEl, 'change', () => {
        state.filter = filterEl.value;
        GM_setValue(STORAGE.filter, state.filter);
        renderRoster();
      });
    }
    if (sortEl) {
      sortEl.value = state.sort;
      on(sortEl, 'change', () => {
        state.sort = sortEl.value;
        GM_setValue(STORAGE.sort, state.sort);
        renderRoster();
      });
    }

    setRetalMode(state.retalMode);
    on(rootEl.querySelector('#twp-retal-mode'), 'click', async () => {
      setRetalMode(state.retalMode === 'war' ? 'all' : 'war');
      try {
        await loadAttacks();
      } catch (e) {
        console.warn('[War Panel] retal mode refresh', e);
      }
      renderRetals();
      renderMini();
    });

    on(document.getElementById('twp-assist-fab'), 'click', onAssistClick);
    document.addEventListener('click', () => ensureAudio(), { once: true });
  }

  function fillSettingsForm() {
    if (!rootEl) return;
    const torn = rootEl.querySelector('#twp-torn-key');
    const ts = rootEl.querySelector('#twp-ts-key');
    const sounds = rootEl.querySelector('#twp-sounds');
    const flash = rootEl.querySelector('#twp-flash');
    if (torn) torn.value = getTornKey();
    if (ts) ts.value = getTsKey();
    if (sounds) sounds.checked = state.soundsOn;
    if (flash) flash.checked = state.flashOn;
  }

  function render() {
    ensurePanel();
    const meta = rootEl.querySelector('#twp-user-meta');
    meta.textContent = state.me
      ? `${state.me.name} · ${state.me.factionName || 'No faction'}`
      : getTornKey()
        ? 'Loading…'
        : 'Not signed in';

    const err = rootEl.querySelector('#twp-error');
    if (state.error) {
      err.hidden = false;
      err.textContent = state.error;
    } else {
      err.hidden = true;
      err.textContent = '';
    }

    renderChain();
    renderRetals();
    renderAssists();
    renderRoster();
    renderFooter();
    renderAssistFab();
  }

  function renderChain() {
    const timerEl = rootEl.querySelector('#twp-chain-timer');
    const countEl = rootEl.querySelector('#twp-chain-count');
    if (!state.chain) {
      timerEl.textContent = '--:--';
      timerEl.style.color = '#888';
      applyChainFlash(timerEl, 0);
      countEl.textContent = 'No active chain';
      renderMini();
      return;
    }
    const remaining = chainRemaining();
    timerEl.textContent = formatHms(remaining);
    if (!state.flashOn || remaining > 60 || remaining <= 0) {
      timerEl.style.color = chainColor(remaining);
    } else {
      timerEl.style.color = '';
    }
    applyChainFlash(timerEl, remaining);
    const current = state.chain.current ?? 0;
    const max = state.chain.max ?? current;
    const mod = state.chain.modifier != null ? ` · x${state.chain.modifier}` : '';
    countEl.textContent = `Chain ${current}${max ? ` / ${max}` : ''}${mod}`;
    renderMini();
  }

  function renderMini() {
    const timerEl = document.getElementById('twp-mini-timer');
    const metaEl = document.getElementById('twp-mini-meta');
    if (!timerEl || !metaEl) return;
    if (!state.chain) {
      timerEl.textContent = '--:--';
      timerEl.style.color = '#888';
      applyChainFlash(timerEl, 0);
      metaEl.textContent = state.war ? `vs ${state.war.enemyName}` : 'War Panel';
      return;
    }
    const remaining = chainRemaining();
    timerEl.textContent = formatHms(remaining);
    if (!state.flashOn || remaining > 60 || remaining <= 0) {
      timerEl.style.color = chainColor(remaining);
    } else {
      timerEl.style.color = '';
    }
    applyChainFlash(timerEl, remaining);
    const current = state.chain.current ?? 0;
    metaEl.textContent = `Chain ${current}${state.retals.length ? ` · ${state.retals.length} retal` : ''}`;
  }

  function renderRetalsNote() {
    const note = rootEl.querySelector('#twp-retals-note');
    if (!note) return;
    const parts = [];
    if (state.retalsError) parts.push(state.retalsError);
    if (
      state.retalMode === 'war' &&
      !state.war?.enemyId &&
      !(state.retals || []).length
    ) {
      parts.push('No active war — switch to Retals: All for other hits.');
    }
    if (parts.length) {
      note.hidden = false;
      note.classList.add('visible');
      note.textContent = parts.join(' ');
    } else {
      note.hidden = true;
      note.classList.remove('visible');
      note.textContent = '';
    }
  }

  function renderRetals() {
    const box = rootEl.querySelector('#twp-retals');
    if (!box) return;
    const nowSec = Math.floor(Date.now() / 1000);
    state.retals = (state.retals || []).filter(
      (a) => a.ended >= nowSec - RETAL_WINDOW_SEC
    );

    renderRetalsNote();

    // Only show the Retals box when there are live retal rows (no empty flicker)
    if (!state.retals.length) {
      box.classList.remove('visible');
      box.innerHTML = '';
      box.dataset.sig = '';
      return;
    }

    const modeLabel = state.retalMode === 'all' ? 'All' : 'War';
    const html =
      `<h3>Retals · ${modeLabel}</h3>` +
      state.retals
        .map((a) => {
          const left = Math.max(0, RETAL_WINDOW_SEC - (nowSec - a.ended));
          const link = attackUrlFor(a.attackerId);
          const hit = a.defenderName ? ` hit ${escapeHtml(a.defenderName)}` : '';
          return `<div><a class="twp-attack-link" data-user-id="${a.attackerId}" href="${link}">${escapeHtml(a.attackerName)}</a><span style="color:#9aa0a6">${hit} · <strong style="color:#ff8a8a">${formatHms(left)}</strong> left${a.result ? ` · ${escapeHtml(a.result)}` : ''}</span></div>`;
        })
        .join('');

    const sig = html.replace(/<strong[^>]*>[^<]*<\/strong>/g, ''); // ignore ticking timer text
    if (box.dataset.sig === sig && box.classList.contains('visible')) {
      // Update only countdowns in place to avoid full redraw flicker
      const timers = box.querySelectorAll('strong');
      state.retals.forEach((a, i) => {
        if (!timers[i]) return;
        const left = Math.max(0, RETAL_WINDOW_SEC - (nowSec - a.ended));
        timers[i].textContent = formatHms(left);
      });
      return;
    }

    box.dataset.sig = sig;
    box.classList.add('visible');
    box.innerHTML = html;
    bindAttackLinks(box);
  }

  function renderAssists() {
    const box = rootEl.querySelector('#twp-assists');
    const assists = Object.values(state.assists || {});
    if (!assists.length) {
      box.classList.remove('visible');
      box.innerHTML = '';
      return;
    }
    box.classList.add('visible');
    box.innerHTML =
      `<h3>Assists</h3>` +
      assists
        .map((a) => {
          const link = attackUrlFor(a.targetId);
          return `<div><strong>ASSIST</strong> ${escapeHtml(a.attackerName)} → <a class="twp-attack-link" data-user-id="${a.targetId}" href="${link}" style="color:#ffb040">${escapeHtml(a.targetName || a.targetId)}</a></div>`;
        })
        .join('');
    bindAttackLinks(box);
  }

  function renderRoster() {
    const roster = rootEl.querySelector('#twp-roster');
    if (!getTornKey()) {
      roster.innerHTML = '<div class="twp-empty">Open Settings and add your Torn API key</div>';
      return;
    }
    if (!state.war) {
      roster.innerHTML = '<div class="twp-empty">No active ranked war detected</div>';
      return;
    }

    const members = filteredSortedMembers();
    const header = `<div style="padding:8px 12px;color:#9aa0a6;">vs <strong style="color:#e8eaed">${escapeHtml(state.war.enemyName)}</strong> · ${members.length} shown · ${state.war.myScore ?? '?'}–${state.war.enemyScore ?? '?'}</div>`;

    if (!members.length) {
      roster.innerHTML = header + '<div class="twp-empty">No members match filters</div>';
      return;
    }

    const rows = members
      .map((m) => {
        const attack = attackUrlFor(m.id);
        const statusClass = `twp-status-${m._status.key}`;
        const bs = m._spy?.total != null ? formatShortNumber(m._spy.total) : '—';
        const ffVal = m._ff?.ff;
        const ffText = ffVal != null ? Number(ffVal).toFixed(2) : '—';
        const ffClass = ffVal != null && ffVal >= 2.5 ? 'twp-ff juicy' : 'twp-ff';
        const revClass = m._revive.on ? 'rev-on' : 'rev-off';
        const tags = [
          `<span class="twp-tag ${revClass}" title="${escapeHtml(m._revive.title)}">${escapeHtml(m._revive.label)}</span>`,
        ];
        if (m._med) {
          tags.push(
            `<span class="twp-tag med" title="${escapeHtml(m._med.title)}">${escapeHtml(m._med.label)}</span>`
          );
        }

        return `
          <div class="twp-row" data-id="${m.id}">
            <span class="twp-presence ${m._presence.level}" title="${escapeHtml(m._presence.title)}"></span>
            <div>
              <a class="twp-attack-link" data-user-id="${m.id}" href="${attack}" title="Open attack page">${escapeHtml(m.name)}</a>
              <div class="twp-tags">${tags.join('')}</div>
            </div>
            <div>L${m.level}</div>
            <div class="${ffClass}" title="Recorded Fair Fight">${ffText}</div>
            <div class="${statusClass}">${escapeHtml(m._status.label)}</div>
            <div class="twp-bs" title="Battle stats">${bs}</div>
          </div>`;
      })
      .join('');

    roster.innerHTML = header + rows;
    bindAttackLinks(roster);
  }

  function renderFooter() {
    rootEl.querySelector('#twp-updated').textContent = state.lastRosterAt
      ? `Updated ${new Date(state.lastRosterAt).toLocaleTimeString()}`
      : '—';
  }

  function renderAssistFab() {
    const fab = document.getElementById('twp-assist-fab');
    if (!fab) return;
    const onAttack = /sid=attack|loader\.php\?sid=attack|attack\.php/i.test(
      location.href + location.hash
    );
    const targetId = getAttackTargetId();
    if (onAttack && targetId && getTornKey()) {
      fab.classList.add('visible');
      fab.dataset.targetId = String(targetId);
      scrapeAttackPageFf();
    } else {
      fab.classList.remove('visible');
    }
  }

  function getAttackTargetId() {
    const href = location.href;
    let m = href.match(/user2ID=(\d+)/i) || href.match(/XID=(\d+)/i);
    if (m) return Number(m[1]);
    const links = [...document.querySelectorAll('a[href*="profiles.php?XID="]')];
    for (const link of links) {
      m = link.href.match(/XID=(\d+)/);
      if (m && state.me && Number(m[1]) !== state.me.id) return Number(m[1]);
    }
    return null;
  }

  function onAssistClick() {
    const fab = document.getElementById('twp-assist-fab');
    const targetId = Number(fab?.dataset.targetId || getAttackTargetId());
    if (!targetId) {
      alert('Could not detect attack target');
      return;
    }
    if (!state.me) {
      alert('Sign in with your Torn API key first');
      return;
    }
    const member = state.members.find((m) => m.id === targetId);
    const targetName = member?.name || null;
    scrapeAttackPageFf();
    state.assists[String(state.me.id)] = {
      attackerId: state.me.id,
      attackerName: state.me.name,
      targetId,
      targetName,
      createdAt: Date.now(),
    };
    renderAssists();
    fab.textContent = 'Assist requested';
    setTimeout(() => {
      fab.textContent = 'Request assist';
    }, 2000);
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ---------------------------------------------------------------------------
  // Boot / loops
  // ---------------------------------------------------------------------------
  async function boot() {
    twpBeacon('War Panel 1.5.9 booting…');
    console.log('[War Panel] v1.5.9 booting on', location.href);

    // Paint the panel first — never block UI on data loads
    try {
      ensurePanel();
      applyMinimized();
      render();
      twpBeacon('War Panel 1.5.9 UI mounted');
      // Remove beacon after a moment so it doesn't sit on the page
      setTimeout(function () {
        try {
          var b = document.getElementById('twp-alive-beacon');
          if (b) b.remove();
        } catch (_) {
          /* ignore */
        }
      }, 4000);
    } catch (e) {
      showBootError(e);
      return;
    }

    state.error = null;
    if (!getTornKey()) {
      try {
        GM_deleteValue(STORAGE.sessionCache);
      } catch {
        /* ignore */
      }
      rootEl.querySelector('#twp-settings')?.classList.add('open');
      try {
        fillSettingsForm();
      } catch (e) {
        console.warn('[War Panel] fillSettingsForm', e);
      }
      render();
      startLoops();
      return;
    }

    if (hydrateFromSessionCache()) {
      render();
      startLoops();
    }

    try {
      await loadIdentity();
      await Promise.all([loadChain(), loadWarAndRoster(), loadAttacks()]);
      scrapeAttackPageFf();
      state.error = null;
      saveSessionCache();
    } catch (e) {
      state.error = e.message;
      console.error('[War Panel]', e);
    }
    render();
    startLoops();
  }

  function startLoops() {
    stopLoops();
    timers.ui = setInterval(() => {
      if (!rootEl) return;
      checkChainAlerts();
      renderChain();
      renderRetals();
      renderRoster();
      renderAssists();
      renderAssistFab();
    }, UI_TICK_MS);

    timers.chain = setInterval(async () => {
      if (!getTornKey()) return;
      try {
        await loadChain();
        saveSessionCache();
      } catch (e) {
        state.error = e.message;
      }
    }, CHAIN_POLL_MS);

    timers.roster = setInterval(async () => {
      if (!getTornKey()) return;
      try {
        await loadWarAndRoster();
        state.error = null;
        saveSessionCache();
      } catch (e) {
        state.error = e.message;
      }
    }, ROSTER_POLL_MS);

    timers.attacks = setInterval(async () => {
      if (!getTornKey()) return;
      try {
        await loadAttacks();
        saveSessionCache();
      } catch (e) {
        console.warn('[War Panel] attacks poll', e);
      }
    }, ATTACKS_POLL_MS);
  }

  function stopLoops() {
    Object.keys(timers).forEach((k) => {
      if (timers[k]) clearInterval(timers[k]);
      timers[k] = null;
    });
  }

  function installNavHooks() {
    try {
      window.addEventListener('hashchange', () => {
        try {
          renderAssistFab();
          scrapeAttackPageFf();
        } catch (e) {
          console.warn('[War Panel] hashchange', e);
        }
      });
    } catch (e) {
      console.warn('[War Panel] hashchange hook', e);
    }
    try {
      const _push = history.pushState.bind(history);
      history.pushState = function () {
        const ret = _push.apply(history, arguments);
        setTimeout(() => {
          try {
            renderAssistFab();
            scrapeAttackPageFf();
          } catch (e) {
            console.warn('[War Panel] pushState', e);
          }
        }, 50);
        return ret;
      };
    } catch (e) {
      console.warn('[War Panel] pushState hook skipped', e);
    }
  }

  function waitForBody() {
    if (document.body) {
      try {
        installNavHooks();
      } catch (e) {
        console.warn('[War Panel] nav hooks', e);
      }
      boot().catch(showBootError);
    } else {
      setTimeout(waitForBody, 50);
    }
  }

  try {
    twpBeacon('War Panel 1.5.5 waiting for body…');
    waitForBody();
  } catch (err) {
    showBootError(err);
  }
})();
