import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * Route cache for Google Maps API responses.
 * Cached for 24 hours per origin-destination pair.
 */
export interface IRouteCache extends Document {
  _id: Types.ObjectId;
  originHash: string;
  destinationHash: string;
  distanceKm: number;
  durationMinutes: number;
  polyline?: string;
  hasFerry: boolean;
  rawResponse?: Record<string, unknown>;
  expiresAt: Date;
  createdAt: Date;
}

const routeCacheSchema = new Schema<IRouteCache>(
  {
    originHash: { type: String, required: true },
    destinationHash: { type: String, required: true },
    distanceKm: { type: Number, required: true },
    durationMinutes: { type: Number, required: true },
    polyline: { type: String },
    hasFerry: { type: Boolean, default: false },
    rawResponse: { type: Schema.Types.Mixed },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

routeCacheSchema.index({ originHash: 1, destinationHash: 1 });
routeCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RouteCache = mongoose.model<IRouteCache>('RouteCache', routeCacheSchema);
