import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IConfig extends Document {
  _id: Types.ObjectId;
  key: string;
  value: unknown;
  description?: string;
  versions: Array<{
    _id: Types.ObjectId;
    value: unknown;
    description?: string;
    updatedBy?: Types.ObjectId;
    updatedAt: Date;
  }>;
  updatedBy?: Types.ObjectId;
  updatedAt: Date;
  createdAt: Date;
}

const configVersionSchema = new Schema(
  {
    value: { type: Schema.Types.Mixed, required: true },
    description: { type: String },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedAt: { type: Date, required: true },
  },
  { _id: true },
);

const configSchema = new Schema<IConfig>(
  {
    key: { type: String, required: true, unique: true },
    value: { type: Schema.Types.Mixed, required: true },
    description: { type: String },
    versions: { type: [configVersionSchema], default: [] },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

export const Config = mongoose.model<IConfig>('Config', configSchema);

// ── Holiday Model ──
export interface IHoliday extends Document {
  _id: Types.ObjectId;
  date: string; // YYYY-MM-DD
  name: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
}

const holidaySchema = new Schema<IHoliday>(
  {
    date: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const Holiday = mongoose.model<IHoliday>('Holiday', holidaySchema);

// ── Sales Availability Model ──
export interface ISalesAvailability extends Document {
  _id: Types.ObjectId;
  salesStaffId: Types.ObjectId;
  unavailableDates: string[]; // YYYY-MM-DD
  updatedBy: Types.ObjectId; // Admin
  updatedAt: Date;
}

const salesAvailabilitySchema = new Schema<ISalesAvailability>(
  {
    salesStaffId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    unavailableDates: [{ type: String }],
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

export const SalesAvailability = mongoose.model<ISalesAvailability>('SalesAvailability', salesAvailabilitySchema);

// ── Receipt Counter (for RMV-YYYY-NNNNN) ──
export interface IReceiptCounter extends Document {
  _id: Types.ObjectId;
  year: number;
  lastSeq: number;
}

const receiptCounterSchema = new Schema<IReceiptCounter>({
  year: { type: Number, required: true, unique: true },
  lastSeq: { type: Number, default: 0 },
});

export const ReceiptCounter = mongoose.model<IReceiptCounter>('ReceiptCounter', receiptCounterSchema);

// ── Project Counter (for RMV-YYYY-#####) ──
export interface IProjectCounter extends Document {
  _id: Types.ObjectId;
  year: number;
  lastSeq: number;
}

const projectCounterSchema = new Schema<IProjectCounter>({
  year: { type: Number, required: true, unique: true },
  lastSeq: { type: Number, default: 0 },
});

export const ProjectCounter = mongoose.model<IProjectCounter>('ProjectCounter', projectCounterSchema);

// ── Daily appointment queue counter (for Q-NNN) ──
export interface IAppointmentQueueCounter extends Document {
  _id: Types.ObjectId;
  date: string; // YYYY-MM-DD Asia/Manila
  lastSeq: number;
}

const appointmentQueueCounterSchema = new Schema<IAppointmentQueueCounter>({
  date: { type: String, required: true, unique: true },
  lastSeq: { type: Number, default: 0 },
});

export const AppointmentQueueCounter = mongoose.model<IAppointmentQueueCounter>(
  'AppointmentQueueCounter',
  appointmentQueueCounterSchema,
);

// ── Blocked Slot Model ──
export interface IBlockedSlot extends Document {
  _id: Types.ObjectId;
  date: string; // YYYY-MM-DD
  slotCode: string;
  type: 'office' | 'ocular';
  reason?: string;
  blockedBy: Types.ObjectId;
  createdAt: Date;
}

const blockedSlotSchema = new Schema<IBlockedSlot>(
  {
    date: { type: String, required: true },
    slotCode: { type: String, required: true },
    type: { type: String, required: true, enum: ['office', 'ocular'] },
    reason: { type: String },
    blockedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

blockedSlotSchema.index({ date: 1, slotCode: 1, type: 1 }, { unique: true });

export const BlockedSlot = mongoose.model<IBlockedSlot>('BlockedSlot', blockedSlotSchema);
