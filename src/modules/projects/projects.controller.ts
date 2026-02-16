import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as projectsService from './projects.service.js';

export const createProject = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.createProject(req.body, req.userId!, req.ip, req.get('user-agent'));
  res.status(201).json({ success: true, data: project });
});

export const updateProject = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.updateProject((req.params.id as string), req.body, req.userId!, req.ip, req.get('user-agent'));
  res.json({ success: true, data: project });
});

export const assignEngineers = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.assignEngineers((req.params.id as string), req.body, req.userId!, req.ip, req.get('user-agent'));
  res.json({ success: true, data: project });
});

export const assignFabricationStaff = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.assignFabricationStaff((req.params.id as string), req.body, req.userId!, req.ip, req.get('user-agent'));
  res.json({ success: true, data: project });
});

export const transitionProject = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.transitionProject((req.params.id as string), req.body, req.userId!, req.ip, req.get('user-agent'));
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

export const addMediaKeys = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.addMediaKeys((req.params.id as string), req.body.keys, req.userId!);
  res.json({ success: true, data: project });
});

export const removeMediaKey = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.removeMediaKey((req.params.id as string), req.body.key, req.userId!);
  res.json({ success: true, data: project });
});
