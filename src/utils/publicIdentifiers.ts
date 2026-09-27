import { AppointmentNumberCounter, CustomerNumberCounter } from '../models/Config.js';

export function formatCustomerNumber(year: number, sequence: number) {
  return `CUS-${year}-${String(sequence).padStart(6, '0')}`;
}

export function formatAppointmentNumber(date: string, sequence: number) {
  return `APT-${date.replaceAll('-', '')}-${String(sequence).padStart(4, '0')}`;
}

async function incrementCounter(
  update: (upsert: boolean) => PromiseLike<{ lastSeq: number } | null>,
) {
  try {
    const counter = await update(true);
    if (!counter) throw new Error('Identifier counter could not be created');
    return counter.lastSeq;
  } catch (error: any) {
    if (error?.code !== 11000) throw error;
    const counter = await update(false);
    if (!counter) throw error;
    return counter.lastSeq;
  }
}

export async function generateCustomerNumber(year = new Date().getFullYear()) {
  const sequence = await incrementCounter((upsert) => CustomerNumberCounter.findOneAndUpdate(
    { year },
    { $inc: { lastSeq: 1 } },
    upsert
      ? { new: true, upsert: true, setDefaultsOnInsert: true }
      : { new: true },
  ));
  return formatCustomerNumber(year, sequence);
}

export async function generateAppointmentNumber(date: string) {
  const sequence = await incrementCounter((upsert) => AppointmentNumberCounter.findOneAndUpdate(
    { date },
    { $inc: { lastSeq: 1 } },
    upsert
      ? { new: true, upsert: true, setDefaultsOnInsert: true }
      : { new: true },
  ));
  return formatAppointmentNumber(date, sequence);
}
