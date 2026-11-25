import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appointmentFindById: vi.fn(),
  appointmentFindOneAndUpdate: vi.fn(),
  paymentFindOne: vi.fn(),
  paymentSave: vi.fn(),
  cashCreate: vi.fn(),
  projectFindById: vi.fn(),
  userFindById: vi.fn(),
  auditCreate: vi.fn(),
  issueReceipt: vi.fn(),
  issueFeeReceipt: vi.fn(),
  paymentFindById: vi.fn(),
  collectionNumber: vi.fn(),
  recordDesignFee: vi.fn(),
  notifyUsers: vi.fn(),
  notifyRoleExcept: vi.fn(),
}));

vi.mock('../../models/index.js', () => {
  class Payment {
    static findOne = mocks.paymentFindOne;
    static findById = mocks.paymentFindById;
    _id = 'payment-new';
    evidenceTrail: unknown[] = [];
    constructor(doc: Record<string, unknown>) { Object.assign(this, doc); }
    save() { return mocks.paymentSave(this); }
  }
  return {
    Appointment: { findById: mocks.appointmentFindById, findOneAndUpdate: mocks.appointmentFindOneAndUpdate },
    Payment,
    CashCollection: { create: mocks.cashCreate },
    Project: { findById: mocks.projectFindById },
    User: { findById: mocks.userFindById },
    AuditLog: { create: mocks.auditCreate },
    generateNextCollectionNumber: mocks.collectionNumber,
  };
});
vi.mock('../notifications/socket.service.js', () => ({
  notifyUsers: mocks.notifyUsers,
  notifyRoleExcept: mocks.notifyRoleExcept,
  emitRoleEvent: vi.fn(),
  emitUserEvent: vi.fn(),
}));
vi.mock('../payments/payments.service.js', () => ({ issueGcashReceipt: mocks.issueReceipt }));
vi.mock('../projects/design-fee.service.js', () => ({
  recordDesignFeePayment: mocks.recordDesignFee,
  issueFeeReceipt: mocks.issueFeeReceipt,
}));

import {
  collectDesignFeeOnSite, collectOcularFeeOnSite, issueCollectionReceipt, ONSITE_CASH_SOURCE,
} from './onsite-fee.service.js';
import { AppointmentStatus, AppointmentType, PaymentMethod, Role } from '../../utils/constants.js';

const STAFF = 'staff-1';

function ocular(overrides: Record<string, unknown> = {}) {
  return {
    _id: { toString: () => 'appt-1' },
    type: AppointmentType.OCULAR,
    salesStaffId: { toString: () => STAFF },
    customerId: { toString: () => 'customer-1' },
    status: AppointmentStatus.IN_PROGRESS,
    appointmentNumber: 'APT-20261126-0001',
    ocularFee: 650,
    ocularFeePaid: false,
    ocularFeeStatus: 'cash_pending',
    ocularFeeNonRefundableAckAt: new Date('2026-11-20T00:00:00Z'),
    ...overrides,
  };
}

function unpaidCashPayment() {
  return {
    _id: 'payment-1',
    amountPaid: 0,
    evidenceTrail: [] as unknown[],
    save: vi.fn(async function save() { return this; }),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.userFindById.mockReturnValue({ select: async () => ({ firstName: 'Kendl', lastName: 'Reyes' }) });
  mocks.appointmentFindOneAndUpdate.mockImplementation(async () => ocular({ ocularFeePaid: true, ocularFeeStatus: 'verified' }));
  mocks.issueReceipt.mockImplementation(async (payment: { receiptNumber?: string }) => { payment.receiptNumber = 'RMV-2026-00042'; });
  mocks.cashCreate.mockImplementation(async (doc: Record<string, unknown>) => ({ _id: 'collection-1', ...doc }));
  mocks.collectionNumber.mockResolvedValue('CC-2026-00007');
});

