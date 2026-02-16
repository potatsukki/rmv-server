import mongoose, { Schema, Document, Types } from 'mongoose';
import { BlueprintStatus } from '../utils/constants.js';

export interface IBlueprint extends Document {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  version: number;
  status: BlueprintStatus;
  blueprintKey: string;  // R2 key for blueprint PDF
  costingKey: string;    // R2 key for costing PDF
  blueprintApproved: boolean;
  costingApproved: boolean;
  uploadedBy: Types.ObjectId; // Engineer
  revisionNotes?: string; // Customer's revision request notes
  revisionRefKeys: string[]; // Customer's reference file attachments
  // Quotation / costing breakdown
  quotation?: {
    materials: number;
    labor: number;
    fees: number;
    total: number;
    breakdown?: string;
    estimatedDuration?: string;
    engineerNotes?: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

const blueprintSchema = new Schema<IBlueprint>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    version: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: Object.values(BlueprintStatus),
      default: BlueprintStatus.UPLOADED,
    },
    blueprintKey: { type: String, required: true },
    costingKey: { type: String, required: true },
    blueprintApproved: { type: Boolean, default: false },
    costingApproved: { type: Boolean, default: false },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    revisionNotes: { type: String },
    revisionRefKeys: [{ type: String }],
    quotation: {
      materials: Number,
      labor: Number,
      fees: Number,
      total: Number,
      breakdown: String,
      estimatedDuration: String,
      engineerNotes: String,
    },
  },
  { timestamps: true },
);

// Unique version per project
blueprintSchema.index({ projectId: 1, version: 1 }, { unique: true });
blueprintSchema.index({ projectId: 1 });

export const Blueprint = mongoose.model<IBlueprint>('Blueprint', blueprintSchema);
