import { describe, expect, it, vi } from 'vitest';

vi.mock('../../models/index.js', () => ({ FabricationUpdate: {}, Holiday: {}, Project: {}, ProjectItem: {}, User: {} }));

import { deliveryDateUnlockStage, stageReachesDeliveryUnlock } from './fabrication-scheduling.js';
import { DeliveryType, FabricationStatus } from '../../utils/constants.js';

describe('delivery / installation date unlock', () => {
  // QA 2026-11-27: the installation date (and the customer's confirmation banner) must not show
  // while the work is still at Welding; it opens at Quality Check, right before Installation.
  it('opens on-site installation at Quality Check, the last workshop stage before Installation', () => {
    const onSite = DeliveryType.ON_SITE_INSTALLATION;
    expect(deliveryDateUnlockStage(onSite)).toEqual({ stage: FabricationStatus.QUALITY_CHECK, label: 'Quality Check' });
    expect(stageReachesDeliveryUnlock(undefined, onSite)).toBe(false);
    expect(stageReachesDeliveryUnlock(FabricationStatus.FABRICATION, onSite)).toBe(false);
    expect(stageReachesDeliveryUnlock(FabricationStatus.WELDING_ASSEMBLY, onSite)).toBe(false);
    expect(stageReachesDeliveryUnlock(FabricationStatus.FINISHING, onSite)).toBe(false);
    expect(stageReachesDeliveryUnlock(FabricationStatus.QUALITY_CHECK, onSite)).toBe(true);
    expect(stageReachesDeliveryUnlock(FabricationStatus.INSTALLATION, onSite)).toBe(true);
    // Legacy on-site history is normalized (Assembly → Welding / Assembly, Ready for Delivery → Quality Check).
    expect(stageReachesDeliveryUnlock(FabricationStatus.ASSEMBLY, onSite)).toBe(false);
    expect(stageReachesDeliveryUnlock(FabricationStatus.READY_FOR_DELIVERY, onSite)).toBe(true);
  });

  it('opens shop delivery at Quality Check, before Ready for Delivery', () => {
    const shop = DeliveryType.SHOP_FABRICATED;
    expect(deliveryDateUnlockStage(shop).label).toBe('Quality Check');
    expect(stageReachesDeliveryUnlock(FabricationStatus.ASSEMBLY, shop)).toBe(false);
    expect(stageReachesDeliveryUnlock(FabricationStatus.FINISHING, shop)).toBe(false);
    expect(stageReachesDeliveryUnlock(FabricationStatus.QUALITY_CHECK, shop)).toBe(true);
    expect(stageReachesDeliveryUnlock(FabricationStatus.READY_FOR_DELIVERY, shop)).toBe(true);
    expect(stageReachesDeliveryUnlock(FabricationStatus.QUALITY_CHECK, undefined)).toBe(true);
  });
});
