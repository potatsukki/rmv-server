import {
  VisitReport, Appointment, Project, ProjectItem, User, AuditLog, SlotLock,
} from '../../models/index.js';
import { VisitReportStatus } from '../../models/VisitReport.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import {
  AppointmentStatus, AppointmentType, AppointmentAttendanceStatus, ContractStatus, ProjectStatus, Role, AuditAction, NotificationCategory,
  ServiceType,
} from '../../utils/constants.js';
import { visitReportStateMachine, appointmentStateMachine } from '../../utils/stateMachine.js';
import { generateProjectNumber } from '../../utils/projectNumber.js';
import { createAndSendNotification, notifyRole } from '../notifications/socket.service.js';
import type { CreateVisitReportInput, UpdateVisitReportInput, ReturnVisitReportInput, ReopenVisitReportInput } from './visit-reports.validation.js';
import type { Types } from 'mongoose';
import { resolveOcularVisitData } from '../appointments/appointments.service.js';

import type { ICustomerSiteDetails } from '../../models/Appointment.js';
import type { UserAddressInput } from '../../utils/userAddresses.js';
import { normalizeUserAddress, requirePinnedAddress } from '../../utils/userAddresses.js';

function isNonEmptyString(value?: string | null) {
  return Boolean(value?.trim());
}

function hasSpecificationData(specifications?: {
  measurements?: Record<string, string | number | boolean>;
  siteConditions?: Record<string, string | number | boolean>;
  materialsDesign?: Record<string, string | number | boolean>;
  additional?: Record<string, string | number | boolean>;
}, section?: 'measurements' | 'siteConditions' | 'materialsDesign' | 'additional') {
  if (!specifications) return false;
  if (section) {
    const target = specifications[section];
    return Boolean(target && Object.values(target).some((value) => {
      if (typeof value === 'string') return value.trim().length > 0;
      if (typeof value === 'number') return Number.isFinite(value);
      return value === true;
    }));
  }
  return ['measurements', 'siteConditions', 'materialsDesign', 'additional']
    .some((key) => {
      const target = specifications[key as keyof typeof specifications];
      return Boolean(target && Object.values(target).some((value) => {
        if (typeof value === 'string') return value.trim().length > 0;
        if (typeof value === 'number') return Number.isFinite(value);
        return value === true;
      }));
    });
}

