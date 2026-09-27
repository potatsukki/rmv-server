import mongoose, { Schema, Document, Types } from 'mongoose';
import { Role, StaffAvailabilityStatus } from '../utils/constants.js';
import { generateCustomerNumber } from '../utils/publicIdentifiers.js';

export interface IUserAddress {
  id?: string;
  label?: string;
  street?: string;
  barangay?: string;
  city?: string;
  province?: string;
  zip?: string;
  country?: string;
  addressType?: 'personal' | 'business';
  lat?: number;
  lng?: number;
  formattedAddress?: string;
  isDefault?: boolean;
}

export interface IUser extends Document {
  _id: Types.ObjectId;
  email: string;
  customerNumber?: string;
  password: string;
  firstName: string;
  lastName: string;
  phone: string;
  address?: string;          // Legacy plain-text address (kept for backwards compat)
  addressData?: IUserAddress; // Structured address with map pin
  savedAddresses?: IUserAddress[];
  roles: Role[];
  isEmailVerified: boolean;
  isActive: boolean;
  mustChangePassword: boolean;
  isSuperAdmin: boolean;
  twoFactorEnabled: boolean;
  twoFactorMethod: 'email';
  expiresAt?: Date; // For temporary outsourced accounts
  contractWarnings?: { '7d'?: boolean; '1d'?: boolean };
  availabilityStatus?: StaffAvailabilityStatus;
  availabilityNote?: string;
  availabilityUpdatedAt?: Date;
  notificationPreferences: {
    appointment: boolean;
    payment: boolean;
    blueprint: boolean;
    fabrication: boolean;
    project: boolean;
    emailNotifications?: boolean;
  };
  themePreference: 'light' | 'dark' | 'system';
  signatureKey?: string; // R2 key for e-signature PNG
  provider: 'local' | 'google';
  firebaseUid?: string;
  photoURL?: string;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    customerNumber: { type: String, trim: true },
    password: { type: String, select: false },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    address: { type: String, trim: true },
    addressData: {
      type: new Schema(
        {
          id: { type: String, trim: true },
          label: { type: String, trim: true },
          street: { type: String, trim: true },
          barangay: { type: String, trim: true },
          city: { type: String, trim: true },
          province: { type: String, trim: true },
          zip: { type: String, trim: true },
          country: { type: String, trim: true, default: 'Philippines' },
          addressType: { type: String, enum: ['personal', 'business'], default: 'personal' },
          lat: { type: Number },
          lng: { type: Number },
          formattedAddress: { type: String, trim: true },
          isDefault: { type: Boolean },
        },
        { _id: false },
      ),
      default: undefined,
    },
    savedAddresses: {
      type: [
        new Schema(
          {
            id: { type: String, trim: true },
            label: { type: String, trim: true },
            street: { type: String, trim: true },
            barangay: { type: String, trim: true },
            city: { type: String, trim: true },
            province: { type: String, trim: true },
            zip: { type: String, trim: true },
            country: { type: String, trim: true, default: 'Philippines' },
            addressType: { type: String, enum: ['personal', 'business'], default: 'business' },
            lat: { type: Number },
            lng: { type: Number },
            formattedAddress: { type: String, trim: true },
            isDefault: { type: Boolean, default: false },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    roles: {
      type: [{ type: String, enum: Object.values(Role) }],
      required: true,
      default: [Role.CUSTOMER],
    },
    isEmailVerified: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    mustChangePassword: { type: Boolean, default: false },
    isSuperAdmin: { type: Boolean, default: false },
    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorMethod: { type: String, enum: ['email'], default: 'email' },
    expiresAt: { type: Date },
    availabilityStatus: {
      type: String,
      enum: Object.values(StaffAvailabilityStatus),
    },
    availabilityNote: { type: String, trim: true, maxlength: 240 },
    availabilityUpdatedAt: { type: Date },
    contractWarnings: {
      '7d': { type: Boolean },
      '1d': { type: Boolean },
    },
    notificationPreferences: {
      appointment: { type: Boolean, default: true },
      payment: { type: Boolean, default: true },
      blueprint: { type: Boolean, default: true },
      fabrication: { type: Boolean, default: true },
      project: { type: Boolean, default: true },
      emailNotifications: { type: Boolean, default: true },
    },
    themePreference: { type: String, enum: ['light', 'dark', 'system'], default: 'light' },
    signatureKey: { type: String },
    provider: { type: String, enum: ['local', 'google'], default: 'local' },
    firebaseUid: { type: String, unique: true, sparse: true },
    photoURL: { type: String },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Indexes
userSchema.index({ roles: 1 });
userSchema.index({ isActive: 1 });
userSchema.index({ expiresAt: 1 }, { sparse: true });
userSchema.index(
  { customerNumber: 1 },
  { unique: true, partialFilterExpression: { customerNumber: { $gt: '' } } },
);

userSchema.pre('validate', async function () {
  if (!this.customerNumber && this.roles.includes(Role.CUSTOMER)) {
    this.customerNumber = await generateCustomerNumber();
  }
});

// Exclude soft-deleted by default
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const excludeDeletedMiddleware = function (this: any, next?: any) {
  const query = this.getFilter();
  if (query.deletedAt === undefined) {
    this.where({ deletedAt: null });
  }
  if (typeof next === 'function') {
    next();
  }
};
(userSchema as any).pre('find', excludeDeletedMiddleware);
(userSchema as any).pre('findOne', excludeDeletedMiddleware);
(userSchema as any).pre('countDocuments', excludeDeletedMiddleware);
(userSchema as any).pre('findOneAndUpdate', excludeDeletedMiddleware);

export const User = mongoose.model<IUser>('User', userSchema);
