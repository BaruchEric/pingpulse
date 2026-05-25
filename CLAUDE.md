# PingPulse

Network monitoring app: a Convex backend, a Vite/React dashboard, and a native Rust client.

## Project structure

- `convex/` — Convex backend: schema, queries/mutations/actions, HTTP router (`http.ts`), crons (`crons.ts`)
- `dashboard/` — React SPA (Vite, react-router) — talks to the backend over HTTP (`VITE_API_URL`)
- `client/` — Native monitoring client (Rust)

## Architecture notes

- The backend runs entirely on Convex. `convex/http.ts` re-exposes a REST API under
  `/api/*` (served at `https://<deployment>.convex.site`) that both the dashboard and
  the Rust client call. Data lives in Convex tables (formerly Cloudflare D1).
- There is **no WebSocket**. The client POSTs a heartbeat to
  `/api/clients/:id/heartbeat` every ping interval, reporting measured RTT and pulling
  `{ config, commands, latest_version, server_logs }` in the response. Admin commands
  (pause/resume/speed_test/etc.) are queued server-side and pulled on the next heartbeat.
- Down/up detection is a 30s cron (`convex/monitor.ts`) scanning `lastSeen`. The 6h cron
  (`convex/maintenance.ts`) handles speed-test fan-out, retention, and health reports.
  Alert dispatch + retries use `ctx.scheduler` (`convex/alertDispatch.ts`).
- Admin auth is a Bearer JWT (HS256, `ADMIN_JWT_SECRET`); client auth is the per-client
  secret hash. The dashboard stores its token in `localStorage`.

## Checks

```sh
bun run typecheck   # tsc for convex/ + dashboard
bun run lint        # eslint for convex/ + dashboard
cd client && cargo test && cargo check
```

`convex/_generated/` is committed (codegen requires reaching Convex's host). After
changing schema/functions, regenerate with `npx convex dev` (or `npx convex codegen`).

## Deploy

```sh
npx convex deploy          # functions, schema, crons
cd dashboard && bun run build && <deploy dist/ to your static host>
```

Required Convex env vars (set with `npx convex env set NAME value`):
`ADMIN_JWT_SECRET`, `LATEST_CLIENT_VERSION`, and optionally `RESEND_API_KEY`,
`ALERT_FROM_EMAIL`, `ALERT_TO_EMAIL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

First run: bootstrap the admin password via `POST /api/auth/bootstrap {"password": "..."}`
(only works while no admin exists).

## Ship pipeline

1. Run all checks (typecheck, lint, cargo test)
2. Fix any failures
3. Commit and push
4. Deploy Convex (`npx convex deploy`) and publish the dashboard build
