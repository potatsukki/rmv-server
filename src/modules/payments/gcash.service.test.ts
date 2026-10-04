import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  appointment: vi.fn(), plan: vi.fn(), project: vi.fn(), paymentById: vi.fn(), create: vi.fn(),
  audit: vi.fn(), config: vi.fn(), image: vi.fn(), lockFind: vi.fn(), lockCreate: vi.fn(),
  ready: vi.fn(), receipt: vi.fn(), exists: vi.fn(), find: vi.fn(), transaction: vi.fn(), session: { id: 'test-session' },
}));
vi.mock('mongoose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mongoose')>();
  return { ...actual, default: { ...actual.default, connection: { transaction: db.transaction } } };
});
vi.mock('../../models/index.js', () => ({
  Appointment: { findById: db.appointment }, PaymentPlan: { findOne: db.plan }, Project: { findById: db.project },
  Payment: { findById: db.paymentById, create: db.create, exists: db.exists, find: db.find, init: vi.fn() }, AuditLog: { create: db.audit },
  SlotLock: { findOne: db.lockFind, create: db.lockCreate },
}));
vi.mock('../config/config.service.js', () => ({ getConfigValue: db.config }));
vi.mock('../uploads/upload.service.js', () => ({ validatePaymentImage: db.image }));
vi.mock('../appointments/appointments.service.js', () => ({ assertBookingReadyForGcashApproval: db.ready, completePaidOcularBooking: vi.fn() }));
vi.mock('./payments.service.js', () => ({ handleInitialFabricationPaymentVerified: vi.fn(), issueGcashReceipt: db.receipt }));
vi.mock('../notifications/socket.service.js', () => ({ createAndSendNotification: vi.fn(), notifyRole: vi.fn(), emitRoleEvent: vi.fn(), emitUserEvent: vi.fn() }));

import { resolveGcashTarget, submitGcash, reviewGcash, getGcashContext } from './gcash.service.js';
import { gcashTargetSchema, submitGcashSchema } from './gcash.validation.js';
import { Role, PaymentMethod, PaymentStageStatus, AppointmentStatus } from '../../utils/constants.js';
import { authorize } from '../../middleware/rbac.js';

const customerId = '111111111111111111111111';
const bookingId = '222222222222222222222222';
const cashierId = '333333333333333333333333';
const paymentId = '444444444444444444444444';
const query = (value: unknown) => ({ session: vi.fn().mockResolvedValue(value) });
function booking(overrides = {}) {
  return { _id: bookingId, customerId, type: 'ocular', status: AppointmentStatus.REQUESTED, ocularFee: 1250,
    ocularFeePaid: false, ocularFeeStatus: 'pending', appointmentNumber: 'RMV-APPT-101',
    salesStaffId: cashierId, customerLocation: { lat: 14.7, lng: 121 }, date: '2026-12-01', slotCode: '09:00',
    save: vi.fn().mockResolvedValue(undefined), $session: vi.fn(), ...overrides };
}
function payment(overrides = {}) {
  return { _id: paymentId, bookingId, customerId, method: PaymentMethod.GCASH, amountPaid: 1250,
    amountRequired: 1250, stageId: `ocular-${bookingId}`, paymentStatus: 'pending_verification',
    status: PaymentStageStatus.PROOF_SUBMITTED, referenceNumber: '1234567890123', gcashReferenceNumber: '1234567890123',
    activeSubmissionKey: `booking:${bookingId}`, proofKey: `payment-proofs/${customerId}/proof.png`,
    evidenceTrail: [{ version: 1, source: 'customer_gcash_submission' }],
    save: vi.fn().mockResolvedValue(undefined), $session: vi.fn(), ...overrides };
}
const submission = { bookingId, referenceNumber: '1234567890123', amountPaid: 1250, paymentDate: '2026-01-02T02:00:00.000Z' };

