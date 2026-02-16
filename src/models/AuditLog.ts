import mongoose, { Schema, Document, Types } from 'mongoose';
import { AuditAction } from '../utils/constants.js';

export interface IAuditLog extends Document {
  _id: Types.ObjectId;
  action: AuditAction;
  actorId?: Types.ObjectId;
  actorEmail?: string;
  targetType?: string; // e.g., 'user', 'appointment', 'project', 'payment'
  targetId?: Types.ObjectId;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  createdAt: Date;
}

const auditLogSchema = new Schema<IAuditLog>(
  {
    action: { type: String, enum: Object.values(AuditAction), required: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    actorEmail: { type: String },
    targetType: { type: String },
    targetId: { type: Schema.Types.ObjectId },
    details: { type: Schema.Types.Mixed },
    ipAddress: { type: String },
    userAgent: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

auditLogSchema.index({ action: 1 });
auditLogSchema.index({ actorId: 1 });
auditLogSchema.index({ targetType: 1, targetId: 1 });
auditLogSchema.index({ createdAt: -1 });

export const AuditLog = mongoose.model<IAuditLog>('AuditLog', auditLogSchema);
