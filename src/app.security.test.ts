import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from './app.js';
import { env } from './config/env.js';
import { Config, User } from './models/index.js';
import { Role } from './utils/constants.js';
import { logger } from './utils/logger.js';

// Exercise the real Express routes and middleware through HTTP. Only persisted
// configuration/user reads are replaced; this suite never connects to MongoDB.
let server: Server;
let base: string;
const userId = '111111111111111111111111';
const configRead = vi.spyOn(Config, 'findOne');
const userRead = vi.spyOn(User, 'findById');
vi.spyOn(logger, 'http').mockImplementation(() => logger);

function token(roles: Role[] = [Role.CUSTOMER], expiresIn = 60) {
  return jwt.sign({ userId, roles }, env.JWT_ACCESS_SECRET, { expiresIn });
}

function user(roles: Role[] = [Role.CUSTOMER], extra = {}) {
  userRead.mockResolvedValue({
    _id: userId, roles, isActive: true, mustChangePassword: false, ...extra,
  } as never);
}

function request(path: string, init: RequestInit = {}) {
  return fetch(`${base}${env.API_PREFIX}${path}`, init);
}

function mutationHeaders(accessToken?: string) {
  return {
    'Content-Type': 'application/json',
    Cookie: 'csrfToken=local-test-token',
    'X-CSRF-Token': 'local-test-token',
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
}

beforeAll(async () => {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  configRead.mockReset().mockResolvedValue(null);
  userRead.mockReset();
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  vi.restoreAllMocks();
});

describe('API security through real HTTP routes', () => {
  it('responds to health checks and emits security headers', async () => {
    const response = await request('/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { status: 'ok' } });
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('strict-transport-security')).toContain('max-age=31536000');
  });

  it('allows the frontend refresh-token header in CORS preflight', async () => {
    const response = await request('/auth/refresh-token', { method: 'OPTIONS', headers: {
      Origin: env.CORS_ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,x-csrf-token,x-refresh-token',
    } });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(env.CORS_ORIGIN);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('x-refresh-token');
  });

  it('does not grant browser CORS access to an unlisted origin', async () => {
    const response = await request('/health', { headers: { Origin: 'https://untrusted.example.invalid' } });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('issues a CSRF token that matches the response cookie', async () => {
    const response = await request('/csrf-token');
    const body = await response.json();
    expect(body.data.csrfToken).toMatch(/^[a-f0-9]{64}$/);
    expect(response.headers.get('set-cookie')).toContain(`csrfToken=${body.data.csrfToken}`);
  });

  it.each([
    {},
    { Cookie: 'csrfToken=expected', 'X-CSRF-Token': 'wrong' },
  ])('rejects a missing or mismatched CSRF token', async (headers) => {
    const response = await request('/auth/logout', { method: 'POST', headers });
    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toMatch(/CSRF token (missing|mismatch)/);
  });

  it.each(['/users/admin/users', '/appointments', '/projects', '/payments/pending', '/reports/revenue']) (
    'requires authentication for %s', async (path) => {
      const response = await request(path);
      expect(response.status).toBe(401);
      expect((await response.json()).success).toBe(false);
    },
  );

  it.each([
    ['/users/admin/users', Role.CUSTOMER],
    ['/reports/revenue', Role.SALES_STAFF],
    ['/reports/pipeline', Role.CASHIER],
    ['/payments/pending', Role.ENGINEER],
  ] as const)('denies %s to role %s', async (path, role) => {
    user([role]);
    const response = await request(path, { headers: { Authorization: `Bearer ${token([role])}` } });
    expect(response.status).toBe(403);
  });

  it('uses current database roles rather than an old administrator claim', async () => {
    user([Role.CUSTOMER]);
    const response = await request('/users/admin/users', { headers: { Authorization: `Bearer ${token([Role.ADMIN])}` } });
    expect(response.status).toBe(403);
  });

  it.each([
    [{ isActive: false }, 403, 'ACCOUNT_DISABLED'],
    [{ deletedAt: new Date() }, 401, 'TOKEN_INVALID'],
    [{ expiresAt: new Date(0) }, 403, 'ACCOUNT_EXPIRED'],
    [{ mustChangePassword: true }, 403, 'MUST_CHANGE_PASSWORD'],
  ] as const)('rejects restricted accounts %s', async (extra, status, code) => {
    user([Role.CUSTOMER], extra);
    const response = await request('/appointments', { headers: { Authorization: `Bearer ${token()}` } });
    expect(response.status).toBe(status);
    expect((await response.json()).error.code).toBe(code);
  });

  it.each(['invalid', token([Role.CUSTOMER], -1)])('rejects invalid or expired JWTs', async (accessToken) => {
    const response = await request('/appointments', { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(response.status).toBe(401);
    expect(userRead).not.toHaveBeenCalled();
  });

  it('denies project creation to customers before executing its service', async () => {
    user();
    const response = await request('/projects', {
      method: 'POST', headers: mutationHeaders(token()), body: JSON.stringify({}),
    });
    expect(response.status).toBe(403);
  });

  it('validates GCash submission details at the HTTP boundary', async () => {
    user();
    const response = await request('/payments/gcash/submit', {
      method: 'POST', headers: mutationHeaders(token()), body: JSON.stringify({
        bookingId: userId, referenceNumber: '123', amountPaid: -1,
        paymentDate: '2999-01-01T00:00:00Z',
      }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.errors.map((error: { path: string }) => error.path)).toEqual(
      expect.arrayContaining(['referenceNumber', 'amountPaid', 'paymentDate']),
    );
  });

  it('keeps the removed refund API unavailable', async () => {
    const response = await request('/refunds');
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('NOT_FOUND');
  });

  it('rate-limits repeated login attempts', async () => {
    const headers = { ...mutationHeaders(), 'X-Forwarded-For': '192.0.2.11' };
    for (let attempt = 0; attempt < 15; attempt++) {
      const response = await request('/auth/login', { method: 'POST', headers, body: '{}' });
      expect(response.status).toBe(400);
    }
    const response = await request('/auth/login', { method: 'POST', headers, body: '{}' });
    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe('RATE_LIMITED');
  });
});
