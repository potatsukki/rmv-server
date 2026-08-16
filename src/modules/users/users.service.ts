import bcrypt from 'bcryptjs';
import {
  User,
  AuditLog,
  RefreshToken,
  SalesAvailability,
  Notification,
  OtpToken,
  AvailabilitySession,
  Appointment,
} from '../../models/index.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import { AppointmentType, AuditAction, Role, StaffAvailabilityStatus, type SlotCode } from '../../utils/constants.js';
import type {
  CreateUserInput,
  UpdateUserInput,
  UpdateProfileInput,
  DeleteAccountInput,
  SalesStaffLookupQueryInput,
  UpdateOwnAvailabilityInput,
} from './users.validation.js';
import type { Types } from 'mongoose';
import { getDefaultSavedAddress, normalizeSavedAddresses } from '../../utils/userAddresses.js';
import {
  buildAvailabilityStateSummary,
  evaluateSalesAssignmentEligibility,
  getOpenAvailabilitySession,
  getOpenAvailabilitySessionsByUserIds,
  hasInternalAvailabilityRole,
} from './availability-session.service.js';

async function attachAvailabilitySummaries<T extends {
  _id: Types.ObjectId;
  roles?: Array<Role | string>;
  availabilityStatus?: StaffAvailabilityStatus;
  availabilityNote?: string;
  availabilityUpdatedAt?: Date;
  toObject: () => Record<string, unknown>;
}>(
  users: T[],
): Promise<Array<Record<string, unknown> & {
  _id: string | Types.ObjectId;
  availabilityStatus?: StaffAvailabilityStatus;
}>> {
  const sessionsByUserId = await getOpenAvailabilitySessionsByUserIds(users.map((user) => user._id));

  return users.map((user) => {
    const summary = buildAvailabilityStateSummary(
      {
        roles: user.roles,
        availabilityStatus: user.availabilityStatus,
        availabilityNote: user.availabilityNote,
        availabilityUpdatedAt: user.availabilityUpdatedAt,
      },
      sessionsByUserId.get(user._id.toString()),
    );
    const base = user.toObject() as Record<string, unknown> & {
      _id: string | Types.ObjectId;
      availabilityStatus?: StaffAvailabilityStatus;
      savedAddresses?: any[];
      addressData?: any;
      roles?: Array<Role | string>;
    };
    if (base.roles?.includes(Role.CUSTOMER)) {
      base.savedAddresses = normalizeSavedAddresses(base.savedAddresses, base.addressData);
    }

    return {
      ...base,
      ...summary,
    };
  });
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildUserSearchFilter(search: string, includePhone = false) {
  const trimmed = search.trim();
  const escaped = escapeRegex(trimmed);
  const tokens = trimmed
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const baseFields = [
    { firstName: { $regex: escaped, $options: 'i' } },
    { lastName: { $regex: escaped, $options: 'i' } },
    { email: { $regex: escaped, $options: 'i' } },
    ...(includePhone ? [{ phone: { $regex: escaped, $options: 'i' } }] : []),
  ];

  if (tokens.length <= 1) return { $or: baseFields };

  return {
    $or: [
      ...baseFields,
      {
        $and: tokens.map((token) => ({
          $or: [
            { firstName: { $regex: escapeRegex(token), $options: 'i' } },
            { lastName: { $regex: escapeRegex(token), $options: 'i' } },
            { email: { $regex: escapeRegex(token), $options: 'i' } },
            ...(includePhone ? [{ phone: { $regex: escapeRegex(token), $options: 'i' } }] : []),
          ],
        })),
      },
    ],
  };
}

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
    Object.assign(filter, buildUserSearchFilter(query.search));
  }

  const sortField = query.sortBy || 'createdAt';
  const sortOrder = query.sortOrder === 'asc' ? 1 : -1;

  const users = await User.find(filter)
    .select('-password')
    .sort({ [sortField]: sortOrder })
    .skip((page - 1) * limit)
    .limit(limit);

  return attachAvailabilitySummaries(users);
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
  const nextRoles = input.roles ?? user.roles;
  const targetsInternalRole = hasInternalAvailabilityRole(nextRoles);
  const passwordToSet = typeof input.password === 'string' ? input.password.trim() : '';
  const isPasswordReset = passwordToSet.length > 0;
  if (passwordToSet) {
    user.password = await bcrypt.hash(passwordToSet, 12);
    user.mustChangePassword = true;
  }
  if (input.isActive !== undefined) user.isActive = input.isActive;
  if (input.expiresAt !== undefined) {
    user.expiresAt = input.expiresAt ? new Date(input.expiresAt) : undefined;
  }

  if (
    input.availabilityStatus !== undefined
    || input.availabilityNote !== undefined
    || input.shiftStartAt !== undefined
    || input.shiftEndAt !== undefined
  ) {
    if (!targetsInternalRole) {
      throw AppError.badRequest('Availability status can only be set for internal staff accounts');
    }

    const now = new Date();

    if (input.availabilityStatus !== undefined) {
      const openSession = await getOpenAvailabilitySession(user._id);
      if (openSession) {
        openSession.closedAt = now;
        openSession.updatedBy = adminId as unknown as Types.ObjectId;
        await openSession.save();
      }
      user.availabilityStatus = input.availabilityStatus;
    }
    if (input.availabilityNote !== undefined) {
      user.availabilityNote = input.availabilityNote || undefined;
    }
    user.availabilityUpdatedAt = now;

    if (input.availabilityStatus !== undefined) {
      await AvailabilitySession.create({
        userId: user._id,
        availabilityStatus: input.availabilityStatus,
        availabilityNote: input.availabilityNote || undefined,
        shiftStartAt:
          input.availabilityStatus === StaffAvailabilityStatus.AVAILABLE && input.shiftStartAt
            ? new Date(input.shiftStartAt)
            : undefined,
        shiftEndAt:
          input.availabilityStatus === StaffAvailabilityStatus.AVAILABLE && input.shiftEndAt
            ? new Date(input.shiftEndAt)
            : undefined,
        createdBy: adminId as unknown as Types.ObjectId,
        updatedBy: adminId as unknown as Types.ObjectId,
      });
    }
  }

  if (input.roles && !targetsInternalRole) {
    await AvailabilitySession.updateMany(
      { userId: user._id, closedAt: { $exists: false } },
      { $set: { closedAt: new Date(), updatedBy: adminId as unknown as Types.ObjectId } },
    );
    user.availabilityStatus = undefined;
    user.availabilityNote = undefined;
    user.availabilityUpdatedAt = undefined;
  }

  await user.save();

  if (input.isActive === false || isPasswordReset) {
    await RefreshToken.deleteMany({ userId: user._id });
  }

  const auditDetails: Record<string, unknown> = {
    ...input,
    passwordChanged: isPasswordReset,
  };
  delete auditDetails.password;

  // If deactivated, invalidate sessions and freeze data
  if (input.isActive === false) {
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
      details: auditDetails,
      ipAddress: ip,
      userAgent: ua,
    });
  }

  const [session] = await Promise.all([
    getOpenAvailabilitySession(user._id),
  ]);

  return {
    ...user.toObject(),
    ...buildAvailabilityStateSummary(user, session),
  };
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
  
  // Only allow address updates for CUSTOMER role
  if (user.roles.includes(Role.CUSTOMER)) {
    if (input.address !== undefined) user.address = input.address;
    if (input.savedAddresses !== undefined || input.addressData !== undefined) {
      const savedAddresses = normalizeSavedAddresses(input.savedAddresses, input.addressData || (user as any).addressData);
      if (savedAddresses.length === 0) {
        throw AppError.badRequest('Customer profile must keep at least one pinned saved address.', ErrorCode.VALIDATION_ERROR);
      }
      (user as any).savedAddresses = savedAddresses;
      const defaultAddress = getDefaultSavedAddress(savedAddresses, input.addressData || (user as any).addressData);
      (user as any).addressData = defaultAddress;
      if (defaultAddress?.formattedAddress) user.address = defaultAddress.formattedAddress;
    }
  } else {
    // For internal staff, silently ignore address submissions (backward compatibility)
    // Address fields are not allowed for non-customer roles
  }
  if (input.notificationPreferences) {
    user.notificationPreferences = {
      ...user.notificationPreferences,
      ...input.notificationPreferences,
    };
  }
  if (input.themePreference !== undefined) user.themePreference = input.themePreference;

  await user.save();
  return user;
}

