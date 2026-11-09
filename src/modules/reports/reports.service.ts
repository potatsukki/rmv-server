import {
  Project, Payment, PaymentPlan, Appointment,
  FabricationUpdate, User, CashCollection, AuditLog, Blueprint, Config,
} from '../../models/index.js';
import {
  DeliveryType, ProjectStatus, PaymentStageStatus, FabricationStatus,
  AppointmentStatus, AppointmentAttendanceStatus, AppointmentType, Role, AuditAction,
} from '../../utils/constants.js';
import type { Types } from 'mongoose';
import { activeProjectStatusesForRoles, customerVisibleProjectsFilter } from '../projects/projects.list-policy.js';
import { resolveProjectStages } from '../projects/project-stage.js';
import { getProjectPaymentDue } from '../payments/payment-due.js';
import { buildAppointmentStatusGroupFilter } from '../appointments/appointment-status-groups.js';
import { countPendingReportGroupsForSalesStaff } from '../visit-reports/visit-reports.service.js';

type LifecycleEscalationProfile = {
  ownerTeam: string;
  ownerRole: string;
  slaHours: number;
  runbookPath: string;
};

type LifecycleHotspotAcknowledgeInput = {
  targetType?: string;
  currentStatus?: string;
  attemptedStatus?: string;
  refreshRequired?: boolean;
  acknowledged?: boolean;
  note?: string;
};

type LifecycleHotspotAcknowledgement = {
  acknowledgedAt: string;
  acknowledgedBy: string;
  note?: string;
};

type LifecycleHotspotAcknowledgementMap = Record<string, LifecycleHotspotAcknowledgement>;

const LIFECYCLE_HOTSPOT_ACK_CONFIG_KEY = 'lifecycle_hotspot_acknowledgements';

function normalizeHotspotPart(value: unknown): string {
  const normalized = String(value ?? 'unknown').trim().toLowerCase();
  return normalized || 'unknown';
}

function buildLifecycleHotspotKey(input: {
  targetType?: unknown;
  currentStatus?: unknown;
  attemptedStatus?: unknown;
  refreshRequired?: unknown;
}): string {
  const targetType = normalizeHotspotPart(input.targetType);
  const currentStatus = normalizeHotspotPart(input.currentStatus);
  const attemptedStatus = normalizeHotspotPart(input.attemptedStatus);
  const refreshRequired = input.refreshRequired === true ? '1' : '0';
  return `${targetType}|${currentStatus}|${attemptedStatus}|${refreshRequired}`;
}

async function readLifecycleHotspotAcknowledgements(): Promise<LifecycleHotspotAcknowledgementMap> {
  const config = await Config.findOne({ key: LIFECYCLE_HOTSPOT_ACK_CONFIG_KEY }).lean().exec();
  const value = config?.value;
  if (!value || typeof value !== 'object') return {};
  return value as LifecycleHotspotAcknowledgementMap;
}

function getLifecycleEscalationProfile(targetType?: string): LifecycleEscalationProfile {
  const normalized = String(targetType || '').toLowerCase();

  if (normalized === 'payments' || normalized === 'cash') {
    return {
      ownerTeam: 'Cash Operations',
      ownerRole: 'Cashier Supervisor',
      slaHours: 2,
      runbookPath: '/help/payments/payment-stage-status-reference#overview',
    };
  }

  if (normalized === 'blueprints' || normalized === 'fabrication' || normalized === 'projects') {
    return {
      ownerTeam: 'Project Operations',
      ownerRole: 'Engineering Lead',
      slaHours: 4,
      runbookPath: '/help/projects-fabrication/project-statuses#overview',
    };
  }

  if (normalized === 'appointments' || normalized === 'visit-reports') {
    return {
      ownerTeam: 'Sales Operations',
      ownerRole: 'Sales Supervisor',
      slaHours: 4,
      runbookPath: '/help/appointments-visits/appointment-status-reference#overview',
    };
  }

  return {
    ownerTeam: 'Platform Operations',
    ownerRole: 'Admin',
    slaHours: 8,
    runbookPath: '/help/projects-fabrication/project-statuses#overview',
  };
}

// ── Recent Audit Logs (Admin) ──

