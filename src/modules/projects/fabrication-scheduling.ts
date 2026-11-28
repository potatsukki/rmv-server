import { format, parse } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import { Types } from 'mongoose';
import { FabricationUpdate, Holiday, Project, ProjectItem, User } from '../../models/index.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import { FabricationStatus, ProjectStatus } from '../../utils/constants.js';
import { fabricationProgress, fabricationStageOrder, normalizeFabricationStatus } from '../../utils/fabricationLifecycle.js';
import { acquireStaffLock, type SalesDayLocks } from '../appointments/sales-day-lock.js';

const TZ = 'Asia/Manila';

/** A project keeps its people on its team from team assignment until fabrication is done. */
export const ACTIVE_FABRICATION_STATUSES = [ProjectStatus.PAYMENT_PENDING, ProjectStatus.FABRICATION];

/**
 * Quality Check is the last workshop stage (on-site: QC → Installation → Done; shop: QC → Ready
 * for Delivery → Done). Once every part of a project has reached it, the project is "near
 * completion" and its fabricators can take the next project (panel note 2026-11-27). It is the
 * same stage that opens the delivery / installation date, on purpose.
 */
export const NEAR_COMPLETION_STAGE = FabricationStatus.QUALITY_CHECK;

/** True when the stage is Quality Check or later (legacy on-site history is normalized first). */
export function stageIsNearCompletion(status: string | null | undefined, deliveryType?: string) {
  if (!status) return false;
  const order = fabricationStageOrder(deliveryType);
  const reached = order.indexOf(normalizeFabricationStatus(status as FabricationStatus, deliveryType));
  return reached >= 0 && reached >= order.indexOf(NEAR_COMPLETION_STAGE);
}

export interface FabricationTrackProgress {
  /** Every track (each project item, or the project itself) reached Quality Check or later. */
  nearCompletion: boolean;
  /** Stage of the slowest track. */
  currentStage: FabricationStatus | null;
  stageIndex: number;
  stageCount: number;
  progressPercent: number;
}

type TrackedProject = { _id: unknown; status?: string; deliveryType?: string };

/** "What if" views of the tracks: before a delete or a new update is saved (no-overlap guard). */
export interface TrackProgressOptions {
  /** Leave these updates out, as if they were already deleted. */
  excludeUpdateIds?: unknown[];
  /** Read this as the newest update of one track, as if it were already posted. */
  withLatest?: { projectId: unknown; projectItemId?: unknown; status: string };
}

// An aggregate $match is not cast by Mongoose, so an id given as a string must become an ObjectId.
const objectIds = (ids: unknown[]) => ids.filter(Boolean)
  .map((id) => (typeof id === 'string' && /^[a-f\d]{24}$/i.test(id) ? new Types.ObjectId(id) : id)) as Types.ObjectId[];

/**
 * Fabrication progress of each project by its SLOWEST track. Each project item has its own
 * lifecycle; a project without items uses the project-level track, and an item without an update
 * of its own falls back to the project-level update. Before fabrication starts nothing counts.
 */
export async function fabricationTrackProgress(
  projects: TrackedProject[],
  options: TrackProgressOptions = {},
): Promise<Map<string, FabricationTrackProgress>> {
  const started = projects.filter((project) => project.status === ProjectStatus.FABRICATION);
  const ids = objectIds(started.map((project) => project._id));
  const excluded = objectIds(options.excludeUpdateIds || []);
  const [latest, items] = ids.length
    ? await Promise.all([
      FabricationUpdate.aggregate<{ _id: { projectId: unknown; projectItemId: unknown }; status: string }>([
        { $match: { projectId: { $in: ids }, ...(excluded.length ? { _id: { $nin: excluded } } : {}) } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: { projectId: '$projectId', projectItemId: { $ifNull: ['$projectItemId', null] } }, status: { $first: '$status' } } },
      ]),
      ProjectItem.find({ projectId: { $in: ids }, status: { $ne: ProjectStatus.CANCELLED } }).select('_id projectId').lean(),
    ])
    : [[], []];

  const trackKey = (projectId: unknown, itemId?: unknown) => `${String(projectId)}:${itemId ? String(itemId) : ''}`;
  const latestByTrack = new Map((latest || []).map((row) => [trackKey(row._id.projectId, row._id.projectItemId), row.status]));
  if (options.withLatest) {
    latestByTrack.set(trackKey(options.withLatest.projectId, options.withLatest.projectItemId), options.withLatest.status);
  }
  const itemsByProject = new Map<string, string[]>();
  for (const item of items || []) {
    const projectId = String(item.projectId);
    itemsByProject.set(projectId, [...(itemsByProject.get(projectId) || []), String(item._id)]);
  }

  const result = new Map<string, FabricationTrackProgress>();
  for (const project of projects) {
    const projectId = String(project._id);
    if (project.status !== ProjectStatus.FABRICATION) {
      result.set(projectId, { nearCompletion: false, ...fabricationProgress(undefined, project.deliveryType) });
      continue;
    }
    const projectLevel = latestByTrack.get(trackKey(projectId));
    const itemIds = itemsByProject.get(projectId) || [];
    const statuses = itemIds.length
      ? itemIds.map((itemId) => latestByTrack.get(trackKey(projectId, itemId)) ?? projectLevel)
      : [projectLevel];
    const slowest = statuses
      .map((status) => fabricationProgress(status, project.deliveryType))
      .reduce((low, next) => (next.stageIndex < low.stageIndex ? next : low));
    result.set(projectId, {
      ...slowest,
      nearCompletion: statuses.every((status) => stageIsNearCompletion(status, project.deliveryType)),
    });
  }
  return result;
}

