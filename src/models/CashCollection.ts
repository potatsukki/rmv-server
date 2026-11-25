import mongoose, { Schema, Document, Types } from 'mongoose';
import { CashCollectionStatus } from '../utils/constants.js';

/** Which fee the sales staff collected in cash during the ocular visit. */
export const CASH_COLLECTION_FEE_TYPES = ['ocular_fee', 'design_fee'] as const;
export type CashCollectionFeeType = typeof CASH_COLLECTION_FEE_TYPES[number];

export interface ICashCollection extends Document {
  _id: Types.ObjectId;
  appointmentId: Types.ObjectId;
  salesStaffId: Types.ObjectId;
  customerId: Types.ObjectId;
  feeType: CashCollectionFeeType;
  /** Acknowledgement number the customer gets when the sales staff takes the cash: CC-YYYY-NNNNN. */
  collectionNumber?: string;
  /** Design fee: the project the fee belongs to. */
  projectId?: Types.ObjectId;
  /** The paid Payment created when the sales staff recorded the cash (on-site collection). */
  paymentId?: Types.ObjectId;
  /** Official receipt, issued by the cashier on receiving the cash (never by the sales staff). */
  receiptNumber?: string;
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
    feeType: { type: String, enum: CASH_COLLECTION_FEE_TYPES, default: 'ocular_fee' },
    collectionNumber: { type: String },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project' },
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment' },
    receiptNumber: { type: String },
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
cashCollectionSchema.index({ collectionNumber: 1 }, { unique: true, sparse: true });

export const CashCollection = mongoose.model<ICashCollection>('CashCollection', cashCollectionSchema);

// ── Collection Counter (for CC-YYYY-NNNNN) ──
interface ICashCollectionCounter extends Document {
  year: number;
  lastSeq: number;
}

const cashCollectionCounterSchema = new Schema<ICashCollectionCounter>({
  year: { type: Number, required: true, unique: true },
  lastSeq: { type: Number, default: 0 },
});

export const CashCollectionCounter = mongoose.model<ICashCollectionCounter>('CashCollectionCounter', cashCollectionCounterSchema);

/** Next acknowledgement number for cash a sales staff collected: CC-2026-00001. */
export async function generateNextCollectionNumber(now: Date = new Date()): Promise<string> {
  const year = now.getFullYear();
  const counter = await CashCollectionCounter.findOneAndUpdate(
    { year },
    { $inc: { lastSeq: 1 } },
    { upsert: true, new: true },
  );
  return `CC-${year}-${String(counter!.lastSeq).padStart(5, '0')}`;
}
