import mongoose, { Schema, Document, Types } from 'mongoose';
import { AppointmentStatus, AppointmentType, AppointmentAttendanceStatus, SlotCode, PaymentMethod, OcularFeePaymentChoice, ServiceType, MeasurementUnit, Environment } from '../utils/constants.js';
import type { ILineItem, ISiteConditions } from './VisitReport.js';

// ── Customer Site Details (pre-visit info from customer) ──
export type SiteDetailsStatus = 'pending' | 'submitted' | 'skipped';
export type InitialDesignStatus = 'pending' | 'submitted' | 'skipped';

export interface ICustomerSiteDetails {
  serviceTypes?: string[];
  serviceTypeCustom?: string;
  measurementUnit?: string;
  lineItems?: ILineItem[];
  siteConditions?: ISiteConditions;
  materials?: string;
  finishes?: string;
  preferredDesign?: string;
  customerRequirements?: string;
  notes?: string;
  photoKeys?: string[];
  videoKeys?: string[];
  sketchKeys?: string[];
  referenceImageKeys?: string[];
}

export interface IAppointment extends Document {
  _id: Types.ObjectId;
  customerId: Types.ObjectId;
  type: AppointmentType;
  date: string; // YYYY-MM-DD Asia/Manila
  slotCode: SlotCode;
  status: AppointmentStatus;
  attendanceStatus?: AppointmentAttendanceStatus;
  actualArrivalAt?: Date;
  consultationStartedAt?: Date;
  consultationCompletedAt?: Date;
  attendanceNotes?: string;
  attendanceUpdatedBy?: Types.ObjectId;
  attendanceUpdatedAt?: Date;
  attendanceOverrideReason?: string;

  // Ocular-specific
  salesStaffId?: Types.ObjectId;
  latitude?: number;
  longitude?: number;
  formattedAddress?: string;
  customerAddress?: string;
  addressStructured?: {
    street: string;
    barangay: string;
    city: string;
    province: string;
    zip: string;
    addressType?: 'personal' | 'business';
  };
  customerLocation?: {
    lat: number;
    lng: number;
  };
  distanceKm?: number;
  ocularFee?: number;
  ocularFeeBreakdown?: {
    label: string;
    baseFee: number;
    baseCoveredKm: number;
    perKmRate: number;
    additionalDistanceKm: number;
    additionalFee: number;
    total: number;
    isWithinNCR: boolean;
  };
  ocularFeePaymentMethod?: PaymentMethod;
  ocularFeePaymentChoice?: OcularFeePaymentChoice;
  ocularFeePaid?: boolean;
  ocularFeeProofKey?: string;
  ocularFeeReferenceNumber?: string;
  ocularFeeVerifiedBy?: Types.ObjectId;
  ocularFeeStatus?: 'pending' | 'cash_pending' | 'proof_submitted' | 'verified' | 'declined';
  ocularFeeDeclineReason?: string;


  paymongoCheckoutSessionId?: string;
  paymongoCheckoutUrl?: string;

  // Notes
  customerNotes?: string;
  internalNotes?: string;

  // Service types (set at booking time)
  serviceTypes?: string[];
  serviceTypeCustom?: string;

  // Cancellation
  cancellationReason?: string;
  cancelledBy?: Types.ObjectId;

  // Rescheduling
  rescheduleCount: number;
  maxReschedules: number;
  rescheduleReason?: string;
  requestedRescheduleDate?: string;
  requestedRescheduleSlot?: string;

  // Set to true when the consultation visit report has been submitted
  consultationReportSubmitted?: boolean;
  sourceConsultationAppointmentId?: Types.ObjectId;
  sourceConsultationReportId?: Types.ObjectId;

  // Customer-provided site details (for office appointments, mandatory before confirmation)
  customerSiteDetails?: ICustomerSiteDetails;
  siteDetailsStatus: SiteDetailsStatus;

  // Sales-provided initial design draft before the ocular visit
  initialDesignKeys?: string[];
  initialDesignNotes?: string;
  initialDesignStatus: InitialDesignStatus;

  // Booking metadata
  bookedBy: Types.ObjectId; // Customer or Agent who created
  confirmedBy?: Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

const appointmentSchema = new Schema<IAppointment>(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: Object.values(AppointmentType), required: true },
    date: { type: String, required: true }, // YYYY-MM-DD
    slotCode: { type: String, required: true },
    status: {
      type: String,
      enum: Object.values(AppointmentStatus),
      default: AppointmentStatus.REQUESTED,
    },
    attendanceStatus: {
      type: String,
      enum: Object.values(AppointmentAttendanceStatus),
      default: AppointmentAttendanceStatus.SCHEDULED,
    },
    actualArrivalAt: { type: Date },
    consultationStartedAt: { type: Date },
    consultationCompletedAt: { type: Date },
    attendanceNotes: { type: String },
    attendanceUpdatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    attendanceUpdatedAt: { type: Date },
    attendanceOverrideReason: { type: String },

