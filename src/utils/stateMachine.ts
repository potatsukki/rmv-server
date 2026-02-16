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
        throw AppError.badRequest(
          `Invalid status transition: ${from} → ${to}`,
          ErrorCode.INVALID_TRANSITION,
          { from, to, allowed: transitions[from] || [] },
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
  [AppointmentStatus.REQUESTED]: [AppointmentStatus.CONFIRMED, AppointmentStatus.CANCELLED],
  [AppointmentStatus.CONFIRMED]: [
    AppointmentStatus.COMPLETED,
    AppointmentStatus.NO_SHOW,
    AppointmentStatus.CANCELLED,
    AppointmentStatus.RESCHEDULE_REQUESTED,
  ],
  [AppointmentStatus.RESCHEDULE_REQUESTED]: [
    AppointmentStatus.CONFIRMED,
    AppointmentStatus.CANCELLED,
  ],
  [AppointmentStatus.COMPLETED]: [],
  [AppointmentStatus.NO_SHOW]: [],
  [AppointmentStatus.CANCELLED]: [],
});

// ── Project State Machine ──
export const projectStateMachine = createStateMachine<ProjectStatus>({
  [ProjectStatus.DRAFT]: [ProjectStatus.SUBMITTED, ProjectStatus.CANCELLED],
  [ProjectStatus.SUBMITTED]: [ProjectStatus.BLUEPRINT, ProjectStatus.CANCELLED],
  [ProjectStatus.BLUEPRINT]: [ProjectStatus.APPROVED, ProjectStatus.CANCELLED],
  [ProjectStatus.APPROVED]: [ProjectStatus.PAYMENT_PENDING, ProjectStatus.CANCELLED],
  [ProjectStatus.PAYMENT_PENDING]: [ProjectStatus.FABRICATION, ProjectStatus.CANCELLED],
  [ProjectStatus.FABRICATION]: [ProjectStatus.COMPLETED, ProjectStatus.CANCELLED],
  [ProjectStatus.COMPLETED]: [],
  [ProjectStatus.CANCELLED]: [],
});

// ── Blueprint State Machine ──
export const blueprintStateMachine = createStateMachine<BlueprintStatus>({
  [BlueprintStatus.UPLOADED]: [BlueprintStatus.APPROVED, BlueprintStatus.REVISION_REQUESTED],
  [BlueprintStatus.REVISION_REQUESTED]: [BlueprintStatus.REVISION_UPLOADED],
  [BlueprintStatus.REVISION_UPLOADED]: [BlueprintStatus.APPROVED, BlueprintStatus.REVISION_REQUESTED],
  [BlueprintStatus.APPROVED]: [],
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
  [FabricationStatus.WELDING]: [FabricationStatus.FINISHING],
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
