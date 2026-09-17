import mongoose, { Schema, Document, Types } from 'mongoose';
import { ContractStatus, ProjectStatus } from '../utils/constants.js';
import type { IProjectItem } from './ProjectItem.js';

export interface IProject extends Document {
  _id: Types.ObjectId;
  appointmentId?: Types.ObjectId;
  projectNumber: string; // RMV-YYYY-#####
  visitReportId?: Types.ObjectId; // link back to the specific visit report
  customerId: Types.ObjectId;
  salesStaffId: Types.ObjectId;
  engineerIds: Types.ObjectId[]; // Multiple engineers can collaborate
  fabricationLeadId?: Types.ObjectId;
  fabricationAssistantIds: Types.ObjectId[];

  title: string;
  totalCost?: number;
  serviceType: string; // e.g., gate, railing, kitchen
  serviceTypes?: string[];
  serviceTypeCustom?: string;
  measurementUnit?: string;
  lineItems?: IProjectItem['lineItems'];
  specifications?: IProjectItem['specifications'];
  preferredDesign?: string;
  customerRequirements?: string;
  selectedDesignTemplateId?: string;
  selectedDesignTemplateName?: string;
  selectedDesignTemplateImageUrl?: string;
  photoKeys?: string[];
  videoKeys?: string[];
  sketchKeys?: string[];
  referenceImageKeys?: string[];
  description: string;
  siteAddress: string;
  siteAddressStructured?: {
    street: string;
    barangay: string;
    city: string;
    province: string;
    zip: string;
    addressType?: 'personal' | 'business';
  };
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
  initialDesignKeys: string[];
  initialDesignNotes?: string;
  initialDesignBackfill?: {
    isSyntheticDemo: boolean;
    reason: string;
    backfilledAt: Date;
    backfilledBy: Types.ObjectId;
  };
  designReviewStatus: 'pending' | 'approved' | 'declined' | 'not_required';
  designReviewedBy?: Types.ObjectId;
  designReviewedAt?: Date;
  designReviewNotes?: string;

  status: ProjectStatus;
  cancelReason?: string;

  mediaKeys: string[]; // R2 keys for reference photos/files
  contractStatus: ContractStatus;
  contractFileKey?: string;
  contractFileName?: string;
  contractContentType?: string;
  contractFileSize?: number;
  contractUploadedAt?: Date;
  contractUploadedBy?: Types.ObjectId;
  contractKey?: string; // R2 key for generated contract PDF
  contractGeneratedAt?: Date;
  contractSignedAt?: Date;
  contractSignatureKey?: string;
  engineerContractSignedAt?: Date;
  engineerContractSignatureKey?: string;
  engineerContractSignedBy?: Types.ObjectId;
  originalContractDownloadedAt?: Date; // one-time original download tracking

  installationConfirmedAt?: Date;
  customerReview?: {
    rating?: number;
    comment?: string;
    submittedAt?: Date;
    submittedBy?: Types.ObjectId;
    skippedAt?: Date;
    skippedReason?: string;
  };

  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const projectSchema = new Schema<IProject>(
  {
    appointmentId: { type: Schema.Types.ObjectId, ref: 'Appointment' },
    projectNumber: { type: String, required: true, unique: true },
    visitReportId: { type: Schema.Types.ObjectId, ref: 'VisitReport' },
    customerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    salesStaffId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    engineerIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    fabricationLeadId: { type: Schema.Types.ObjectId, ref: 'User' },
    fabricationAssistantIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],

    title: { type: String, required: true, trim: true },
    totalCost: { type: Number },
    serviceType: { type: String, required: true, trim: true },
    serviceTypes: [{ type: String, trim: true }],
    serviceTypeCustom: String,
    measurementUnit: String,
    lineItems: { type: [Schema.Types.Mixed], default: [] },
    specifications: { type: Schema.Types.Mixed },
    preferredDesign: String,
    customerRequirements: String,
    selectedDesignTemplateId: String,
    selectedDesignTemplateName: String,
    selectedDesignTemplateImageUrl: String,
    photoKeys: [String],
    videoKeys: [String],
    sketchKeys: [String],
    referenceImageKeys: [String],
    description: { type: String, required: true },
    siteAddress: { type: String, required: true },
    siteAddressStructured: {
      street: { type: String, trim: true },
      barangay: { type: String, trim: true },
      city: { type: String, trim: true },
      province: { type: String, trim: true },
      zip: { type: String, trim: true },
      addressType: { type: String, enum: ['personal', 'business'] },
      _id: false,
    },
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
    initialDesignKeys: [{ type: String }],
    initialDesignNotes: { type: String },
    initialDesignBackfill: {
      isSyntheticDemo: { type: Boolean, default: false },
      reason: { type: String },
      backfilledAt: { type: Date },
      backfilledBy: { type: Schema.Types.ObjectId, ref: 'User' },
    },
    designReviewStatus: {
      type: String,
      enum: ['pending', 'approved', 'declined', 'not_required'],
      default: 'not_required',
    },
    designReviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    designReviewedAt: { type: Date },
    designReviewNotes: { type: String },

    status: {
      type: String,
      enum: Object.values(ProjectStatus),
      default: ProjectStatus.DRAFT,
    },
    cancelReason: { type: String },

    mediaKeys: [{ type: String }],
    contractStatus: {
      type: String,
      enum: Object.values(ContractStatus),
      default: ContractStatus.MISSING,
    },
    contractFileKey: { type: String },
    contractFileName: { type: String },
    contractContentType: { type: String },
    contractFileSize: { type: Number },
    contractUploadedAt: { type: Date },
    contractUploadedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    contractKey: { type: String },
    contractGeneratedAt: { type: Date },
    contractSignedAt: { type: Date },
    contractSignatureKey: { type: String },
    engineerContractSignedAt: { type: Date },
    engineerContractSignatureKey: { type: String },
    engineerContractSignedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    originalContractDownloadedAt: { type: Date, default: null },

    installationConfirmedAt: { type: Date, default: null },
    customerReview: {
      rating: { type: Number, min: 1, max: 5 },
      comment: { type: String },
      submittedAt: { type: Date },
      submittedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      skippedAt: { type: Date },
      skippedReason: { type: String },
    },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

projectSchema.index({ customerId: 1, status: 1 });
projectSchema.index({ salesStaffId: 1 });
projectSchema.index({ engineerIds: 1 });
projectSchema.index({ status: 1 });
projectSchema.index({ contractStatus: 1 });
projectSchema.index({ appointmentId: 1 }); // no longer unique — multiple projects per appointment
projectSchema.index({ visitReportId: 1 });

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
