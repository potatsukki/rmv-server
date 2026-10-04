import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Isolated values for imports that validate configuration. No live services
    // are started by the unit suite; database and storage calls are test doubles.
    env: {
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://127.0.0.1:1/rmv_test',
      JWT_ACCESS_SECRET: 'rmv-test-only-access-secret',
      JWT_REFRESH_SECRET: 'rmv-test-only-refresh-secret',
      SMTP_FROM_EMAIL: 'test@example.invalid',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1',
      SMTP_USER: '',
      SMTP_PASS: '',
      EMAIL_PROVIDER: 'smtp',
      CORS_ORIGIN: 'http://localhost:5173',
      COOKIE_DOMAIN: 'localhost',
      COOKIE_SECURE: 'false',
      COOKIE_SAMESITE: 'lax',
      API_PREFIX: '/api/v1',
      FRONTEND_URL: 'http://localhost:5173',
      CSRF_SECRET: 'rmv-test-only-csrf-secret',
      PAYMONGO_SECRET_KEY: '',
      PAYMONGO_WEBHOOK_SECRET: '',
      FIREBASE_SERVICE_ACCOUNT_B64: '',
      R2_ACCOUNT_ID: 'test-only',
      R2_ACCESS_KEY_ID: 'test-only',
      R2_SECRET_ACCESS_KEY: 'test-only',
      R2_BUCKET_NAME: 'rmv-test-only',
    },
  },
});
