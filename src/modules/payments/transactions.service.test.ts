import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockPaymentFind, mockPaymentDistinct, mockAppointmentFind, mockPlanFind } = vi.hoisted(() => ({
  mockPaymentFind: vi.fn(),
  mockPaymentDistinct: vi.fn(),
  mockAppointmentFind: vi.fn(),
  mockPlanFind: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  Payment: { find: mockPaymentFind, distinct: mockPaymentDistinct },
  Appointment: { find: mockAppointmentFind },
  PaymentPlan: { find: mockPlanFind },
}));

import {
  buildTransactionsCsv,
  classifyPaymentType,
  csvCell,
  listTransactions,
  normalizeTransactionStatus,
  type TransactionRow,
} from './transactions.service.js';

/** Chainable Mongoose query stub: every populate/select returns itself; lean resolves the rows. */
function query(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.populate = vi.fn(() => chain);
  chain.select = vi.fn(() => chain);
  chain.lean = vi.fn(async () => rows);
  return chain;
}

const customer = { firstName: 'Lindsay', lastName: 'Tredes' };
const cashier = { firstName: 'Sean', lastName: 'Reyes' };
const project = { _id: 'project-1', title: 'Railings Project', projectNumber: 'PRJ-2026-00095', customerId: customer };

const payments = [
  { _id: 'p-stage', projectId: project, stageId: 'stage-uuid-1', method: 'cash', amountPaid: 6000, status: 'verified',
    receiptNumber: 'RMV-2026-00010', receiptKey: 'receipts/10.pdf', verifiedBy: cashier, verifiedAt: new Date('2026-11-05T02:00:00Z'),
    createdAt: new Date('2026-11-05T01:00:00Z') },
  { _id: 'p-design', projectId: project, stageId: 'design-fee-project-1', method: 'gcash', amountPaid: 1000, status: 'proof_submitted',
    paymentStatus: 'pending_verification', gcashReferenceNumber: '2026110900001', createdAt: new Date('2026-11-09T01:00:00Z') },
  { _id: 'p-revision', projectId: project, stageId: 'revision-fee-project-1', method: 'cash', amountPaid: 1000, status: 'declined',
    declineReason: 'Wrong amount', createdAt: new Date('2026-11-07T01:00:00Z') },
  { _id: 'p-booking', bookingId: { _id: 'appt-1', appointmentNumber: 'APT-20261114-0003', serviceTypes: ['kitchen_counter'] },
    customerId: { firstName: 'Amihan', lastName: 'Reyes' }, stageId: 'ocular-fee', method: 'gcash', amountPaid: 1500,
    status: 'verified', paymentStatus: 'paid', createdAt: new Date('2026-11-10T01:00:00Z') },
];
const legacyOculars = [
  { _id: 'appt-old', appointmentNumber: 'APT-20261001-0001', customerId: { firstName: 'Ivy', lastName: 'Cruz' },
    serviceTypes: ['railings'], ocularFee: 800, ocularFeePaid: true, ocularFeePaymentMethod: 'cash', createdAt: new Date('2026-10-01T01:00:00Z') },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockPaymentFind.mockImplementation(() => query(payments));
  mockPaymentDistinct.mockResolvedValue(['appt-1']);
  mockAppointmentFind.mockImplementation(() => query(legacyOculars));
  mockPlanFind.mockImplementation(() => query([{ stages: [{ stageId: 'stage-uuid-1', label: 'Down Payment' }] }]));
});

describe('transaction classification', () => {
  it.each([
    [{ bookingId: 'appt-1', stageId: 'ocular-fee' }, 'ocular_fee'],
    [{ stageId: 'design-fee-project-1' }, 'design_fee'],
    [{ stageId: 'revision-fee-project-1' }, 'revision_fee'],
    [{ stageId: 'stage-uuid-1' }, 'project_payment'],
  ])('classifies %o as %s', (payment, type) => {
    expect(classifyPaymentType(payment)).toBe(type);
  });

  it.each([
    ['paid', 'verified'], ['verified', 'verified'],
    ['rejected', 'rejected'], ['declined', 'rejected'],
    ['pending_verification', 'pending'], ['proof_submitted', 'pending'], ['unpaid', 'pending'], ['cash_pending', 'pending'],
  ])('maps %s to %s', (raw, status) => {
    expect(normalizeTransactionStatus(raw)).toBe(status);
  });
});

