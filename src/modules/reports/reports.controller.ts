import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as reportsService from './reports.service.js';
import { getConfigValue } from '../config/config.service.js';
import { AppError } from '../../utils/appError.js';

const LIFECYCLE_ANALYTICS_FLAG = 'feature_lifecycle_mismatch_analytics';

export const getDashboardSummary = asyncHandler(async (req: Request, res: Response) => {
  const data = await reportsService.getDashboardSummary(req.userId, req.userRoles);
  res.json({ success: true, data });
});

export const getRevenueReport = asyncHandler(async (req: Request, res: Response) => {
  const data = await reportsService.getRevenueReport(req.query as any);
  res.json({ success: true, data });
});

export const getPaymentStageReport = asyncHandler(async (req: Request, res: Response) => {
  const data = await reportsService.getPaymentStageReport(req.query as any);
  res.json({ success: true, data });
});

export const getOutstandingReport = asyncHandler(async (req: Request, res: Response) => {
  const data = await reportsService.getOutstandingReport();
  res.json({ success: true, data });
});

export const getProjectPipelineReport = asyncHandler(async (req: Request, res: Response) => {
  const data = await reportsService.getProjectPipelineReport();
  res.json({ success: true, data });
});

export const getWorkloadReport = asyncHandler(async (req: Request, res: Response) => {
  const data = await reportsService.getWorkloadReport();
  res.json({ success: true, data });
});

export const getConversionReport = asyncHandler(async (req: Request, res: Response) => {
  const data = await reportsService.getConversionReport(req.query as any);
  res.json({ success: true, data });
});

export const getAuditLogs = asyncHandler(async (req: Request, res: Response) => {
  const text = (key: string) => (typeof req.query[key] === 'string' && req.query[key] ? String(req.query[key]).trim() : undefined);
  const data = await reportsService.getRecentAuditLogs({
    limit: req.query.limit ? Number(req.query.limit) : undefined,
    page: req.query.page ? Number(req.query.page) : undefined,
    action: text('action'),
    targetType: text('targetType'),
    targetId: text('targetId'),
    actorId: text('actorId'),
    dateFrom: text('dateFrom'),
    dateTo: text('dateTo'),
  });
  res.json({ success: true, data });
});

export const getLifecycleMismatchHotspots = asyncHandler(async (req: Request, res: Response) => {
  const isEnabled = await getConfigValue<boolean>(LIFECYCLE_ANALYTICS_FLAG, true);
  if (!isEnabled) {
    throw AppError.notFound('Lifecycle mismatch analytics is currently disabled');
  }

  const data = await reportsService.getLifecycleMismatchHotspots({
    dateFrom: req.query.dateFrom ? String(req.query.dateFrom) : undefined,
    dateTo: req.query.dateTo ? String(req.query.dateTo) : undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
  });
  res.json({ success: true, data });
});

export const acknowledgeLifecycleMismatchHotspot = asyncHandler(async (req: Request, res: Response) => {
  const isEnabled = await getConfigValue<boolean>(LIFECYCLE_ANALYTICS_FLAG, true);
  if (!isEnabled) {
    throw AppError.notFound('Lifecycle mismatch analytics is currently disabled');
  }

  if (!req.userId) {
    throw AppError.unauthorized('Unauthorized');
  }

  const data = await reportsService.acknowledgeLifecycleMismatchHotspot(
    {
      targetType: req.body?.targetType,
      currentStatus: req.body?.currentStatus,
      attemptedStatus: req.body?.attemptedStatus,
      refreshRequired: req.body?.refreshRequired === true,
      acknowledged: req.body?.acknowledged !== false,
      note: req.body?.note ? String(req.body.note) : undefined,
    },
    req.userId,
    req.ip,
    req.headers['user-agent'],
  );

  res.json({ success: true, data });
});
