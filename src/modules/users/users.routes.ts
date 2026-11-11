import { Router } from 'express';
import * as usersController from './users.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { authorize } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { Role } from '../../utils/constants.js';
import {
  createUserSchema,
  updateUserSchema,
  updateProfileSchema,
  updateOwnAvailabilitySchema,
  salesAvailabilitySchema,
  deleteAccountSchema,
  salesStaffLookupQuerySchema,
} from './users.validation.js';

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
  authorize(Role.ADMIN, Role.ENGINEER),
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

// ── Sales Staff lookup (agents assigning staff; sales staff choosing who takes a project's ocular visit) ──
router.get(
  '/sales-staff',
  authenticate,
  authorize(Role.APPOINTMENT_AGENT, Role.ADMIN, Role.SALES_STAFF),
  validate(salesStaffLookupQuerySchema, 'query'),
  usersController.listSalesStaff,
);

// ── Customer lookup (for agents creating appointments) ──
router.get(
  '/customers',
  authenticate,
  authorize(Role.APPOINTMENT_AGENT, Role.ADMIN, Role.SALES_STAFF),
  usersController.listCustomers,
);

router.get(
  '/customers/:id',
  authenticate,
  authorize(Role.APPOINTMENT_AGENT, Role.ADMIN, Role.SALES_STAFF),
  usersController.getCustomerById,
);

// ── Profile (any authenticated user) ──
router.patch(
  '/profile',
  authenticate,
  validate(updateProfileSchema),
  usersController.updateProfile,
);

router.patch(
  '/profile/availability',
  authenticate,
  authorize(
    Role.SALES_STAFF,
    Role.APPOINTMENT_AGENT,
    Role.ENGINEER,
    Role.CASHIER,
    Role.ADMIN,
    Role.FABRICATION_STAFF,
  ),
  validate(updateOwnAvailabilitySchema),
  usersController.updateOwnAvailability,
);

router.post(
  '/profile/availability/close',
  authenticate,
  authorize(
    Role.SALES_STAFF,
    Role.APPOINTMENT_AGENT,
    Role.ENGINEER,
    Role.CASHIER,
    Role.ADMIN,
    Role.FABRICATION_STAFF,
  ),
  usersController.closeOwnAvailability,
);

// ── E-Signature ──
router.post(
  '/signature',
  authenticate,
  usersController.saveSignature,
);

router.get(
  '/signature',
  authenticate,
  usersController.getSignature,
);

router.delete(
  '/signature',
  authenticate,
  usersController.deleteSignature,
);

// ── Account Deletion ──
router.delete(
  '/account',
  authenticate,
  validate(deleteAccountSchema),
  usersController.deleteAccount,
);

export default router;
