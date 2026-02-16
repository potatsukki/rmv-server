import http from 'http';
import app from './app.js';
import { env } from './config/env.js';
import { connectDB } from './config/database.js';
import { initializeSocket } from './modules/notifications/socket.service.js';
import { processEmailRetries } from './modules/notifications/email.service.js';
import { seedDefaultConfigs } from './modules/config/config.service.js';
import { logger } from './utils/logger.js';

const server = http.createServer(app);

// ── Initialize Socket.io ──
initializeSocket(server);

// ── Email Retry Processor (every 2 minutes) ──
let emailRetryInterval: NodeJS.Timeout;

async function startServer(): Promise<void> {
  try {
    // Connect to MongoDB
    await connectDB();

    // Seed default configs
    await seedDefaultConfigs();
    logger.info('Default configs seeded');

    // Start email retry processor
    emailRetryInterval = setInterval(async () => {
      try {
        await processEmailRetries();
      } catch (error) {
        logger.error('Email retry processor error:', error);
      }
    }, 2 * 60 * 1000); // every 2 minutes

    // Start HTTP server
    server.listen(env.PORT, () => {
      logger.info(`🚀 Server running on port ${env.PORT} in ${env.NODE_ENV} mode`);
      logger.info(`📡 API prefix: ${env.API_PREFIX}`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// ── Graceful Shutdown ──
function gracefulShutdown(signal: string): void {
  logger.info(`${signal} received. Shutting down gracefully...`);

  // Stop accepting new connections
  server.close(() => {
    logger.info('HTTP server closed');

    // Clear retry interval
    if (emailRetryInterval) {
      clearInterval(emailRetryInterval);
    }

    // Close MongoDB connection
    import('mongoose').then((mongoose) => {
      mongoose.default.connection.close(false).then(() => {
        logger.info('MongoDB connection closed');
        process.exit(0);
      });
    });
  });

  // Force shutdown after 10s
  setTimeout(() => {
    logger.error('Forced shutdown after 10s timeout');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

startServer();