    salesStaffId: { type: Schema.Types.ObjectId, ref: 'User' },
    latitude: { type: Number },
    longitude: { type: Number },
    formattedAddress: { type: String },
    customerAddress: { type: String },
    addressStructured: {
      street: { type: String, trim: true },
      barangay: { type: String, trim: true },
      city: { type: String, trim: true },
      province: { type: String, trim: true },
      zip: { type: String, trim: true },
      addressType: { type: String, enum: ['personal', 'business'] },
      _id: false,
    },
    customerLocation: {
      lat: { type: Number },
      lng: { type: Number },
    },
    distanceKm: { type: Number },
    ocularFee: { type: Number },
    ocularFeeBreakdown: {
      label: String,
      baseFee: Number,
      baseCoveredKm: Number,
      perKmRate: Number,
      additionalDistanceKm: Number,
      additionalFee: Number,
      total: Number,
      isWithinNCR: Boolean,
    },
    ocularFeePaymentMethod: { type: String, enum: Object.values(PaymentMethod) },
    ocularFeePaymentChoice: { type: String, enum: Object.values(OcularFeePaymentChoice) },
    ocularFeePaid: { type: Boolean, default: false },
    ocularFeeProofKey: { type: String },
    ocularFeeReferenceNumber: { type: String },
    ocularFeeStatus: { type: String, enum: ['pending', 'cash_pending', 'proof_submitted', 'verified', 'declined'] },
    ocularFeeDeclineReason: { type: String },
    ocularFeeVerifiedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    paymongoCheckoutSessionId: { type: String },
    paymongoCheckoutUrl: { type: String },

    customerNotes: { type: String },
    internalNotes: { type: String },

    serviceTypes: [{ type: String, enum: [...Object.values(ServiceType)] }],
    serviceTypeCustom: { type: String, trim: true },

    cancellationReason: { type: String },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User' },

    rescheduleCount: { type: Number, default: 0 },
    maxReschedules: { type: Number, default: 3 },
    rescheduleReason: { type: String },
    requestedRescheduleDate: { type: String },
    requestedRescheduleSlot: { type: String },

    // Customer-provided site details
    customerSiteDetails: {
      serviceTypes: [{ type: String, enum: [...Object.values(ServiceType)] }],
      serviceTypeCustom: { type: String, trim: true },
      measurementUnit: { type: String, enum: Object.values(MeasurementUnit) },
      lineItems: [{
        label: { type: String, trim: true },
        length: { type: Number },
        width: { type: Number },
        height: { type: Number },
        area: { type: Number },
        thickness: { type: Number },
        quantity: { type: Number, default: 1, min: 1 },
        notes: { type: String },
        _id: false,
      }],
      siteConditions: {
        environment: { type: String, enum: Object.values(Environment) },
        floorType: { type: String },
        wallMaterial: { type: String },
        hasElectrical: { type: Boolean },
        hasPlumbing: { type: Boolean },
        accessNotes: { type: String },
        obstaclesOrConstraints: { type: String },
        _id: false,
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
      _id: false,
    },
    siteDetailsStatus: {
      type: String,
      enum: ['pending', 'submitted', 'skipped'],
      default: 'pending',
    },
    initialDesignKeys: [{ type: String }],
    initialDesignNotes: { type: String },
    initialDesignStatus: {
      type: String,
      enum: ['pending', 'submitted', 'skipped'],
      default: 'pending',
    },

    consultationReportSubmitted: { type: Boolean, default: false },
    sourceConsultationAppointmentId: { type: Schema.Types.ObjectId, ref: 'Appointment' },
    sourceConsultationReportId: { type: Schema.Types.ObjectId, ref: 'VisitReport' },

    bookedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    confirmedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

appointmentSchema.index({ customerId: 1, status: 1 });
appointmentSchema.index({ salesStaffId: 1, date: 1 });
appointmentSchema.index({ date: 1, slotCode: 1 });
appointmentSchema.index({ status: 1 });
appointmentSchema.index({ sourceConsultationAppointmentId: 1, type: 1 });

export const Appointment = mongoose.model<IAppointment>('Appointment', appointmentSchema);