export function manilaToday(now = new Date()) {
  return formatInTimeZone(now, TZ, 'yyyy-MM-dd');
}

export function readableDay(day: string) {
  return format(parse(day, 'yyyy-MM-dd', new Date()), 'MMM d, yyyy');
}

async function staffNames(ids: string[]) {
  const users = await User.find({ _id: { $in: ids } }).select('firstName lastName').lean();
  return new Map(users.map((user) => [String(user._id), `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || 'A fabricator']));
}

/** A lead / assistant who is still on another project in the workshop. */
export interface WorkshopConflict {
  staffId: string;
  name: string;
  projectId: string;
  projectNumber?: string;
  title?: string;
  role: 'Lead' | 'Assistant';
}

/**
 * Who of `staffIds` leads or assists ANOTHER project still in the workshop (payment pending, or in
 * fabrication with a part not yet at Quality Check). Delivery crew duty does not count.
 */
export async function findWorkshopConflicts(projectId: string, staffIds: string[]): Promise<WorkshopConflict[]> {
  const ids = [...new Set(staffIds.filter(Boolean).map(String))];
  if (!ids.length) return [];

  const others = await Project.find({
    _id: { $ne: projectId },
    status: { $in: ACTIVE_FABRICATION_STATUSES },
    $or: [{ fabricationLeadId: { $in: ids } }, { fabricationAssistantIds: { $in: ids } }],
  }).select('projectNumber title status deliveryType fabricationLeadId fabricationAssistantIds').lean();
  if (!others.length) return [];

  const progress = await fabricationTrackProgress(others);
  const inWorkshop = others.filter((project) => !progress.get(String(project._id))?.nearCompletion);
  if (!inWorkshop.length) return [];

  const names = await staffNames(ids);
  return ids.flatMap((id) => inWorkshop.flatMap((project): WorkshopConflict[] => {
    const role = String(project.fabricationLeadId) === id
      ? 'Lead'
      : (project.fabricationAssistantIds || []).some((assistant) => String(assistant) === id) ? 'Assistant' : null;
    return role ? [{
      staffId: id,
      name: names.get(id) ?? 'A fabricator',
      projectId: String(project._id),
      projectNumber: project.projectNumber,
      title: project.title,
      role,
    }] : [];
  }));
}

const projectLabel = (conflict: WorkshopConflict) => conflict.projectNumber || conflict.title || 'another project';

/**
 * A fabricator (lead or assistant) works on one project in the workshop at a time: another
 * project blocks them until it reaches Quality Check (see NEAR_COMPLETION_STAGE). Being on another
 * project's delivery crew does not count; neither does this project itself.
 */
export async function assertFabricatorsFree(projectId: string, staffIds: string[]) {
  const conflicts = await findWorkshopConflicts(projectId, staffIds);
  if (!conflicts.length) return;

  throw AppError.badRequest(
    `${conflicts.map((conflict) => `${conflict.name} is still on ${projectLabel(conflict)} (${conflict.role})`).join('; ')}. A fabricator can take a new project once their current one reaches Quality Check.`,
    ErrorCode.FABRICATOR_ALREADY_ASSIGNED,
  );
}

/**
 * Serializes team changes per fabricator (lead, assistant, or the team of a project whose stage
 * goes back), so two saves can't put one person on two workshop projects. Held until the request
 * ends (`withSalesDayLocks`).
 */
export async function lockFabricators(locks: SalesDayLocks, staffIds: string[], lockedBy: string) {
  for (const staffId of [...new Set(staffIds.filter(Boolean).map((id) => String(id).toLowerCase()))].sort()) {
    await acquireStaffLock(
      locks,
      { staffId, date: 'all-dates', slot: 'fabricator-team' },
      lockedBy,
      'Another team assignment for this fabricator is being saved right now. Please try again in a moment.',
    );
  }
}

type TeamProject = TrackedProject & {
  fabricationLeadId?: unknown;
  fabricationAssistantIds?: unknown[];
};

/**
 * No overlap (2026-11-28): refuses a change that sends a project back into the workshop (a part
 * no longer at Quality Check or later) while someone on its team already took another workshop
 * project because this one had reached Quality Check; they would be on two workshop projects.
 * Takes the team's fabricator locks first, so an auto-assign or a team change for the same people
 * waits for this change. The caller makes the change while the locks are held.
 */
export async function assertProjectStaysOutOfWorkshop(
  project: TeamProject,
  change: TrackProgressOptions,
  locks: SalesDayLocks,
  actorId: string,
  kind: 'delete' | 'post',
) {
  if (project.status !== ProjectStatus.FABRICATION) return;
  const team = [project.fabricationLeadId, ...(project.fabricationAssistantIds || [])].filter(Boolean).map(String);
  if (!team.length) return;

  const id = String(project._id);
  if (!(await fabricationTrackProgress([project])).get(id)?.nearCompletion) return; // already in the workshop
  if ((await fabricationTrackProgress([project], change)).get(id)?.nearCompletion) return; // stays near completion

  await lockFabricators(locks, team, actorId);
  const conflicts = await findWorkshopConflicts(id, team);
  if (!conflicts.length) return;

  const taken = conflicts.map((conflict) => `${conflict.name} already took ${projectLabel(conflict)} (${conflict.role})`).join('; ');
  const others = [...new Set(conflicts.map(projectLabel))].join(', ');
  throw AppError.badRequest(
    kind === 'delete'
      ? `This update can't be deleted: ${taken} after this project reached Quality Check. Ask the engineer or admin to change the team of ${others} first.`
      : `This update would move the project back before Quality Check, but ${taken}. Ask the engineer or admin to change the team of ${others} first.`,
    ErrorCode.FABRICATOR_ALREADY_ASSIGNED,
  );
}

/** Delivery / installation day: today or later (Manila), Monday to Saturday, not a holiday. */
export async function assertDeliveryDateAllowed(date: string, now = new Date()) {
  const parsed = parse(date, 'yyyy-MM-dd', new Date());
  if (Number.isNaN(parsed.getTime()) || format(parsed, 'yyyy-MM-dd') !== date) {
    throw AppError.badRequest('Choose a valid delivery / installation date');
  }
  if (date < manilaToday(now)) {
    throw AppError.badRequest('The delivery / installation date cannot be in the past');
  }
  if (parsed.getDay() === 0) {
    throw AppError.badRequest('Delivery / installation is Monday to Saturday. Choose another date.');
  }
  const holiday = await Holiday.findOne({ date }).select('name').lean();
  if (holiday) {
    throw AppError.badRequest(`${readableDay(date)} is a holiday${holiday.name ? ` (${holiday.name})` : ''}. Choose another date.`);
  }
}

/** A delivery takes the crew's whole day, so a crew member can't have two deliveries on one date. */
export async function assertDeliveryCrewFree(projectId: string, crewIds: string[], date: string) {
  const ids = [...new Set(crewIds.filter(Boolean))];
  if (!ids.length) return;

  const others = await Project.find({
    _id: { $ne: projectId },
    status: { $in: ACTIVE_FABRICATION_STATUSES },
    'deliverySchedule.date': date,
    deliveryCrewIds: { $in: ids },
  }).select('projectNumber title deliveryCrewIds').lean();
  if (!others.length) return;

  const names = await staffNames(ids);
  const conflicts = ids.flatMap((id) => others
    .filter((project) => (project.deliveryCrewIds || []).some((crewId) => String(crewId) === id))
    .map((project) => `${names.get(id) ?? 'A crew member'} already has a delivery on ${readableDay(date)} (${project.projectNumber || project.title})`));
  if (!conflicts.length) return;

  throw AppError.badRequest(
    `${conflicts.join('; ')}. A delivery takes the crew's whole day; choose other crew or another date.`,
    ErrorCode.DELIVERY_CREW_CONFLICT,
  );
}

const STAGE_LABELS: Partial<Record<FabricationStatus, string>> = {
  [FabricationStatus.WELDING_ASSEMBLY]: 'Welding / Assembly',
  [FabricationStatus.QUALITY_CHECK]: 'Quality Check',
};

/**
 * The stage that opens the delivery / installation date: Quality Check, the last workshop stage
 * before the work leaves the shop (on-site: before Installation; shop: before Ready for Delivery).
 * Before it, neither the date nor the customer's confirmation banner is shown.
 */
export function deliveryDateUnlockStage(_deliveryType?: string) {
  const stage = FabricationStatus.QUALITY_CHECK;
  return { stage, label: STAGE_LABELS[stage] ?? stage };
}

/** True when the latest stage reached is at or past the unlock stage. */
export function stageReachesDeliveryUnlock(status: string | undefined, deliveryType?: string) {
  if (!status) return false;
  const order = fabricationStageOrder(deliveryType);
  const reached = order.indexOf(normalizeFabricationStatus(status as FabricationStatus, deliveryType));
  return reached >= 0 && reached >= order.indexOf(deliveryDateUnlockStage(deliveryType).stage);
}

/**
 * The delivery / installation date can be set once any item (or the project-level track) has
 * reached the unlock stage, so a project can't be scheduled while fabrication has barely started.
 */
export async function isDeliveryDateUnlocked(project: { _id: unknown; deliveryType?: string }) {
  const latest = await FabricationUpdate.aggregate<{ _id: unknown; status: string }>([
    { $match: { projectId: project._id } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: { $ifNull: ['$projectItemId', null] }, status: { $first: '$status' } } },
  ]);
  return latest.some((entry) => stageReachesDeliveryUnlock(entry.status, project.deliveryType));
}
