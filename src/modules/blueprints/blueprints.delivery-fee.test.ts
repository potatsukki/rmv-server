import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ estimate: vi.fn() }));

vi.mock('../../models/index.js', () => ({
  Blueprint: {}, BlueprintDraft: {}, Project: {}, ProjectItem: {}, PaymentPlan: {}, User: {}, AuditLog: {},
}));
vi.mock('../notifications/socket.service.js', () => ({ createAndSendNotification: vi.fn(), notifyRole: vi.fn(), notifyUsers: vi.fn() }));
vi.mock('../notifications/email.service.js', () => ({ sendBlueprintUploadedEmail: vi.fn() }));
vi.mock('../uploads/upload.service.js', () => ({ deleteFile: vi.fn() }));
vi.mock('../config/config.service.js', () => ({ getInstallmentConfig: vi.fn(), getFeePolicyConfig: vi.fn() }));
vi.mock('../delivery/delivery-fee.service.js', () => ({ estimateProjectDeliveryFee: mocks.estimate }));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { buildQuotationFromDraft, resolveDraftDeliveryFee } from './blueprints.service.js';
import { DeliveryType } from '../../utils/constants.js';

const project = { _id: 'project-1', deliveryType: DeliveryType.ON_SITE_INSTALLATION, ocularAppointmentId: 'ocular-1' };
const breakdown = {
  distanceKm: 25, haulingVehicle: 'truck', haulingTrips: 1, haulingTripCost: 2550, hauling: 2550,
  crewVehicle: 'l300', crewDays: 3, crewTripCost: 1400, crew: 4200, computedAmount: 6750,
  ratesSnapshot: [{ key: 'truck', label: 'Truck', baseFee: 1500, baseCoveredKm: 10, perKmRate: 70 }],
};
const draftQuotation = (deliveryFee?: Record<string, unknown>) => ({
  lineItems: [{ label: 'Stainless railing', quantity: 1, materials: '20000', labor: '' }],
  workingDays: '3',
  fees: '999',
  ...(deliveryFee ? { deliveryFee } : {}),
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.estimate.mockResolvedValue({ available: true, siteAddress: 'Antipolo', defaults: {}, breakdown, vehicles: [] });
});

describe('delivery fee on the quotation', () => {
  it('bills the server-computed fee and adds it to the total', async () => {
    const delivery = await resolveDraftDeliveryFee(project, draftQuotation({ enabled: true, amount: '' }));
    expect(delivery).toMatchObject({ amount: 6750, computedAmount: 6750, overrideReason: undefined });
    expect(mocks.estimate).toHaveBeenCalledWith(project, expect.objectContaining({ workingDays: 3 }));

    const quotation = buildQuotationFromDraft(draftQuotation(), DeliveryType.ON_SITE_INSTALLATION, delivery);
    expect(quotation).toMatchObject({ fees: 6750, total: 26750, deliveryFee: { amount: 6750, distanceKm: 25 } });
    expect(quotation?.internalCosts?.deliveryMobilization).toBe(6750);
    // Installment stages split the total, so the delivery fee reaches the payment plan.
    expect(quotation?.paymentMilestones?.reduce((sum, stage) => sum + (stage.amount ?? 0), 0)).toBe(26750);
  });

  it('requires a reason when the engineer changes the computed amount', async () => {
    await expect(resolveDraftDeliveryFee(project, draftQuotation({ amount: '5000' })))
      .rejects.toThrow('Give a reason');
    await expect(resolveDraftDeliveryFee(project, draftQuotation({ amount: '5000', overrideReason: 'Shared trip with another job' })))
      .resolves.toMatchObject({ amount: 5000, computedAmount: 6750, overrideReason: 'Shared trip with another job' });
  });

  it('charges nothing when delivery is turned off or billed on another item', async () => {
    expect(await resolveDraftDeliveryFee(project, draftQuotation({ enabled: false }))).toBeNull();
    expect(mocks.estimate).not.toHaveBeenCalled();

    mocks.estimate.mockResolvedValue({ available: false, reason: 'charged_on_other_item', message: 'x', vehicles: [] });
    expect(await resolveDraftDeliveryFee(project, draftQuotation({}), 'item-2')).toBeNull();

    const quotation = buildQuotationFromDraft(draftQuotation(), DeliveryType.ON_SITE_INSTALLATION, null);
    expect(quotation).toMatchObject({ fees: 0, total: 20000 });
    expect(quotation?.deliveryFee).toBeUndefined();
  });

  it('takes a manual amount when the road distance is unavailable', async () => {
    mocks.estimate.mockResolvedValue({ available: false, reason: 'no_site_location', message: 'No site location on file.', vehicles: [] });
    await expect(resolveDraftDeliveryFee(project, draftQuotation({ amount: '' }))).rejects.toThrow('Enter 0 if there is no delivery charge');
    await expect(resolveDraftDeliveryFee(project, draftQuotation({ amount: '1800' })))
      .resolves.toMatchObject({ amount: 1800, computedAmount: null, distanceKm: null });
  });

  it('keeps the typed fees for drafts saved before the delivery fee existed', async () => {
    expect(await resolveDraftDeliveryFee(project, draftQuotation())).toBeUndefined();
    expect(buildQuotationFromDraft(draftQuotation(), DeliveryType.ON_SITE_INSTALLATION, undefined))
      .toMatchObject({ fees: 999, total: 20999 });
  });
});