describe('collectOcularFeeOnSite', () => {
  it('lets only the sales staff of the ocular visit record the cash', async () => {
    mocks.appointmentFindById.mockResolvedValueOnce(ocular());
    await expect(collectOcularFeeOnSite('appt-1', 'other-staff', {})).rejects.toThrow('Only the sales staff assigned');
    expect(mocks.appointmentFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('needs the sales staff at the site or after the visit', async () => {
    for (const status of [AppointmentStatus.CONFIRMED, AppointmentStatus.ON_THE_WAY]) {
      mocks.appointmentFindById.mockResolvedValueOnce(ocular({ status }));
      await expect(collectOcularFeeOnSite('appt-1', STAFF, {})).rejects.toThrow('at the site');
    }
    for (const status of [AppointmentStatus.ARRIVED_AT_SITE, AppointmentStatus.IN_PROGRESS, AppointmentStatus.COMPLETED]) {
      mocks.appointmentFindById.mockResolvedValueOnce(ocular({ status }));
      mocks.paymentFindOne.mockResolvedValueOnce(unpaidCashPayment());
      await expect(collectOcularFeeOnSite('appt-1', STAFF, {})).resolves.toBeDefined();
    }
  });

  it('refuses while an online payment waits for the cashier, or when the fee is paid / free', async () => {
    mocks.appointmentFindById.mockResolvedValueOnce(ocular({ ocularFeeStatus: 'proof_submitted' }));
    await expect(collectOcularFeeOnSite('appt-1', STAFF, {})).rejects.toThrow('online payment');

    mocks.appointmentFindById.mockResolvedValueOnce(ocular({ ocularFeePaid: true }));
    await expect(collectOcularFeeOnSite('appt-1', STAFF, {})).rejects.toThrow('already paid');

    mocks.appointmentFindById.mockResolvedValueOnce(ocular({ ocularFee: 0 }));
    await expect(collectOcularFeeOnSite('appt-1', STAFF, {})).rejects.toThrow('no fee');
  });

  it('needs the in-person non-refundable acknowledgment when the customer did not confirm it in the app', async () => {
    mocks.appointmentFindById.mockResolvedValueOnce(ocular({ ocularFeeNonRefundableAckAt: undefined }));
    await expect(collectOcularFeeOnSite('appt-1', STAFF, {})).rejects.toThrow('non-refundable');

    mocks.appointmentFindById.mockResolvedValueOnce(ocular({ ocularFeeNonRefundableAckAt: undefined }));
    mocks.paymentFindOne.mockResolvedValueOnce(unpaidCashPayment());
    await collectOcularFeeOnSite('appt-1', STAFF, { customerAcknowledgedInPerson: true });
    expect(mocks.appointmentFindOneAndUpdate.mock.calls[0]![1].$set.ocularFeeNonRefundableAckAt).toBeInstanceOf(Date);
  });

  it('marks the fee paid at once with an acknowledgement (no receipt) and leaves the cash for the cashier', async () => {
    const payment = unpaidCashPayment();
    mocks.appointmentFindById.mockResolvedValueOnce(ocular());
    mocks.paymentFindOne.mockResolvedValueOnce(payment);

    const result = await collectOcularFeeOnSite('appt-1', STAFF, { notes: 'Exact amount' });

    const [filter, update] = mocks.appointmentFindOneAndUpdate.mock.calls[0]!;
    expect(filter).toMatchObject({ ocularFeePaid: { $ne: true }, ocularFeeStatus: { $ne: 'proof_submitted' } });
    expect(update.$set).toMatchObject({
      ocularFeePaid: true, ocularFeeStatus: 'verified', ocularFeePaymentMethod: PaymentMethod.CASH,
      paymentStatus: 'paid', ocularFeeVerifiedBy: STAFF,
    });
    expect(payment).toMatchObject({ amountPaid: 650, amountRequired: 650, paymentStatus: 'paid', status: 'verified', verifiedBy: STAFF });
    expect(payment.evidenceTrail[0]).toMatchObject({ source: ONSITE_CASH_SOURCE, amountPaid: 650, note: 'Exact amount' });
    // The sales staff never issues the official receipt.
    expect(mocks.issueReceipt).not.toHaveBeenCalled();
    expect(mocks.cashCreate).toHaveBeenCalledWith(expect.objectContaining({
      salesStaffId: STAFF, feeType: 'ocular_fee', paymentId: 'payment-1', collectionNumber: 'CC-2026-00007', amountCollected: 650, status: 'collected',
    }));
    expect(mocks.cashCreate.mock.calls[0]![0]).not.toHaveProperty('receiptNumber');
    expect(result.collectionNumber).toBe('CC-2026-00007');
    // The customer gets the acknowledgement; the cashiers hear about the cash; the sales staff does not.
    const [, , title, message, link, options] = mocks.notifyUsers.mock.calls[0]!;
    expect(title).toBe('Ocular Fee Payment Received');
    expect(message).toContain('Payment received by Kendl Reyes');
    expect(message).toContain('Collection No. CC-2026-00007');
    expect(message).toContain('official receipt follows');
    expect(link).toBe('/appointments/appt-1');
    expect(options).toEqual({ excludeUserId: STAFF });
    expect(mocks.notifyRoleExcept).toHaveBeenCalledWith(Role.CASHIER, expect.anything(), 'Cash to Receive', expect.stringContaining('official receipt'), '/cash', STAFF);
  });

  it('starts a new cash payment when the customer never chose cash online', async () => {
    mocks.appointmentFindById.mockResolvedValueOnce(ocular({ ocularFeeStatus: 'pending' }));
    mocks.paymentFindOne.mockResolvedValueOnce(null);

    await collectOcularFeeOnSite('appt-1', STAFF, {});

    const saved = mocks.paymentSave.mock.calls[0]![0];
    expect(saved).toMatchObject({ stageId: 'ocular-appt-1', method: PaymentMethod.CASH, amountPaid: 650, paymentStatus: 'paid' });
  });

  it('stops when the cashier recorded the fee at the same moment', async () => {
    mocks.appointmentFindById.mockResolvedValueOnce(ocular());
    mocks.appointmentFindOneAndUpdate.mockResolvedValueOnce(null);
    await expect(collectOcularFeeOnSite('appt-1', STAFF, {})).rejects.toThrow('already paid');
    expect(mocks.cashCreate).not.toHaveBeenCalled();
  });
});

describe('collectDesignFeeOnSite', () => {
  const project = {
    _id: { toString: () => 'project-1' },
    salesStaffId: { toString: () => 'project-staff' },
    customerId: 'customer-1',
    ocularAppointmentId: 'ocular-1',
    title: 'Terrace railing',
  };

  function mockProject(overrides: Record<string, unknown> = {}) {
    mocks.projectFindById.mockReturnValueOnce({ select: async () => ({ ...project, ...overrides }) });
  }
  function mockOcularStaff(staffId: string) {
    mocks.appointmentFindById.mockReturnValueOnce({ select: async () => ({ salesStaffId: { toString: () => staffId } }) });
  }

  it('lets the project sales staff or the staff who took the ocular visit record it', async () => {
    mocks.recordDesignFee.mockResolvedValue({
      project: { designFee: { amount: 1000 } }, payment: { _id: 'payment-2', amountPaid: 1000 }, receiptNumber: undefined,
    });

    mockProject();
    mockOcularStaff('ocular-staff');
    await collectDesignFeeOnSite('project-1', 'ocular-staff', { customerAcknowledgedInPerson: true });

    expect(mocks.recordDesignFee).toHaveBeenCalledWith(
      'project-1',
      { method: PaymentMethod.CASH, customerAcknowledgedInPerson: true },
      'ocular-staff',
      undefined,
      undefined,
      { source: ONSITE_CASH_SOURCE, issueReceipt: false },
    );
    expect(mocks.cashCreate).toHaveBeenCalledWith(expect.objectContaining({
      appointmentId: 'ocular-1', feeType: 'design_fee', paymentId: 'payment-2', collectionNumber: 'CC-2026-00007', amountCollected: 1000,
    }));
    expect(mocks.notifyUsers).toHaveBeenCalledWith(
      ['customer-1'], expect.anything(), 'Design Fee Payment Received', expect.stringContaining('Collection No. CC-2026-00007'),
      expect.stringContaining('/payments'), { excludeUserId: 'ocular-staff' },
    );
    expect(mocks.notifyRoleExcept).toHaveBeenCalledWith(Role.CASHIER, expect.anything(), 'Cash to Receive', expect.stringContaining('design fee'), '/cash', 'ocular-staff');

    mockProject();
    mockOcularStaff('ocular-staff');
    await expect(collectDesignFeeOnSite('project-1', 'project-staff', {})).resolves.toBeDefined();
  });

  it('refuses other sales staff and projects without an ocular visit', async () => {
    mockProject();
    mockOcularStaff('ocular-staff');
    await expect(collectDesignFeeOnSite('project-1', 'someone-else', {})).rejects.toThrow('Only the sales staff of this project');

    mockProject({ ocularAppointmentId: undefined });
    await expect(collectDesignFeeOnSite('project-1', 'project-staff', {})).rejects.toThrow('no ocular visit');
    expect(mocks.recordDesignFee).not.toHaveBeenCalled();
  });
});

describe('issueCollectionReceipt (the cashier received the cash)', () => {
  function collection(overrides: Record<string, unknown> = {}) {
    return {
      feeType: 'ocular_fee', paymentId: 'payment-1', customerId: 'customer-1', appointmentId: 'appt-1',
      amountCollected: 650, collectionNumber: 'CC-2026-00007', save: vi.fn(async () => undefined), ...overrides,
    };
  }

  it('issues the ocular fee receipt in the cashier\'s name and tells the customer', async () => {
    const payment = { receiptNumber: undefined as string | undefined };
    mocks.paymentFindById.mockResolvedValueOnce(payment);
    const item = collection();

    const number = await issueCollectionReceipt(item as never, 'cashier-1');

    expect(mocks.issueReceipt).toHaveBeenCalledWith(payment, 'cashier-1');
    expect(number).toBe('RMV-2026-00042');
    expect(item).toMatchObject({ receiptNumber: 'RMV-2026-00042' });
    expect(item.save).toHaveBeenCalled();
    expect(mocks.notifyUsers).toHaveBeenCalledWith(
      ['customer-1'], expect.anything(), 'Official Receipt Issued', expect.stringContaining('RMV-2026-00042'), '/appointments/appt-1',
    );
  });

  it('issues the design fee receipt through the fee receipt flow', async () => {
    mocks.issueFeeReceipt.mockResolvedValueOnce('RMV-2026-00050');
    const item = collection({ feeType: 'design_fee', paymentId: 'payment-2', projectId: 'project-1', amountCollected: 1000 });

    expect(await issueCollectionReceipt(item as never, 'cashier-1')).toBe('RMV-2026-00050');
    expect(mocks.issueFeeReceipt).toHaveBeenCalledWith('payment-2', 'cashier-1');
  });

  it('leaves old collections (no linked payment) and receipted ones alone', async () => {
    expect(await issueCollectionReceipt(collection({ paymentId: undefined }) as never, 'cashier-1')).toBeUndefined();
    expect(await issueCollectionReceipt(collection({ receiptNumber: 'RMV-1' }) as never, 'cashier-1')).toBe('RMV-1');
    expect(mocks.issueReceipt).not.toHaveBeenCalled();
    expect(mocks.notifyUsers).not.toHaveBeenCalled();
  });
});
