import { formatInTimeZone } from 'date-fns-tz';
import { Appointment, Payment, PaymentPlan } from '../../models/index.js';

/**
 * Transaction History (admin + cashier): every payment record in one list.
 * Sources: Payment documents (project stages, design/revision fees, ocular booking fees) and
 * older ocular fees that live only on the Appointment. On-site cash collections (CashCollection)
 * are a staff turnover, not a customer payment, and stay on the Cash Flow page.
 */

const TZ = 'Asia/Manila';
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
export const TRANSACTION_EXPORT_LIMIT = 5000;

export const TRANSACTION_TYPES = ['project_payment', 'design_fee', 'revision_fee', 'ocular_fee'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];
export const TRANSACTION_STATUSES = ['verified', 'pending', 'rejected'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export interface TransactionQuery {
  dateFrom?: string;
  dateTo?: string;
  type?: TransactionType;
  method?: string;
  status?: TransactionStatus;
  search?: string;
  page?: string | number;
  limit?: string | number;
}

export interface TransactionRow {
  _id: string;
  source: 'payment' | 'appointment';
  date: string;
  type: TransactionType;
  description: string;
  customerName: string;
  projectId?: string;
  projectNumber?: string;
  appointmentId?: string;
  appointmentNumber?: string;
  method?: string;
  amount: number;
  status: TransactionStatus;
  referenceNumber?: string;
  receiptNumber?: string;
  hasReceipt: boolean;
  handledBy?: string;
  handledAt?: string;
  rejectionReason?: string;
}

export interface TransactionSummary {
  count: number;
  verifiedTotal: number;
  pendingTotal: number;
  rejectedCount: number;
  byMethod: Array<{ method: string; amount: number }>;
}

const VERIFIED_VALUES = new Set(['paid', 'verified']);
const REJECTED_VALUES = new Set(['rejected', 'declined']);

/** paid/verified → verified; rejected/declined → rejected; anything still waiting → pending. */
export function normalizeTransactionStatus(value: string | undefined | null): TransactionStatus {
  const status = String(value || '').toLowerCase();
  if (VERIFIED_VALUES.has(status)) return 'verified';
  if (REJECTED_VALUES.has(status)) return 'rejected';
  return 'pending';
}

export function classifyPaymentType(payment: { bookingId?: unknown; stageId?: string }): TransactionType {
  if (payment.bookingId) return 'ocular_fee';
  if (payment.stageId?.startsWith('design-fee-')) return 'design_fee';
  if (payment.stageId?.startsWith('revision-fee-')) return 'revision_fee';
  return 'project_payment';
}

const fullName = (person: any) => (person && typeof person === 'object'
  ? `${String(person.firstName || '').trim()} ${String(person.lastName || '').trim()}`.trim()
  : '');
const idOf = (value: any) => (value && typeof value === 'object' && value._id ? String(value._id) : value ? String(value) : undefined);
const toIso = (value: unknown) => (value ? new Date(value as string | Date).toISOString() : undefined);

function createdAtRange(query: TransactionQuery) {
  if (!query.dateFrom && !query.dateTo) return undefined;
  const range: Record<string, Date> = {};
  if (query.dateFrom) range.$gte = new Date(`${query.dateFrom}T00:00:00.000+08:00`);
  if (query.dateTo) range.$lte = new Date(`${query.dateTo}T23:59:59.999+08:00`);
  return range;
}

async function loadStageLabels(projectIds: string[]) {
  const labels = new Map<string, string>();
  if (!projectIds.length) return labels;
  const plans = await PaymentPlan.find({ projectId: { $in: projectIds } }).select('stages.stageId stages.label').lean();
  for (const plan of plans as any[]) {
    for (const stage of plan.stages || []) labels.set(String(stage.stageId), String(stage.label));
  }
  return labels;
}

function paymentToRow(payment: any, stageLabels: Map<string, string>): TransactionRow {
  const type = classifyPaymentType(payment);
  const project = payment.projectId && typeof payment.projectId === 'object' ? payment.projectId : null;
  const booking = payment.bookingId && typeof payment.bookingId === 'object' ? payment.bookingId : null;
  const projectTitle = project?.title || 'Project';
  const description = type === 'design_fee'
    ? `Design Fee — ${projectTitle}`
    : type === 'revision_fee'
      ? `Revision Fee — ${projectTitle}`
      : type === 'ocular_fee'
        ? `Ocular Fee${booking?.serviceTypes?.length ? ` — ${booking.serviceTypes.join(', ').replace(/_/g, ' ')}` : ''}`
        : `${stageLabels.get(String(payment.stageId)) || 'Project Payment'} — ${projectTitle}`;
  const handler = payment.verifiedBy || payment.rejectedBy;

  return {
    _id: String(payment._id),
    source: 'payment',
    date: toIso(payment.createdAt)!,
    type,
    description,
    customerName: fullName(payment.customerId) || fullName(project?.customerId) || 'Unknown Customer',
    projectId: idOf(payment.projectId),
    projectNumber: project?.projectNumber,
    appointmentId: idOf(payment.bookingId),
    appointmentNumber: booking?.appointmentNumber,
    method: payment.method,
    amount: Number(payment.amountPaid || 0),
    status: normalizeTransactionStatus(payment.paymentStatus || payment.status),
    referenceNumber: payment.gcashReferenceNumber || payment.referenceNumber,
    receiptNumber: payment.receiptNumber,
    hasReceipt: Boolean(payment.receiptKey),
    handledBy: fullName(handler) || undefined,
    handledAt: toIso(payment.verifiedAt || payment.rejectedAt),
    rejectionReason: payment.rejectionReason || payment.declineReason,
  };
}

function legacyOcularToRow(appointment: any): TransactionRow {
  const status: TransactionStatus = appointment.ocularFeePaid
    ? 'verified'
    : normalizeTransactionStatus(appointment.ocularFeeStatus);
  return {
    _id: String(appointment._id),
    source: 'appointment',
    date: toIso(appointment.createdAt)!,
    type: 'ocular_fee',
    description: `Ocular Fee${appointment.serviceTypes?.length ? ` — ${appointment.serviceTypes.join(', ').replace(/_/g, ' ')}` : ''}`,
    customerName: fullName(appointment.customerId) || 'Unknown Customer',
    appointmentId: String(appointment._id),
    appointmentNumber: appointment.appointmentNumber,
    method: appointment.ocularFeePaymentMethod,
    amount: Number(appointment.ocularFee || 0),
    status,
    hasReceipt: false,
  };
}

function matchesSearch(row: TransactionRow, search: string) {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return [row.customerName, row.projectNumber, row.appointmentNumber, row.receiptNumber, row.referenceNumber, row.description]
    .some((value) => value?.toLowerCase().includes(needle));
}

/** Filters the normalized rows (type/status/search) and sorts newest first. */
export function filterTransactionRows(rows: TransactionRow[], query: TransactionQuery) {
  return rows
    .filter((row) => !query.type || row.type === query.type)
    .filter((row) => !query.status || row.status === query.status)
    .filter((row) => !query.search || matchesSearch(row, query.search))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

export function summarizeTransactions(rows: TransactionRow[]): TransactionSummary {
  const byMethod = new Map<string, number>();
  let verifiedTotal = 0;
  let pendingTotal = 0;
  let rejectedCount = 0;
  for (const row of rows) {
    if (row.status === 'verified') {
      verifiedTotal += row.amount;
      const method = row.method || 'unspecified';
      byMethod.set(method, (byMethod.get(method) || 0) + row.amount);
    } else if (row.status === 'pending') {
      pendingTotal += row.amount;
    } else {
      rejectedCount += 1;
    }
  }
  return {
    count: rows.length,
    verifiedTotal,
    pendingTotal,
    rejectedCount,
    byMethod: [...byMethod.entries()].map(([method, amount]) => ({ method, amount })),
  };
}

/** Every transaction matching the filters, newest first. */
export async function listTransactionRows(query: TransactionQuery): Promise<TransactionRow[]> {
  const createdAt = createdAtRange(query);
  const paymentFilter: Record<string, unknown> = {};
  if (createdAt) paymentFilter.createdAt = createdAt;
  if (query.method) paymentFilter.method = query.method;

  const wantsOcular = !query.type || query.type === 'ocular_fee';
  const [payments, bookingIdsWithPayment] = await Promise.all([
    Payment.find(paymentFilter)
      .populate('customerId', 'firstName lastName')
      .populate({ path: 'projectId', select: 'title projectNumber customerId', populate: { path: 'customerId', select: 'firstName lastName' } })
      .populate('bookingId', 'appointmentNumber serviceTypes date')
      .populate('verifiedBy', 'firstName lastName')
      .populate('rejectedBy', 'firstName lastName')
      .lean(),
    wantsOcular ? Payment.distinct('bookingId', { bookingId: { $exists: true, $ne: null } }) : Promise.resolve([]),
  ]);

  // Ocular fees from before booking payments existed; a booking with its own Payment is listed once.
  const legacyFilter: Record<string, unknown> = {
    type: 'ocular',
    ocularFee: { $gt: 0 },
    $or: [
      { ocularFeePaid: true },
      { ocularFeeStatus: { $in: ['verified', 'proof_submitted', 'cash_pending', 'declined'] } },
    ],
  };
  if (bookingIdsWithPayment.length) legacyFilter._id = { $nin: bookingIdsWithPayment };
  if (createdAt) legacyFilter.createdAt = createdAt;
  if (query.method) legacyFilter.ocularFeePaymentMethod = query.method;
  const legacyOculars = wantsOcular
    ? await Appointment.find(legacyFilter)
      .select('appointmentNumber customerId serviceTypes ocularFee ocularFeePaid ocularFeeStatus ocularFeePaymentMethod createdAt')
      .populate('customerId', 'firstName lastName')
      .lean()
    : [];

  const stageProjectIds = [...new Set((payments as any[])
    .filter((payment) => classifyPaymentType(payment) === 'project_payment')
    .map((payment) => idOf(payment.projectId))
    .filter((id): id is string => Boolean(id)))];
  const stageLabels = await loadStageLabels(stageProjectIds);

  const rows = [
    ...(payments as any[]).map((payment) => paymentToRow(payment, stageLabels)),
    ...(legacyOculars as any[]).map(legacyOcularToRow),
  ];
  return filterTransactionRows(rows, query);
}

export async function listTransactions(query: TransactionQuery) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(Math.max(1, Number(query.limit) || DEFAULT_LIMIT), MAX_LIMIT);
  const rows = await listTransactionRows(query);
  return {
    items: rows.slice((page - 1) * limit, page * limit),
    total: rows.length,
    page,
    limit,
    summary: summarizeTransactions(rows),
  };
}

const TYPE_LABELS: Record<TransactionType, string> = {
  project_payment: 'Project Payment',
  design_fee: 'Design Fee',
  revision_fee: 'Revision Fee',
  ocular_fee: 'Ocular Fee',
};

/** One CSV cell: quoted when needed, and guarded against spreadsheet formula injection. */
export function csvCell(value: unknown) {
  let cell = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`;
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

const formatManila = (iso?: string) => (iso ? formatInTimeZone(new Date(iso), TZ, 'yyyy-MM-dd HH:mm') : '');

export function buildTransactionsCsv(rows: TransactionRow[]) {
  const header = ['Date', 'Receipt No.', 'Type', 'Description', 'Customer', 'Project ID', 'Appointment ID', 'Method', 'Amount', 'Status', 'Reference No.', 'Handled By', 'Handled At'];
  const lines = rows.map((row) => [
    formatManila(row.date),
    row.receiptNumber,
    TYPE_LABELS[row.type],
    row.description,
    row.customerName,
    row.projectNumber,
    row.appointmentNumber,
    row.method?.replace(/_/g, ' '),
    row.amount.toFixed(2),
    row.status,
    row.referenceNumber,
    row.handledBy,
    formatManila(row.handledAt),
  ].map(csvCell).join(','));
  // BOM so Excel opens the file as UTF-8.
  return `﻿${[header.map(csvCell).join(','), ...lines].join('\r\n')}\r\n`;
}
