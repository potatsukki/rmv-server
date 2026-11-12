/**
 * Backfill VisitReport.submittedAt for reports submitted before the field existed, using the
 * latest "visit_report_submitted" audit log entry of each report.
 *
 * Dry run (prints what it would change):
 *   npx tsx src/scripts/backfillVisitReportSubmittedAt.ts
 * Apply:
 *   npx tsx src/scripts/backfillVisitReportSubmittedAt.ts --apply
 *
 * Safe to run more than once: reports that already have submittedAt are skipped.
 */
import mongoose from 'mongoose';
import { connectDB } from '../config/database.js';
import { AuditLog, VisitReport, VisitReportStatus } from '../models/index.js';
import { AuditAction } from '../utils/constants.js';

async function backfillVisitReportSubmittedAt(apply: boolean): Promise<void> {
  await connectDB();

  const reports = await VisitReport.find({
    status: { $in: [VisitReportStatus.SUBMITTED, VisitReportStatus.COMPLETED] },
    submittedAt: { $exists: false },
  })
    .select('_id')
    .lean();

  const latestSubmissions = await AuditLog.aggregate<{ _id: mongoose.Types.ObjectId; submittedAt: Date }>([
    {
      $match: {
        action: AuditAction.VISIT_REPORT_SUBMITTED,
        targetType: 'visit_report',
        targetId: { $in: reports.map((report) => report._id) },
      },
    },
    { $group: { _id: '$targetId', submittedAt: { $max: '$createdAt' } } },
  ]);
  const submittedAtById = new Map(latestSubmissions.map((entry) => [entry._id.toString(), entry.submittedAt]));

  let found = 0;
  for (const report of reports) {
    const submittedAt = submittedAtById.get(report._id.toString());
    if (!submittedAt) continue;
    found += 1;
    if (apply) {
      // updateOne with timestamps off: filling in history must not bump updatedAt.
      await VisitReport.updateOne({ _id: report._id }, { $set: { submittedAt } }, { timestamps: false });
    }
  }

  console.log(`${reports.length} submitted report(s) without submittedAt; ${found} have a submission audit entry.`);
  console.log(apply
    ? `Updated ${found} report(s).`
    : 'Dry run: nothing written. Re-run with --apply to save.');
}

backfillVisitReportSubmittedAt(process.argv.includes('--apply'))
  .then(async () => {
    await mongoose.connection.close();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('Backfill failed:', error);
    await mongoose.connection.close();
    process.exit(1);
  });