beforeEach(() => {
  vi.resetAllMocks();
  db.transaction.mockImplementation(async (callback) => callback(db.session));
  db.config.mockResolvedValue({ accountName: 'RMV', accountNumber: '09123456789' });
  db.create.mockImplementation(async ([input]) => [{ _id: paymentId, ...input }]);
  db.lockFind.mockReturnValue(query(null));
  db.image.mockResolvedValue(true);
  db.exists.mockReturnValue(query(null));
  const historyQuery = { populate: vi.fn(), sort: vi.fn().mockResolvedValue([]) };
  historyQuery.populate.mockReturnValue(historyQuery);
  db.find.mockReturnValue(historyQuery);
});

describe('GCash request validation', () => {
  it('requires exactly one booking or stage and required submission details', () => {
    expect(gcashTargetSchema.safeParse({}).success).toBe(false);
    expect(gcashTargetSchema.safeParse({ bookingId, stageId: 'stage-1' }).success).toBe(false);
    expect(submitGcashSchema.safeParse(submission).success).toBe(true);
    expect(submitGcashSchema.safeParse({ ...submission, referenceNumber: '' }).success).toBe(false);
    expect(submitGcashSchema.safeParse({ ...submission, paymentDate: '' }).success).toBe(false);
    expect(submitGcashSchema.safeParse({ ...submission, amountPaid: 12.345 }).success).toBe(false);
    expect(submitGcashSchema.safeParse({ ...submission, paymentDate: '2999-01-01T00:00:00Z' }).success).toBe(false);
  });
  it('removes client-supplied payment status and amount required', () => {
    expect(submitGcashSchema.parse({ ...submission, paymentStatus: 'paid', amountRequired: 1 })).toEqual(submission);
  });
});

