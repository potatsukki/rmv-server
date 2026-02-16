import mongoose, { Schema, Document, Types } from 'mongoose';
import { OtpPurpose } from '../utils/constants.js';

export interface IOtpToken extends Document {
  _id: Types.ObjectId;
  email: string;
  otp: string;
  purpose: OtpPurpose;
  attempts: number;
  maxAttempts: number;
  expiresAt: Date;
  lockedUntil?: Date;
  lastSentAt: Date;
  isUsed: boolean;
  createdAt: Date;
}

const otpTokenSchema = new Schema<IOtpToken>(
  {
    email: { type: String, required: true, lowercase: true },
    otp: { type: String, required: true },
    purpose: { type: String, enum: Object.values(OtpPurpose), required: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    expiresAt: { type: Date, required: true },
    lockedUntil: { type: Date },
    lastSentAt: { type: Date, default: Date.now },
    isUsed: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

otpTokenSchema.index({ email: 1, purpose: 1 });
otpTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL auto-delete

export const OtpToken = mongoose.model<IOtpToken>('OtpToken', otpTokenSchema);
