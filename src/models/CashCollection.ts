import mongoose, { Schema, Document, Types } from 'mongoose';
import { CashCollectionStatus } from '../utils/constants.js';

export interface ICashCollection extends Document {
  _id: Types.ObjectId;
  appointmentId: Types.ObjectId;
  salesStaffId: Types.ObjectId;
  customerId: Types.ObjectId;
  amountCollected: number;
  notes?: string;
  photoKey?: string; // Optional photo of receipt/money
  status: CashCollectionStatus;
  receivedBy?: Types.ObjectId; // Cashier
  amountReceived?: number;
  receivedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const cashCollectionSchema = new Schema<ICashCollection>(
  {
    appointmentId: { type: Schema.Types.ObjectId, ref: 'Appointment', required: true },
    salesStaffId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    amountCollected: { type: Number, required: true, min: 0 },
    notes: { type: String },
    photoKey: { type: String },
    status: {
      type: String,
      enum: Object.values(CashCollectionStatus),
      default: CashCollectionStatus.COLLECTED,
    },
    receivedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    amountReceived: { type: Number },
    receivedAt: { type: Date },
  },
  { timestamps: true },
);

cashCollectionSchema.index({ appointmentId: 1 });
cashCollectionSchema.index({ salesStaffId: 1 });
cashCollectionSchema.index({ status: 1 });

export const CashCollection = mongoose.model<ICashCollection>('CashCollection', cashCollectionSchema);
