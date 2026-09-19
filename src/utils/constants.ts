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

export enum StaffAvailabilityStatus {
  AVAILABLE = 'available',
  UNAVAILABLE = 'unavailable',
  ON_LEAVE = 'on_leave',
}

// ── Appointment Status ──
export enum AppointmentStatus {
  REQUESTED = 'requested',
  CONFIRMED = 'confirmed',
  PREPARING = 'preparing',
  ON_THE_WAY = 'on_the_way',
  ARRIVED_AT_SITE = 'arrived_at_site',
  IN_PROGRESS = 'in_progress',
  READY_FOR_OCULAR = 'ready_for_ocular',
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

export enum AppointmentAttendanceStatus {
  SCHEDULED = 'scheduled',
  ON_TIME = 'on_time',
  LATE_ARRIVAL = 'late_arrival',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  RESCHEDULED = 'rescheduled',
  NO_SHOW = 'no_show',
  CUSTOMER_DECLINED = 'customer_declined',
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
  READY_FOR_OCULAR = 'ready_for_ocular',
  FABRICATION = 'fabrication',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

// ── Manual Signed Contract Status ──
export enum ContractStatus {
  MISSING = 'missing',
  UPLOADED = 'uploaded',
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
  QRPH = 'qrph',
}

// ── Fabrication Status ──
export enum FabricationStatus {
  QUEUED = 'queued',
  SITE_PREPARATION = 'site_preparation',
  MEASUREMENT_LAYOUT = 'measurement_layout',
  MATERIAL_PREP = 'material_prep',
  CUTTING = 'cutting',
  WELDING = 'welding',
  ASSEMBLY = 'assembly',
  FABRICATION_INSTALLATION = 'fabrication_installation',
  WELDING_ASSEMBLY = 'welding_assembly',
  FINISHING = 'finishing',
  QUALITY_CHECK = 'quality_check',
  READY_FOR_DELIVERY = 'ready_for_delivery',
  TURNOVER = 'turnover',
  DONE = 'done',
}

export enum DeliveryType {
  SHOP_FABRICATED = 'shop_fabricated',
  ON_SITE_INSTALLATION = 'on_site_installation',
}

// ── Cash Collection Status ──
export enum CashCollectionStatus {
  COLLECTED = 'collected',
  RECEIVED = 'received',
  DISCREPANCY = 'discrepancy',
}

// ── Ocular Fee Payment Choice (customer picks at booking) ──
export enum OcularFeePaymentChoice {
  ONLINE = 'online',
  CASH = 'cash',
}


// ── OTP Purpose ──
export enum OtpPurpose {
  EMAIL_VERIFICATION = 'email_verification',
  PASSWORD_RESET = 'password_reset',
  LOGIN_2FA = 'login_2fa',
  ENABLE_2FA = 'enable_2fa',
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

// ── Service Type (fabrication categories) ──
export enum ServiceType {
  RAILINGS = 'railings',
  GRILLS = 'grills',
  GATES = 'gates',
  FENCES = 'fences',
  KITCHEN_COUNTER = 'kitchen_counter',
  KITCHEN_CABINET = 'kitchen_cabinet',
  TABLE = 'table',
  CHAIR = 'chair',
  SHELVING = 'shelving',
  DOOR = 'door',
  WINDOW_FRAME = 'window_frame',
  CANOPY = 'canopy',
  STAIRCASE = 'staircase',
  BALUSTRADE = 'balustrade',
  SIGNAGE = 'signage',
  CUSTOM = 'custom',
}

// ── Measurement Unit ──
export enum MeasurementUnit {
  CM = 'cm',
  INCHES = 'inches',
  FEET = 'feet',
  METERS = 'meters',
}

// ── Environment / Site Condition ──
export enum Environment {
  INDOOR = 'indoor',
  OUTDOOR = 'outdoor',
  SEMI_COVERED = 'semi_covered',
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
  TWO_FA_ENABLED = '2fa_enabled',
  TWO_FA_DISABLED = '2fa_disabled',
  SESSION_REVOKED = 'session_revoked',
  ALL_SESSIONS_REVOKED = 'all_sessions_revoked',

  // User
  USER_CREATED = 'user_created',
  USER_UPDATED = 'user_updated',
  USER_DISABLED = 'user_disabled',
  USER_ENABLED = 'user_enabled',
  USER_DELETED = 'user_deleted',

  // Appointment
  APPOINTMENT_CREATED = 'appointment_created',
  APPOINTMENT_UPDATED = 'appointment_updated',
  APPOINTMENT_CONFIRMED = 'appointment_confirmed',
  APPOINTMENT_CANCELLED = 'appointment_cancelled',
  APPOINTMENT_COMPLETED = 'appointment_completed',
  APPOINTMENT_NO_SHOW = 'appointment_no_show',
  APPOINTMENT_RESCHEDULE_REQUESTED = 'appointment_reschedule_requested',
  APPOINTMENT_RESCHEDULED = 'appointment_rescheduled',
  APPOINTMENT_LOCATION_SUBMITTED = 'appointment_location_submitted',
  APPOINTMENT_PREPARING = 'appointment_preparing',
  APPOINTMENT_ON_THE_WAY = 'appointment_on_the_way',
  APPOINTMENT_ARRIVED_AT_SITE = 'appointment_arrived_at_site',
  APPOINTMENT_IN_PROGRESS = 'appointment_in_progress',
  APPOINTMENT_ATTENDANCE_UPDATED = 'appointment_attendance_updated',
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
  QUOTATION_DRAFT_UPDATED = 'quotation_draft_updated',
  QUOTATION_SUBMITTED_FOR_REVIEW = 'quotation_submitted_for_review',
  QUOTATION_APPROVED = 'quotation_approved',
  QUOTATION_SENT_TO_CUSTOMER = 'quotation_sent_to_customer',
  QUOTATION_REVISED = 'quotation_revised',

  // Payment
  PAYMENT_PLAN_CREATED = 'payment_plan_created',
  PAYMENT_PLAN_UPDATED = 'payment_plan_updated',
  PAYMENT_PROOF_SUBMITTED = 'payment_proof_submitted',
  PAYMENT_VERIFIED = 'payment_verified',
  PAYMENT_DECLINED = 'payment_declined',
  RECEIPT_GENERATED = 'receipt_generated',
  RECEIPT_RESENT = 'receipt_resent',
  LIFECYCLE_MISMATCH_BLOCKED = 'lifecycle_mismatch_blocked',
  LIFECYCLE_HOTSPOT_ACKNOWLEDGED = 'lifecycle_hotspot_acknowledged',

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
  VISIT_REPORT_DELETED = 'visit_report_deleted',
  VISIT_REPORT_COMPLETED = 'visit_report_completed',

  // Config
  CONFIG_UPDATED = 'config_updated',
  CONFIG_ROLLED_BACK = 'config_rolled_back',
  HOLIDAY_CREATED = 'holiday_created',
  HOLIDAY_DELETED = 'holiday_deleted',
  MAINTENANCE_TOGGLED = 'maintenance_toggled',
  SLOT_BLOCKED = 'slot_blocked',
  SLOT_UNBLOCKED = 'slot_unblocked',
  SLOTS_BULK_BLOCKED = 'slots_bulk_blocked',
  SLOTS_BULK_UNBLOCKED = 'slots_bulk_unblocked',
}
