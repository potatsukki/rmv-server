import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  mockUserFindById,
  mockUserFind,
  mockNotificationCreate,
} = vi.hoisted(() => ({
  mockUserFindById: vi.fn(),
  mockUserFind: vi.fn(),
  mockNotificationCreate: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  Notification: {
    create: mockNotificationCreate,
  },
  User: {
    findById: mockUserFindById,
    find: mockUserFind,
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { createAndSendNotification, notifyBookingAgentAppointmentSuccessful } from './socket.service.js';
import { NotificationCategory, Role } from '../../utils/constants.js';

describe('createAndSendNotification preference handling', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('delivers appointment workflow notifications to internal staff even when appointment notifications are disabled', async () => {
    mockUserFindById.mockResolvedValueOnce({
      _id: 'agent-1',
      roles: [Role.APPOINTMENT_AGENT],
      notificationPreferences: { appointment: false },
    });
    mockNotificationCreate.mockResolvedValueOnce({
      _id: 'notif-1',
      userId: 'agent-1',
      createdAt: new Date('2026-08-10T00:00:00.000Z'),
    });

    await createAndSendNotification(
      'agent-1',
      NotificationCategory.APPOINTMENT,
      'Reschedule Requested',
      'Customer requested a reschedule.',
      '/appointments/appointment-1',
    );

    expect(mockNotificationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'agent-1',
        category: NotificationCategory.APPOINTMENT,
        title: 'Reschedule Requested',
      }),
    );
  });

  it('still respects appointment notification preferences for customers', async () => {
    mockUserFindById.mockResolvedValueOnce({
      _id: 'customer-1',
      roles: [Role.CUSTOMER],
      notificationPreferences: { appointment: false },
    });

    await createAndSendNotification(
      'customer-1',
      NotificationCategory.APPOINTMENT,
      'Appointment Updated',
      'Your appointment changed.',
      '/appointments/appointment-1',
    );

    expect(mockNotificationCreate).not.toHaveBeenCalled();
  });
});

describe('notifyBookingAgentAppointmentSuccessful', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('notifies only the agent who booked the appointment', async () => {
    mockUserFind.mockReturnValueOnce({ select: vi.fn().mockResolvedValue([{ _id: 'agent-1' }]) });
    mockUserFindById.mockResolvedValueOnce({
      _id: 'agent-1',
      roles: [Role.APPOINTMENT_AGENT],
      notificationPreferences: {},
    });
    mockNotificationCreate.mockResolvedValueOnce({ _id: 'notif-1', userId: 'agent-1', createdAt: new Date() });

    await notifyBookingAgentAppointmentSuccessful({
      _id: 'appointment-1',
      appointmentNumber: 'APT-20261016-0001',
      type: 'office',
      date: '2026-10-16',
      bookedBy: 'agent-1',
      confirmedBy: 'agent-1',
    });

    expect(mockUserFind).toHaveBeenCalledWith(expect.objectContaining({
      _id: { $in: ['agent-1'] },
      roles: Role.APPOINTMENT_AGENT,
    }));
    expect(mockNotificationCreate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      userId: 'agent-1',
      title: 'Appointment Successful',
      link: '/appointments/appointment-1',
    }));
  });
});
