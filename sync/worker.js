/**
 * The 7th Terminal BFF
 * Auth (licensed factions), Torn proxy, stock MV cache, dibs/assists via Durable Object.
 */

import { FactionRoom } from './faction-do.js';

export { FactionRoom };

const TORN_API = 'https://api.torn.com/v2';
const ADMIN_TTL_SECONDS = 8 * 60 * 60;
const LICENSE_TTL_SECONDS = 6 * 60 * 60;
const CONFIG_KEY = 'config:allowedFactionIds';
const STOCK_CACHE_KEY = 'cache:stocks-catalog';
const COMMENT = 'SeventhTerminal';

/** Known cash / item dividends for active stocks (fallback when API omits payout). */
const ACTIVE_BENEFIT_FALLBACK = {
  ASS: { kind: 'item', itemId: null, label: 'Six Pack of Alcohol' },
  BAG: { kind: 'item', itemId: null, label: 'Ammunition Pack' },
  CNC: { kind: 'cash', value: 80_000_000 },
  EWM: { kind: 'item', itemId: null, label: 'Box of Grenades' },
  EVL: { kind: 'happy', value: 1000 },
  FHG: { kind: 'item', itemId: null, label: 'Feathery Hotel Coupon' },
  GRN: { kind: 'cash', value: 4_000_000 },
  CBD: { kind: 'nerve', value: 50 },
  HRG: { kind: 'property', label: 'Random Property' },
  IOU: { kind: 'cash', value: 12_000_000 },
  LAG: { kind: 'item', itemId: null, label: 'Lawyer Business Card' },
  LSC: { kind: 'item', itemId: null, label: 'Lottery Voucher' },
  MCS: { kind: 'energy', value: 100, maxIncrements: 10 },
  MUN: { kind: 'item', itemId: null, label: 'Six Pack of Energy Drink' },
  PRN: { kind: 'item', itemId: null, label: 'Erotic DVD' },
  PTS: { kind: 'points', value: 100 },
  SYM: { kind: 'item', itemId: null, label: 'Drug Pack' },
  TMI: { kind: 'cash', value: 25_000_000 },
  TCT: { kind: 'cash', value: 1_000_000 },
  TSB: { kind: 'cash', value: 50_000_000 },
  TCC: { kind: 'item', itemId: null, label: 'Clothing Cache' },
  THS: { kind: 'item', itemId: null, label: 'Box of Medical Supplies' },
};

/** Approximate MV proxies when item id unknown (updated via live item lookup when possible). */
const LABEL_MV_HINTS = {
  'Six Pack of Alcohol': 850_000,
  'Ammunition Pack': 4_500_000,
  'Box of Grenades': 2_800_000,
  'Feathery Hotel Coupon': 3_200_000,
  'Lawyer Business Card': 2_100_000,
  'Lottery Voucher': 900_000,
  'Six Pack of Energy Drink': 6_500_000,
  'Erotic DVD': 1_200_000,
  'Drug Pack': 3_800_000,
  'Clothing Cache': 15_000_000,
  'Box of Medical Supplies': 1_800_000,
  'Random Property': 50_000_000,
};