export async function getRecentAuditLogs(query: {
  limit?: number;
  page?: number;
  action?: string;
  targetType?: string;
  targetId?: string;
  actorId?: string;
  /** YYYY-MM-DD, Manila time */
  dateFrom?: string;
  dateTo?: string;
}) {
  const limit = Math.min(Math.max(query.limit ?? 5, 1), 100);
  const page = Math.max(query.page ?? 1, 1);
  const skip = (page - 1) * limit;

  // Activity Log filters: what happened, to which record, by whom, and when.
  const filter: Record<string, unknown> = {};
  if (query.action) filter.action = query.action;
  if (query.targetType) filter.targetType = query.targetType;
  if (query.targetId && /^[a-f\d]{24}$/i.test(query.targetId)) filter.targetId = query.targetId;
  if (query.actorId && /^[a-f\d]{24}$/i.test(query.actorId)) filter.actorId = query.actorId;
  const createdAt: Record<string, Date> = {};
  if (query.dateFrom && /^\d{4}-\d{2}-\d{2}$/.test(query.dateFrom)) createdAt.$gte = new Date(`${query.dateFrom}T00:00:00+08:00`);
  if (query.dateTo && /^\d{4}-\d{2}-\d{2}$/.test(query.dateTo)) createdAt.$lte = new Date(`${query.dateTo}T23:59:59.999+08:00`);
  if (Object.keys(createdAt).length) filter.createdAt = createdAt;

  const [items, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('actorId', 'firstName lastName email roles')
      .lean()
      .exec(),
    AuditLog.countDocuments(filter).exec(),
  ]);

  return {
    items,
    total,
    page,
    limit,
    hasMore: skip + items.length < total,
  };
}

// ── Lifecycle Mismatch Hotspots (Admin) ──

export async function getLifecycleMismatchHotspots(query: {
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
}) {
  const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);

  const match: Record<string, unknown> = {
    action: AuditAction.LIFECYCLE_MISMATCH_BLOCKED,
  };

  if (query.dateFrom || query.dateTo) {
    match.createdAt = {};
    if (query.dateFrom) (match.createdAt as Record<string, unknown>).$gte = new Date(query.dateFrom);
    if (query.dateTo) (match.createdAt as Record<string, unknown>).$lte = new Date(`${query.dateTo}T23:59:59.999Z`);
  }

  const rows = await AuditLog.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          targetType: '$targetType',
          currentStatus: '$details.currentStatus',
          attemptedStatus: '$details.attemptedStatus',
          refreshRequired: '$details.refreshRequired',
        },
        count: { $sum: 1 },
        lastSeenAt: { $max: '$createdAt' },
      },
    },
    { $sort: { count: -1, lastSeenAt: -1 } },
    { $limit: limit },
    {
      $project: {
        _id: 0,
        targetType: '$_id.targetType',
        currentStatus: '$_id.currentStatus',
        attemptedStatus: '$_id.attemptedStatus',
        refreshRequired: '$_id.refreshRequired',
        count: 1,
        lastSeenAt: 1,
      },
    },
  ]).exec();

  const acknowledgements = await readLifecycleHotspotAcknowledgements();

  const [total, refreshRequiredTotal, byTargetType] = await Promise.all([
    AuditLog.countDocuments(match).exec(),
    AuditLog.countDocuments({ ...match, 'details.refreshRequired': true }).exec(),
    AuditLog.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$targetType',
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      {
        $project: {
          _id: 0,
          targetType: { $ifNull: ['$_id', 'unknown'] },
          count: 1,
        },
      },
    ]).exec(),
  ]);

  let previousWindowTotal: number | null = null;
  let trendDelta: number | null = null;
  let trendPercent: number | null = null;

  if (query.dateFrom && query.dateTo) {
    const windowStart = new Date(query.dateFrom);
    const windowEnd = new Date(`${query.dateTo}T23:59:59.999Z`);
    const windowMs = windowEnd.getTime() - windowStart.getTime() + 1;

    if (windowMs > 0) {
      const previousEnd = new Date(windowStart.getTime() - 1);
      const previousStart = new Date(previousEnd.getTime() - windowMs + 1);

      previousWindowTotal = await AuditLog.countDocuments({
        action: AuditAction.LIFECYCLE_MISMATCH_BLOCKED,
        createdAt: {
          $gte: previousStart,
          $lte: previousEnd,
        },
      }).exec();

      trendDelta = total - previousWindowTotal;
      trendPercent = previousWindowTotal > 0
        ? Math.round((trendDelta / previousWindowTotal) * 1000) / 10
        : (total > 0 ? 100 : 0);
    }
  }

  const topTargetType = byTargetType[0]?.targetType;
  const escalationSummary = getLifecycleEscalationProfile(topTargetType);
  const enrichedRows = rows.map((row) => {
    const hotspotKey = buildLifecycleHotspotKey(row);
    const acknowledgement = acknowledgements[hotspotKey];
    return {
      ...row,
      hotspotKey,
      isAcknowledged: !!acknowledgement,
      acknowledgedAt: acknowledgement?.acknowledgedAt,
      acknowledgedBy: acknowledgement?.acknowledgedBy,
      acknowledgmentNote: acknowledgement?.note,
      escalation: getLifecycleEscalationProfile(row.targetType),
    };
  });

  const sortedRows = enrichedRows.sort((a, b) => {
    if (a.isAcknowledged !== b.isAcknowledged) {
      return a.isAcknowledged ? 1 : -1;
    }
    if (b.count !== a.count) return b.count - a.count;
    const aTime = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
    const bTime = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0;
    return bTime - aTime;
  });

  const limitedRows = sortedRows.slice(0, limit);
  const acknowledgedCount = limitedRows.filter((row) => row.isAcknowledged).length;
  const unacknowledgedCount = limitedRows.length - acknowledgedCount;

  return {
    total,
    limit,
    refreshRequiredTotal,
    byTargetType,
    acknowledgedCount,
    unacknowledgedCount,
    escalationSummary: {
      topTargetType: topTargetType || 'unknown',
      ...escalationSummary,
    },
    trend: {
      previousWindowTotal,
      trendDelta,
      trendPercent,
    },
    items: limitedRows,
  };
}

