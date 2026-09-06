import { Router } from 'express';
import * as ctrl from './config.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { authorize } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { Role } from '../../utils/constants.js';
import {
	updateConfigSchema,
	createHolidaySchema,
	maintenanceToggleSchema,
	createBlockedSlotSchema,
	bulkBlockSlotsSchema,
	bulkUnblockSlotsSchema,
	previewConfigImpactSchema,
	rollbackConfigVersionSchema,
	scheduleMaintenanceSchema,
} from './config.validation.js';

const router = Router();


// Read configs: any authenticated user; write: admin only
router.get('/configs', authenticate, ctrl.listConfigs);
router.get('/configs/:key', authenticate, ctrl.getConfig);
router.get('/configs/:key/versions', authenticate, authorize(Role.ADMIN), ctrl.listConfigVersions);
router.put('/configs/:key', authenticate, authorize(Role.ADMIN), validate(updateConfigSchema), ctrl.upsertConfig);
router.post('/configs/:key/preview', authenticate, authorize(Role.ADMIN), validate(previewConfigImpactSchema), ctrl.previewConfigImpact);
router.post('/configs/:key/rollback', authenticate, authorize(Role.ADMIN), validate(rollbackConfigVersionSchema), ctrl.rollbackConfigVersion);

// Customers need the same holiday calendar the booking service validates against.
router.get('/holidays', authenticate, ctrl.listHolidays);
router.post('/holidays', authenticate, authorize(Role.ADMIN), validate(createHolidaySchema), ctrl.createHoliday);
router.delete('/holidays/:id', authenticate, authorize(Role.ADMIN), ctrl.deleteHoliday);

router.post('/maintenance', authenticate, authorize(Role.ADMIN), validate(maintenanceToggleSchema), ctrl.toggleMaintenance);
router.post('/maintenance/schedule', authenticate, authorize(Role.ADMIN), validate(scheduleMaintenanceSchema), ctrl.scheduleMaintenance);


router.get('/blocked-slots', authenticate, authorize(Role.ADMIN, Role.APPOINTMENT_AGENT), ctrl.listBlockedSlots);
router.post('/blocked-slots/bulk', authenticate, authorize(Role.ADMIN, Role.APPOINTMENT_AGENT), validate(bulkBlockSlotsSchema), ctrl.bulkCreateBlockedSlots);
router.delete('/blocked-slots/bulk', authenticate, authorize(Role.ADMIN, Role.APPOINTMENT_AGENT), validate(bulkUnblockSlotsSchema), ctrl.bulkDeleteBlockedSlots);
router.post('/blocked-slots', authenticate, authorize(Role.ADMIN, Role.APPOINTMENT_AGENT), validate(createBlockedSlotSchema), ctrl.createBlockedSlot);
router.delete('/blocked-slots/:id', authenticate, authorize(Role.ADMIN, Role.APPOINTMENT_AGENT), ctrl.deleteBlockedSlot);

export default router;
