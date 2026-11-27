import { AppointmentStatus, AppointmentType, SLOT_CODES } from '../../utils/constants.js';

/**
 * Travel time and staff busy time — the single source of truth for RMV scheduling.
 *
 * Every capacity check (customer booking, agent booking, staff assignment, reschedule, ocular
 * scheduling, the staff picker) and every schedule shown on screen comes from these functions.
 * The web does not compute travel time: the API sends `ocularSchedule` / `travelLabel` from here.
 *
 * Model (user decisions 2026-11-26):
 * - A consultation keeps its sales staff busy for its one-hour slot at the office.
 * - An ocular visit is a round trip shop → site → shop: preparation (15 min) + the rounded drive
 *   + a traffic allowance each way + 1.5 hr on site. Two oculars on one day are never chained
 *   site to site; the staff is back at the shop between them.
 * - The route (OpenRouteService, shop → site) has no live traffic, so the allowance stands in for it.
 * - An ocular visit with no route yet (no site pin) keeps its staff busy the whole day.
 * - Getting back after 5:00 PM is a warning, not a block.
 */

/** Every appointment slot (SLOT_CODES) is one hour long. */
export const APPOINTMENT_SLOT_MINUTES = 60;
/** Time on site for an ocular visit (measuring). */
export const OCULAR_SITE_MINUTES = 90;
/** Preparing and loading before leaving the shop for an ocular visit. */
export const OCULAR_PREP_MINUTES = 15;
/** Traffic allowance added to each one-way trip of an ocular visit (the route has no live traffic). */
export const OCULAR_TRAFFIC_BUFFER_MINUTES = 60;
/** A site this close to the shop (route km) gets no traffic allowance. */
export const OCULAR_NEAR_SHOP_KM = 4;
/** The route's drive time is rounded up to this step, so the schedule has no odd minutes. */
export const OCULAR_TRAVEL_STEP_MINUTES = 30;
/** End of the last slot (5:00 PM): getting back later is shown as a warning. */
export const WORKDAY_END_MINUTES = 17 * 60;
/** Asia/Manila is UTC+8 all year (no daylight saving). */
const MANILA_OFFSET_MINUTES = 8 * 60;

/**
 * Statuses that give the staff's time back at once in the database queries. A finished appointment
 * is decided by holdsStaffTime: a consultation frees it at once, an ocular visit once the trip back ends.
 */
export const SALES_SLOT_FREEING_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.CANCELLED,
  AppointmentStatus.NO_SHOW,
];

export function slotStartMinutes(slotCode: string | undefined | null): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(slotCode ?? '').trim());
  if (!match) return undefined;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** True when two slots on the same date overlap in time ([start, start + 60 min)). */
export function slotsOverlap(a: string | undefined | null, b: string | undefined | null): boolean {
  const startA = slotStartMinutes(a);
  const startB = slotStartMinutes(b);
  if (startA === undefined || startB === undefined) return Boolean(a) && a === b;
  return startA < startB + APPOINTMENT_SLOT_MINUTES && startB < startA + APPOINTMENT_SLOT_MINUTES;
}

/** Drive time rounded up to the next 30 min (48 → 60, 70 → 90); 0 stays 0. */
export function roundTravelMinutes(travelMinutes: number): number {
  return Math.ceil(Math.max(0, travelMinutes) / OCULAR_TRAVEL_STEP_MINUTES) * OCULAR_TRAVEL_STEP_MINUTES;
}

export function isNearShop(distanceKm?: number | null): boolean {
  return typeof distanceKm === 'number' && Number.isFinite(distanceKm) && distanceKm <= OCULAR_NEAR_SHOP_KM;
}

/** One-way trip to an ocular site: rounded drive + the traffic allowance (none for a site near the shop). */
export function legMinutes(travelMinutes: number, distanceKm?: number | null): number {
  return roundTravelMinutes(travelMinutes) + (isNearShop(distanceKm) ? 0 : OCULAR_TRAFFIC_BUFFER_MINUTES);
}