export async function acknowledgeLifecycleMismatchHotspot(
  input: LifecycleHotspotAcknowledgeInput,
  actorId: string,
  ip?: string,
  userAgent?: string,
) {
  const hotspotKey = buildLifecycleHotspotKey(input);
  const acknowledgements = await readLifecycleHotspotAcknowledgements();
  const shouldAcknowledge = input.acknowledged !== false;

  if (shouldAcknowledge) {
    acknowledgements[hotspotKey] = {
      acknowledgedAt: new Date().toISOString(),
      acknowledgedBy: actorId,
      note: input.note?.trim() || undefined,
    };
  } else {
    delete acknowledgements[hotspotKey];
  }

  await Config.findOneAndUpdate(
    { key: LIFECYCLE_HOTSPOT_ACK_CONFIG_KEY },
    {
      value: acknowledgements,
      description: 'Lifecycle mismatch hotspot acknowledgement state',
      updatedBy: actorId,
    },
    { upsert: true, new: true },
  ).exec();

  await AuditLog.create({
    action: AuditAction.LIFECYCLE_HOTSPOT_ACKNOWLEDGED,
    actorId,
    targetType: 'reports',
    details: {
      hotspotKey,
      acknowledged: shouldAcknowledge,
      note: input.note?.trim() || undefined,
      targetType: normalizeHotspotPart(input.targetType),
      currentStatus: normalizeHotspotPart(input.currentStatus),
      attemptedStatus: normalizeHotspotPart(input.attemptedStatus),
      refreshRequired: input.refreshRequired === true,
    },
    ipAddress: ip,
    userAgent,
  });

  return {
    hotspotKey,
    acknowledged: shouldAcknowledge,
    acknowledgedAt: shouldAcknowledge ? acknowledgements[hotspotKey]?.acknowledgedAt : null,
    acknowledgedBy: shouldAcknowledge ? actorId : null,
  };
}

// ── Revenue Report (Admin + Cashier) ──

const MAX_REPORTABLE_PAYMENT_AMOUNT = 999_999_999;

