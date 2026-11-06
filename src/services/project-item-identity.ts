import type { Types } from 'mongoose';
import { ProjectItem } from '../models/index.js';

interface ReportIdentitySource {
  _id?: Types.ObjectId | string;
  serviceType?: string;
  selectedDesignTemplateId?: string | null;
  projectItemId?: Types.ObjectId | string | null;
}

/** `design:<id>` for a report/item that belongs to one customer-selected design, else undefined. */
export function designItemKey(source?: { selectedDesignTemplateId?: string | null } | null) {
  const id = source?.selectedDesignTemplateId?.trim();
  return id ? `design:${id}` : undefined;
}

/**
 * Upsert filter for the project item that mirrors a visit report.
 * 1. The item already linked to this report (survives consultation → ocular promotion).
 * 2. Otherwise the item for the report's design, so several designs of one service stay separate.
 * 3. Otherwise the design-less item of the report's service (pre-design behavior).
 */
export async function projectItemFilterForReport(
  projectId: Types.ObjectId | string,
  report: ReportIdentitySource,
): Promise<Record<string, unknown>> {
  const serviceType = report.serviceType || 'custom';
  const links: Record<string, unknown>[] = [];
  if (report.projectItemId) links.push({ _id: report.projectItemId });
  if (report._id) {
    links.push({ consultationVisitReportId: report._id }, { ocularVisitReportId: report._id });
  }

  if (links.length) {
    const linked = await ProjectItem.findOne({ projectId, $or: links }, { _id: 1 });
    if (linked) return { _id: linked._id };
  }

  const designId = report.selectedDesignTemplateId?.trim();
  if (designId) {
    return { projectId, serviceType, selectedDesignTemplateId: designId };
  }

  // No design: reuse the design-less item of this service, or an unlinked item of this service
  // (older items may carry the project's design without being tied to a report).
  const reusable = await ProjectItem.findOne({ projectId, serviceType, selectedDesignTemplateId: null }, { _id: 1 })
    || await ProjectItem.findOne({
      projectId,
      serviceType,
      consultationVisitReportId: null,
      ocularVisitReportId: null,
    }, { _id: 1 });
  if (reusable) return { _id: reusable._id };

  return { projectId, serviceType, selectedDesignTemplateId: null };
}
