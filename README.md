# RMV System Handoff Guide

This workspace contains the RMV Stainless Steel Fabrication thesis system. It is split into a React frontend, an Express backend, deployment assets, and operational notes for the VPS.

## Quick Start

Prerequisites:

- Node.js 22 or newer
- npm
- MongoDB Atlas connection string or local MongoDB
- Backend `.env` file in `rmv-server/.env`

Install dependencies:

```bash
cd rmv-server
npm install

cd ../rmv-web
npm install
```

Run the backend:

```bash
cd rmv-server
npm run dev
```

Run the frontend in another terminal:

```bash
cd rmv-web
npm run dev
```

Default local URLs:

| App | URL |
| --- | --- |
| Frontend | `http://localhost:5173` |
| Backend API | `http://localhost:5000/api/v1` |
| Health check | `http://localhost:5000/api/v1/health` |

## Repository Map

```text
RMV_System/
|-- rmv-server/                Backend API, database models, jobs, services
|-- rmv-web/                   React frontend app
|-- nginx/                     Local/root reverse proxy config
|-- ops-tools/                 Helper for running SSH commands on the VPS
|-- images-for-landing-page/   Source marketing and portfolio images
|-- Testing_Reports/           Local test/report artifacts, ignored by git
|-- DEPLOYMENT_GUIDE.md        Production deployment and VPS operations guide
|-- SYSTEM_SPEC.md             Current business-flow source of truth
|-- docker-compose.yml         Root Docker stack
`-- README.md                  This handoff guide
```

## Backend Overview

Backend path: `rmv-server`

Main files:

| File or folder | Purpose |
| --- | --- |
| `src/server.ts` | Starts HTTP server, Socket.IO, MongoDB, config seeding, and scheduled jobs |
| `src/app.ts` | Express app, middleware, health route, CSRF, CORS, and API route mounting |
| `src/config/env.ts` | Environment variable schema and production safety checks |
| `src/config/database.ts` | MongoDB connection |
| `src/models/` | Mongoose models |
| `src/modules/` | Feature modules: auth, appointments, projects, payments, etc. |
| `src/jobs/` | Background jobs for reminders and contract expiry |
| `src/scripts/` | Seed, cleanup, repair, and migration helper scripts |
| `scripts/` | Smoke tests and ops helpers |

Backend scripts:

```bash
npm run dev          # Start development API with tsx watch
npm run build        # TypeScript build and copy static assets
npm run start        # Run compiled dist/server.js
npm run seed         # Seed super admin account
npm run seed:demo    # Seed demo data
npm run test         # Run Vitest tests
npm run typecheck    # Run TypeScript without emitting files
npm run smoke:api    # Basic API smoke test
npm run smoke:phase3 # Focused payment/refund/fabrication smoke test
```

Mounted API areas:

| API prefix | Module |
| --- | --- |
| `/api/v1/auth` | Login, register, OTP, 2FA, password reset, sessions |
| `/api/v1/users` | User and staff management |
| `/api/v1/notifications` | Notifications and Socket.IO support |
| `/api/v1/appointments` | Consultation and ocular appointment lifecycle |
| `/api/v1/maps` | OpenRouteService distance/location helpers |
| `/api/v1/projects` | Project lifecycle, reviews, contracts, payment plan selection |
| `/api/v1/blueprints` | Blueprint and costing uploads, approvals, revisions |
| `/api/v1/payments` | Stage payments, PayMongo, cashier queue |
| `/api/v1/fabrication` | Fabrication progress updates |
| `/api/v1/cash` | Field cash collection and cashier handoff |
| `/api/v1/reports` | Admin/cashier reports |
| `/api/v1/uploads` | File uploads backed by Cloudflare R2 |
| `/api/v1/config` | Admin configuration |
| `/api/v1/visit-reports` | Consultation and ocular reports |
| `/api/v1/services` | Service catalog |
| `/api/v1/webhooks` | External webhooks, currently mounted before CSRF |

## Frontend Overview

Frontend path: `rmv-web`

Main files:

| File or folder | Purpose |
| --- | --- |
| `src/App.tsx` | Route tree and role-based route protection |
| `src/main.tsx` | React entrypoint |
| `src/lib/api.ts` | Axios client, CSRF refresh, token refresh, auth retry logic |
| `src/lib/constants.ts` | Roles, statuses, payment methods, fabrication states |
| `src/stores/` | Zustand stores for auth, theme, notifications, dialogs |
| `src/hooks/` | React Query hooks and shared data access |
| `src/pages/` | Routed pages |
| `src/components/` | Layout, auth, shared, map, and UI components |
| `public/` | Static images, logos, help media, sitemap, robots |

Frontend scripts:

```bash
npm run dev                    # Start Vite dev server
npm run build                  # Typecheck and build production assets
npm run preview                # Preview production build
npm run test                   # Run frontend tests
npm run test:contrast          # Run dark-mode contrast regressions
npm run audit:contrast:browser # Browser-based contrast audit
```

Important routes:

| Route | Purpose |
| --- | --- |
| `/` | Public landing page |
| `/collections` | Public portfolio/collections page |
| `/login`, `/register` | Auth entry points |
| `/dashboard` | Role-aware dashboard |
| `/appointments` | Appointment list and visit-report access |
| `/appointments/book` | Customer consultation booking |
| `/appointments/create-for-customer` | Staff-created appointments |
| `/appointments/:id` | Appointment detail, ocular location, status actions |
| `/projects` | Project list |
| `/projects/:id` | Project detail with blueprint, payment, fabrication tabs |
| `/payments` | Customer payments, cashier queue, ocular fee queue, refunds |
| `/cash` | Sales/cashier cash flow |
| `/reports` | Admin/cashier/engineer reports |
| `/users`, `/employees` | Admin user management |
| `/settings` | Admin configuration |
| `/slot-management` | Admin/appointment-agent slot blocking |
| `/help` | Help center |

## Roles

| Role | Main responsibilities |
| --- | --- |
| `customer` | Book consultation, track appointments/projects, approve designs, sign contract, pay, request refund |
| `appointment_agent` | Review requested consultations, assign sales staff, manage slots |
| `sales_staff` | Run consultation/ocular visits, submit reports, handle ocular cash |
| `engineer` | Review reports, sign engineer contract, upload blueprint/costing |
| `cashier` | Verify payments, receive field cash, process refund queue, view reports |
| `fabrication_staff` | Update fabrication progress |
| `admin` | Full operational oversight and system configuration |

## Business Flow Summary

The current implemented flow is documented in detail in `SYSTEM_SPEC.md`. High-level flow:

1. Customer registers, verifies OTP, completes profile, and logs in.
2. Customer books an office consultation.
3. Appointment agent or admin confirms and assigns sales staff.
4. Sales staff completes consultation and submits consultation report.
5. A project is created or updated from the report.
6. Sales staff creates/finalizes the ocular appointment after the consultation stage.
7. Customer submits site location for ocular fee calculation.
8. Ocular visit is completed and ocular report is submitted.
9. Engineer reviews site data, signs engineer contract, then uploads blueprint/costing.
10. Customer approves blueprint and costing or requests revisions.
11. Customer selects payment plan, signs contract, and pays active stages.
12. Cashier verifies payments.
13. Fabrication progresses through workshop stages.
14. Customer confirms installation when ready for delivery.
15. Fabrication reaches done and project becomes completed.
16. Customer can submit or skip a review.

Important current behavior:

- Customer self-booking is consultation-first. Customers do not directly self-book ocular visits.
- Ocular creation and finalization are sales-staff-owned in the backend.
- Customer site location is required at the ocular stage.
- Manual proof upload for project stage payments is not the active flow.
- PayMongo/QR and cash handling are the current payment paths.

## Environment Variables

Backend env file location:

```text
rmv-server/.env
```

Create one from the example when setting up locally:

```bash
cd rmv-server
cp .env.example .env
```

Required variable names:

```env
NODE_ENV
PORT
API_PREFIX
MONGODB_URI
JWT_ACCESS_SECRET
JWT_REFRESH_SECRET
JWT_ACCESS_EXPIRY
JWT_REFRESH_EXPIRY
COOKIE_DOMAIN
COOKIE_SECURE
COOKIE_SAMESITE
CORS_ORIGIN
EMAIL_PROVIDER
SMTP_HOST
SMTP_PORT
SMTP_USER
SMTP_PASS
SMTP_FROM_EMAIL
SMTP_FROM_NAME
SENDGRID_API_KEY
RESEND_API_KEY
R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET_NAME
R2_PUBLIC_URL
ORS_API_KEY
SUPER_ADMIN_EMAIL
SUPER_ADMIN_PASSWORD
SUPER_ADMIN_FIRST_NAME
SUPER_ADMIN_LAST_NAME
CSRF_SECRET
PAYMONGO_SECRET_KEY
PAYMONGO_WEBHOOK_SECRET
FRONTEND_URL
FEATURE_DIRECT_OCULAR_STAFF_ENABLED
FEATURE_DIRECT_OCULAR_CUSTOMER_ENABLED
FEATURE_DIRECT_OCULAR_STAFF_PILOT_IDS
FEATURE_DIRECT_OCULAR_CUSTOMER_PILOT_IDS
FIREBASE_SERVICE_ACCOUNT_B64
```

Never commit `.env` files. They are ignored by `.gitignore`.

For handoff, transfer the real `.env` through a private channel or password manager, then place it at `rmv-server/.env`. If pulling from the VPS, copy it to the developer machine without committing it:

```bash
scp root@188.166.177.69:/opt/rmv/rmv-server/.env ./rmv-server/.env
```

Production env lives on the VPS at:

```text
/opt/rmv/rmv-server/.env
```

## Firebase Note

The frontend Firebase web config is currently hardcoded in:

```text
rmv-web/src/lib/firebase.ts
```

That config identifies the Firebase project for browser auth. The backend Firebase Admin service account is separate and should be provided through:

```env
FIREBASE_SERVICE_ACCOUNT_B64
```

## Deployment

See `DEPLOYMENT_GUIDE.md` for full production instructions.

Production overview:

- Domain: `rmvfabrication.app`
- VPS IP: `188.166.177.69`
- Backend repo path on VPS: `/opt/rmv/rmv-server`
- Frontend repo path on VPS: `/opt/rmv/rmv-web`
- Reverse proxy: Nginx
- SSL: Let's Encrypt via Certbot
- Containers: API, web, nginx, certbot

Common local SSH helper usage:

```powershell
cd ops-tools
$env:VPS_HOST = "188.166.177.69"
$env:VPS_USER = "root"
$env:VPS_PASSWORD = "YOUR_PASSWORD"

