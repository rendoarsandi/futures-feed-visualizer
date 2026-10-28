# Futures Feed Visualizer

Live BTC futures prices and momentum from **Binance USD-M, Bybit, OKX and Hyperliquid**, alongside a weighted signal. Two charts, adjustable lookback and threshold, per-venue weights, and simulated Up/Down entry counters.

**[Source](https://github.com/rendoarsandi/futures-feed-visualizer) · [Deploy on Vercel](https://vercel.com/new)**

## Run locally

Requires Node.js 22 or newer. There are no runtime dependencies, API keys or Go installation requirements.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. For the explicitly synthetic, offline preview, open **http://127.0.0.1:5173/?demo=1**. Set `PORT=5174` to use another local port.

## Deploy on Vercel

1. Open [Vercel → New Project](https://vercel.com/new) and import `rendoarsandi/futures-feed-visualizer` from GitHub.
2. Keep the root directory at the repository root. `vercel.json` supplies the static build configuration: **Other** framework, `npm run build`, output directory `dist`.
3. Deploy. No environment variables, API keys, Functions or separate feed server are needed. Later pushes to `main` deploy through Vercel's Git integration.

The site opens the four public exchange WebSockets **from the visitor's browser**, rather than from Vercel. Supported domains are explicitly allowed in the deployment's Content Security Policy. Exchange restrictions on a visitor's region/network still apply; an unavailable stream is shown as connecting, with any previously observed price held as a dashed reference. It never silently falls back to an order book, mark or another market.

## Signal rules

- Defaults: **0.01% over 200 ms**, equal venue weights. Lookback supports 100–15000 ms. Each venue uses its own accepted executed-price history and local receipt clock. Movement is `(latest − baseline) / baseline × 100`.
- History uses a bounded 8192-anchor ring, keeping the first execution in each 2 ms bucket plus the exact final execution before skipped buckets. The supported 15-second window remains available during bursts. A connected quiet feed remains eligible and its rolling movement becomes zero.
- Weighted movement averages eligible venues' **percentage returns**, rather than changes in their average raw price. At least two venues covering half the configured weight must have current-session lookback baselines. Zero weight disables that stream.
- Binance forward aggregate-ID gaps reset its history and mark counts incomplete. Duplicate/reversed Binance IDs cannot replace accepted prices or timing. All venues filter replayed batches and reversed execution timestamps. Incoming event age does not itself exclude an ordered execution. Reconnects clear the affected stream's history.
- A simulated entry occurs on an accepted execution crossing the threshold after movement has been observed inside the threshold. A held excursion counts once; crossing directly from above to below the band does not rearm it. Health reads can rearm counters but cannot create live entries. There are no orders, fills, fees or PnL in these counts.
- The recent-entry log shows at most one entry per second across all venues and the weighted signal. Entries during that gap are omitted from the log; counters still include every qualifying excursion. Resetting the session clears the log and its gap.

## Sessions and limitations

Feed processing and counters run in a dedicated browser worker, separately from chart drawing. UI updates are limited to 20 Hz with at most one pending chart message. Pausing a chart affects presentation only. History holds at most 2600 display points, and recent signals at most 60.

Each tab has its **own in-memory session**. Applying settings or Reset clears its counters and chart. Closing/reloading the tab ends the session; no server continues counting. Browsers and phones may suspend background tabs, so keep the page active for comparisons. WebSocket replacements discard the affected baseline and disarm counters. Binance's browser-native control Ping/Pong is handled by the browser; the app cannot measure it or enforce the Go client's control-frame read watchdog. The other venues use bounded text-heartbeat recovery. This is a deliberate hosting/runtime difference.

The worker evaluates each accepted execution synchronously. Weighted snapshots use the current state of the other streams when that execution is processed. Each route has its own publication cadence and scheduling; the numbers do not establish exchange-level order, venue latency, fill speed or profitability. Quote-currency basis is not FX-adjusted. Counters are separate from strategy cooldowns and any running trading bot.

## Origin and checks

This standalone project ports the feed window, four executed-trade parsers, weighted quorum and counter semantics from the local Poly-Bot feed visualizer and its feed implementation at commit `15fe010`. It copies no account data, credentials, orders or trading execution code, and has no imports or runtime dependency on that repository. Future upstream changes are not automatically synchronized.

```sh
npm run check
npm test
npm run build
```

Tests are offline and cover wire-frame acceptance, quiet windows, ID gaps and replays, weighted quorum, held-price eligibility, threshold excursions, maximum-lookback retention, exact aggregate IDs, worker reset validation and bounded display delivery. An optional `npm run smoke:live` opens real exchange streams for 15 seconds; it is not part of the offline test suite and does not measure venue latency.
