import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ chargeInfo: vi.fn() }));

vi.mock('../../models/index.js', () => ({
  Blueprint: {}, BlueprintDraft: {}, Project: {}, ProjectItem: {}, PaymentPlan: {}, User: {}, AuditLog: {},
}));
vi.mock('../notifications/socket.service.js', () => ({ createAndSendNotification: vi.fn(), notifyRole: vi.fn(), notifyUsers: vi.fn() }));
vi.mock('../notifications/email.service.js', () => ({ sendBlueprintUploadedEmail: vi.fn() }));
vi.mock('../uploads/upload.service.js', () => ({ deleteFile: vi.fn() }));
vi.mock('../config/config.service.js', () => ({ getInstallmentConfig: vi.fn(), getFeePolicyConfig: vi.fn() }));
vi.mock('../delivery/delivery-fee.service.js', () => ({ getDeliveryChargeInfo: mocks.chargeInfo }));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { buildQuotationFromDraft, resolveDraftDeliveryFee } from './blueprints.service.js';
import { DeliveryType } from '../../utils/constants.js';

const project = { _id: 'project-1', deliveryType: DeliveryType.ON_SITE_INSTALLATION };
const draftQuotation = (deliveryFee?: Record<string, unknown>) => ({
  lineItems: [{ label: 'Stainless railing', quantity: 1, materials: '20000', labor: '' }],
  workingDays: '3',
  fees: '999',
  ...(deliveryFee ? { deliveryFee } : {}),
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.chargeInfo.mockResolvedValue({ chargedHere: true });
});

describe('third-party delivery fee on the quotation', () => {
  it('bills the engineer\'s typed estimate as-is and adds it to the total', async () => {
    const delivery = await resolveDraftDeliveryFee(project, draftQuotation({ enabled: true, amount: '1,800' }));
    expect(delivery).toMatchObject({ amount: 1800, distanceKm: null, computedAmount: null, haulingTrips: 0, crewDays: 0, ratesSnapshot: [] });

    const quotation = buildQuotationFromDraft(draftQuotation(), DeliveryType.ON_SITE_INSTALLATION, delivery);
    expect(quotation).toMatchObject({ fees: 1800, total: 21800, deliveryFee: { amount: 1800 } });
    // Installment stages split the total, so the delivery fee reaches the payment plan.
    expect(quotation?.paymentMilestones?.reduce((sum, stage) => sum + (stage.amount ?? 0), 0)).toBe(21800);
  });

  it('ignores the old vehicle / trip fields', async () => {
    const delivery = await resolveDraftDeliveryFee(project, draftQuotation({
      amount: '1500', haulingVehicle: 'truck', haulingTrips: '3', crewVehicle: 'l300', crewDays: '4', overrideReason: 'x',
    }));
    expect(delivery).toMatchObject({ amount: 1500, haulingTrips: 0, crewDays: 0 });
    expect(delivery).not.toHaveProperty('overrideReason');
  });

  it('requires an amount when delivery is charged (0 means no charge)', async () => {
    await expect(resolveDraftDeliveryFee(project, draftQuotation({ amount: '' }))).rejects.toThrow('Enter the third-party delivery fee');
    await expect(resolveDraftDeliveryFee(project, draftQuotation({ amount: '0' }))).resolves.toMatchObject({ amount: 0 });
  });

  it('charges nothing when delivery is turned off or billed on another item', async () => {
    expect(await resolveDraftDeliveryFee(project, draftQuotation({ enabled: false }))).toBeNull();
    expect(mocks.chargeInfo).not.toHaveBeenCalled();

    mocks.chargeInfo.mockResolvedValue({ chargedHere: false, primaryItemTitle: 'Railing', message: 'x' });
    expect(await resolveDraftDeliveryFee(project, draftQuotation({ amount: '1800' }), 'item-2')).toBeNull();
    expect(mocks.chargeInfo).toHaveBeenCalledWith('project-1', 'item-2');

    const quotation = buildQuotationFromDraft(draftQuotation(), DeliveryType.ON_SITE_INSTALLATION, null);
    expect(quotation).toMatchObject({ fees: 0, total: 20000 });
    expect(quotation?.deliveryFee).toBeUndefined();
  });

  it('keeps the typed fees for drafts saved before the delivery fee existed', async () => {
    expect(await resolveDraftDeliveryFee(project, draftQuotation())).toBeUndefined();
    expect(buildQuotationFromDraft(draftQuotation(), DeliveryType.ON_SITE_INSTALLATION, undefined))
      .toMatchObject({ fees: 999, total: 20999 });
  });
});
