import mongoose, { Schema, Document, Types } from 'mongoose';
import { NotificationCategory } from '../utils/constants.js';

export interface INotification extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  category: NotificationCategory;
  title: string;
  message: string;
  link?: string; // Frontend route to navigate to
  isRead: boolean;
  createdAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    category: { type: String, enum: Object.values(NotificationCategory), required: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    link: { type: String },
    isRead: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });

export const Notification = mongoose.model<INotification>('Notification', notificationSchema);
