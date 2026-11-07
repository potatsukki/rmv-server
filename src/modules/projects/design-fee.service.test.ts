import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectFindById: vi.fn(),
  projectFindOneAndUpdate: vi.fn(),
  projectUpdateOne: vi.fn(),
  appointmentFindById: vi.fn(),
  userFindById: vi.fn(),
  auditCreate: vi.fn(),
  paymentCreate: vi.fn(),
  planFind: vi.fn(),
  blueprintFindOne: vi.fn(),
  feePolicy: vi.fn(),
  receiptNumber: vi.fn(),
  uploadReceipt: vi.fn(),
  notify: vi.fn(),
  notifyRole: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  Project: {
    findById: mocks.projectFindById,
    findOneAndUpdate: mocks.projectFindOneAndUpdate,
    updateOne: mocks.projectUpdateOne,
    find: vi.fn(),
  },
  Appointment: { findById: mocks.appointmentFindById },
  User: { findById: mocks.userFindById },
  AuditLog: { create: mocks.auditCreate },
}));
vi.mock('../../models/Payment.js', () => ({
  Payment: { create: mocks.paymentCreate },
  PaymentPlan: { find: () => ({ lean: mocks.planFind }) },
}));
vi.mock('../../models/Blueprint.js', () => ({
  Blueprint: { findOne: () => ({ sort: () => ({ lean: mocks.blueprintFindOne }) }) },
}));
vi.mock('../notifications/socket.service.js', () => ({
  createAndSendNotification: mocks.notify,
  notifyRole: mocks.notifyRole,
  emitRoleEvent: vi.fn(),
}));
vi.mock('../notifications/email.service.js', () => ({ sendPaymentVerifiedEmail: mocks.sendEmail }));
vi.mock('../config/config.service.js', () => ({ getFeePolicyConfig: mocks.feePolicy }));
vi.mock('../payments/payments.service.js', () => ({
  generateAndUploadReceipt: mocks.uploadReceipt,
  generateNextReceiptNumber: mocks.receiptNumber,
}));
vi.mock('../maps/maps.service.js', () => ({ OCULAR_TOLL_NOTE: 'Toll fees are shouldered by RMV.' }));

import {
  applyFeeCreditsToNewPlans,
  assertDesignFeeAllowsBlueprint,
  deductCreditFromPlan,
  getProjectFeeSummary,
  openDesignFee,
  recordDesignFeePayment,
} from './design-fee.service.js';
import { PaymentMethod } from '../../utils/constants.js';

const stage = (amount: number) => ({ amount, remainingBalance: amount, status: 'pending', amountPaid: 0 });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.feePolicy.mockResolvedValue({ designFeeAmount: 1000, ocularFeeOnProceed: 'separate' });
});