/** An ocular site's route from the shop, as saved on the appointment. */
export type OcularRoute = {
  /** One-way drive from the shop (route estimate, no traffic). */
  travelDurationMinutes?: number | null;
  /** Route distance from the shop. */
  distanceKm?: number | null;
};

/**
 * The route a lookup passed as query strings (`travelMinutes`, `distanceKm`), or undefined when
 * there is none. Express 5 keeps req.query as raw strings even after validation.
 */
export function ocularRouteFromQuery(travelMinutes?: unknown, distanceKm?: unknown): OcularRoute | undefined {
  const toNumber = (value: unknown) => {
    if (value === undefined || value === null || value === '') return undefined;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : undefined;
  };
  const travel = toNumber(travelMinutes);
  return travel === undefined ? undefined : { travelDurationMinutes: travel, distanceKm: toNumber(distanceKm) };
}

export type ScheduledVisit = OcularRoute & {
  type?: AppointmentType | string | null;
  slotCode?: string | null;
};

function routeMinutes(visit: OcularRoute): number | undefined {
  const travel = visit.travelDurationMinutes;
  return typeof travel === 'number' && Number.isFinite(travel) && travel >= 0 ? travel : undefined;
}

/**
 * Minutes of the day [start, end) the visit keeps its sales staff busy: a consultation is its
 * slot; an ocular visit runs from preparing at the shop until getting back. Null when that is
 * unknown (an ocular visit with no route): it then takes the whole day.
 */
export function staffBusyWindow(visit: ScheduledVisit): { start: number; end: number } | null {
  const start = slotStartMinutes(visit.slotCode);
  if (start === undefined) return null;
  if (visit.type !== AppointmentType.OCULAR) return { start, end: start + APPOINTMENT_SLOT_MINUTES };
  const travel = routeMinutes(visit);
  if (travel === undefined) return null;
  const leg = legMinutes(travel, visit.distanceKm);
  return { start: start - leg - OCULAR_PREP_MINUTES, end: start + OCULAR_SITE_MINUTES + leg };
}

/**
 * True when one sales staff member can't hold both appointments on the same date: their busy
 * times overlap (staffBusyWindow). An ocular visit with no route still takes the whole day.
 */
export function appointmentsConflict(a: ScheduledVisit, b: ScheduledVisit): boolean {
  const windowA = staffBusyWindow(a);
  const windowB = staffBusyWindow(b);
  if (windowA && windowB) return windowA.start < windowB.end && windowB.start < windowA.end;
  return a.type === AppointmentType.OCULAR
    || b.type === AppointmentType.OCULAR
    || slotsOverlap(a.slotCode, b.slotCode);
}

/** "8:05 AM" for minutes of the day. */
export function formatMinutesLabel(totalMinutes: number) {
  const minutes = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
}

