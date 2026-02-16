import { z } from 'zod';
import { ProjectStatus } from '../../utils/constants.js';

export const createProjectSchema = z.object({
  appointmentId: z.string().min(1),
  title: z.string().min(1).max(100).trim(),
  serviceType: z.string().min(1).max(100).trim(),
  description: z.string().min(1).max(2000).trim(),
  siteAddress: z.string().min(1).max(500).trim(),
  measurements: z.object({
    length: z.number().positive().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    area: z.number().positive().optional(),
    thickness: z.number().positive().optional(),
    unit: z.string().default('cm'),
  }).optional(),
  materialType: z.string().max(100).optional(),
  finishColor: z.string().max(50).optional(),
  quantity: z.number().int().min(1).default(1),
  notes: z.string().max(2000).trim().optional(),
});

export const updateProjectSchema = z.object({
  title: z.string().min(1).max(100).trim().optional(),
  serviceType: z.string().min(1).max(100).trim().optional(),
  description: z.string().min(1).max(2000).trim().optional(),
  siteAddress: z.string().min(1).max(500).trim().optional(),
  measurements: z.object({
    length: z.number().positive().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    area: z.number().positive().optional(),
    thickness: z.number().positive().optional(),
    unit: z.string().default('cm'),
  }).optional(),
  materialType: z.string().max(100).optional(),
  finishColor: z.string().max(50).optional(),
  quantity: z.number().int().min(1).optional(),
  notes: z.string().max(2000).trim().optional(),
  estimatedCompletionDate: z.string().datetime().optional(),
});

export const assignEngineersSchema = z.object({
  engineerIds: z.array(z.string().min(1)).min(1),
});

export const assignFabricationSchema = z.object({
  fabricationLeadId: z.string().min(1),
  fabricationAssistantIds: z.array(z.string().min(1)).default([]),
});

export const transitionProjectSchema = z.object({
  status: z.nativeEnum(ProjectStatus),
  cancelReason: z.string().max(500).trim().optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type AssignEngineersInput = z.infer<typeof assignEngineersSchema>;
export type AssignFabricationInput = z.infer<typeof assignFabricationSchema>;
export type TransitionProjectInput = z.infer<typeof transitionProjectSchema>;
