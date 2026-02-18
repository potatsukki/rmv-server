import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import * as ctrl from './maps.controller.js';
import {
  autocompleteQuerySchema,
  coordinateSchema,
  placeDetailsQuerySchema,
} from './maps.validation.js';

const router = Router();

router.post('/compute-fee', authenticate, validate(coordinateSchema), ctrl.computeOcularFee);
router.post('/compute-route', authenticate, validate(coordinateSchema), ctrl.computeRoute);
router.post('/reverse-geocode', authenticate, validate(coordinateSchema), ctrl.reverseGeocode);

router.get(
  '/autocomplete',
  authenticate,
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
