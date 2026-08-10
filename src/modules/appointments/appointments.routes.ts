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
  reassignAppointmentSalesSchema,
  salesAppointmentDecisionSchema,
  rescheduleRequestSchema,
  rescheduleCompleteSchema,
  cancelAppointmentSchema,
  consultationAttendanceSchema,
  noShowSchema,
  recordOcularFeeSchema,
  submitOcularFeeProofSchema,
  declineOcularFeeSchema,
  availableSlotsQuerySchema,
  appointmentQueueQuerySchema,
  submitSiteDetailsSchema,
  agentCreateOcularSchema,
  submitOcularLocationSchema,
  agentFinalizeOcularSchema,
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

// ── Customer: Submit Site Details ──
router.post(
  '/:id/site-details',
  authenticate,
  authorize(Role.CUSTOMER),
  validate(submitSiteDetailsSchema),
  ctrl.submitSiteDetails,
);

// ── Customer: Skip Site Details (ocular only) ──
router.post(
  '/:id/skip-site-details',
  authenticate,
  authorize(Role.CUSTOMER),
  ctrl.skipSiteDetails,
);

// ── Agent Routes ──
router.post(
  '/agent',
  authenticate,
  authorize(Role.APPOINTMENT_AGENT),
  validate(agentCreateAppointmentSchema),
  ctrl.agentCreateAppointment,
);

// ── Agent: Create Ocular (from consultation context) ──
router.post(
  '/agent-create-ocular',
  authenticate,
  authorize(Role.SALES_STAFF),
  validate(agentCreateOcularSchema),
  ctrl.agentCreateOcular,
);

// ── Customer: Submit Ocular Location ──
router.post(
  '/:id/submit-location',
  authenticate,
  authorize(Role.CUSTOMER),
  validate(submitOcularLocationSchema),
  ctrl.customerSubmitOcularLocation,
);

// ── Agent: Finalize Ocular ──
router.post(
  '/:id/finalize-ocular',
  authenticate,
  authorize(Role.SALES_STAFF),
  validate(agentFinalizeOcularSchema),
  ctrl.agentFinalizeOcular,
);

router.post(
  '/:id/confirm',
  authenticate,
  authorize(Role.APPOINTMENT_AGENT, Role.ADMIN),
  validate(confirmAppointmentSchema),
  ctrl.confirmAppointment,
);

router.post(
  '/:id/reassign-sales',
  authenticate,
  authorize(Role.APPOINTMENT_AGENT, Role.ADMIN, Role.SALES_STAFF),
  validate(reassignAppointmentSalesSchema),
  ctrl.reassignAppointmentSales,
);

router.post(
  '/:id/sales-decision',
  authenticate,
  authorize(Role.SALES_STAFF),
  validate(salesAppointmentDecisionSchema),
  ctrl.reviewAssignedAppointment,
);

router.post(
  '/:id/reschedule-complete',
  authenticate,
  authorize(Role.APPOINTMENT_AGENT),
  validate(rescheduleCompleteSchema),
  ctrl.completeReschedule,
);

router.post(
  '/:id/reschedule-reject',
  authenticate,
  authorize(Role.APPOINTMENT_AGENT, Role.ADMIN),
  ctrl.rejectReschedule,
);

router.post(
  '/:id/complete',
  authenticate,
  authorize(Role.SALES_STAFF),
  ctrl.completeAppointment,
);

router.post(
  '/:id/visit-status/:status',
  authenticate,
  authorize(Role.SALES_STAFF),
  ctrl.updateVisitStatus,
);

router.post(
  '/:id/no-show',
  authenticate,
  authorize(Role.SALES_STAFF),
  validate(noShowSchema),
  ctrl.markNoShow,
);

router.post(
  '/:id/consultation-attendance',
  authenticate,
  authorize(Role.SALES_STAFF, Role.ADMIN),
  validate(consultationAttendanceSchema),
  ctrl.updateConsultationAttendance,
);

router.post(
  '/:id/ocular-fee',
  authenticate,
  authorize(Role.APPOINTMENT_AGENT, Role.SALES_STAFF),
  validate(recordOcularFeeSchema),
  ctrl.recordOcularFee,
);

// ⚠️ TESTING ONLY: Simulate payment without PayMongo. Remove for production.
router.post(
  '/:id/simulate-ocular-payment',
  authenticate,
  authorize(Role.CUSTOMER),
  ctrl.simulateOcularFeePayment,
);
// ⚠️ END TESTING ONLY

// ── Customer: Actively verify ocular fee payment via PayMongo ──
router.post(
  '/:id/ocular-fee-verify-checkout',
  authenticate,
  authorize(Role.CUSTOMER),
  ctrl.verifyOcularFeeCheckout,
);

// ── Customer: Create PayMongo Checkout Session ──
router.post(
  '/:id/ocular-fee-checkout',
  authenticate,
  authorize(Role.CUSTOMER),
  ctrl.createOcularFeeCheckout,
);

// ── Customer: Request Ocular Fee Cash Payment ──
router.post(
  '/:id/request-cash',
  authenticate,
  authorize(Role.CUSTOMER),
  ctrl.requestOcularCashPayment,
);

// ── Customer: Submit Ocular Fee Proof (manual fallback) ──
router.post(
  '/:id/ocular-fee-proof',
  authenticate,
  authorize(Role.CUSTOMER),
  validate(submitOcularFeeProofSchema),
  ctrl.submitOcularFeeProof,
);

// ── Cashier: Verify Ocular Fee ──
router.post(
  '/:id/ocular-fee-verify',
  authenticate,
  authorize(Role.CASHIER, Role.ADMIN),
  ctrl.verifyOcularFee,
);


router.post(
  '/:id/ocular-fee-decline',
  authenticate,
  authorize(Role.CASHIER, Role.ADMIN),
  validate(declineOcularFeeSchema),
  ctrl.declineOcularFee,
);









// ── Cashier: List Pending Ocular Fees ──
router.get(
  '/ocular-fee-queue',
  authenticate,
  authorize(Role.CASHIER, Role.ADMIN),
  ctrl.listPendingOcularFees,
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
  authorize(Role.CUSTOMER, Role.APPOINTMENT_AGENT, Role.SALES_STAFF, Role.CASHIER, Role.ADMIN),
  ctrl.listAppointments,
);

router.get(
  '/queue',
  authenticate,
  authorize(Role.APPOINTMENT_AGENT, Role.SALES_STAFF, Role.ADMIN),
  validate(appointmentQueueQuerySchema, 'query'),
  ctrl.listAppointmentQueue,
);

router.get(
  '/:id',
  authenticate,
  authorize(Role.CUSTOMER, Role.APPOINTMENT_AGENT, Role.SALES_STAFF, Role.CASHIER, Role.ADMIN),
  ctrl.getAppointmentById,
);

export default router;
