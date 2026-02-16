import {
  VisitReport, Appointment, Project, User, AuditLog,
} from '../../models/index.js';
import { VisitReportStatus } from '../../models/VisitReport.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import {
  AppointmentStatus, ProjectStatus, Role, AuditAction, NotificationCategory,
} from '../../utils/constants.js';
import { visitReportStateMachine, appointmentStateMachine } from '../../utils/stateMachine.js';
import { createAndSendNotification, notifyRole } from '../notifications/socket.service.js';
import type { UpdateVisitReportInput, ReturnVisitReportInput } from './visit-reports.validation.js';
import type { Types } from 'mongoose';

// ── Auto-create Draft (called when Agent confirms appointment) ──

export async function autoCreateDraft(
  appointmentId: Types.ObjectId | string,
  customerId: Types.ObjectId | string,
  salesStaffId: Types.ObjectId | string,
  visitType: string,
): Promise<void> {
  // Check if one already exists
  const existing = await VisitReport.findOne({ appointmentId });
  if (existing) return; // idempotent

  const report = await VisitReport.create({
    appointmentId,
    customerId,
    salesStaffId,
    status: VisitReportStatus.DRAFT,
    visitType,
    photoKeys: [],
    videoKeys: [],
    sketchKeys: [],
    referenceImageKeys: [],
  });

  await AuditLog.create({
    action: AuditAction.VISIT_REPORT_CREATED,
    actorId: salesStaffId.toString(),
    targetType: 'visit_report',
    targetId: report._id,
    details: { appointmentId: appointmentId.toString(), autoCreated: true },
  });
}

// ── Get by ID ──

export async function getVisitReport(reportId: string) {
  const report = await VisitReport.findById(reportId)
    .populate('customerId', 'firstName lastName email phone')
    .populate('salesStaffId', 'firstName lastName email')
    .populate('appointmentId', 'date slotCode type customerAddress');
  if (!report) throw AppError.notFound('Visit report not found');
  return report;
}

// ── Get by Appointment ──

export async function getByAppointment(appointmentId: string) {
  const report = await VisitReport.findOne({ appointmentId })
    .populate('customerId', 'firstName lastName email phone')
    .populate('salesStaffId', 'firstName lastName email')
    .populate('appointmentId', 'date slotCode type customerAddress');
  return report; // may be null
}

// ── List for Sales Staff ──

export async function listForSalesStaff(salesStaffId: string, query: {
  status?: string;
  page?: string;
  limit?: string;
}) {
  const page = parseInt(query.page || '1');
  const limit = Math.min(parseInt(query.limit || '20'), 100);
  const filter: Record<string, unknown> = { salesStaffId };
  if (query.status) filter.status = query.status;

  const [reports, total] = await Promise.all([
    VisitReport.find(filter)
      .populate('customerId', 'firstName lastName email')
      .populate('appointmentId', 'date slotCode type customerAddress')
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    VisitReport.countDocuments(filter),
  ]);

  return { items: reports, total, hasMore: page * limit < total };
}

// ── List Submitted (Engineer queue) ──

export async function listSubmitted(query: {
  page?: string;
  limit?: string;
}) {
  const page = parseInt(query.page || '1');
  const limit = Math.min(parseInt(query.limit || '20'), 100);
  const filter = { status: VisitReportStatus.SUBMITTED };

  const [reports, total] = await Promise.all([
    VisitReport.find(filter)
      .populate('customerId', 'firstName lastName email')
      .populate('salesStaffId', 'firstName lastName')
      .populate('appointmentId', 'date slotCode type customerAddress')
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    VisitReport.countDocuments(filter),
  ]);

  return { items: reports, total, hasMore: page * limit < total };
}

// ── List All (Admin view) ──

export async function listAll(query: {
  status?: string;
  salesStaffId?: string;
  page?: string;
  limit?: string;
}) {
  const page = parseInt(query.page || '1');
  const limit = Math.min(parseInt(query.limit || '20'), 100);
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;
  if (query.salesStaffId) filter.salesStaffId = query.salesStaffId;

  const [reports, total] = await Promise.all([
    VisitReport.find(filter)
      .populate('customerId', 'firstName lastName email')
      .populate('salesStaffId', 'firstName lastName')
      .populate('appointmentId', 'date slotCode type customerAddress')
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    VisitReport.countDocuments(filter),
  ]);

  return { items: reports, total, hasMore: page * limit < total };
}

// ── Update Report (Sales Staff fills draft/returned) ──

export async function updateReport(
  reportId: string,
  input: UpdateVisitReportInput,
  salesStaffId: string,
  ip?: string,
  ua?: string,
) {
  const report = await VisitReport.findById(reportId);
  if (!report) throw AppError.notFound('Visit report not found');

  // Only the assigned sales staff can edit
  if (report.salesStaffId.toString() !== salesStaffId) {
    throw AppError.forbidden('You are not assigned to this visit report');
  }

  // Can only edit in DRAFT or RETURNED status
  if (![VisitReportStatus.DRAFT, VisitReportStatus.RETURNED].includes(report.status)) {
    throw AppError.badRequest('Visit report can only be edited in draft or returned status');
  }

  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      (report as any)[key] = value;
      changes[key] = value;
    }
  }

  await report.save();

  await AuditLog.create({
    action: AuditAction.VISIT_REPORT_UPDATED,
    actorId: salesStaffId,
    targetType: 'visit_report',
    targetId: report._id,
    details: changes,
    ipAddress: ip,
    userAgent: ua,
  });

  return report;
}

