import mongoose, { Schema, Document, Types } from 'mongoose';
import { FabricationStatus } from '../utils/constants.js';

export interface IFabricationUpdate extends Document {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  status: FabricationStatus;
  notes: string; // Required per spec
  photoKeys: string[]; // Optional photos per update
  updatedBy: Types.ObjectId;
  createdAt: Date;
}

const fabricationUpdateSchema = new Schema<IFabricationUpdate>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    status: {
      type: String,
      enum: Object.values(FabricationStatus),
      required: true,
    },
    notes: { type: String, required: true },
    photoKeys: {
      type: [{ type: String }],
      validate: {
        validator: (v: string[]) => v.length <= 10,
        message: 'Must provide at most 10 photos per update',
      },
    },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

fabricationUpdateSchema.index({ projectId: 1, createdAt: -1 });

export const FabricationUpdate = mongoose.model<IFabricationUpdate>('FabricationUpdate', fabricationUpdateSchema);
