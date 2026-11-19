import { ProjectItem } from '../../models/index.js';

/** Delivery is charged once per project, on its first item. */
export async function resolveDeliveryChargeItem(projectId: unknown, projectItemId?: string) {
  const items = await ProjectItem.find({ projectId: String(projectId) }).sort({ createdAt: 1 }).select('_id title').lean();
  if (items.length <= 1) return { chargedHere: true as const };
  const primary = items[0]!;
  if (projectItemId && String(primary._id) === projectItemId) return { chargedHere: true as const };
  return { chargedHere: false as const, primaryItemTitle: primary.title || 'Item 1' };
}

export type DeliveryChargeInfo =
  | { chargedHere: true }
  | { chargedHere: false; primaryItemTitle: string; message: string };

/**
 * Where the third-party delivery fee goes. The engineer types the courier's estimated fee
 * (e.g. Lalamove, booked by RMV outside the system); nothing is computed here.
 */
export async function getDeliveryChargeInfo(projectId: unknown, projectItemId?: string): Promise<DeliveryChargeInfo> {
  const chargeItem = await resolveDeliveryChargeItem(projectId, projectItemId);
  if (chargeItem.chargedHere) return { chargedHere: true };
  return {
    chargedHere: false,
    primaryItemTitle: chargeItem.primaryItemTitle,
    message: `The delivery fee is charged once per project, on "${chargeItem.primaryItemTitle}".`,
  };
}