// ── Submit Report (Sales Staff → Engineer) ──

export async function submitReport(
  reportId: string,
  salesStaffId: string,
  ip?: string,
  ua?: string,
) {
  const report = await VisitReport.findById(reportId);
  if (!report) throw AppError.notFound('Visit report not found');

  if (report.salesStaffId.toString() !== salesStaffId) {
    throw AppError.forbidden('You are not assigned to this visit report');
  }

  visitReportStateMachine.assertTransition(report.status, VisitReportStatus.SUBMITTED);

  report.status = VisitReportStatus.SUBMITTED;
  await report.save();

  await AuditLog.create({
    action: AuditAction.VISIT_REPORT_SUBMITTED,
    actorId: salesStaffId,
    targetType: 'visit_report',
    targetId: report._id,
    ipAddress: ip,
    userAgent: ua,
  });

  // ── Auto-complete the appointment ──
  const appointment = await Appointment.findById(report.appointmentId);
  if (appointment && appointment.status === AppointmentStatus.CONFIRMED) {
    appointmentStateMachine.assertTransition(appointment.status, AppointmentStatus.COMPLETED);
    appointment.status = AppointmentStatus.COMPLETED;
    await appointment.save();

    await AuditLog.create({
      action: AuditAction.APPOINTMENT_COMPLETED,
      actorId: salesStaffId,
      targetType: 'appointment',
      targetId: appointment._id,
      details: { triggeredBy: 'system', reason: 'visit_report_submitted' },
      ipAddress: ip,
      userAgent: ua,
    });
  }

  // ── Auto-create Project (DRAFT → SUBMITTED) ──
  if (appointment) {
    const existingProject = await Project.findOne({ appointmentId: report.appointmentId });
    if (!existingProject) {
      const project = await Project.create({
        appointmentId: report.appointmentId,
        customerId: report.customerId,
        salesStaffId: report.salesStaffId,
        title: `Project - ${appointment.customerNotes || 'Visit Report'}`,
        serviceType: report.preferredDesign || 'General Fabrication',
        description: report.customerRequirements || report.notes || 'Created from visit report',
        siteAddress: appointment.customerAddress || 'TBD',
        measurements: report.measurements,
        materialType: report.materials,
        finishColor: report.finishes,
        quantity: 1,
        notes: report.notes,
        status: ProjectStatus.SUBMITTED,
        mediaKeys: [...report.photoKeys, ...report.sketchKeys, ...report.referenceImageKeys],
      });

      await AuditLog.create({
        action: AuditAction.PROJECT_CREATED,
        actorId: salesStaffId,
        targetType: 'project',
        targetId: project._id,
        details: { triggeredBy: 'system', reason: 'visit_report_submitted', visitReportId: reportId },
        ipAddress: ip,
        userAgent: ua,
      });

      // Notify admins about new project
      await notifyRole(
        Role.ADMIN,
        NotificationCategory.PROJECT,
        'New Project from Visit Report',
        `A new project "${project.title}" has been created from a visit report. Assign an engineer.`,
        `/projects/${project._id}`,
      );

      // Notify customer
      await createAndSendNotification(
        report.customerId,
        NotificationCategory.PROJECT,
        'Project Created',
        `Your project has been created from the visit report. An engineer will be assigned shortly.`,
        `/projects/${project._id}`,
      );
    }
  }

  // Notify engineers about submitted report
  await notifyRole(
    Role.ENGINEER,
    NotificationCategory.PROJECT,
    'New Visit Report Submitted',
    `A sales visit report has been submitted and is ready for review.`,
    `/visit-reports/${report._id}`,
  );

  return report;
}

// ── Return Report (Engineer → Sales Staff) ──

export async function returnReport(
  reportId: string,
  input: ReturnVisitReportInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const report = await VisitReport.findById(reportId);
  if (!report) throw AppError.notFound('Visit report not found');

  visitReportStateMachine.assertTransition(report.status, VisitReportStatus.RETURNED);

  report.status = VisitReportStatus.RETURNED;
  report.returnReason = input.reason;
  await report.save();

  await AuditLog.create({
    action: AuditAction.VISIT_REPORT_RETURNED,
    actorId,
    targetType: 'visit_report',
    targetId: report._id,
    details: { reason: input.reason },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify the sales staff
  await createAndSendNotification(
    report.salesStaffId,
    NotificationCategory.PROJECT,
    'Visit Report Returned',
    `Your visit report has been returned for revision. Reason: ${input.reason}`,
    `/visit-reports/${report._id}`,
  );

  return report;
}

// ── Mark as Completed (when engineer finishes blueprint from this report) ──

export async function markCompleted(
  reportId: string,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const report = await VisitReport.findById(reportId);
  if (!report) throw AppError.notFound('Visit report not found');

  visitReportStateMachine.assertTransition(report.status, VisitReportStatus.COMPLETED);

  report.status = VisitReportStatus.COMPLETED;
  await report.save();

  await AuditLog.create({
    action: AuditAction.VISIT_REPORT_COMPLETED,
    actorId,
    targetType: 'visit_report',
    targetId: report._id,
    ipAddress: ip,
    userAgent: ua,
  });

  return report;
}
