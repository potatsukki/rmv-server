import { Router } from 'express';
import * as ctrl from './projects.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { authorize } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { Role } from '../../utils/constants.js';
import {
  createProjectSchema,
  updateProjectSchema,
  assignEngineersSchema,
  assignFabricationSchema,
  transitionProjectSchema,
} from './projects.validation.js';

const router = Router();

// ── CRUD ──
router.post(
  '/',
  authenticate,
  authorize(Role.SALES_STAFF, Role.ADMIN),
  validate(createProjectSchema),
  ctrl.createProject,
);

router.patch(
  '/:id',
  authenticate,
  authorize(Role.SALES_STAFF, Role.ENGINEER, Role.ADMIN),
  validate(updateProjectSchema),
  ctrl.updateProject,
);

// ── Assignments ──
router.post(
  '/:id/assign-engineers',
  authenticate,
  authorize(Role.SALES_STAFF, Role.ADMIN),
  validate(assignEngineersSchema),
  ctrl.assignEngineers,
);

router.post(
  '/:id/assign-fabrication',
  authenticate,
  authorize(Role.ENGINEER, Role.ADMIN),
  validate(assignFabricationSchema),
  ctrl.assignFabricationStaff,
);

// ── Status Transition ──
router.post(
  '/:id/transition',
  authenticate,
  authorize(Role.SALES_STAFF, Role.ENGINEER, Role.ADMIN),
  validate(transitionProjectSchema),
  ctrl.transitionProject,
);

// ── Media ──
router.post(
  '/:id/media',
  authenticate,
  authorize(Role.SALES_STAFF, Role.ENGINEER, Role.ADMIN),
  ctrl.addMediaKeys,
);

router.delete(
  '/:id/media',
  authenticate,
  authorize(Role.SALES_STAFF, Role.ENGINEER, Role.ADMIN),
  ctrl.removeMediaKey,
);

// ── Read ──
router.get(
  '/',
  authenticate,
  ctrl.listProjects,
);

router.get(
  '/:id',
  authenticate,
  ctrl.getProjectById,
);

export default router;
