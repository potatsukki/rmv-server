import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'off', ''].includes(normalized)) {
      return false;
    }
  }

  return value;
}, z.boolean());

function normalizeCookieDomain(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();

  if (!normalized || normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1') {
    return undefined;
  }

  return value.trim();
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(5000),
  API_PREFIX: z.string().default('/api/v1'),

  // MongoDB
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),

  // JWT
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_EXPIRY: z.string().default('15m'),
  JWT_REFRESH_EXPIRY: z.string().default('7d'),

  // Cookies
  COOKIE_DOMAIN: z.string().default('localhost'),
  COOKIE_SECURE: booleanFromEnv.default(false),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

  // CORS
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  // Mail provider
  EMAIL_PROVIDER: z.enum(['smtp', 'sendgrid_api', 'resend_api']).default('smtp'),

  // SMTP
  SMTP_HOST: z.string().default('smtp.gmail.com'),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  SMTP_FROM_EMAIL: z.string().email(),
  SMTP_FROM_NAME: z.string().default('RMV Stainless Steel'),
  SENDGRID_API_KEY: z.string().default(''),
  RESEND_API_KEY: z.string().default(''),

  // R2 (optional in dev)
  R2_ACCOUNT_ID: z.string().default('placeholder'),
  R2_ACCESS_KEY_ID: z.string().default('placeholder'),
  R2_SECRET_ACCESS_KEY: z.string().default('placeholder'),
  R2_BUCKET_NAME: z.string().default('rmv-uploads'),
  R2_PUBLIC_URL: z.string().optional(),

  // OpenRouteService (free alternative to Google Maps)
  ORS_API_KEY: z.string().default('placeholder'),

  // Super Admin Seed
  SUPER_ADMIN_EMAIL: z.string().email().default('admin@rmvsteelfab.com'),
  SUPER_ADMIN_PASSWORD: z.string().min(8).default('Admin@12345'),
  SUPER_ADMIN_FIRST_NAME: z.string().default('Super'),
  SUPER_ADMIN_LAST_NAME: z.string().default('Admin'),

  // CSRF
  CSRF_SECRET: z.string().min(16).default('change-me-csrf-secret-32chars!!'),

  // PayMongo
  PAYMONGO_SECRET_KEY: z.string().default(''),
  PAYMONGO_WEBHOOK_SECRET: z.string().default(''),

  // Frontend URL (for redirect URLs)
  FRONTEND_URL: z.string().default('http://localhost:5173'),

  // Feature flags: direct ocular booking flows
  FEATURE_DIRECT_OCULAR_STAFF_ENABLED: booleanFromEnv.default(false),
  FEATURE_DIRECT_OCULAR_CUSTOMER_ENABLED: booleanFromEnv.default(false),
  FEATURE_DIRECT_OCULAR_STAFF_PILOT_IDS: z.string().default(''),
  FEATURE_DIRECT_OCULAR_CUSTOMER_PILOT_IDS: z.string().default(''),

  // Firebase (base64-encoded service account JSON)
  FIREBASE_SERVICE_ACCOUNT_B64: z.string().default(''),
});

const parsed = envSchema.safeParse(process.env);
let envData: z.infer<typeof envSchema>;

if (!parsed.success) {
  if (process.env.NODE_ENV === 'test') {
    const fallback = {
      NODE_ENV: 'test',
      PORT: 5000,
      API_PREFIX: '/api/v1',
      MONGODB_URI: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/rmv-test',
      JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET || 'test-access-secret-123456',
      JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-123456',
      SMTP_FROM_EMAIL: process.env.SMTP_FROM_EMAIL || 'test@example.com',
    } as const;

    envData = envSchema.parse(fallback);
  } else {
    console.error('Invalid environment variables:');
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
} else {
  envData = parsed.data;
}

const resolvedCookieDomain = normalizeCookieDomain(envData.COOKIE_DOMAIN);

if (envData.NODE_ENV === 'production') {
  const prodConfigErrors: string[] = [];

  if (envData.CSRF_SECRET === 'change-me-csrf-secret-32chars!!') {
    prodConfigErrors.push('CSRF_SECRET must be overridden in production');
  }

  if (envData.SUPER_ADMIN_PASSWORD === 'Admin@12345') {
    prodConfigErrors.push('SUPER_ADMIN_PASSWORD must be overridden in production');
  }

  if (!envData.COOKIE_SECURE) {
    prodConfigErrors.push('COOKIE_SECURE must be true in production');
  }

  if (!resolvedCookieDomain) {
    prodConfigErrors.push('COOKIE_DOMAIN cannot be localhost in production');
  }

  if (envData.EMAIL_PROVIDER === 'smtp') {
    if (!envData.SMTP_USER) {
      prodConfigErrors.push('SMTP_USER is required when EMAIL_PROVIDER=smtp');
    }

    if (!envData.SMTP_PASS) {
      prodConfigErrors.push('SMTP_PASS is required when EMAIL_PROVIDER=smtp');
    }
  }

  if (envData.EMAIL_PROVIDER === 'sendgrid_api' && !envData.SENDGRID_API_KEY) {
    prodConfigErrors.push('SENDGRID_API_KEY is required when EMAIL_PROVIDER=sendgrid_api');
  }

  if (envData.EMAIL_PROVIDER === 'resend_api' && !envData.RESEND_API_KEY) {
    prodConfigErrors.push('RESEND_API_KEY is required when EMAIL_PROVIDER=resend_api');
  }

  if (prodConfigErrors.length > 0) {
    console.error('Invalid production environment variables:');
    for (const message of prodConfigErrors) {
      console.error(`- ${message}`);
    }
    process.exit(1);
  }
}

export const env = {
  ...envData,
  COOKIE_DOMAIN: resolvedCookieDomain,
};
