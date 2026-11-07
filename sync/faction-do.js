/**
 * Per-faction Durable Object for serialized dibs/assists under war load.
 */

const ASSIST_TTL_MS = 5 * 60 * 1000;

export class FactionRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const session = JSON.parse(request.headers.get('X-Session') || '{}');

    try {
      if (request.method === 'GET' && path === '/state') {
        return json(await this.getState());
      }

      const dibsMatch = path.match(/^\/dibs\/(\d+)$/);
      if (dibsMatch) {
        const targetId = dibsMatch[1];
        if (request.method === 'PUT') {
          return json(await this.putDib(session, targetId, await safeJson(request)));
        }
        if (request.method === 'DELETE') {
          return json(await this.deleteDib(session, targetId));
        }
      }

      if (request.method === 'PUT' && path === '/assists') {
        return json(await this.putAssist(session, await safeJson(request)));
      }

      const assistMatch = path.match(/^\/assists\/(\d+)$/);
      if (assistMatch && request.method === 'DELETE') {
        return json(await this.deleteAssist(session, assistMatch[1]));
      }

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: err.message || 'Server error' }, 500);
    }
  }

  async read() {
    const data = (await this.state.storage.get('state')) || { dibs: {}, assists: {} };
    return {
      dibs: data.dibs || {},
      assists: pruneAssists(data.assists || {}),
    };
  }

  async write(data) {
    const next = {
      dibs: data.dibs || {},
      assists: pruneAssists(data.assists || {}),
      updatedAt: Date.now(),
    };
    await this.state.storage.put('state', next);
    return next;
  }

  async getState() {
    return this.read();
  }

  async putDib(session, targetId, body) {
    const data = await this.read();
    const existing = data.dibs[targetId];
    const force = Boolean(body && body.force);

    if (existing && existing.claimerId !== session.userId && !force) {
      return {
        ok: false,
        conflict: true,
        dibs: data.dibs,
        assists: data.assists,
        existing,
      };
    }

    data.dibs[targetId] = {
      targetId: Number(targetId),
      claimerId: session.userId,
      claimerName: session.name,
      claimedAt: Date.now(),
      note: body && body.note ? String(body.note).slice(0, 80) : null,
    };
    const saved = await this.write(data);
    return { ok: true, dibs: saved.dibs, assists: saved.assists };
  }

  async deleteDib(session, targetId) {
    const data = await this.read();
    const existing = data.dibs[targetId];
    if (existing && existing.claimerId !== session.userId) {
      return {
        ok: false,
        conflict: true,
        dibs: data.dibs,
        assists: data.assists,
        existing,
      };
    }
    delete data.dibs[targetId];
    const saved = await this.write(data);
    return { ok: true, dibs: saved.dibs, assists: saved.assists };
  }

  async putAssist(session, body) {
    const targetId = Number(body.targetId);
    if (!targetId) throw new Error('targetId is required');
    const data = await this.read();
    data.assists[String(session.userId)] = {
      attackerId: session.userId,
      attackerName: session.name,
      targetId,
      targetName: body.targetName ? String(body.targetName) : null,
      createdAt: Date.now(),
    };
    const saved = await this.write(data);
    return { ok: true, dibs: saved.dibs, assists: saved.assists };
  }

  async deleteAssist(session, attackerId) {
    if (Number(attackerId) !== session.userId) {
      return { ok: false, error: 'Can only clear your own assist' };
    }
    const data = await this.read();
    delete data.assists[String(attackerId)];
    const saved = await this.write(data);
    return { ok: true, dibs: saved.dibs, assists: saved.assists };
  }
}

function pruneAssists(assists) {
  const now = Date.now();
  const out = {};
  for (const [id, a] of Object.entries(assists)) {
    if (a && now - (a.createdAt || 0) < ASSIST_TTL_MS) out[id] = a;
  }
  return out;
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