describe('GCash ownership and submission', () => {
  it('shows pending_payment separately from a logistics appointment that was already scheduled', async () => {
    db.appointment.mockReturnValue(query(booking({ status: AppointmentStatus.CONFIRMED, bookingStatus: 'pending_payment', ocularFeeStatus: 'proof_submitted' })));
    const context = await getGcashContext({ bookingId }, customerId);
    expect(context.paymentStatus).toBe('pending_verification'); expect(context.bookingStatus).toBe('pending_payment');
  });
  it('keeps payment history readable after the booking is completed', async () => {
    db.appointment.mockReturnValue(query(booking({ status: AppointmentStatus.COMPLETED, bookingStatus: 'confirmed', ocularFeePaid: true })));
    const context = await getGcashContext({ bookingId }, customerId);
    expect(context.paymentStatus).toBe('paid'); expect(context.bookingStatus).toBe('confirmed');
  });
  it('rejects another customer before recording any payment', async () => {
    db.appointment.mockReturnValue(query(booking({ customerId: cashierId })));
    await expect(submitGcash(submission, customerId)).rejects.toThrow('own booking');
    expect(db.create).not.toHaveBeenCalled();
  });
  it('requires official payment information', async () => {
    db.config.mockResolvedValue({ accountName: '', accountNumber: '', qrCodeKey: '' });
    await expect(submitGcash(submission, customerId)).rejects.toThrow('not been configured');
  });
  it('records an optional-proof submission as pending, using the backend fee', async () => {
    const appointment = booking(); db.appointment.mockReturnValue(query(appointment));
    const result = await submitGcash({ ...submission, amountPaid: 100 }, customerId);
    expect(result).toMatchObject({ amountRequired: 1250, amountPaid: 100, paymentStatus: 'pending_verification', status: 'proof_submitted' });
    expect(appointment).toMatchObject({ ocularFeePaid: false, paymentStatus: 'pending_verification', bookingStatus: 'pending_payment', status: 'requested' });
    expect(appointment.save).toHaveBeenCalledWith({ session: db.session });
    expect(db.receipt).not.toHaveBeenCalled();
  });
  it('blocks repeat pending submissions', async () => {
    db.appointment.mockReturnValue(query(booking({ ocularFeeStatus: 'proof_submitted' })));
    await expect(submitGcash(submission, customerId)).rejects.toThrow('already awaiting verification');
    expect(db.create).not.toHaveBeenCalled();
  });
  it('rejects a proof owned by another user and invalid image metadata', async () => {
    await expect(submitGcash({ ...submission, proofKey: `payment-proofs/${cashierId}/proof.png` }, customerId)).rejects.toThrow('own payment screenshot');
    db.image.mockResolvedValue(false);
    await expect(submitGcash({ ...submission, proofKey: `payment-proofs/${customerId}/proof.png` }, customerId)).rejects.toThrow('valid payment screenshot');
    expect(db.create).not.toHaveBeenCalled();
  });
  it('reports duplicate unique reference or active submission conflicts', async () => {
    db.appointment.mockReturnValue(query(booking())); db.create.mockRejectedValue({ code: 11000 });
    await expect(submitGcash(submission, customerId)).rejects.toThrow('reference has already been submitted');
  });
  it('rejects a used reference with the exact message and retains the flagged attempt', async () => {
    let committed = false;
    db.transaction.mockImplementation(async (callback) => { const result = await callback(db.session); committed = true; return result; });
    const appointment = booking(); db.appointment.mockReturnValue(query(appointment));
    db.exists.mockReturnValue(query({ _id: paymentId }));
    await expect(submitGcash(submission, customerId)).rejects.toThrow('This GCash reference number has already been used. Please check your payment details.');
    expect(db.create.mock.calls[0]?.[0]?.[0]).toMatchObject({ paymentStatus: 'rejected', status: 'declined',
      duplicateReference: true, rejectionReason: 'Duplicate reference number', rejectedAt: expect.any(Date), referenceNumber: submission.referenceNumber });
    expect(db.create.mock.calls[0]?.[0]?.[0].activeSubmissionKey).toBeUndefined();
    expect(appointment).toMatchObject({ ocularFeePaid: false, paymentStatus: 'rejected', bookingStatus: 'pending_payment' });
    expect(db.receipt).not.toHaveBeenCalled();
    expect(db.audit).toHaveBeenCalledOnce();
    expect(committed).toBe(true);
    expect(db.create.mock.calls[0]?.[0]?.[0].verifiedBy).toBeUndefined();
  });
  it('calculates a project balance from stage payments and credit', async () => {
    db.plan.mockReturnValue(query({ projectId: bookingId, stages: [{ stageId: 'stage-1', amount: 5000, amountPaid: 1000, creditApplied: 250 }] }));
    db.project.mockReturnValue(query({ _id: bookingId, customerId, status: 'payment_pending' }));
    const target = await resolveGcashTarget({ stageId: 'stage-1' }, customerId);
    expect(target.amount).toBe(3750);
  });
  it('also detects references in rejected attempts for the same customer and booking', async () => {
    db.appointment.mockReturnValue(query(booking({ ocularFeeStatus: 'declined' })));
    db.exists.mockReturnValue(query({ _id: paymentId }));
    await expect(submitGcash(submission, customerId)).rejects.toThrow('This GCash reference number has already been used. Please check your payment details.');
    expect(db.exists).toHaveBeenCalledWith({ method: 'gcash', $or: [
      { referenceNumber: submission.referenceNumber }, { gcashReferenceNumber: submission.referenceNumber },
    ] });
    expect(db.create.mock.calls[0]?.[0]?.[0].paymentStatus).toBe('rejected');
  });
  it('persists a rejected duplicate when a concurrent submission wins the reference index', async () => {
    const appointment = booking(); db.appointment.mockReturnValue(query(appointment));
    db.create.mockRejectedValueOnce({ code: 11000, keyPattern: { gcashReferenceNumber: 1 } });
    await expect(submitGcash(submission, customerId)).rejects.toThrow('This GCash reference number has already been used. Please check your payment details.');
    expect(db.transaction).toHaveBeenCalledTimes(2);
    expect(db.create.mock.calls[1]?.[0]?.[0]).toMatchObject({ paymentStatus: 'rejected', duplicateReference: true, rejectedBy: null, rejectionSource: 'system' });
    expect(db.create.mock.calls[1]?.[0]?.[0].gcashReferenceNumber).toBeUndefined();
    expect(appointment).toMatchObject({ ocularFeePaid: false, bookingStatus: 'pending_payment' });
  });
  it('detects a concurrent reference even when the active submission index conflicts first', async () => {
    db.appointment.mockReturnValue(query(booking()));
    db.exists.mockReturnValueOnce(query(null)).mockReturnValue(query({ _id: paymentId }));
    db.create.mockRejectedValueOnce({ code: 11000, keyPattern: { activeSubmissionKey: 1 } });
    await expect(submitGcash(submission, customerId)).rejects.toThrow('This GCash reference number has already been used. Please check your payment details.');
    expect(db.create.mock.calls[1]?.[0]?.[0].paymentStatus).toBe('rejected');
  });
  it('retains the original pending submission when flagging another duplicate attempt', async () => {
    const appointment = booking({ ocularFeeStatus: 'proof_submitted', paymentStatus: 'pending_verification' });
    db.appointment.mockReturnValue(query(appointment)); db.exists.mockReturnValue(query({ _id: paymentId }));
    await expect(submitGcash(submission, customerId)).rejects.toThrow('This GCash reference number has already been used. Please check your payment details.');
    expect(appointment).toMatchObject({ ocularFeeStatus: 'proof_submitted', paymentStatus: 'pending_verification', bookingStatus: 'pending_payment', ocularFeePaid: false });
    expect(db.create.mock.calls[0]?.[0]?.[0].paymentStatus).toBe('rejected');
  });
  it('rejects duplicate project stage attempts without changing the paid amount', async () => {
    const stage = { stageId: 'stage-1', amount: 1250, amountPaid: 0, creditApplied: 0, status: PaymentStageStatus.PENDING };
    const plan = { projectId: bookingId, stages: [stage], save: vi.fn() };
    db.plan.mockReturnValue(query(plan)); db.project.mockReturnValue(query({ _id: bookingId, customerId, status: 'payment_pending' }));
    db.exists.mockReturnValue(query({ _id: paymentId }));
    const { bookingId: _bookingId, ...details } = submission;
    await expect(submitGcash({ ...details, stageId: 'stage-1' }, customerId)).rejects.toThrow('This GCash reference number has already been used. Please check your payment details.');
    expect(stage).toMatchObject({ status: 'declined', amountPaid: 0 });
    expect(plan.save).toHaveBeenCalledWith({ session: db.session });
    expect(db.create.mock.calls[0]?.[0]?.[0]).toMatchObject({ paymentStatus: 'rejected', duplicateReference: true, stageId: 'stage-1' });
  });
});