const POINTS_MV = 45_000; // ~$/point heuristic for ROI
const ENERGY_MV = 35_000;
const NERVE_MV = 25_000;
const HAPPY_MV = 800;

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';

      if (request.method === 'GET' && (path === '/' || path === '/health')) {
        return json(
          { ok: true, service: 'seventh-terminal', product: 'The 7th Terminal' },
          200,
          cors
        );
      }

      if (request.method === 'GET' && path === '/admin') {
        return adminPage(cors);
      }

      if (request.method === 'POST' && path === '/admin/login') {
        return json(await handleAdminLogin(request, env), 200, cors);
      }

      if (request.method === 'GET' && path === '/admin/config') {
        const admin = await requireAdminSession(request, env);
        if (admin.error) return json({ error: admin.error }, admin.status, cors);
        return json({ allowedFactionIds: await getAllowedFactionIds(env) }, 200, cors);
      }

      if (request.method === 'PUT' && path === '/admin/config') {
        const admin = await requireAdminSession(request, env);
        if (admin.error) return json({ error: admin.error }, admin.status, cors);
        const body = await safeJson(request);
        const ids = normalizeFactionIds(body.allowedFactionIds);
        await setAllowedFactionIds(env, ids);
        return json({ ok: true, allowedFactionIds: ids }, 200, cors);
      }

      if (request.method === 'POST' && path === '/license') {
        return json(await handleLicense(request, env), 200, cors);
      }

      if (request.method === 'POST' && path === '/auth') {
        return json(await handleAuth(request, env), 200, cors);
      }

      // Public catalog needs session + key (rate-limited via user keys + shared cache)
      const session = await requireSession(request, env);
      if (session.error) {
        return json({ error: session.error }, session.status, cors);
      }

      if (request.method === 'GET' && path === '/stocks/catalog') {
        const tornKey = tornKeyFrom(request);
        if (!tornKey) return json({ error: 'Missing X-Torn-Key' }, 400, cors);
        return json(await getStocksCatalog(env, tornKey), 200, cors);
      }

      // TornStats proxy (browser cannot call tornstats.com directly — CORS)
      if (request.method === 'GET' && path.startsWith('/tornstats/')) {
        const tsKey = String(request.headers.get('X-TornStats-Key') || '').trim();
        if (!tsKey) return json({ error: 'Missing X-TornStats-Key' }, 400, cors);
        const rest = path.slice('/tornstats/'.length) + (url.search || '');
        const tsUrl = `https://www.tornstats.com/api/v2/${encodeURIComponent(tsKey)}/${rest}`;
        const res = await fetch(tsUrl, { headers: { Accept: 'application/json' } });
        const data = await res.json().catch(() => ({}));
        return json(data, res.ok ? 200 : 400, cors);
      }

      if (request.method === 'GET' && path.startsWith('/torn/')) {
        const tornKey = tornKeyFrom(request);
        if (!tornKey) return json({ error: 'Missing X-Torn-Key' }, 400, cors);
        const tornPath = path.slice('/torn/'.length) + (url.search || '');
        const data = await tornGet(tornKey, tornPath);
        if (data && data.error) {
          return json(
            { error: data.error.error || JSON.stringify(data.error) },
            400,
            cors
          );
        }
        return json(data, 200, cors);
      }

      // Dibs / assists → Durable Object
      if (
        path === '/state' ||
        path.startsWith('/dibs/') ||
        path === '/assists' ||
        path.startsWith('/assists/')
      ) {
        return forwardToFactionDo(env, session, request, path, cors);
      }

      return json({ error: 'Not found' }, 404, cors);
    } catch (err) {
      return json({ error: err.message || 'Server error' }, 500, cors);
    }
  },
};

function tornKeyFrom(request) {
  return String(request.headers.get('X-Torn-Key') || '').trim();
}

