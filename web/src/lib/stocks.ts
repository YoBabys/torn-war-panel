export type CatalogStock = {
  stockId: number
  name: string
  acronym: string
  price: number
  benefit: {
    type: 'active' | 'passive'
    description: string
    frequency: number
    requirement: number
    itemId: number | null
    benefitValue: number
    valueSource: string
    maxIncrements: number | null
  }
  blockCost: number
  annualPayout: number
  monthlyPayout: number
  annualRoi: number
}

export type Holding = {
  stockId: number
  totalShares: number
  increment: number
  progress: number
  ready: boolean
}

export type BlockOpportunity = {
  stock: CatalogStock
  nextIncrement: number
  nextBlockShares: number
  sharesOwned: number
  sharesNeeded: number
  costToComplete: number
  monthlyPayout: number
  annualRoi: number
  affordable: boolean
}

export type DeployStep = {
  acronym: string
  name: string
  shares: number
  cost: number
  monthlyGain: number
  annualRoi: number
}

export type ReallocMove = {
  sellAcronym: string
  sellShares: number
  sellProceeds: number
  buyAcronym: string
  buyShares: number
  buyCost: number
  monthlyDelta: number
  note: string
}

export function parseHoldings(payload: { stocks?: unknown }): Holding[] {
  const raw = payload.stocks
  let list: Record<string, unknown>[] = []
  if (Array.isArray(raw)) list = raw
  else if (raw && typeof raw === 'object') {
    list = Object.entries(raw as Record<string, unknown>).map(([id, s]) => ({
      ...(s as object),
      stock_id: (s as { stock_id?: number }).stock_id ?? Number(id),
    }))
  }

  return list.map((s) => {
    const dividend = (s.dividend || s.benefit) as Record<string, unknown> | undefined
    return {
      stockId: Number(s.stock_id ?? s.id),
      totalShares: Number(s.total_shares ?? s.shares ?? 0),
      increment: Number(dividend?.increment ?? 0),
      progress: Number(dividend?.progress ?? 0),
      ready: Boolean(Number(dividend?.ready ?? 0)),
    }
  })
}

/** Shares required for the Nth active increment (1-based); each block doubles. */
export function sharesForIncrement(baseRequirement: number, incrementIndex: number): number {
  if (incrementIndex < 1) return 0
  return baseRequirement * 2 ** (incrementIndex - 1)
}

/** Total shares needed to own `increments` full blocks. */
export function totalSharesForIncrements(baseRequirement: number, increments: number): number {
  let total = 0
  for (let i = 1; i <= increments; i++) total += sharesForIncrement(baseRequirement, i)
  return total
}

export function inferIncrements(shares: number, baseRequirement: number): number {
  if (baseRequirement <= 0 || shares <= 0) return 0
  let owned = 0
  let inc = 0
  while (true) {
    const next = sharesForIncrement(baseRequirement, inc + 1)
    if (owned + next > shares) break
    owned += next
    inc += 1
    if (inc > 40) break
  }
  return inc
}

export function nextBlockOpportunity(
  stock: CatalogStock,
  holding: Holding | undefined
): BlockOpportunity | null {
  if (stock.benefit.type !== 'active' || stock.benefit.requirement <= 0) return null
  const base = stock.benefit.requirement
  const sharesOwned = holding?.totalShares ?? 0
  let increments =
    holding?.increment && holding.increment > 0
      ? holding.increment
      : inferIncrements(sharesOwned, base)

  if (stock.benefit.maxIncrements != null && increments >= stock.benefit.maxIncrements) {
    return null
  }

  const nextIncrement = increments + 1
  const nextBlockShares = sharesForIncrement(base, nextIncrement)
  const sharesForCurrentBlocks = totalSharesForIncrements(base, increments)
  const progressInBlock = Math.max(0, sharesOwned - sharesForCurrentBlocks)
  const sharesNeeded = Math.max(0, nextBlockShares - progressInBlock)
  const costToComplete = sharesNeeded * stock.price
  const monthlyPayout = stock.monthlyPayout
  const annualRoi =
    nextBlockShares * stock.price > 0
      ? stock.annualPayout / (nextBlockShares * stock.price)
      : 0

  return {
    stock,
    nextIncrement,
    nextBlockShares,
    sharesOwned,
    sharesNeeded,
    costToComplete,
    monthlyPayout,
    annualRoi,
    affordable: false,
  }
}

