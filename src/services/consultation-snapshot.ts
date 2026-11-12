import type { IConsultationSnapshot } from '../models/VisitReport.js';

/**
 * Keeps a read-only copy of a consultation report's answers before the same report is moved on
 * to the ocular visit (and those fields are cleared or overwritten). Taken once; later calls keep
 * the first copy.
 */
export function snapshotConsultationReport(report: any, now: Date = new Date()): void {
  if (report.visitType !== 'consultation' || report.consultationSnapshot) return;
  const snapshot: IConsultationSnapshot = {
    appointmentId: report.appointmentId,
    status: report.status,
    serviceType: report.serviceType,
    serviceTypeCustom: report.serviceTypeCustom,
    actualVisitDateTime: report.actualVisitDateTime,
    discussionNotes: report.discussionNotes,
    consultationOutcome: report.consultationOutcome,
    noOcularReason: report.noOcularReason,
    recommendedOcularDate: report.recommendedOcularDate,
    recommendedOcularSlot: report.recommendedOcularSlot,
    recommendedOcularAddress: report.recommendedOcularAddress,
    submittedAt: report.submittedAt,
    capturedAt: now,
  };
  report.consultationSnapshot = Object.fromEntries(
    Object.entries(snapshot).filter(([, value]) => value !== undefined && value !== null),
  );
  report.markModified?.('consultationSnapshot');
}
