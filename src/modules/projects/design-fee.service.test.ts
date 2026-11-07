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
  blueprintFindById: vi.fn(),
  blueprintFindOneAndUpdate: vi.fn(),
  blueprintUpdateOne: vi.fn(),
  blueprintFindRevised: vi.fn(),
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
  Blueprint: {
    findOne: () => ({ sort: () => ({ lean: mocks.blueprintFindOne }) }),
    find: () => ({ select: () => ({ lean: mocks.blueprintFindRevised }) }),
    findById: mocks.blueprintFindById,
    findOneAndUpdate: mocks.blueprintFindOneAndUpdate,
    updateOne: mocks.blueprintUpdateOne,
  },
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
  acknowledgeDesignFee,
  applyFeeCreditsToNewPlans,
  assertDesignFeeAllowsBlueprint,
  deductCreditFromPlan,
  getProjectFeeSummary,
  openDesignFee,
  prepareRevisionFee,
  recordDesignFeePayment,
  recordRevisionFeePayment,
} from './design-fee.service.js';
import { PaymentMethod } from '../../utils/constants.js';

const stage = (amount: number) => ({ amount, remainingBalance: amount, status: 'pending', amountPaid: 0 });

function mockReceipt() {
  mocks.receiptNumber.mockResolvedValueOnce('RMV-2026-00001');
  mocks.uploadReceipt.mockResolvedValueOnce({ key: 'receipts/r.pdf', buffer: Buffer.from('pdf') });
  mocks.userFindById.mockResolvedValue({ firstName: 'Ana', lastName: 'Cruz', email: 'ana@example.com' });
  mocks.paymentCreate.mockImplementationOnce(async (doc) => doc);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.feePolicy.mockResolvedValue({
    designFeeAmount: 1000, ocularFeeOnProceed: 'separate', revisionFeeAmount: 1000, freeRevisionLimit: 3,
  });
  mocks.blueprintFindRevised.mockResolvedValue([]);
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
    expect(mocks.notify).toHaveBeenCalledWith('customer-1', expect.anything(), 'Design Fee Due', expect.stringContaining('non-refundable'), expect.any(String));
  });

  it('blocks the blueprint only while the design fee is pending', () => {
    expect(() => assertDesignFeeAllowsBlueprint({ designFee: { status: 'pending' } })).toThrow('design fee must be paid');
    expect(() => assertDesignFeeAllowsBlueprint({ designFee: { status: 'verified' } })).not.toThrow();
    // Projects created before the fee existed are not blocked.
    expect(() => assertDesignFeeAllowsBlueprint({})).not.toThrow();
  });

  it('lets only the project customer acknowledge the non-refundable design fee', async () => {
    const pending = { _id: 'project-1', customerId: { toString: () => 'customer-1' }, designFee: { amount: 1000, status: 'pending' } };
    mocks.projectFindById.mockResolvedValueOnce(pending);
    await expect(acknowledgeDesignFee('project-1', 'someone-else')).rejects.toThrow('Only the project customer');

    mocks.projectFindById.mockResolvedValueOnce(pending);
    mocks.projectFindOneAndUpdate.mockResolvedValueOnce({ ...pending, designFee: { ...pending.designFee, acknowledgedAt: new Date() } });
    await acknowledgeDesignFee('project-1', 'customer-1');
    expect(mocks.projectFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ 'designFee.status': 'pending' }),
      { $set: { 'designFee.acknowledgedAt': expect.any(Date), 'designFee.acknowledgedVia': 'customer' } },
      { new: true },
    );
  });

  it('refuses to record the fee until the customer acknowledged it is non-refundable', async () => {
    mocks.projectFindById.mockResolvedValueOnce({ _id: 'project-1', designFee: { amount: 1000, status: 'pending' } });
    await expect(recordDesignFeePayment('project-1', { method: PaymentMethod.CASH }, 'cashier-1'))
      .rejects.toThrow('non-refundable');
    expect(mocks.projectFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('records an in-person acknowledgment, issues a receipt, and refuses a second recording', async () => {
    const pending = { _id: 'project-1', customerId: 'customer-1', title: 'Gate', designFee: { amount: 1000, status: 'pending' } };
    mocks.projectFindById.mockResolvedValueOnce(pending);
    mocks.projectFindOneAndUpdate.mockResolvedValueOnce({ ...pending, designFee: { amount: 1000, status: 'verified' } });
    mockReceipt();

    const result = await recordDesignFeePayment(
      'project-1',
      { method: PaymentMethod.CASH, customerAcknowledgedInPerson: true },
      'cashier-1',
    );

    expect(result.receiptNumber).toBe('RMV-2026-00001');
    expect(mocks.projectFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'project-1', 'designFee.status': 'pending' },
      { $set: expect.objectContaining({ 'designFee.status': 'verified', 'designFee.acknowledgedVia': 'in_person' }) },
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
    mocks.projectFindById.mockResolvedValueOnce({
      _id: 'project-1', designFee: { amount: 1000, status: 'pending', acknowledgedAt: new Date() },
    });
    await expect(recordDesignFeePayment('project-1', { method: PaymentMethod.GCASH }, 'cashier-1'))
      .rejects.toThrow('reference number');
    expect(mocks.projectFindOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('revision fee', () => {
  it('is free for revisions 1 to 3 and ₱1,000 with acknowledgment after that', async () => {
    await expect(prepareRevisionFee(3, false)).resolves.toBeNull();
    await expect(prepareRevisionFee(4, false)).rejects.toThrow('non-refundable fee');
    await expect(prepareRevisionFee(4, true)).resolves.toMatchObject({ amount: 1000, status: 'pending', revisionNumber: 4 });
  });

  it('records the revision fee once with its own receipt', async () => {
    const pending = { _id: 'bp-4', projectId: 'project-1', revisionFee: { amount: 1000, status: 'pending', revisionNumber: 4 } };
    mocks.blueprintFindById.mockResolvedValueOnce(pending);
    mocks.projectFindById.mockResolvedValueOnce({ _id: 'project-1', customerId: 'customer-1', title: 'Gate' });
    mocks.blueprintFindOneAndUpdate.mockResolvedValueOnce({ ...pending, uploadedBy: 'engineer-1', revisionFee: { ...pending.revisionFee, status: 'verified' } });
    mockReceipt();

    const result = await recordRevisionFeePayment('bp-4', { method: PaymentMethod.CASH }, 'cashier-1');

    expect(result.receiptNumber).toBe('RMV-2026-00001');
    expect(mocks.paymentCreate).toHaveBeenCalledWith(expect.objectContaining({ stageId: 'revision-fee-bp-4', amountPaid: 1000 }));

    mocks.blueprintFindById.mockResolvedValueOnce({ ...pending, revisionFee: { ...pending.revisionFee, status: 'verified' } });
    await expect(recordRevisionFeePayment('bp-4', { method: PaymentMethod.CASH }, 'cashier-1')).rejects.toThrow('already paid');
  });
});

describe('design fee credit', () => {
  it('deducts an amount from the plan total and keeps stage sums equal to the new total', () => {
    const plan = { totalAmount: 55000, stages: [stage(16500), stage(22000), stage(16500)] };

    expect(deductCreditFromPlan(plan, 1000)).toBe(1000);

    expect(plan.totalAmount).toBe(54000);
    expect(plan.stages.reduce((sum, item) => sum + item.amount, 0)).toBe(54000);
  });

  it('credits ₱1,000 before the 10% installment surcharge: (50,000 − 1,000) × 1.1', async () => {
    mocks.projectFindOneAndUpdate.mockResolvedValueOnce({ designFee: { amount: 1000, status: 'verified' } });
    const plan = { totalAmount: 55000, baseAmount: 50000, surchargePercent: 10, stages: [stage(16500), stage(22000), stage(16500)] };

    await applyFeeCreditsToNewPlans('project-1', [plan] as any);

    expect(plan).toMatchObject({ totalAmount: 53900, baseAmount: 50000, designFeeCredit: 1000 });
    expect(plan.stages.reduce((sum, item) => sum + item.amount, 0)).toBe(53900);
  });

  it('credits the verified design fee to the first new plan only once', async () => {
    mocks.projectFindOneAndUpdate.mockResolvedValueOnce({ designFee: { amount: 1000, status: 'verified' } });
    const plans = [{ totalAmount: 30000, stages: [stage(30000)] }, { totalAmount: 20000, stages: [stage(20000)] }];

    await applyFeeCreditsToNewPlans('project-1', plans as any);

    expect(plans[0]).toMatchObject({ totalAmount: 29000, baseAmount: 30000, designFeeCredit: 1000 });
    expect(plans[1]).toMatchObject({ totalAmount: 20000 });

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

  it('settles to zero for an installment plan with the design fee credited before the surcharge', async () => {
    mocks.projectFindById.mockResolvedValueOnce(project({ amount: 1000, status: 'verified' }));
    mocks.appointmentFindById.mockResolvedValueOnce({ ocularFee: 590, ocularFeePaid: true });
    mocks.planFind.mockResolvedValueOnce([{
      totalAmount: 53900, baseAmount: 50000, surchargePercent: 10, designFeeCredit: 1000, ocularFeeCredit: 0,
      stages: [{ amountPaid: 16170 }, { amountPaid: 21560 }, { amountPaid: 16170 }],
    }]);

    const summary = await getProjectFeeSummary('project-1');

    expect(summary).toMatchObject({
      projectCost: 50000,
      installmentSurcharge: 4900,
      designFeeCredit: 1000,
      ocularFee: { amount: 590, status: 'verified', treatment: 'separate' },
      totalAmountDue: 55490, // 50,000 + 4,900 surcharge + 1,000 design + 590 ocular − 1,000 credit
      paymentsReceived: 55490,
      remainingBalance: 0,
    });
  });

  it('adds paid and pending revision fees as separate charges', async () => {
    mocks.projectFindById.mockResolvedValueOnce(project({ amount: 1000, status: 'verified' }));
    mocks.appointmentFindById.mockResolvedValueOnce(null);
    mocks.planFind.mockResolvedValueOnce([]);
    mocks.blueprintFindOne.mockResolvedValueOnce({ quotation: { total: 20000 } });
    mocks.blueprintFindRevised.mockResolvedValueOnce([
      { _id: 'bp-4', version: 4, revisionFee: { amount: 1000, status: 'verified', revisionNumber: 4 } },
      { _id: 'bp-5', version: 5, revisionFee: { amount: 1000, status: 'pending', revisionNumber: 5 } },
    ]);

    const summary = await getProjectFeeSummary('project-1');

    expect(summary.revisionFees).toMatchObject({ count: 2, amount: 2000, paid: 1000, pending: 1000 });
    // 20,000 + 1,000 design + 2,000 revisions − 1,000 credit = 22,000; received 1,000 design + 1,000 revision.
    expect(summary).toMatchObject({ totalAmountDue: 22000, paymentsReceived: 2000, remainingBalance: 20000 });
  });

  it('does not charge the design fee when the customer did not proceed', async () => {
    mocks.projectFindById.mockResolvedValueOnce(project({ amount: 1000, status: 'not_charged' }));
    mocks.appointmentFindById.mockResolvedValueOnce({ ocularFee: 350, ocularFeePaid: true });
    mocks.planFind.mockResolvedValueOnce([]);
    mocks.blueprintFindOne.mockResolvedValueOnce(null);

    const summary = await getProjectFeeSummary('project-1');

    expect(summary).toMatchObject({ projectCost: null, totalAmountDue: 350, paymentsReceived: 350, remainingBalance: 0 });
  });
});
