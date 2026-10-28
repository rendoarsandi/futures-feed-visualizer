# Futures Feed Visualizer

- This is a standalone public market-data diagnostic. Never load bot credentials/account files, submit orders, infer fills or add a dependency on the private bot repository.
- `public/engine.js` owns trade acceptance, bounded history, lookback movement, weighted quorum and excursion counters. `streams.js` owns socket lifecycle; `feed-worker.js` owns the per-tab session. UI rendering cannot own counts.
- Use executed trades only. Quiet healthy feeds retain zero rolling movement; event timestamp age is diagnostic. Preserve exact Binance aggregate IDs, forward-gap history resets, replay/out-of-order rejection and per-session baselines. Do not substitute marks or BBO midpoint momentum.
- Weight each venue's own percentage return. Require two eligible venues representing at least half the configured weight. Held display prices cannot authorize signals.
- Keep history, deduplication, recent events and UI delivery bounded. Cancel sockets and timers on shutdown/reconfiguration. Health reads may rearm but cannot create live entries. Demo stays explicitly synthetic and offline.
- Keep deployment static and Vercel-ready. Sessions are per tab; document browser suspension and exchange access limits. Do not promise venue or execution latency.
- Keep development guidance here and usage/architecture in README.md. No account data, secrets, node_modules or build output in Git.
- Run `npm run check`, `npm test`, `npm run build`, and `git diff --check` before committing. Unit tests remain offline; live checks are opt-in. Add coverage only for meaningful boundary contracts or credible regressions.
- Keep checks local. Do not add GitHub Actions workflows; Vercel deployment uses its own Git integration.
- Commit/push only when requested. Preserve the owner's profile stats markers when editing its separate README.
