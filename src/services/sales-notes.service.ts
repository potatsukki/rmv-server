import { Appointment, Project, ProjectItem, VisitReport, AuditLog } from '../models/index.js';
import { AppError } from '../utils/appError.js';
import { AuditAction, ProjectStatus, Role } from '../utils/constants.js';
import { cleanSalesNotes } from '../utils/salesNotes.js';

export async function syncAppointmentSalesNotes(appointmentId: string, value: string, requireDraftProject = false) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');
  const sourceId = appointment.sourceConsultationAppointmentId || appointment._id;
  const oculars = await Appointment.find({ sourceConsultationAppointmentId: sourceId }).select('_id').lean();
  const appointmentIds = [...new Set([String(sourceId), String(appointment._id), ...oculars.map((item) => String(item._id))])];
  const projectFilter = { $or: [
    { appointmentId: { $in: appointmentIds } },
    { ocularAppointmentId: { $in: appointmentIds } },
  ] };
  if (requireDraftProject && await Project.exists({ ...projectFilter, status: { $ne: ProjectStatus.DRAFT } })) {
    throw AppError.badRequest('Update sales notes through the project after it has been submitted to engineering.');
  }
  const initialDesignNotes = cleanSalesNotes(value);
  await Appointment.updateMany({ _id: { $in: appointmentIds } }, { $set: { initialDesignNotes } });
  await VisitReport.updateMany({ appointmentId: { $in: appointmentIds } }, { $set: { initialDesignNotes } });
  const projects = await Project.find({ ...projectFilter, status: ProjectStatus.DRAFT }).select('_id').lean();
  const projectIds = projects.map((project) => project._id);
  if (projectIds.length) {
    await Project.updateMany({ _id: { $in: projectIds }, status: ProjectStatus.DRAFT }, { $set: { initialDesignNotes } });
    await ProjectItem.updateMany({ projectId: { $in: projectIds }, status: ProjectStatus.DRAFT }, { $set: { initialDesignNotes } });
  }
  return initialDesignNotes;
}

export async function updateAppointmentSalesNotes(appointmentId: string, notes: string, actorId: string, roles: Role[], ip?: string, ua?: string) {
  const appointment = await Appointment.findById(appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');
  if (!roles.includes(Role.ADMIN) && String(appointment.salesStaffId) !== actorId) {
    throw AppError.forbidden('Only the assigned sales staff can update sales notes.');
  }
  const initialDesignNotes = await syncAppointmentSalesNotes(appointmentId, notes, true);
  await AuditLog.create({ action: AuditAction.APPOINTMENT_UPDATED, actorId, targetType: 'appointment', targetId: appointment._id,
    details: { initialDesignNotes }, ipAddress: ip, userAgent: ua });
  return Appointment.findById(appointmentId);
}
