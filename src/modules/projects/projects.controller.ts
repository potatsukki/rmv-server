import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as projectsService from './projects.service.js';
import { maskProjectTotalCostForActor } from './projects.list-policy.js';

function serializeProjectForActor(project: any, req: Request) {
  if (!project || typeof project !== 'object') return project;
  const plainProject = typeof project.toObject === 'function'
    ? project.toObject()
    : { ...project };

  return maskProjectTotalCostForActor(
    plainProject,
    req.userId!,
    req.userRoles || [],
  );
}

function serializeProjectMutationResult(result: any, req: Request) {
  if (!result || typeof result !== 'object' || !('project' in result)) {
    return serializeProjectForActor(result, req);
  }

  return {
    ...result,
    project: serializeProjectForActor(result.project, req),
  };
}

export const createProject = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.createProject(req.body, req.userId!, req.ip, req.get('user-agent'));
  res.status(201).json({ success: true, data: serializeProjectForActor(project, req) });
});

export const updateProject = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.updateProject((req.params.id as string), req.body, req.userId!, req.ip, req.get('user-agent'));
  res.json({ success: true, data: serializeProjectForActor(project, req) });
});

export const assignEngineers = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.assignEngineers((req.params.id as string), req.body, req.userId!, req.ip, req.get('user-agent'));
  res.json({ success: true, data: serializeProjectForActor(project, req) });
});

export const reassignProjectSalesStaff = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.reassignProjectSalesStaff(
    req.params.id as string,
    req.body,
    req.userId!,
    req.userRoles!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: serializeProjectForActor(project, req) });
});

export const assignFabricationStaff = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.assignFabricationStaff((req.params.id as string), req.body, req.userId!, req.ip, req.get('user-agent'));
  res.json({ success: true, data: serializeProjectForActor(project, req) });
});

export const transitionProject = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.transitionProject((req.params.id as string), req.body, req.userId!, req.ip, req.get('user-agent'));
  res.json({ success: true, data: serializeProjectForActor(project, req) });
});

export const getProjectByVisitReportId = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.getProjectByVisitReportId(req.params.visitReportId as string);
  res.json({ success: true, data: project });
});

export const getProjectById = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.getProjectById((req.params.id as string), req.userId!, req.userRoles!);
  res.json({ success: true, data: project });
});

export const listProjects = asyncHandler(async (req: Request, res: Response) => {
  const result = await projectsService.listProjects(req.query as any, req.userId!, req.userRoles!);
  res.json({ success: true, data: result });
});

export const repairMissingProjectNumbers = asyncHandler(async (_req: Request, res: Response) => {
  const result = await projectsService.repairMissingProjectNumbers();
  res.json({ success: true, data: result });
});

export const addMediaKeys = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.addMediaKeys((req.params.id as string), req.body.keys, req.userId!);
  res.json({ success: true, data: serializeProjectForActor(project, req) });
});

export const removeMediaKey = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.removeMediaKey((req.params.id as string), req.body.key, req.userId!);
  res.json({ success: true, data: serializeProjectForActor(project, req) });
});

export const generateContract = asyncHandler(async (req: Request, res: Response) => {
  res.status(410).json({
    success: false,
    message: 'Generated contract PDFs are disabled. Upload the manually signed contract instead.',
  });
});

export const uploadSignedContract = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.uploadSignedContract(
    req.params.id as string,
    req.body,
    req.userId!,
    req.userRoles!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: serializeProjectForActor(project, req) });
});

export const getContractDownloadUrl = asyncHandler(async (req: Request, res: Response) => {
  const copy = (req.query.copy as string) === 'copy' ? 'copy' : 'original';
  const result = await projectsService.getContractDownloadUrl(
    req.params.id as string,
    copy,
    req.userId!,
    req.userRoles!,
  );
  res.json({ success: true, data: result });
});

export const signContract = asyncHandler(async (req: Request, res: Response) => {
  res.status(410).json({
    success: false,
    message: 'Customer e-sign contract flow is disabled. Use the uploaded manually signed contract.',
  });
});

export const signEngineerContract = asyncHandler(async (req: Request, res: Response) => {
  res.status(410).json({
    success: false,
    message: 'Engineer e-sign contract flow is disabled. Use the uploaded manually signed contract.',
  });
});

export const reviewInitialDesign = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.reviewInitialDesign(
    req.params.id as string,
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: serializeProjectForActor(project, req) });
});

export const resubmitInitialDesign = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.resubmitInitialDesign(
    req.params.id as string,
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: serializeProjectForActor(project, req) });
});

export const backfillInitialDesign = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.backfillInitialDesign(
    req.params.id as string,
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: serializeProjectForActor(project, req) });
});

export const selectPaymentPlan = asyncHandler(async (req: Request, res: Response) => {
  const result = await projectsService.selectPaymentPlan(
    req.params.id as string,
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: serializeProjectMutationResult(result, req) });
});

export const confirmInstallation = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.confirmInstallation(
    req.params.id as string,
    req.userId!,
    req.userRoles!,
    (req.body?.projectItemId || req.query.projectItemId) as string | undefined,
  );
  res.json({ success: true, data: serializeProjectForActor(project, req) });
});

export const submitProjectReview = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.submitProjectReview(
    req.params.id as string,
    req.body,
    req.userId!,
    req.userRoles!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: serializeProjectForActor(project, req) });
});

export const skipProjectReview = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.skipProjectReview(
    req.params.id as string,
    req.body,
    req.userId!,
    req.userRoles!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: serializeProjectForActor(project, req) });
});