describe('GCash cashier decisions', () => {
  it.each([[Role.CUSTOMER], [Role.ADMIN], [Role.SALES_STAFF]])('denies non-cashier role %s', async (...roles) => {
    await expect(reviewGcash(paymentId, cashierId, roles as Role[], 'paid')).rejects.toThrow('Only a cashier');
    expect(db.transaction).not.toHaveBeenCalled();
  });
  it('rejects whitespace reasons', async () => {
    await expect(reviewGcash(paymentId, cashierId, [Role.CASHIER], 'rejected', '   ')).rejects.toThrow('reason is required');
  });
  it('refuses approval of an incorrect amount without marking the booking paid', async () => {
    const attempt = payment({ amountPaid: 100 }); const appointment = booking({ ocularFeeStatus: 'proof_submitted' });
    db.paymentById.mockReturnValue(query(attempt)); db.appointment.mockReturnValue(query(appointment));
    await expect(reviewGcash(paymentId, cashierId, [Role.CASHIER], 'paid')).rejects.toThrow('must match');
    expect(appointment.ocularFeePaid).toBe(false); expect(attempt.save).not.toHaveBeenCalled();
  });
  it('approves payment and confirms booking together with cashier identity', async () => {
    const attempt = payment(); const appointment = booking({ ocularFeeStatus: 'proof_submitted' });
    db.paymentById.mockReturnValue(query(attempt)); db.appointment.mockReturnValue(query(appointment));
    const result = await reviewGcash(paymentId, cashierId, [Role.CASHIER], 'paid', undefined, 'signature.png');
    expect(result.paymentStatus).toBe('paid'); expect(result.verifiedBy?.toString()).toBe(cashierId); expect(result.verifiedAt).toBeInstanceOf(Date);
    expect(appointment).toMatchObject({ ocularFeePaid: true, paymentStatus: 'paid', bookingStatus: 'confirmed', status: 'confirmed' });
    expect(attempt.save).toHaveBeenCalledWith({ session: db.session }); expect(appointment.save).toHaveBeenCalledWith({ session: db.session });
    expect(db.lockCreate).toHaveBeenCalledOnce(); expect(db.receipt).toHaveBeenCalledWith(attempt);
    expect(attempt.$session).toHaveBeenCalledWith(null);
  });
  it('records cash as paid only when the cashier explicitly receives it', async () => {
    const attempt = payment({ method: PaymentMethod.CASH, paymentStatus: 'unpaid', amountPaid: 0 });
    const appointment = booking({ ocularFeeStatus: 'cash_pending', ocularFeePaymentMethod: PaymentMethod.CASH });
    db.paymentById.mockReturnValue(query(attempt)); db.appointment.mockReturnValue(query(appointment));
    await reviewGcash(paymentId, cashierId, [Role.CASHIER], 'paid', undefined, undefined, true);
    expect(attempt.amountPaid).toBe(1250); expect(attempt.paymentStatus).toBe('paid'); expect(attempt.method).toBe('cash');
    expect(appointment.ocularFeePaid).toBe(true);
  });
  it('does not turn a cash selection into paid through the GCash review API', async () => {
    db.paymentById.mockReturnValue(query(payment({ method: PaymentMethod.CASH, paymentStatus: 'unpaid', amountPaid: 0 })));
    await expect(reviewGcash(paymentId, cashierId, [Role.CASHIER], 'paid')).rejects.toThrow('Payment not found');
    expect(db.receipt).not.toHaveBeenCalled();
  });
  it('keeps project amounts unpaid until approval, then advances the paid stage', async () => {
    const attempt = payment({ bookingId: undefined, projectId: bookingId, stageId: 'stage-1' });
    const stage = { stageId: 'stage-1', amount: 1250, amountPaid: 0, creditApplied: 0, status: PaymentStageStatus.PROOF_SUBMITTED, remainingBalance: 1250 };
    const plan = { projectId: bookingId, stages: [stage], isImmutable: false, save: vi.fn() };
    db.paymentById.mockReturnValue(query(attempt));
    db.plan.mockReturnValue(query(plan)); db.project.mockReturnValue(query({ _id: bookingId, customerId, status: 'payment_pending' }));
    await reviewGcash(paymentId, cashierId, [Role.CASHIER], 'paid');
    expect(stage).toMatchObject({ status: 'verified', amountPaid: 1250, remainingBalance: 0 });
    expect(plan.isImmutable).toBe(true); expect(plan.save).toHaveBeenCalledWith({ session: db.session });
  });
  it('retains rejected evidence and permits a corrected new attempt', async () => {
    const attempt = payment(); const appointment = booking({ ocularFeeStatus: 'proof_submitted' });
    db.paymentById.mockReturnValue(query(attempt)); db.appointment.mockReturnValue(query(appointment));
    await reviewGcash(paymentId, cashierId, [Role.CASHIER], 'rejected', ' Payment not found ');
    expect(attempt).toMatchObject({ paymentStatus: 'rejected', rejectionReason: 'Payment not found', declineReason: 'Payment not found', referenceNumber: '1234567890123', proofKey: `payment-proofs/${customerId}/proof.png` });
    expect(attempt.rejectedBy?.toString()).toBe(cashierId); expect(attempt.rejectedAt).toBeInstanceOf(Date);
    expect(attempt.evidenceTrail).toHaveLength(2); expect(appointment.ocularFeePaid).toBe(false);
    expect(attempt.gcashReferenceNumber).toBe(submission.referenceNumber); expect(attempt.activeSubmissionKey).toBeUndefined();
    expect(appointment).toMatchObject({ paymentStatus: 'rejected', bookingStatus: 'pending_payment' });
    const corrected = await submitGcash({ ...submission, referenceNumber: '9876543210123' }, customerId);
    expect(corrected.paymentStatus).toBe('pending_verification'); expect(attempt.paymentStatus).toBe('rejected');
  });
  it('blocks repeated review of a paid payment', async () => {
    db.paymentById.mockReturnValue(query(payment({ paymentStatus: 'paid' })));
    await expect(reviewGcash(paymentId, cashierId, [Role.CASHIER], 'paid')).rejects.toThrow('already been reviewed');
  });
  it.each(['Invalid reference number', 'Duplicate reference number', 'Payment not found', 'Incorrect amount', 'Invalid proof of payment'])('keeps the booking unpaid and audits manual rejection: %s', async (reason) => {
    const attempt = payment(); const appointment = booking({ ocularFeeStatus: 'proof_submitted' });
    db.paymentById.mockReturnValue(query(attempt)); db.appointment.mockReturnValue(query(appointment));
    const rejected = await reviewGcash(paymentId, cashierId, [Role.CASHIER], 'rejected', reason);
    expect(rejected).toMatchObject({ paymentStatus: 'rejected', rejectionReason: reason, rejectionSource: 'cashier', rejectedAt: expect.any(Date), duplicateReference: reason === 'Duplicate reference number' });
    expect(rejected.rejectedBy?.toString()).toBe(cashierId);
    expect(appointment).toMatchObject({ bookingStatus: 'pending_payment', paymentStatus: 'rejected', ocularFeePaid: false });
    expect(rejected.verifiedBy).toBeUndefined(); expect(db.receipt).not.toHaveBeenCalled();
  });
  it('cannot approve a flagged duplicate, even if its status were incorrectly pending', async () => {
    const attempt = payment({ duplicateReference: true }); db.paymentById.mockReturnValue(query(attempt));
    await expect(reviewGcash(paymentId, cashierId, [Role.CASHIER], 'paid')).rejects.toThrow('This GCash reference number has already been used. Please check your payment details.');
    expect(attempt.save).not.toHaveBeenCalled(); expect(db.receipt).not.toHaveBeenCalled();
  });
  it('cannot approve a previously rejected attempt', async () => {
    db.paymentById.mockReturnValue(query(payment({ paymentStatus: 'rejected' })));
    await expect(reviewGcash(paymentId, cashierId, [Role.CASHIER], 'paid')).rejects.toThrow('already been reviewed');
    expect(db.receipt).not.toHaveBeenCalled();
  });
  it('blocks approval when another booking owns the slot', async () => {
    db.paymentById.mockReturnValue(query(payment())); db.appointment.mockReturnValue(query(booking({ ocularFeeStatus: 'proof_submitted' })));
    db.lockFind.mockReturnValue(query({ appointmentId: customerId }));
    await expect(reviewGcash(paymentId, cashierId, [Role.CASHIER], 'paid')).rejects.toThrow('slot is no longer available');
    expect(db.receipt).not.toHaveBeenCalled();
  });
});

describe('cashier API authorization', () => {
  it('denies authenticated customers and permits cashiers in the route guard', () => {
    const next = vi.fn();
    authorize(Role.CASHIER)({ user: {}, userRoles: [Role.CUSTOMER] } as never, {} as never, next);
    expect(next.mock.calls[0]?.[0]?.statusCode).toBe(403);
    next.mockClear();
    authorize(Role.CASHIER)({ user: {}, userRoles: [Role.CASHIER] } as never, {} as never, next);
    expect(next).toHaveBeenCalledWith();
  });
});
