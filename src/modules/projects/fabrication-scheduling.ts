import { format, parse } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import { FabricationUpdate, Holiday, Project, User } from '../../models/index.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import { DeliveryType, FabricationStatus, ProjectStatus } from '../../utils/constants.js';
import { fabricationStageOrder, normalizeFabricationStatus } from '../../utils/fabricationLifecycle.js';

const TZ = 'Asia/Manila';

/** A project keeps its people occupied from team assignment until fabrication is done. */
export const ACTIVE_FABRICATION_STATUSES = [ProjectStatus.PAYMENT_PENDING, ProjectStatus.FABRICATION];

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

/**
 * A fabricator (lead or assistant) works on one active project at a time. Being on another
 * project's delivery crew does not count; neither does this project itself.
 */
export async function assertFabricatorsFree(projectId: string, staffIds: string[]) {
  const ids = [...new Set(staffIds.filter(Boolean))];
  if (!ids.length) return;

  const others = await Project.find({
    _id: { $ne: projectId },
    status: { $in: ACTIVE_FABRICATION_STATUSES },
    $or: [{ fabricationLeadId: { $in: ids } }, { fabricationAssistantIds: { $in: ids } }],
  }).select('projectNumber title fabricationLeadId fabricationAssistantIds').lean();
  if (!others.length) return;

  const names = await staffNames(ids);
  const conflicts = ids.flatMap((id) => others.flatMap((project) => {
    const role = String(project.fabricationLeadId) === id
      ? 'Lead'
      : (project.fabricationAssistantIds || []).some((assistant) => String(assistant) === id) ? 'Assistant' : null;
    return role ? [`${names.get(id) ?? 'A fabricator'} is already on ${project.projectNumber || project.title} (${role})`] : [];
  }));
  if (!conflicts.length) return;

  throw AppError.badRequest(
    `${conflicts.join('; ')}. A fabricator can work on one active project at a time.`,
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
 * The stage that opens the delivery / installation date: the last workshop stage before the work
 * leaves the shop (on-site: Welding / Assembly before Installation; shop: Quality Check before
 * Ready for Delivery).
 */
export function deliveryDateUnlockStage(deliveryType?: string) {
  const stage = deliveryType === DeliveryType.ON_SITE_INSTALLATION
    ? FabricationStatus.WELDING_ASSEMBLY
    : FabricationStatus.QUALITY_CHECK;
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
