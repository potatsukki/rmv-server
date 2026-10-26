import type { Model } from 'mongoose';
import { Blueprint, PaymentPlan, Project } from '../models/index.js';
import { installmentMilestoneTexts } from '../modules/blueprints/blueprints.service.js';
import { DeliveryType } from '../utils/constants.js';

const OLD_SECOND_LABEL = 'During Fabrication';
const OLD_FINAL_DESCRIPTION = '30% payable when fabrication is completed.';

/**
 * Relabels installment stages saved before the 2nd payment moved to Installation
 * (Ready for Delivery for shop work) and the final payment to Done. Only the old texts
 * match, so later runs change nothing. Receipts and generated contracts stay as issued.
 */
export async function backfillInstallmentStageTexts() {
  const onSiteProjectIds = await Project.distinct('_id', { deliveryType: DeliveryType.ON_SITE_INSTALLATION });
  const onSite = installmentMilestoneTexts(DeliveryType.ON_SITE_INSTALLATION);
  const shop = installmentMilestoneTexts(DeliveryType.SHOP_FABRICATED);

  async function relabel(model: Model<any>, path: string) {
    let modified = 0;
    for (const [projectId, { second }] of [
      [{ $in: onSiteProjectIds }, onSite],
      [{ $nin: onSiteProjectIds }, shop],
    ] as const) {
      const result = await model.updateMany(
        { projectId, [`${path}.label`]: OLD_SECOND_LABEL },
        { $set: { [`${path}.$[stage].label`]: second.label, [`${path}.$[stage].description`]: second.description } },
        { arrayFilters: [{ 'stage.label': OLD_SECOND_LABEL }] },
      );
      modified += result.modifiedCount;
    }
    const result = await model.updateMany(
      { [`${path}.description`]: OLD_FINAL_DESCRIPTION },
      { $set: { [`${path}.$[stage].description`]: onSite.final.description } },
      { arrayFilters: [{ 'stage.description': OLD_FINAL_DESCRIPTION }] },
    );
    return modified + result.modifiedCount;
  }

  return await relabel(PaymentPlan, 'stages') + await relabel(Blueprint, 'quotation.paymentMilestones');
}