export async function getRevenueReport(query: {
  dateFrom?: string;
  dateTo?: string;
  groupBy?: string; // 'day' | 'week' | 'month'
}) {
  const filter: Record<string, unknown> = {
    status: PaymentStageStatus.VERIFIED,
    amountPaid: { $lte: MAX_REPORTABLE_PAYMENT_AMOUNT },
  };

  if (query.dateFrom || query.dateTo) {
    filter.verifiedAt = {};
    if (query.dateFrom) (filter.verifiedAt as Record<string, unknown>).$gte = new Date(query.dateFrom);
    if (query.dateTo) (filter.verifiedAt as Record<string, unknown>).$lte = new Date(query.dateTo + 'T23:59:59.999Z');
  }

  const payments = await Payment.find(filter).sort({ verifiedAt: 1 });

  const totalRevenue = payments.reduce((sum, p) => sum + p.amountPaid, 0);
  const totalPayments = payments.length;

  // Group by period
  const groupBy = query.groupBy || 'month';
  const grouped: Record<string, { revenue: number; count: number }> = {};

  for (const payment of payments) {
    let key: string;
    const date = payment.verifiedAt!;

    if (groupBy === 'day') {
      key = date.toISOString().split('T')[0];
    } else if (groupBy === 'week') {
      const d = new Date(date);
      const dayOfWeek = d.getDay();
      d.setDate(d.getDate() - dayOfWeek);
      key = `Week of ${d.toISOString().split('T')[0]}`;
    } else {
      key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    }

    if (!grouped[key]) grouped[key] = { revenue: 0, count: 0 };
    grouped[key].revenue += payment.amountPaid;
    grouped[key].count += 1;
  }

  // By payment method
  const byMethod: Record<string, number> = {};
  for (const payment of payments) {
    if (!byMethod[payment.method]) byMethod[payment.method] = 0;
    byMethod[payment.method] += payment.amountPaid;
  }

  return {
    totalRevenue,
    totalPayments,
    byPeriod: Object.entries(grouped).map(([period, data]) => ({
      period,
      ...data,
    })),
    byPaymentMethod: Object.entries(byMethod).map(([method, amount]) => ({
      method,
      amount,
    })),
  };
}

// ── Payment Stage Breakdown ──

export async function getPaymentStageReport(query: {
  dateFrom?: string;
  dateTo?: string;
}) {
  const filter: Record<string, unknown> = {};
  if (query.dateFrom || query.dateTo) {
    filter.createdAt = {};
    if (query.dateFrom) (filter.createdAt as Record<string, unknown>).$gte = new Date(query.dateFrom);
    if (query.dateTo) (filter.createdAt as Record<string, unknown>).$lte = new Date(query.dateTo + 'T23:59:59.999Z');
  }

  const plans = await PaymentPlan.find(filter);

  const statusCounts: Record<string, number> = {};
  let totalAmount = 0;
  let totalPaid = 0;

  for (const plan of plans) {
    for (const stage of plan.stages) {
      if (!statusCounts[stage.status]) statusCounts[stage.status] = 0;
      statusCounts[stage.status] += 1;
      totalAmount += stage.amount;
      totalPaid += stage.amountPaid;
    }
  }

  return {
    totalPlans: plans.length,
    totalAmount,
    totalPaid,
    totalOutstanding: totalAmount - totalPaid,
    byStatus: Object.entries(statusCounts).map(([status, count]) => ({
      status,
      count,
    })),
  };
}

// ── Outstanding Payments ──

export async function getOutstandingReport() {
  const plans = await PaymentPlan.find()
    .populate('projectId', 'title customerId salesStaffId');

  const outstanding = plans
    .filter(plan => plan.stages.some(s => s.remainingBalance > 0))
    .map(plan => ({
      projectId: plan.projectId,
      totalAmount: plan.totalAmount,
      totalPaid: plan.stages.reduce((sum, s) => sum + s.amountPaid, 0),
      totalOutstanding: plan.stages.reduce((sum, s) => sum + s.remainingBalance, 0),
      stages: plan.stages.map(s => ({
        label: s.label,
        amount: s.amount,
        paid: s.amountPaid,
        remaining: s.remainingBalance,
        status: s.status,
      })),
    }));

  return {
    totalOutstanding: outstanding.reduce((sum, o) => sum + o.totalOutstanding, 0),
    projects: outstanding,
  };
}