export function rankOpportunities(
  catalog: CatalogStock[],
  holdings: Holding[],
  liquid: number
): BlockOpportunity[] {
  const byId = new Map(holdings.map((h) => [h.stockId, h]))
  const ops: BlockOpportunity[] = []
  for (const stock of catalog) {
    const op = nextBlockOpportunity(stock, byId.get(stock.stockId))
    if (!op) continue
    op.affordable = op.costToComplete > 0 && op.costToComplete <= liquid
    ops.push(op)
  }
  ops.sort((a, b) => b.annualRoi - a.annualRoi)
  return ops
}

export function deployCashPlan(
  catalog: CatalogStock[],
  holdings: Holding[],
  liquid: number
): { steps: DeployStep[]; leftover: number; monthlyGain: number } {
  let cash = liquid
  const held = new Map(holdings.map((h) => [h.stockId, { ...h }]))
  const steps: DeployStep[] = []
  let monthlyGain = 0
  const MAX_STEPS = 12

  for (let i = 0; i < MAX_STEPS; i++) {
    const ops = rankOpportunities(
      catalog,
      [...held.values()],
      cash
    ).filter((o) => o.costToComplete > 0 && o.costToComplete <= cash)
    const best = ops[0]
    if (!best) break

    cash -= best.costToComplete
    monthlyGain += best.monthlyPayout
    steps.push({
      acronym: best.stock.acronym,
      name: best.stock.name,
      shares: best.sharesNeeded,
      cost: best.costToComplete,
      monthlyGain: best.monthlyPayout,
      annualRoi: best.annualRoi,
    })

    const prev = held.get(best.stock.stockId) || {
      stockId: best.stock.stockId,
      totalShares: best.sharesOwned,
      increment: best.nextIncrement - 1,
      progress: 0,
      ready: false,
    }
    held.set(best.stock.stockId, {
      ...prev,
      totalShares: prev.totalShares + best.sharesNeeded,
      increment: best.nextIncrement,
    })
  }

  return { steps, leftover: cash, monthlyGain }
}

function positionMonthly(
  stock: CatalogStock,
  holding: Holding
): { increments: number; monthly: number; capital: number } {
  const base = stock.benefit.requirement
  const increments =
    holding.increment > 0 ? holding.increment : inferIncrements(holding.totalShares, base)
  const monthly = increments * stock.monthlyPayout
  const capital = holding.totalShares * stock.price
  return { increments, monthly, capital }
}

/**
 * Suggest selling lowest-ROI active capital to fund higher-ROI next blocks.
 */