describe('listTransactions', () => {
  it('lists stage, design, revision and ocular payments plus legacy ocular fees, newest first', async () => {
    const result = await listTransactions({});

    expect(result.items.map((row) => row._id)).toEqual(['p-booking', 'p-design', 'p-revision', 'p-stage', 'appt-old']);
    expect(result.items.find((row) => row._id === 'p-stage')).toMatchObject({
      type: 'project_payment', description: 'Down Payment — Railings Project', customerName: 'Lindsay Tredes',
      projectNumber: 'PRJ-2026-00095', status: 'verified', receiptNumber: 'RMV-2026-00010', hasReceipt: true, handledBy: 'Sean Reyes',
    });
    expect(result.items.find((row) => row._id === 'p-booking')).toMatchObject({
      type: 'ocular_fee', appointmentNumber: 'APT-20261114-0003', customerName: 'Amihan Reyes', status: 'verified',
    });
    expect(result.items.find((row) => row._id === 'p-design')).toMatchObject({ type: 'design_fee', status: 'pending', referenceNumber: '2026110900001' });
    expect(result.items.find((row) => row._id === 'p-revision')).toMatchObject({ type: 'revision_fee', status: 'rejected', rejectionReason: 'Wrong amount' });
    expect(result.items.find((row) => row._id === 'appt-old')).toMatchObject({ source: 'appointment', type: 'ocular_fee', amount: 800, status: 'verified' });
  });

  it('never lists a booking twice: legacy ocular fees skip bookings that already have a Payment', async () => {
    await listTransactions({});
    expect(mockAppointmentFind).toHaveBeenCalledWith(expect.objectContaining({ _id: { $nin: ['appt-1'] }, type: 'ocular' }));
  });

  it('computes the summary over every filtered row, not only the current page', async () => {
    const result = await listTransactions({ limit: 2 });

    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(5);
    expect(result.summary).toEqual({
      count: 5,
      verifiedTotal: 6000 + 1500 + 800,
      pendingTotal: 1000,
      rejectedCount: 1,
      byMethod: expect.arrayContaining([{ method: 'cash', amount: 6800 }, { method: 'gcash', amount: 1500 }]),
    });
  });

  it('filters by type, status and search', async () => {
    expect((await listTransactions({ type: 'design_fee' })).items.map((row) => row._id)).toEqual(['p-design']);
    expect((await listTransactions({ status: 'rejected' })).items.map((row) => row._id)).toEqual(['p-revision']);
    expect((await listTransactions({ search: 'apt-20261114' })).items.map((row) => row._id)).toEqual(['p-booking']);
    expect((await listTransactions({ search: 'RMV-2026-00010' })).items.map((row) => row._id)).toEqual(['p-stage']);
  });

  it('skips the legacy ocular lookup when another type is requested', async () => {
    await listTransactions({ type: 'project_payment' });
    expect(mockAppointmentFind).not.toHaveBeenCalled();
    expect(mockPaymentDistinct).not.toHaveBeenCalled();
  });

  it('sends the date range (Manila days) and method to the database queries', async () => {
    await listTransactions({ dateFrom: '2026-11-01', dateTo: '2026-11-10', method: 'gcash' });
    const range = { $gte: new Date('2026-11-01T00:00:00.000+08:00'), $lte: new Date('2026-11-10T23:59:59.999+08:00') };
    expect(mockPaymentFind).toHaveBeenCalledWith({ createdAt: range, method: 'gcash' });
    expect(mockAppointmentFind).toHaveBeenCalledWith(expect.objectContaining({ createdAt: range, ocularFeePaymentMethod: 'gcash' }));
  });
});

describe('transactions CSV', () => {
  const row: TransactionRow = {
    _id: 'p-1', source: 'payment', date: '2026-11-05T01:00:00.000Z', type: 'project_payment',
    description: 'Down Payment — "Main", Railings', customerName: '=HYPERLINK("x")', projectNumber: 'PRJ-2026-00095',
    method: 'bank_transfer', amount: 6000, status: 'verified', receiptNumber: 'RMV-2026-00010', hasReceipt: true,
    handledBy: 'Sean Reyes', handledAt: '2026-11-05T02:00:00.000Z',
  };

  it('writes a header row and one escaped line per transaction, in Manila time', () => {
    const [header, line] = buildTransactionsCsv([row]).replace(/^﻿/, '').split('\r\n');
    expect(header).toBe('Date,Receipt No.,Type,Description,Customer,Project ID,Appointment ID,Method,Amount,Status,Reference No.,Handled By,Handled At');
    expect(line).toBe([
      '2026-11-05 09:00', 'RMV-2026-00010', 'Project Payment', '"Down Payment — ""Main"", Railings"',
      `"'=HYPERLINK(""x"")"`, 'PRJ-2026-00095', '', 'bank transfer', '6000.00', 'verified', '', 'Sean Reyes', '2026-11-05 10:00',
    ].join(','));
  });

  it('guards cells that a spreadsheet would run as a formula', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+63917')).toBe("'+63917");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(undefined)).toBe('');
  });
});
