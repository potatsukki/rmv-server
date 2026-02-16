import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';

import { env } from './config/env.js';
import { apiLimiter } from './middleware/rateLimiter.js';
import { csrfProtection, generateCsrfToken } from './middleware/csrf.js';
import { optionalAuth } from './middleware/auth.js';
import { maintenanceGuard } from './middleware/maintenance.js';
import { errorHandler } from './middleware/errorHandler.js';
import { logger } from './utils/logger.js';

// Route imports
import authRoutes from './modules/auth/auth.routes.js';
import userRoutes from './modules/users/users.routes.js';
import notificationRoutes from './modules/notifications/notification.routes.js';
import appointmentRoutes from './modules/appointments/appointments.routes.js';
import mapRoutes from './modules/maps/maps.routes.js';
import projectRoutes from './modules/projects/projects.routes.js';
import blueprintRoutes from './modules/blueprints/blueprints.routes.js';
import paymentRoutes from './modules/payments/payments.routes.js';
import fabricationRoutes from './modules/fabrication/fabrication.routes.js';
import cashRoutes from './modules/cash/cash.routes.js';
import reportRoutes from './modules/reports/reports.routes.js';
import uploadRoutes from './modules/uploads/upload.routes.js';
import configRoutes from './modules/config/config.routes.js';
import visitReportRoutes from './modules/visit-reports/visit-reports.routes.js';

const app = express();
app.set('trust proxy', 1);

// ── Security Headers ──
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", env.CORS_ORIGIN],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  }),
);

// ── CORS ──
app.use(
  cors({
    origin: env.CORS_ORIGIN.split(',').map((o) => o.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  }),
);

// ── Body Parsing ──
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(cookieParser());

// ── HTTP Logging ──
const morganStream = {
  write: (message: string) => logger.http(message.trim()),
};
app.use(morgan('combined', { stream: morganStream }));

// ── Global Rate Limiter ──
app.use(apiLimiter);

// ── CSRF Token Endpoint (before csrf protection) ──
app.get(`${env.API_PREFIX}/csrf-token`, (req, res) => {
  const token = generateCsrfToken();
  res.cookie('csrfToken', token, {
    httpOnly: false,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    domain: env.COOKIE_DOMAIN,
    path: '/',
  });
  res.json({ success: true, data: { csrfToken: token } });
});

// ── CSRF Protection (state-changing methods) ──
app.use(csrfProtection);
app.use(optionalAuth);

// ── Maintenance Mode Guard ──
app.use(maintenanceGuard);

// ── Health Check ──
app.get(`${env.API_PREFIX}/health`, (_req, res) => {
  res.json({
    success: true,
    data: {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    },
  });
});

// ── API Routes ──
const prefix = env.API_PREFIX;

app.use(`${prefix}/auth`, authRoutes);
app.use(`${prefix}/users`, userRoutes);
app.use(`${prefix}/notifications`, notificationRoutes);
app.use(`${prefix}/appointments`, appointmentRoutes);
app.use(`${prefix}/maps`, mapRoutes);
app.use(`${prefix}/projects`, projectRoutes);
app.use(`${prefix}/blueprints`, blueprintRoutes);
app.use(`${prefix}/payments`, paymentRoutes);
app.use(`${prefix}/fabrication`, fabricationRoutes);
app.use(`${prefix}/cash`, cashRoutes);
app.use(`${prefix}/reports`, reportRoutes);
app.use(`${prefix}/uploads`, uploadRoutes);
app.use(`${prefix}/config`, configRoutes);
app.use(`${prefix}/visit-reports`, visitReportRoutes);

// ── 404 Handler ──
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: 'Route not found' },
  });
});

// ── Global Error Handler ──
app.use(errorHandler);

export default app;
