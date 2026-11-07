export type Member = {
  id: number
  name: string
  level: number
  status: { state?: string; until?: number; description?: string; details?: string }
  last_action: { status?: string; timestamp?: number } | null
  revive_setting: string
  is_revivable: boolean
}

export type WarInfo = {
  warId: number | string | null
  enemyId: number
  enemyName: string
  enemyScore?: number
  myScore?: number
  target?: number
  start?: number
}

export type Dib = {
  targetId: number
  claimerId: number
  claimerName: string
  claimedAt: number
  note?: string | null
}

export type Assist = {
  attackerId: number
  attackerName: string
  targetId: number
  targetName?: string | null
  createdAt: number
}

export type Retal = {
  attackerId: number
  attackerName: string
  ended: number
  result: string
}

export type FfEntry = { ff: number; at: number; result?: string; name?: string }

const RETAL_WINDOW_SEC = 5 * 60

export function memberBucket(m: Member, nowSec: number): 'okay' | 'hosp' | 'jail' | 'travel' {
  const state = String(m.status?.state || 'Okay')
  const until = Number(m.status?.until || 0)
  if (state === 'Hospital' && until > nowSec) return 'hosp'
  if (state === 'Jail' && until > nowSec) return 'jail'
  if (state === 'Traveling' || state === 'Abroad') return 'travel'
  return 'okay'
}

export function statusLight(m: Member): 'online' | 'away' | 'offline' {
  const s = String(m.last_action?.status || '').toLowerCase()
  if (s === 'online') return 'online'
  if (s === 'idle') return 'away'
  return 'offline'
}

export function revLabel(m: Member): string {
  const r = String(m.revive_setting || '').toLowerCase()
  if (r.includes('everyone') || r === 'everyone') return 'Rev-On'
  if (r.includes('friends') || r.includes('faction')) return 'Rev-On'
  if (r.includes('no one') || r.includes('nobody') || r === 'off') return 'Rev-Off'
  return ''
}

export function normalizeMembers(raw: unknown): Member[] {
  let list: Record<string, unknown>[] = []
  if (Array.isArray(raw)) list = raw
  else if (raw && typeof raw === 'object') {
    list = Object.entries(raw as Record<string, unknown>).map(([id, m]) => ({
      ...(m as object),
      id: (m as { id?: number }).id ?? Number(id),
    }))
  }
  return list.map((m) => ({
    id: Number(m.id ?? m.user_id),
    name: String(m.name || 'Unknown'),
    level: Number(m.level || 0),
    status: (m.status as Member['status']) || { state: 'Okay', until: 0 },
    last_action: (m.last_action as Member['last_action']) || null,
    revive_setting: String(m.revive_setting || m.reviveSetting || 'Unknown'),
    is_revivable: Boolean(m.is_revivable),
  }))
}

export function parseWar(
  warsPayload: { wars?: { ranked?: unknown } },
  myFactionId: number | null
): WarInfo | null {
  const ranked = warsPayload.wars?.ranked
  const war = Array.isArray(ranked) ? ranked[0] : ranked
  if (!war || typeof war !== 'object') return null
  const w = war as Record<string, unknown>
  const factionsRaw = w.factions
  const factions = Array.isArray(factionsRaw)
    ? factionsRaw
    : Object.values((factionsRaw as object) || {})
  const enemy = factions.find(
    (f) => Number((f as { id?: number; faction_id?: number }).id ?? (f as { faction_id?: number }).faction_id) !== myFactionId
  ) as { id?: number; faction_id?: number; name?: string; score?: number } | undefined
  const mine = factions.find(
    (f) => Number((f as { id?: number; faction_id?: number }).id ?? (f as { faction_id?: number }).faction_id) === myFactionId
  ) as { score?: number } | undefined
  if (!enemy) return null
  const enemyId = Number(enemy.id ?? enemy.faction_id)
  return {
    warId: (w.war_id as number) ?? (w.id as number) ?? null,
    enemyId,
    enemyName: String(enemy.name || 'Enemy'),
    enemyScore: enemy.score,
    myScore: mine?.score,
    target: w.target as number | undefined,
    start: w.start as number | undefined,
  }
}

