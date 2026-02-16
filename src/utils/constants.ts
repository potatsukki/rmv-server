// ── Roles ──
export enum Role {
  CUSTOMER = 'customer',
  APPOINTMENT_AGENT = 'appointment_agent',
  SALES_STAFF = 'sales_staff',
  ENGINEER = 'engineer',
  CASHIER = 'cashier',
  ADMIN = 'admin',
  FABRICATION_STAFF = 'fabrication_staff',
}

// ── Appointment Status ──
export enum AppointmentStatus {
  REQUESTED = 'requested',
  CONFIRMED = 'confirmed',
  COMPLETED = 'completed',
  NO_SHOW = 'no_show',
  CANCELLED = 'cancelled',
  RESCHEDULE_REQUESTED = 'reschedule_requested',
}

// ── Appointment Type ──
export enum AppointmentType {
  OFFICE = 'office',
  OCULAR = 'ocular',
}

// ── Slot Codes ──
export const SLOT_CODES = ['09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00'] as const;
export type SlotCode = typeof SLOT_CODES[number];

// ── Project Status ──
export enum ProjectStatus {
  DRAFT = 'draft',
  SUBMITTED = 'submitted',
  BLUEPRINT = 'blueprint',
  APPROVED = 'approved',
  PAYMENT_PENDING = 'payment_pending',
  FABRICATION = 'fabrication',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

// ── Blueprint Status ──
export enum BlueprintStatus {
  UPLOADED = 'uploaded',
  APPROVED = 'approved',
  REVISION_REQUESTED = 'revision_requested',
  REVISION_UPLOADED = 'revision_uploaded',
}

// ── Blueprint Component (separate approval for blueprint vs costing) ──
export enum BlueprintComponent {
  BLUEPRINT = 'blueprint',
  COSTING = 'costing',
}

// ── Payment Stage Status ──
export enum PaymentStageStatus {
  PENDING = 'pending',
  PROOF_SUBMITTED = 'proof_submitted',
  VERIFIED = 'verified',
  DECLINED = 'declined',
}

// ── Payment Method ──
export enum PaymentMethod {
  CASH = 'cash',
  GCASH = 'gcash',
  BANK_TRANSFER = 'bank_transfer',
  PAYMONGO = 'paymongo',
}

// ── Fabrication Status ──
export enum FabricationStatus {
  QUEUED = 'queued',
  MATERIAL_PREP = 'material_prep',
  CUTTING = 'cutting',
  WELDING = 'welding',
  FINISHING = 'finishing',
  QUALITY_CHECK = 'quality_check',
  READY_FOR_DELIVERY = 'ready_for_delivery',
  DONE = 'done',
}

// ── Cash Collection Status ──
export enum CashCollectionStatus {
  COLLECTED = 'collected',
  RECEIVED = 'received',
  DISCREPANCY = 'discrepancy',
}

// ── OTP Purpose ──
export enum OtpPurpose {
  EMAIL_VERIFICATION = 'email_verification',
  PASSWORD_RESET = 'password_reset',
}

// ── Email Log Status ──
export enum EmailLogStatus {
  PENDING = 'pending',
  SENT = 'sent',
  FAILED = 'failed',
}

// ── Notification Category ──
export enum NotificationCategory {
  APPOINTMENT = 'appointment',
  PROJECT = 'project',
  PAYMENT = 'payment',
  BLUEPRINT = 'blueprint',
  FABRICATION = 'fabrication',
  SYSTEM = 'system',
}

// ── Audit Action ──
export enum AuditAction {
  // Auth
  LOGIN = 'login',
  LOGOUT = 'logout',
  LOGIN_FAILED = 'login_failed',
  PASSWORD_CHANGED = 'password_changed',
  PASSWORD_RESET = 'password_reset',
  EMAIL_VERIFIED = 'email_verified',

  // User
  USER_CREATED = 'user_created',
  USER_UPDATED = 'user_updated',
  USER_DISABLED = 'user_disabled',
  USER_ENABLED = 'user_enabled',

  // Appointment
  APPOINTMENT_CREATED = 'appointment_created',
  APPOINTMENT_CONFIRMED = 'appointment_confirmed',
  APPOINTMENT_CANCELLED = 'appointment_cancelled',
  APPOINTMENT_COMPLETED = 'appointment_completed',
  APPOINTMENT_NO_SHOW = 'appointment_no_show',
  APPOINTMENT_RESCHEDULE_REQUESTED = 'appointment_reschedule_requested',
  APPOINTMENT_RESCHEDULED = 'appointment_rescheduled',
  SALES_ASSIGNED = 'sales_assigned',

  // Project
  PROJECT_CREATED = 'project_created',
  PROJECT_UPDATED = 'project_updated',
  PROJECT_CANCELLED = 'project_cancelled',
  PROJECT_COMPLETED = 'project_completed',
  PROJECT_REASSIGNED = 'project_reassigned',

  // Blueprint
  BLUEPRINT_UPLOADED = 'blueprint_uploaded',
  BLUEPRINT_APPROVED = 'blueprint_approved',
  BLUEPRINT_REVISION_REQUESTED = 'blueprint_revision_requested',
  BLUEPRINT_REVISION_UPLOADED = 'blueprint_revision_uploaded',

  // Payment
  PAYMENT_PLAN_CREATED = 'payment_plan_created',
  PAYMENT_PLAN_UPDATED = 'payment_plan_updated',
  PAYMENT_PROOF_SUBMITTED = 'payment_proof_submitted',
  PAYMENT_VERIFIED = 'payment_verified',
  PAYMENT_DECLINED = 'payment_declined',
  RECEIPT_GENERATED = 'receipt_generated',
  RECEIPT_RESENT = 'receipt_resent',

  // Cash
  CASH_COLLECTED = 'cash_collected',
  CASH_RECEIVED = 'cash_received',
  CASH_DISCREPANCY = 'cash_discrepancy',

  // Fabrication
  FABRICATION_ASSIGNED = 'fabrication_assigned',
  FABRICATION_UPDATED = 'fabrication_updated',

  // Visit Report
  VISIT_REPORT_CREATED = 'visit_report_created',
  VISIT_REPORT_UPDATED = 'visit_report_updated',
  VISIT_REPORT_SUBMITTED = 'visit_report_submitted',
  VISIT_REPORT_RETURNED = 'visit_report_returned',
  VISIT_REPORT_COMPLETED = 'visit_report_completed',

  // Config
  CONFIG_UPDATED = 'config_updated',
  HOLIDAY_CREATED = 'holiday_created',
  HOLIDAY_DELETED = 'holiday_deleted',
  MAINTENANCE_TOGGLED = 'maintenance_toggled',
}
