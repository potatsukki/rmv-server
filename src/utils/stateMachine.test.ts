import { describe, expect, it } from 'vitest';
import { appointmentStateMachine } from './stateMachine.js';
import { AppointmentStatus } from './constants.js';
import { AppError, ErrorCode } from './appError.js';

describe('appointmentStateMachine', () => {
  it('allows valid transitions', () => {
    expect(
      appointmentStateMachine.canTransition(
        AppointmentStatus.REQUESTED,
        AppointmentStatus.CONFIRMED,
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
    }
  });
});
