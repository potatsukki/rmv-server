# Smoke Tests

## Quick API Smoke

Runs a fast sanity check for critical endpoints and contracts:

1. CSRF token issue
2. Admin login
3. `/auth/me` ID shape (`_id` + `id`)
4. Refresh token endpoint
5. Signed upload URL contract
6. Upload view redirect endpoint
7. Reports pipeline response shape
8. Admin users endpoint

Command:

```bash
npm run smoke:api
```

Optional environment variables:

- `SMOKE_BASE_URL` (default: `http://localhost:5000/api/v1`)
- `SMOKE_ADMIN_EMAIL` (default: `admin@rmvsteelfab.com`)
- `SMOKE_ADMIN_PASSWORD` (default: `Admin@12345`)

Example:

```bash
SMOKE_BASE_URL=http://localhost:5000/api/v1 npm run smoke:api
```

## Full Pipeline Smoke

Runs the long end-to-end workflow script:

```bash
npm run smoke:pipeline
```

This validates the full role handoff flow and is slower than `smoke:api`.
