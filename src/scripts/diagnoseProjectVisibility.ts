/**
 * Read-only diagnostic: why a project does or does not show on the Projects tab (QA 2026-11-26:
 * "hindi talaga lumabas" for Admin and Customer).
 *
 *   npx tsx src/scripts/diagnoseProjectVisibility.ts PRJ-2026-00094
 *   npx tsx src/scripts/diagnoseProjectVisibility.ts APT-20261125-0003
 *   npx tsx src/scripts/diagnoseProjectVisibility.ts customer@example.com
 *   npx tsx src/scripts/diagnoseProjectVisibility.ts 6b05260dc631d9e3415d96fd   (project or appointment id)
 *
 * For every matching project it prints whether the Admin list and the customer's list include it
 * and, if not, why (soft-deleted, or older than the newest 100). Customers see all their own projects,
 * with or without a signed contract (2026-11-26). When there is no project, it prints the
 * appointment's linked oculars and reports and what has to happen before a project exists.
 * Only reads; it never writes to the database.
 */
import mongoose from 'mongoose';
import { connectDB } from '../config/database.js';
import { Appointment, Project, User, VisitReport } from '../models/index.js';
import { customerVisibleProjectsFilter } from '../modules/projects/projects.list-policy.js';

/** listProjects returns at most 100 projects per page, newest createdAt first. */
const LIST_PAGE_LIMIT = 100;

