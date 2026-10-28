# AWS EC2 Capacity & Cost Assessment — Fiducial Insurance ERP

### Mumbai Region (ap-south-1) · October 2026

**Prepared by:** Senior AWS Cloud Architect & DevOps Engineer (AI-assisted analysis)  
**Evidence basis:** Direct read-only inspection of `Fiducial_backend` and `Fiducial_frontend` repositories on 26 October 2026 (`fiducial-ghi-frontend` excluded per user scope).  
**Disclaimer:** All AWS prices are sourced from third-party pricing aggregators and published AWS documentation as of October 2026. Prices are _estimates_ — verify at [calculator.aws](https://calculator.aws). Exchange rate assumed: **1 USD = 84 INR**.

---

## 1. Executive Summary

> **Scope confirmed:** Only `Fiducial_backend` (Express) and `Fiducial_frontend` (Next.js Property ERP). `fiducial-ghi-frontend` is excluded from deployment.  
> **Actual workload:** 5–10 concurrent users, 1–3 deployments per month.  
> **Root cause of past OOM:** `npm run build` / `next build` running on the production server alongside running apps.  
> With 1 frontend and 1 backend, steady-state runtime memory is only **~550–620 MB**.

| Decision point                              | Recommendation                                                                                                                       |
| :------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------- |
| **EC2 instance today (recommended)**        | **t3.medium** (2 vCPU / 4 GiB) — runtime uses ~15% of RAM; leaves >3.4 GB free. Zero hassle for builds.                              |
| **EC2 instance today (budget option)**      | **t3.small** (2 vCPU / 2 GiB) — runtime fits easily (~620 MB used, 1.4 GB free). Build requires CI/CD or `pm2 stop all` + 4 GB swap. |
| **Run frontend + backend on one instance?** | **Yes** — easily fits on a single instance for 5–10 users                                                                            |
| **Database on same instance?**              | **No** — use MongoDB Atlas Flex (~$8–15/month for managed 3-node replica set)                                                        |
| **Total all-in monthly cost**               | **≈ ₹5,000 – ₹5,750 / mo** (t3.medium) OR **≈ ₹3,400 – ₹3,950 / mo** (t3.small) incl. 18% GST                                        |
| **Build OOM problem**                       | Use `deployment/deploy.sh` (stops PM2 during build) or GitHub Actions CI/CD (§5A)                                                    |
| **When to upgrade**                         | When concurrent users exceed 30–50 or memory consistently exceeds 70%                                                                |

---

## 2. Actual Project Architecture Discovered

From direct inspection of the repositories:

```
Internet
  ▼ HTTPS:443
Nginx (reverse proxy)
  ├── / ──────────────► PM2: Fiducial_frontend     (next start :3001)
  │                        BFF: browser → /api/proxy/* → Express :5001
  └── /api/v1/health ──► Express API (direct, operator path)

PM2: fiducial-backend  →  node dist/server.js :5001
  └── Mongoose TLS ──────► MongoDB Atlas (replica set, ap-south-1)

Optional external calls:
  Express → SMTP (nodemailer)
  Express → Google Gemini API (OCR, off by default)
  Express → Existing-policy API (renewals, off by default)
```

**Key finding:** The Next.js app runs as a persistent Node.js server (`next start`) — not static HTML. It acts as a **Backend-for-Frontend (BFF)**; the browser never contacts Express directly. JWT tokens stay in `httpOnly` cookies injected server-side.

---

## 3. Verified Technology Stack

> Facts tagged **[Verified]** = observed directly in code/config. **[Estimate]** = reasoned from framework behaviour.

### 3.1 Backend (`Fiducial_backend`)

| Property          | Value                                                                              | Source                                          |
| :---------------- | :--------------------------------------------------------------------------------- | :---------------------------------------------- |
| Runtime           | **Node.js 24 LTS**                                                                 | `.nvmrc` **[Verified]**                         |
| Engine floor      | `>=20.12.0`                                                                        | `package.json engines` **[Verified]**           |
| Package manager   | npm 11.6.2                                                                         | `package.json` **[Verified]**                   |
| Framework         | **Express 5.2.1**                                                                  | `package.json` **[Verified]**                   |
| Language          | TypeScript 6.0, ESM (`"type":"module"`)                                            | `package.json` **[Verified]**                   |
| ORM / driver      | **Mongoose 9.10.4** → MongoDB only                                                 | `package.json`, `src/lib/db.ts` **[Verified]**  |
| DB requirement    | **Replica set mandatory** — multi-document ACID transactions via `withTransaction` | `src/lib/db.ts` **[Verified]**                  |
| Build command     | `npm run build` → `tsc -p tsconfig.build.json` → `dist/` (5.7 MB)                  | `package.json`, measured **[Verified]**         |
| Production start  | `node --env-file-if-exists=.env dist/server.js`                                    | `package.json` **[Verified]**                   |
| Process manager   | **PM2 fork mode, 1 instance**, `max_memory_restart: 1000M`                         | `ecosystem.config.cjs` **[Verified]**           |
| Default port      | 4000 (VPS: **5001**)                                                               | `env.ts`, `ecosystem.config.cjs` **[Verified]** |
| JSON body limit   | **1 MB**                                                                           | `src/app.ts:128` **[Verified]**                 |
| Security          | helmet, CORS exact-origin allowlist (Zod-validated), express-rate-limit            | `src/app.ts` **[Verified]**                     |
| Auth              | JWT (`jose 6.2.12`), Argon2 password hashing                                       | `package.json` **[Verified]**                   |
| Logging           | **Pino 10** structured JSON; health suppressed from logs                           | `src/app.ts` **[Verified]**                     |
| Graceful shutdown | SIGTERM/SIGINT → drain HTTP → close MongoDB (10 s timeout)                         | `src/server.ts` **[Verified]**                  |
| Health endpoint   | `GET /api/v1/health` → `{status, db, version, uptimeSeconds}`                      | `src/server.ts` **[Verified]**                  |

**Background workers (inside single Node process):**

- **Claim notification mail worker** — `setInterval` every 30 s; sends queued emails, retries failures. `timer.unref()` — does not prevent clean shutdown. **[Verified]**
- **Renewal reminder scanner** — `setInterval` every 360 min; scans policies expiring within 30 days, deduplicated via MongoDB unique index. **[Verified]**

**Memory-intensive operations identified:**

- **PDF generation** (`pdfmake 0.3.11`) — RFQ, QCR, Placement Slip, Coverage Letter from ExcelJS workbooks
- **Excel generation** (`exceljs 4.4.0`) — import templates, census workbooks, TPA reports
- **PDF text extraction** (`pdfjs-dist 4.10.38`) — quote auto-fill (built-in reader, on-server)
- **ZIP bundling** (`jszip 3.10.2`) — document archives
- **Large imports** — IIB master (thousands of rows), census workbooks

**No local filesystem writes** — all uploads/attachments stored in MongoDB as binary. **[Verified]**

### 3.2 Frontend 1 (`Fiducial_frontend`) — Property / Fire / Burglary

| Property                | Value                                                                                          | Source                                            |
| :---------------------- | :--------------------------------------------------------------------------------------------- | :------------------------------------------------ |
| Framework               | **Next.js 16.3.8** (App Router, React 19)                                                      | `package.json` **[Verified]**                     |
| PM2                     | fork mode, 1 instance, `max_memory_restart: 1500M`, port **3001**                              | `ecosystem.config.cjs` **[Verified]**             |
| Rendering               | SSR + BFF route handlers — **not static exportable**                                           | `next.config.ts`, `src/app/api/**` **[Verified]** |
| Static export feasible? | **No** — BFF proxy and auth middleware are server-side                                         | `DEPLOYMENT_AUDIT.md` **[Verified]**              |
| Build output            | `.next/server/` 25 MB, `.next/static/` 2.7 MB, `.next/cache/` 519 MB (dev cache, never deploy) | `du` **[Verified]**                               |
| In-memory page cache    | 50 MB max (`cacheMaxMemorySize: 52428800`)                                                     | `required-server-files.json` **[Verified]**       |
| Key env vars            | `API_URL` (server-only, not baked into bundle), `COOKIE_SECURE`, `USE_MOCK_API=false`          | `.env.production.example` **[Verified]**          |

### 3.3 GHI Frontend (`fiducial-ghi-frontend`) — Excluded from Deployment Scope

> **Deployment status:** **Excluded.** Per project requirements, only `Fiducial_backend` and `Fiducial_frontend` are deployed on this EC2 instance. `fiducial-ghi-frontend` is omitted from Nginx routing, PM2 configuration, and system resource calculations.

### 3.4 Database

| Property            | Value                                                    | Source                                                                                    |
| :------------------ | :------------------------------------------------------- | :---------------------------------------------------------------------------------------- |
| Engine              | **MongoDB 7.0**                                          | `docker-compose.yml`, `mongodb-memory-server` version **[Verified]**                      |
| ORM                 | Mongoose 9.10.4                                          | `package.json` **[Verified]**                                                             |
| Transaction mode    | Multi-document ACID — **replica set mandatory**          | `src/lib/db.ts` **[Verified]**                                                            |
| Recommended hosting | **MongoDB Atlas**                                        | `.env.production.example`, `DEPLOYMENT.md §3.1`, `DEPLOYMENT_AUDIT.md §10` **[Verified]** |
| Collections         | 42 Mongoose models in `src/models.ts`                    | `src/models.ts` **[Verified]**                                                            |
| `autoIndex`         | False — indexes created at startup via `ensureIndexes()` | `src/lib/db.ts` **[Verified]**                                                            |

---

## 4. Workload Assumptions and Evidence

No live monitoring data is available. The scenarios below are **planning assumptions**.

| Scenario            | Concurrent users | Typical operations                                                        |
| :------------------ | :--------------- | :------------------------------------------------------------------------ |
| **Small (current)** | 5–25             | Staff auth, CRUD on proposals, occasional RFQ PDF, light imports          |
| **Medium (growth)** | 25–75            | Concurrent RFQ/QCR generation, census imports, claim status updates       |
| **Large (future)**  | 75–200           | High-volume census workbooks, batch TPA imports, many concurrent sessions |

**Evidence for "small" as the current workload:**

- PM2 configured as single fork-mode process — not cluster mode.
- `max_memory_restart` values (1000M backend, 1500M frontend) match a single-instance setup.
- Co-hosted VPS deployment beside another unrelated application.
- No load balancer, CDN, or horizontal scaling in any documentation.
- Insurance brokerage ERP: typical Indian brokerage staff populations in early production number in tens.

---

## 5. Resource Consumption Estimates

> All figures assume **MongoDB Atlas** — database is **not** on the EC2 instance.

### 5.1 Backend Process Memory

| State                         | Estimated RSS   | Reasoning                                                                                                             |
| :---------------------------- | :-------------- | :-------------------------------------------------------------------------------------------------------------------- |
| Idle baseline                 | ~120–160 MB     | V8 heap, Mongoose pool (5 connections default), Express route tree, Pino, pdfmake fonts (loaded at init), Zod schemas |
| Normal CRUD load              | +20–40 MB       | In-flight request objects, JSON parsing, Mongoose result docs                                                         |
| PDF generation (RFQ/QCR/slip) | +60–180 MB peak | ExcelJS loads full workbook into JS objects; pdfmake builds entire document model in memory before rendering          |
| Census import (1,000 rows)    | +30–80 MB       | ExcelJS row iteration, Mongoose bulk insert                                                                           |
| Large IIB master import       | +50–100 MB      | Thousands of rows from uploaded .xlsx                                                                                 |
| PM2 daemon                    | ~30–40 MB       | Separate OS process                                                                                                   |

**Backend realistic range: 150–350 MB.**

### 5.2 Frontend Process Memory (per frontend)

- V8 heap + Next.js server runtime: ~100–130 MB base.
- In-memory page cache: 50 MB max.
- BFF route handlers: minimal local allocation (streams proxied to Express).
- React 19 server components: rendered to HTML, not held.
- **Steady-state estimate: 150–250 MB per frontend.**

### 5.3 OS and Supporting Processes

| Process          | Memory         |
| :--------------- | :------------- |
| Ubuntu 24.04 OS  | ~200–250 MB    |
| Nginx            | ~5–15 MB       |
| PM2 daemon       | ~30–40 MB      |
| SSH/sshd         | ~10 MB         |
| CloudWatch agent | ~30–50 MB      |
| **Total**        | **275–365 MB** |

### 5.4 Combined Memory Budget (Backend + 1 Frontend)

#### At 5–10 concurrent users (actual workload)

| Component                          | Idle / Low | Typical for 5–10 users | Peak (PDF / Bulk import) |
| :--------------------------------- | :--------: | :--------------------: | :----------------------: |
| OS + Nginx + PM2 + system          |   275 MB   |         300 MB         |          330 MB          |
| Express backend (`dist/server.js`) |   120 MB   |         150 MB         |          350 MB          |
| Fiducial_frontend (`next start`)   |   150 MB   |         170 MB         |          220 MB          |
| **Total runtime**                  | **545 MB** |       **620 MB**       |        **900 MB**        |

At 5–10 users, operations are mostly standard CRUD with sporadic, non-concurrent PDF generation. Realistically this workload stays at **~550–650 MB** during normal active use.

#### At 25–50 concurrent users (medium growth)

| Component         |  Typical   | Peak (concurrent PDFs + imports) |
| :---------------- | :--------: | :------------------------------: |
| OS + system       |   300 MB   |              340 MB              |
| Express backend   |   200 MB   |              350 MB              |
| Fiducial_frontend |   200 MB   |              280 MB              |
| **Total**         | **700 MB** |            **970 MB**            |

### 5.5 Instance Sizing for Actual Workload

| Instance RAM             | Verdict for 5–10 users (1 Frontend + 1 Backend)                                                                                                                                                                                                                                                                     |
| :----------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **t3.small — 2 GiB** 💡  | ✅ **Viable budget option.** Runtime memory is only ~620 MB, leaving **~1.4 GB free** (70% headroom). Even a 900 MB PDF peak fits. **Build requirement:** Since `next build` needs ~1.5 GB, building on the server requires `deploy.sh` (`pm2 stop all`) + 4 GB swap, or offloading builds to GitHub Actions CI/CD. |
| **t3.medium — 4 GiB** ⭐ | ✅ **Recommended for zero-friction operation.** Runtime uses only ~15% of RAM (~3.4 GB free). Builds easily on-box with `deploy.sh` with zero memory pressure. Leaves room for growth without manual intervention.                                                                                                  |
| t3.large — 8 GiB         | ⚠️ Overkill for 5–10 users with 1 frontend. Sits >88% idle. Revisit if traffic exceeds 50+ concurrent users.                                                                                                                                                                                                        |
| t3.xlarge — 16 GiB       | ⚠️ Massive overkill.                                                                                                                                                                                                                                                                                                |

> **Key insight:** The previous OOM was caused by running `npm run build` / `next build` on the
> production server — **not** by the runtime memory of the application itself. `next build` for a
> Next.js 16 app consumes 1–2 GiB of RAM on its own. That is a **build-time problem**, solved by
> moving builds off the server or stopping PM2 during builds. The instance does NOT need to be sized to absorb a concurrent build.

---

## 5A. Solving the Build OOM Problem (Primary Issue)

Three concrete options, ordered from best to simplest:

### Option 1: CI/CD — Build in GitHub Actions (Recommended)

GitHub Actions runners have **7 GiB RAM** by default and are free for public/private repos within
the free tier (2,000 min/month on free plan — more than enough for 1–3 deploys/month).

The backend CI already does `npm run build`. Add a deploy job:

```yaml
# .github/workflows/deploy.yml  (new file)
name: Deploy
on:
  workflow_dispatch: # manual trigger
  push:
    branches: [main]

jobs:
  build-and-deploy:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm

      # --- Backend ---
      - run: npm ci
        working-directory: Fiducial_backend
      - run: npm run build
        working-directory: Fiducial_backend
      # Rsync only dist/ (not node_modules) to the server
      - run: |
          rsync -az --delete Fiducial_backend/dist/ ubuntu@${{ secrets.EC2_IP }}:/var/www/fiducial/Fiducial_backend/dist/

      # --- Frontend ---
      - run: npm ci
        working-directory: Fiducial_frontend
      - run: npm run build
        working-directory: Fiducial_frontend
      - run: |
          rsync -az --delete Fiducial_frontend/.next/ ubuntu@${{ secrets.EC2_IP }}:/var/www/fiducial/Fiducial_frontend/.next/

      # Restart PM2 on server
      - run: ssh ubuntu@${{ secrets.EC2_IP }} 'pm2 restart ecosystem.config.cjs'
```

**Result:** Builds never touch the production server. The EC2 instance only runs the 2 Node.js processes.

### Option 2: Build on the Server with PM2 Stopped (Simplest for 1–3 deploys/month)

For infrequent deployments with only 5–10 users, a brief 2–3 minute deployment window is completely acceptable.
The turnkey deployment script is saved at `deployment/deploy.sh`:

```bash
#!/usr/bin/env bash
# deploy.sh — run on the EC2 server (stops PM2, builds sequentially, restarts PM2)
set -euo pipefail
cd /var/www/fiducial

# Pull latest code
git -C Fiducial_backend pull origin main
git -C Fiducial_frontend pull origin main

# Stop all Node processes to free RAM before building
pm2 stop all

# Limit build memory ceiling
export NODE_OPTIONS="--max-old-space-size=2048"

# Build backend (~400 MB RAM, 30–60 s)
cd Fiducial_backend && npm ci --prefer-offline && npm run build && cd ..

# Build frontend (~1.5 GB RAM, 2–3 min)
cd Fiducial_frontend && npm ci --prefer-offline && npm run build && cd ..

# Restart everything
pm2 restart ecosystem.config.cjs
pm2 save

echo "Deploy complete"
```

**RAM available for build:**

- On a **`t3.medium`** (4 GiB) with PM2 stopped: ~3.7 GB free. `next build` peaks at ~1.5 GB. Zero memory issues. ✅
- On a **`t3.small`** (2 GiB) with PM2 stopped: ~1.7 GB free + 4 GB swap. Peak of 1.5 GB completes safely with swap. ✅  
  **Downtime:** ~2–4 minutes total per deployment — trivial for 5–10 internal users with 1–3 deploys/month.

### Option 3: Build with Memory Cap (Keep PM2 Running, No Downtime)

If even brief downtime is unacceptable, limit `next build` memory and run builds alongside the running app:

```bash
# Limit next build to 1.5 GB (t3.medium has 4 GB; running app uses ~700 MB; 1.5 GB for build)
export NODE_OPTIONS="--max-old-space-size=1500"
npm run build   # in each frontend dir
```

**Risk:** If the running app has a burst (e.g., PDF generation) during the build, total RAM could hit ~2.5 GB — still inside 4 GiB on t3.medium, but tight. Add swap (§12.1, step 9) as a safety net.  
**Best used with:** swap enabled + a deployment time chosen during off-peak hours (e.g., midnight).

**Summary:**

| Strategy                                   | Downtime |          RAM needed           |       Complexity        |
| :----------------------------------------- | :------: | :---------------------------: | :---------------------: |
| Option 1: CI/CD (GitHub Actions)           |   Zero   |   7 GB (on GH runner, free)   | Medium (one-time setup) |
| Option 2: Stop PM2, build, restart         | 5–8 min  | ~1.5 GB (plenty on t3.medium) |           Low           |
| Option 3: Build alongside app + memory cap |   Zero   |         ~2.5 GB peak          |           Low           |

### 5.6 CPU Requirements

Workload is **I/O-bound at normal load**, with **CPU-bound bursts** during:

- `pdfmake` rendering (synchronous, 200–800 ms/document)
- `exceljs` workbook parse/build
- Argon2 hashing (deliberate, ~200 ms)

**T3 CPU credit risk:** If PDF generation exceeds ~5–10/hour sustained, T3 may throttle to 20% baseline (≈ 0.4 effective vCPU). This is the primary T3 operational risk. Monitor credit balance; switch to `m7i.large` if credits are consistently depleted.

---

## 6. EC2 Instance Comparison (ap-south-1, Linux On-Demand)

> **Source:** vantage.sh, cloudburn.io, sparecores.com — cross-checked October 2026.  
> **These are estimates — verify at [calculator.aws](https://calculator.aws).**  
> Monthly = hourly × 730 hours.

| Instance         | vCPU |  RAM   |  $/hr   |  $/mo   | ₹/mo (@84) | CPU credits           | Suitability for 5–10 users (1 Frontend + 1 Backend)                                                               |
| :--------------- | :--: | :----: | :-----: | :-----: | :--------: | :-------------------- | :---------------------------------------------------------------------------------------------------------------- |
| **t3.small** 💡  |  2   | 2 GiB  | $0.0224 | $16.35  |   ₹1,373   | Burstable 10%         | 💡 **Viable budget option.** Runtime is ~620 MB; ~1.4 GB free. Build on-box with `deploy.sh` + swap, or in CI/CD. |
| **t3.medium** ⭐ |  2   | 4 GiB  | $0.0448 | $32.70  |   ₹2,747   | Burstable 20%         | ✅ **Recommended baseline.** Runtime ~620 MB; >3.4 GB free. Builds on-box effortlessly with `deploy.sh`.          |
| t3a.medium       |  2   | 4 GiB  | $0.0376 | $27.45  |   ₹2,306   | Burstable 20% AMD     | ✅ Budget alternative — same specs, AMD, 16% cheaper                                                              |
| t3.large         |  2   | 8 GiB  | $0.0896 | $65.41  |   ₹5,494   | Burstable 30%         | ⚠️ Overkill for 5–10 users with 1 frontend; upgrade only at 50+ users                                             |
| t3a.large        |  2   | 8 GiB  | $0.0752 | $54.90  |   ₹4,611   | Burstable 30% AMD     | ⚠️ Overkill                                                                                                       |
| t3.xlarge        |  4   | 16 GiB | $0.1792 | $130.82 |  ₹10,989   | Burstable 40%         | ⚠️ Overkill                                                                                                       |
| m7i.large        |  2   | 8 GiB  | $0.1010 | $73.73  |   ₹6,193   | None — full sustained | ⚠️ Overkill                                                                                                       |
| m7a.large        |  2   | 8 GiB  | $0.1159 | $84.61  |   ₹7,107   | None — full sustained | ⚠️ Overkill                                                                                                       |

**All instances confirmed available in ap-south-1 (all three AZs). [Verified via pricing search]**

---

## 7. Architecture Comparison

### Architecture A: All on One EC2 + Atlas (Recommended)

Backend + 1 frontend + Nginx on t3.medium (or t3.small). MongoDB on Atlas.

| Dimension       | Assessment                                     |
| :-------------- | :--------------------------------------------- |
| Monthly compute | ~$65 (t3.large)                                |
| Complexity      | Low — PM2 manages everything                   |
| Performance     | Adequate; loopback inter-process communication |
| Security        | Good — Express never exposed; BFF enforced     |
| Availability    | Single point of failure; PM2 auto-restarts     |
| Scaling         | Vertical only                                  |
| **Verdict**     | **Best for current scale**                     |

### Architecture B: App EC2 + Managed Database ⭐ (Recommended)

Backend + 2 frontends on t3.large. MongoDB Atlas Flex or M10.

| Dimension       | Assessment                                                                                                                              |
| :-------------- | :-------------------------------------------------------------------------------------------------------------------------------------- |
| Monthly compute | EC2 $65 + Atlas Flex $8–30 = $73–$95                                                                                                    |
| Complexity      | Slightly higher (Atlas account)                                                                                                         |
| Performance     | Better DB reliability; Atlas handles failover                                                                                           |
| Security        | Atlas network access controls; TLS enforced                                                                                             |
| Availability    | Atlas M10 = 3-node replica set with auto-failover                                                                                       |
| Scaling         | Atlas storage/compute scales independently                                                                                              |
| **Verdict**     | **Recommended.** MongoDB already requires a replica set; Atlas removes that operational burden. Flex at $8–30/month is excellent value. |

### Architecture C: Separate Hosting (Vercel/Railway for Frontends)

Partially feasible — `API_URL` is a runtime server-only env var, not baked into bundles. However, adds CI/CD complexity, CORS coordination, and cost. Not recommended until single-server model is outgrown.

### Architecture D: CI/CD Artifact Builds ⭐ (Must-Implement Practice)

GitHub Actions builds TypeScript and Next.js; only prebuilt artifacts deployed to EC2.

| Dimension       | Assessment                                                                                                                            |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------ |
| Additional cost | **None** — GitHub Actions free tier is sufficient                                                                                     |
| Build memory    | Offloaded to 7 GiB GitHub runners — eliminates OOM-during-build                                                                       |
| EC2 impact      | **Zero** — `npm run build` / `next build` never runs on production server                                                             |
| Disk savings    | Dev `node_modules` not needed on server                                                                                               |
| **Verdict**     | **Must-implement.** Eliminates the largest single operational risk. The existing CI already builds — extend it with a CD/deploy step. |

---

## 8. Detailed Monthly Cost Estimates (INR)

**Exchange rate: 1 USD = 84 INR. GST: 18% on AWS invoices for Indian accounts.**

### 8.1 Component Cost Reference

| Component                                  | USD/month  |    INR/month    |
| :----------------------------------------- | :--------: | :-------------: |
| EC2 t3.medium (730 hrs)                    |   $32.70   |     ₹2,747      |
| EC2 t3a.medium (730 hrs)                   |   $27.45   |     ₹2,306      |
| EC2 t3.large (730 hrs)                     |   $65.41   |     ₹5,494      |
| EBS gp3 30 GB ($0.08/GB-mo)                |   $2.40    |      ₹202       |
| EBS gp3 40 GB                              |   $3.20    |      ₹269       |
| Public IPv4 (1 addr, 730 hrs)              |   $3.65    |      ₹307       |
| Data transfer out ~50 GB (5–10 users est.) |   $4.25    |      ₹357       |
| MongoDB Atlas Flex (~est.)                 |   $8–15    |   ₹672–₹1,260   |
| MongoDB Atlas M10 3-node (~est.)           | ~$180–$276 | ₹15,120–₹23,184 |
| CloudWatch Agent + metrics (est.)          |   $3–$5    |    ₹252–₹420    |

> **Data transfer for 5–10 users:** At this scale, 50 GB/month is a generous ceiling (small JSON
> API responses + occasional PDF downloads). 100 GB would be unlikely without heavy file usage.

### 8.2 All-In Monthly Cost Scenarios (Calibrated for 5–10 Users, 1 Frontend + 1 Backend)

| Option                  | Configuration                                               | USD/mo | ₹/mo pre-GST | ₹/mo incl. 18% GST | Notes                                                                                   |
| :---------------------- | :---------------------------------------------------------- | :----: | :----------: | :----------------: | :-------------------------------------------------------------------------------------- |
| **Ultra-Budget** 💡     | t3.small + Atlas Flex + 30 GB EBS + IPv4 + 50 GB transfer   |  ~$35  |   ~₹2,940    |    ~**₹3,470**     | 💡 Lowest cost. Runtime fits easily (~620 MB). Build with `deploy.sh` + swap, or CI/CD. |
| **Recommended** ⭐      | t3.medium + Atlas Flex + 30 GB EBS + IPv4 + 50 GB transfer  |  ~$51  |   ~₹4,284    |    ~**₹5,055**     | ✅ **Optimal balance.** >3.4 GB free RAM. Zero build-friction, zero worry.              |
| **Budget alt (AMD)**    | t3a.medium + Atlas Flex + 30 GB EBS + IPv4 + 50 GB transfer |  ~$45  |   ~₹3,780    |    ~**₹4,460**     | ✅ AMD, identical specs, 13% cheaper                                                    |
| **Future-proof**        | t3.large + Atlas Flex + 40 GB EBS + IPv4 + 50 GB transfer   |  ~$84  |   ~₹7,056    |    ~**₹8,326**     | ⚠️ Overkill today; upgrade if users hit 50+                                             |
| **Growth (managed DB)** | t3.medium + Atlas M10 3-node + 30 GB EBS + IPv4             | ~$221  |   ~₹18,564   |    ~**₹21,905**    | ⚠️ When Flex 5 GB storage ceiling is hit                                                |

> **Atlas Flex vs M10:** Flex provides a managed replica set + 7-day free backups + TLS with a 5 GB
> storage cap. Perfectly adequate for a launch-phase ERP with 5–10 users. Upgrade to M10 dedicated
> when storage approaches 4 GB.

---

## 9. Recommended Production Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  EC2: t3.medium (or t3.small)  Ubuntu 24.04  ap-south-1       │
│                                                               │
│  Nginx :443 (Let's Encrypt TLS, HTTP→HTTPS redirect)         │
│    ├─ / ─────────────► PM2: fiducial-frontend      :3001     │
│    (operator: /api/v1/health, /api/docs → Express  :5001)    │
│                                                               │
│  PM2: fiducial-backend  →  node dist/server.js :5001         │
│    └─ Mongoose TLS ──────► MongoDB Atlas Flex (ap-south-1)   │
│                                                               │
│  EBS gp3: 30 GB  |  1 Elastic Public IPv4                    │
└───────────────────────────────────────────────────────────────┘
            Deployment: deployment/deploy.sh OR GitHub Actions
             ├─ Build backend  → dist/
             └─ Build Fiducial_frontend  → .next/
```

**Production PM2 configuration (`ecosystem.config.cjs`):**

```javascript
module.exports = {
  apps: [
    {
      name: 'fiducial-backend',
      cwd: '/var/www/fiducial/Fiducial_backend',
      script: 'dist/server.js',
      node_args: '--env-file=.env',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: 5001,
      },
    },
    {
      name: 'fiducial-frontend',
      cwd: '/var/www/fiducial/Fiducial_frontend',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3001',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '600M',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
    },
  ],
};
```

---

## 10. Security and Availability Considerations

### 10.1 Security Posture

| Control                                               | Status                                 | Action                                                   |
| :---------------------------------------------------- | :------------------------------------- | :------------------------------------------------------- |
| JWT never reaches browser (BFF + httpOnly cookie)     | ✅ Enforced by architecture            | Maintain                                                 |
| Express bound to loopback (not public)                | ✅ By design                           | Maintain                                                 |
| Helmet.js security headers                            | ✅ Enabled                             | Maintain                                                 |
| CORS exact-origin allowlist (Zod-validated)           | ✅ Verified                            | Maintain                                                 |
| Login rate-limiting (in-memory, single instance safe) | ✅ Configured                          | Add Redis store before horizontal scaling                |
| Secrets not in source control                         | ✅ `.gitignore` covers `.env*`         | Use AWS SSM Parameter Store for production               |
| Argon2 password hashing                               | ✅ Memory-hard                         | Maintain                                                 |
| `COOKIE_SECURE=true` in production                    | ⚠️ **Currently false in VPS config**   | **Set to `true` immediately when HTTPS is active**       |
| SSH restricted to trusted IPs                         | ❓ Unknown (depends on security group) | Restrict port 22 to office/VPN CIDR                      |
| Least-privilege IAM role on EC2                       | ❓ Not in codebase                     | Create instance role (SSM + CloudWatch only)             |
| EBS encryption at rest                                | ❓ Not confirmed                       | Enable at volume creation (no cost with AWS-managed key) |
| MongoDB Atlas TLS                                     | ✅ `mongodb+srv://` enforces TLS       | Maintain                                                 |
| Atlas network access                                  | ⚠️ Needs Elastic IP restriction        | Allowlist only EC2 Elastic IP in Atlas Network Access    |
| Log rotation                                          | ❓ Not configured                      | Install `pm2-logrotate` to prevent disk exhaustion       |
| Swagger UI is public                                  | ⚠️ By design                           | Consider IP-restricting `/api/docs` in production        |

### 10.2 Data Sensitivity

Application handles employee PII, salary, DoB, banking details, medical claims, and health insurance data. Under India's DPDP Act 2023:

- Data must remain in India — **Atlas ap-south-1** satisfies this.
- Encryption in transit: enforced (Atlas TLS + HTTPS).
- Encryption at rest: **enable** EBS encryption + Atlas encryption-at-rest.
- Audit log (`AuditLogModel`) is append-only — **[Verified]**.

---

## 11. Monitoring and Scaling Thresholds

### 11.1 CloudWatch Alarms

> Install the **CloudWatch Agent** — EC2 does not expose RAM metrics by default.

| Metric                    | Warning        | Critical        | Action                                   |
| :------------------------ | :------------- | :-------------- | :--------------------------------------- |
| EC2 CPU Utilization       | >60% for 5 min | >80% for 10 min | Investigate; consider m7i.large upgrade  |
| Memory Usage (CW Agent)   | >70%           | >85%            | Scale up instance; check for leaks       |
| Disk Usage                | >70%           | >85%            | Expand EBS; clear PM2 logs               |
| PM2 process restarts      | >2 in 10 min   | >5 in 10 min    | Check logs for OOM/crash                 |
| MongoDB Atlas connections | >80% of limit  | >90% of limit   | Tune Mongoose pool or upgrade Atlas tier |
| HTTP 5xx error rate       | >1% over 5 min | >5% over 5 min  | Alert; check PM2 logs                    |

### 11.2 Scaling Decision Points

| Signal                          | Action                                      |
| :------------------------------ | :------------------------------------------ |
| T3 CPU credit balance < 100     | Upgrade to m7i.large                        |
| Memory consistently > 70%       | Upgrade t3.large → t3.xlarge or optimize    |
| PM2 OOM restarts > 2/day        | Profile Node heap; consider larger instance |
| p95 response time > 2 s         | Profile MongoDB queries; add indexes        |
| > 75 concurrent users sustained | Horizontal scaling (ALB + 2× t3.large)      |
| Atlas Flex storage > 4 GB       | Upgrade to Atlas M10 dedicated              |

---

## 12. Deployment Recommendations

### 12.1 Pre-Launch Actions (Ordered by Priority)

1. **Implement safe build strategy.** Use `deployment/deploy.sh` (builds sequentially with PM2 stopped) or GitHub Actions CD.
   - **Never run unconstrained concurrent `next build` alongside running production processes.**

2. **Calibrated PM2 memory limits.** Keep `max_memory_restart` set to `500M` for backend and `600M` for frontend to prevent any memory runaway.

3. **Set `COOKIE_SECURE=true`** as soon as HTTPS is configured.

4. **Install `pm2-logrotate`** to prevent disk exhaustion:

   ```bash
   pm2 install pm2-logrotate
   pm2 set pm2-logrotate:max_size 50M
   pm2 set pm2-logrotate:retain 7
   ```

5. **Install CloudWatch Agent** and configure the alarms in §11.1.

6. **Enable EBS encryption** at volume creation.

7. **Restrict Atlas Network Access** to the EC2 Elastic IP only.

8. **Restrict SSH** (port 22) to known CIDR ranges in the EC2 security group.

9. **Add 4 GB swap** as a safety buffer:

   ```bash
   sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
   sudo mkswap /swapfile && sudo swapon /swapfile
   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   ```

   > **Caveat:** Swap to EBS (~100 MB/s) is far slower than RAM. Consistent swap use means the instance is undersized — upgrade, do not rely on swap as a substitute.

10. **Health check:** `/api/v1/health` already exists — configure it in an ALB Target Group when load balancing is added.

### 12.2 Staging Recommendation

Before production, deploy prebuilt artifacts to a **staging instance** (`t3.small` or `t3.medium`). Run the full workflow (login → create proposal → generate PDF → download RFQ) and verify `pm2 status` shows zero restarts.

---

## 13. Risks, Uncertainties, and Assumptions

| Risk                                         | Likelihood            | Impact   | Mitigation                                                            |
| :------------------------------------------- | :-------------------- | :------- | :-------------------------------------------------------------------- |
| Unconstrained `npm run build` on server      | **High**              | **High** | Use `deployment/deploy.sh` or GitHub Actions CD                       |
| `COOKIE_SECURE=false` in VPS config          | **High**              | Medium   | Enable with HTTPS                                                     |
| T3 CPU credit exhaustion during PDF bursts   | Medium                | Medium   | Monitor; switch to m7i.large if triggered                             |
| Atlas Flex 5 GB storage ceiling              | Medium                | Low      | Monitor; upgrade to M10 at 4 GB                                       |
| 1 MB JSON body limit on large uploads        | Medium                | Medium   | Increase `express.json` limit in `src/app.ts` if needed (code change) |
| MongoDB standalone (if Atlas not used)       | Low                   | **High** | Mandate Atlas or self-managed replica set                             |
| In-memory rate-limiter (no horizontal scale) | Low (single instance) | Medium   | Add Redis store before ALB + multi-instance                           |
| Exchange rate fluctuation ₹/USD              | Medium                | Low      | Budget ±10% variance                                                  |
| AWS pricing changes                          | Low                   | Low      | Verify quarterly at calculator.aws                                    |

---

## 14. Final Decision with Justification

### Recommended: **t3.medium** (2 vCPU / 4 GiB) OR Budget: **t3.small** (2 vCPU / 2 GiB)

**Why t3.medium is recommended for zero operational friction:**  
With 1 frontend and 1 backend, the two Node.js processes consume only ~550–620 MB at steady state. A `t3.medium` (4 GiB) leaves **~3.4 GB free** (>85% headroom). When running `deployment/deploy.sh` (which stops PM2 during build), `next build` has 3.7 GB of free RAM to execute cleanly without any memory constraints. Total monthly cost: **~₹5,055/month** (incl. Atlas Flex & GST).

**Why t3.small is a viable ultra-budget alternative:**  
For 5–10 users, runtime memory is well below 1 GB. A `t3.small` (2 GiB) has **1.4 GB free** during normal operations. Total monthly cost drops to **~₹3,470/month** (incl. Atlas Flex & GST). The only operational rule: builds must be run via `deployment/deploy.sh` with a 4 GB swapfile, or built in GitHub Actions CI/CD.

**Why not t3.large:**  
At $65/month vs $33/month, `t3.large` costs double and would sit >88% idle. Sizing for builds by overpaying for RAM 24/7 is an anti-pattern. Upgrade to `t3.large` only if concurrent users exceed 50+.

**Why Atlas over self-hosted MongoDB:**  
The application requires a replica set for transactions. Running mongod on the same EC2 instance adds ~300 MB RAM, disk I/O contention, and zero automated backups. Atlas Flex provides a managed 3-node replica set + automatic backups + TLS for $8–15/month.

---

## Final Answers

### Which EC2 instance should I choose today?

1. **`t3.medium`** (2 vCPU / 4 GiB, ap-south-1) — **Recommended choice.** Zero-worry baseline. Total cost: **~₹5,055/month** all-in incl. GST.
2. **`t3.small`** (2 vCPU / 2 GiB, ap-south-1) — **Ultra-budget choice.** Saves ₹1,600/month (total: **~₹3,470/month** all-in). Requires 4 GB swap for builds.

### Can one instance safely host the frontend and the backend?

**Yes**, comfortably on either `t3.medium` or `t3.small` for 5–10 users — the runtime memory is only ~550–620 MB.  
The only condition: **use `deployment/deploy.sh` or CI/CD to prevent `npm run build` from competing with running processes**.

### Should the database run on that same instance?

**No.** Use MongoDB Atlas Flex (~$8–15/month). Transactions require a replica set; Atlas provides it without the operational burden.

### What is the realistic total monthly cost in the Mumbai region?

**Recommended configuration (t3.medium + Atlas Flex) — 1 Frontend + 1 Backend:**

| Line item                               |     USD      |        INR         |
| :-------------------------------------- | :----------: | :----------------: |
| EC2 t3.medium (730 hrs)                 |    $32.70    |       ₹2,747       |
| EBS gp3 30 GB                           |    $2.40     |        ₹202        |
| Public IPv4 (730 hrs)                   |    $3.65     |        ₹307        |
| Data transfer out ~50 GB                |    $4.25     |        ₹357        |
| MongoDB Atlas Flex (estimate)           |    $8–15     |    ₹672–₹1,260     |
| **Subtotal (pre-GST)**                  | **~$51–$58** | **~₹4,284–₹4,872** |
| **18% GST**                             |    ~$9–10    |     ~₹771–₹877     |
| **Total (t3.medium)**                   | **~$60–$68** | **~₹5,055–₹5,749** |
| **Total (t3.small budget alternative)** | **~$41–$49** | **~₹3,470–₹4,128** |

Expect **₹3,500 – ₹5,000/month** depending on whether you pick `t3.small` or `t3.medium`. This is roughly half of original estimates, because the instance is correctly sized for the actual workload.

### What should I change if the application grows to 100–200 concurrent users?

1. **Vertical scale first:** Resize t3.medium → t3.large (stop instance, change type, start — minimal downtime, zero code change). Do this when CloudWatch memory alarm fires at >70%.
2. **Atlas M10:** Upgrade when Flex shared compute lags or storage > 4 GB.
3. **Horizontal (if vertical maxes out):** ALB + 2× EC2. Requires Redis for rate-limiter state before this step.
4. **CloudFront:** Cache `.next/static/` assets to reduce origin bandwidth.

### What evidence should I collect before upgrading the instance?

Collect **7 consecutive days** of:

1. Per-process memory (`pm2 monit` or CloudWatch custom metrics).
2. T3 CPU credit balance — upgrade to m7i.large if < 50 consistently.
3. P95 / P99 response times for PDF/Excel endpoints.
4. PM2 restart count — OOM kills appear as unexpected restarts.
5. MongoDB Atlas connection count and query execution time.
6. EBS disk usage — confirm `pm2-logrotate` is working.

Only upgrade if **two or more signals** exceed their warning thresholds for 3+ consecutive days.

---

## Appendix: Pricing Sources and Exchange Rate

| Source                   | URL                                                                       | Accessed     |
| :----------------------- | :------------------------------------------------------------------------ | :----------- |
| AWS EC2 pricing (Mumbai) | https://aws.amazon.com/ec2/pricing/on-demand/                             | October 2026 |
| AWS EBS pricing          | https://aws.amazon.com/ebs/pricing/                                       | October 2026 |
| AWS public IPv4 pricing  | https://aws.amazon.com/vpc/pricing/                                       | October 2026 |
| MongoDB Atlas pricing    | https://www.mongodb.com/pricing                                           | October 2026 |
| Third-party aggregators  | vantage.sh, cloudburn.io, sparecores.com                                  | October 2026 |
| Exchange rate            | 1 USD = 84 INR (assumed mid-market; use live rate for financial planning) | October 2026 |

> All prices are **estimates**. Actual billing may differ based on account discounts, Savings Plans, Free Tier eligibility, and post-assessment price changes. Verify at [calculator.aws](https://calculator.aws) before committing infrastructure spend.
