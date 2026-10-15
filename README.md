# THBT Uniswap V4 Pool Data Viewer

A static, no-build single-page app for monitoring THBT liquidity pool performance on Uniswap v4 and building a monthly THB exchange-rate comparison report. There is no backend of its own — the browser talks directly to The Graph and (via a small proxy) the Bank of Thailand's exchange rate API.

## Architecture

```mermaid
flowchart TB
    subgraph CICD["Repo & Deployment"]
        Repo[("GitHub Repo<br/>index.html, bot-proxy-worker.js")]
        Actions["GitHub Actions<br/>(.github/workflows/static.yml)"]
        Pages["GitHub Pages<br/>(static hosting)"]
        Repo -- "push to main" --> Actions -- "upload + deploy" --> Pages
    end

    subgraph Browser["User's Browser (client-side SPA)"]
        App["index.html<br/>Table View / Raw JSON / Monthly Report"]
        LS[("localStorage<br/>Graph API key, BOT token, proxy URL")]
        App <--> LS
    end

    subgraph External["External Services"]
        Graph["The Graph Gateway<br/>Uniswap V4 subgraph"]
        Worker["Cloudflare Worker<br/>bot-proxy-worker.js (CORS relay)"]
        BOT["Bank of Thailand<br/>Daily Avg Exchange Rate API"]
    end

    Pages -- "serves static files" --> App
    App -- "GraphQL POST, Graph API key<br/>(poolDayDatas: price, volume)" --> Graph
    Graph -- "pool day data" --> App
    App -- "GET, Authorization: BOT token<br/>(Monthly Report only)" --> Worker
    Worker -- "server-to-server GET<br/>(no CORS restriction here)" --> BOT
    BOT -- "daily avg rates" --> Worker
    Worker -- "adds CORS headers, returns JSON" --> App
```

## How it works

**1. Static frontend, no backend.** `index.html` is the entire application — HTML, CSS and JS in one file, with three tabs: Table View, Raw JSON, and Monthly Report. There's no server, database, or build step of its own.

**2. Config lives in the browser.** The Graph API key, BOT App ID/Token, and the Cloudflare proxy URL are entered once in the UI and cached in `localStorage`, so they persist across visits without touching any server the project controls.

**3. Pool data comes straight from The Graph.** Table View, Raw JSON, and the pool-price/volume side of the Monthly Report all send a GraphQL `POST` directly from the browser to The Graph's hosted Uniswap V4 subgraph, using the user's own API key. Each supported pair (THBT vs. USDT, USDC, EURC, AUDD, XSGD) is defined by two pool IDs — the original pool and the pool it migrated to — so history isn't lost across the migration. Because token0/token1 ordering in a pool is fixed by contract address rather than which token is THBT, the app inspects `pool.token0.symbol` per row and re-orients prices/volumes so THBT is always on the same side of the output.

**4. BOT exchange rates go through a CORS relay.** The Monthly Report also pulls the Bank of Thailand's Daily Average Exchange Rate (THB → USD/EUR/SGD/AUD). `gateway.api.bot.or.th` doesn't send CORS headers, so a browser can't call it directly. `bot-proxy-worker.js` is a small Cloudflare Worker the user deploys themselves: the browser calls the worker, the worker calls BOT server-to-server (no CORS involved there), and adds the CORS headers itself before handing the response back. The worker only ever forwards to that one BOT endpoint and only forwards the `Authorization` header it's given.

**5. Deployment is push-to-deploy.** `.github/workflows/static.yml` deploys the whole repository as static content to GitHub Pages on every push to `main` (or manually via workflow dispatch) — no build artifacts, just the raw files.

## Price Deviation Dashboard (`dashboard.html`)

A second page that shows each pool's **current** THBT rate next to the latest BOT Daily Average Exchange Rate (mid rate) and flags the gap:

| Pair | Compared with |
|---|---|
| THBT / USDT, THBT / USDC | BOT USD |
| THBT / EURC | BOT EUR |
| THBT / XSGD | BOT SGD |
| THBT / AUDD | BOT AUD |

- **Deviation** = (Uniswap rate − BOT rate) ÷ BOT rate, with the Uniswap rate expressed as THBT per 1 token and 1 THBT treated as 1 THB.
- **Highlighting:** red when |deviation| > 4%, yellow when > 2%.
- **Pool prices** come from the Uniswap V4 subgraph's `pools` entity (updates with every swap), all five pools in one GraphQL request. Each pair uses its current (migrated) pool, falling back to the original pool if it's missing.
- **BOT rates** use the most recent published date in the last 14 days, so weekends and holidays show the last business day's rate. They're cached for 3 hours, since BOT publishes once per business day.
- **Refresh:** auto-refresh every 10, 15, 30 or 60 minutes (default 10), plus a **Refresh now** button that also re-fetches BOT rates. Auto-refresh runs only while the page is open.
- **Load:** a 10-minute interval is one subgraph query per refresh, about 4,300 a month for one open tab, within The Graph's free monthly allowance.
- **Settings** use the same `localStorage` keys as `index.html`, so a Graph key, BOT token and proxy URL saved there are picked up automatically.

## Shared Dashboard for the Team (`shared-dashboard/`)

A separate version of the price deviation dashboard that colleagues can open with a personal link (or an emailed one-time code), without needing their own Graph key or BOT token. It runs as a Cloudflare Worker that keeps the keys server-side and shares one cached result between all viewers. `dashboard.html` above is unchanged. Setup steps are in [`shared-dashboard/README.md`](shared-dashboard/README.md).

## Setup

- Get a Graph API key from [The Graph Studio](https://thegraph.com/studio/apikeys/) and paste it into the app. The Uniswap V4 subgraph ID is already built in.
- To enable the Monthly Report's BOT exchange-rate columns, deploy `bot-proxy-worker.js` as a free [Cloudflare Worker](https://workers.cloudflare.com/) (paste its contents into a new Worker and deploy — no CLI needed), then paste the resulting `*.workers.dev` URL into the app's BOT Proxy URL field.
- Never commit your Graph API key or BOT token into this repo — both are kept client-side in `localStorage` only.
