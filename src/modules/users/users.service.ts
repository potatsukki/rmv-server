import bcrypt from 'bcryptjs';
import { User, AuditLog, RefreshToken, SalesAvailability } from '../../models/index.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import { AuditAction, Role } from '../../utils/constants.js';
import type { CreateUserInput, UpdateUserInput, UpdateProfileInput } from './users.validation.js';
import type { Types } from 'mongoose';

// Admin: Create user
export async function createUser(input: CreateUserInput, adminId: string, ip?: string, ua?: string) {
  const existing = await User.findOne({ email: input.email });
  if (existing) throw AppError.conflict('Email already registered', ErrorCode.DUPLICATE_ENTRY);

  const hashedPassword = await bcrypt.hash(input.password, 12);

  const user = await User.create({
    email: input.email,
    password: hashedPassword,
    firstName: input.firstName,
    lastName: input.lastName,
    phone: input.phone || undefined,
    roles: input.roles,
    isEmailVerified: true, // Staff accounts are pre-verified
    mustChangePassword: true,
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
  });

  await AuditLog.create({
    action: AuditAction.USER_CREATED,
    actorId: adminId as unknown as Types.ObjectId,
    targetType: 'user',
    targetId: user._id,
    details: { roles: input.roles, hasExpiry: !!input.expiresAt },
    ipAddress: ip,
    userAgent: ua,
  });

  return {
    id: user._id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    roles: user.roles,
    mustChangePassword: true,
  };
}

// Admin: List users
export async function listUsers(query: {
  role?: string;
  isActive?: string;
  search?: string;
  page?: string;
  limit?: string;
  sortBy?: string;
  sortOrder?: string;
}) {
  const page = parseInt(query.page || '1');
  const limit = Math.min(parseInt(query.limit || '20'), 100);
  const filter: Record<string, unknown> = {};

  if (query.role) filter.roles = query.role;
  if (query.isActive !== undefined) filter.isActive = query.isActive === 'true';
  if (query.search) {
    filter.$or = [
      { firstName: { $regex: query.search, $options: 'i' } },
      { lastName: { $regex: query.search, $options: 'i' } },
      { email: { $regex: query.search, $options: 'i' } },
    ];
  }

  const sortField = query.sortBy || 'createdAt';
  const sortOrder = query.sortOrder === 'asc' ? 1 : -1;

  const [users, total] = await Promise.all([
    User.find(filter)
      .select('-password')
      .sort({ [sortField]: sortOrder })
      .skip((page - 1) * limit)
      .limit(limit),
    User.countDocuments(filter),
  ]);

  return users;
}

// Admin: Update user
export async function updateUser(userId: string, input: UpdateUserInput, adminId: string, ip?: string, ua?: string) {
  const user = await User.findById(userId);
  if (!user) throw AppError.notFound('User not found');

  // Prevent modifying super admin
  if (user.isSuperAdmin && adminId !== user._id.toString()) {
    throw AppError.forbidden('Cannot modify Super Admin');
  }

  if (input.firstName) user.firstName = input.firstName;
  if (input.lastName) user.lastName = input.lastName;
  if (input.phone) user.phone = input.phone;
  if (input.roles) user.roles = input.roles;
  if (input.isActive !== undefined) user.isActive = input.isActive;
  if (input.expiresAt !== undefined) {
    user.expiresAt = input.expiresAt ? new Date(input.expiresAt) : undefined;
  }

  await user.save();

  // If deactivated, invalidate sessions and freeze data
  if (input.isActive === false) {
    await RefreshToken.deleteMany({ userId: user._id });
    await AuditLog.create({
      action: AuditAction.USER_DISABLED,
      actorId: adminId as unknown as Types.ObjectId,
      targetType: 'user',
      targetId: user._id,
      ipAddress: ip,
      userAgent: ua,
    });
  } else {
    await AuditLog.create({
      action: AuditAction.USER_UPDATED,
      actorId: adminId as unknown as Types.ObjectId,
      targetType: 'user',
      targetId: user._id,
      details: input,
      ipAddress: ip,
      userAgent: ua,
    });
  }

  return user;
}

// Admin: Disable user
export async function disableUser(userId: string, adminId: string, ip?: string, ua?: string) {
  const user = await User.findById(userId);
  if (!user) throw AppError.notFound('User not found');
  if (user.isSuperAdmin) throw AppError.forbidden('Cannot disable Super Admin');

  user.isActive = false;
  await user.save();

  // Invalidate all sessions
  await RefreshToken.deleteMany({ userId: user._id });

  await AuditLog.create({
    action: AuditAction.USER_DISABLED,
    actorId: adminId as unknown as Types.ObjectId,
    targetType: 'user',
    targetId: user._id,
    ipAddress: ip,
    userAgent: ua,
  });

  return { message: 'User disabled successfully' };
}

// Admin: Enable user
export async function enableUser(userId: string, adminId: string, ip?: string, ua?: string) {
  const user = await User.findById(userId);
  if (!user) throw AppError.notFound('User not found');

  if (user.isActive) {
    return { message: 'User is already enabled' };
  }

  user.isActive = true;
  await user.save();

  await AuditLog.create({
    action: AuditAction.USER_ENABLED,
    actorId: adminId as unknown as Types.ObjectId,
    targetType: 'user',
    targetId: user._id,
    ipAddress: ip,
    userAgent: ua,
  });

  return { message: 'User enabled successfully' };
}

// Profile: Update own profile
export async function updateProfile(userId: string, input: UpdateProfileInput) {
  const user = await User.findById(userId);
  if (!user) throw AppError.notFound('User not found');

  if (input.firstName) user.firstName = input.firstName;
  if (input.lastName) user.lastName = input.lastName;
  if (input.phone) user.phone = input.phone;
  if (input.address !== undefined) user.address = input.address;
  if (input.notificationPreferences) {
    user.notificationPreferences = {
      ...user.notificationPreferences,
      ...input.notificationPreferences,
    };
  }

  await user.save();
  return user;
}

// Admin: Manage sales availability
export async function updateSalesAvailability(
  salesStaffId: string,
  unavailableDates: string[],
  adminId: string,
) {
  const salesUser = await User.findById(salesStaffId);
  if (!salesUser || !salesUser.roles.includes(Role.SALES_STAFF)) {
    throw AppError.notFound('Sales staff not found');
  }

  await SalesAvailability.findOneAndUpdate(
    { salesStaffId },
    { unavailableDates, updatedBy: adminId },
    { upsert: true, new: true },
  );

  return { message: 'Availability updated' };
}

export async function getSalesAvailability(salesStaffId: string) {
  const availability = await SalesAvailability.findOne({ salesStaffId });
  return availability?.unavailableDates || [];
}

// List users by role (for agent lookups)
export async function listByRole(role: string, search?: string) {
  const filter: Record<string, unknown> = { roles: role, isActive: true };
  if (search) {
    filter.$or = [
      { firstName: { $regex: search, $options: 'i' } },
      { lastName: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } },
    ];
  }
  return User.find(filter)
    .select('firstName lastName email phone')
    .sort({ firstName: 1 })
    .limit(50);
}


