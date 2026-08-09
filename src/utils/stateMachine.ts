import {
  AppointmentStatus,
  ProjectStatus,
  BlueprintStatus,
  PaymentStageStatus,
  FabricationStatus,
} from './constants.js';
import { VisitReportStatus } from '../models/VisitReport.js';
import { AppError, ErrorCode } from './appError.js';

// ── Generic State Machine Type ──
type TransitionMap<T extends string> = Record<T, T[]>;

function createStateMachine<T extends string>(transitions: TransitionMap<T>) {
  return {
    canTransition(from: T, to: T): boolean {
      return transitions[from]?.includes(to) ?? false;
    },
    assertTransition(from: T, to: T): void {
      if (!this.canTransition(from, to)) {
        const allowedNextStatuses = transitions[from] || [];
        throw AppError.badRequest(
          `Invalid status transition: ${from} → ${to}`,
          ErrorCode.INVALID_TRANSITION,
          {
            diagnosticsType: 'LIFECYCLE_MISMATCH',
            refreshRequired: true,
            currentStatus: from,
            attemptedStatus: to,
            allowedNextStatuses,
            // Backward-compatible aliases for existing consumers.
            from,
            to,
            allowed: allowedNextStatuses,
          },
        );
      }
    },
    getAllowed(from: T): T[] {
      return transitions[from] || [];
    },
  };
}

// ── Appointment State Machine ──
export const appointmentStateMachine = createStateMachine<AppointmentStatus>({
  [AppointmentStatus.REQUESTED]: [
    AppointmentStatus.CONFIRMED,
    AppointmentStatus.CANCELLED,
    AppointmentStatus.NO_SHOW,
    AppointmentStatus.RESCHEDULE_REQUESTED,
  ],
  [AppointmentStatus.CONFIRMED]: [
    AppointmentStatus.ON_THE_WAY,
    AppointmentStatus.COMPLETED,
    AppointmentStatus.NO_SHOW,
    AppointmentStatus.CANCELLED,
    AppointmentStatus.RESCHEDULE_REQUESTED,
  ],
  [AppointmentStatus.PREPARING]: [
    AppointmentStatus.ON_THE_WAY,
    AppointmentStatus.COMPLETED,
    AppointmentStatus.CANCELLED,
    AppointmentStatus.NO_SHOW,
    AppointmentStatus.RESCHEDULE_REQUESTED,
  ],
  [AppointmentStatus.ON_THE_WAY]: [
    AppointmentStatus.ARRIVED_AT_SITE,
    AppointmentStatus.CANCELLED,
    AppointmentStatus.NO_SHOW,
  ],
  [AppointmentStatus.ARRIVED_AT_SITE]: [
    AppointmentStatus.IN_PROGRESS,
    AppointmentStatus.CANCELLED,
    AppointmentStatus.NO_SHOW,
  ],
  [AppointmentStatus.IN_PROGRESS]: [
    AppointmentStatus.COMPLETED,
    AppointmentStatus.CANCELLED,
    AppointmentStatus.NO_SHOW,
  ],
  [AppointmentStatus.RESCHEDULE_REQUESTED]: [
    AppointmentStatus.CONFIRMED,
    AppointmentStatus.CANCELLED,
  ],
  [AppointmentStatus.COMPLETED]: [AppointmentStatus.READY_FOR_OCULAR],
  [AppointmentStatus.READY_FOR_OCULAR]: [AppointmentStatus.COMPLETED],
  [AppointmentStatus.NO_SHOW]: [],
  [AppointmentStatus.CANCELLED]: [],
});

// ── Project State Machine ──
export const projectStateMachine = createStateMachine<ProjectStatus>({
  [ProjectStatus.DRAFT]: [ProjectStatus.SUBMITTED, ProjectStatus.CANCELLED],
  [ProjectStatus.SUBMITTED]: [ProjectStatus.BLUEPRINT, ProjectStatus.CANCELLED],
  [ProjectStatus.BLUEPRINT]: [ProjectStatus.APPROVED, ProjectStatus.PAYMENT_PENDING, ProjectStatus.CANCELLED],
  [ProjectStatus.APPROVED]: [ProjectStatus.PAYMENT_PENDING, ProjectStatus.BLUEPRINT, ProjectStatus.CANCELLED],
  [ProjectStatus.PAYMENT_PENDING]: [ProjectStatus.FABRICATION, ProjectStatus.CANCELLED],
  [ProjectStatus.READY_FOR_OCULAR]: [ProjectStatus.FABRICATION, ProjectStatus.CANCELLED],
  [ProjectStatus.FABRICATION]: [ProjectStatus.COMPLETED, ProjectStatus.CANCELLED],
  [ProjectStatus.COMPLETED]: [],
  [ProjectStatus.CANCELLED]: [],
});

// ── Blueprint State Machine ──
export const blueprintStateMachine = createStateMachine<BlueprintStatus>({
  [BlueprintStatus.UPLOADED]: [BlueprintStatus.APPROVED, BlueprintStatus.REVISION_REQUESTED],
  [BlueprintStatus.REVISION_REQUESTED]: [BlueprintStatus.REVISION_UPLOADED],
  [BlueprintStatus.REVISION_UPLOADED]: [BlueprintStatus.APPROVED, BlueprintStatus.REVISION_REQUESTED],
  [BlueprintStatus.APPROVED]: [BlueprintStatus.REVISION_REQUESTED],
});

// ── Payment Stage State Machine ──
export const paymentStateMachine = createStateMachine<PaymentStageStatus>({
  [PaymentStageStatus.PENDING]: [PaymentStageStatus.PROOF_SUBMITTED],
  [PaymentStageStatus.PROOF_SUBMITTED]: [PaymentStageStatus.VERIFIED, PaymentStageStatus.DECLINED],
  [PaymentStageStatus.VERIFIED]: [],
  [PaymentStageStatus.DECLINED]: [PaymentStageStatus.PROOF_SUBMITTED],
});

// ── Fabrication State Machine ──
export const fabricationStateMachine = createStateMachine<FabricationStatus>({
  [FabricationStatus.QUEUED]: [FabricationStatus.MATERIAL_PREP],
  [FabricationStatus.MATERIAL_PREP]: [FabricationStatus.CUTTING],
  [FabricationStatus.CUTTING]: [FabricationStatus.WELDING],
  [FabricationStatus.WELDING]: [FabricationStatus.ASSEMBLY],
  [FabricationStatus.ASSEMBLY]: [FabricationStatus.FINISHING],
  [FabricationStatus.FINISHING]: [FabricationStatus.QUALITY_CHECK],
  [FabricationStatus.QUALITY_CHECK]: [FabricationStatus.READY_FOR_DELIVERY],
  [FabricationStatus.READY_FOR_DELIVERY]: [FabricationStatus.DONE],
  [FabricationStatus.DONE]: [],
});

// ── Visit Report State Machine ──
export const visitReportStateMachine = createStateMachine<VisitReportStatus>({
  [VisitReportStatus.DRAFT]: [VisitReportStatus.SUBMITTED],
  [VisitReportStatus.SUBMITTED]: [VisitReportStatus.RETURNED, VisitReportStatus.COMPLETED],
  [VisitReportStatus.RETURNED]: [VisitReportStatus.SUBMITTED],
  [VisitReportStatus.COMPLETED]: [],
});
