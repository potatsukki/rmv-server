import mongoose, { Schema, Document, Types } from 'mongoose';
import { ProjectStatus } from '../utils/constants.js';

export interface IProject extends Document {
  _id: Types.ObjectId;
  appointmentId: Types.ObjectId;
  customerId: Types.ObjectId;
  salesStaffId: Types.ObjectId;
  engineerIds: Types.ObjectId[]; // Multiple engineers can collaborate
  fabricationLeadId?: Types.ObjectId;
  fabricationAssistantIds: Types.ObjectId[];

  title: string;
  serviceType: string; // e.g., gate, railing, kitchen
  description: string;
  siteAddress: string;
  measurements?: {
    length?: number;
    width?: number;
    height?: number;
    area?: number;
    thickness?: number;
    unit: string;
  };
  materialType?: string;
  finishColor?: string;
  quantity: number;
  notes?: string;
  estimatedCompletionDate?: Date;

  status: ProjectStatus;
  cancelReason?: string;

  mediaKeys: string[]; // R2 keys for reference photos/files

  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const projectSchema = new Schema<IProject>(
  {
    appointmentId: { type: Schema.Types.ObjectId, ref: 'Appointment', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    salesStaffId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    engineerIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    fabricationLeadId: { type: Schema.Types.ObjectId, ref: 'User' },
    fabricationAssistantIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],

    title: { type: String, required: true, trim: true },
    serviceType: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    siteAddress: { type: String, required: true },
    measurements: {
      length: Number,
      width: Number,
      height: Number,
      area: Number,
      thickness: Number,
      unit: { type: String, default: 'cm' },
    },
    materialType: { type: String },
    finishColor: { type: String },
    quantity: { type: Number, default: 1, min: 1 },
    notes: { type: String },
    estimatedCompletionDate: { type: Date },

    status: {
      type: String,
      enum: Object.values(ProjectStatus),
      default: ProjectStatus.DRAFT,
    },
    cancelReason: { type: String },

    mediaKeys: [{ type: String }],

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

projectSchema.index({ customerId: 1, status: 1 });
projectSchema.index({ salesStaffId: 1 });
projectSchema.index({ engineerIds: 1 });
projectSchema.index({ status: 1 });
projectSchema.index({ appointmentId: 1 }, { unique: true }); // 1:1 with appointment

// Soft delete filter
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const excludeDeletedMiddleware = function (this: any, next?: any) {
  const query = this.getFilter();
  if (query.deletedAt === undefined) {
    this.where({ deletedAt: null });
  }
  if (typeof next === 'function') {
    next();
  }
};
(projectSchema as any).pre('find', excludeDeletedMiddleware);
(projectSchema as any).pre('findOne', excludeDeletedMiddleware);
(projectSchema as any).pre('countDocuments', excludeDeletedMiddleware);
(projectSchema as any).pre('findOneAndUpdate', excludeDeletedMiddleware);

export const Project = mongoose.model<IProject>('Project', projectSchema);
