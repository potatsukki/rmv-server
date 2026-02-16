import { Router } from 'express';
import * as ctrl from './maps.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { signedUrlLimiter } from '../../middleware/rateLimiter.js';
import { computeFeeSchema, autocompleteQuerySchema, placeDetailsQuerySchema } from './maps.validation.js';

const router = Router();

// All maps routes require authentication
router.post(
  '/compute-fee',
  authenticate,
  validate(computeFeeSchema),
  ctrl.computeOcularFee,
);

router.post(
  '/compute-route',
  authenticate,
  validate(computeFeeSchema), // Same schema — lat/lng
  ctrl.computeRoute,
);

router.get(
  '/autocomplete',
  authenticate,
  signedUrlLimiter, // Reuse the 10/min limiter for maps proxying
  validate(autocompleteQuerySchema, 'query'),
  ctrl.placesAutocomplete,
);

router.get(
  '/place-details',
  authenticate,
  validate(placeDetailsQuerySchema, 'query'),
  ctrl.placeDetails,
);

export default router;
