import { describe, expect, it } from 'vitest';
import { FabricationUpdate } from '../models/FabricationUpdate.js';
import { createFabricationUpdateSchema } from '../modules/fabrication/fabrication.validation.js';
import { DeliveryType, FabricationStatus } from './constants.js';
import { normalizeFabricationStatus } from './fabricationLifecycle.js';

describe('fabrication lifecycle compatibility and validation', () => {
  it.each([
    [FabricationStatus.SITE_PREPARATION, 'fabrication'],
    [FabricationStatus.MEASUREMENT_LAYOUT, 'fabrication'],
    [FabricationStatus.MATERIAL_PREP, 'fabrication'],
    [FabricationStatus.CUTTING, 'fabrication'],
    [FabricationStatus.FABRICATION_INSTALLATION, 'fabrication'],
    [FabricationStatus.WELDING, 'welding_assembly'],
    [FabricationStatus.ASSEMBLY, 'welding_assembly'],
    [FabricationStatus.READY_FOR_DELIVERY, 'quality_check'],
    [FabricationStatus.TURNOVER, 'done'],
  ])('maps legacy %s only on on-site projects', (legacyStatus, expected) => {
    expect(normalizeFabricationStatus(legacyStatus, DeliveryType.ON_SITE_INSTALLATION)).toBe(expected);
    expect(normalizeFabricationStatus(legacyStatus, DeliveryType.SHOP_FABRICATED)).toBe(legacyStatus);
    expect(normalizeFabricationStatus(legacyStatus)).toBe(legacyStatus);
  });

  it.each(['fabrication', 'welding_assembly', 'installation', 'finishing', 'quality_check', 'done'])('accepts canonical %s in API validation and the database model', (status) => {
    const data = { projectId: '000000000000000000000001', updatedBy: '000000000000000000000002', status, notes: 'Progress recorded.' };
    expect(createFabricationUpdateSchema.safeParse(data).success).toBe(true);
    expect(new FabricationUpdate(data).validateSync()).toBeUndefined();
    expect(normalizeFabricationStatus(status as FabricationStatus, DeliveryType.ON_SITE_INSTALLATION)).toBe(status);
  });

  it('keeps legacy stored statuses valid when only notes or photos are edited', () => {
    const update = new FabricationUpdate({ projectId: '000000000000000000000001', updatedBy: '000000000000000000000002', status: FabricationStatus.TURNOVER, notes: 'Original history.' });
    update.notes = 'Corrected notes.';
    expect(update.validateSync()).toBeUndefined();
    expect(update.status).toBe(FabricationStatus.TURNOVER);
  });
});