node run-ssh.mjs "docker ps"
node run-ssh.mjs "docker logs rmv-api --tail 50"
```

Common VPS commands:

```bash
docker ps -a
docker logs rmv-api --tail 100
docker logs rmv-nginx --tail 50

cd /opt/rmv/rmv-server/deploy
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml restart api
docker compose -f docker-compose.prod.yml up -d --build
```

## Testing and Quality Checks

Backend:

```bash
cd rmv-server
npm run typecheck
npm run test
npm run smoke:api
```

Frontend:

```bash
cd rmv-web
npm run build
npm run test
npm run test:contrast
```

Run both builds before handoff or demo:

```bash
cd rmv-server && npm run build
cd ../rmv-web && npm run build
```

## Common Development Tasks

Add a new backend feature:

1. Add or update a model in `rmv-server/src/models/` if persistence is needed.
2. Add validation in the target module's `*.validation.ts`.
3. Add service logic in `*.service.ts`.
4. Add controller handlers in `*.controller.ts`.
5. Add route bindings in `*.routes.ts`.
6. Mount a new route group in `src/app.ts` only if it is a new module.
7. Add focused tests for the service or route behavior.

Add a new frontend page:

1. Create the page in `rmv-web/src/pages/`.
2. Add API access through `src/hooks/` or `src/lib/api.ts`.
3. Add route in `src/App.tsx`.
4. Add navigation in `src/components/layout/navigation.ts` if it should appear in menus.
5. Use existing UI components from `src/components/ui/`.

Change a status flow:

1. Check constants in `rmv-web/src/lib/constants.ts`.
2. Check backend enums/models in `rmv-server/src/models/`.
3. Check service guards in the related module.
4. Update `SYSTEM_SPEC.md` if the business flow changes.
5. Add or update tests around blocked and allowed transitions.

## Troubleshooting

Backend fails on startup:

- Check `rmv-server/.env`.
- Confirm `MONGODB_URI` is valid.
- Confirm required production secrets are not default placeholder values.
- Run `npm run typecheck`.

Frontend cannot call API:

- Confirm backend is running on port `5000`.
- Confirm `CORS_ORIGIN=http://localhost:5173` in backend `.env`.
- Confirm requests are going to `/api/v1`.

