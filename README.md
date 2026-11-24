# On-call Health

Shows an engineering manager how hard on-call is hitting each person, and which alerts to fix first. Built for the quarterly on-call review.

**Live:** https://oncall-health.vercel.app

## The pain

Pages arrive through several tools at all hours, a lot of them are flapping, duplicated or resolve on their own, and one person quietly absorbs the swaps and weekends. Nobody has the numbers to argue for change.

## Features

- **Import** PagerDuty incidents CSV, REST API (`/incidents` plus `/log_entries`) and Analytics raw incidents, Opsgenie alerts CSV or Alert API JSON, Rootly CSV or JSON:API (incidents and alerts), or any CSV. Tested against the vendors' published example responses. Format detection, column mapping and a validation report with line numbers.
- **Per-person load** in each person's timezone and working hours: business hours, evenings, sleep hours (default 22:00 to 07:00) and weekends, plus a 7 x 24 heatmap.
- **Ack and resolve distributions**, **fairness** (Gini and share against a fair share) and a **documented burnout-risk score**.
- **Noise detection**: auto-resolved blips, flapping, duplicates, dependencies, never-acked and non-actionable alerts, ranked with a concrete change and the pages per month it removes. Toggle any fix as a what-if.
- **Rotation simulator** (single, primary/secondary, follow-the-sun), **pay and time off in lieu** with an editable policy, a **printable quarterly report** and CSVs.
- **History**: quarterly or monthly snapshots with a compare view.
- Local-first (IndexedDB). Optional email sign-in syncs teams across devices.
- Three synthetic sample teams.

## Run locally

```sh
npm install
npm run dev     # http://localhost:5173
npm test        # engine tests
npm run build
```

### Tests

```sh
npm test                           # engine unit tests (node:test)
npx playwright install chromium    # once; add --with-deps on a bare Linux box
npm run build && npm run test:e2e  # browser tests against the production build
```

`npm run test:e2e` starts `vite preview` itself on port 4173 and tests the `dist/` you just built, so build first. Use another port with `E2E_PORT=4400 npm run test:e2e`. It refuses to reuse a server that is already running. The suite runs signed out in Chromium, uses only the built-in sample teams and the synthetic files in `e2e/fixtures/`, and aborts every request that leaves the preview server (fonts, Supabase), so it needs no network or account. Any uncaught page error fails the test.

GitHub Actions (`.github/workflows/ci.yml`, job `test`) runs install, build, unit tests and the E2E suite on every pull request and on pushes to `main`.

`vercel.json` turns off preview deployments: only `main` is deployed, so pull requests are gated by CI rather than by a Vercel preview.

Cloud sync needs `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `.env` (see `.env.example`). Without them the app runs in local-only mode.

Built by Aryan Kansagara.
