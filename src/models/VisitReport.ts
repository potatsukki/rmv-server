import mongoose, { Schema, Document, Types } from 'mongoose';
import { ServiceType, MeasurementUnit, Environment } from '../utils/constants.js';

// ── Visit Report Status ──
export enum VisitReportStatus {
  DRAFT = 'draft',
  SUBMITTED = 'submitted',
  RETURNED = 'returned',
  COMPLETED = 'completed',
}

// ── Line Item (per-component measurement) ──
export interface ILineItem {
  label: string;           // e.g. "Left panel", "Kitchen counter top"
  length?: number;
  width?: number;
  height?: number;
  area?: number;
  thickness?: number;
  quantity: number;
  notes?: string;
}

// ── Site Conditions ──
export interface ISiteConditions {
  environment: string;            // indoor | outdoor | semi_covered
  floorType?: string;             // e.g. "Tile", "Concrete"
  wallMaterial?: string;          // e.g. "Concrete hollow block"
  hasElectrical?: boolean;
  hasPlumbing?: boolean;
  accessNotes?: string;           // e.g. "Narrow staircase, no elevator"
  obstaclesOrConstraints?: string;
}

export interface IServiceSpecifications {
  measurements?: Record<string, string | number | boolean>;
  siteConditions?: Record<string, string | number | boolean>;
  materialsDesign?: Record<string, string | number | boolean>;
  additional?: Record<string, string | number | boolean>;
}

export interface IOcularAddressSnapshot {
  id?: string;
  label?: string;
  street?: string;
  barangay?: string;
  city?: string;
  province?: string;
  zip?: string;
  country?: string;
  addressType?: 'personal' | 'business';
  lat?: number;
  lng?: number;
  formattedAddress?: string;
  isDefault?: boolean;
}

export interface IConsultationSnapshot {
  appointmentId?: Types.ObjectId;
  status?: string;
  serviceType?: string;
  serviceTypeCustom?: string;
  actualVisitDateTime?: Date;
  discussionNotes?: string;
  consultationOutcome?: 'schedule_ocular' | 'no_ocular';
  noOcularReason?: string;
  recommendedOcularDate?: Date;
  recommendedOcularSlot?: string;
  recommendedOcularAddress?: IOcularAddressSnapshot;
  /** When the consultation report was submitted (the report's own submittedAt then restarts for the ocular visit). */
  submittedAt?: Date;
  capturedAt: Date;
}

export interface IVisitReport extends Document {
  _id: Types.ObjectId;
  appointmentId: Types.ObjectId;
  customerId: Types.ObjectId;
  salesStaffId: Types.ObjectId;

  status: VisitReportStatus;
  visitType: string; // ocular | consultation
  actualVisitDateTime?: Date;

  // ── Service Type (what fabrication category this report covers) ──
  serviceType: string;
  serviceTypeCustom?: string; // only used when serviceType === 'custom'

  // ── Structured measurements (per-line-item) ──
  measurementUnit: string;
  lineItems: ILineItem[];

  // ── Legacy flat measurements (backward compat for old reports) ──
  measurements?: {
    length?: number;
    width?: number;
    height?: number;
    area?: number;
    thickness?: number;
    unit: string;
    raw?: string;
  };

  // ── Site conditions ──
  siteConditions?: ISiteConditions;

  materials?: string;
  finishes?: string;
  preferredDesign?: string;
  customerRequirements?: string;
  notes?: string;
  specifications?: IServiceSpecifications;

  // ── Consultation-specific fields ──
  discussionNotes?: string;
  consultationOutcome?: 'schedule_ocular' | 'no_ocular';
  noOcularReason?: string;
  initialDesignKeys?: string[];
  initialDesignNotes?: string;
  selectedDesignTemplateId?: string;
  selectedDesignTemplateName?: string;
  selectedDesignTemplateImageUrl?: string;
  recommendedOcularDate?: Date;
  recommendedOcularSlot?: string;
  recommendedOcularAddressId?: string;
  recommendedOcularAddress?: IOcularAddressSnapshot;
  linkedProjectId?: Types.ObjectId;
  projectItemId?: Types.ObjectId;
  /**
   * Read-only copy of the consultation answers, taken when this report moves on to the ocular
   * visit (same report id) so the consultation record is not lost when those fields are cleared.
   */
  consultationSnapshot?: IConsultationSnapshot;

