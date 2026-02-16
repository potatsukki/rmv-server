import mongoose, { Schema, Document, Types } from 'mongoose';
import { AppointmentStatus, AppointmentType, SlotCode, PaymentMethod } from '../utils/constants.js';

export interface IAppointment extends Document {
  _id: Types.ObjectId;
  customerId: Types.ObjectId;
  type: AppointmentType;
  date: string; // YYYY-MM-DD Asia/Manila
  slotCode: SlotCode;
  status: AppointmentStatus;

  // Ocular-specific
  salesStaffId?: Types.ObjectId;
  customerAddress?: string;
  customerLocation?: {
    lat: number;
    lng: number;
  };
  distanceKm?: number;
  ocularFee?: number;
  ocularFeeBreakdown?: {
    base: number;
    baseKm: number;
    extraKm: number;
    extraRate: number;
    extraFee: number;
    total: number;
    isWithinNCR: boolean;
  };
  ocularFeePaymentMethod?: PaymentMethod;
  ocularFeePaid?: boolean;

  // Notes
  customerNotes?: string;
  internalNotes?: string;

  // Rescheduling
  rescheduleCount: number;
  maxReschedules: number;
  rescheduleReason?: string;

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

    salesStaffId: { type: Schema.Types.ObjectId, ref: 'User' },
    customerAddress: { type: String },
    customerLocation: {
      lat: { type: Number },
      lng: { type: Number },
    },
    distanceKm: { type: Number },
    ocularFee: { type: Number },
    ocularFeeBreakdown: {
      base: Number,
      baseKm: Number,
      extraKm: Number,
      extraRate: Number,
      extraFee: Number,
      total: Number,
      isWithinNCR: Boolean,
    },
    ocularFeePaymentMethod: { type: String, enum: Object.values(PaymentMethod) },
    ocularFeePaid: { type: Boolean, default: false },

    customerNotes: { type: String },
    internalNotes: { type: String },

    rescheduleCount: { type: Number, default: 0 },
    maxReschedules: { type: Number, default: 3 },
    rescheduleReason: { type: String },

    bookedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    confirmedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

appointmentSchema.index({ customerId: 1, status: 1 });
appointmentSchema.index({ salesStaffId: 1, date: 1 });
appointmentSchema.index({ date: 1, slotCode: 1 });
appointmentSchema.index({ status: 1 });

export const Appointment = mongoose.model<IAppointment>('Appointment', appointmentSchema);