async function forwardToFactionDo(env, session, request, path, cors) {
  if (!env.FACTION_DO) {
    return json({ error: 'FACTION_DO binding missing' }, 500, cors);
  }
  const id = env.FACTION_DO.idFromName(`faction:${session.factionId}`);
  const stub = env.FACTION_DO.get(id);
  const headers = new Headers(request.headers);
  headers.set(
    'X-Session',
    JSON.stringify({
      userId: session.userId,
      name: session.name,
      factionId: session.factionId,
    })
  );
  const doReq = new Request(new URL(path, 'https://faction-do.internal'), {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text(),
  });
  const res = await stub.fetch(doReq);
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Torn-Key, X-TornStats-Key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function secret(env) {
  return env.SESSION_SECRET || 'dev-insecure-change-me';
}

function ownerIds(env) {
  return String(env.OWNER_TORN_IDS || '')
    .split(',')
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function normalizeFactionIds(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const n = Number(item);
    if (!Number.isFinite(n) || n <= 0) continue;
    const id = Math.floor(n);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

async function getAllowedFactionIds(env) {
  const raw = await env.WARPANEL.get(CONFIG_KEY);
  if (!raw) return [];
  try {
    return normalizeFactionIds(JSON.parse(raw));
  } catch {
    return [];
  }
}

async function setAllowedFactionIds(env, ids) {
  await env.WARPANEL.put(CONFIG_KEY, JSON.stringify(normalizeFactionIds(ids)));
}

async function resolveTornUser(tornKey) {
  const profile = await tornGet(tornKey, 'user');
  if (profile.error) {
    throw new Error(profile.error.error || 'Invalid Torn API key');
  }

  let userId = profile.profile?.id ?? profile.id;
  let name = profile.profile?.name ?? profile.name;
  let factionId = profile.faction?.id ?? profile.faction_id ?? null;
  let factionName = profile.faction?.name ?? null;

  if (!factionId || !name || !userId) {
    try {
      const faction = await tornGet(tornKey, 'user/faction');
      const f = faction.faction || faction;
      factionId = factionId || f?.id || f?.faction_id || null;
      factionName = factionName || f?.name || null;
    } catch {
      /* ignore */
    }
  }

  if (!userId || !name) throw new Error('Could not resolve Torn user');
  return {
    userId: Number(userId),
    name: String(name),
    factionId: factionId ? Number(factionId) : null,
    factionName: factionName ? String(factionName) : null,
  };
}

async function assertLicensed(env, user) {
  const allowed = await getAllowedFactionIds(env);
  if (!allowed.length) {
    throw new Error('No factions are licensed yet. Ask the owner to configure /admin.');
  }
  if (!user.factionId) {
    throw new Error('You must be in a faction to use The 7th Terminal');
  }
  if (!allowed.includes(user.factionId)) {
    throw new Error(`Faction ${user.factionId} is not licensed for The 7th Terminal`);
  }
}

async function handleLicense(request, env) {
  const body = await safeJson(request);
  const tornKey = String(body.tornKey || '').trim();
  if (!tornKey) throw new Error('tornKey is required');

  const user = await resolveTornUser(tornKey);
  try {
    await assertLicensed(env, user);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  return {
    ok: true,
    userId: user.userId,
    name: user.name,
    factionId: user.factionId,
    factionName: user.factionName,
    expiresIn: LICENSE_TTL_SECONDS,
  };
}

async function handleAuth(request, env) {
  const body = await safeJson(request);
  const tornKey = String(body.tornKey || '').trim();
  if (!tornKey) throw new Error('tornKey is required');

  const user = await resolveTornUser(tornKey);
  await assertLicensed(env, user);

  const ttl = Number(env.SESSION_TTL_SECONDS || 86400);
  const token = await signSession(
    {
      userId: user.userId,
      name: user.name,
      factionId: user.factionId,
      factionName: user.factionName,
      exp: Math.floor(Date.now() / 1000) + ttl,
    },
    secret(env)
  );

  return {
    token,
    userId: user.userId,
    name: user.name,
    factionId: user.factionId,
    factionName: user.factionName,
    expiresIn: ttl,
  };
}

async function handleAdminLogin(request, env) {
  const body = await safeJson(request);
  const tornKey = String(body.tornKey || '').trim();
  if (!tornKey) throw new Error('tornKey is required');

  const owners = ownerIds(env);
  if (!owners.length) {
    throw new Error('OWNER_TORN_IDS is not configured on the Worker');
  }

  const user = await resolveTornUser(tornKey);
  if (!owners.includes(user.userId)) {
    throw new Error('Not an admin');
  }

  const token = await signSession(
    {
      role: 'admin',
      userId: user.userId,
      name: user.name,
      exp: Math.floor(Date.now() / 1000) + ADMIN_TTL_SECONDS,
    },
    secret(env)
  );

  return {
    token,
    userId: user.userId,
    name: user.name,
    expiresIn: ADMIN_TTL_SECONDS,
    allowedFactionIds: await getAllowedFactionIds(env),
  };
}

async function requireAdminSession(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return { error: 'Missing Authorization', status: 401 };
  try {
    const payload = await verifySession(token, secret(env));
    if (!payload || payload.role !== 'admin' || payload.exp < Math.floor(Date.now() / 1000)) {
      return { error: 'Admin session expired', status: 401 };
    }
    const owners = ownerIds(env);
    if (!owners.includes(Number(payload.userId))) {
      return { error: 'Not an admin', status: 403 };
    }
    return payload;
  } catch {
    return { error: 'Invalid admin session', status: 401 };
  }
}

async function requireSession(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return { error: 'Missing Authorization', status: 401 };
  try {
    const payload = await verifySession(token, secret(env));
    if (!payload || payload.role === 'admin' || payload.exp < Math.floor(Date.now() / 1000)) {
      return { error: 'Session expired', status: 401 };
    }
    return payload;
  } catch {
    return { error: 'Invalid session', status: 401 };
  }
}

async function tornGet(key, path) {
  const clean = String(path).replace(/^\//, '');
  const joiner = clean.includes('?') ? '&' : '?';
  const url = `${TORN_API}/${clean}${joiner}comment=${COMMENT}&key=${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  return res.json();
}

async function getStocksCatalog(env, tornKey) {
  const ttl = Number(env.STOCK_CACHE_TTL_SECONDS || 600) * 1000;
  const cached = await env.WARPANEL.get(STOCK_CACHE_KEY);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed.at && Date.now() - parsed.at < ttl && Array.isArray(parsed.stocks)) {
        return { stocks: parsed.stocks, cached: true, at: parsed.at };
      }
    } catch {
      /* rebuild */
    }
  }

  const data = await tornGet(tornKey, 'torn/stocks');
  if (data.error) throw new Error(data.error.error || 'Failed to load stocks');

  const raw = data.stocks;
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === 'object') list = Object.values(raw);

  const itemIds = new Set();
  for (const s of list) {
    const bid = s.benefit?.item_id ?? s.benefit?.itemId;
    if (bid) itemIds.add(Number(bid));
  }

  const itemMv = {};
  if (itemIds.size) {
    try {
      const itemsData = await tornGet(tornKey, 'torn/items');
      const items = itemsData.items || itemsData;
      const entries =
        items && typeof items === 'object'
          ? Array.isArray(items)
            ? items
            : Object.entries(items).map(([id, v]) => ({ id: Number(id), ...v }))
          : [];
      for (const it of entries) {
        const id = Number(it.id ?? it.item_id);
        if (itemIds.has(id)) {
          itemMv[id] = Number(it.market_value ?? it.marketValue ?? 0) || 0;
        }
      }
    } catch {
      /* hints only */
    }
  }

  const stocks = list.map((s) => enrichStock(s, itemMv));
  const payload = { at: Date.now(), stocks };
  await env.WARPANEL.put(STOCK_CACHE_KEY, JSON.stringify(payload));
  return { stocks, cached: false, at: payload.at };
}

function enrichStock(s, itemMv) {
  const acronym = String(s.acronym || s.stock_id || '').toUpperCase();
  const benefit = s.benefit || {};
  const type = String(benefit.type || (benefit.requirement ? 'active' : 'passive')).toLowerCase();
  const requirement = Number(benefit.requirement || 0);
  const frequency = Number(benefit.frequency || 0);
  const itemId = benefit.item_id ?? benefit.itemId ?? null;
  const description = benefit.description || '';
  const price = Number(s.current_price ?? s.price ?? 0);

  let benefitValue = 0;
  let valueSource = 'none';
  const fallback = ACTIVE_BENEFIT_FALLBACK[acronym];

  if (type === 'active') {
    const cashMatch = description.match(/\$[\d,]+/);
    if (cashMatch) {
      benefitValue = Number(cashMatch[0].replace(/[$,]/g, ''));
      valueSource = 'description-cash';
    } else if (itemId && itemMv[Number(itemId)]) {
      benefitValue = itemMv[Number(itemId)];
      valueSource = 'item-mv';
    } else if (fallback?.kind === 'cash') {
      benefitValue = fallback.value;
      valueSource = 'fallback-cash';
    } else if (fallback?.kind === 'points') {
      benefitValue = fallback.value * POINTS_MV;
      valueSource = 'points-proxy';
    } else if (fallback?.kind === 'energy') {
      benefitValue = fallback.value * ENERGY_MV;
      valueSource = 'energy-proxy';
    } else if (fallback?.kind === 'nerve') {
      benefitValue = fallback.value * NERVE_MV;
      valueSource = 'nerve-proxy';
    } else if (fallback?.kind === 'happy') {
      benefitValue = fallback.value * HAPPY_MV;
      valueSource = 'happy-proxy';
    } else if (fallback?.kind === 'item' || fallback?.kind === 'property') {
      benefitValue = LABEL_MV_HINTS[fallback.label] || 0;
      valueSource = 'label-hint';
    } else if (description) {
      // try item label hint from description
      for (const [label, mv] of Object.entries(LABEL_MV_HINTS)) {
        if (description.toLowerCase().includes(label.toLowerCase().slice(0, 12))) {
          benefitValue = mv;
          valueSource = 'label-hint';
          break;
        }
      }
    }
  }

  const blockCost = requirement > 0 && price > 0 ? requirement * price : 0;
  const annualPayout =
    type === 'active' && frequency > 0 ? (benefitValue * 365) / frequency : 0;
  const monthlyPayout =
    type === 'active' && frequency > 0 ? (benefitValue * 30) / frequency : 0;
  const annualRoi = blockCost > 0 ? annualPayout / blockCost : 0;

  return {
    stockId: Number(s.stock_id ?? s.id),
    name: s.name || acronym,
    acronym,
    price,
    investors: s.investors ?? null,
    totalShares: s.total_shares ?? null,
    benefit: {
      type: type === 'active' ? 'active' : 'passive',
      description,
      frequency,
      requirement,
      itemId: itemId != null ? Number(itemId) : null,
      benefitValue,
      valueSource,
      maxIncrements: fallback?.maxIncrements ?? null,
    },
    blockCost,
    annualPayout,
    monthlyPayout,
    annualRoi,
  };
}

async function signSession(payload, secretKey) {
  const body = bytesToB64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmac(secretKey, body);
  return `${body}.${sig}`;
}

async function verifySession(token, secretKey) {
  const [body, sig] = token.split('.');
  if (!body || !sig) throw new Error('bad token');
  const expected = await hmac(secretKey, body);
  if (sig !== expected) throw new Error('bad sig');
  const text = new TextDecoder().decode(b64UrlToBytes(body));
  return JSON.parse(text);
}

async function hmac(secretKey, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secretKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return bytesToB64Url(new Uint8Array(mac));
}

function bytesToB64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64UrlToBytes(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function adminPage(cors) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>The 7th Terminal — License Admin</title>
  <style>
    :root { color-scheme: dark; }
    body { font-family: "IBM Plex Mono", ui-monospace, monospace; background: #0c0e10; color: #c8d0d8; margin: 0; padding: 28px; }
    h1 { font-family: "Bebas Neue", Impact, sans-serif; letter-spacing: 0.06em; font-size: 28px; margin: 0 0 6px; color: #e8b84a; }
    p, label { font-size: 13px; color: #8a96a3; }
    .card { max-width: 520px; background: #12161a; border: 1px solid #2a323c; padding: 18px; }
    input { width: 100%; box-sizing: border-box; background: #0c0e10; color: #e8eaed; border: 1px solid #3a4254;
      padding: 8px 10px; margin: 6px 0 12px; font-family: inherit; }
    button { background: #e8b84a; color: #12161a; border: 0; padding: 8px 12px; cursor: pointer; font-weight: 700; font-family: inherit; }
    button.secondary { background: #2a3140; color: #c8d0d8; }
    button.danger { background: #8b2e2e; color: #fff; }
    .row { display: flex; gap: 8px; align-items: center; }
    .row input { margin: 0; flex: 1; }
    ul { list-style: none; padding: 0; margin: 0 0 12px; }
    li { display: flex; justify-content: space-between; align-items: center; gap: 8px;
      padding: 8px 10px; border: 1px solid #2a323c; margin-bottom: 6px; }
    .ok { color: #6dcea4; } .err { color: #f07178; }
    .hidden { display: none; }
    code { color: #e8b84a; }
  </style>
</head>
<body>
  <div class="card">
    <h1>THE 7TH TERMINAL</h1>
    <p>License admin — faction allowlist</p>
    <div id="login">
      <label>Your Torn API key (owner only)</label>
      <input id="tornKey" type="password" autocomplete="off" placeholder="Torn API key" />
      <button type="button" id="loginBtn">Log in</button>
      <p id="loginMsg" class="err"></p>
    </div>
    <div id="panel" class="hidden">
      <p id="who" class="ok"></p>
      <label>Add faction ID</label>
      <div class="row">
        <input id="factionId" type="number" min="1" step="1" placeholder="e.g. 12345" />
        <button type="button" class="secondary" id="addBtn">Add</button>
      </div>
      <ul id="list"></ul>
      <div class="row">
        <button type="button" id="saveBtn">Save allowlist</button>
        <button type="button" class="secondary" id="logoutBtn">Log out</button>
      </div>
      <p id="saveMsg"></p>
    </div>
  </div>
  <script>
    const loginEl = document.getElementById('login');
    const panelEl = document.getElementById('panel');
    const listEl = document.getElementById('list');
    const loginMsg = document.getElementById('loginMsg');
    const saveMsg = document.getElementById('saveMsg');
    const who = document.getElementById('who');
    let token = sessionStorage.getItem('t7t_admin_token') || '';
    let ids = [];

    function renderList() {
      listEl.innerHTML = '';
      if (!ids.length) {
        listEl.innerHTML = '<li><span>No factions licensed (everyone denied)</span></li>';
        return;
      }
      ids.forEach((id) => {
        const li = document.createElement('li');
        li.innerHTML = '<span>Faction <code>' + id + '</code></span>';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'danger';
        btn.textContent = 'Remove';
        btn.onclick = () => {
          ids = ids.filter((x) => x !== id);
          renderList();
        };
        li.appendChild(btn);
        listEl.appendChild(li);
      });
    }

    async function api(method, path, body) {
      const res = await fetch(path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) throw new Error(data.error || ('HTTP ' + res.status));
      return data;
    }

    async function showPanel(name) {
      loginEl.classList.add('hidden');
      panelEl.classList.remove('hidden');
      who.textContent = 'Logged in as ' + name;
      const cfg = await api('GET', '/admin/config');
      ids = Array.isArray(cfg.allowedFactionIds) ? cfg.allowedFactionIds.slice() : [];
      renderList();
    }

    document.getElementById('loginBtn').onclick = async () => {
      loginMsg.textContent = '';
      try {
        const key = document.getElementById('tornKey').value.trim();
        const data = await api('POST', '/admin/login', { tornKey: key });
        token = data.token;
        sessionStorage.setItem('t7t_admin_token', token);
        ids = Array.isArray(data.allowedFactionIds) ? data.allowedFactionIds.slice() : [];
        await showPanel(data.name || ('#' + data.userId));
        renderList();
      } catch (e) {
        loginMsg.textContent = e.message;
      }
    };

    document.getElementById('addBtn').onclick = () => {
      const n = Number(document.getElementById('factionId').value);
      if (!Number.isFinite(n) || n <= 0) return;
      const id = Math.floor(n);
      if (!ids.includes(id)) ids.push(id);
      ids.sort((a, b) => a - b);
      document.getElementById('factionId').value = '';
      renderList();
    };

    document.getElementById('saveBtn').onclick = async () => {
      saveMsg.textContent = '';
      saveMsg.className = '';
      try {
        const data = await api('PUT', '/admin/config', { allowedFactionIds: ids });
        ids = data.allowedFactionIds || [];
        renderList();
        saveMsg.className = 'ok';
        saveMsg.textContent = 'Saved ' + ids.length + ' faction(s).';
      } catch (e) {
        saveMsg.className = 'err';
        saveMsg.textContent = e.message;
      }
    };

    document.getElementById('logoutBtn').onclick = () => {
      token = '';
      sessionStorage.removeItem('t7t_admin_token');
      panelEl.classList.add('hidden');
      loginEl.classList.remove('hidden');
    };

    if (token) {
      showPanel('admin').catch(() => {
        token = '';
        sessionStorage.removeItem('t7t_admin_token');
      });
    }
  </script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...cors,
    },
  });
}