type Doc = Record<string, any>;

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isObjectId = (value: string) => /^[a-f\d]{24}$/i.test(value);
const manila = (value: unknown) => (value
  ? new Date(value as string).toLocaleString('en-US', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' })
  : '—');

async function personLabel(id: unknown) {
  if (!id) return '(none)';
  const user = await User.findById(id).select('firstName lastName email roles').lean();
  return user ? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() + ` <${user.email}>` : `(missing user ${String(id)})`;
}

/** Raw collection reads, so soft-deleted projects (deletedAt set) are found too. */
function findProjectsRaw(filter: Doc) {
  return Project.collection.find(filter).sort({ createdAt: -1 }).toArray();
}

async function findAppointments(term: string): Promise<Doc[]> {
  if (/^APT-/i.test(term)) {
    return Appointment.find({ appointmentNumber: new RegExp(`^${escapeRegex(term)}$`, 'i') }).lean();
  }
  if (isObjectId(term)) {
    const appointment = await Appointment.findById(term).lean();
    return appointment ? [appointment] : [];
  }
  return [];
}

async function findProjects(term: string, appointments: Doc[]): Promise<Doc[]> {
  if (/^PRJ-/i.test(term)) {
    return findProjectsRaw({ projectNumber: new RegExp(escapeRegex(term), 'i') });
  }
  if (term.includes('@')) {
    const customer = await User.findOne({ email: term.toLowerCase() }).select('_id').lean();
    return customer ? findProjectsRaw({ customerId: customer._id }) : [];
  }
  const ids = appointments.map((appointment) => appointment._id);
  // Oculars booked from a consultation point back to it; their projects use the ocular's id.
  const oculars = ids.length ? await Appointment.find({ sourceConsultationAppointmentId: { $in: ids } }).select('_id').lean() : [];
  const appointmentIds = [...ids, ...oculars.map((ocular) => ocular._id)];
  const byAppointment = appointmentIds.length
    ? await findProjectsRaw({ $or: [{ appointmentId: { $in: appointmentIds } }, { ocularAppointmentId: { $in: appointmentIds } }] })
    : [];
  if (byAppointment.length || !isObjectId(term)) return byAppointment;
  return findProjectsRaw({ _id: new mongoose.Types.ObjectId(term) });
}

async function describeProject(project: Doc) {
  console.log(`\n== ${project.projectNumber ?? '(no project number)'} · ${project.title ?? ''} [${project._id}] ==`);
  console.log(`  status: ${project.status} · contract: ${project.contractStatus ?? '(not set)'} · created: ${manila(project.createdAt)}`);
  console.log(`  customer: ${await personLabel(project.customerId)}`);
  console.log(`  sales staff: ${await personLabel(project.salesStaffId)}`);
  if (project.ocularAppointmentId) {
    const ocular = await Appointment.findById(project.ocularAppointmentId).select('appointmentNumber status date slotCode').lean();
    console.log(`  ocular visit: ${ocular ? `${ocular.appointmentNumber ?? ocular._id} (${ocular.status}, ${ocular.date} ${ocular.slotCode})` : '(missing)'}`);
  }

  if (project.deletedAt) {
    console.log(`  ADMIN LIST: HIDDEN — soft-deleted on ${manila(project.deletedAt)} (deletedAt is set; every list skips it).`);
    console.log('  CUSTOMER LIST: HIDDEN — soft-deleted.');
    return;
  }

  const newer = await Project.countDocuments({ createdAt: { $gt: project.createdAt } });
  const total = await Project.countDocuments({});
  console.log(newer < LIST_PAGE_LIMIT
    ? `  ADMIN LIST: shown — row ${newer + 1} of ${total} under "All" (newest first).`
    : `  ADMIN LIST: NOT on the page — ${newer} newer projects come first and the list shows ${LIST_PAGE_LIMIT}. Searching its Project ID finds it.`);

  if (project.customerId) {
    // Since 2026-11-26 a customer sees every project of theirs, with or without a signed contract.
    const visible = await Project.countDocuments({ _id: project._id, ...customerVisibleProjectsFilter(String(project.customerId)) });
    console.log(visible
      ? `  CUSTOMER LIST: shown to the customer above (contract: ${project.contractStatus ?? 'not set'}).`
      : '  CUSTOMER LIST: HIDDEN — unexpected: check that this server runs the 2026-11-26 rule (all own projects).');
  }
  console.log('  SALES STAFF LIST: only the sales staff above (sales staff see their own projects only).');
}

async function describeAppointmentWithoutProject(appointment: Doc) {
  console.log(`\n== ${appointment.appointmentNumber ?? appointment._id} (${appointment.type}) ==`);
  console.log(`  status: ${appointment.status} · attendance: ${appointment.attendanceStatus ?? '—'} · ${appointment.date} ${appointment.slotCode}`);
  console.log(`  customer: ${await personLabel(appointment.customerId)}`);
  const [oculars, reports] = await Promise.all([
    Appointment.find({ sourceConsultationAppointmentId: appointment._id }).select('appointmentNumber status date slotCode').lean(),
    VisitReport.find({ appointmentId: appointment._id }).select('status visitType submittedAt').lean(),
  ]);
  for (const ocular of oculars) console.log(`  ocular booked from it: ${ocular.appointmentNumber ?? ocular._id} (${ocular.status}, ${ocular.date} ${ocular.slotCode})`);
  for (const report of reports) console.log(`  ${report.visitType} report: ${report.status}${report.submittedAt ? `, submitted ${manila(report.submittedAt)}` : ''}`);
  console.log('  NO PROJECT EXISTS for this appointment yet, so no list can show one. A project is created by');
  console.log('  "Create Project" (sales staff or admin, with the signed contract) or, for an ocular visit booked');
  console.log('  from the consultation report, when that ocular report is submitted.');
}

async function diagnoseProjectVisibility(term: string) {
  await connectDB();
  const appointments = await findAppointments(term);
  const projects = await findProjects(term, appointments);

  console.log(`\nSearch: "${term}" → ${projects.length} project(s), ${appointments.length} appointment(s)`);
  for (const project of projects) await describeProject(project);
  if (!projects.length) {
    if (appointments.length) {
      for (const appointment of appointments) await describeAppointmentWithoutProject(appointment);
    } else {
      console.log('\nNothing matched. Use a Project ID (PRJ-…), an Appointment ID (APT-…), a customer email, or a record id.');
      console.log('Note: the Projects tab search matches Project IDs, titles, services and names, not Appointment IDs.');
    }
  }
}

const term = process.argv[2]?.trim();
if (!term) {
  console.error('Usage: npx tsx src/scripts/diagnoseProjectVisibility.ts <PRJ-… | APT-… | customer email | id>');
  process.exit(1);
}

diagnoseProjectVisibility(term)
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
