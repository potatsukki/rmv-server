import { toZonedTime } from 'date-fns-tz';
import { Appointment } from '../models/Appointment.js';
import {
  AppointmentNumberCounter,
  CustomerNumberCounter,
} from '../models/Config.js';
import { User } from '../models/User.js';
import { Role } from '../utils/constants.js';
import {
  generateAppointmentNumber,
  generateCustomerNumber,
} from '../utils/publicIdentifiers.js';

const TZ = 'Asia/Manila';

const missingCustomerNumberFilter = {
  roles: Role.CUSTOMER,
  $or: [
    { customerNumber: { $exists: false } },
    { customerNumber: null },
    { customerNumber: '' },
  ],
};

const missingAppointmentNumberFilter = {
  $or: [
    { appointmentNumber: { $exists: false } },
    { appointmentNumber: null },
    { appointmentNumber: '' },
  ],
};

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
    if (parsed) {
      customerMax.set(parsed.year, Math.max(customerMax.get(parsed.year) || 0, parsed.sequence));
    }
  }

  const appointmentMax = new Map<string, number>();
  for (const appointment of numberedAppointments) {
    const parsed = readAppointmentSequence(appointment.appointmentNumber);
    if (parsed) {
      appointmentMax.set(parsed.date, Math.max(appointmentMax.get(parsed.date) || 0, parsed.sequence));
    }
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

export async function backfillPublicIdentifiers() {
  const [customers, appointments] = await Promise.all([
    User.find(missingCustomerNumberFilter)
      .select('_id createdAt')
      .sort({ createdAt: 1, _id: 1 })
      .lean(),
    Appointment.find(missingAppointmentNumberFilter)
      .select('_id date createdAt')
      .sort({ date: 1, createdAt: 1, _id: 1 })
      .lean(),
  ]);

  if (customers.length === 0 && appointments.length === 0) {
    return { customers: 0, appointments: 0 };
  }

  await synchronizeCounters();

  let assignedCustomers = 0;
  for (const customer of customers) {
    const customerNumber = await generateCustomerNumber(customerYear(customer.createdAt));
    const result = await User.updateOne(
      { _id: customer._id, ...missingCustomerNumberFilter },
      { $set: { customerNumber } },
    );
    assignedCustomers += result.modifiedCount;
  }

  let assignedAppointments = 0;
  for (const appointment of appointments) {
    const appointmentNumber = await generateAppointmentNumber(appointment.date);
    const result = await Appointment.updateOne(
      { _id: appointment._id, ...missingAppointmentNumberFilter },
      { $set: { appointmentNumber } },
    );
    assignedAppointments += result.modifiedCount;
  }

  return {
    customers: assignedCustomers,
    appointments: assignedAppointments,
  };
}
