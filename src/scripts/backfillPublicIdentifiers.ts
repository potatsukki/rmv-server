import mongoose from 'mongoose';
import dotenv from 'dotenv';
import {
  formatAppointmentNumber,
  formatCustomerNumber,
} from '../utils/publicIdentifiers.js';
import { backfillPublicIdentifiers } from '../services/publicIdentifierBackfill.js';

dotenv.config();

async function backfill() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) throw new Error('MONGODB_URI or MONGO_URI is required');

  await mongoose.connect(mongoUri);
  const result = await backfillPublicIdentifiers();

  console.log(`Assigned ${result.customers} customer IDs and ${result.appointments} appointment IDs.`);
  console.log(`Examples: ${formatCustomerNumber(2026, 1)} and ${formatAppointmentNumber('2026-09-27', 1)}.`);
}

backfill()
  .catch((error) => {
    console.error('Public identifier backfill failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close();
  });
