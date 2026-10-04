import { format } from 'date-fns';
import { AppointmentStatus, AppointmentType } from '../../utils/constants.js';

type SearchScope = 'customer' | 'staff';

interface SearchSiteDetails {
  serviceTypes?: string[];
  serviceTypeCustom?: string;
  notes?: string;
  customerRequirements?: string;
  materials?: string;
  finishes?: string;
  preferredDesign?: string;
}

interface SearchProjectRef {
  projectNumber?: string;
  title?: string;
  serviceType?: string;
}

interface SearchAppointmentInput {
  appointmentNumber?: string;
  type?: string;
  status?: string;
  consultationReportSubmitted?: boolean;
  date?: string;
  slotCode?: string;
  customerNotes?: string;
  internalNotes?: string;
  formattedAddress?: string;
  customerAddress?: string;
  serviceTypes?: string[];
  serviceTypeCustom?: string;
  customerSiteDetails?: SearchSiteDetails;
  customerName?: string;
  customerNumber?: string;
  salesStaffName?: string;
  linkedProjects?: SearchProjectRef[];
}

const APPOINTMENT_STATUS_LABELS: Record<string, string[]> = {
  [AppointmentStatus.REQUESTED]: ['requested'],
  [AppointmentStatus.CONFIRMED]: ['confirmed'],
  [AppointmentStatus.PREPARING]: ['preparing'],
  [AppointmentStatus.ON_THE_WAY]: ['on the way'],
  [AppointmentStatus.READY_FOR_OCULAR]: ['ready for ocular'],
  [AppointmentStatus.COMPLETED]: ['completed'],
  [AppointmentStatus.CANCELLED]: ['cancelled'],
  [AppointmentStatus.NO_SHOW]: ['no show'],
  [AppointmentStatus.RESCHEDULE_REQUESTED]: ['reschedule requested', 'reschedule'],
};

const APPOINTMENT_TYPE_ALIASES: Record<string, string[]> = {
  [AppointmentType.OFFICE]: ['office', 'consultation'],
  [AppointmentType.OCULAR]: ['ocular', 'ocular visit'],
};

function normalizeForSearch(value?: string | null): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function labelize(value?: string | null): string {
  const normalized = normalizeForSearch(value);
  return normalized;
}

function formatSlotTimeForSearch(slotCode?: string | null) {
  if (!slotCode) return '';
  const [hourRaw, minuteRaw] = slotCode.split(':').map(Number);
  const hour = Number.isFinite(hourRaw) ? hourRaw : 0;
  const minute = Number.isFinite(minuteRaw) ? minuteRaw : 0;
  const suffix = hour >= 12 ? 'pm' : 'am';
  const hour12 = hour % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function formatDateTokens(dateStr?: string | null): string[] {
  if (!dateStr) return [];
  const parsed = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return [dateStr];
  return [
    dateStr,
    format(parsed, 'MMMM d yyyy'),
    format(parsed, 'MMMM d, yyyy'),
    format(parsed, 'MMM d yyyy'),
    format(parsed, 'MMM d, yyyy'),
    format(parsed, 'EEEE MMMM d yyyy'),
  ];
}

function collectStatusTerms(appointment: SearchAppointmentInput): string[] {
  return APPOINTMENT_STATUS_LABELS[appointment.status || ''] || [labelize(appointment.status)];
}

export function normalizeAppointmentSearchTerm(term?: string | null): string {
  return normalizeForSearch(term);
}

export function matchesAppointmentSearch(
  appointment: SearchAppointmentInput,
  rawTerm: string | null | undefined,
  scope: SearchScope,
) {
  const normalizedTerm = normalizeAppointmentSearchTerm(rawTerm);
  if (!normalizedTerm) return true;

  const linkedProjects = appointment.linkedProjects || [];
  const searchableParts = [
    appointment.appointmentNumber,
    ...collectStatusTerms(appointment),
    ...(APPOINTMENT_TYPE_ALIASES[appointment.type || ''] || [labelize(appointment.type)]),
    ...formatDateTokens(appointment.date),
    appointment.slotCode,
    formatSlotTimeForSearch(appointment.slotCode),
    appointment.customerNotes,
    appointment.internalNotes,
    appointment.formattedAddress,
    appointment.customerAddress,
    ...(appointment.serviceTypes || []),
    ...(appointment.serviceTypes || []).map(labelize),
    appointment.serviceTypeCustom,
    ...(appointment.customerSiteDetails?.serviceTypes || []),
    ...(appointment.customerSiteDetails?.serviceTypes || []).map(labelize),
    appointment.customerSiteDetails?.serviceTypeCustom,
    appointment.customerSiteDetails?.notes,
    appointment.customerSiteDetails?.customerRequirements,
    appointment.customerSiteDetails?.materials,
    appointment.customerSiteDetails?.finishes,
    appointment.customerSiteDetails?.preferredDesign,
  ];

  if (scope === 'staff') {
    searchableParts.push(
      appointment.customerName,
      appointment.customerNumber,
      appointment.salesStaffName,
      ...linkedProjects.flatMap((project) => [
        project.projectNumber,
        project.title,
        project.serviceType,
        labelize(project.serviceType),
      ]),
    );
  }

  const haystack = normalizeForSearch(searchableParts.filter(Boolean).join(' '));
  const tokens = normalizedTerm.split(' ').filter(Boolean);
  return tokens.every((token) => haystack.includes(token));
}
