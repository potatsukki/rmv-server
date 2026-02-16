import { Config, Holiday, AuditLog } from '../../models/index.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import { AuditAction } from '../../utils/constants.js';
import type { UpdateConfigInput, CreateHolidayInput } from './config.validation.js';
import type { Types } from 'mongoose';

// ── Config CRUD ──

export async function getConfig(key: string) {
  const config = await Config.findOne({ key });
  if (!config) throw AppError.notFound(`Config key "${key}" not found`);
  return config;
}

export async function listConfigs() {
  return Config.find().sort({ key: 1 });
}

export async function upsertConfig(
  key: string,
  input: UpdateConfigInput,
  adminId: string,
  ip?: string,
  ua?: string,
) {
  const config = await Config.findOneAndUpdate(
    { key },
    {
      value: input.value,
      description: input.description,
      updatedBy: adminId,
    },
    { upsert: true, new: true },
  );

  await AuditLog.create({
    action: AuditAction.CONFIG_UPDATED,
    actorId: adminId,
    targetType: 'config',
    targetId: config._id,
    details: { key, value: input.value },
    ipAddress: ip,
    userAgent: ua,
  });

  return config;
}

// ── Holidays ──

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
  // Check duplicate
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

// ── Maintenance Mode ──

export async function toggleMaintenance(
  enabled: boolean,
  adminId: string,
  ip?: string,
  ua?: string,
) {
  const config = await Config.findOneAndUpdate(
    { key: 'maintenance_mode' },
    { value: enabled, updatedBy: adminId },
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

export async function isMaintenanceMode(): Promise<boolean> {
  const config = await Config.findOne({ key: 'maintenance_mode' });
  return config?.value === true;
}

// ── Default configs seeder ──

export async function seedDefaultConfigs(): Promise<void> {
  const defaults: Record<string, { value: unknown; description: string }> = {
    office_slot_capacity: {
      value: 3,
      description: 'Maximum number of office visit appointments per time slot',
    },
    maintenance_mode: {
      value: false,
      description: 'Enable/disable maintenance mode',
    },
    ocular_fee_config: {
      value: {
        baseFee: 500,
        baseKm: 10,
        extraRatePerKm: 30,
        maxDistanceKm: 100,
      },
      description: 'Ocular visit fee configuration',
    },
  };

  for (const [key, { value, description }] of Object.entries(defaults)) {
    await Config.findOneAndUpdate(
      { key },
      { $setOnInsert: { value, description } },
      { upsert: true },
    );
  }
}