describe('design fee lifecycle', () => {
  it('opens the ₱1,000 design fee once when the customer proceeds', async () => {
    mocks.projectFindOneAndUpdate.mockResolvedValueOnce({ _id: 'project-1', customerId: 'customer-1', title: 'Gate' });

    await openDesignFee('project-1');

    expect(mocks.projectFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'project-1' }),
      { $set: { designFee: expect.objectContaining({ amount: 1000, status: 'pending' }) } },
      { new: true },
    );
    expect(mocks.notify).toHaveBeenCalledWith('customer-1', expect.anything(), 'Design Fee Due', expect.stringContaining('₱1,000'), expect.any(String));
  });

  it('blocks the blueprint only while the design fee is pending', () => {
    expect(() => assertDesignFeeAllowsBlueprint({ designFee: { status: 'pending' } })).toThrow('design fee must be paid');
    expect(() => assertDesignFeeAllowsBlueprint({ designFee: { status: 'verified' } })).not.toThrow();
    // Projects created before the fee existed are not blocked.
    expect(() => assertDesignFeeAllowsBlueprint({})).not.toThrow();
  });

  it('records the cashier payment with a receipt and refuses a second recording', async () => {
    const pending = { _id: 'project-1', customerId: 'customer-1', title: 'Gate', designFee: { amount: 1000, status: 'pending' } };
    mocks.projectFindById.mockResolvedValueOnce(pending);
    mocks.projectFindOneAndUpdate.mockResolvedValueOnce({ ...pending, designFee: { amount: 1000, status: 'verified' } });
    mocks.receiptNumber.mockResolvedValueOnce('RMV-2026-00001');
    mocks.uploadReceipt.mockResolvedValueOnce({ key: 'receipts/r.pdf', buffer: Buffer.from('pdf') });
    mocks.userFindById.mockResolvedValue({ firstName: 'Ana', lastName: 'Cruz', email: 'ana@example.com' });
    mocks.paymentCreate.mockImplementationOnce(async (doc) => doc);

    const result = await recordDesignFeePayment('project-1', { method: PaymentMethod.CASH }, 'cashier-1');

    expect(result.receiptNumber).toBe('RMV-2026-00001');
    expect(mocks.projectFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'project-1', 'designFee.status': 'pending' },
      expect.anything(),
      { new: true },
    );
    expect(mocks.paymentCreate).toHaveBeenCalledWith(expect.objectContaining({
      stageId: 'design-fee-project-1', amountPaid: 1000, paymentStatus: 'paid', receiptNumber: 'RMV-2026-00001',
    }));
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);

    mocks.projectFindById.mockResolvedValueOnce({ ...pending, designFee: { amount: 1000, status: 'verified' } });
    await expect(recordDesignFeePayment('project-1', { method: PaymentMethod.CASH }, 'cashier-1'))
      .rejects.toThrow('already paid');
  });

  it('requires a reference number for GCash and bank payments', async () => {
    mocks.projectFindById.mockResolvedValueOnce({ _id: 'project-1', designFee: { amount: 1000, status: 'pending' } });
    await expect(recordDesignFeePayment('project-1', { method: PaymentMethod.GCASH }, 'cashier-1'))
      .rejects.toThrow('reference number');
    expect(mocks.projectFindOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('design fee credit', () => {
  it('deducts the credit from the plan total and keeps stage sums equal to the new total', () => {
    const plan = { totalAmount: 55000, stages: [stage(16500), stage(22000), stage(16500)] };

    expect(deductCreditFromPlan(plan, 1000)).toBe(1000);

    expect(plan.totalAmount).toBe(54000);
    expect(plan.stages.reduce((sum, item) => sum + item.amount, 0)).toBe(54000);
    expect(plan.stages.map((item) => item.amount)).toEqual([16200, 21600, 16200]);
  });

  it('credits the verified design fee to the first new plan only once', async () => {
    mocks.projectFindOneAndUpdate.mockResolvedValueOnce({ designFee: { amount: 1000, status: 'verified' } });
    const plans = [{ totalAmount: 30000, stages: [stage(30000)] }, { totalAmount: 20000, stages: [stage(20000)] }];

    await applyFeeCreditsToNewPlans('project-1', plans as any);

    expect(plans[0]).toMatchObject({ totalAmount: 29000, grossAmount: 30000, designFeeCredit: 1000 });
    expect(plans[1]).toMatchObject({ totalAmount: 20000 });
    expect(mocks.projectFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ 'designFee.status': 'verified', 'designFee.creditedPlanId': { $exists: false } }),
      expect.anything(),
      { new: true },
    );

    // Already credited: the atomic claim finds nothing, so no second deduction.
    mocks.projectFindOneAndUpdate.mockResolvedValueOnce(null);
    const later = [{ totalAmount: 20000, stages: [stage(20000)] }];
    await applyFeeCreditsToNewPlans('project-1', later as any);
    expect(later[0]).toMatchObject({ totalAmount: 20000 });
  });
});

describe('project fee summary', () => {
  const project = (designFee: Record<string, unknown>) => ({
    _id: { toString: () => 'project-1' },
    ocularAppointmentId: 'ocular-1',
    designFee,
  });

  it('settles to zero when everything is paid and the design fee was credited once', async () => {
    mocks.projectFindById.mockResolvedValueOnce(project({ amount: 1000, status: 'verified' }));
    mocks.appointmentFindById.mockResolvedValueOnce({ ocularFee: 590, ocularFeePaid: true });
    mocks.planFind.mockResolvedValueOnce([{
      totalAmount: 54000, grossAmount: 55000, designFeeCredit: 1000, ocularFeeCredit: 0,
      stages: [{ amountPaid: 16200 }, { amountPaid: 21600 }, { amountPaid: 16200 }],
    }]);

    const summary = await getProjectFeeSummary('project-1');

    expect(summary).toMatchObject({
      projectCost: 55000,
      designFeeCredit: 1000,
      ocularFee: { amount: 590, status: 'verified', treatment: 'separate' },
      totalAmountDue: 55590, // 55,000 + 1,000 design + 590 ocular − 1,000 credit
      paymentsReceived: 55590,
      remainingBalance: 0,
    });
  });

  it('does not charge the design fee when the customer did not proceed', async () => {
    mocks.projectFindById.mockResolvedValueOnce(project({ amount: 1000, status: 'not_charged' }));
    mocks.appointmentFindById.mockResolvedValueOnce({ ocularFee: 350, ocularFeePaid: true });
    mocks.planFind.mockResolvedValueOnce([]);
    mocks.blueprintFindOne.mockResolvedValueOnce(null);

    const summary = await getProjectFeeSummary('project-1');

    expect(summary).toMatchObject({ projectCost: null, totalAmountDue: 350, paymentsReceived: 350, remainingBalance: 0 });
  });

  it('deducts the paid ocular fee when the policy is set to credit', async () => {
    mocks.feePolicy.mockResolvedValue({ designFeeAmount: 1000, ocularFeeOnProceed: 'credit' });
    mocks.projectFindById.mockResolvedValueOnce(project({ amount: 1000, status: 'verified' }));
    mocks.appointmentFindById.mockResolvedValueOnce({ ocularFee: 590, ocularFeePaid: true });
    mocks.planFind.mockResolvedValueOnce([{
      totalAmount: 53410, grossAmount: 55000, designFeeCredit: 1000, ocularFeeCredit: 590, stages: [{ amountPaid: 0 }],
    }]);

    const summary = await getProjectFeeSummary('project-1');

    expect(summary).toMatchObject({ ocularFeeCredit: 590, totalAmountDue: 55000, remainingBalance: 53410 });
  });
});