// Admin: Manage sales availability
export async function updateSalesAvailability(
  salesStaffId: string,
  unavailableDates: string[],
  adminId: string,
  availabilityStatus?: StaffAvailabilityStatus,
  availabilityNote?: string | null,
) {
  const salesUser = await User.findById(salesStaffId);
  if (!salesUser || !salesUser.roles.includes(Role.SALES_STAFF)) {
    throw AppError.notFound('Sales staff not found');
  }

  if (availabilityStatus !== undefined) {
    salesUser.availabilityStatus = availabilityStatus;
  }
  if (availabilityNote !== undefined) {
    salesUser.availabilityNote = availabilityNote || undefined;
  }
  if (availabilityStatus !== undefined || availabilityNote !== undefined) {
    salesUser.availabilityUpdatedAt = new Date();
    await salesUser.save();
  }

  await SalesAvailability.findOneAndUpdate(
    { salesStaffId },
    { unavailableDates, updatedBy: adminId },
    { upsert: true, new: true },
  );

  return { message: 'Availability updated' };
}

// Employee: Time in. Availability scheduling remains admin-managed.
export async function updateOwnAvailability(userId: string, input: UpdateOwnAvailabilityInput) {
  const user = await User.findById(userId);
  if (!user) throw AppError.notFound('User not found');
  if (!hasInternalAvailabilityRole(user.roles)) {
    throw AppError.badRequest('Only internal staff can time in');
  }

  const now = new Date();
  const openSession = await getOpenAvailabilitySession(user._id);
  if (openSession) {
    throw AppError.badRequest('You are already timed in');
  }

  user.availabilityStatus = StaffAvailabilityStatus.AVAILABLE;
  user.availabilityNote = input.availabilityNote || 'Timed in';
  user.availabilityUpdatedAt = now;
  await user.save();

  await AvailabilitySession.create({
    userId: user._id,
    availabilityStatus: StaffAvailabilityStatus.AVAILABLE,
    availabilityNote: input.availabilityNote || 'Timed in',
    shiftStartAt: now,
    createdBy: user._id,
    updatedBy: user._id,
  });

  await AuditLog.create({
    action: AuditAction.USER_UPDATED,
    actorId: user._id,
    targetType: 'user',
    targetId: user._id,
    details: {
      timeIn: true,
      shiftStartAt: now.toISOString(),
    },
  });

  const nextSession = await getOpenAvailabilitySession(user._id);
  return {
    ...user.toObject(),
    ...buildAvailabilityStateSummary(user, nextSession),
  };
}

