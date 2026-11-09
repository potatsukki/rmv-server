import { describe, expect, it, vi } from 'vitest';

const { mockNotificationCreate, mockUserFindById } = vi.hoisted(() => ({
  mockNotificationCreate: vi.fn(),
  mockUserFindById: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  Notification: { create: mockNotificationCreate },
  User: { findById: mockUserFindById, find: vi.fn() },
}));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { notifyUsers } from './socket.service.js';
import { NotificationCategory } from '../../utils/constants.js';

describe('notifyUsers', () => {
  it('notifies each affected person once and never the person who acted', async () => {
    mockUserFindById.mockResolvedValue({ roles: ['customer'], notificationPreferences: {} });
    mockNotificationCreate.mockImplementation(async (doc) => ({ _id: 'n', createdAt: new Date(), ...doc }));

    await notifyUsers(
      ['customer-1', 'sales-1', 'customer-1', null, undefined, 'agent-1'],
      NotificationCategory.APPOINTMENT,
      'Consultation No-Show',
      'APT-20261112-0002 was marked as a no-show.',
      '/appointments/a1',
      { excludeUserId: 'sales-1' },
    );

    const recipients = mockNotificationCreate.mock.calls.map(([doc]) => doc.userId);
    expect(recipients).toEqual(['customer-1', 'agent-1']);
  });
});
