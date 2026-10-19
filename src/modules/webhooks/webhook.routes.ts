import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { handlePaymongoPayment } from '../appointments/appointments.service.js';
import { handleStagePaymongoPayment } from '../payments/payments.service.js';
import { logger } from '../../utils/logger.js';
import { env } from '../../config/env.js';

const router = Router();

function verifyPaymongoSignature(rawBody: string, signatureHeader: string, secret: string): boolean {
  // PayMongo sends: t=<timestamp>,te=<test_sig>,li=<live_sig>
  const parts = signatureHeader.split(',');
  const timestampPart = parts.find(p => p.startsWith('t='));
  const signatures = parts.filter(p => p.startsWith('te=') || p.startsWith('li='));

  if (!timestampPart || signatures.length === 0) return false;

  const timestamp = timestampPart.replace('t=', '');
  const payload = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  return signatures.some(sig => {
    const value = sig.split('=').slice(1).join('=');
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(value, 'hex'),
    );
  });
}

/**
 * PayMongo Webhook Handler
 * POST /api/v1/webhooks/paymongo
 *
 * PayMongo sends checkout_session.payment.paid events here.
 * This endpoint bypasses CSRF protection (registered before CSRF middleware).
 */
router.post('/paymongo', async (req: Request, res: Response) => {
  try {
    // Verify webhook signature if secret is configured
    const webhookSecret = env.PAYMONGO_WEBHOOK_SECRET;
    if (webhookSecret) {
      const signature = req.headers['paymongo-signature'] as string;
      if (!signature) {
        logger.warn('PayMongo webhook: missing signature header');
        res.status(401).json({ error: 'Missing signature' });
        return;
      }
      const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      if (!verifyPaymongoSignature(rawBody, signature, webhookSecret)) {
        logger.warn('PayMongo webhook: invalid signature');
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }
    }

    const event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    if (!event?.data?.attributes?.type) {
      logger.warn('PayMongo webhook: missing event type');
      res.status(400).json({ error: 'Invalid event' });
      return;
    }

    const eventType = event.data.attributes.type;
    const eventId = event.data.id;
    logger.info(`PayMongo webhook received: ${eventType} (event ${eventId})`);

    if (eventType === 'checkout_session.payment.paid') {
      const checkoutSession = event.data.attributes.data;
      const sessionId = checkoutSession?.id;
      const metadata = checkoutSession?.attributes?.metadata;

      if (!sessionId) {
        logger.warn('PayMongo webhook: no session ID in event');
        res.status(400).json({ error: 'Missing session ID' });
        return;
      }

      logger.info(`PayMongo webhook: processing session ${sessionId}`, { metadata });

      // Try appointment payment first
      const appointment = await handlePaymongoPayment(sessionId);

      if (appointment) {
        logger.info(`PayMongo webhook: ocular fee paid, awaiting cashier verification, for appointment ${appointment._id}`);
      } else {
        // Try project stage payment
        const stagePlan = await handleStagePaymongoPayment(sessionId);
        if (stagePlan) {
          logger.info(`PayMongo webhook: stage payment verified for project ${stagePlan.projectId}`);
        } else {
          logger.info(`PayMongo webhook: no matching appointment or stage for session ${sessionId}`);
        }
      }
    } else {
      logger.info(`PayMongo webhook: unhandled event type '${eventType}'`);
    }

    // Always return 200 to acknowledge receipt
    res.status(200).json({ success: true });
  } catch (error) {
    logger.error('PayMongo webhook error:', error);
    // Still return 200 to prevent retries on our processing errors
    res.status(200).json({ success: true });
  }
});

export default router;
