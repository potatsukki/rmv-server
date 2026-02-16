import { Router } from 'express';
import * as ctrl from './blueprints.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { authorize } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { Role } from '../../utils/constants.js';
import {
  uploadBlueprintSchema,
  revisionUploadSchema,
  approveBlueprintSchema,
  requestRevisionSchema,
} from './blueprints.validation.js';

const router = Router();

// ── Engineer: Upload ──
router.post(
  '/',
  authenticate,
  authorize(Role.ENGINEER),
  validate(uploadBlueprintSchema),
  ctrl.uploadBlueprint,
);

router.post(
  '/:id/revision',
  authenticate,
  authorize(Role.ENGINEER),
  validate(revisionUploadSchema),
  ctrl.uploadRevision,
);

// ── Customer: Approve / Request Revision ──
router.post(
  '/:id/approve',
  authenticate,
  authorize(Role.CUSTOMER),
  validate(approveBlueprintSchema),
  ctrl.approveComponent,
);

router.post(
  '/:id/request-revision',
  authenticate,
  authorize(Role.CUSTOMER),
  validate(requestRevisionSchema),
  ctrl.requestRevision,
);

// ── Read ──
router.get(
  '/:id',
  authenticate,
  ctrl.getBlueprintById,
);

router.get(
  '/project/:projectId',
  authenticate,
  ctrl.listBlueprintsByProject,
);

router.get(
  '/project/:projectId/latest',
  authenticate,
  ctrl.getLatestBlueprint,
);

export default router;
