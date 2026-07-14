import { Router } from 'express';
import * as ctrl from './landing.controller.js';

const router = Router();

router.get('/', ctrl.getLandingContent);

export default router;
