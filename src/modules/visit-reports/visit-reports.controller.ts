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
  } else {
    // Sales staff — their own reports
    result = await visitReportsService.listForSalesStaff(req.userId!, req.query as any);
  }

  res.json({ success: true, data: result });
});

// ── Get Visit Report ──
export const getVisitReport = asyncHandler(async (req: Request, res: Response) => {
  const report = await visitReportsService.getVisitReport(req.params.id as string);
  res.json({ success: true, data: report });
});

// ── Get by Appointment ──
export const getByAppointment = asyncHandler(async (req: Request, res: Response) => {
  const report = await visitReportsService.getByAppointment(req.params.appointmentId as string);
  res.json({ success: true, data: report });
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
