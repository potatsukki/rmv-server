/**
 * On-site cash during the ocular visit, against a REAL, throwaway MongoDB database:
 * the sales staff records the ocular fee and the design fee in cash (paid at once, receipt issued),
 * then the cashier receives the turnover in Cash Flow (exact amount → received, short → discrepancy).
 *
 * Skipped unless RMV_MONGO_TEST_URI points at a local database, e.g.
 *   RMV_MONGO_TEST_URI=mongodb://127.0.0.1:27017/rmv_repro_onsite_fee npx vitest run onsite-fee.integration
 * The database named in the URI is dropped before and after the run. Never point it at real data.
 * With other real-DB test files, run them one at a time (--no-file-parallelism): they share the database.
 */
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const stubAll = vi.hoisted(() => (module: Record<string, unknown>) => Object.fromEntries(
  Object.entries(module).map(([key, value]) => [key, typeof value === 'function' ? vi.fn() : value]),
));

vi.mock('../notifications/socket.service.js', async (importOriginal) => stubAll(await importOriginal()));
vi.mock('../notifications/email.service.js', async (importOriginal) => stubAll(await importOriginal()));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
// Receipt PDFs are generated for real; only the file storage upload is stubbed.
vi.mock('../../config/r2.js', () => ({ r2Client: { send: vi.fn(async () => ({})) } }));

import {
  Appointment, CashCollection, CashDiscrepancy, Payment, Project, User,
} from '../../models/index.js';
import {
  AppointmentStatus, AppointmentType, CashCollectionStatus, PaymentMethod, PaymentStageStatus, Role,
} from '../../utils/constants.js';
import { collectDesignFeeOnSite, collectOcularFeeOnSite } from './onsite-fee.service.js';
import { receiveCash, resolveDiscrepancy } from './cash.service.js';
import { recordBookingCash } from '../payments/gcash.service.js';
import { assertDesignFeeAllowsBlueprint } from '../projects/design-fee.service.js';

const MONGO_URI = process.env.RMV_MONGO_TEST_URI;

async function createUser(email: string, roles: Role[]) {
  return User.create({ email, firstName: email.split('@')[0], lastName: 'Test', roles, isActive: true });
}

