# The 7th Terminal

Faction web app for Torn City (~100 members):

- **War** — chain timer, enemy roster, FF/retals, shared **dibs** + assists (external to Torn)
- **Stocks** — holdings-aware advisor ranked by **benefit value vs market value (MV)** ROI, liquid deploy plan, and reallocation suggestions

## Userscript install (auto-updates)

Tampermonkey userscript: [`war-panel.user.js`](war-panel.user.js).

1. Install [Tampermonkey](https://www.tampermonkey.net/), then open the raw script once:
   - https://raw.githubusercontent.com/YoBabys/torn-war-panel/main/war-panel.user.js
   - or https://github.com/YoBabys/torn-war-panel/raw/main/war-panel.user.js
2. Confirm the install prompt. Faction mates only need this once.
3. Updates: Tampermonkey checks `@updateURL` on its schedule (or Dashboard → **Check for userscript updates**). Bump `@version` in the script whenever you ship a change, then push to `main`.

The in-Torn overlay is this userscript; the product surface for faction-wide dibs and stocks is this site.

## Stack

| Piece | Role |
|-------|------|
| [`web/`](web/) | Vite + React + TypeScript SPA |
| [`sync/worker.js`](sync/worker.js) | Cloudflare Worker BFF (auth, Torn proxy, stock cache) |
| [`sync/faction-do.js`](sync/faction-do.js) | Durable Object for serialized dibs/assists |
| KV `WARPANEL` | Faction allowlist + stock catalog cache |

## Local development

```bash
# Terminal 1 — Worker (default http://127.0.0.1:8787)
npm run sync:dev

# Terminal 2 — SPA (http://127.0.0.1:5173, proxies /api → Worker)
npm run web:dev
```

1. Open the Worker admin at `http://127.0.0.1:8787/admin`
2. Log in with an owner Torn key (see secrets below) and **add your faction ID** to the allowlist
3. Open the SPA, paste a faction member’s Torn API key, Enter terminal

Optional: set **API base** on the login/settings screen to a deployed Worker URL (skip the Vite proxy).

### Env / secrets (Worker)

```bash
cd sync
npx wrangler secret put SESSION_SECRET
npx wrangler secret put OWNER_TORN_IDS   # comma-separated Torn user IDs
```

Vars in [`sync/wrangler.toml`](sync/wrangler.toml):

- `SESSION_TTL_SECONDS` (default 86400)
- `STOCK_CACHE_TTL_SECONDS` (default 600)

For local `wrangler dev`, you can also use a `.dev.vars` file in `sync/`:

```
SESSION_SECRET=dev-local-secret
OWNER_TORN_IDS=1234567
```

### SPA build / Pages

```bash
npm run web:build
```

Deploy `web/dist` to Cloudflare Pages (or any static host). Set build env:

```
VITE_API_BASE=https://seventh-terminal.<your-subdomain>.workers.dev
```

Or leave blank and have members paste the Worker URL under Settings → API base.

CORS already allows browser origins; the SPA sends `Authorization` + `X-Torn-Key` (key stays in the browser).

## Deploy Worker

```bash
npm run sync:deploy
```

First deploy will apply the Durable Object migration (`FactionRoom`). Confirm the KV namespace IDs in `sync/wrangler.toml` match your Cloudflare account (or create new ones and update the file).

## API surface

| Method | Path | Notes |
|--------|------|-------|
| POST | `/auth` | `{ tornKey }` → session (licensed faction only) |
| GET | `/torn/*` | Proxied Torn v2 (needs Bearer + `X-Torn-Key`) |
| GET | `/stocks/catalog` | Cached stocks + MV ROI fields |
| GET | `/state` | Faction dibs + assists |
| PUT/DELETE | `/dibs/:targetId` | Claim / release (`force` on PUT) |
| PUT/DELETE | `/assists` / `/assists/:id` | Shared assists (5 min TTL) |
| GET | `/admin` | Allowlist UI (owners only) |

## Stocks advisor (how ROI is computed)

For each **active** stock next benefit block:

- Block shares double each increment after the first
- `benefitValue` = cash payout, item market value, or a documented proxy (points/energy/etc.)
- `annualROI = (benefitValue × 365 / frequencyDays) / (nextBlockShares × price)`
- Monthly $ shown for advisor copy

**Passives** (IST, WLT, TCI, …) are listed as utility and excluded from sell suggestions unless “Treat passives as sellable capital” is enabled.

## Torn API key scopes

Prefer **Full**, or Limited/Custom with access to:

- user identity / money / stocks / attacks
- faction chain, wars, members

## License gate

Only faction IDs on the Worker allowlist can authenticate. Manage at `/admin` with `OWNER_TORN_IDS`.
