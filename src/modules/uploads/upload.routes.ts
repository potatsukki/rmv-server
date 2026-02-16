import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { signedUrlLimiter } from '../../middleware/rateLimiter.js';
import {
  signedUploadUrlSchema,
  signedDownloadUrlSchema,
  verifyUploadSchema,
  viewFileQuerySchema,
} from './upload.validation.js';
import * as UploadController from './upload.controller.js';

const router = Router();

// All upload routes require auth + signed URL rate limit
router.use(authenticate);

router.get(
  '/view',
  validate(viewFileQuerySchema, 'query'),
  UploadController.viewFile,
);

router.use(signedUrlLimiter);

router.post(
  '/signed-upload-url',
  validate(signedUploadUrlSchema),
  UploadController.getSignedUploadUrl,
);

router.post(
  '/signed-download-url',
  validate(signedDownloadUrlSchema),
  UploadController.getSignedDownloadUrl,
);

router.post(
  '/verify',
  validate(verifyUploadSchema),
  UploadController.verifyUpload,
);

export default router;