export async function closeOwnAvailability(userId: string) {
  const user = await User.findById(userId);
  if (!user) throw AppError.notFound('User not found');
  if (!hasInternalAvailabilityRole(user.roles)) {
    throw AppError.badRequest('Only internal staff can time out');
  }

  const session = await getOpenAvailabilitySession(user._id);
  if (!session) {
    throw AppError.badRequest('You are not currently timed in');
  }

  const now = new Date();
  session.closedAt = now;
  session.shiftEndAt = session.shiftEndAt || now;
  session.updatedBy = user._id;
  await session.save();

  user.availabilityStatus = undefined;
  user.availabilityNote = undefined;
  user.availabilityUpdatedAt = now;
  await user.save();

  await AuditLog.create({
    action: AuditAction.USER_UPDATED,
    actorId: user._id,
    targetType: 'user',
    targetId: user._id,
    details: { timeOut: true, closedSessionId: session._id.toString(), shiftEndAt: now.toISOString() },
  });

  return {
    ...user.toObject(),
    ...buildAvailabilityStateSummary(user, null),
  };
}

export async function getSalesAvailability(salesStaffId: string) {
  const availability = await SalesAvailability.findOne({ salesStaffId });
  return availability?.unavailableDates || [];
}

// List users by role (for agent lookups)
export async function listByRole(
  role: string,
  search?: string,
  assignmentContext?: SalesStaffLookupQueryInput,
) {
  const filter: Record<string, unknown> = { roles: role, isActive: true };
  if (search) {
    Object.assign(filter, buildUserSearchFilter(search, true));
  }

  const users = await User.find(filter)
    .select('firstName lastName email phone roles isActive availabilityStatus availabilityNote availabilityUpdatedAt addressData savedAddresses')
    .sort({ firstName: 1 })
    .limit(50);

  const withSummaries = await attachAvailabilitySummaries(users);

  if (
    role !== Role.SALES_STAFF
    || !assignmentContext?.date
    || !assignmentContext.slotCode
  ) {
    return withSummaries;
  }

  const dateStr = assignmentContext.date;
  const slotCode = assignmentContext.slotCode as SlotCode;
  const targetAppointment = assignmentContext.appointmentId
    ? await Appointment.findById(assignmentContext.appointmentId).select('type').lean()
    : null;
  const appointmentType = targetAppointment?.type as AppointmentType | undefined;
  const salesUsers = withSummaries as Array<{
    _id: string | Types.ObjectId;
    availabilityStatus?: StaffAvailabilityStatus;
    [key: string]: unknown;
  }>;

  return Promise.all(
    salesUsers.map(async (user) => {
      const eligibility = await evaluateSalesAssignmentEligibility({
        salesStaffId: String(user._id),
        userAvailabilityStatus: user.availabilityStatus,
        session: await getOpenAvailabilitySession(String(user._id)),
        dateStr,
        slotCode,
        appointmentType,
        appointmentId: assignmentContext.appointmentId,
      });

      return {
        ...user,
        ...eligibility,
      };
    }),
  );
}

