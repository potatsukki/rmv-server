import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { Role } from '../../utils/constants.js';
import * as visitReportsService from './visit-reports.service.js';

// ── List Visit Reports ──
export const listVisitReports = asyncHandler(async (req: Request, res: Response) => {
  const roles = req.userRoles!;
  let result;

  if (roles.includes(Role.ADMIN)) {
    result = await visitReportsService.listAll(req.query as any);
  } else if (roles.includes(Role.ENGINEER)) {
    result = await visitReportsService.listSubmitted(req.query as any);
  } else if (!roles.includes(Role.SALES_STAFF) && roles.includes(Role.FABRICATION_STAFF)) {
    result = await visitReportsService.listForFabricationStaff(req.userId!, req.query as any);
  } else {
    // Sales staff — their own reports
    result = await visitReportsService.listForSalesStaff(req.userId!, req.query as any);
  }

  res.json({ success: true, data: result });
});

// ── Create Visit Report (+ Add Another Project) ──
export const createVisitReport = asyncHandler(async (req: Request, res: Response) => {
  const report = await visitReportsService.createReport(
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.status(201).json({ success: true, data: report });
});

// ── Get Visit Report ──
export const getVisitReport = asyncHandler(async (req: Request, res: Response) => {
  const roles = req.userRoles!;
  const fabricationOnly = roles.includes(Role.FABRICATION_STAFF)
    && ![Role.ADMIN, Role.ENGINEER, Role.SALES_STAFF].some((role) => roles.includes(role));
  const report = await visitReportsService.getVisitReport(req.params.id as string, fabricationOnly ? req.userId! : undefined);
  res.json({ success: true, data: report });
});

// ── Get by Appointment (returns array) ──
export const getByAppointment = asyncHandler(async (req: Request, res: Response) => {
  const reports = await visitReportsService.getByAppointment(req.params.appointmentId as string);
  res.json({ success: true, data: reports });
});

// ── Update Report ──
export const updateVisitReport = asyncHandler(async (req: Request, res: Response) => {
  const report = await visitReportsService.updateReport(
    req.params.id as string,
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: report });
});

// ── Submit Report ──
export const submitVisitReport = asyncHandler(async (req: Request, res: Response) => {
  const report = await visitReportsService.submitReport(
    req.params.id as string,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: report });
});

// ── Return Report ──
export const returnVisitReport = asyncHandler(async (req: Request, res: Response) => {
  const report = await visitReportsService.returnReport(
    req.params.id as string,
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: report });
});

export const reopenVisitReportForRepair = asyncHandler(async (req: Request, res: Response) => {
  const report = await visitReportsService.reopenReportForRepair(
    req.params.id as string,
    req.body,
    req.userId!,
    req.userRoles!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: report });
});

// ── Delete Report ──
export const deleteVisitReport = asyncHandler(async (req: Request, res: Response) => {
  const result = await visitReportsService.deleteReport(
    req.params.id as string,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: result });
});