// ── Project Pipeline (active projects by status) ──

export async function getProjectPipelineReport() {
  const pipeline = await Project.aggregate([
    { $match: { deletedAt: null, status: { $ne: ProjectStatus.CANCELLED } } },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const total = pipeline.reduce((sum, p) => sum + p.count, 0);

  return {
    total,
    byStatus: pipeline.map(p => ({
      status: p._id,
      count: p.count,
      percentage: total > 0 ? Math.round((p.count / total) * 100) : 0,
    })),
  };
}

// ── Staff Workload Report ──

export async function getWorkloadReport() {
  // Active projects per engineer
  const engineerWorkload = await Project.aggregate([
    { $match: { deletedAt: null, status: { $nin: [ProjectStatus.COMPLETED, ProjectStatus.CANCELLED] } } },
    { $unwind: '$engineerIds' },
    {
      $group: {
        _id: '$engineerIds',
        activeProjects: { $sum: 1 },
      },
    },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'engineer',
      },
    },
    { $unwind: '$engineer' },
    {
      $project: {
        _id: 1,
        name: { $concat: ['$engineer.firstName', ' ', '$engineer.lastName'] },
        activeProjects: 1,
      },
    },
    { $sort: { activeProjects: -1 } },
  ]);

  // Active projects per fabrication lead
  const fabWorkload = await Project.aggregate([
    {
      $match: {
        deletedAt: null,
        status: ProjectStatus.FABRICATION,
        fabricationLeadId: { $exists: true },
      },
    },
    {
      $group: {
        _id: '$fabricationLeadId',
        activeProjects: { $sum: 1 },
      },
    },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'staff',
      },
    },
    { $unwind: '$staff' },
    {
      $project: {
        _id: 1,
        name: { $concat: ['$staff.firstName', ' ', '$staff.lastName'] },
        activeProjects: 1,
      },
    },
    { $sort: { activeProjects: -1 } },
  ]);

  // Appointments per sales staff (this month)
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const nextMonth = now.getMonth() === 11
    ? `${now.getFullYear() + 1}-01-01`
    : `${now.getFullYear()}-${String(now.getMonth() + 2).padStart(2, '0')}-01`;

  const salesWorkload = await Appointment.aggregate([
    {
      $match: {
        date: { $gte: monthStart, $lt: nextMonth },
        status: { $ne: AppointmentStatus.CANCELLED },
        salesStaffId: { $exists: true },
      },
    },
    {
      $group: {
        _id: '$salesStaffId',
        appointments: { $sum: 1 },
      },
    },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'staff',
      },
    },
    { $unwind: '$staff' },
    {
      $project: {
        _id: 1,
        name: { $concat: ['$staff.firstName', ' ', '$staff.lastName'] },
        appointments: 1,
      },
    },
    { $sort: { appointments: -1 } },
  ]);

  return {
    engineers: engineerWorkload,
    fabrication: fabWorkload,
    sales: salesWorkload,
  };
}

// ── Appointment Conversion Report ──

export async function getConversionReport(query: {
  dateFrom?: string;
  dateTo?: string;
}) {
  const filter: Record<string, unknown> = {};
  if (query.dateFrom) filter.date = { ...(filter.date as object || {}), $gte: query.dateFrom };
  if (query.dateTo) filter.date = { ...(filter.date as object || {}), $lte: query.dateTo };

  const appointments = await Appointment.find(filter);

  const totalAppointments = appointments.length;
  // No-show and declined consultations close as completed; attendanceStatus keeps the outcome.
  const isNoShow = (a: (typeof appointments)[number]) => a.status === AppointmentStatus.NO_SHOW
    || a.attendanceStatus === AppointmentAttendanceStatus.NO_SHOW;
  const isHeldConsultation = (a: (typeof appointments)[number]) => a.status === AppointmentStatus.COMPLETED
    && a.attendanceStatus !== AppointmentAttendanceStatus.NO_SHOW
    && a.attendanceStatus !== AppointmentAttendanceStatus.CUSTOMER_DECLINED;
  const completed = appointments.filter(isHeldConsultation).length;
  const cancelled = appointments.filter(a => a.status === AppointmentStatus.CANCELLED).length;
  const noShow = appointments.filter(isNoShow).length;

  // Count how many completed appointments resulted in projects
  const completedIds = appointments
    .filter(isHeldConsultation)
    .map(a => a._id);

  const projectsCreated = await Project.countDocuments({
    appointmentId: { $in: completedIds },
  });

  const byType = {
    office: appointments.filter(a => a.type === AppointmentType.OFFICE).length,
    ocular: appointments.filter(a => a.type === AppointmentType.OCULAR).length,
  };

  return {
    totalAppointments,
    completed,
    cancelled,
    noShow,
    projectsCreated,
    conversionRate: completed > 0
      ? Math.round((projectsCreated / completed) * 100)
      : 0,
    completionRate: totalAppointments > 0
      ? Math.round((completed / totalAppointments) * 100)
      : 0,
    byType,
  };
}

