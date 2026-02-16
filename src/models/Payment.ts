import mongoose, { Schema, Document, Types } from 'mongoose';
import { PaymentStageStatus, PaymentMethod } from '../utils/constants.js';

// ── Payment Plan (per project) ──
export interface IPaymentStage {
  stageId: string; // auto-generated UUID
  label: string; // Auto: "Stage 1", "Stage 2", etc.
  percentage: number;
  amount: number; // Calculated from total * percentage
  status: PaymentStageStatus;
  qrCodeKey?: string; // R2 key for QR code image
  amountPaid: number;
  creditApplied: number;
  remainingBalance: number;
}

export interface IPaymentPlan extends Document {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  totalAmount: number;
  isPayInFull: boolean;
  stages: IPaymentStage[];
  isImmutable: boolean; // Locked after first verified payment
  createdBy: Types.ObjectId; // Cashier
  createdAt: Date;
  updatedAt: Date;
}

const paymentStageSchema = new Schema<IPaymentStage>(
  {
    stageId: { type: String, required: true },
    label: { type: String, required: true },
    percentage: { type: Number, required: true },
    amount: { type: Number, required: true },
    status: {
      type: String,
      enum: Object.values(PaymentStageStatus),
      default: PaymentStageStatus.PENDING,
    },
    qrCodeKey: { type: String },
    amountPaid: { type: Number, default: 0 },
    creditApplied: { type: Number, default: 0 },
    remainingBalance: { type: Number, default: 0 },
  },
  { _id: false },
);

const paymentPlanSchema = new Schema<IPaymentPlan>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, unique: true },
    totalAmount: { type: Number, required: true, min: 0 },
    isPayInFull: { type: Boolean, default: false },
    stages: { type: [paymentStageSchema], required: true },
    isImmutable: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

export const PaymentPlan = mongoose.model<IPaymentPlan>('PaymentPlan', paymentPlanSchema);

// ── Individual Payment Record ──
export interface IPayment extends Document {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  stageId: string;
  method: PaymentMethod;
  amountPaid: number;
  referenceNumber?: string;
  proofKey?: string; // R2 key
  status: PaymentStageStatus;
  declineReason?: string;
  verifiedBy?: Types.ObjectId;
  verifiedAt?: Date;
  receiptKey?: string; // R2 key for receipt PDF
  receiptNumber?: string;
  idempotencyKey?: string;
  creditFromPrevious: number; // Credit applied from overpayment
  excessCredit: number; // Excess to carry forward
  createdAt: Date;
  updatedAt: Date;
}

const paymentSchema = new Schema<IPayment>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    stageId: { type: String, required: true },
    method: { type: String, enum: Object.values(PaymentMethod), required: true },
    amountPaid: { type: Number, required: true, min: 0 },
    referenceNumber: { type: String },
    proofKey: { type: String },
    status: {
      type: String,
      enum: Object.values(PaymentStageStatus),
      default: PaymentStageStatus.PROOF_SUBMITTED,
    },
    declineReason: { type: String },
    verifiedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    verifiedAt: { type: Date },
    receiptKey: { type: String },
    receiptNumber: { type: String },
    idempotencyKey: { type: String },
    creditFromPrevious: { type: Number, default: 0 },
    excessCredit: { type: Number, default: 0 },
  },
  { timestamps: true },
);

paymentSchema.index({ projectId: 1, stageId: 1 });
paymentSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

export const Payment = mongoose.model<IPayment>('Payment', paymentSchema);
