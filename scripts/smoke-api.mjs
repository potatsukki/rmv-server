/**
 * Lightweight API smoke test.
 *
 * Usage:
 *   node scripts/smoke-api.mjs
 *
 * Environment variables:
 *   SMOKE_BASE_URL (default: http://localhost:5000/api/v1)
 *   SMOKE_ADMIN_EMAIL (default: admin@rmvsteelfab.com)
 *   SMOKE_ADMIN_PASSWORD (default: Admin@12345)
 */

const BASE_URL = process.env.SMOKE_BASE_URL || 'http://localhost:5000/api/v1';
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL || 'admin@rmvsteelfab.com';
const ADMIN_PASSWORD = process.env.SMOKE_ADMIN_PASSWORD || 'Admin@12345';

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
const INFO = '\x1b[36mINFO\x1b[0m';

class Session {
  constructor() {
    this.cookies = new Map();
  }

  cookieHeader() {
    if (this.cookies.size === 0) return '';
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  applySetCookies(res) {
    const setCookies = res.headers.getSetCookie?.() || [];
    for (const rawCookie of setCookies) {
      const [cookiePart] = rawCookie.split(';');
      const [name, ...valueParts] = cookiePart.split('=');
      if (!name) continue;
      this.cookies.set(name.trim(), valueParts.join('=').trim());
    }
  }

  async request(method, path, { body, redirect = 'follow' } = {}) {
    const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
    const headers = {};
    const cookieHeader = this.cookieHeader();
    if (cookieHeader) headers.Cookie = cookieHeader;

    const upperMethod = method.toUpperCase();
    if (!['GET', 'HEAD'].includes(upperMethod)) {
      headers['Content-Type'] = 'application/json';
      const csrf = this.cookies.get('csrfToken');
      if (csrf) headers['X-CSRF-Token'] = csrf;
    }

    const res = await fetch(url, {
      method: upperMethod,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect,
    });

    this.applySetCookies(res);

    let data = null;
    try {
      data = await res.json();
    } catch {
      // Some endpoints may return redirects/non-JSON.
    }

    return { status: res.status, data, headers: res.headers };
  }
}

function logStep(label, details = '') {
  console.log(`${INFO} ${label}${details ? `: ${details}` : ''}`);
}

function assertCheck(name, condition, details = '') {
  if (condition) {
    console.log(`${PASS} ${name}`);
    return true;
  }
  console.log(`${FAIL} ${name}${details ? `: ${details}` : ''}`);
  return false;
}

async function main() {
  const session = new Session();
  const failures = [];

  logStep('Base URL', BASE_URL);

  const csrfRes = await session.request('GET', '/csrf-token');
  if (
    !assertCheck(
      'CSRF token endpoint',
      csrfRes.status === 200 && !!session.cookies.get('csrfToken'),
      `status=${csrfRes.status}`,
    )
  ) {
    failures.push('csrf-token');
  }

  const loginRes = await session.request('POST', '/auth/login', {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (
    !assertCheck(
      'Admin login',
      loginRes.status === 200 && !!session.cookies.get('accessToken'),
      `status=${loginRes.status}`,
    )
  ) {
    failures.push('login');
  }

  const meRes = await session.request('GET', '/auth/me');
  if (
    !assertCheck(
      'Auth me shape',
      meRes.status === 200 && !!meRes.data?.data?._id && !!meRes.data?.data?.id,
      `status=${meRes.status}`,
    )
  ) {
    failures.push('auth-me');
  }

  const refreshRes = await session.request('POST', '/auth/refresh-token');
  if (!assertCheck('Refresh token endpoint', refreshRes.status === 200, `status=${refreshRes.status}`)) {
    failures.push('refresh-token');
  }

  const uploadRes = await session.request('POST', '/uploads/signed-upload-url', {
    body: {
      folder: 'smoke-check',
      filename: 'sample.jpg',
      contentType: 'image/jpeg',
    },
  });
  const uploadKey = uploadRes.data?.data?.key;
  if (
    !assertCheck(
      'Signed upload URL contract',
      uploadRes.status === 200 &&
        typeof uploadRes.data?.data?.uploadUrl === 'string' &&
        typeof uploadKey === 'string',
      `status=${uploadRes.status}`,
    )
  ) {
    failures.push('signed-upload-url');
  }

  if (uploadKey) {
    const viewRes = await session.request(
      'GET',
      `/uploads/view?key=${encodeURIComponent(uploadKey)}`,
      { redirect: 'manual' },
    );
    if (
      !assertCheck(
        'Upload view endpoint redirect',
        [301, 302, 303, 307, 308].includes(viewRes.status),
        `status=${viewRes.status}`,
      )
    ) {
      failures.push('upload-view');
    }
  }

  const reportsRes = await session.request('GET', '/reports/pipeline');
  if (
    !assertCheck(
      'Reports pipeline endpoint',
      reportsRes.status === 200 && Array.isArray(reportsRes.data?.data?.byStatus),
      `status=${reportsRes.status}`,
    )
  ) {
    failures.push('reports-pipeline');
  }

  const usersRes = await session.request('GET', '/users/admin/users?limit=1');
  if (!assertCheck('Admin users endpoint', usersRes.status === 200, `status=${usersRes.status}`)) {
    failures.push('admin-users');
  }

  console.log('');
  if (failures.length > 0) {
    console.log(`${FAIL} Smoke test failed (${failures.length}): ${failures.join(', ')}`);
    process.exit(1);
  }

  console.log(`${PASS} Smoke test passed`);
}

main().catch((error) => {
  console.error(`${FAIL} Unhandled error`, error);
  process.exit(1);
});
