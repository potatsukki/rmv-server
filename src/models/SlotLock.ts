import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Slot Lock for anti-double-booking.
 * Unique index on { date, slotCode, salesId } prevents race conditions.
 * TTL index auto-removes unconfirmed locks after 5 minutes.
 */
export interface ISlotLock extends Document {
  _id: Types.ObjectId;
  date: string; // YYYY-MM-DD
  slotCode: string;
  salesId: Types.ObjectId;
  appointmentId?: Types.ObjectId;
  lockedBy: Types.ObjectId;
  confirmed: boolean;
  expiresAt: Date;
  createdAt: Date;
}

const slotLockSchema = new Schema<ISlotLock>(
  {
    date: { type: String, required: true },
    slotCode: { type: String, required: true },
    salesId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    appointmentId: { type: Schema.Types.ObjectId, ref: 'Appointment' },
    lockedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    confirmed: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// THE critical unique index for anti-race
slotLockSchema.index({ date: 1, slotCode: 1, salesId: 1 }, { unique: true });

// TTL: auto-remove unconfirmed locks after expiry
slotLockSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, partialFilterExpression: { confirmed: false } },
);

export const SlotLock = mongoose.model<ISlotLock>('SlotLock', slotLockSchema);
