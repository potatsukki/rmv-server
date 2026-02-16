import mongoose, { Schema, Document, Types } from 'mongoose';

// ── Visit Report Status ──
export enum VisitReportStatus {
  DRAFT = 'draft',
  SUBMITTED = 'submitted',
  RETURNED = 'returned',
  COMPLETED = 'completed',
}

export interface IVisitReport extends Document {
  _id: Types.ObjectId;
  appointmentId: Types.ObjectId;
  customerId: Types.ObjectId;
  salesStaffId: Types.ObjectId;

  status: VisitReportStatus;
  visitType: string; // ocular | consultation
  actualVisitDateTime?: Date;

  // Structured measurements
  measurements?: {
    length?: number;
    width?: number;
    height?: number;
    area?: number;
    thickness?: number;
    unit: string;
    raw?: string; // free-form notes about measurements
  };

  materials?: string;
  finishes?: string;
  preferredDesign?: string;
  customerRequirements?: string;
  notes?: string;

  // File uploads (R2 keys)
  photoKeys: string[];
  videoKeys: string[];
  sketchKeys: string[];
  referenceImageKeys: string[];

  // Return handling
  returnReason?: string;

  createdAt: Date;
  updatedAt: Date;
}

const visitReportSchema = new Schema<IVisitReport>(
  {
    appointmentId: { type: Schema.Types.ObjectId, ref: 'Appointment', required: true, unique: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    salesStaffId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    status: {
      type: String,
      enum: Object.values(VisitReportStatus),
      default: VisitReportStatus.DRAFT,
    },
    visitType: { type: String, enum: ['ocular', 'consultation'], default: 'ocular' },
    actualVisitDateTime: { type: Date },

    measurements: {
      length: Number,
      width: Number,
      height: Number,
      area: Number,
      thickness: Number,
      unit: { type: String, default: 'cm' },
      raw: String,
    },

    materials: { type: String },
    finishes: { type: String },
    preferredDesign: { type: String },
    customerRequirements: { type: String },
    notes: { type: String },

    photoKeys: [{ type: String }],
    videoKeys: [{ type: String }],
    sketchKeys: [{ type: String }],
    referenceImageKeys: [{ type: String }],

    returnReason: { type: String },
  },
  { timestamps: true },
);

visitReportSchema.index({ salesStaffId: 1, status: 1 });
visitReportSchema.index({ status: 1 });

export const VisitReport = mongoose.model<IVisitReport>('VisitReport', visitReportSchema);
