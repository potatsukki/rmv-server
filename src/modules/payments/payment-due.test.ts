import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  planFind: vi.fn(),
  blueprintDistinct: vi.fn(),
  paymentDistinct: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  PaymentPlan: { find: mocks.planFind },
  Blueprint: { distinct: mocks.blueprintDistinct },
  Payment: { distinct: mocks.paymentDistinct },
}));

import { getProjectPaymentDue } from './payment-due.js';

const exec = <T>(value: T) => ({ exec: vi.fn().mockResolvedValue(value) });
const activatedAt = new Date('2026-11-01');

function plans(value: object[]) {
  mocks.planFind.mockReturnValue({ select: () => ({ lean: () => exec(value) }) });
}

describe('getProjectPaymentDue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    plans([]);
    mocks.blueprintDistinct.mockReturnValue(exec([]));
    mocks.paymentDistinct.mockReturnValue(exec([]));
  });

  it('counts only due stages that still have a balance', async () => {
    plans([{
      projectId: 'p1',
      stages: [
        { status: 'pending', amount: 3000, amountPaid: 0, activatedAt },
        { status: 'declined', amount: 1000, amountPaid: 200, activatedAt },
        { status: 'pending', amount: 4000, amountPaid: 0, activatedAt: null },
        { status: 'proof_submitted', amount: 1000, amountPaid: 0, activatedAt },
        { status: 'pending', amount: 1000, amountPaid: 1000, activatedAt },
        { status: 'pending', amount: 1000, amountPaid: 0, creditApplied: 1000, activatedAt },
      ],
    }]);

    const due = await getProjectPaymentDue([{ _id: 'p1', status: 'payment_pending' }]);

    expect(due.get('p1')).toEqual({
      dueStages: 2, designFee: false, revisionFee: false, needsPlan: false, needsPayment: true,
    });
  });

  it('flags design fees unless a GCash proof is waiting for review', async () => {
    mocks.paymentDistinct.mockReturnValue(exec(['design-fee-p2']));

    const due = await getProjectPaymentDue([
      { _id: 'p1', status: 'submitted', designFee: { status: 'pending' } },
      { _id: 'p2', status: 'submitted', designFee: { status: 'pending' } },
      { _id: 'p3', status: 'blueprint', designFee: { status: 'verified' } },
    ]);

    expect(due.get('p1')?.designFee).toBe(true);
    expect(due.get('p2')?.designFee).toBe(false);
    expect(due.get('p3')?.needsPayment).toBe(false);
    expect(mocks.paymentDistinct).toHaveBeenCalledWith('stageId', {
      stageId: { $in: ['design-fee-p1', 'design-fee-p2'] },
      paymentStatus: 'pending_verification',
    });
  });

  it('flags revision fees and approved projects without a payment plan', async () => {
    mocks.blueprintDistinct.mockReturnValue(exec(['p1']));
    plans([{ projectId: 'p3', stages: [{ status: 'pending', amount: 1000, amountPaid: 0, activatedAt: null }] }]);

    const due = await getProjectPaymentDue([
      { _id: 'p1', status: 'blueprint' },
      { _id: 'p2', status: 'approved' },
      { _id: 'p3', status: 'approved' },
    ]);

    expect(due.get('p1')).toMatchObject({ revisionFee: true, needsPayment: true });
    expect(due.get('p2')).toMatchObject({ needsPlan: true, needsPayment: true });
    expect(due.get('p3')).toMatchObject({ needsPlan: false, needsPayment: false });
  });

  it('leaves cancelled projects out and skips queries when nothing is open', async () => {
    const due = await getProjectPaymentDue([{ _id: 'p1', status: 'cancelled', designFee: { status: 'pending' } }]);

    expect(due.size).toBe(0);
    expect(mocks.planFind).not.toHaveBeenCalled();
  });
});
