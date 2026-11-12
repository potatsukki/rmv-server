import { describe, expect, it } from 'vitest';
import { snapshotConsultationReport } from './consultation-snapshot.js';

describe('snapshotConsultationReport', () => {
  const now = new Date('2026-11-10T02:00:00Z');

  it('copies the consultation answers once, before they are cleared', () => {
    const report: Record<string, any> = {
      visitType: 'consultation', status: 'submitted', appointmentId: 'consultation-1',
      consultationOutcome: 'no_ocular', noOcularReason: 'Decided on the project',
      actualVisitDateTime: new Date('2026-11-10T01:00:00Z'), discussionNotes: 'Balcony railing',
      submittedAt: new Date('2026-11-10T01:30:00Z'),
    };
    snapshotConsultationReport(report, now);
    report.visitType = 'ocular';
    report.consultationOutcome = undefined;
    snapshotConsultationReport(report, new Date());

    expect(report.consultationSnapshot).toEqual({
      appointmentId: 'consultation-1', status: 'submitted', consultationOutcome: 'no_ocular',
      noOcularReason: 'Decided on the project', actualVisitDateTime: new Date('2026-11-10T01:00:00Z'),
      discussionNotes: 'Balcony railing', submittedAt: new Date('2026-11-10T01:30:00Z'), capturedAt: now,
    });
  });

  it('leaves ocular reports alone', () => {
    const report: Record<string, any> = { visitType: 'ocular' };
    snapshotConsultationReport(report, now);
    expect(report.consultationSnapshot).toBeUndefined();
  });
});
