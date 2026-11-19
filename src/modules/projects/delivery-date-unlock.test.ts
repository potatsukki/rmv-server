import { describe, expect, it, vi } from 'vitest';

vi.mock('../../models/index.js', () => ({ FabricationUpdate: {}, Holiday: {}, Project: {}, User: {} }));

import { deliveryDateUnlockStage, stageReachesDeliveryUnlock } from './fabrication-scheduling.js';
import { DeliveryType, FabricationStatus } from '../../utils/constants.js';

describe('delivery / installation date unlock', () => {
  it('opens on-site installation at Welding / Assembly, the last workshop stage before Installation', () => {
    const onSite = DeliveryType.ON_SITE_INSTALLATION;
    expect(deliveryDateUnlockStage(onSite)).toEqual({ stage: FabricationStatus.WELDING_ASSEMBLY, label: 'Welding / Assembly' });
    expect(stageReachesDeliveryUnlock(undefined, onSite)).toBe(false);
    expect(stageReachesDeliveryUnlock(FabricationStatus.FABRICATION, onSite)).toBe(false);
    expect(stageReachesDeliveryUnlock(FabricationStatus.WELDING_ASSEMBLY, onSite)).toBe(true);
    expect(stageReachesDeliveryUnlock(FabricationStatus.INSTALLATION, onSite)).toBe(true);
    // Legacy on-site history is normalized (Assembly → Welding / Assembly, Cutting → Fabrication).
    expect(stageReachesDeliveryUnlock(FabricationStatus.ASSEMBLY, onSite)).toBe(true);
    expect(stageReachesDeliveryUnlock(FabricationStatus.CUTTING, onSite)).toBe(false);
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
