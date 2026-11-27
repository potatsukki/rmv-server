import { DeliveryType, FabricationStatus } from './constants.js';

// Installation is the last workshop-to-site step: the work is finished and checked in the shop
// first, then installed (user decision 2026-11-27, QA "pa-ayos").
export const ON_SITE_FABRICATION_STAGES = [
  FabricationStatus.FABRICATION,
  FabricationStatus.WELDING_ASSEMBLY,
  FabricationStatus.FINISHING,
  FabricationStatus.QUALITY_CHECK,
  FabricationStatus.INSTALLATION,
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

export const SHOP_FABRICATION_STAGES = [
  FabricationStatus.MATERIAL_PREP,
  FabricationStatus.CUTTING,
  FabricationStatus.WELDING,
  FabricationStatus.ASSEMBLY,
  FabricationStatus.FINISHING,
  FabricationStatus.QUALITY_CHECK,
  FabricationStatus.READY_FOR_DELIVERY,
  FabricationStatus.DONE,
];

export function fabricationStageOrder(deliveryType?: string) {
  return deliveryType === DeliveryType.ON_SITE_INSTALLATION ? ON_SITE_FABRICATION_STAGES : SHOP_FABRICATION_STAGES;
}

/**
 * How far a project's fabrication is: the number of stages reached (0 before the first update)
 * out of the stage count, with the latest stored status normalized for legacy on-site history.
 */
export function fabricationProgress(latestStatus: string | undefined, deliveryType?: string) {
  const order = fabricationStageOrder(deliveryType);
  const stage = latestStatus ? normalizeFabricationStatus(latestStatus as FabricationStatus, deliveryType) : null;
  const index = stage ? order.indexOf(stage) : -1;
  const reached = index + 1;
  return {
    currentStage: stage && index >= 0 ? stage : null,
    stageIndex: reached,
    stageCount: order.length,
    progressPercent: Math.round((reached / order.length) * 100),
  };
}

export function normalizeFabricationStatus(status: FabricationStatus, deliveryType?: string): FabricationStatus {
  return deliveryType === DeliveryType.ON_SITE_INSTALLATION
    ? LEGACY_ON_SITE_STATUSES[status] ?? status
    : status;
}