function normalizeAttacks(payload: { attacks?: unknown }): Record<string, unknown>[] {
  const raw = payload.attacks ?? payload
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object') {
    return Object.entries(raw as Record<string, unknown>).map(([code, a]) => ({
      code,
      ...(a as object),
    }))
  }
  return []
}

function normalizeEnded(raw: unknown): number {
  let ended = Number(raw || 0)
  if (!Number.isFinite(ended) || ended <= 0) return 0
  if (ended > 1e12) ended = Math.floor(ended / 1000)
  return ended
}

export function attackPlayers(a: Record<string, unknown>) {
  const attacker = a.attacker as Record<string, unknown> | undefined
  const defender = a.defender as Record<string, unknown> | undefined
  const mods = a.modifiers as Record<string, unknown> | undefined
  return {
    attackerId: Number(attacker?.id ?? a.attacker_id ?? 0) || null,
    attackerName: String(attacker?.name ?? a.attacker_name ?? 'Unknown'),
    defenderId: Number(defender?.id ?? a.defender_id ?? 0) || null,
    defenderName: String(defender?.name ?? a.defender_name ?? 'Unknown'),
    attackerFaction: Number(
      (attacker?.faction as { id?: number })?.id ?? a.attacker_faction ?? 0
    ) || null,
    defenderFaction: Number(
      (defender?.faction as { id?: number })?.id ?? a.defender_faction ?? 0
    ) || null,
    ff: Number(mods?.fair_fight ?? mods?.fairFight ?? a.fair_fight ?? NaN),
    ended: normalizeEnded(a.ended ?? a.timestamp_ended ?? a.timestamp ?? a.started),
    result: String(a.result || ''),
  }
}

export function buildRetals(
  candidates: ReturnType<typeof attackPlayers>[],
  opts: {
    myId: number
    myFactionId: number | null
    enemyId: number | null
    enemyMemberIds: Set<number>
    nowSec: number
  }
): Retal[] {
  const list = candidates.filter((a) => {
    if (!a.attackerId || !a.ended) return false
    if (a.ended < opts.nowSec - RETAL_WINDOW_SEC) return false
    if (a.attackerId === opts.myId) return false
    const onMe = a.defenderId === opts.myId
    const onUs =
      onMe ||
      (opts.myFactionId != null && a.defenderFaction === opts.myFactionId)
    if (!onUs) return false
    if (onMe) return true
    if (!opts.enemyId) return false
    if (a.attackerFaction === opts.enemyId) return true
    return opts.enemyMemberIds.has(a.attackerId)
  })
  const byAttacker = new Map<number, (typeof list)[0]>()
  for (const a of list) {
    const prev = byAttacker.get(a.attackerId!)
    if (!prev || a.ended > prev.ended) byAttacker.set(a.attackerId!, a)
  }
  return [...byAttacker.values()]
    .sort((a, b) => b.ended - a.ended)
    .slice(0, 15)
    .map((a) => ({
      attackerId: a.attackerId!,
      attackerName: a.attackerName,
      ended: a.ended,
      result: a.result,
    }))
}

export function parseAttacksPayload(payload: { attacks?: unknown }) {
  return normalizeAttacks(payload).map(attackPlayers)
}

export function sortMembers(
  members: Member[],
  sort: string,
  nowSec: number,
  ff: Record<string, FfEntry>
): Member[] {
  const copy = [...members]
  copy.sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name)
    if (sort === 'level') return b.level - a.level
    if (sort === 'ff') {
      const fa = ff[String(a.id)]?.ff ?? 0
      const fb = ff[String(b.id)]?.ff ?? 0
      return fb - fa
    }
    // hosp: soonest out first; okay last
    const ua = Number(a.status?.until || 0)
    const ub = Number(b.status?.until || 0)
    const aHosp = memberBucket(a, nowSec) === 'hosp'
    const bHosp = memberBucket(b, nowSec) === 'hosp'
    if (aHosp && bHosp) return ua - ub
    if (aHosp) return -1
    if (bHosp) return 1
    const aJail = memberBucket(a, nowSec) === 'jail'
    const bJail = memberBucket(b, nowSec) === 'jail'
    if (aJail && bJail) return ua - ub
    if (aJail) return -1
    if (bJail) return 1
    return a.name.localeCompare(b.name)
  })
  return copy
}