CSRF errors:

- The frontend fetches `/api/v1/csrf-token`.
- Mutating requests send `X-CSRF-Token`.
- Check `COOKIE_DOMAIN`, `COOKIE_SECURE`, and `COOKIE_SAMESITE`.
- For local development, use `COOKIE_DOMAIN=localhost`, `COOKIE_SECURE=false`, `COOKIE_SAMESITE=lax`.

Emails not sending:

- Check `EMAIL_PROVIDER`.
- For SMTP, check `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM_EMAIL`.
- For SendGrid or Resend, check the matching API key.

Uploads fail:

- Check Cloudflare R2 variables.
- Confirm bucket CORS if uploads or public URLs fail.
- Check `R2_PUBLIC_URL`.

Payments fail:

- Check `PAYMONGO_SECRET_KEY`.
- Check `PAYMONGO_WEBHOOK_SECRET` if webhooks are enabled.
- For sandbox testing, use PayMongo test credentials and test payment methods.

## Files to Read First

For a new groupmate, read in this order:

1. `README.md`
2. `SYSTEM_SPEC.md`
3. `DEPLOYMENT_GUIDE.md`
4. `rmv-server/src/config/env.ts`
5. `rmv-server/src/app.ts`
6. `rmv-web/src/App.tsx`
7. `rmv-web/src/lib/api.ts`
8. `rmv-web/src/lib/constants.ts`