// ── Dashboard Summary ──

async function countUnpaidProjects(projectIds: Types.ObjectId[] | null) {
  const plans = await PaymentPlan.find({
    ...(projectIds ? { projectId: { $in: projectIds } } : {}),
    stages: { $elemMatch: { status: { $ne: PaymentStageStatus.VERIFIED }, amount: { $gt: 0 } } },
  })
    .select('projectId stages.status stages.amount stages.amountPaid')
    .populate<{ projectId: { _id: Types.ObjectId; status: ProjectStatus; deletedAt?: Date | null } | null }>(
      'projectId', 'status deletedAt',
    )
    .lean()
    .exec();

  const unpaidProjects = new Set<string>();
  for (const plan of plans) {
    const project = plan.projectId;
    if (!project || project.deletedAt || project.status === ProjectStatus.CANCELLED) continue;
    const hasBalance = plan.stages.some(stage =>
      stage.status !== PaymentStageStatus.VERIFIED
      && Math.round(stage.amount * 100) > Math.round((stage.amountPaid ?? 0) * 100),
    );
    if (hasBalance) unpaidProjects.add(String(project._id));
  }
  return unpaidProjects.size;
}

const CLOSED_APPOINTMENT_STATUSES = [
  AppointmentStatus.CANCELLED,
  AppointmentStatus.COMPLETED,
  AppointmentStatus.NO_SHOW,
];

/** Today's date in Manila (YYYY-MM-DD), the format appointment dates are stored in. */
function manilaToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
}

/**
 * Customer dashboard numbers, counted with the same rules as the lists each card opens:
 * - projects: the customer visibility rule and the Projects page listing stages
 * - Pending Visits: the Requested + Assigned appointment status groups
 * - Pending Payments: projects in the Payments "Needs Payment" filter + unpaid ocular fees
 */
async function getCustomerDashboardCounts(customerId: string) {
  const projects = await Project.find(customerVisibleProjectsFilter(customerId))
    .select('_id status designFee')
    .lean()
    .exec();

  const [stages, paymentDue, unpaidOcularFees, pendingVisits] = await Promise.all([
    resolveProjectStages(projects),
    getProjectPaymentDue(projects),
    Appointment.countDocuments({
      customerId,
      type: AppointmentType.OCULAR,
      ocularFeeStatus: 'pending',
      ocularFee: { $gt: 0 },
      status: { $nin: CLOSED_APPOINTMENT_STATUSES },
      date: { $gte: manilaToday() },
    }).exec(),
    Appointment.countDocuments({
      customerId,
      $or: [
        buildAppointmentStatusGroupFilter('requested')!,
        buildAppointmentStatusGroupFilter('assigned')!,
      ],
    }).exec(),
  ]);

  let completed = 0;
  let cancelled = 0;
  let fabrication = 0;
  for (const stage of stages.values()) {
    if (stage === 'completed') completed += 1;
    else if (stage === 'cancelled') cancelled += 1;
    else if (stage === 'fabrication') fabrication += 1;
  }
  const projectsNeedingPayment = [...paymentDue.values()].filter((due) => due.needsPayment).length;

  return {
    projectIds: projects.map((project) => project._id as Types.ObjectId),
    totalProjects: projects.length,
    activeProjects: projects.length - completed - cancelled,
    completedProjects: completed,
    fabricationInProgress: fabrication,
    pendingAppointments: pendingVisits,
    pendingPayments: projectsNeedingPayment + unpaidOcularFees,
  };
}

