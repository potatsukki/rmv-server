import { describe, expect, it } from 'vitest';
import { appointmentStateMachine, getFabricationStateMachine } from './stateMachine.js';
import { AppointmentStatus, DeliveryType, FabricationStatus } from './constants.js';
import { AppError, ErrorCode } from './appError.js';

describe('appointmentStateMachine', () => {
  it('allows valid transitions', () => {
    expect(
      appointmentStateMachine.canTransition(
        AppointmentStatus.REQUESTED,
        AppointmentStatus.CONFIRMED,
      ),
    ).toBe(true);

    expect(
      appointmentStateMachine.canTransition(
        AppointmentStatus.REQUESTED,
        AppointmentStatus.RESCHEDULE_REQUESTED,
      ),
    ).toBe(true);

    expect(
      appointmentStateMachine.canTransition(
        AppointmentStatus.PREPARING,
        AppointmentStatus.RESCHEDULE_REQUESTED,
      ),
    ).toBe(true);

    expect(
      appointmentStateMachine.canTransition(
        AppointmentStatus.COMPLETED,
        AppointmentStatus.READY_FOR_OCULAR,
      ),
    ).toBe(true);

    expect(
      appointmentStateMachine.canTransition(
        AppointmentStatus.READY_FOR_OCULAR,
        AppointmentStatus.COMPLETED,
      ),
    ).toBe(true);

    expect(
      appointmentStateMachine.canTransition(
        AppointmentStatus.CONFIRMED,
        AppointmentStatus.ON_THE_WAY,
      ),
    ).toBe(true);

    expect(
      appointmentStateMachine.canTransition(
        AppointmentStatus.ON_THE_WAY,
        AppointmentStatus.ARRIVED_AT_SITE,
      ),
    ).toBe(true);

    expect(
      appointmentStateMachine.canTransition(
        AppointmentStatus.ARRIVED_AT_SITE,
        AppointmentStatus.IN_PROGRESS,
      ),
    ).toBe(true);

    expect(
      appointmentStateMachine.canTransition(
        AppointmentStatus.IN_PROGRESS,
        AppointmentStatus.COMPLETED,
      ),
    ).toBe(true);
  });

  it('rejects invalid transitions', () => {
    expect(
      appointmentStateMachine.canTransition(
        AppointmentStatus.REQUESTED,
        AppointmentStatus.COMPLETED,
      ),
    ).toBe(false);

    expect(
      appointmentStateMachine.canTransition(
        AppointmentStatus.CONFIRMED,
        AppointmentStatus.IN_PROGRESS,
      ),
    ).toBe(false);

    expect(
      appointmentStateMachine.canTransition(
        AppointmentStatus.ON_THE_WAY,
        AppointmentStatus.COMPLETED,
      ),
    ).toBe(false);

    expect(
      appointmentStateMachine.canTransition(
        AppointmentStatus.ARRIVED_AT_SITE,
        AppointmentStatus.COMPLETED,
      ),
    ).toBe(false);
  });

  it('throws AppError with INVALID_TRANSITION on invalid assertTransition', () => {
    try {
      appointmentStateMachine.assertTransition(
        AppointmentStatus.REQUESTED,
        AppointmentStatus.COMPLETED,
      );
      throw new Error('Expected transition assertion to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe(ErrorCode.INVALID_TRANSITION);
      expect(appError.details).toMatchObject({
        diagnosticsType: 'LIFECYCLE_MISMATCH',
        refreshRequired: true,
        currentStatus: AppointmentStatus.REQUESTED,
        attemptedStatus: AppointmentStatus.COMPLETED,
      });
      expect(Array.isArray(appError.details?.allowedNextStatuses)).toBe(true);
      expect(appError.details?.allowedNextStatuses).toContain(AppointmentStatus.CONFIRMED);
    }
  });
});

describe('delivery-type fabrication lifecycles', () => {
  it('uses the shop-fabricated sequence', () => {
    const machine = getFabricationStateMachine(DeliveryType.SHOP_FABRICATED);
    expect(machine.getAllowed(FabricationStatus.QUEUED)).toEqual([FabricationStatus.MATERIAL_PREP]);
    expect(machine.getAllowed(FabricationStatus.QUALITY_CHECK)).toEqual([FabricationStatus.READY_FOR_DELIVERY]);
    expect(machine.getAllowed(FabricationStatus.READY_FOR_DELIVERY)).toEqual([FabricationStatus.DONE]);
  });

  it('uses the on-site installation sequence', () => {
    const machine = getFabricationStateMachine(DeliveryType.ON_SITE_INSTALLATION);
    expect(machine.getAllowed(FabricationStatus.QUEUED)).toEqual([FabricationStatus.SITE_PREPARATION]);
    expect(machine.getAllowed(FabricationStatus.MEASUREMENT_LAYOUT)).toEqual([FabricationStatus.MATERIAL_PREP]);
    expect(machine.getAllowed(FabricationStatus.MATERIAL_PREP)).toEqual([FabricationStatus.FABRICATION_INSTALLATION]);
    expect(machine.getAllowed(FabricationStatus.QUALITY_CHECK)).toEqual([FabricationStatus.TURNOVER]);
    expect(machine.getAllowed(FabricationStatus.TURNOVER)).toEqual([]);
  });
});
