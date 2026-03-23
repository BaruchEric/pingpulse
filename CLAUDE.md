# PingPulse

Cloudflare Workers project with a Vite/React dashboard.

## Project structure

- `worker/` — Cloudflare Worker (Hono API, Durable Objects, D1)
- `worker/dashboard/` — React SPA (Vite, react-router)
- `client/` — Native monitoring client (Zig)

## Checks

Run from `worker/`:

```sh
bun run typecheck   # tsc --noEmit for worker + dashboard
bun run lint        # eslint for worker + dashboard
bun run test        # vitest run
```

## Deploy

After pushing to git, always deploy to Cloudflare Workers:

```sh
cd worker && bun run deploy
```

This builds the dashboard and runs `wrangler deploy`. The site is live at `ping.beric.ca`.

## Ship pipeline

1. Run all checks (typecheck, lint, test) from `worker/`
2. Fix any failures
3. Commit and push
4. Deploy: `cd worker && bun run deploy`
