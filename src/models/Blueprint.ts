import mongoose, { Schema, Document, Types } from 'mongoose';
import { BlueprintStatus } from '../utils/constants.js';

export type QuotationReviewStatus = 'draft' | 'for_review' | 'approved' | 'sent_to_customer';
export type QuotationPaymentOption = 'full' | 'milestone';
export type QuotationComplexity = 'simple' | 'standard' | 'complex';

export interface IQuotationInternalCosts {
  estimatedMaterials: number;
  fabricationWork: number;
  finishingPolishing: number;
  installation: number;
  deliveryMobilization: number;
  overheadMisc: number;
  markupProfit: number;
}

export interface IBlueprint extends Document {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  projectItemId?: Types.ObjectId;
  version: number;
  status: BlueprintStatus;
  blueprintKey: string;  // R2 key for technical blueprint (fabricators)
  designKey: string;     // R2 key for design/rendering (customer-facing)
  costingKey?: string;   // Optional R2 key for supporting costing file
  blueprintApproved: boolean;
  costingApproved: boolean;
  uploadedBy: Types.ObjectId; // Engineer
  revisionNotes?: string; // Customer's revision request notes
  revisionComponent?: 'blueprint' | 'costing';
  revisionRefKeys: string[]; // Customer's reference file attachments
  quotationReviewStatus: QuotationReviewStatus;
  quotationReviewedBy?: Types.ObjectId;
  quotationReviewedAt?: Date;
  quotationSentAt?: Date;
  // Quotation / costing breakdown
  quotation?: {
    internalCosts?: IQuotationInternalCosts;
    costPreset?: {
      serviceType?: string;
      complexity?: QuotationComplexity;
      suggestedAt?: Date;
      suggestedValues?: Partial<IQuotationInternalCosts>;
    };
    discount?: number;
    subtotal?: number;
    total: number;
    paymentOption?: QuotationPaymentOption;
    paymentMilestones?: {
      label: string;
      description?: string;
      percentage?: number;
      amount?: number;
      trigger?: string;
    }[];
    validityDays?: number;
    systemEstimatedDuration?: string;
    adjustedEstimatedDuration?: string;
    estimatedDuration?: string;
    inclusions?: string;
    exclusions?: string;
    engineerNotes?: string;
    materials?: number;
    labor?: number;
    fees?: number;
    lineItems?: {
      label: string;
      quantity: number;
      materials: number;
      labor: number;
      amount: number;
    }[];
    breakdown?: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

const internalCostsSchema = new Schema<IQuotationInternalCosts>(
  {
    estimatedMaterials: { type: Number, default: 0, min: 0 },
    fabricationWork: { type: Number, default: 0, min: 0 },
    finishingPolishing: { type: Number, default: 0, min: 0 },
    installation: { type: Number, default: 0, min: 0 },
    deliveryMobilization: { type: Number, default: 0, min: 0 },
    overheadMisc: { type: Number, default: 0, min: 0 },
    markupProfit: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const blueprintSchema = new Schema<IBlueprint>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    projectItemId: { type: Schema.Types.ObjectId, ref: 'ProjectItem' },
    version: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: Object.values(BlueprintStatus),
      default: BlueprintStatus.UPLOADED,
    },
    blueprintKey: { type: String, required: true },
    designKey: { type: String, default: '' },
    costingKey: { type: String, default: '' },
    blueprintApproved: { type: Boolean, default: false },
    costingApproved: { type: Boolean, default: false },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    revisionNotes: { type: String },
    revisionComponent: { type: String, enum: ['blueprint', 'costing'] },
    revisionRefKeys: [{ type: String }],
    quotationReviewStatus: {
      type: String,
      enum: ['draft', 'for_review', 'approved', 'sent_to_customer'],
      default: 'draft',
    },
    quotationReviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    quotationReviewedAt: Date,
    quotationSentAt: Date,
    quotation: {
      internalCosts: { type: internalCostsSchema, default: undefined },
      costPreset: {
        serviceType: String,
        complexity: { type: String, enum: ['simple', 'standard', 'complex'], default: 'standard' },
        suggestedAt: Date,
        suggestedValues: { type: internalCostsSchema, default: undefined },
      },
      discount: { type: Number, default: 0, min: 0 },
      subtotal: { type: Number, default: 0, min: 0 },
      total: Number,
      paymentOption: { type: String, enum: ['full', 'milestone'], default: 'milestone' },
      paymentMilestones: [{
        label: { type: String, required: true },
        description: { type: String },
        percentage: { type: Number, min: 0, max: 100 },
        amount: { type: Number, min: 0 },
        trigger: { type: String },
      }],
      validityDays: { type: Number, default: 30 },
      systemEstimatedDuration: String,
      adjustedEstimatedDuration: String,
      estimatedDuration: String,
      inclusions: String,
      exclusions: String,
      engineerNotes: String,
      materials: Number,
      labor: Number,
      fees: Number,
      lineItems: [{
        label: { type: String, required: true },
        quantity: { type: Number, required: true, min: 1 },
        materials: { type: Number, required: true, min: 0 },
        labor: { type: Number, required: true, min: 0 },
        amount: { type: Number, required: true, min: 0 },
      }],
      breakdown: String,
    },
  },
  { timestamps: true },
);

// Unique version per project item. Legacy project-level blueprints keep projectItemId empty.
blueprintSchema.index({ projectId: 1, projectItemId: 1, version: 1 }, { unique: true });
blueprintSchema.index({ projectId: 1 });
blueprintSchema.index({ projectItemId: 1 });

export const Blueprint = mongoose.model<IBlueprint>('Blueprint', blueprintSchema);
