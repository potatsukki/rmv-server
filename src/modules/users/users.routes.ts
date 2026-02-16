import { Router } from 'express';
import * as usersController from './users.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { authorize } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { Role } from '../../utils/constants.js';
import { createUserSchema, updateUserSchema, updateProfileSchema, salesAvailabilitySchema } from './users.validation.js';

const router = Router();

// ── Admin User Management ──
router.post(
  '/admin/users',
  authenticate,
  authorize(Role.ADMIN),
  validate(createUserSchema),
  usersController.createUser,
);

router.get(
  '/admin/users',
  authenticate,
  authorize(Role.ADMIN),
  usersController.listUsers,
);

router.patch(
  '/admin/users/:id',
  authenticate,
  authorize(Role.ADMIN),
  validate(updateUserSchema),
  usersController.updateUser,
);

router.post(
  '/admin/users/:id/disable',
  authenticate,
  authorize(Role.ADMIN),
  usersController.disableUser,
);

router.post(
  '/admin/users/:id/enable',
  authenticate,
  authorize(Role.ADMIN),
  usersController.enableUser,
);

router.put(
  '/admin/sales-availability',
  authenticate,
  authorize(Role.ADMIN),
  validate(salesAvailabilitySchema),
  usersController.updateSalesAvailability,
);

router.get(
  '/admin/sales-availability/:id',
  authenticate,
  authorize(Role.ADMIN),
  usersController.getSalesAvailability,
);

// ── Sales Staff lookup (for agents assigning staff) ──
router.get(
  '/sales-staff',
  authenticate,
  authorize(Role.APPOINTMENT_AGENT, Role.ADMIN),
  usersController.listSalesStaff,
);

// ── Customer lookup (for agents creating appointments) ──
router.get(
  '/customers',
  authenticate,
  authorize(Role.APPOINTMENT_AGENT, Role.ADMIN),
  usersController.listCustomers,
);

// ── Profile (any authenticated user) ──
router.patch(
  '/profile',
  authenticate,
  validate(updateProfileSchema),
  usersController.updateProfile,
);

export default router;
