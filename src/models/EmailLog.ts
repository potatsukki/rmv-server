import mongoose, { Schema, Document, Types } from 'mongoose';
import { EmailLogStatus } from '../utils/constants.js';

export interface IEmailLog extends Document {
  _id: Types.ObjectId;
  to: string;
  subject: string;
  template: string;
  status: EmailLogStatus;
  attempts: number;
  lastAttemptAt?: Date;
  nextRetryAt?: Date;
  errorMessage?: string;
  relatedType?: string;
  relatedId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const emailLogSchema = new Schema<IEmailLog>(
  {
    to: { type: String, required: true },
    subject: { type: String, required: true },
    template: { type: String, required: true },
    status: {
      type: String,
      enum: Object.values(EmailLogStatus),
      default: EmailLogStatus.PENDING,
    },
    attempts: { type: Number, default: 0 },
    lastAttemptAt: { type: Date },
    nextRetryAt: { type: Date },
    errorMessage: { type: String },
    relatedType: { type: String },
    relatedId: { type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

emailLogSchema.index({ status: 1, nextRetryAt: 1 });
emailLogSchema.index({ to: 1, createdAt: -1 });

export const EmailLog = mongoose.model<IEmailLog>('EmailLog', emailLogSchema);
