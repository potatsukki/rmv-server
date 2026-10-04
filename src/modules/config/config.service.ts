import { Config, Holiday, AuditLog, BlockedSlot, User } from '../../models/index.js';
import { notifyAllUsers } from '../notifications/socket.service.js';
import { NotificationCategory } from '../../utils/constants.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import { gcashSettingsSchema } from '../payments/gcash.validation.js';
import { AuditAction } from '../../utils/constants.js';
import type {
  UpdateConfigInput,
  CreateHolidayInput,
  CreateBlockedSlotInput,
  BulkBlockSlotsInput,
  BulkUnblockSlotsInput,
  RollbackConfigVersionInput,
} from './config.validation.js';

const LEGACY_SHOP_COORDS = {
  lat: 14.6617,
  lng: 120.9567,
};

const MAPULANG_LUPA_SHOP_COORDS = {
  lat: 14.7020893,
  lng: 121.0000338,
};

const DAHLIA_EXT_PLUS_CODE_COORDS = {
  lat: 14.6995125,
  lng: 121.053703125,
};

const HIGH_RISK_CONFIG_KEYS = new Set([
  'maintenance_mode',
  'feature_lifecycle_mismatch_analytics',
  'payment_activation_map',
  'payment_headsup_map',
  'payment_reminder_grace_days',
  'payment_reminder_interval_days',
  'payment_escalation_after_reminders',
  'installment_surcharge_percent',
  'installment_split',
]);

function valuesEqual(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return a === b;
  }
}

export async function getConfig(key: string) {
  const config = await Config.findOne({ key });
  if (!config) throw AppError.notFound(`Config key "${key}" not found`);
  return config;
}

/** Get a config value with fallback (no throw). */
export async function getConfigValue<T = unknown>(key: string, fallback: T): Promise<T> {
  const config = await Config.findOne({ key });
  return config ? (config.value as T) : fallback;
}

/** Get all payment-related installment config in one call. */
export async function getInstallmentConfig() {
  const [surcharge, split, labels, descriptions] = await Promise.all([
    getConfigValue<number>('installment_surcharge_percent', 10),
    getConfigValue<number[]>('installment_split', [30, 40, 30]),
    getConfigValue<string[]>('installment_stage_labels', ['Down Payment', 'Mid-Project', 'Final Payment']),
    getConfigValue<string[]>('installment_stage_descriptions', ['Initial payment before fabrication', 'Due when fabrication is complete', 'Due after installation & acceptance']),
  ]);
  return { surchargePercent: surcharge, split, stageLabels: labels, stageDescriptions: descriptions };
}

/**
 * Get payment activation config — maps payment stage index to fabrication status triggers.
 * - activationMap: fabrication status that activates (makes due) each stage. null = activate immediately.
 * - headsUpMap: fabrication status that sends an advance "prepare" notice. null = no heads-up.
 * - reminderGraceDays: days after activation before first overdue reminder.
 * - reminderIntervalDays: days between subsequent reminders.
 * - escalationAfterReminders: number of customer reminders before notifying the cashier.
 */
export async function getPaymentActivationConfig() {
  const [activationMap, headsUpMap, graceDays, intervalDays, escalationCount] = await Promise.all([
    getConfigValue<(string | null)[]>('payment_activation_map', [null, 'quality_check', 'done']),
    getConfigValue<(string | null)[]>('payment_headsup_map', [null, 'finishing', 'ready_for_delivery']),
    getConfigValue<number>('payment_reminder_grace_days', 3),
    getConfigValue<number>('payment_reminder_interval_days', 2),
    getConfigValue<number>('payment_escalation_after_reminders', 3),
  ]);
  return {
    activationMap,
    headsUpMap,
    reminderGraceDays: graceDays,
    reminderIntervalDays: intervalDays,
    escalationAfterReminders: escalationCount,
  };
}

export async function listConfigs() {
  return Config.find().select('-versions').sort({ key: 1 });
}

