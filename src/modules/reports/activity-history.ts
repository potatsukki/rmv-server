import { AuditLog } from '../../models/index.js';

/** Records whose audit rows make up one history, e.g. an appointment and its visit reports. */
export interface ActivityTarget {
  targetType: string;
  ids: unknown[];
}

export interface ActivityHistoryItem {
  _id: string;
  action: string;
  targetType?: string;
  targetId?: string;
  at: Date;
  actor: { _id: string; name: string; roles: string[] } | null;
  /** True for steps the system did on its own (no person acted). */
  automatic: boolean;
  details: Record<string, string | number | boolean>;
}

const MAX_HISTORY_ITEMS = 300;

function toPlainValue(value: unknown): string | number | boolean | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  // ObjectIds (and anything else with a meaningful string form) become strings.
  if (typeof (value as { toHexString?: unknown }).toHexString === 'function') return String(value);
  return undefined;
}

/** Only simple values are returned; nested objects and request metadata (IP, browser) stay out. */
function safeDetails(details: unknown): Record<string, string | number | boolean> {
  if (!details || typeof details !== 'object') return {};
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
    const plain = toPlainValue(value);
    if (plain !== undefined) result[key] = plain;
  }
  return result;
}

/** Oldest first: who did what, and when, across the given records. */
export async function getActivityHistory(targets: ActivityTarget[]): Promise<ActivityHistoryItem[]> {
  const conditions = targets
    .map((target) => ({ targetType: target.targetType, ids: target.ids.filter(Boolean) }))
    .filter((target) => target.ids.length > 0)
    .map((target) => ({ targetType: target.targetType, targetId: { $in: target.ids } }));
  if (conditions.length === 0) return [];

  const logs = await AuditLog.find({ $or: conditions } as Record<string, unknown>)
    .sort({ createdAt: 1 })
    .limit(MAX_HISTORY_ITEMS)
    .populate('actorId', 'firstName lastName roles')
    .lean();

  return logs.map((log: any) => {
    const actor = log.actorId && typeof log.actorId === 'object' && 'firstName' in log.actorId
      ? {
        _id: String(log.actorId._id),
        name: [log.actorId.firstName, log.actorId.lastName].filter(Boolean).join(' ').trim() || 'Staff',
        roles: Array.isArray(log.actorId.roles) ? log.actorId.roles : [],
      }
      : null;
    return {
      _id: String(log._id),
      action: log.action,
      targetType: log.targetType,
      targetId: log.targetId ? String(log.targetId) : undefined,
      at: log.createdAt,
      actor,
      automatic: !log.actorId || log.details?.automatic === true,
      details: safeDetails(log.details),
    };
  });
}
