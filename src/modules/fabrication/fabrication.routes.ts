import { Router } from 'express';
import * as ctrl from './fabrication.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { authorize } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { Role } from '../../utils/constants.js';
import { createFabricationUpdateSchema } from './fabrication.validation.js';

const router = Router();

// ── Fabrication Staff: Post Update ──
router.post(
  '/',
  authenticate,
  authorize(Role.FABRICATION_STAFF),
  validate(createFabricationUpdateSchema),
  ctrl.createFabricationUpdate,
);

// ── Read ──
router.get(
  '/project/:projectId',
  authenticate,
  ctrl.listFabricationUpdates,
);

router.get(
  '/project/:projectId/status',
  authenticate,
  ctrl.getLatestFabricationStatus,
);

router.get(
  '/:id',
  authenticate,
  ctrl.getFabricationUpdateById,
);

export default router;
