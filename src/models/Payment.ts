import mongoose, { Schema, Document, Types } from 'mongoose';
import { PaymentStageStatus, PaymentMethod } from '../utils/constants.js';

// ── Payment Plan (per project) ──
export interface IPaymentStage {
  stageId: string; // auto-generated UUID
  label: string; // Auto: "Stage 1", "Stage 2", etc.
  description?: string; // Milestone trigger e.g. "Due before fabrication starts"
  percentage: number;
  amount: number; // Calculated from total * percentage
  status: PaymentStageStatus;
  qrCodeKey?: string; // R2 key for QR code image
  checkoutSessionId?: string; // PayMongo checkout session ID
  amountPaid: number;
  creditApplied: number;
  remainingBalance: number;
  // ── Payment Activation (fabrication-driven) ──
  activatedAt?: Date | null; // When stage became due (null = not yet due)
  headsUpSentAt?: Date | null; // When the advance "prepare" notice was sent
  remindersSent: number; // How many overdue reminders sent
  lastReminderAt?: Date | null; // Prevents duplicate reminders
  escalatedToCashier: boolean; // Whether cashier has been notified
}

export interface IPaymentPlan extends Document {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  projectItemId?: Types.ObjectId;
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
    description: { type: String },
    percentage: { type: Number, required: true },
    amount: { type: Number, required: true },
    status: {
      type: String,
      enum: Object.values(PaymentStageStatus),
      default: PaymentStageStatus.PENDING,
    },
    qrCodeKey: { type: String },
    checkoutSessionId: { type: String },
    amountPaid: { type: Number, default: 0 },
    creditApplied: { type: Number, default: 0 },
    remainingBalance: { type: Number, default: 0 },
    // Payment activation fields
    activatedAt: { type: Date, default: null },
    headsUpSentAt: { type: Date, default: null },
    remindersSent: { type: Number, default: 0 },
    lastReminderAt: { type: Date, default: null },
    escalatedToCashier: { type: Boolean, default: false },
  },
  { _id: false },
);

const paymentPlanSchema = new Schema<IPaymentPlan>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    projectItemId: { type: Schema.Types.ObjectId, ref: 'ProjectItem' },
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
  bookingId?: Types.ObjectId;
  customerId?: Types.ObjectId;
  amountRequired?: number;
  paymentDate?: Date;
  paymentStatus?: 'unpaid' | 'pending_verification' | 'paid' | 'rejected';
  gcashReferenceNumber?: string;
  activeSubmissionKey?: string;
  rejectionReason?: string;
  duplicateReference?: boolean;
  rejectionSource?: 'system' | 'cashier';
  rejectedBy?: Types.ObjectId | null;
  rejectedAt?: Date;
  projectItemId?: Types.ObjectId;
  stageId: string;
  method: PaymentMethod;
  amountPaid: number;
  referenceNumber?: string;
  proofKey?: string; // R2 key
  status: PaymentStageStatus;
  declineReason?: string;
  verifiedBy?: Types.ObjectId;
  verifiedAt?: Date;
  cashierSignatureKey?: string;
  receiptKey?: string; // R2 key for receipt PDF
  receiptNumber?: string;
  idempotencyKey?: string;
  evidenceTrail: Array<{
    version: number;
    source: string;
    status: PaymentStageStatus;
    method: PaymentMethod;
    amountPaid: number;
    proofKey?: string;
    referenceNumber?: string;
    receiptKey?: string;
    receiptNumber?: string;
    note?: string;
    actorId?: Types.ObjectId;
    capturedAt: Date;
  }>;
  creditFromPrevious: number; // Credit applied from overpayment
  excessCredit: number; // Excess to carry forward
  createdAt: Date;
  updatedAt: Date;
}

const paymentEvidenceSchema = new Schema(
  {
    version: { type: Number, required: true },
    source: { type: String, required: true },
    status: {
      type: String,
      enum: Object.values(PaymentStageStatus),
      required: true,
    },
    method: {
      type: String,
      enum: Object.values(PaymentMethod),
      required: true,
    },
    amountPaid: { type: Number, required: true, min: 0 },
    proofKey: { type: String },
    referenceNumber: { type: String },
    receiptKey: { type: String },
    receiptNumber: { type: String },
    note: { type: String },
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    capturedAt: { type: Date, required: true },
  },
  { _id: false },
);

const paymentSchema = new Schema<IPayment>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: function () { return !this.bookingId; } },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Appointment' },
    customerId: { type: Schema.Types.ObjectId, ref: 'User' },
    amountRequired: { type: Number, min: 0 },
    paymentDate: { type: Date },
    paymentStatus: { type: String, enum: ['unpaid', 'pending_verification', 'paid', 'rejected'] },
    gcashReferenceNumber: { type: String },
    activeSubmissionKey: { type: String },
    rejectionReason: { type: String },
    duplicateReference: { type: Boolean },
    rejectionSource: { type: String, enum: ['system', 'cashier'] },
    rejectedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    rejectedAt: { type: Date },
    projectItemId: { type: Schema.Types.ObjectId, ref: 'ProjectItem' },
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
    cashierSignatureKey: { type: String },
    receiptKey: { type: String },
    receiptNumber: { type: String },
    idempotencyKey: { type: String },
    evidenceTrail: { type: [paymentEvidenceSchema], default: [] },
    creditFromPrevious: { type: Number, default: 0 },
    excessCredit: { type: Number, default: 0 },
  },
  { timestamps: true },
);

paymentPlanSchema.index({ projectId: 1 }, { unique: true, partialFilterExpression: { projectItemId: { $exists: false } } });
paymentPlanSchema.index({ projectItemId: 1 }, { unique: true, sparse: true });
paymentSchema.index({ projectId: 1, stageId: 1 });
paymentSchema.index({ projectItemId: 1, stageId: 1 });
paymentSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
paymentSchema.index({ gcashReferenceNumber: 1 }, { unique: true, sparse: true });
paymentSchema.index({ method: 1, referenceNumber: 1 });
paymentSchema.index({ activeSubmissionKey: 1 }, { unique: true, sparse: true });
paymentSchema.index({ bookingId: 1, createdAt: -1 });

export const Payment = mongoose.model<IPayment>('Payment', paymentSchema);
