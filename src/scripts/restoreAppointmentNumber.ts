/**
 * Put back an appointment's original number (APT-YYYYMMDD-NNNN), and the same number in its own
 * notifications. Before the 2026-11-25 fix, the automatic consultation start could replace it
 * (QA: APT-20261125-0003 became APT-20261125-0006).
 *
 * Dry run (prints what it would change):
 *   npx tsx src/scripts/restoreAppointmentNumber.ts <appointmentId> <APT-number>
 * Apply:
 *   npx tsx src/scripts/restoreAppointmentNumber.ts <appointmentId> <APT-number> --apply
 *
 * QA 2026-11-25:
 *   npx tsx src/scripts/restoreAppointmentNumber.ts 6b05260dc631d9e3415d96fd APT-20261125-0003
 */
import mongoose from 'mongoose';
import { connectDB } from '../config/database.js';
import { restoreAppointmentNumber } from '../services/appointmentNumberRestore.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const [appointmentId, number] = args.filter((arg) => arg !== '--apply');
  if (!appointmentId || !number) {
    throw new Error('Usage: npx tsx src/scripts/restoreAppointmentNumber.ts <appointmentId> <APT-number> [--apply]');
  }

  await connectDB();
  const result = await restoreAppointmentNumber(appointmentId, number, { apply });

  console.log(`Appointment ${result.appointmentId}: ${result.from ?? '(no number)'} → ${result.to}`);
  console.log(`Notifications of this appointment that show ${result.from ?? 'the old number'}: ${result.notifications}`);
  console.log(apply
    ? 'Saved. The appointment page and these notifications now show the restored number.'
    : 'Dry run: nothing written. Re-run with --apply to save.');
}

main()
  .then(async () => {
    await mongoose.connection.close();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('Restore failed:', error instanceof Error ? error.message : error);
    await mongoose.connection.close();
    process.exit(1);
  });