describe.runIf(Boolean(MONGO_URI))('on-site cash during the ocular visit (real database)', () => {
  let customerId: string;
  let salesId: string;
  let otherSalesId: string;
  let cashierId: string;

  beforeAll(async () => {
    await mongoose.connect(MONGO_URI!);
    if (!mongoose.connection.name.includes('repro') && !mongoose.connection.name.includes('test')) {
      throw new Error(`Refusing to use database "${mongoose.connection.name}": its name must contain "repro" or "test".`);
    }
    await mongoose.connection.dropDatabase();
    for (const model of [User, Appointment, Project, Payment, CashCollection]) await model.syncIndexes();
  }, 60_000);

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  beforeEach(async () => {
    await Promise.all(Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})));
    customerId = String((await createUser('customer01@example.test', [Role.CUSTOMER]))._id);
    salesId = String((await createUser('salesstaff01@example.test', [Role.SALES_STAFF]))._id);
    otherSalesId = String((await createUser('salesstaff02@example.test', [Role.SALES_STAFF]))._id);
    cashierId = String((await createUser('cashier01@example.test', [Role.CASHIER]))._id);
  });

  /** An outside-NCR ocular visit in progress; the customer chose "Cash / Pay On-site" online. */
  async function ocularInProgress() {
    const ocular = await Appointment.create({
      customerId,
      type: AppointmentType.OCULAR,
      date: '2026-11-26',
      slotCode: '10:00',
      status: AppointmentStatus.IN_PROGRESS,
      salesStaffId: salesId,
      bookedBy: salesId,
      serviceTypes: ['railings'],
      formattedAddress: 'Calamba, Laguna',
      customerLocation: { lat: 14.21, lng: 121.16 },
      ocularFee: 650,
      ocularFeeBreakdown: {
        label: 'Outside NCR', baseFee: 350, baseCoveredKm: 6, perKmRate: 60,
        additionalDistanceKm: 5, additionalFee: 300, total: 650, isWithinNCR: false,
      },
      ocularFeeStatus: 'cash_pending',
      ocularFeePaymentMethod: PaymentMethod.CASH,
      ocularFeeNonRefundableAckAt: new Date(),
      paymentStatus: 'unpaid',
      bookingStatus: 'pending_payment',
    });
    await Payment.create({
      bookingId: ocular._id, customerId, stageId: `ocular-${ocular._id}`, method: PaymentMethod.CASH,
      amountRequired: 650, amountPaid: 0, status: PaymentStageStatus.PENDING, paymentStatus: 'unpaid',
    });
    return ocular;
  }

  it('records the ocular fee at the site: paid with an acknowledgement (no receipt yet), and the cashier can no longer record it twice', async () => {
    const ocular = await ocularInProgress();

    await expect(collectOcularFeeOnSite(String(ocular._id), otherSalesId, {})).rejects.toThrow('Only the sales staff assigned');

    const result = await collectOcularFeeOnSite(String(ocular._id), salesId, { notes: 'Exact amount' });
    expect(result.collectionNumber).toMatch(/^CC-\d{4}-\d{5}$/);

    const saved = await Appointment.findById(ocular._id).lean();
    // The ocular report checks exactly this flag before it can be submitted.
    expect(saved).toMatchObject({ ocularFeePaid: true, ocularFeeStatus: 'verified', paymentStatus: 'paid', ocularFeePaymentMethod: 'cash' });
    expect(String(saved?.ocularFeeVerifiedBy)).toBe(salesId);
    // Its appointment number is untouched by the update.
    expect(saved?.appointmentNumber).toBe(ocular.appointmentNumber);

    const payments = await Payment.find({ bookingId: ocular._id }).lean();
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ paymentStatus: 'paid', status: 'verified', amountPaid: 650 });
    expect(payments[0]!.receiptNumber).toBeUndefined();
    expect(payments[0]!.evidenceTrail.at(-1)).toMatchObject({ source: 'sales_staff_onsite_cash', note: 'Exact amount' });

    const collection = await CashCollection.findOne({ appointmentId: ocular._id }).lean();
    expect(collection).toMatchObject({
      feeType: 'ocular_fee', amountCollected: 650, status: CashCollectionStatus.COLLECTED, collectionNumber: result.collectionNumber,
    });
    expect(collection?.receiptNumber).toBeUndefined();

    await expect(recordBookingCash(String(ocular._id), cashierId, [Role.CASHIER])).rejects.toThrow();
    await expect(collectOcularFeeOnSite(String(ocular._id), salesId, {})).rejects.toThrow('already paid');
  });

  it('records the design fee after the ocular visit, so the blueprint can start', async () => {
    const ocular = await ocularInProgress();
    await Appointment.updateOne({ _id: ocular._id }, { $set: { status: AppointmentStatus.COMPLETED } });
    // The project stays with its own sales staff; the ocular visit was handed over to salesId.
    const project = await Project.create({
      projectNumber: 'PRJ-2026-09001', customerId, salesStaffId: otherSalesId, title: 'Terrace railing',
      serviceType: 'railings', ocularAppointmentId: ocular._id,
      designFee: { amount: 1000, status: 'pending', dueAt: new Date() },
    });

    await expect(collectDesignFeeOnSite(String(project._id), salesId, {})).rejects.toThrow('non-refundable');
    const result = await collectDesignFeeOnSite(String(project._id), salesId, { customerAcknowledgedInPerson: true });
    expect(result.collectionNumber).toMatch(/^CC-\d{4}-\d{5}$/);

    const saved = await Project.findById(project._id).lean();
    expect(saved?.designFee).toMatchObject({ status: 'verified', method: 'cash', acknowledgedVia: 'in_person' });
    expect(saved?.designFee?.receiptNumber).toBeUndefined();
    expect(() => assertDesignFeeAllowsBlueprint(saved!)).not.toThrow();

    const payment = await Payment.findOne({ stageId: `design-fee-${project._id}` }).lean();
    expect(payment).toMatchObject({ paymentStatus: 'paid', amountPaid: 1000 });
    expect(payment?.receiptNumber).toBeUndefined();
    expect(payment!.evidenceTrail.at(-1)).toMatchObject({ source: 'sales_staff_onsite_cash' });

    const collection = await CashCollection.findOne({ projectId: project._id });
    expect(collection).toMatchObject({ feeType: 'design_fee', amountCollected: 1000, status: CashCollectionStatus.COLLECTED });
    expect(String(collection?.appointmentId)).toBe(String(ocular._id));

    // The cashier receives the cash: now the official receipt is issued, in the cashier's name.
    await receiveCash(String(collection!._id), { amountReceived: 1000 }, cashierId);
    const receipted = await Payment.findOne({ stageId: `design-fee-${project._id}` }).lean();
    expect(receipted?.receiptNumber).toMatch(/^RMV-\d{4}-\d{5}$/);
    expect((await Project.findById(project._id).lean())?.designFee?.receiptNumber).toBe(receipted?.receiptNumber);
    expect((await CashCollection.findById(collection!._id).lean())?.receiptNumber).toBe(receipted?.receiptNumber);
  });

  it('issues the official receipt when the cashier receives the turnover; a short amount waits for the admin', async () => {
    const first = await ocularInProgress();
    const { collection: exact } = await collectOcularFeeOnSite(String(first._id), salesId, {});
    await receiveCash(String(exact._id), { amountReceived: 650 }, cashierId);
    const received = await CashCollection.findById(exact._id).lean();
    expect(received).toMatchObject({ status: CashCollectionStatus.RECEIVED, receiptNumber: expect.stringMatching(/^RMV-\d{4}-\d{5}$/) });
    expect((await Payment.findById(exact.paymentId).lean())?.receiptNumber).toBe(received?.receiptNumber);
    // A second collection gets the next acknowledgement number.
    const second = await ocularInProgress();
    const { collection: short } = await collectOcularFeeOnSite(String(second._id), salesId, {});
    expect(short.collectionNumber).not.toBe(exact.collectionNumber);

    await receiveCash(String(short._id), { amountReceived: 600 }, cashierId);
    expect((await CashCollection.findById(short._id).lean())).toMatchObject({ status: CashCollectionStatus.DISCREPANCY });
    expect((await CashCollection.findById(short._id).lean())?.receiptNumber).toBeUndefined();
    const discrepancy = await CashDiscrepancy.findOne({ cashCollectionId: short._id }).lean();
    expect(discrepancy).toMatchObject({ difference: 50 });
    // The customer's payment stays paid; the receipt waits for the admin to resolve the difference.
    expect((await Appointment.findById(second._id).lean())?.ocularFeePaid).toBe(true);

    await resolveDiscrepancy(String(discrepancy!._id), { resolutionNotes: 'Staff paid the ₱50 shortfall' }, cashierId);
    expect((await CashCollection.findById(short._id).lean())?.receiptNumber).toMatch(/^RMV-\d{4}-\d{5}$/);
  });
});