function readableServiceTitle(serviceType?: string, custom?: string) {
  if (serviceType === ServiceType.CUSTOM && custom?.trim()) return custom.trim();
  return (serviceType || ServiceType.CUSTOM)
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getAddressStructured(address: UserAddressInput) {
  return {
    street: address.street || '',
    barangay: address.barangay || '',
    city: address.city || '',
    province: address.province || '',
    zip: address.zip || '',
  };
}

function getVisitReportProjectSiteAddress(appt: any, report: any) {
  return appt.formattedAddress
    || appt.customerAddress
    || report.recommendedOcularAddress?.formattedAddress
    || report.recommendedOcularAddress?.address
    || '';
}

async function applyRecommendedOcularAddress(appointment: any, addressInput: UserAddressInput) {
  requirePinnedAddress(addressInput);
  const address = normalizeUserAddress(addressInput, addressInput.label || 'Ocular site');
  const ocularVisitData = await resolveOcularVisitData(
    AppointmentType.OCULAR,
    address.formattedAddress,
    { lat: address.lat!, lng: address.lng! },
  );
  if (!ocularVisitData) throw AppError.badRequest('Could not compute ocular visit data');

  appointment.latitude = ocularVisitData.latitude;
  appointment.longitude = ocularVisitData.longitude;
  appointment.formattedAddress = ocularVisitData.formattedAddress;
  appointment.customerAddress = ocularVisitData.formattedAddress;
  appointment.customerLocation = ocularVisitData.customerLocation;
  appointment.distanceKm = ocularVisitData.distanceKm;
  appointment.ocularFee = ocularVisitData.ocularFee;
  appointment.ocularFeeBreakdown = ocularVisitData.ocularFeeBreakdown;
  appointment.addressStructured = getAddressStructured(address);

  if (!ocularVisitData.ocularFeeBreakdown.isWithinNCR && ocularVisitData.ocularFee > 0) {
    appointment.ocularFeeStatus = 'pending';
    appointment.ocularFeePaid = false;
  } else if (!appointment.ocularFeePaid) {
    appointment.ocularFeeStatus = undefined;
  }

  return { address, ocularVisitData };
}

async function getRelatedOcularAppointmentForConsultation(report: any) {
  if (
    report.visitType !== 'consultation'
    || report.consultationOutcome !== 'schedule_ocular'
    || !report.recommendedOcularDate
    || !report.recommendedOcularSlot
  ) {
    return null;
  }

  const customerId = (report.customerId as any)?._id || report.customerId;
  const recommendedOcularDate = report.recommendedOcularDate.toISOString().split('T')[0];

  return Appointment.findOne({
    customerId,
    type: AppointmentType.OCULAR,
    date: recommendedOcularDate,
    slotCode: report.recommendedOcularSlot,
    status: { $nin: [AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW] },
  })
    .select('_id status customerLocation formattedAddress customerAddress distanceKm ocularFee ocularFeeBreakdown ocularFeePaid ocularFeeStatus ocularFeePaymentChoice date slotCode')
    .lean();
}

async function upsertProjectItemFromVisitReport(project: any, report: any) {
  const mediaKeys = [
    ...(report.photoKeys || []),
    ...(report.sketchKeys || []),
    ...(report.referenceImageKeys || []),
  ];

  const item = await ProjectItem.findOneAndUpdate(
    { projectId: project._id, serviceType: report.serviceType },
    {
      $set: {
        projectId: project._id,
        appointmentId: project.appointmentId,
        title: readableServiceTitle(report.serviceType, report.serviceTypeCustom),
        serviceType: report.serviceType,
        serviceTypeCustom: report.serviceTypeCustom,
        measurements: report.measurements,
        measurementUnit: report.measurementUnit,
        lineItems: report.lineItems || [],
        materials: report.materials,
        finishes: report.finishes,
        preferredDesign: report.preferredDesign,
        specifications: report.specifications,
        customerRequirements: report.customerRequirements,
        notes: report.notes,
        initialDesignKeys: report.initialDesignKeys || [],
        initialDesignNotes: report.initialDesignNotes,
        selectedDesignTemplateId: report.selectedDesignTemplateId,
        selectedDesignTemplateName: report.selectedDesignTemplateName,
        selectedDesignTemplateImageUrl: report.selectedDesignTemplateImageUrl,
        mediaKeys,
        ...(report.visitType === 'ocular'
          ? { ocularVisitReportId: report._id }
          : { consultationVisitReportId: report._id }),
      },
      $setOnInsert: {
        status: project.status || ProjectStatus.DRAFT,
      },
    },
    { upsert: true, new: true },
  );

  if (!report.projectItemId || report.projectItemId.toString() !== item._id.toString()) {
    report.projectItemId = item._id;
    report.linkedProjectId = project._id;
    await report.save();
  }

  return item;
}

function getInitialReportServiceTypes(
  customerSiteDetails?: ICustomerSiteDetails,
  serviceTypesOverride?: string[],
  serviceTypeOverride?: string,
) {
  const rawServiceTypes = serviceTypesOverride?.length
      ? serviceTypesOverride
    : serviceTypeOverride
      ? [serviceTypeOverride]
    : customerSiteDetails?.serviceTypes?.length
      ? customerSiteDetails.serviceTypes
      : [ServiceType.CUSTOM];

  return [...new Set(rawServiceTypes.filter((value): value is string => isNonEmptyString(value)))];
}

function serviceTypeSet(values?: string[]) {
  return new Set((values || []).map((value) => String(value).trim()).filter(Boolean));
}

function sameServiceTypes(a?: string[], b?: string[]) {
  const left = serviceTypeSet(a);
  const right = serviceTypeSet(b);
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

async function getAppointmentVisitReportServiceTypes(appointmentId: Types.ObjectId | string) {
  const appointment = await Appointment.findById(appointmentId)
    .select('serviceTypes serviceType')
    .lean();
  const appointmentServiceTypes = getInitialReportServiceTypes(
    undefined,
    appointment?.serviceTypes,
    (appointment as any)?.serviceType,
  ).filter((serviceType) => serviceType !== ServiceType.CUSTOM);

  if (appointmentServiceTypes.length > 0) {
    return appointmentServiceTypes;
  }

  const reports = await VisitReport.find({ appointmentId, visitType: 'consultation' })
    .select('serviceType')
    .lean();
  return [...new Set(
    reports
      .map((report) => report.serviceType)
      .filter((value): value is string => isNonEmptyString(value)),
  )];
}

function isEmptyDraftReport(report: any) {
  return !hasReportValue(report.lineItems)
    && !hasReportValue(report.measurements)
    && !hasReportValue(report.siteConditions)
    && !hasReportValue(report.materials)
    && !hasReportValue(report.finishes)
    && !hasReportValue(report.preferredDesign)
    && !hasReportValue(report.customerRequirements)
    && !hasReportValue(report.notes)
    && !hasReportValue(report.specifications)
    && !hasReportValue(report.discussionNotes)
    && !hasReportValue(report.initialDesignKeys)
    && !hasReportValue(report.initialDesignNotes)
    && !hasReportValue(report.selectedDesignTemplateId)
    && !hasReportValue(report.selectedDesignTemplateName)
    && !hasReportValue(report.selectedDesignTemplateImageUrl)
    && !hasReportValue(report.photoKeys)
    && !hasReportValue(report.videoKeys)
    && !hasReportValue(report.sketchKeys)
    && !hasReportValue(report.referenceImageKeys);
}

async function ensureAppointmentServiceTypeReports(
  appointmentId: Types.ObjectId | string,
  customerId: Types.ObjectId | string,
  salesStaffId: Types.ObjectId | string,
  visitType: string,
  customerSiteDetails?: ICustomerSiteDetails,
  serviceTypesOverride?: string[],
  serviceTypeOverride?: string,
  serviceTypeCustomOverride?: string,
  linkedProjectId?: Types.ObjectId | string,
  preferredReportId?: Types.ObjectId | string,
) {
  const requestedServiceTypes = getInitialReportServiceTypes(
    customerSiteDetails,
    serviceTypesOverride,
    serviceTypeOverride,
  );
  const customServiceTypeLabel = customerSiteDetails?.serviceTypeCustom || serviceTypeCustomOverride;

  if (visitType === 'ocular') {
    const ocularAppointment = await Appointment.findById(appointmentId)
      .select('sourceConsultationAppointmentId')
      .lean();
    const sourceConsultationAppointmentId = ocularAppointment?.sourceConsultationAppointmentId;
    await promoteConsultationReportsToOcularAppointment(
      appointmentId,
      sourceConsultationAppointmentId || appointmentId,
      customerId,
      salesStaffId,
      requestedServiceTypes,
      linkedProjectId,
      preferredReportId,
    );
  }

  const existingReports = await VisitReport.find({ appointmentId }).sort({ createdAt: 1 });
  if (requestedServiceTypes.length > 0 && !requestedServiceTypes.includes(ServiceType.CUSTOM)) {
    const placeholderReport = existingReports.find((report) => report.serviceType === ServiceType.CUSTOM);
    if (placeholderReport && !existingReports.some((report) => report.serviceType === requestedServiceTypes[0])) {
      placeholderReport.serviceType = requestedServiceTypes[0];
      placeholderReport.serviceTypeCustom = undefined;
      await placeholderReport.save();
    }
  }

  // Keep manually added report items even when they are not part of the original
  // appointment service list. This prevents add-item regressions where new
  // selections (e.g. Gates/Fences) disappear on the next sync/refetch.

  const existingServiceTypes = new Set(existingReports.map((report) => report.serviceType));
  const missingServiceTypes = requestedServiceTypes.filter((serviceType) => !existingServiceTypes.has(serviceType));

  for (const report of existingReports) {
    if (report.status !== VisitReportStatus.DRAFT) {
      continue;
    }

    let changed = false;

    if (linkedProjectId && !report.linkedProjectId) {
      report.linkedProjectId = linkedProjectId as Types.ObjectId;
      changed = true;
    }

    if (report.serviceType === ServiceType.CUSTOM && customServiceTypeLabel && report.serviceTypeCustom !== customServiceTypeLabel) {
      report.serviceTypeCustom = customServiceTypeLabel;
      changed = true;
    }

    if (customerSiteDetails) {
      if (customerSiteDetails.materials && report.materials !== customerSiteDetails.materials) {
        report.materials = customerSiteDetails.materials;
        changed = true;
      }
      if (customerSiteDetails.finishes && report.finishes !== customerSiteDetails.finishes) {
        report.finishes = customerSiteDetails.finishes;
        changed = true;
      }
      if (customerSiteDetails.preferredDesign && report.preferredDesign !== customerSiteDetails.preferredDesign) {
        report.preferredDesign = customerSiteDetails.preferredDesign;
        changed = true;
      }
      if (customerSiteDetails.customerRequirements && report.customerRequirements !== customerSiteDetails.customerRequirements) {
        report.customerRequirements = customerSiteDetails.customerRequirements;
        changed = true;
      }
      if (customerSiteDetails.notes && report.notes !== customerSiteDetails.notes) {
        report.notes = customerSiteDetails.notes;
        changed = true;
      }
      if (customerSiteDetails.measurementUnit && report.measurementUnit !== customerSiteDetails.measurementUnit) {
        report.measurementUnit = customerSiteDetails.measurementUnit;
        changed = true;
      }
      if ((report.lineItems?.length || 0) === 0 && (customerSiteDetails.lineItems?.length || 0) > 0) {
        report.lineItems = customerSiteDetails.lineItems || [];
        changed = true;
      }
      if (!report.siteConditions && customerSiteDetails.siteConditions) {
        report.siteConditions = customerSiteDetails.siteConditions;
        changed = true;
      }
      if ((report.photoKeys?.length || 0) === 0 && (customerSiteDetails.photoKeys?.length || 0) > 0) {
        report.photoKeys = customerSiteDetails.photoKeys || [];
        changed = true;
      }
      if ((report.videoKeys?.length || 0) === 0 && (customerSiteDetails.videoKeys?.length || 0) > 0) {
        report.videoKeys = customerSiteDetails.videoKeys || [];
        changed = true;
      }
      if ((report.sketchKeys?.length || 0) === 0 && (customerSiteDetails.sketchKeys?.length || 0) > 0) {
        report.sketchKeys = customerSiteDetails.sketchKeys || [];
        changed = true;
      }
      if ((report.referenceImageKeys?.length || 0) === 0 && (customerSiteDetails.referenceImageKeys?.length || 0) > 0) {
        report.referenceImageKeys = customerSiteDetails.referenceImageKeys || [];
        changed = true;
      }
    }

    if (changed) {
      await report.save();
    }
  }

  for (const serviceType of missingServiceTypes) {
    const report = await VisitReport.create({
      appointmentId,
      customerId,
      salesStaffId,
      status: VisitReportStatus.DRAFT,
      visitType,
      ...(linkedProjectId && { linkedProjectId }),
      serviceType,
      serviceTypeCustom: serviceType === ServiceType.CUSTOM ? customServiceTypeLabel : undefined,
      measurementUnit: customerSiteDetails?.measurementUnit,
      lineItems: customerSiteDetails?.lineItems || [],
      siteConditions: customerSiteDetails?.siteConditions,
      materials: customerSiteDetails?.materials,
      finishes: customerSiteDetails?.finishes,
      preferredDesign: customerSiteDetails?.preferredDesign,
      customerRequirements: customerSiteDetails?.customerRequirements,
      notes: customerSiteDetails?.notes,
      photoKeys: customerSiteDetails?.photoKeys || [],
      videoKeys: customerSiteDetails?.videoKeys || [],
      sketchKeys: customerSiteDetails?.sketchKeys || [],
      referenceImageKeys: customerSiteDetails?.referenceImageKeys || [],
    });

    await AuditLog.create({
      action: AuditAction.VISIT_REPORT_CREATED,
      actorId: salesStaffId.toString(),
      targetType: 'visit_report',
      targetId: report._id,
      details: {
        appointmentId: appointmentId.toString(),
        autoCreated: true,
        serviceType,
      },
    });
  }
}

const reportCarryOverFields = [
  'measurementUnit',
  'lineItems',
  'measurements',
  'siteConditions',
  'materials',
  'finishes',
  'preferredDesign',
  'customerRequirements',
  'notes',
  'specifications',
  'discussionNotes',
  'initialDesignKeys',
  'initialDesignNotes',
  'selectedDesignTemplateId',
  'selectedDesignTemplateName',
  'selectedDesignTemplateImageUrl',
  'photoKeys',
  'videoKeys',
  'sketchKeys',
  'referenceImageKeys',
] as const;

function hasReportValue(value: unknown) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return value !== undefined && value !== null;
}

function mergeReportContent(target: any, source: any) {
  for (const field of reportCarryOverFields) {
    const current = target[field];
    const incoming = source[field];
    if (!hasReportValue(current) && hasReportValue(incoming)) {
      target[field] = incoming;
    }
  }
}

function reportCreatedTime(report: any) {
  return new Date(report.createdAt || 0).getTime();
}

function reportUpdatedTime(report: any) {
  return new Date(report.updatedAt || report.createdAt || 0).getTime();
}

function reportHasUserData(report: any) {
  return !isEmptyDraftReport(report);
}

function getMergeConflictFields(target: any, source: any) {
  const conflicts: string[] = [];
  for (const field of reportCarryOverFields) {
    const current = target[field];
    const incoming = source[field];
    if (!hasReportValue(current) || !hasReportValue(incoming)) {
      continue;
    }
    if (JSON.stringify(current) !== JSON.stringify(incoming)) {
      conflicts.push(field);
    }
  }
  return conflicts;
}

function pickCanonicalLifecycleReport(reports: any[]) {
  const sourceWithData = reports
    .filter((report) => report.visitType === 'consultation' && reportHasUserData(report))
    .sort((a, b) => reportCreatedTime(a) - reportCreatedTime(b))[0];
  if (sourceWithData) return sourceWithData;

  const anyWithData = reports
    .filter(reportHasUserData)
    .sort((a, b) => reportCreatedTime(a) - reportCreatedTime(b))[0];
  if (anyWithData) return anyWithData;

  const sourceEmpty = reports
    .filter((report) => report.visitType === 'consultation')
    .sort((a, b) => reportCreatedTime(a) - reportCreatedTime(b))[0];
  if (sourceEmpty) return sourceEmpty;

  return reports.sort((a, b) => reportCreatedTime(a) - reportCreatedTime(b))[0];
}

async function transitionConsultationReportsToOcularAppointment(
  ocularAppointmentId: Types.ObjectId | string,
  sourceConsultationAppointmentId: Types.ObjectId | string,
  customerId: Types.ObjectId | string,
  salesStaffId: Types.ObjectId | string,
  requestedServiceTypes: string[],
  linkedProjectId?: Types.ObjectId | string,
  preferredReportId?: Types.ObjectId | string,
) {
  const serviceTypeFilter = requestedServiceTypes.length > 0
    ? { serviceType: { $in: requestedServiceTypes } }
    : {};

  const sourceFilter: Record<string, unknown> = {
    customerId,
    salesStaffId,
    visitType: 'consultation',
    status: {
      $in: [
        VisitReportStatus.DRAFT,
        VisitReportStatus.RETURNED,
        VisitReportStatus.SUBMITTED,
        VisitReportStatus.COMPLETED,
      ],
    },
    appointmentId: sourceConsultationAppointmentId,
    ...serviceTypeFilter,
  };

  if (linkedProjectId) {
    sourceFilter.$or = [
      { linkedProjectId },
      { linkedProjectId: { $exists: false } },
      { linkedProjectId: null },
    ];
  }

  const [sourceReports, existingOcularReports] = await Promise.all([
    VisitReport.find(sourceFilter).sort({ createdAt: 1 }),
    VisitReport.find({
    appointmentId: ocularAppointmentId,
    visitType: 'ocular',
    ...serviceTypeFilter,
    }).sort({ createdAt: 1 }),
  ]);

  if (sourceReports.length === 0 && existingOcularReports.length === 0) return [];

  const requestedSet = requestedServiceTypes.length > 0 ? new Set(requestedServiceTypes) : null;
  const serviceTypes = [...new Set([...sourceReports, ...existingOcularReports]
    .map((report) => report.serviceType)
    .filter((serviceType) => serviceType && (!requestedSet || requestedSet.has(serviceType))))];
  const canonicalReports: any[] = [];

  for (const serviceType of serviceTypes) {
    const candidates = [...sourceReports, ...existingOcularReports]
      .filter((report) => report.serviceType === serviceType);
    if (candidates.length === 0) continue;

    const canonical = preferredReportId
      ? candidates.find((report) => report._id.toString() === preferredReportId.toString()) || pickCanonicalLifecycleReport(candidates)
      : pickCanonicalLifecycleReport(candidates);
    const duplicates = candidates.filter((report) => report._id.toString() !== canonical._id.toString());
    const conflictFields = new Set<string>();

    for (const duplicate of duplicates) {
      for (const field of getMergeConflictFields(canonical, duplicate)) {
        conflictFields.add(field);
      }
      mergeReportContent(canonical, duplicate);
      await VisitReport.deleteOne({ _id: duplicate._id });
    }

    canonical.appointmentId = ocularAppointmentId as Types.ObjectId;
    canonical.visitType = 'ocular';
    canonical.status = VisitReportStatus.DRAFT;
    if (linkedProjectId && !canonical.linkedProjectId) {
      canonical.linkedProjectId = linkedProjectId as Types.ObjectId;
    }
    await canonical.save();
    canonicalReports.push(canonical);

    await AuditLog.create({
      action: AuditAction.VISIT_REPORT_CREATED,
      actorId: salesStaffId.toString(),
      targetType: 'visit_report',
      targetId: canonical._id,
      details: {
        appointmentId: ocularAppointmentId.toString(),
        transitionedFromConsultation: true,
        sourceConsultationAppointmentId: sourceConsultationAppointmentId.toString(),
        serviceType,
        duplicateIdsRemoved: duplicates.map((duplicate) => duplicate._id.toString()),
        ...(conflictFields.size > 0 && { mergeConflictFields: [...conflictFields] }),
      },
    });
  }

  return canonicalReports;
}

async function promoteConsultationReportsToOcularAppointment(
  ocularAppointmentId: Types.ObjectId | string,
  sourceConsultationAppointmentId: Types.ObjectId | string,
  customerId: Types.ObjectId | string,
  salesStaffId: Types.ObjectId | string,
  requestedServiceTypes: string[],
  linkedProjectId?: Types.ObjectId | string,
  preferredReportId?: Types.ObjectId | string,
) {
  return transitionConsultationReportsToOcularAppointment(
    ocularAppointmentId,
    sourceConsultationAppointmentId,
    customerId,
    salesStaffId,
    requestedServiceTypes,
    linkedProjectId,
    preferredReportId,
  );
}

const ACTIVE_OCULAR_REPORT_APPOINTMENT_STATUSES = [
  AppointmentStatus.REQUESTED,
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.PREPARING,
  AppointmentStatus.ON_THE_WAY,
  AppointmentStatus.ARRIVED_AT_SITE,
  AppointmentStatus.IN_PROGRESS,
  AppointmentStatus.RESCHEDULE_REQUESTED,
  AppointmentStatus.READY_FOR_OCULAR,
] as const;

function serviceSetKey(appointment: any) {
  const sourceKey = appointment.sourceConsultationAppointmentId
    ? appointment.sourceConsultationAppointmentId.toString()
    : 'no-source';
  const serviceTypes = appointment.serviceTypes?.length
    ? appointment.serviceTypes
    : appointment.customerSiteDetails?.serviceTypes || [];

  const itemKey = serviceTypes
    .map((serviceType: string) => String(serviceType).trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join('|') || 'custom';

  return `${sourceKey}::${itemKey}`;
}

async function getCanonicalActiveOcularAppointmentsForSalesStaff(salesStaffId: string) {
  const activeOcularAppointments = await Appointment.find({
    salesStaffId,
    type: AppointmentType.OCULAR,
    status: { $in: ACTIVE_OCULAR_REPORT_APPOINTMENT_STATUSES },
  })
    .select('_id customerId salesStaffId serviceTypes serviceTypeCustom customerSiteDetails sourceConsultationAppointmentId updatedAt createdAt')
    .sort({ updatedAt: -1, createdAt: -1 });

  const canonicalByCustomerAndItems = new Map<string, any>();
  const staleIds: Types.ObjectId[] = [];

  for (const appointment of activeOcularAppointments) {
    const key = `${appointment.customerId.toString()}::${serviceSetKey(appointment)}`;
    if (canonicalByCustomerAndItems.has(key)) {
      staleIds.push(appointment._id);
    } else {
      canonicalByCustomerAndItems.set(key, appointment);
    }
  }

  return {
    canonicalAppointments: [...canonicalByCustomerAndItems.values()],
    staleIds,
  };
}

async function getCanonicalActiveOcularAppointment(appointment: any) {
  if (
    appointment.type !== AppointmentType.OCULAR
    || !ACTIVE_OCULAR_REPORT_APPOINTMENT_STATUSES.includes(appointment.status)
    || !appointment.salesStaffId
  ) {
    return null;
  }

  const candidates = await Appointment.find({
    customerId: appointment.customerId,
    salesStaffId: appointment.salesStaffId,
    type: AppointmentType.OCULAR,
    status: { $in: ACTIVE_OCULAR_REPORT_APPOINTMENT_STATUSES },
  })
    .select('_id customerId salesStaffId serviceTypes serviceTypeCustom customerSiteDetails sourceConsultationAppointmentId updatedAt createdAt')
    .sort({ updatedAt: -1, createdAt: -1 });

  const targetKey = serviceSetKey(appointment);
  return candidates.find((candidate) => serviceSetKey(candidate) === targetKey) || null;
}

function hasAnyMeasuredDimensions(report: {
  lineItems?: Array<{
    length?: number;
    width?: number;
    height?: number;
    area?: number;
    thickness?: number;
  }>;
  measurements?: {
    length?: number;
    width?: number;
    height?: number;
    area?: number;
    thickness?: number;
    raw?: string;
  };
}) {
  const hasLineItemMeasurements = Boolean(
    report.lineItems?.some((item) =>
      item.length != null ||
      item.width != null ||
      item.height != null ||
      item.area != null ||
      item.thickness != null,
    ),
  );

  const legacy = report.measurements;
  const hasLegacyMeasurements = Boolean(
    legacy && (
      legacy.length != null ||
      legacy.width != null ||
      legacy.height != null ||
      legacy.area != null ||
      legacy.thickness != null ||
      legacy.raw?.trim()
    ),
  );

  return hasLineItemMeasurements || hasLegacyMeasurements;
}

function getIncompleteOcularFields(report: {
  actualVisitDateTime?: Date | string | null;
  lineItems?: Array<{
    label?: string;
    length?: number;
    width?: number;
    height?: number;
    area?: number;
    thickness?: number;
    quantity?: number;
    notes?: string;
  }>;
  measurements?: {
    length?: number;
    width?: number;
    height?: number;
    area?: number;
    thickness?: number;
    raw?: string;
  };
  siteConditions?: {
    environment?: string;
    floorType?: string;
    wallMaterial?: string;
    hasElectrical?: boolean;
    hasPlumbing?: boolean;
    accessNotes?: string;
    obstaclesOrConstraints?: string;
  };
  materials?: string;
  finishes?: string;
  preferredDesign?: string;
  photoKeys?: string[];
  initialDesignKeys?: string[];
  initialDesignNotes?: string;
  selectedDesignTemplateImageUrl?: string;
}) {
  const missing: string[] = [];

  if (!report.actualVisitDateTime) {
    missing.push('actual visit date and time');
  }

  const lineItems = report.lineItems || [];
  if (lineItems.length > 0) {
    lineItems.forEach((item, index) => {
      const isComplete = isNonEmptyString(item.label)
        && item.quantity != null
        && item.quantity >= 1
        && item.length != null
        && item.width != null
        && item.height != null
        && item.thickness != null
        && item.area != null
        && isNonEmptyString(item.notes);

      if (!isComplete) {
        missing.push(`complete measurement details for line item ${index + 1}`);
      }
    });
  } else {
    const legacy = report.measurements;
    const hasCompleteLegacyMeasurements = Boolean(
      legacy
      && legacy.length != null
      && legacy.width != null
      && legacy.height != null
      && legacy.thickness != null
      && legacy.area != null
      && isNonEmptyString(legacy.raw),
    );

    if (!hasCompleteLegacyMeasurements) {
      missing.push('at least one complete measurement item');
    }
  }

  if (!isNonEmptyString(report.siteConditions?.environment)) missing.push('site environment');
  if (!isNonEmptyString(report.siteConditions?.floorType)) missing.push('floor type');
  if (!isNonEmptyString(report.siteConditions?.wallMaterial)) missing.push('wall material');
  if (!isNonEmptyString(report.siteConditions?.accessNotes)) missing.push('access notes');
  if (!isNonEmptyString(report.siteConditions?.obstaclesOrConstraints)) missing.push('obstacles or constraints');

  if (!isNonEmptyString(report.materials)) missing.push('materials');
  if (!isNonEmptyString(report.finishes)) missing.push('finishes');
  if (!isNonEmptyString(report.preferredDesign)) missing.push('preferred design');
  if ((report.photoKeys?.length || 0) === 0) missing.push('site photos');
  const hasInitialDesignReference = (report.initialDesignKeys?.length || 0) > 0
    || isNonEmptyString(report.selectedDesignTemplateImageUrl);
  if (!hasInitialDesignReference) missing.push('initial design files');
  return [...new Set(missing)];
}

function getIncompleteNoOcularFields(report: {
  title?: string;
  serviceType?: string;
  serviceTypeCustom?: string;
  discussionNotes?: string;
  customerRequirements?: string;
  notes?: string;
  lineItems?: Array<{
    label?: string;
    length?: number;
    width?: number;
    height?: number;
    area?: number;
    thickness?: number;
    quantity?: number;
    notes?: string;
  }>;
  measurements?: {
    length?: number;
    width?: number;
    height?: number;
    area?: number;
    thickness?: number;
    raw?: string;
  };
  materials?: string;
  preferredDesign?: string;
  specifications?: {
    measurements?: Record<string, string | number | boolean>;
    siteConditions?: Record<string, string | number | boolean>;
    materialsDesign?: Record<string, string | number | boolean>;
    additional?: Record<string, string | number | boolean>;
  };
  photoKeys?: string[];
  referenceImageKeys?: string[];
  initialDesignKeys?: string[];
  selectedDesignTemplateImageUrl?: string;
}) {
  const missing: string[] = [];

  const hasServiceDetails = isNonEmptyString(report.title)
    || isNonEmptyString(report.serviceType)
    || isNonEmptyString(report.serviceTypeCustom);
  if (!hasServiceDetails) missing.push('project title or service details');

  const hasDescription = isNonEmptyString(report.discussionNotes)
    || isNonEmptyString(report.customerRequirements)
    || isNonEmptyString(report.notes);
  if (!hasDescription) missing.push('project description or requirement notes');

  if (!hasAnyMeasuredDimensions(report) && !hasSpecificationData(report.specifications, 'measurements')) {
    missing.push('measurements/dimensions');
  }

  if (!isNonEmptyString(report.materials) && !hasSpecificationData(report.specifications, 'materialsDesign')) {
    missing.push('material preference');
  }

  const hasDesignReferences = isNonEmptyString(report.preferredDesign)
    || (report.referenceImageKeys?.length || 0) > 0
    || (report.initialDesignKeys?.length || 0) > 0
    || isNonEmptyString(report.selectedDesignTemplateImageUrl)
    || hasSpecificationData(report.specifications, 'materialsDesign');
  if (!hasDesignReferences) {
    missing.push('design/reference details');
  }

  if ((report.photoKeys?.length || 0) === 0) {
    missing.push('uploaded reference files/images');
  }

  return [...new Set(missing)];
}

async function ensureConsultationDraftProject(
  report: any,
  appt: any,
  salesStaffId: string,
  reason: string,
  ip?: string,
  ua?: string,
) {
  const serviceTypes = await getAppointmentVisitReportServiceTypes(report.appointmentId);
  const serviceLabel = serviceTypes.length > 0
    ? serviceTypes.join(', ')
    : report.serviceTypeCustom || report.serviceType || 'General Fabrication';
  const customerNotes = (appt.customerNotes || '').trim();
  const notesNormalized = customerNotes.toLowerCase();
  const serviceLabelNormalized = serviceLabel.toLowerCase();
  const titleBase = customerNotes && notesNormalized !== serviceLabelNormalized
    ? customerNotes
    : serviceLabel;

  const existingProject = await Project.findOne({
    $or: [
      { appointmentId: report.appointmentId },
      { visitReportId: report._id },
    ],
  });
  if (existingProject) {
    if (!existingProject.contractStatus) {
      existingProject.contractStatus = ContractStatus.MISSING;
    }
    const nextServiceTypes = [...new Set([...(existingProject.serviceTypes || []), ...serviceTypes])];
    existingProject.serviceTypes = nextServiceTypes;
    existingProject.serviceType = nextServiceTypes.length > 0 ? nextServiceTypes.join(', ') : serviceLabel;
    existingProject.title = existingProject.title || titleBase;
    existingProject.mediaKeys = [...new Set([
      ...(existingProject.mediaKeys || []),
      ...report.photoKeys,
      ...report.sketchKeys,
      ...report.referenceImageKeys,
    ])];
    await existingProject.save();

    if (!report.linkedProjectId || report.linkedProjectId.toString() !== existingProject._id.toString()) {
      report.linkedProjectId = existingProject._id;
      await report.save();
    }

    const relatedReports = await VisitReport.find({ appointmentId: report.appointmentId });
    for (const relatedReport of relatedReports) {
      await upsertProjectItemFromVisitReport(existingProject, relatedReport);
    }

    return existingProject;
  }

  const project = await Project.create({
    projectNumber: await generateProjectNumber(),
    appointmentId: report.appointmentId,
    visitReportId: report._id,
    customerId: report.customerId,
    salesStaffId: report.salesStaffId,
    title: titleBase,
    serviceType: serviceLabel,
    serviceTypes,
    description: report.customerRequirements || report.notes || 'Created from consultation',
    siteAddress: getVisitReportProjectSiteAddress(appt, report),
    measurements: report.measurements,
    materialType: report.materials,
    finishColor: report.finishes,
    quantity: 1,
    notes: report.notes,
    designReviewStatus: 'not_required',
    status: ProjectStatus.DRAFT,
    contractStatus: ContractStatus.MISSING,
    mediaKeys: [...report.photoKeys, ...report.sketchKeys, ...report.referenceImageKeys],
  });

  if (!report.linkedProjectId || report.linkedProjectId.toString() !== project._id.toString()) {
    report.linkedProjectId = project._id;
    await report.save();
  }

  const relatedReports = await VisitReport.find({ appointmentId: report.appointmentId });
  for (const relatedReport of relatedReports) {
    await upsertProjectItemFromVisitReport(project, relatedReport);
  }

  await AuditLog.create({
    action: AuditAction.PROJECT_CREATED,
    actorId: salesStaffId,
    targetType: 'project',
    targetId: project._id,
    details: { triggeredBy: 'system', reason, visitReportId: report._id },
    ipAddress: ip,
    userAgent: ua,
  });

  return project;
}

async function notifySalesContractUploadRequired(project: any, serviceLabel: string, reason: string) {
  await notifyRole(
    Role.ADMIN,
    NotificationCategory.PROJECT,
    'Signed Contract Required',
    `Project "${serviceLabel}" is ready for signed contract upload before engineering can claim it. ${reason}`,
    `/projects/${project._id}/contract`,
  );

  await createAndSendNotification(
    project.salesStaffId,
    NotificationCategory.PROJECT,
    'Upload Signed Contract',
    `Upload the manually signed contract for "${serviceLabel}" so engineering can claim the project.`,
    `/projects/${project._id}/contract`,
  );
}

async function submitSiblingConsultationReports(
  sourceReport: any,
  _appt: any,
  salesStaffId: string,
  ip?: string,
  ua?: string,
) {
  const siblingReports = await VisitReport.find({
    appointmentId: sourceReport.appointmentId,
    visitType: 'consultation',
    salesStaffId,
    _id: { $ne: sourceReport._id },
    status: { $in: [VisitReportStatus.DRAFT, VisitReportStatus.RETURNED] },
  });

  for (const sibling of siblingReports) {
    if (sourceReport.consultationOutcome === 'no_ocular') {
      sibling.recommendedOcularDate = undefined;
      sibling.recommendedOcularSlot = undefined;
      sibling.recommendedOcularAddressId = undefined;
      sibling.recommendedOcularAddress = undefined;
    } else {
      if (!sibling.recommendedOcularDate && sourceReport.recommendedOcularDate) {
        sibling.recommendedOcularDate = sourceReport.recommendedOcularDate;
      }
      if (!sibling.recommendedOcularSlot && sourceReport.recommendedOcularSlot) {
        sibling.recommendedOcularSlot = sourceReport.recommendedOcularSlot;
      }
      if (!sibling.recommendedOcularAddressId && sourceReport.recommendedOcularAddressId) {
        sibling.recommendedOcularAddressId = sourceReport.recommendedOcularAddressId;
      }
      if (!sibling.recommendedOcularAddress && sourceReport.recommendedOcularAddress) {
        sibling.recommendedOcularAddress = sourceReport.recommendedOcularAddress;
      }
    }
    if (!sibling.actualVisitDateTime && sourceReport.actualVisitDateTime) {
      sibling.actualVisitDateTime = sourceReport.actualVisitDateTime;
    }
    if (sourceReport.consultationOutcome) {
      sibling.consultationOutcome = sourceReport.consultationOutcome;
    }
    if (sourceReport.consultationOutcome === 'no_ocular') {
      sibling.noOcularReason = sourceReport.noOcularReason;
    } else {
      sibling.noOcularReason = undefined;
    }

    visitReportStateMachine.assertTransition(sibling.status, VisitReportStatus.SUBMITTED);
    sibling.status = VisitReportStatus.SUBMITTED;
    await sibling.save();

    await AuditLog.create({
      action: AuditAction.VISIT_REPORT_SUBMITTED,
      actorId: salesStaffId,
      targetType: 'visit_report',
      targetId: sibling._id,
      details: {
        appointmentId: sourceReport.appointmentId.toString(),
        submittedWith: sourceReport._id.toString(),
      },
      ipAddress: ip,
      userAgent: ua,
    });
  }
}

async function completeOcularAppointmentForReport(appt: any, salesStaffId: string, ip?: string, ua?: string) {
  if (appt.status === AppointmentStatus.COMPLETED) return;

  appointmentStateMachine.assertTransition(appt.status, AppointmentStatus.COMPLETED);
  appt.status = AppointmentStatus.COMPLETED;
  await appt.save();

  if (appt.salesStaffId) {
    await SlotLock.deleteOne({
      date: appt.date,
      slotCode: appt.slotCode,
      salesId: appt.salesStaffId,
    });
  }

  await AuditLog.create({
    action: AuditAction.APPOINTMENT_COMPLETED,
    actorId: salesStaffId,
    targetType: 'appointment',
    targetId: appt._id,
    details: { reason: 'ocular_report_project_created' },
    ipAddress: ip,
    userAgent: ua,
  });
}

/**
 * Build a filter condition that excludes draft reports whose appointment has been cancelled.
 * Returns a condition to merge into the Mongo query.
 */
async function excludeCancelledDrafts(): Promise<Record<string, unknown>> {
  const cancelledIds = await Appointment.find(
    { status: AppointmentStatus.CANCELLED },
    { _id: 1 },
  ).lean();

  if (cancelledIds.length === 0) return {};

  // Exclude drafts tied to cancelled appointments; non-draft reports are preserved.
  return {
    $nor: [
      {
        status: VisitReportStatus.DRAFT,
        appointmentId: { $in: cancelledIds.map((a) => a._id) },
      },
    ],
  };
}

// ── Auto-create Draft (called when Agent confirms appointment) ──
// Creates one initial draft per booked service type. Sales staff can add more via createReport().
// If customerSiteDetails is provided (customer filled in pre-visit info), pre-populate the report.

export async function autoCreateDraft(
  appointmentId: Types.ObjectId | string,
  customerId: Types.ObjectId | string,
  salesStaffId: Types.ObjectId | string,
  visitType: string,
  customerSiteDetails?: ICustomerSiteDetails,
  serviceTypesOverride?: string[],
  serviceTypeOverride?: string,
  serviceTypeCustomOverride?: string,
  linkedProjectId?: Types.ObjectId | string,
): Promise<void> {
  await ensureAppointmentServiceTypeReports(
    appointmentId,
    customerId,
    salesStaffId,
    visitType,
    customerSiteDetails,
    serviceTypesOverride,
    serviceTypeOverride,
    serviceTypeCustomOverride,
    linkedProjectId,
  );
}

// ── Create Report (Sales Staff adds another project/report to an appointment) ──

export async function createReport(
  input: CreateVisitReportInput,
  salesStaffId: string,
  ip?: string,
  ua?: string,
) {
  // Verify the appointment exists and belongs to this sales staff
  const appointment = await Appointment.findById(input.appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (appointment.salesStaffId?.toString() !== salesStaffId) {
    throw AppError.forbidden('You are not assigned to this appointment');
  }

  const inferredVisitType =
    input.visitType
    || (appointment.type === 'ocular' ? 'ocular' : 'consultation');

  const report = await VisitReport.create({
    appointmentId: input.appointmentId,
    customerId: appointment.customerId,
    salesStaffId,
    status: VisitReportStatus.DRAFT,
    visitType: inferredVisitType,
    serviceType: input.serviceType,
    serviceTypeCustom: input.serviceTypeCustom,
    lineItems: [],
    photoKeys: [],
    videoKeys: [],
    sketchKeys: [],
    referenceImageKeys: [],
  });

  await AuditLog.create({
    action: AuditAction.VISIT_REPORT_CREATED,
    actorId: salesStaffId,
    targetType: 'visit_report',
    targetId: report._id,
    details: { appointmentId: input.appointmentId, serviceType: input.serviceType },
    ipAddress: ip,
    userAgent: ua,
  });

  return report;
}

// ── Get by ID ──

function populateVisitReportDetail(query: any) {
  return query
    .populate('customerId', 'firstName lastName email phone')
    .populate('salesStaffId', 'firstName lastName email')
    .populate('appointmentId', 'customerId date slotCode type status customerAddress serviceTypes serviceTypeCustom customerSiteDetails salesStaffId sourceConsultationAppointmentId sourceConsultationReportId attendanceStatus actualArrivalAt consultationStartedAt consultationCompletedAt attendanceNotes attendanceUpdatedAt updatedAt createdAt');
}

async function findFirstVisitReportForAppointment(appointmentId: string) {
  return populateVisitReportDetail(
    VisitReport.findOne({ appointmentId }).sort({ createdAt: 1 }),
  );
}

async function resolveVisitReportFromAppointmentId(appointmentId: string) {
  let report = await findFirstVisitReportForAppointment(appointmentId);
  if (report) return report;

  const appointment = await Appointment.findById(appointmentId)
    .select('customerId salesStaffId type serviceTypes serviceTypeCustom customerSiteDetails sourceConsultationAppointmentId');

  if (!appointment?.salesStaffId) return null;

  await ensureAppointmentServiceTypeReports(
    appointment._id,
    appointment.customerId,
    appointment.salesStaffId,
    appointment.type === AppointmentType.OCULAR ? 'ocular' : 'consultation',
    appointment.customerSiteDetails,
    appointment.serviceTypes,
    appointment.serviceTypes?.[0],
    appointment.serviceTypeCustom,
  );

  return findFirstVisitReportForAppointment(appointmentId);
}

async function resolveVisitReportFromAuditLog(reportId: string) {
  const replacementLog = await AuditLog.findOne({
    targetType: 'visit_report',
    'details.duplicateIdsRemoved': reportId,
  })
    .select('targetId details')
    .sort({ createdAt: -1 })
    .lean();

  if (replacementLog?.targetId) {
    const replacementReport = await populateVisitReportDetail(VisitReport.findById(replacementLog.targetId));
    if (replacementReport) return replacementReport;
  }

  const creationLog = await AuditLog.findOne({
    targetType: 'visit_report',
    targetId: reportId,
    'details.appointmentId': { $exists: true },
  })
    .select('details')
    .sort({ createdAt: -1 })
    .lean();
  const appointmentId = (creationLog?.details as { appointmentId?: unknown } | undefined)?.appointmentId;

  return appointmentId ? findFirstVisitReportForAppointment(String(appointmentId)) : null;
}

export async function getVisitReport(reportId: string) {
  let report: any = await populateVisitReportDetail(VisitReport.findById(reportId));

  if (!report) {
    report = await resolveVisitReportFromAuditLog(reportId)
      || await resolveVisitReportFromAppointmentId(reportId);
  }

  if (!report) throw AppError.notFound('Visit report not found');

  const appointment = report.appointmentId as any;
  if (appointment?._id && appointment?.salesStaffId) {
    const canonicalAppointment = await getCanonicalActiveOcularAppointment(appointment);
    if (canonicalAppointment && canonicalAppointment._id.toString() !== appointment._id.toString()) {
      await ensureAppointmentServiceTypeReports(
        canonicalAppointment._id,
        canonicalAppointment.customerId,
        canonicalAppointment.salesStaffId!,
        'ocular',
        canonicalAppointment.customerSiteDetails,
        canonicalAppointment.serviceTypes,
        canonicalAppointment.serviceTypes?.[0],
        canonicalAppointment.serviceTypeCustom,
        report.linkedProjectId,
      );

      const canonicalReport = await VisitReport.findOne({
        appointmentId: canonicalAppointment._id,
        serviceType: report.serviceType,
      })
        .populate('customerId', 'firstName lastName email phone')
        .populate('salesStaffId', 'firstName lastName email')
        .populate('appointmentId', 'customerId date slotCode type status customerAddress serviceTypes serviceTypeCustom customerSiteDetails salesStaffId sourceConsultationAppointmentId sourceConsultationReportId attendanceStatus actualArrivalAt consultationStartedAt consultationCompletedAt attendanceNotes attendanceUpdatedAt updatedAt createdAt');

      if (canonicalReport) {
        report = canonicalReport;
      }
    }

    const refreshedAppointment = report.appointmentId as any;
    await ensureAppointmentServiceTypeReports(
      refreshedAppointment._id,
      report.customerId instanceof Object ? (report.customerId as any)._id : report.customerId,
      refreshedAppointment.salesStaffId,
      refreshedAppointment.type === AppointmentType.OCULAR ? 'ocular' : 'consultation',
      refreshedAppointment.customerSiteDetails,
      refreshedAppointment.serviceTypes,
      refreshedAppointment.serviceTypes?.[0],
      refreshedAppointment.serviceTypeCustom,
      report.linkedProjectId,
      report._id,
    );
  }

  // Fetch sample projects for the customer
  const customerId = report.customerId instanceof Object ? (report.customerId as any)._id : report.customerId;
  const customerProjects = await Project.find({ customerId })
    .select('title serviceType status')
    .sort({ createdAt: -1 })
    .limit(2);

  const sampleProjects = customerProjects.map((p) => ({
    projectId: String(p._id),
    title: p.title || p.serviceType || 'Project',
    serviceType: p.serviceType,
    status: p.status,
    path: `/projects/${p._id}`,
  }));
  const relatedOcularAppointment = await getRelatedOcularAppointmentForConsultation(report);

  return {
    ...report.toObject(),
    sampleProjects,
    relatedOcularAppointment,
  };
}

// ── Get by Appointment (returns ARRAY — multiple reports per appointment) ──

export async function getByAppointment(appointmentId: string) {
  const appointment = await Appointment.findById(appointmentId)
    .select('customerId salesStaffId type serviceTypes serviceTypeCustom customerSiteDetails')
    .lean();

  if (appointment?.salesStaffId) {
    await ensureAppointmentServiceTypeReports(
      appointmentId,
      appointment.customerId,
      appointment.salesStaffId,
      appointment.type === AppointmentType.OCULAR ? 'ocular' : 'consultation',
      appointment.customerSiteDetails,
      appointment.serviceTypes,
      appointment.serviceTypes?.[0],
      appointment.serviceTypeCustom,
    );
  }

  const reports = await VisitReport.find({ appointmentId })
    .populate('customerId', 'firstName lastName email phone')
    .populate('salesStaffId', 'firstName lastName email')
    .populate('appointmentId', 'date slotCode type customerAddress attendanceStatus actualArrivalAt consultationStartedAt consultationCompletedAt attendanceNotes attendanceUpdatedAt')
    .sort({ createdAt: 1 });
  return reports;
}

// ── List for Sales Staff ──

export async function listForSalesStaff(salesStaffId: string, query: {
  status?: string;
  page?: string;
  limit?: string;
}) {
  const page = parseInt(query.page || '1');
  const limit = Math.min(parseInt(query.limit || '20'), 100);
  const { staleIds } = await getCanonicalActiveOcularAppointmentsForSalesStaff(salesStaffId);
  await repairPromotableOcularReportsForSalesStaff(salesStaffId);
  const filter: Record<string, unknown> = { salesStaffId, ...(await excludeCancelledDrafts()) };
  if (staleIds.length > 0) {
    filter.appointmentId = { $nin: staleIds };
  }
  if (query.status) filter.status = query.status;

  const [reports, total] = await Promise.all([
    VisitReport.find(filter)
      .populate('customerId', 'firstName lastName email')
      .populate('appointmentId', 'date slotCode type customerAddress attendanceStatus actualArrivalAt consultationStartedAt consultationCompletedAt attendanceNotes attendanceUpdatedAt')
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    VisitReport.countDocuments(filter),
  ]);

  return { items: reports, total, hasMore: page * limit < total };
}

async function repairPromotableOcularReportsForSalesStaff(salesStaffId: string) {
  const { canonicalAppointments } = await getCanonicalActiveOcularAppointmentsForSalesStaff(salesStaffId);

  for (const appointment of canonicalAppointments) {
    const serviceTypes = appointment.serviceTypes?.length
      ? appointment.serviceTypes
      : appointment.customerSiteDetails?.serviceTypes || [];

    await promoteConsultationReportsToOcularAppointment(
      appointment._id,
      appointment.sourceConsultationAppointmentId || appointment._id,
      appointment.customerId,
      appointment.salesStaffId!,
      serviceTypes,
    );
  }
}

// ── List Submitted (Engineer queue) ──

export async function listSubmitted(query: {
  page?: string;
  limit?: string;
}) {
  const page = parseInt(query.page || '1');
  const limit = Math.min(parseInt(query.limit || '20'), 100);
  const filter = { status: VisitReportStatus.SUBMITTED };

  const [reports, total] = await Promise.all([
    VisitReport.find(filter)
      .populate('customerId', 'firstName lastName email')
      .populate('salesStaffId', 'firstName lastName')
      .populate('appointmentId', 'date slotCode type customerAddress attendanceStatus actualArrivalAt consultationStartedAt consultationCompletedAt attendanceNotes attendanceUpdatedAt')
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    VisitReport.countDocuments(filter),
  ]);

  return { items: reports, total, hasMore: page * limit < total };
}

// ── List All (Admin view) ──

export async function listAll(query: {
  status?: string;
  salesStaffId?: string;
  page?: string;
  limit?: string;
}) {
  const page = parseInt(query.page || '1');
  const limit = Math.min(parseInt(query.limit || '20'), 100);
  const filter: Record<string, unknown> = { ...(await excludeCancelledDrafts()) };
  if (query.status) filter.status = query.status;
  if (query.salesStaffId) filter.salesStaffId = query.salesStaffId;

  const [reports, total] = await Promise.all([
    VisitReport.find(filter)
      .populate('customerId', 'firstName lastName email')
      .populate('salesStaffId', 'firstName lastName')
      .populate('appointmentId', 'date slotCode type customerAddress attendanceStatus actualArrivalAt consultationStartedAt consultationCompletedAt attendanceNotes attendanceUpdatedAt')
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    VisitReport.countDocuments(filter),
  ]);

  return { items: reports, total, hasMore: page * limit < total };
}

// ── Update Report (Sales Staff fills draft/returned) ──

export async function updateReport(
  reportId: string,
  input: UpdateVisitReportInput,
  salesStaffId: string,
  ip?: string,
  ua?: string,
) {
  const report = await VisitReport.findById(reportId);
  if (!report) throw AppError.notFound('Visit report not found');

  // Only the assigned sales staff can edit
  if (report.salesStaffId.toString() !== salesStaffId) {
    throw AppError.forbidden('You are not assigned to this visit report');
  }

  // Can only edit in DRAFT or RETURNED status
  if (![VisitReportStatus.DRAFT, VisitReportStatus.RETURNED].includes(report.status)) {
    throw AppError.badRequest('Visit report can only be edited in draft or returned status');
  }

  if (report.visitType === 'consultation') {
    const siblingSchedule = await VisitReport.findOne({
      appointmentId: report.appointmentId,
      visitType: 'consultation',
      _id: { $ne: report._id },
      recommendedOcularDate: { $exists: true, $ne: null },
      recommendedOcularSlot: { $exists: true, $ne: null },
    }).select('recommendedOcularDate recommendedOcularSlot recommendedOcularAddressId recommendedOcularAddress');

    if (siblingSchedule) {
      input.recommendedOcularDate = siblingSchedule.recommendedOcularDate as any;
      input.recommendedOcularSlot = siblingSchedule.recommendedOcularSlot;
      input.recommendedOcularAddressId = (siblingSchedule as any).recommendedOcularAddressId;
      input.recommendedOcularAddress = (siblingSchedule as any).recommendedOcularAddress;
    }
  }

  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      (report as any)[key] = value;
      changes[key] = value;
    }
  }

  if (report.visitType === 'consultation' && report.consultationOutcome === 'no_ocular') {
    report.recommendedOcularDate = undefined;
    report.recommendedOcularSlot = undefined;
    report.recommendedOcularAddressId = undefined;
    report.recommendedOcularAddress = undefined;
    changes.recommendedOcularDate = undefined;
    changes.recommendedOcularSlot = undefined;
    changes.recommendedOcularAddressId = undefined;
    changes.recommendedOcularAddress = undefined;
  }

  await report.save();

  await AuditLog.create({
    action: AuditAction.VISIT_REPORT_UPDATED,
    actorId: salesStaffId,
    targetType: 'visit_report',
    targetId: report._id,
    details: changes,
    ipAddress: ip,
    userAgent: ua,
  });

  return report;
}

// ── Submit Report (Sales Staff → Engineer) ──

export async function submitReport(
  reportId: string,
  salesStaffId: string,
  ip?: string,
  ua?: string,
) {
  const report = await VisitReport.findById(reportId);
  if (!report) throw AppError.notFound('Visit report not found');

  if (report.salesStaffId.toString() !== salesStaffId) {
    throw AppError.forbidden('You are not assigned to this visit report');
  }

  // Ensure the linked appointment is in a valid status before allowing submission
  const appt = await Appointment.findById(report.appointmentId);
  if (!appt) throw AppError.notFound('Linked appointment not found');

  const isConsultationReport = report.visitType === 'consultation';
  const hasRecommendedOcularSchedule = Boolean(report.recommendedOcularDate && report.recommendedOcularSlot);
  const hasRecommendedOcularAddress = Boolean(
    report.recommendedOcularAddress
    && typeof (report.recommendedOcularAddress as any).lat === 'number'
    && typeof (report.recommendedOcularAddress as any).lng === 'number'
    && (report.recommendedOcularAddress as any).formattedAddress,
  );
  const consultationOutcome = report.consultationOutcome as 'schedule_ocular' | 'no_ocular' | undefined;

  let siblingConsultationReportsSubmitted = false;

  if (isConsultationReport) {
    const attendanceStatus = appt.attendanceStatus || AppointmentAttendanceStatus.SCHEDULED;
    if (attendanceStatus === AppointmentAttendanceStatus.NO_SHOW) {
      throw AppError.badRequest(
        'Consultation report cannot be submitted because the consultation was marked as No Show. Save notes only.',
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (attendanceStatus === AppointmentAttendanceStatus.RESCHEDULED) {
      throw AppError.badRequest(
        'Consultation report cannot be submitted because the consultation was marked as Rescheduled. Save notes only.',
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (attendanceStatus === AppointmentAttendanceStatus.CUSTOMER_DECLINED) {
      throw AppError.badRequest(
        'Consultation report cannot be submitted because the customer declined to proceed. Save notes only.',
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (attendanceStatus !== AppointmentAttendanceStatus.COMPLETED) {
      throw AppError.badRequest(
        'Complete the consultation attendance before submitting the consultation report.',
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (!consultationOutcome) {
      throw AppError.badRequest(
        'Choose whether to schedule an ocular visit or proceed without ocular before submitting the consultation report.',
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (consultationOutcome === 'schedule_ocular' && !hasRecommendedOcularSchedule) {
      throw AppError.badRequest(
        'Select an ocular visit date and time before scheduling the ocular visit.',
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (consultationOutcome === 'no_ocular' && !report.noOcularReason?.trim()) {
      throw AppError.badRequest(
        'Explain why ocular is not needed before proceeding without ocular.',
        ErrorCode.VALIDATION_ERROR,
      );
    }
    if (consultationOutcome === 'no_ocular') {
      report.recommendedOcularDate = undefined;
      report.recommendedOcularSlot = undefined;
      const missingFields = getIncompleteNoOcularFields({
        title: readableServiceTitle(report.serviceType, report.serviceTypeCustom),
        serviceType: report.serviceType,
        serviceTypeCustom: report.serviceTypeCustom,
        discussionNotes: report.discussionNotes,
        customerRequirements: report.customerRequirements,
        notes: report.notes,
        lineItems: report.lineItems,
        measurements: report.measurements,
        materials: report.materials,
        preferredDesign: report.preferredDesign,
        photoKeys: report.photoKeys,
        referenceImageKeys: report.referenceImageKeys,
        initialDesignKeys: report.initialDesignKeys,
        selectedDesignTemplateImageUrl: report.selectedDesignTemplateImageUrl,
      });
      if (missingFields.length > 0) {
        throw AppError.badRequest(
          `Proceeding without ocular requires complete project details. Missing: ${missingFields.join(', ')}.`,
          ErrorCode.VALIDATION_ERROR,
        );
      }
    }
  }

  if (report.visitType === 'ocular' && appt.status !== AppointmentStatus.COMPLETED) {
    if (appt.status !== AppointmentStatus.IN_PROGRESS) {
      throw AppError.badRequest(
        'Start the site visit first before submitting the final ocular report.',
        ErrorCode.VALIDATION_ERROR,
      );
    }

    await completeOcularAppointmentForReport(appt, salesStaffId, ip, ua);
  }

  if (!isConsultationReport && appt.status !== AppointmentStatus.COMPLETED) {
    throw AppError.badRequest(
      'The appointment must be marked as complete before submitting reports',
      ErrorCode.VALIDATION_ERROR,
    );
  }

  // Block submission for ocular visits with unpaid fees when the site is outside NCR.
  if (
    report.visitType === 'ocular' &&
    !appt.ocularFeeBreakdown?.isWithinNCR &&
    (appt.ocularFee || 0) > 0 &&
    !appt.ocularFeePaid
  ) {
    throw AppError.badRequest(
      'The ocular visit fee must be paid and verified before submitting this report.',
      ErrorCode.VALIDATION_ERROR,
    );
  }

  if (report.visitType === 'ocular') {
    const missingFields = getIncompleteOcularFields(report);
    if (missingFields.length > 0) {
      throw AppError.badRequest(
        `You have not yet provided information on: ${missingFields.join(', ')}.`,
        ErrorCode.VALIDATION_ERROR,
      );
    }
  }

  if (isConsultationReport && consultationOutcome === 'no_ocular') {
    report.recommendedOcularDate = undefined;
    report.recommendedOcularSlot = undefined;
    report.recommendedOcularAddressId = undefined;
    report.recommendedOcularAddress = undefined;
  }

  const alreadySubmittedConsultation = isConsultationReport && report.status === VisitReportStatus.SUBMITTED;

  if (alreadySubmittedConsultation && consultationOutcome === 'no_ocular') {
    await report.save();
    await ensureConsultationDraftProject(
      report,
      appt,
      salesStaffId,
      'consultation_resubmitted_repair',
      ip,
      ua,
    );
    await submitSiblingConsultationReports(report, appt, salesStaffId, ip, ua);
    return report;
  }

  if (!alreadySubmittedConsultation) {
    visitReportStateMachine.assertTransition(report.status, VisitReportStatus.SUBMITTED);

    report.status = VisitReportStatus.SUBMITTED;
    await report.save();

    await AuditLog.create({
      action: AuditAction.VISIT_REPORT_SUBMITTED,
      actorId: salesStaffId,
      targetType: 'visit_report',
      targetId: report._id,
      ipAddress: ip,
      userAgent: ua,
    });
  } else {
    await report.save();
  }

  if (isConsultationReport) {
    // ── Consultation: auto-create DRAFT project, then branch by ocular decision ──
    const serviceLabel = report.serviceTypeCustom || report.serviceType || 'General Fabrication';
    const project = await ensureConsultationDraftProject(
      report,
      appt,
      salesStaffId,
      'consultation_submitted',
      ip,
      ua,
    );

    const formatOcularSlot = (slot: string) => {
      const h = parseInt(slot.split(':')[0]);
      return `${h > 12 ? h - 12 : h === 0 ? 12 : h}:00 ${h >= 12 ? 'PM' : 'AM'}`;
    };

    if (consultationOutcome === 'schedule_ocular') {
      const ocularDateInfo = report.recommendedOcularDate
        ? ` Recommended ocular date: ${report.recommendedOcularDate.toISOString().split('T')[0]}${report.recommendedOcularSlot ? ` at ${formatOcularSlot(report.recommendedOcularSlot)}` : ''}.`
        : '';
      await notifyRole(
        Role.APPOINTMENT_AGENT,
        NotificationCategory.APPOINTMENT,
        'Consultation Completed — Schedule Ocular',
        `Consultation report submitted for "${serviceLabel}". A DRAFT project has been created.${ocularDateInfo} Schedule an ocular visit for the customer.`,
        `/appointments/${appt._id}`,
      );

      await notifyRole(
        Role.ADMIN,
        NotificationCategory.PROJECT,
        'New Draft Project from Consultation',
        `A new draft project "${serviceLabel}" has been created from a consultation. Awaiting ocular visit.`,
        `/projects/${project._id}`,
      );

      await createAndSendNotification(
        report.customerId,
        NotificationCategory.PROJECT,
        'Consultation Complete',
        `Your consultation has been completed for "${serviceLabel}". An ocular visit will be scheduled next.`,
        `/appointments/${appt._id}`,
      );

      appt.consultationReportSubmitted = true;
      if (appt.status === AppointmentStatus.COMPLETED) {
        appointmentStateMachine.assertTransition(
          appt.status,
          AppointmentStatus.READY_FOR_OCULAR,
        );
        appt.status = AppointmentStatus.READY_FOR_OCULAR;
      }
      await appt.save();

      const recommendedOcularDate = report.recommendedOcularDate
        ? report.recommendedOcularDate.toISOString().split('T')[0]
        : undefined;
      const recommendedOcularSlot = report.recommendedOcularSlot;

      await submitSiblingConsultationReports(report, appt, salesStaffId, ip, ua);
      siblingConsultationReportsSubmitted = true;

      const consultationServiceTypes = await getAppointmentVisitReportServiceTypes(report.appointmentId);
      const activeOcular = await Appointment.findOne({
        customerId: report.customerId,
        type: AppointmentType.OCULAR,
        sourceConsultationAppointmentId: appt._id,
        status: {
          $in: [
            AppointmentStatus.REQUESTED,
            AppointmentStatus.CONFIRMED,
            AppointmentStatus.PREPARING,
            AppointmentStatus.ON_THE_WAY,
            AppointmentStatus.ARRIVED_AT_SITE,
            AppointmentStatus.IN_PROGRESS,
            AppointmentStatus.RESCHEDULE_REQUESTED,
            AppointmentStatus.READY_FOR_OCULAR,
          ],
        },
      }).sort({ updatedAt: -1, createdAt: -1 });

      let ocularAppointment = activeOcular;
      const ocularServiceTypeCustom = report.serviceTypeCustom || appt.serviceTypeCustom;

      if (!ocularAppointment) {
        ocularAppointment = await Appointment.create({
          customerId: report.customerId,
          type: AppointmentType.OCULAR,
          date: recommendedOcularDate!,
          slotCode: recommendedOcularSlot!,
          status: AppointmentStatus.REQUESTED,
          salesStaffId: report.salesStaffId,
          bookedBy: report.salesStaffId,
          sourceConsultationAppointmentId: appt._id,
          sourceConsultationReportId: report._id,
          serviceTypes: consultationServiceTypes,
          serviceTypeCustom: appt.serviceTypeCustom,
          customerSiteDetails: {
            serviceTypes: consultationServiceTypes,
            serviceTypeCustom: appt.serviceTypeCustom,
          },
          customerNotes: `Ocular follow-up scheduled from consultation report ${report._id}`,
        });

        await AuditLog.create({
          action: AuditAction.APPOINTMENT_CREATED,
          actorId: salesStaffId,
          targetType: 'appointment',
          targetId: ocularAppointment._id,
          details: {
            triggeredBy: 'system',
            reason: 'consultation_report_recommended_ocular',
            sourceVisitReportId: report._id,
          },
          ipAddress: ip,
          userAgent: ua,
        });
      } else {
        let changedExistingOcular = false;

        if (recommendedOcularDate && ocularAppointment.date !== recommendedOcularDate) {
          ocularAppointment.date = recommendedOcularDate;
          changedExistingOcular = true;
        }
        if (recommendedOcularSlot && ocularAppointment.slotCode !== recommendedOcularSlot) {
          ocularAppointment.slotCode = recommendedOcularSlot as any;
          changedExistingOcular = true;
        }
        if (!ocularAppointment.salesStaffId) {
          ocularAppointment.salesStaffId = report.salesStaffId;
          changedExistingOcular = true;
        }
        if (!ocularAppointment.bookedBy) {
          ocularAppointment.bookedBy = report.salesStaffId;
          changedExistingOcular = true;
        }
        if (ocularAppointment.sourceConsultationAppointmentId?.toString() !== appt._id.toString()) {
          ocularAppointment.sourceConsultationAppointmentId = appt._id;
          changedExistingOcular = true;
        }
        if (ocularAppointment.sourceConsultationReportId?.toString() !== report._id.toString()) {
          ocularAppointment.sourceConsultationReportId = report._id;
          changedExistingOcular = true;
        }
        if (consultationServiceTypes.length > 0 && !sameServiceTypes(ocularAppointment.serviceTypes, consultationServiceTypes)) {
          ocularAppointment.serviceTypes = consultationServiceTypes;
          changedExistingOcular = true;
        }
        if (!ocularAppointment.serviceTypeCustom && ocularServiceTypeCustom) {
          ocularAppointment.serviceTypeCustom = ocularServiceTypeCustom;
          changedExistingOcular = true;
        }
        if (!ocularAppointment.customerSiteDetails) {
          ocularAppointment.customerSiteDetails = {
            serviceTypes: consultationServiceTypes,
            serviceTypeCustom: ocularServiceTypeCustom,
          };
          changedExistingOcular = true;
        } else {
          if (consultationServiceTypes.length > 0 && !sameServiceTypes(ocularAppointment.customerSiteDetails.serviceTypes, consultationServiceTypes)) {
            ocularAppointment.customerSiteDetails.serviceTypes = consultationServiceTypes;
            changedExistingOcular = true;
          }
          if (!ocularAppointment.customerSiteDetails.serviceTypeCustom && ocularServiceTypeCustom) {
            ocularAppointment.customerSiteDetails.serviceTypeCustom = ocularServiceTypeCustom;
            changedExistingOcular = true;
          }
        }

        if (changedExistingOcular) {
          await ocularAppointment.save();
        }
      }

      if (hasRecommendedOcularAddress) {
        await applyRecommendedOcularAddress(
          ocularAppointment,
          report.recommendedOcularAddress as any,
        );
        await ocularAppointment.save();
      }
      await promoteConsultationReportsToOcularAppointment(
        ocularAppointment._id,
        appt._id,
        report.customerId,
        report.salesStaffId,
        consultationServiceTypes,
        project._id,
        report._id,
      );

      if (appt.status === AppointmentStatus.READY_FOR_OCULAR) {
        appointmentStateMachine.assertTransition(
          appt.status,
          AppointmentStatus.COMPLETED,
        );
        appt.status = AppointmentStatus.COMPLETED;
        await appt.save();
      }

      const readableSlot = formatOcularSlot(recommendedOcularSlot!);
      if (!hasRecommendedOcularAddress) {
        await createAndSendNotification(
          report.customerId,
          NotificationCategory.SYSTEM,
          'Action Required — Submit Ocular Site Pin & Address',
          `Your ocular visit is scheduled for ${recommendedOcularDate} at ${readableSlot}. Open this appointment to submit your exact map pin and complete site address. We will then confirm whether the visit is free within Metro Manila or requires an ocular fee.`,
          `/appointments/${ocularAppointment._id}`,
        );
        if (ocularAppointment.salesStaffId) {
          await createAndSendNotification(
            ocularAppointment.salesStaffId.toString(),
            NotificationCategory.APPOINTMENT,
            'Ocular Visit Scheduled — Customer Address Needed',
            `The ocular visit is scheduled for ${recommendedOcularDate} at ${readableSlot}. Waiting for the customer to add and pin the site address.`,
            `/appointments/${ocularAppointment._id}`,
          );
        }
      } else {
        const addressLine = ocularAppointment.formattedAddress || 'the selected project address';
        const requiresOcularFee = !ocularAppointment.ocularFeeBreakdown?.isWithinNCR && (ocularAppointment.ocularFee || 0) > 0;

        if (requiresOcularFee) {
          await createAndSendNotification(
            report.customerId,
            NotificationCategory.PAYMENT,
            'Ocular Visit Payment Required',
            `Your ocular visit for ${recommendedOcularDate} at ${readableSlot} uses ${addressLine}. Please pay the ocular fee of ₱${ocularAppointment.ocularFee?.toLocaleString()} to proceed.`,
            `/appointments/${ocularAppointment._id}/pay-ocular-fee`,
          );
        } else {
          await createAndSendNotification(
            report.customerId,
            NotificationCategory.APPOINTMENT,
            'Ocular Visit Scheduled',
            `Your ocular visit is scheduled for ${recommendedOcularDate} at ${readableSlot} at ${addressLine}. No ocular fee is required.`,
            `/appointments/${ocularAppointment._id}`,
          );
        }

        if (ocularAppointment.salesStaffId) {
          await createAndSendNotification(
            ocularAppointment.salesStaffId.toString(),
            NotificationCategory.APPOINTMENT,
            requiresOcularFee ? 'Ocular Address Selected - Payment Pending' : 'Ocular Address Selected',
            requiresOcularFee
              ? `The customer address is set for ${recommendedOcularDate} at ${readableSlot}. Waiting for ocular fee payment.`
              : `The customer address is set for ${recommendedOcularDate} at ${readableSlot}. You can finalize the ocular visit.`,
            `/appointments/${ocularAppointment._id}`,
          );
        }
      }

      if (appt.status !== AppointmentStatus.COMPLETED) {
        appointmentStateMachine.assertTransition(
          appt.status,
          AppointmentStatus.COMPLETED,
        );
        appt.status = AppointmentStatus.COMPLETED;
        await appt.save();
      }
    } else {
      project.contractStatus = project.contractStatus || ContractStatus.MISSING;
      if (project.status !== ProjectStatus.DRAFT) {
        project.status = ProjectStatus.DRAFT;
      }
      await project.save();

      const item = await upsertProjectItemFromVisitReport(project, report);
      item.status = ProjectStatus.DRAFT;
      await item.save();

      await notifySalesContractUploadRequired(project, serviceLabel, 'Sales marked ocular as not needed.');

      await createAndSendNotification(
        report.customerId,
        NotificationCategory.PROJECT,
        'Consultation Complete',
        `Your consultation has been completed for "${serviceLabel}". The project will continue without an ocular visit.`,
        `/projects/${project._id}`,
      );

      appt.consultationReportSubmitted = true;
      if (appt.status !== AppointmentStatus.COMPLETED) {
        appointmentStateMachine.assertTransition(
          appt.status,
          AppointmentStatus.COMPLETED,
        );
        appt.status = AppointmentStatus.COMPLETED;
        await appt.save();
      } else {
        await appt.save();
      }
    }

    if (!siblingConsultationReportsSubmitted) {
      await submitSiblingConsultationReports(report, appt, salesStaffId, ip, ua);
    }
  } else {
    // ── Ocular: update existing project with measurements, transition DRAFT → SUBMITTED ──
    const linkedProject = report.linkedProjectId
      ? await Project.findById(report.linkedProjectId)
      : await Project.findOne({ visitReportId: { $ne: report._id }, appointmentId: { $exists: true }, customerId: report.customerId, status: { $in: [ProjectStatus.DRAFT, ProjectStatus.SUBMITTED] } }).sort({ createdAt: -1 });

    if (linkedProject) {
      // Update project with ocular data
      if (report.measurements) linkedProject.measurements = report.measurements;
      if (report.materials) linkedProject.materialType = report.materials;
      if (report.finishes) linkedProject.finishColor = report.finishes;
      if (report.notes) linkedProject.notes = report.notes;
      if (report.initialDesignKeys?.length) linkedProject.initialDesignKeys = report.initialDesignKeys;
      if (report.initialDesignNotes) linkedProject.initialDesignNotes = report.initialDesignNotes;
      if (report.initialDesignKeys?.length || report.initialDesignNotes?.trim()) {
        linkedProject.designReviewStatus = linkedProject.designReviewStatus === 'approved'
          ? 'approved'
          : 'pending';
      }
      if (report.siteConditions) (linkedProject as any).siteConditions = report.siteConditions;
      linkedProject.mediaKeys = [...(linkedProject.mediaKeys || []), ...report.photoKeys, ...report.sketchKeys, ...report.referenceImageKeys];
      if (appt.formattedAddress) linkedProject.siteAddress = appt.formattedAddress;
      // Point the project's visitReportId to the ocular report so the project page shows on-site data
      linkedProject.visitReportId = report._id;

      linkedProject.contractStatus = linkedProject.contractStatus || ContractStatus.MISSING;

      await linkedProject.save();
      const item = await upsertProjectItemFromVisitReport(linkedProject, report);
      item.status = linkedProject.status === ProjectStatus.DRAFT ? ProjectStatus.DRAFT : linkedProject.status;
      await item.save();

      await AuditLog.create({
        action: AuditAction.PROJECT_UPDATED,
        actorId: salesStaffId,
        targetType: 'project',
        targetId: linkedProject._id,
        details: { triggeredBy: 'system', reason: 'ocular_report_submitted', visitReportId: reportId },
        ipAddress: ip,
        userAgent: ua,
      });

      await notifySalesContractUploadRequired(
        linkedProject,
        linkedProject.serviceType || linkedProject.title,
        'Ocular measurements have been submitted.',
      );
    } else {
      // Fallback: no linked project found — create one as draft pending signed contract upload.
      const existingProject = await Project.findOne({ visitReportId: report._id });
      if (!existingProject) {
        const serviceLabel = report.serviceTypeCustom || report.serviceType || 'General Fabrication';
        const customerNotes = (appt.customerNotes || '').trim();
        const notesNormalized = customerNotes.toLowerCase();
        const serviceLabelNormalized = serviceLabel.toLowerCase();
        const titleBase = customerNotes && notesNormalized !== serviceLabelNormalized
          ? customerNotes
          : serviceLabel;
        const project = await Project.create({
          projectNumber: await generateProjectNumber(),
          appointmentId: report.appointmentId,
          visitReportId: report._id,
          customerId: report.customerId,
          salesStaffId: report.salesStaffId,
          title: titleBase,
          serviceType: serviceLabel,
          description: report.customerRequirements || report.notes || 'Created from visit report',
          siteAddress: getVisitReportProjectSiteAddress(appt, report),
          measurements: report.measurements,
          materialType: report.materials,
          finishColor: report.finishes,
          quantity: 1,
          notes: report.notes,
          initialDesignKeys: report.initialDesignKeys || [],
          initialDesignNotes: report.initialDesignNotes,
          designReviewStatus: (report.initialDesignKeys?.length || report.initialDesignNotes) ? 'pending' : 'not_required',
          status: ProjectStatus.DRAFT,
          contractStatus: ContractStatus.MISSING,
          mediaKeys: [...report.photoKeys, ...report.sketchKeys, ...report.referenceImageKeys],
        });

        await AuditLog.create({
          action: AuditAction.PROJECT_CREATED,
          actorId: salesStaffId,
          targetType: 'project',
          targetId: project._id,
          details: { triggeredBy: 'system', reason: 'visit_report_submitted', visitReportId: reportId },
          ipAddress: ip,
          userAgent: ua,
        });

        await notifySalesContractUploadRequired(project, serviceLabel, 'The ocular visit report created a project.');
      }
    }
  }

  return report;
}

// ── Delete Report (Sales Staff removes accidental extra project) ──

export async function deleteReport(
  reportId: string,
  salesStaffId: string,
  ip?: string,
  ua?: string,
) {
  const report = await VisitReport.findById(reportId);
  if (!report) throw AppError.notFound('Visit report not found');

  if (report.salesStaffId.toString() !== salesStaffId) {
    throw AppError.forbidden('You are not assigned to this visit report');
  }

  if (![VisitReportStatus.DRAFT, VisitReportStatus.RETURNED].includes(report.status)) {
    throw AppError.badRequest('Only draft or returned reports can be deleted');
  }

  const hasLinkedProject = await Project.exists({ visitReportId: report._id });
  if (hasLinkedProject) {
    throw AppError.badRequest('Cannot delete a report that already has a linked project');
  }

  const reportCountForAppointment = await VisitReport.countDocuments({
    appointmentId: report.appointmentId,
  });

  if (reportCountForAppointment <= 1) {
    throw AppError.badRequest('At least one visit report must remain for this appointment');
  }

  const deletedId = report._id.toString();
  await report.deleteOne();

  await AuditLog.create({
    action: AuditAction.VISIT_REPORT_DELETED,
    actorId: salesStaffId,
    targetType: 'visit_report',
    targetId: report._id,
    details: {
      appointmentId: report.appointmentId.toString(),
      status: report.status,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  return { deletedId };
}

// ── Return Report (Engineer → Sales Staff) ──

export async function returnReport(
  reportId: string,
  input: ReturnVisitReportInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const report = await VisitReport.findById(reportId);
  if (!report) throw AppError.notFound('Visit report not found');

  visitReportStateMachine.assertTransition(report.status, VisitReportStatus.RETURNED);

  report.status = VisitReportStatus.RETURNED;
  report.returnReason = input.reason;
  await report.save();

  await AuditLog.create({
    action: AuditAction.VISIT_REPORT_RETURNED,
    actorId,
    targetType: 'visit_report',
    targetId: report._id,
    details: { reason: input.reason },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify the sales staff
  await createAndSendNotification(
    report.salesStaffId,
    NotificationCategory.PROJECT,
    'Visit Report Returned',
    `Your visit report has been returned for revision. Reason: ${input.reason}`,
    `/visit-reports/${report._id}`,
  );

  return report;
}

export async function reopenReportForRepair(
  reportId: string,
  input: ReopenVisitReportInput,
  actorId: string,
  actorRoles: Role[],
  ip?: string,
  ua?: string,
) {
  const report = await VisitReport.findById(reportId);
  if (!report) throw AppError.notFound('Visit report not found');

  if (report.visitType !== 'ocular') {
    throw AppError.badRequest('Only ocular reports can be reopened for repair');
  }

  const isAdmin = actorRoles.includes(Role.ADMIN);
  const isAssignedSales = actorRoles.includes(Role.SALES_STAFF) && report.salesStaffId.toString() === actorId;
  if (!isAdmin && !isAssignedSales) {
    throw AppError.forbidden('Only the assigned sales staff or an admin can reopen this ocular report');
  }

  if (![VisitReportStatus.SUBMITTED, VisitReportStatus.COMPLETED].includes(report.status)) {
    throw AppError.badRequest('Only submitted or completed ocular reports can be reopened for repair');
  }

  const reason = input.reason.trim();
  report.status = VisitReportStatus.RETURNED;
  report.returnReason = reason;
  await report.save();

  await AuditLog.create({
    action: AuditAction.VISIT_REPORT_RETURNED,
    actorId,
    targetType: 'visit_report',
    targetId: report._id,
    details: { reason, reopenedForRepair: true },
    ipAddress: ip,
    userAgent: ua,
  });

  const linkedProject = report.linkedProjectId
    ? await Project.findById(report.linkedProjectId)
    : await Project.findOne({ visitReportId: report._id });

  if (linkedProject) {
    await notifyRole(
      Role.ADMIN,
      NotificationCategory.PROJECT,
      'Ocular Report Reopened for Repair',
      `Ocular report for project "${linkedProject.title}" was reopened for repair. Reason: ${reason}`,
      `/visit-reports/${report._id}`,
    );

    for (const engineerId of linkedProject.engineerIds) {
      await createAndSendNotification(
        engineerId,
        NotificationCategory.PROJECT,
        'Ocular Report Under Repair',
        `The ocular report for project "${linkedProject.title}" was reopened for repair. Engineering should wait for the corrected site data before relying on it.`,
        `/projects/${linkedProject._id}`,
      );
    }
  }

  if (isAdmin && report.salesStaffId.toString() !== actorId) {
    await createAndSendNotification(
      report.salesStaffId,
      NotificationCategory.PROJECT,
      'Ocular Report Reopened for Repair',
      `An admin reopened your ocular report for repair. Reason: ${reason}`,
      `/visit-reports/${report._id}`,
    );
  }

  return report;
}

// ── Mark as Completed (when engineer finishes blueprint from this report) ──

export async function markCompleted(
  reportId: string,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const report = await VisitReport.findById(reportId);
  if (!report) throw AppError.notFound('Visit report not found');

  visitReportStateMachine.assertTransition(report.status, VisitReportStatus.COMPLETED);

  report.status = VisitReportStatus.COMPLETED;
  await report.save();

  await AuditLog.create({
    action: AuditAction.VISIT_REPORT_COMPLETED,
    actorId,
    targetType: 'visit_report',
    targetId: report._id,
    ipAddress: ip,
    userAgent: ua,
  });

  return report;
}

export const __visitReportServiceInternals = {
  getIncompleteNoOcularFields,
};
