import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IIdempotencyKey extends Document {
  _id: Types.ObjectId;
  key: string;
  userId: Types.ObjectId;
  endpoint: string;
  responseStatus: number;
  responseBody?: Record<string, unknown>;
  expiresAt: Date;
  createdAt: Date;
}

const idempotencyKeySchema = new Schema<IIdempotencyKey>(
  {
    key: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    endpoint: { type: String, required: true },
    responseStatus: { type: Number },
    responseBody: { type: Schema.Types.Mixed },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

idempotencyKeySchema.index({ key: 1, userId: 1 }, { unique: true });
idempotencyKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // 24h TTL

export const IdempotencyKey = mongoose.model<IIdempotencyKey>('IdempotencyKey', idempotencyKeySchema);
