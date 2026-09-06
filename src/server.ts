import http from 'http';
import app from './app.js';
import { env } from './config/env.js';
import { connectDB } from './config/database.js';
import { initializeSocket } from './modules/notifications/socket.service.js';
import { processEmailRetries } from './modules/notifications/email.service.js';
import { processPaymentReminders } from './jobs/paymentReminders.js';
import { processContractExpiries } from './jobs/contractExpiry.js';
import { processAvailabilityShiftReminders } from './jobs/availabilityShiftReminders.js';
import { processAutomatedConsultationAttendance } from './modules/appointments/consultation-attendance-automation.js';
import { seedDefaultConfigs } from './modules/config/config.service.js';
import { logger } from './utils/logger.js';

const server = http.createServer(app);

// ── Initialize Socket.io ──
initializeSocket(server);

// ── Email Retry Processor (every 2 minutes) ──
let emailRetryInterval: NodeJS.Timeout;
// ── Payment Reminder Processor (every hour) ──
let paymentReminderInterval: NodeJS.Timeout;
// ── Contract Expiry Processor (every 12 hours) ──
let contractExpiryInterval: NodeJS.Timeout;
// ── Availability Shift Reminder Processor (every 15 minutes) ──
let availabilityReminderInterval: NodeJS.Timeout;
// ── Consultation attendance automation (every minute) ──
let consultationAttendanceInterval: NodeJS.Timeout;

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

    // Start payment reminder processor
    paymentReminderInterval = setInterval(async () => {
      try {
        await processPaymentReminders();
      } catch (error) {
        logger.error('Payment reminder processor error:', error);
      }
    }, 60 * 60 * 1000); // every hour

    // Start contract expiry processor
    contractExpiryInterval = setInterval(async () => {
      try {
        await processContractExpiries();
      } catch (error) {
        logger.error('Contract expiry processor error:', error);
      }
    }, 12 * 60 * 60 * 1000); // every 12 hours

    availabilityReminderInterval = setInterval(async () => {
      try {
        await processAvailabilityShiftReminders();
      } catch (error) {
        logger.error('Availability reminder processor error:', error);
      }
    }, 15 * 60 * 1000); // every 15 minutes

    consultationAttendanceInterval = setInterval(async () => {
      try {
        await processAutomatedConsultationAttendance(
          new Date(),
          (message, error) => logger.error(message, error),
        );
      } catch (error) {
        logger.error('Consultation attendance automation error:', error);
      }
    }, 60 * 1000); // every minute

    // Run contract check once on startup
    processContractExpiries().catch(err =>
      logger.error('Initial contract expiry check failed:', err)
    );
    processAvailabilityShiftReminders().catch(err =>
      logger.error('Initial availability reminder check failed:', err)
    );
    processAutomatedConsultationAttendance(
      new Date(),
      (message, error) => logger.error(message, error),
    ).catch(err =>
      logger.error('Initial consultation attendance automation failed:', err)
    );

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
    if (paymentReminderInterval) {
      clearInterval(paymentReminderInterval);
    }
    if (contractExpiryInterval) {
      clearInterval(contractExpiryInterval);
    }
    if (availabilityReminderInterval) {
      clearInterval(availabilityReminderInterval);
    }
    if (consultationAttendanceInterval) {
      clearInterval(consultationAttendanceInterval);
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
