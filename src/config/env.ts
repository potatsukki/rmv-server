import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

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
  COOKIE_SECURE: z.coerce.boolean().default(false),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

  // CORS
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  // SMTP (Google)
  SMTP_HOST: z.string().default('smtp.gmail.com'),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().min(1),
  SMTP_PASS: z.string().min(1),
  SMTP_FROM_EMAIL: z.string().email(),
  SMTP_FROM_NAME: z.string().default('RMV Stainless Steel'),

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
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const envData = parsed.data;

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

  if (envData.COOKIE_DOMAIN === 'localhost') {
    prodConfigErrors.push('COOKIE_DOMAIN cannot be localhost in production');
  }

  if (prodConfigErrors.length > 0) {
    console.error('Invalid production environment variables:');
    for (const message of prodConfigErrors) {
      console.error(`- ${message}`);
    }
    process.exit(1);
  }
}

export const env = envData;
