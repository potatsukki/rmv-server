import { Router } from 'express';
import * as ctrl from './appointments.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { authorize } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { Role } from '../../utils/constants.js';
import {
  requestAppointmentSchema,
  agentCreateAppointmentSchema,
  confirmAppointmentSchema,
  rescheduleRequestSchema,
  rescheduleCompleteSchema,
  cancelAppointmentSchema,
  noShowSchema,
  recordOcularFeeSchema,
  availableSlotsQuerySchema,
} from './appointments.validation.js';

const router = Router();

// ── Public-ish (authenticated) ──
router.get(
  '/slots',
  authenticate,
  validate(availableSlotsQuerySchema, 'query'),
  ctrl.getAvailableSlots,
);

// ── Customer Routes ──
router.post(
  '/',
  authenticate,
  authorize(Role.CUSTOMER),
  validate(requestAppointmentSchema),
  ctrl.requestAppointment,
);

router.post(
  '/:id/reschedule-request',
  authenticate,
  authorize(Role.CUSTOMER),
  validate(rescheduleRequestSchema),
  ctrl.requestReschedule,
);

// ── Agent Routes ──
router.post(
  '/agent',
  authenticate,
  authorize(Role.APPOINTMENT_AGENT),
  validate(agentCreateAppointmentSchema),
  ctrl.agentCreateAppointment,
);

router.post(
  '/:id/confirm',
  authenticate,
  authorize(Role.APPOINTMENT_AGENT, Role.ADMIN),
  validate(confirmAppointmentSchema),
  ctrl.confirmAppointment,
);

router.post(
  '/:id/reschedule-complete',
  authenticate,
  authorize(Role.APPOINTMENT_AGENT),
  validate(rescheduleCompleteSchema),
  ctrl.completeReschedule,
);

router.post(
  '/:id/complete',
  authenticate,
  authorize(Role.APPOINTMENT_AGENT, Role.SALES_STAFF),
  ctrl.completeAppointment,
);

router.post(
  '/:id/no-show',
  authenticate,
  authorize(Role.APPOINTMENT_AGENT, Role.SALES_STAFF),
  validate(noShowSchema),
  ctrl.markNoShow,
);

router.post(
  '/:id/ocular-fee',
  authenticate,
  authorize(Role.APPOINTMENT_AGENT, Role.SALES_STAFF),
  validate(recordOcularFeeSchema),
  ctrl.recordOcularFee,
);

// ── Cancel (customer or agent/admin) ──
router.post(
  '/:id/cancel',
  authenticate,
  authorize(Role.CUSTOMER, Role.APPOINTMENT_AGENT, Role.ADMIN),
  validate(cancelAppointmentSchema),
  ctrl.cancelAppointment,
);

// ── Read ──
router.get(
  '/',
  authenticate,
  authorize(Role.CUSTOMER, Role.APPOINTMENT_AGENT, Role.SALES_STAFF, Role.ADMIN),
  ctrl.listAppointments,
);

router.get(
  '/:id',
  authenticate,
  authorize(Role.CUSTOMER, Role.APPOINTMENT_AGENT, Role.SALES_STAFF, Role.ADMIN),
  ctrl.getAppointmentById,
);

export default router;