export async function getDashboardSummary(userId?: string, userRoles?: string[]) {
  try {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // Determine if the caller is a pure customer (no staff/admin roles)
    const isCustomerOnly = userRoles?.includes(Role.CUSTOMER)
      && !userRoles?.some(r => [Role.ADMIN, Role.APPOINTMENT_AGENT, Role.SALES_STAFF, Role.ENGINEER, Role.CASHIER].includes(r as Role));

    // Appointment filter: scope to the customer's own appointments when applicable
    const appointmentBaseFilter = isCustomerOnly && userId ? { customerId: userId } : {};

    // Customers get counts that match the filtered lists their dashboard cards open.
    const customerCounts = isCustomerOnly && userId ? await getCustomerDashboardCounts(userId) : null;

    const [
      totalProjects,
      activeProjects,
      completedProjects,
      pendingPayments,
      unpaidProjects,
      revenueResult,
      pendingAppointments,
      totalAppointmentsToday,
      fabricationInProgress,
      pendingVisitReports,
      pendingCashPayments,
      totalUsers,
      pendingBlueprints,
      completedToday,
    ] = await Promise.all([
      customerCounts
        ? Promise.resolve(customerCounts.totalProjects)
        : Project.countDocuments({ deletedAt: null }).exec(),
      customerCounts ? Promise.resolve(customerCounts.activeProjects) : Project.countDocuments({
        deletedAt: null,
        status: userRoles?.includes(Role.SALES_STAFF) && !userRoles.includes(Role.ADMIN)
          ? { $in: activeProjectStatusesForRoles(userRoles as Role[]) }
          : { $nin: [ProjectStatus.COMPLETED, ProjectStatus.CANCELLED] },
        ...(userRoles?.includes(Role.ENGINEER) && !userRoles?.some(r => [Role.ADMIN, Role.SALES_STAFF].includes(r as Role))
          ? { $or: [{ engineerIds: userId }, { status: ProjectStatus.SUBMITTED, engineerIds: { $size: 0 } }] }
          : userRoles?.includes(Role.FABRICATION_STAFF) && !userRoles?.some(r => [Role.ADMIN, Role.ENGINEER].includes(r as Role))
            ? { status: ProjectStatus.FABRICATION }
            : userRoles?.includes(Role.SALES_STAFF) && !userRoles?.includes(Role.ADMIN)
              ? { salesStaffId: userId }
              : userRoles?.includes(Role.CUSTOMER) && !userRoles?.some(r => [Role.ADMIN, Role.SALES_STAFF, Role.ENGINEER].includes(r as Role))
                ? { customerId: userId }
                : {}),
      }).exec(),
      customerCounts
        ? Promise.resolve(customerCounts.completedProjects)
        : Project.countDocuments({ deletedAt: null, status: ProjectStatus.COMPLETED }).exec(),
      // Customers: payments they must act on now. Staff: proofs waiting for cashier review.
      customerCounts
        ? Promise.resolve(customerCounts.pendingPayments)
        : Payment.countDocuments({ status: PaymentStageStatus.PROOF_SUBMITTED }).exec(),
      // Count projects with an unsettled balance, independently of submitted payment records.
      countUnpaidProjects(customerCounts ? customerCounts.projectIds : null),
      Payment.aggregate([
        { $match: { status: PaymentStageStatus.VERIFIED, verifiedAt: { $gte: monthStart }, amountPaid: { $lte: MAX_REPORTABLE_PAYMENT_AMOUNT } } },
        { $group: { _id: null, total: { $sum: '$amountPaid' } } },
      ]).exec(),
      customerCounts ? Promise.resolve(customerCounts.pendingAppointments) : Appointment.countDocuments({
        ...appointmentBaseFilter,
        status: { $in: [AppointmentStatus.REQUESTED, AppointmentStatus.RESCHEDULE_REQUESTED] },
      }).exec(),
      Appointment.countDocuments({
        ...appointmentBaseFilter,
        date: todayStr,
        status: { $in: [AppointmentStatus.CONFIRMED, AppointmentStatus.ASSIGNED, AppointmentStatus.REQUESTED] },
      }).exec(),
      customerCounts ? Promise.resolve(customerCounts.fabricationInProgress) : Project.countDocuments({
        deletedAt: null,
        status: ProjectStatus.FABRICATION,
        ...(userRoles?.includes(Role.ENGINEER)
          && !userRoles?.some(r => [Role.ADMIN, Role.SALES_STAFF].includes(r as Role))
          && userId
          ? { engineerIds: userId }
          : {}),
      }).exec(),
      // Count draft/returned visit reports for the current user (sales staff KPI)
      userId && userRoles?.includes(Role.SALES_STAFF)
        ? countPendingReportGroupsForSalesStaff(userId)
        : Promise.resolve(0),
      // Count appointments with pending cash payment (scoped to sales staff)
      Appointment.countDocuments({
        ocularFeeStatus: 'cash_pending',
        ...(userRoles?.includes(Role.SALES_STAFF) && !userRoles?.includes(Role.ADMIN) && userId
          ? { salesStaffId: userId }
          : {}),
      }).exec(),
      // Admin-only: total active users
      User.countDocuments({ isActive: true }).exec(),
      // Admin-only: blueprints pending customer review
      Blueprint.countDocuments({ status: { $in: ['uploaded', 'revision_uploaded'] } }).exec(),
      // Fab-staff: fabrication updates made today 
      FabricationUpdate.countDocuments({
        createdAt: { $gte: startOfToday },
        ...(userId && userRoles?.includes(Role.FABRICATION_STAFF) && !userRoles?.includes(Role.ADMIN)
          ? { updatedBy: userId }
          : {}),
      }).exec(),
    ]);

    const revenueThisMonth = revenueResult?.[0]?.total ?? 0;

    // Conversion rate: completed / total (avoid div by zero)
    const conversionRate = totalProjects > 0 ? completedProjects / totalProjects : 0;

    // ── Pending installation confirmations (customer-facing) ──
    // Legacy projects confirm after fabrication; on-site projects confirm before completion.
    let pendingInstallationConfirmations: { _id: string; title: string }[] = [];
    if (isCustomerOnly && userId) {
      const readyProjects = await FabricationUpdate.aggregate([
        { $sort: { createdAt: -1 as const } },
        { $group: { _id: '$projectId', latestStatus: { $first: '$status' } } },
        { $match: { latestStatus: FabricationStatus.READY_FOR_DELIVERY } },
      ]).exec();
      const readyProjectIds = readyProjects.map(r => r._id);
      pendingInstallationConfirmations = await Project.find({
          $or: [
            { _id: { $in: readyProjectIds } },
            { deliveryType: DeliveryType.ON_SITE_INSTALLATION, status: ProjectStatus.FABRICATION },
          ],
          customerId: userId,
          installationConfirmedAt: null,
          deletedAt: null,
        }).select('_id title').lean().exec() as unknown as { _id: string; title: string }[];
    }

    return {
      totalProjects,
      activeProjects,
      completedProjects,
      pendingPayments,
      unpaidProjects,
      revenueThisMonth,
      totalRevenue: revenueThisMonth,
      pendingAppointments,
      totalAppointmentsToday,
      todayAppointments: totalAppointmentsToday,
      fabricationInProgress,
      conversionRate,
      pendingVisitReports,
      pendingCashPayments,
      totalUsers,
      pendingBlueprints,
      completedToday,
      pendingInstallationConfirmations,
    };
  } catch (error) {
    console.error('getDashboardSummary error:', error);
    // Return safe defaults so the dashboard doesn't crash
    return {
      totalProjects: 0,
      activeProjects: 0,
      completedProjects: 0,
      pendingPayments: 0,
      unpaidProjects: 0,
      revenueThisMonth: 0,
      totalRevenue: 0,
      pendingAppointments: 0,
      totalAppointmentsToday: 0,
      todayAppointments: 0,
      fabricationInProgress: 0,
      conversionRate: 0,
      pendingVisitReports: 0,
      pendingCashPayments: 0,
      totalUsers: 0,
      pendingBlueprints: 0,
      completedToday: 0,
      pendingInstallationConfirmations: [],
    };
  }
}
