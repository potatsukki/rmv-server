import mongoose, { Schema, Document, Types } from 'mongoose';
import { ProjectStatus } from '../utils/constants.js';

export interface IProjectItem extends Document {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  appointmentId?: Types.ObjectId;
  consultationVisitReportId?: Types.ObjectId;
  ocularVisitReportId?: Types.ObjectId;
  serviceType: string;
  serviceTypeCustom?: string;
  title: string;
  status: ProjectStatus;
  measurements?: {
    length?: number;
    width?: number;
    height?: number;
    area?: number;
    thickness?: number;
    unit: string;
    raw?: string;
  };
  measurementUnit?: string;
  lineItems: Array<{
    label: string;
    length?: number;
    width?: number;
    height?: number;
    area?: number;
    thickness?: number;
    quantity: number;
    notes?: string;
  }>;
  materials?: string;
  finishes?: string;
  preferredDesign?: string;
  customerRequirements?: string;
  notes?: string;
  specifications?: {
    measurements?: Record<string, string | number | boolean>;
    siteConditions?: Record<string, string | number | boolean>;
    materialsDesign?: Record<string, string | number | boolean>;
    additional?: Record<string, string | number | boolean>;
  };
  initialDesignKeys: string[];
  initialDesignNotes?: string;
  selectedDesignTemplateId?: string;
  selectedDesignTemplateName?: string;
  selectedDesignTemplateImageUrl?: string;
  designReviewStatus: 'pending' | 'approved' | 'declined' | 'not_required';
  designReviewedBy?: Types.ObjectId;
  designReviewedAt?: Date;
  designReviewNotes?: string;
  installationConfirmedAt?: Date;
  mediaKeys: string[];
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const lineItemSchema = new Schema(
  {
    label: { type: String, required: true, trim: true },
    length: Number,
    width: Number,
    height: Number,
    area: Number,
    thickness: Number,
    quantity: { type: Number, default: 1, min: 1 },
    notes: String,
  },
  { _id: false },
);

const projectItemSchema = new Schema<IProjectItem>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    appointmentId: { type: Schema.Types.ObjectId, ref: 'Appointment' },
    consultationVisitReportId: { type: Schema.Types.ObjectId, ref: 'VisitReport' },
    ocularVisitReportId: { type: Schema.Types.ObjectId, ref: 'VisitReport' },
    serviceType: { type: String, required: true, trim: true },
    serviceTypeCustom: { type: String, trim: true },
    title: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: Object.values(ProjectStatus),
      default: ProjectStatus.DRAFT,
    },
    measurements: {
      length: Number,
      width: Number,
      height: Number,
      area: Number,
      thickness: Number,
      unit: { type: String, default: 'cm' },
      raw: String,
    },
    measurementUnit: { type: String },
    lineItems: { type: [lineItemSchema], default: [] },
    materials: String,
    finishes: String,
    preferredDesign: String,
    customerRequirements: String,
    notes: String,
    specifications: { type: Schema.Types.Mixed },
    initialDesignKeys: [{ type: String }],
    initialDesignNotes: String,
    selectedDesignTemplateId: { type: String, trim: true },
    selectedDesignTemplateName: { type: String, trim: true },
    selectedDesignTemplateImageUrl: { type: String, trim: true },
    designReviewStatus: {
      type: String,
      enum: ['pending', 'approved', 'declined', 'not_required'],
      default: 'not_required',
    },
    designReviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    designReviewedAt: Date,
    designReviewNotes: String,
    installationConfirmedAt: { type: Date, default: null },
    mediaKeys: [{ type: String }],
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

projectItemSchema.index({ projectId: 1, serviceType: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
projectItemSchema.index({ appointmentId: 1 });
projectItemSchema.index({ consultationVisitReportId: 1 });
projectItemSchema.index({ ocularVisitReportId: 1 });
projectItemSchema.index({ status: 1 });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const excludeDeletedMiddleware = function (this: any, next?: any) {
  const query = this.getFilter();
  if (query.deletedAt === undefined) {
    this.where({ deletedAt: null });
  }
  if (typeof next === 'function') next();
};

(projectItemSchema as any).pre('find', excludeDeletedMiddleware);
(projectItemSchema as any).pre('findOne', excludeDeletedMiddleware);
(projectItemSchema as any).pre('countDocuments', excludeDeletedMiddleware);
(projectItemSchema as any).pre('findOneAndUpdate', excludeDeletedMiddleware);

export const ProjectItem = mongoose.model<IProjectItem>('ProjectItem', projectItemSchema);