  // File uploads (R2 keys)
  photoKeys: string[];
  videoKeys: string[];
  sketchKeys: string[];
  referenceImageKeys: string[];

  // Return handling
  returnReason?: string;

  /** When the report was last submitted (shown in the Visit Reports list). */
  submittedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

// ── Line Item sub-schema ──
const lineItemSchema = new Schema<ILineItem>(
  {
    label: { type: String, required: true, trim: true },
    length: { type: Number },
    width: { type: Number },
    height: { type: Number },
    area: { type: Number },
    thickness: { type: Number },
    quantity: { type: Number, default: 1, min: 1 },
    notes: { type: String },
  },
  { _id: false },
);

// ── Site Conditions sub-schema ──
const siteConditionsSchema = new Schema<ISiteConditions>(
  {
    environment: { type: String, enum: Object.values(Environment), default: Environment.INDOOR },
    floorType: { type: String },
    wallMaterial: { type: String },
    hasElectrical: { type: Boolean },
    hasPlumbing: { type: Boolean },
    accessNotes: { type: String },
    obstaclesOrConstraints: { type: String },
  },
  { _id: false },
);

const visitReportSchema = new Schema<IVisitReport>(
  {
    appointmentId: { type: Schema.Types.ObjectId, ref: 'Appointment', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    salesStaffId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    status: {
      type: String,
      enum: Object.values(VisitReportStatus),
      default: VisitReportStatus.DRAFT,
    },
    visitType: { type: String, enum: ['ocular', 'consultation'], default: 'ocular' },
    actualVisitDateTime: { type: Date },

    // Service type
    serviceType: {
      type: String,
      enum: [...Object.values(ServiceType)],
      required: true,
      default: ServiceType.CUSTOM,
    },
    serviceTypeCustom: { type: String, trim: true },

    // Measurements
    measurementUnit: {
      type: String,
      enum: Object.values(MeasurementUnit),
      default: MeasurementUnit.CM,
    },
    lineItems: { type: [lineItemSchema], default: [] },

    // Legacy flat measurements (kept for backward compat)
    measurements: {
      length: Number,
      width: Number,
      height: Number,
      area: Number,
      thickness: Number,
      unit: { type: String, default: 'cm' },
      raw: String,
    },

    // Site conditions
    siteConditions: { type: siteConditionsSchema },

    materials: { type: String },
    finishes: { type: String },
    preferredDesign: { type: String },
    customerRequirements: { type: String },
    notes: { type: String },
    specifications: { type: Schema.Types.Mixed },

    photoKeys: [{ type: String }],
    videoKeys: [{ type: String }],
    sketchKeys: [{ type: String }],
    referenceImageKeys: [{ type: String }],

    // Consultation-specific fields
    discussionNotes: { type: String, maxlength: 4000 },
    consultationOutcome: { type: String, enum: ['schedule_ocular', 'no_ocular'] },
    noOcularReason: { type: String, maxlength: 1000 },
    initialDesignKeys: [{ type: String }],
    initialDesignNotes: { type: String, maxlength: 2000 },
    selectedDesignTemplateId: { type: String, trim: true },
    selectedDesignTemplateName: { type: String, trim: true },
    selectedDesignTemplateImageUrl: { type: String, trim: true },
    recommendedOcularDate: { type: Date },
    recommendedOcularSlot: { type: String },
    recommendedOcularAddressId: { type: String, trim: true },
    recommendedOcularAddress: { type: Schema.Types.Mixed },
    consultationSnapshot: { type: Schema.Types.Mixed },
    linkedProjectId: { type: Schema.Types.ObjectId, ref: 'Project' },
    projectItemId: { type: Schema.Types.ObjectId, ref: 'ProjectItem' },

    returnReason: { type: String },
    submittedAt: { type: Date },
  },
  { timestamps: true },
);

visitReportSchema.index({ appointmentId: 1 }); // no longer unique — multiple reports per appointment
visitReportSchema.index({ projectItemId: 1 });
visitReportSchema.index({ salesStaffId: 1, status: 1 });
visitReportSchema.index({ status: 1 });

export const VisitReport = mongoose.model<IVisitReport>('VisitReport', visitReportSchema);