export function reallocationPlan(
  catalog: CatalogStock[],
  holdings: Holding[],
  liquid: number,
  opts: { sellPassives?: boolean } = {}
): {
  currentMonthly: number
  optimizedMonthly: number
  deltaMonthly: number
  moves: ReallocMove[]
} {
  const byId = new Map(catalog.map((s) => [s.stockId, s]))
  let currentMonthly = 0
  const activePositions: {
    stock: CatalogStock
    holding: Holding
    increments: number
    monthly: number
    capital: number
    roiPerDollar: number
  }[] = []

  for (const h of holdings) {
    const stock = byId.get(h.stockId)
    if (!stock || h.totalShares <= 0) continue
    if (stock.benefit.type === 'passive' && !opts.sellPassives) continue
    if (stock.benefit.type === 'passive') {
      activePositions.push({
        stock,
        holding: h,
        increments: 0,
        monthly: 0,
        capital: h.totalShares * stock.price,
        roiPerDollar: 0,
      })
      continue
    }
    const pos = positionMonthly(stock, h)
    currentMonthly += pos.monthly
    const roiPerDollar = pos.capital > 0 ? pos.monthly / pos.capital : 0
    activePositions.push({ ...pos, stock, holding: h, roiPerDollar })
  }

  // Simulate: pool = liquid + sellable capital from lowest ROI increments
  let pool = liquid
  const simHeld = new Map(holdings.map((h) => [h.stockId, { ...h }]))
  const moves: ReallocMove[] = []

  // Rank sell candidates: peel last increment of lowest ROI actives
  const sellCandidates = activePositions
    .filter((p) => p.stock.benefit.type === 'active' && p.increments >= 1)
    .sort((a, b) => a.roiPerDollar - b.roiPerDollar)

  for (const pos of sellCandidates) {
    const ops = rankOpportunities(catalog, [...simHeld.values()], pool + pos.capital)
    const best = ops[0]
    if (!best) break
    const lastIncShares = sharesForIncrement(pos.stock.benefit.requirement, pos.increments)
    const proceeds = lastIncShares * pos.stock.price
    const lostMonthly = pos.stock.monthlyPayout
    if (best.annualRoi <= pos.stock.annualRoi * 1.05) continue // not worth churn
    if (best.monthlyPayout <= lostMonthly) continue

    const h = simHeld.get(pos.stock.stockId)!
    h.totalShares = Math.max(0, h.totalShares - lastIncShares)
    h.increment = Math.max(0, (h.increment || pos.increments) - 1)
    pool += proceeds

    if (best.costToComplete <= pool) {
      pool -= best.costToComplete
      const buyH = simHeld.get(best.stock.stockId) || {
        stockId: best.stock.stockId,
        totalShares: best.sharesOwned,
        increment: best.nextIncrement - 1,
        progress: 0,
        ready: false,
      }
      buyH.totalShares += best.sharesNeeded
      buyH.increment = best.nextIncrement
      simHeld.set(best.stock.stockId, buyH)

      const monthlyDelta = best.monthlyPayout - lostMonthly
      moves.push({
        sellAcronym: pos.stock.acronym,
        sellShares: lastIncShares,
        sellProceeds: proceeds,
        buyAcronym: best.stock.acronym,
        buyShares: best.sharesNeeded,
        buyCost: best.costToComplete,
        monthlyDelta,
        note: `Sell ${pos.stock.acronym} block → buy ${best.stock.acronym} block`,
      })
      if (moves.length >= 6) break
    } else {
      // revert sell if we can't buy
      h.totalShares += lastIncShares
      h.increment += 1
      pool -= proceeds
    }
  }

  // Also suggest deploying leftover pool into best blocks
  const deploy = deployCashPlan(catalog, [...simHeld.values()], pool)
  for (const step of deploy.steps) {
    moves.push({
      sellAcronym: '—',
      sellShares: 0,
      sellProceeds: 0,
      buyAcronym: step.acronym,
      buyShares: step.shares,
      buyCost: step.cost,
      monthlyDelta: step.monthlyGain,
      note: `Deploy cash into ${step.acronym}`,
    })
  }

  let optimizedMonthly = 0
  for (const h of simHeld.values()) {
    const stock = byId.get(h.stockId)
    if (!stock || stock.benefit.type !== 'active') continue
    optimizedMonthly += positionMonthly(stock, h).monthly
  }

  // Prefer deploy-only delta if no sells
  if (!moves.some((m) => m.sellShares > 0)) {
    optimizedMonthly = currentMonthly + deploy.monthlyGain
  }

  return {
    currentMonthly,
    optimizedMonthly,
    deltaMonthly: optimizedMonthly - currentMonthly,
    moves: moves.slice(0, 8),
  }
}

export function portfolioSummary(
  catalog: CatalogStock[],
  holdings: Holding[]
): {
  activeCapital: number
  passiveCapital: number
  monthlyIncome: number
  positions: { stock: CatalogStock; holding: Holding; monthly: number; capital: number }[]
} {
  const byId = new Map(catalog.map((s) => [s.stockId, s]))
  let activeCapital = 0
  let passiveCapital = 0
  let monthlyIncome = 0
  const positions: {
    stock: CatalogStock
    holding: Holding
    monthly: number
    capital: number
  }[] = []

  for (const h of holdings) {
    const stock = byId.get(h.stockId)
    if (!stock || h.totalShares <= 0) continue
    const capital = h.totalShares * stock.price
    if (stock.benefit.type === 'active') {
      const { monthly } = positionMonthly(stock, h)
      monthlyIncome += monthly
      activeCapital += capital
      positions.push({ stock, holding: h, monthly, capital })
    } else {
      passiveCapital += capital
      positions.push({ stock, holding: h, monthly: 0, capital })
    }
  }

  return { activeCapital, passiveCapital, monthlyIncome, positions }
}