export async function upsertConfig(
  key: string,
  input: UpdateConfigInput,
  adminId: string,
  ip?: string,
  ua?: string,
) {
  const existing = await Config.findOne({ key });
  if (key === 'gcash_payment') {
    const parsed = gcashSettingsSchema.safeParse(input.value);
    if (!parsed.success) throw AppError.badRequest('Invalid GCash account information');
    input.value = parsed.data;
  }
  const hasPrevious = !!existing;
  const changed = !existing || !valuesEqual(existing.value, input.value) || existing.description !== input.description;

  const update: Record<string, unknown> = {
    value: input.value,
    description: input.description,
    updatedBy: adminId,
  };

  if (hasPrevious && changed) {
    update.$push = {
      versions: {
        $each: [{
          value: existing!.value,
          description: existing!.description,
          updatedBy: existing!.updatedBy,
          updatedAt: existing!.updatedAt,
        }],
        $slice: -30,
      },
    };
  }

  const config = await Config.findOneAndUpdate(
    { key },
    update,
    { upsert: true, new: true },
  );

  await AuditLog.create({
    action: AuditAction.CONFIG_UPDATED,
    actorId: adminId,
    targetType: 'config',
    targetId: config._id,
    details: {
      key,
      value: input.value,
      previousValue: existing?.value,
      highRisk: HIGH_RISK_CONFIG_KEYS.has(key),
    },
    ipAddress: ip,
    userAgent: ua,
  });

  return config;
}

export async function previewConfigImpact(key: string, value: unknown) {
  const warnings: string[] = [];

  if (key === 'maintenance_mode' && value === true) {
    warnings.push('Enabling maintenance mode blocks non-admin users immediately.');
  }

  if (key === 'feature_lifecycle_mismatch_analytics' && value === false) {
    warnings.push('Disabling lifecycle analytics hides hotspot alerts and trend visibility for operations.');
  }

  if (key === 'installment_surcharge_percent') {
    const num = Number(value);
    if (Number.isNaN(num) || num < 0 || num > 100) {
      warnings.push('Installment surcharge should remain between 0 and 100.');
    } else if (num >= 25) {
      warnings.push('High surcharge may significantly increase installment totals for customers.');
    }
  }

  if (key === 'installment_split' && Array.isArray(value)) {
    const sum = value.map((v) => Number(v)).reduce((acc, n) => acc + (Number.isNaN(n) ? 0 : n), 0);
    if (Math.abs(sum - 100) > 0.01) {
      warnings.push(`Installment split should total 100. Current total is ${sum}.`);
    }
  }

  if (key.startsWith('payment_')) {
    warnings.push('Payment activation/reminder changes alter due-date behavior across in-flight projects.');
  }

  const riskLevel = warnings.length >= 2 || HIGH_RISK_CONFIG_KEYS.has(key)
    ? (warnings.length >= 2 ? 'high' : 'medium')
    : 'low';

  return {
    key,
    riskLevel,
    warnings,
    requiresConfirmation: riskLevel !== 'low',
  };
}

export async function listConfigVersions(key: string, limit = 20) {
  const config = await Config.findOne({ key });
  if (!config) throw AppError.notFound(`Config key "${key}" not found`);

  const versions = (config.versions || [])
    .slice()
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, Math.max(1, Math.min(limit, 50)));

  return {
    key,
    current: {
      value: config.value,
      description: config.description,
      updatedAt: config.updatedAt,
      updatedBy: config.updatedBy,
    },
    versions,
  };
}