/** "45 min", "1 hr 30 min", "2 hr". */
export function formatTravelDuration(minutes: number) {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (!hours) return `${rest} min`;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

/** The drive time as shown everywhere (rounded): "30 min", "1 hr", "1 hr 30 min". */
export function travelLabel(travelMinutes: number) {
  return formatTravelDuration(roundTravelMinutes(travelMinutes));
}

/** "7:45 AM–1:30 PM": the time an ocular visit keeps its staff busy, or null when unknown. */
export function formatOcularBusyWindow(visit: ScheduledVisit): string | null {
  if (visit.type !== AppointmentType.OCULAR) return null;
  const window = staffBusyWindow(visit);
  return window ? `${formatMinutesLabel(window.start)}–${formatMinutesLabel(window.end)}` : null;
}

export interface OcularSchedule {
  /** Raw route estimate (no traffic), as saved. */
  travelMinutes: number;
  /** Drive rounded up to 30 min. */
  roundedTravelMinutes: number;
  /** "1 hr" */
  travelLabel: string;
  distanceKm: number | null;
  /** Traffic allowance per way (0 near the shop). */
  trafficMinutes: number;
  nearShop: boolean;
  prepMinutes: number;
  siteMinutes: number;
  /** "7:45 AM" — start preparing at the shop (the staff's busy time starts here). */
  prepFrom: string;
  /** "8:00 AM" — leave the shop. */
  leaveAt: string;
  /** "10:00 AM" */
  onSiteStart: string;
  /** "11:30 AM" */
  onSiteEnd: string;
  /** "1:30 PM" — back at the shop (the staff's busy time ends here). */
  backAt: string;
  /** Getting back after 5:00 PM (a warning, not a block). */
  endsAfterWorkday: boolean;
}

/** The ocular schedule every screen shows, or null when the slot or the route is unknown. */
export function describeOcularSchedule(slotCode: string | null | undefined, route: OcularRoute | null | undefined): OcularSchedule | null {
  const start = slotStartMinutes(slotCode);
  const travel = route ? routeMinutes(route) : undefined;
  if (start === undefined || travel === undefined) return null;
  const distanceKm = typeof route?.distanceKm === 'number' && Number.isFinite(route.distanceKm) ? route.distanceKm : null;
  const nearShop = isNearShop(distanceKm);
  const leg = legMinutes(travel, distanceKm);
  const back = start + OCULAR_SITE_MINUTES + leg;
  return {
    travelMinutes: travel,
    roundedTravelMinutes: roundTravelMinutes(travel),
    travelLabel: travelLabel(travel),
    distanceKm,
    trafficMinutes: nearShop ? 0 : OCULAR_TRAFFIC_BUFFER_MINUTES,
    nearShop,
    prepMinutes: OCULAR_PREP_MINUTES,
    siteMinutes: OCULAR_SITE_MINUTES,
    prepFrom: formatMinutesLabel(start - leg - OCULAR_PREP_MINUTES),
    leaveAt: formatMinutesLabel(start - leg),
    onSiteStart: formatMinutesLabel(start),
    onSiteEnd: formatMinutesLabel(start + OCULAR_SITE_MINUTES),
    backAt: formatMinutesLabel(back),
    endsAfterWorkday: back > WORKDAY_END_MINUTES,
  };
}

/**
 * The schedule for every bookable slot (SLOT_CODES), for a route that has no slot yet: the
 * Schedule Ocular dialog shows the one for the picked time instead of computing it on the web.
 */
export function describeOcularSchedulesBySlot(route: OcularRoute | null | undefined): Record<string, OcularSchedule> {
  const schedules: Record<string, OcularSchedule> = {};
  for (const slotCode of SLOT_CODES) {
    const schedule = describeOcularSchedule(slotCode, route);
    if (schedule) schedules[slotCode] = schedule;
  }
  return schedules;
}

/** Epoch ms of a Manila date (yyyy-MM-dd) + minutes of that day. */
function manilaTimestamp(date: string, minutesOfDay: number): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return undefined;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) + (minutesOfDay - MANILA_OFFSET_MINUTES) * 60_000;
}

/** A visit that has happened: completed (incl. Customer Declined / office No Show) or a consultation finished as Ready for Ocular. */
const FINISHED_STATUSES: AppointmentStatus[] = [AppointmentStatus.COMPLETED, AppointmentStatus.READY_FOR_OCULAR];

/**
 * True when the appointment still takes its sales staff's time. Cancelled and no-show give it back
 * at once. A finished consultation does too, so a consultation closed early (e.g. Customer
 * Declined) makes its hour vacant again (user decision 2026-11-27). A finished ocular visit keeps
 * the staff busy until the trip back ends, because they are still on the road.
 */
export function holdsStaffTime(
  appointment: ScheduledVisit & { status?: AppointmentStatus | string | null; date?: string | null },
  now: Date = new Date(),
): boolean {
  if (SALES_SLOT_FREEING_STATUSES.includes(appointment.status as AppointmentStatus)) return false;
  if (!FINISHED_STATUSES.includes(appointment.status as AppointmentStatus)) return true;
  if (appointment.type !== AppointmentType.OCULAR) return false;
  const end = staffBusyWindow(appointment)?.end ?? 24 * 60;
  const endsAt = appointment.date ? manilaTimestamp(appointment.date, end) : undefined;
  return endsAt !== undefined && endsAt > now.getTime();
}
