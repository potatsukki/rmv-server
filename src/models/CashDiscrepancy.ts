import mongoose, { Schema, Document, Types } from 'mongoose';

export interface ICashDiscrepancy extends Document {
  _id: Types.ObjectId;
  cashCollectionId: Types.ObjectId;
  appointmentId: Types.ObjectId;
  salesStaffId: Types.ObjectId;
  cashierId: Types.ObjectId;
  amountCollected: number;
  amountReceived: number;
  difference: number;
  resolved: boolean;
  resolvedBy?: Types.ObjectId;
  resolvedAt?: Date;
  resolutionNotes?: string;
  createdAt: Date;
}

const cashDiscrepancySchema = new Schema<ICashDiscrepancy>(
  {
    cashCollectionId: { type: Schema.Types.ObjectId, ref: 'CashCollection', required: true },
    appointmentId: { type: Schema.Types.ObjectId, ref: 'Appointment', required: true },
    salesStaffId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    cashierId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    amountCollected: { type: Number, required: true },
    amountReceived: { type: Number, required: true },
    difference: { type: Number, required: true },
    resolved: { type: Boolean, default: false },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    resolvedAt: { type: Date },
    resolutionNotes: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

cashDiscrepancySchema.index({ resolved: 1 });

export const CashDiscrepancy = mongoose.model<ICashDiscrepancy>('CashDiscrepancy', cashDiscrepancySchema);