export async function rollbackConfigVersion(
  key: string,
  input: RollbackConfigVersionInput,
  adminId: string,
  ip?: string,
  ua?: string,
) {
  const config = await Config.findOne({ key });
  if (!config) throw AppError.notFound(`Config key "${key}" not found`);

  const version = config.versions.find((entry) => entry._id.toString() === input.versionId);
  if (!version) throw AppError.notFound('Config version not found');

  config.versions.push({
    value: config.value,
    description: config.description,
    updatedBy: config.updatedBy,
    updatedAt: config.updatedAt,
  } as any);

  if (config.versions.length > 30) {
    config.versions = config.versions.slice(config.versions.length - 30);
  }

  config.value = version.value;
  config.description = version.description;
  config.updatedBy = adminId as any;
  await config.save();

  await AuditLog.create({
    action: AuditAction.CONFIG_ROLLED_BACK,
    actorId: adminId,
    targetType: 'config',
    targetId: config._id,
    details: {
      key,
      rolledBackToVersionId: input.versionId,
      value: version.value,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  return config;
}

export async function listHolidays(year?: string) {
  const filter: Record<string, unknown> = {};
  if (year) filter.date = { $regex: `^${year}` };

  return Holiday.find(filter).sort({ date: 1 });
}

export async function createHoliday(
  input: CreateHolidayInput,
  adminId: string,
  ip?: string,
  ua?: string,
) {
  const existing = await Holiday.findOne({ date: input.date });
  if (existing) throw AppError.conflict('Holiday already exists on this date', ErrorCode.DUPLICATE_ENTRY);

  const holiday = await Holiday.create({
    date: input.date,
    name: input.name,
    createdBy: adminId,
  });

  await AuditLog.create({
    action: AuditAction.HOLIDAY_CREATED,
    actorId: adminId,
    targetType: 'holiday',
    targetId: holiday._id,
    details: { date: input.date, name: input.name },
    ipAddress: ip,
    userAgent: ua,
  });

  return holiday;
}

export async function deleteHoliday(
  holidayId: string,
  adminId: string,
  ip?: string,
  ua?: string,
) {
  const holiday = await Holiday.findByIdAndDelete(holidayId);
  if (!holiday) throw AppError.notFound('Holiday not found');

  await AuditLog.create({
    action: AuditAction.HOLIDAY_DELETED,
    actorId: adminId,
    targetType: 'holiday',
    targetId: holiday._id,
    details: { date: holiday.date, name: holiday.name },
    ipAddress: ip,
    userAgent: ua,
  });

  return { deleted: true };
}

export async function toggleMaintenance(
  enabled: boolean,
  adminId: string,
  ip?: string,
  ua?: string,
) {
  const update: any = { value: enabled, updatedBy: adminId };
  // If disabling, also clear any scheduled time
  if (!enabled) {
    await Config.findOneAndUpdate({ key: 'maintenance_scheduled_at' }, { value: null });
  }

  const config = await Config.findOneAndUpdate(
    { key: 'maintenance_mode' },
    update,
    { upsert: true, new: true },
  );

  await AuditLog.create({
    action: AuditAction.MAINTENANCE_TOGGLED,
    actorId: adminId,
    targetType: 'config',
    targetId: config._id,
    details: { enabled },
    ipAddress: ip,
    userAgent: ua,
  });

  return { maintenanceMode: enabled };
}

/**
 * Schedule maintenance and notify all users.
 */
export async function scheduleMaintenance(
  scheduledAt: Date,
  reason: string,
  adminId: string,
  ip?: string,
  ua?: string,
) {
  // 1. Update Configs
  await Promise.all([
    Config.findOneAndUpdate(
      { key: 'maintenance_scheduled_at' },
      { value: scheduledAt, updatedBy: adminId },
      { upsert: true }
    ),
    Config.findOneAndUpdate(
      { key: 'maintenance_message' },
      { value: reason, updatedBy: adminId },
      { upsert: true }
    ),
    // Ensure maintenance_mode is false initially so it only triggers at the time
    Config.findOneAndUpdate(
      { key: 'maintenance_mode' },
      { value: false, updatedBy: adminId },
      { upsert: true }
    )
  ]);

  // 2. Notify all users
  const formattedDate = new Date(scheduledAt).toLocaleString('en-US', {
    dateStyle: 'long',
    timeStyle: 'short',
  });

  await notifyAllUsers(
    NotificationCategory.SYSTEM,
    'Upcoming System Maintenance',
    `The system will be unavailable for maintenance starting ${formattedDate}.${reason ? ` Reason: ${reason}` : ''}`
  );

  // 3. Audit Log
  await AuditLog.create({
    action: AuditAction.CONFIG_UPDATED,
    actorId: adminId,
    targetType: 'config',
    details: {
      key: 'maintenance_scheduled_at',
      value: scheduledAt,
      reason,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  return { success: true, scheduledAt };
}


export async function isMaintenanceMode(): Promise<boolean> {
  const config = await Config.findOne({ key: 'maintenance_mode' });
  return config?.value === true;
}

// ── Blocked Slots ──

export async function listBlockedSlots(date?: string) {
  const filter: Record<string, unknown> = {};
  if (date) filter.date = date;
  return BlockedSlot.find(filter).sort({ date: 1, slotCode: 1 }).populate('blockedBy', 'firstName lastName');
}

export async function createBlockedSlot(
  input: CreateBlockedSlotInput,
  userId: string,
  ip?: string,
  ua?: string,
) {
  const existing = await BlockedSlot.findOne({ date: input.date, slotCode: input.slotCode, type: input.type });
  if (existing) throw AppError.conflict('This slot is already blocked', ErrorCode.DUPLICATE_ENTRY);

  const slot = await BlockedSlot.create({
    date: input.date,
    slotCode: input.slotCode,
    type: input.type,
    reason: input.reason,
    blockedBy: userId,
  });

  await AuditLog.create({
    action: AuditAction.SLOT_BLOCKED,
    actorId: userId,
    targetType: 'blockedSlot',
    targetId: slot._id,
    details: { date: input.date, slotCode: input.slotCode, type: input.type, reason: input.reason },
    ipAddress: ip,
    userAgent: ua,
  });

  return slot;
}

export async function deleteBlockedSlot(
  slotId: string,
  userId: string,
  ip?: string,
  ua?: string,
) {
  const slot = await BlockedSlot.findByIdAndDelete(slotId);
  if (!slot) throw AppError.notFound('Blocked slot not found');

  await AuditLog.create({
    action: AuditAction.SLOT_UNBLOCKED,
    actorId: userId,
    targetType: 'blockedSlot',
    targetId: slot._id,
    details: { date: slot.date, slotCode: slot.slotCode, type: slot.type },
    ipAddress: ip,
    userAgent: ua,
  });

  return { deleted: true };
}

export async function bulkCreateBlockedSlots(
  input: BulkBlockSlotsInput,
  userId: string,
  ip?: string,
  ua?: string,
) {
  const docs = input.slots.map((s) => ({
    date: input.date,
    slotCode: s.slotCode,
    type: s.type,
    reason: input.reason,
    blockedBy: userId,
  }));

  let created = 0;
  let skipped = 0;

  try {
    const result = await BlockedSlot.insertMany(docs, { ordered: false });
    created = result.length;
    skipped = docs.length - created;
  } catch (err: unknown) {
    // BulkWriteError — some succeeded, some duplicates
    const bwe = err as { code?: number; insertedDocs?: unknown[] };
    if (bwe.code === 11000) {
      created = (bwe.insertedDocs ?? []).length;
      skipped = docs.length - created;
    } else {
      throw err;
    }
  }

  if (created > 0) {
    await AuditLog.create({
      action: AuditAction.SLOTS_BULK_BLOCKED,
      actorId: userId,
      targetType: 'blockedSlot',
      details: {
        date: input.date,
        slots: input.slots,
        reason: input.reason,
        created,
        skipped,
      },
      ipAddress: ip,
      userAgent: ua,
    });
  }

  return { created, skipped };
}

export async function bulkDeleteBlockedSlots(
  input: BulkUnblockSlotsInput,
  userId: string,
  ip?: string,
  ua?: string,
) {
  const slots = await BlockedSlot.find({ _id: { $in: input.ids } });
  if (!slots.length) throw AppError.notFound('No blocked slots found for the given IDs');

  const details = slots.map((s) => ({ date: s.date, slotCode: s.slotCode, type: s.type }));
  await BlockedSlot.deleteMany({ _id: { $in: input.ids } });

  await AuditLog.create({
    action: AuditAction.SLOTS_BULK_UNBLOCKED,
    actorId: userId,
    targetType: 'blockedSlot',
    details: { slots: details, count: slots.length },
    ipAddress: ip,
    userAgent: ua,
  });

  return { deleted: slots.length };
}

export async function seedDefaultConfigs(): Promise<void> {
  const defaults: Record<string, { value: unknown; description: string }> = {
    maintenance_mode: {
      value: false,
      description: 'Enable/disable maintenance mode',
    },
    maintenance_scheduled_at: {
      value: null,
      description: 'Scheduled timestamp for when maintenance mode should take effect',
    },
    maintenance_message: {
      value: '',
      description: 'Reason or custom message for the scheduled maintenance',
    },
    ocular_fee_config: {
      value: {
        baseFee: 350,
        baseKm: 10,
        extraRatePerKm: 60,
        maxDistanceKm: 100,
      },
      description: 'Legacy ocular visit fee configuration (backward compatibility)',
    },
    shopLatitude: {
      value: DAHLIA_EXT_PLUS_CODE_COORDS.lat,
      description: 'Shop latitude used as routing origin for ocular visits',
    },
    shopLongitude: {
      value: DAHLIA_EXT_PLUS_CODE_COORDS.lng,
      description: 'Shop longitude used as routing origin for ocular visits',
    },
    baseCoveredKm: {
      value: 10,
      description: 'Distance covered by the base ocular fee for outside-NCR visits',
    },
    baseFee: {
      value: 350,
      description: 'Minimum ocular transportation fee (outside NCR)',
    },
    perKmRate: {
      value: 60,
      description: 'Additional ocular transportation fee per kilometer outside base coverage',
    },
    maxDistanceKm: {
      value: 100,
      description: 'Maximum serviceable distance for ocular visits',
    },
    ncrPolygonFile: {
      value: 'src/modules/maps/data/ncr-boundary.json',
      description: 'GeoJSON file path used for NCR point-in-polygon validation',
    },
    installment_surcharge_percent: {
      value: 10,
      description: 'Surcharge percentage applied to installment payments (e.g. 10 = 10%)',
    },
    installment_split: {
      value: [30, 40, 30],
      description: 'Installment split percentages for each stage (must sum to 100)',
    },
    installment_stage_labels: {
      value: ['Down Payment', 'Mid-Project', 'Final Payment'],
      description: 'Labels for each installment stage corresponding to installment_split',
    },
    installment_stage_descriptions: {
      value: ['Initial payment before fabrication', 'Due when fabrication is complete', 'Due after installation & acceptance'],
      description: 'Default milestone descriptions for each installment stage',
    },
    payment_activation_map: {
      value: [null, 'quality_check', 'done'],
      description: 'Fabrication status that activates (makes due) each payment stage. null = activate immediately. Array index corresponds to stage index.',
    },
    payment_headsup_map: {
      value: [null, 'finishing', 'ready_for_delivery'],
      description: 'Fabrication status that sends an advance "prepare your payment" notice. null = no heads-up.',
    },
    payment_reminder_grace_days: {
      value: 3,
      description: 'Days after a payment stage is activated before the first overdue reminder is sent',
    },
    payment_reminder_interval_days: {
      value: 2,
      description: 'Days between subsequent overdue reminders to the customer',
    },
    payment_escalation_after_reminders: {
      value: 3,
      description: 'Number of customer reminders sent before escalating to the cashier',
    },
    help_center_content: {
      value: {
        title: 'Help Center',
        subtitle: 'Guides for bookings, payments, and project tracking.',
        sections: [
          {
            heading: 'Booking appointments',
            body: 'Use the Appointments page to create, reschedule, or monitor your visits.',
          },
          {
            heading: 'Payments',
            body: 'Use Payments to monitor and manage your project stage payments.',
          },
          {
            heading: 'Project tracking',
            body: 'Use the Projects page to monitor blueprint, payment, and fabrication milestones.',
          },
          {
            heading: 'Need support?',
            body: 'Contact your assigned staff through the portal notifications channel.',
          },
        ],
        roleSections: {
          admin: [
            {
              heading: 'Admin controls',
              body: 'Use Settings and Slot Management for maintenance mode, holidays, and appointment slot blocks.',
            },
          ],
          cashier: [
            {
              heading: 'Cashier operations',
              body: 'Use Cashier Queue for payment verification.',
            },
          ],
        },
      },
      description: 'Help Center page content shown to authenticated users. Editable by admin.',
    },
  };

  for (const [key, { value, description }] of Object.entries(defaults)) {
    await Config.findOneAndUpdate(
      { key },
      { $setOnInsert: { value, description } },
      { upsert: true },
    );
  }

  // One-time migration from known previous seeded coordinates to
  // exact Plus Code location: M3X3+RF4, Dahlia Ext, Quezon City.
  await Config.updateOne(
    {
      key: 'shopLatitude',
      value: {
        $in: [
          LEGACY_SHOP_COORDS.lat,
          String(LEGACY_SHOP_COORDS.lat),
          MAPULANG_LUPA_SHOP_COORDS.lat,
          String(MAPULANG_LUPA_SHOP_COORDS.lat),
          14.7004606,
          '14.7004606',
        ],
      },
    },
    { $set: { value: DAHLIA_EXT_PLUS_CODE_COORDS.lat } },
  );
  await Config.updateOne(
    {
      key: 'shopLongitude',
      value: {
        $in: [
          LEGACY_SHOP_COORDS.lng,
          String(LEGACY_SHOP_COORDS.lng),
          MAPULANG_LUPA_SHOP_COORDS.lng,
          String(MAPULANG_LUPA_SHOP_COORDS.lng),
          121.0553413,
          '121.0553413',
        ],
      },
    },
    { $set: { value: DAHLIA_EXT_PLUS_CODE_COORDS.lng } },
  );
}
