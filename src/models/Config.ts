import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IConfig extends Document {
  _id: Types.ObjectId;
  key: string;
  value: unknown;
  description?: string;
  updatedBy?: Types.ObjectId;
  updatedAt: Date;
  createdAt: Date;
}

const configSchema = new Schema<IConfig>(
  {
    key: { type: String, required: true, unique: true },
    value: { type: Schema.Types.Mixed, required: true },
    description: { type: String },
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
