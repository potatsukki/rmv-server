import { DeliveryType, FabricationStatus } from './constants.js';

export const ON_SITE_FABRICATION_STAGES = [
  FabricationStatus.FABRICATION,
  FabricationStatus.WELDING_ASSEMBLY,
  FabricationStatus.INSTALLATION,
  FabricationStatus.FINISHING,
  FabricationStatus.QUALITY_CHECK,
  FabricationStatus.DONE,
];

// Keep stored history intact while exposing the new stages for existing on-site work.
const LEGACY_ON_SITE_STATUSES: Partial<Record<FabricationStatus, FabricationStatus>> = {
  [FabricationStatus.SITE_PREPARATION]: FabricationStatus.FABRICATION,
  [FabricationStatus.MEASUREMENT_LAYOUT]: FabricationStatus.FABRICATION,
  [FabricationStatus.MATERIAL_PREP]: FabricationStatus.FABRICATION,
  [FabricationStatus.CUTTING]: FabricationStatus.FABRICATION,
  [FabricationStatus.FABRICATION_INSTALLATION]: FabricationStatus.FABRICATION,
  [FabricationStatus.WELDING]: FabricationStatus.WELDING_ASSEMBLY,
  [FabricationStatus.ASSEMBLY]: FabricationStatus.WELDING_ASSEMBLY,
  [FabricationStatus.READY_FOR_DELIVERY]: FabricationStatus.QUALITY_CHECK,
  [FabricationStatus.TURNOVER]: FabricationStatus.DONE,
};

export function normalizeFabricationStatus(status: FabricationStatus, deliveryType?: string): FabricationStatus {
  return deliveryType === DeliveryType.ON_SITE_INSTALLATION
    ? LEGACY_ON_SITE_STATUSES[status] ?? status
    : status;
}