export async function getCustomerById(userId: string) {
  const user = await User.findOne({ _id: userId, roles: 'customer', isActive: true })
    .select('firstName lastName email phone addressData savedAddresses')
    .lean();
  if (!user) throw AppError.notFound('Customer not found');
  const savedAddresses = normalizeSavedAddresses((user as any).savedAddresses, (user as any).addressData);
  return {
    ...user,
    savedAddresses,
    addressData: getDefaultSavedAddress(savedAddresses, (user as any).addressData) || (user as any).addressData,
  };
}

// ── Save E-Signature ──

export async function saveSignature(userId: string, signatureKey: string) {
  const user = await User.findById(userId);
  if (!user) throw AppError.notFound('User not found');

  user.signatureKey = signatureKey;
  await user.save();

  return { signatureKey: user.signatureKey };
}

// ── Get User Signature ──

export async function getSignature(userId: string) {
  const user = await User.findById(userId).select('signatureKey');
  if (!user) throw AppError.notFound('User not found');
  return { signatureKey: user.signatureKey || null };
}

// ── Delete E-Signature ──

export async function deleteSignature(userId: string) {
  const user = await User.findById(userId);
  if (!user) throw AppError.notFound('User not found');

  user.signatureKey = undefined;
  await user.save();

  return { signatureKey: null };
}

// Self: Delete own account
export async function deleteAccount(userId: string, input: DeleteAccountInput, ip?: string, ua?: string) {
  const user = await User.findById(userId).select('+password +provider');
  if (!user) throw AppError.notFound('User not found');

  // Local users must confirm with their password
  if (user.provider !== 'google') {
    if (!input.password) throw AppError.badRequest('Password is required to delete your account', ErrorCode.VALIDATION_ERROR);
    const isMatch = await bcrypt.compare(input.password, user.password);
    if (!isMatch) throw AppError.badRequest('Incorrect password', ErrorCode.INVALID_CREDENTIALS);
  }

  // Soft-delete: mark inactive and set deletedAt
  const originalEmail = user.email;
  user.isActive = false;
  user.deletedAt = new Date();
  // Scramble the email so the unique index frees up the address for re-registration
  user.email = `deleted_${Date.now()}_${user.email}`;
  // Clear firebaseUid so Google sign-up can reuse the UID
  user.firebaseUid = undefined;
  await user.save();

  // Revoke all sessions
  await RefreshToken.deleteMany({ userId: user._id });

  // Delete OTP tokens and notifications
  await OtpToken.deleteMany({ email: originalEmail });
  await Notification.deleteMany({ userId: user._id });

  await AuditLog.create({
    action: AuditAction.USER_DELETED,
    actorId: user._id,
    actorEmail: originalEmail,
    targetType: 'user',
    targetId: user._id,
    details: { originalEmail },
    ipAddress: ip,
    userAgent: ua,
  });

  return { message: 'Account deleted successfully.' };
}

