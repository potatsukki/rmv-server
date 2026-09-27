import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { toZonedTime } from 'date-fns-tz';
import {
  Appointment,
  AppointmentNumberCounter,
  CustomerNumberCounter,
  User,
} from '../models/index.js';
import { Role } from '../utils/constants.js';
import {
  formatAppointmentNumber,
  formatCustomerNumber,
  generateAppointmentNumber,
  generateCustomerNumber,
} from '../utils/publicIdentifiers.js';

dotenv.config();

const TZ = 'Asia/Manila';

function customerYear(createdAt?: Date) {
  return toZonedTime(createdAt || new Date(), TZ).getFullYear();
}

function readCustomerSequence(value?: string) {
  const match = value?.match(/^CUS-(\d{4})-(\d{6})$/);
  return match ? { year: Number(match[1]), sequence: Number(match[2]) } : null;
}

function readAppointmentSequence(value?: string) {
  const match = value?.match(/^APT-(\d{8})-(\d{4})$/);
  if (!match) return null;
  const compactDate = match[1];
  return {
    date: `${compactDate.slice(0, 4)}-${compactDate.slice(4, 6)}-${compactDate.slice(6, 8)}`,
    sequence: Number(match[2]),
  };
}

async function synchronizeCounters() {
  const [numberedCustomers, numberedAppointments] = await Promise.all([
    User.find({ customerNumber: { $exists: true, $ne: '' } }).select('customerNumber').lean(),
    Appointment.find({ appointmentNumber: { $exists: true, $ne: '' } }).select('appointmentNumber').lean(),
  ]);

  const customerMax = new Map<number, number>();
  for (const customer of numberedCustomers) {
    const parsed = readCustomerSequence(customer.customerNumber);
    if (parsed) customerMax.set(parsed.year, Math.max(customerMax.get(parsed.year) || 0, parsed.sequence));
  }

  const appointmentMax = new Map<string, number>();
  for (const appointment of numberedAppointments) {
    const parsed = readAppointmentSequence(appointment.appointmentNumber);
    if (parsed) appointmentMax.set(parsed.date, Math.max(appointmentMax.get(parsed.date) || 0, parsed.sequence));
  }

  await Promise.all([
    ...[...customerMax].map(([year, lastSeq]) => CustomerNumberCounter.findOneAndUpdate(
      { year },
      { $max: { lastSeq } },
      { upsert: true, setDefaultsOnInsert: true },
    )),
    ...[...appointmentMax].map(([date, lastSeq]) => AppointmentNumberCounter.findOneAndUpdate(
      { date },
      { $max: { lastSeq } },
      { upsert: true, setDefaultsOnInsert: true },
    )),
  ]);
}

async function backfill() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) throw new Error('MONGODB_URI or MONGO_URI is required');

  await mongoose.connect(mongoUri);
  await synchronizeCounters();

  const customers = await User.find({
    roles: Role.CUSTOMER,
    $or: [
      { customerNumber: { $exists: false } },
      { customerNumber: null },
      { customerNumber: '' },
    ],
  }).select('_id createdAt').sort({ createdAt: 1, _id: 1 }).lean();

  for (const customer of customers) {
    const year = customerYear(customer.createdAt);
    const customerNumber = await generateCustomerNumber(year);
    await User.updateOne(
      { _id: customer._id, $or: [{ customerNumber: { $exists: false } }, { customerNumber: null }, { customerNumber: '' }] },
      { $set: { customerNumber } },
    );
  }

  const appointments = await Appointment.find({
    $or: [
      { appointmentNumber: { $exists: false } },
      { appointmentNumber: null },
      { appointmentNumber: '' },
    ],
  }).select('_id date createdAt').sort({ date: 1, createdAt: 1, _id: 1 }).lean();

  for (const appointment of appointments) {
    const appointmentNumber = await generateAppointmentNumber(appointment.date);
    await Appointment.updateOne(
      { _id: appointment._id, $or: [{ appointmentNumber: { $exists: false } }, { appointmentNumber: null }, { appointmentNumber: '' }] },
      { $set: { appointmentNumber } },
    );
  }

  console.log(`Assigned ${customers.length} customer IDs and ${appointments.length} appointment IDs.`);
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
