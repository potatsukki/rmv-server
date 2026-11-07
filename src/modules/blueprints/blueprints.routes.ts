import { Router } from 'express';
import { recordDesignFeeSchema } from '../projects/projects.validation.js';
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
  acceptBlueprintSchema,
  upsertBlueprintDraftSchema,
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

// ── Cashier: record the paid revision fee ──
router.post(
  '/:id/revision-fee/record',
  authenticate,
  authorize(Role.CASHIER, Role.ADMIN),
  validate(recordDesignFeeSchema),
  ctrl.recordRevisionFee,
);

router.post(
  '/:id/accept',
  authenticate,
  authorize(Role.CUSTOMER),
  validate(acceptBlueprintSchema),
  ctrl.acceptBlueprint,
);

router.post(
  '/:id/quotation/approve-send',
  authenticate,
  authorize(Role.ADMIN),
  ctrl.approveAndSendQuotation,
);

router.get(
  '/:id/quotation/history',
  authenticate,
  ctrl.getQuotationHistory,
);

router.get(
  '/project/:projectId/draft',
  authenticate,
  authorize(Role.ENGINEER),
  ctrl.getBlueprintDraft,
);

router.put(
  '/project/:projectId/draft',
  authenticate,
  authorize(Role.ENGINEER),
  validate(upsertBlueprintDraftSchema),
  ctrl.upsertBlueprintDraft,
);

router.post(
  '/project/:projectId/draft/finalize',
  authenticate,
  authorize(Role.ENGINEER),
  ctrl.finalizeBlueprintDraft,
);

router.delete(
  '/project/:projectId/draft',
  authenticate,
  authorize(Role.ENGINEER),
  ctrl.deleteBlueprintDraft,
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
