/**
 * Read-only diagnostic: why do customers see fewer sales staff on a date?
 *
 * Prints every sales staff member's eligibility, blocked slots, every appointment on the date
 * (including the ones the Appointments page hides: project oculars and unpaid oculars), and the
 * "N staff available" count each slot shows on the booking page.
 *
 *   npx tsx src/scripts/diagnoseSalesDay.ts 2026-11-15
 *
 * Only reads; it never writes to the database.
 */
import mongoose from 'mongoose';
import { connectDB } from '../config/database.js';
import { Appointment, BlockedSlot, Project, SalesAvailability, User } from '../models/index.js';
import { AppointmentType, Role } from '../utils/constants.js';
import { SALES_SLOT_FREEING_STATUSES } from '../modules/users/availability-session.service.js';
import { getAvailableSlots } from '../modules/appointments/appointments.service.js';

type NameLike = { firstName?: string; lastName?: string } | null | undefined;

const fullName = (user: NameLike) => `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim() || '(no name)';

async function diagnoseSalesDay(date: string): Promise<void> {
  await connectDB();

  const staff = await User.find({ roles: Role.SALES_STAFF })
    .select('firstName lastName isActive availabilityStatus')
    .lean();
  const staffById = new Map(staff.map((member) => [member._id.toString(), member]));
  const unavailable = await SalesAvailability.find({ unavailableDates: date }).select('salesStaffId').lean();
  const unavailableIds = new Set(unavailable.map((entry) => entry.salesStaffId.toString()));

  console.log(`\n== SALES STAFF (${date}) ==`);
  for (const member of staff) {
    const reasons: string[] = [];
    if (!member.isActive) reasons.push('account inactive');
    if (member.availabilityStatus && member.availabilityStatus !== 'available') reasons.push(`admin set ${member.availabilityStatus}`);
    if (unavailableIds.has(member._id.toString())) reasons.push(`marked unavailable on ${date}`);
    console.log(`- ${fullName(member)} [${member._id}]: ${reasons.length ? `NOT COUNTED (${reasons.join(', ')})` : 'counted'}`);
  }

  const blocked = await BlockedSlot.find({ date }).select('slotCode type').lean();
  console.log(`\n== BLOCKED SLOTS ==\n${blocked.map((slot) => `- ${slot.slotCode} (${slot.type})`).join('\n') || '- none'}`);

  const appointments = await Appointment.find({ date })
    .select('appointmentNumber type slotCode status salesStaffId customerId ocularFeeStatus')
    .sort({ slotCode: 1 })
    .lean();
  const projects = await Project.find({ ocularAppointmentId: { $in: appointments.map((appointment) => appointment._id) } })
    .select('projectNumber status ocularAppointmentId')
    .lean();
  const projectByAppointmentId = new Map(projects.map((project) => [String(project.ocularAppointmentId), project]));
  const customers = await User.find({ _id: { $in: appointments.map((appointment) => appointment.customerId) } })
    .select('firstName lastName')
    .lean();
  const customerById = new Map(customers.map((customer) => [customer._id.toString(), customer]));

  console.log(`\n== APPOINTMENTS ON ${date} ==`);
  if (!appointments.length) console.log('- none');
  for (const appointment of appointments) {
    const project = projectByAppointmentId.get(appointment._id.toString());
    const staffMember = appointment.salesStaffId ? staffById.get(appointment.salesStaffId.toString()) : undefined;
    const holdsSlot = !SALES_SLOT_FREEING_STATUSES.includes(appointment.status);
    const hiddenBecause: string[] = [];
    if (project) hiddenBecause.push(`project ocular ${project.projectNumber ?? project._id}`);
    if (appointment.type === AppointmentType.OCULAR && appointment.ocularFeeStatus === 'pending') {
      hiddenBecause.push('ocular fee unpaid (hidden from admin/agent)');
    }
    console.log([
      `- ${appointment.appointmentNumber ?? appointment._id}`,
      appointment.type,
      appointment.slotCode,
      appointment.status,
      `staff: ${appointment.salesStaffId ? (staffMember ? fullName(staffMember) : appointment.salesStaffId.toString()) : 'UNASSIGNED (uses one staff from the pool)'}`,
      `customer: ${fullName(customerById.get(appointment.customerId.toString()))}`,
      holdsSlot ? 'HOLDS SLOT' : 'frees slot',
      hiddenBecause.length ? `HIDDEN on Appointments page: ${hiddenBecause.join('; ')}` : 'visible on Appointments page',
      `id: ${appointment._id}`,
    ].join(' | '));
  }

  console.log(`\n== WHAT THE BOOKING PAGE SHOWS (office consultation) ==`);
  try {
    const { slots } = await getAvailableSlots({ date, type: AppointmentType.OFFICE });
    for (const slot of slots) {
      console.log(`- ${slot.time}: ${slot.blocked ? 'blocked' : `${slot.remaining} staff available`}`);
    }
  } catch (error) {
    console.log(`- date not bookable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const date = process.argv[2];
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('Usage: npx tsx src/scripts/diagnoseSalesDay.ts <yyyy-MM-dd>');
  process.exit(1);
}

diagnoseSalesDay(date)
  .then(async () => {
    await mongoose.connection.close();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('Diagnosis failed:', error);
    await mongoose.connection.close();
    process.exit(1);
  });