## Handoff Checklist

- `rmv-server/.env` is present locally and not committed.
- Backend installs and runs with `npm run dev`.
- Frontend installs and runs with `npm run dev`.
- Super admin login works.
- Health check returns success.
- At least one customer, sales staff, engineer, cashier, and admin account exists for testing.
- MongoDB Atlas allows the current IP or VPS IP.
- Email provider is working for OTP/password reset.
- R2 upload credentials work if testing photos, contracts, receipts, or blueprints.
- PayMongo sandbox keys work if testing online payments.
- `SYSTEM_SPEC.md` still matches any workflow changes.

## Project Screenshot

![RMV role-based dashboard](https://raw.githubusercontent.com/sean-camara/sean-camara-portfolio/main/public/assets/rmv-screenshot.png)

## Project Context

RMV is an academic capstone modeled on the workflow of a local stainless-steel fabrication business. It is not presented as paid client employment or as a system confirmed to be in daily business use.

## Architecture Summary

The Express and TypeScript API separates controllers, application services, persistence, middleware, jobs, and external integrations. MongoDB stores accounts and workflow records; Firebase, Cloudflare R2, email, PayMongo, and Socket.IO support identity-related services, files, notifications, payments, and real-time updates. Docker, Nginx, health checks, and blue-green scripts support production-style deployment and rollback.

## Testing Strategy

Vitest suites cover authentication policy and tokens, validation, state machines, appointments, projects, reports, fabrication, payments, refunds, reminders, and error handling. API and pipeline smoke scripts cover broader configured flows. Run `npm run typecheck`, `npm run test`, `npm run build`, and the documented smoke commands with isolated test data. No coverage percentage is published; browser-to-provider sandbox testing and failure/recovery exercises remain incomplete.

## Known Limitations

- Live email, storage, payment, and notification verification requires separately configured sandbox services.
- Operational scripts assume the documented VPS/Docker topology.
- The capstone is still being refined and is not claimed to be in daily business use.

## Future Improvements

- Expand integration tests around external-provider failures and retries.
- Add repeatable disaster-recovery exercises and recorded restore evidence.
- Keep API and workflow documentation synchronized with state-machine changes.

## License

No license file is currently included. All rights are reserved unless a license is added later.
