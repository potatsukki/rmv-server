import { beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';

const mocks = vi.hoisted(() => ({
  userFindOne: vi.fn(),
  userCreate: vi.fn(),
  otpUpdateMany: vi.fn(),
  otpFindOne: vi.fn(),
  otpCreate: vi.fn(),
  refreshCreate: vi.fn(),
  auditCreate: vi.fn(),
  loginHistoryRecord: vi.fn(),
  sendOtpEmail: vi.fn(),
  verifyFirebaseIdToken: vi.fn(),
}));

vi.mock('../../models/index.js', () => ({
  User: { findOne: mocks.userFindOne, create: mocks.userCreate },
  OtpToken: { updateMany: mocks.otpUpdateMany, findOne: mocks.otpFindOne, create: mocks.otpCreate },
  RefreshToken: { create: mocks.refreshCreate },
  AuditLog: { create: mocks.auditCreate },
  LoginHistory: { record: mocks.loginHistoryRecord },
}));
vi.mock('../notifications/email.service.js', () => ({
  sendOtpEmail: mocks.sendOtpEmail,
  sendPasswordResetEmail: vi.fn(),
  send2faEmail: vi.fn(),
}));
vi.mock('../../config/firebase.js', () => ({ verifyFirebaseIdToken: mocks.verifyFirebaseIdToken }));
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { googleAuth, googleComplete, register } from './auth.service.js';
import { ErrorCode } from '../../utils/appError.js';

function makeUser(overrides: Record<string, unknown> = {}) {
  const user: Record<string, unknown> = {
    _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    email: 'tester@example.com',
    firstName: 'Juan',
    lastName: 'Luma',
    phone: '+639170000000',
    password: 'old-hash',
    roles: ['customer'],
    isEmailVerified: false,
    isActive: true,
    provider: 'local',
    firebaseUid: undefined,
    twoFactorEnabled: false,
    ...overrides,
  };
  user.save = vi.fn().mockResolvedValue(user);
  user.set = vi.fn((key: string, value: unknown) => { user[key] = value; });
  return user;
}

const registerInput = {
  email: 'tester@example.com',
  password: 'NewPassw0rd!',
  firstName: 'Maria',
  lastName: 'Bago',
  phone: '+639171111111',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.otpFindOne.mockReturnValue({ sort: vi.fn().mockResolvedValue(null) });
  mocks.otpCreate.mockResolvedValue({});
  mocks.sendOtpEmail.mockResolvedValue(undefined);
  mocks.verifyFirebaseIdToken.mockResolvedValue({
    uid: 'firebase-uid-1',
    email: 'tester@example.com',
    name: 'Maria Google',
    picture: 'https://example.com/photo.png',
  });
});

describe('register', () => {
  it('replaces the stale details of an unverified signup and resends the OTP', async () => {
    const existing = makeUser();
    mocks.userFindOne.mockResolvedValue(existing);

    await register(registerInput as never);

    expect(existing.firstName).toBe('Maria');
    expect(existing.lastName).toBe('Bago');
    expect(existing.phone).toBe('+639171111111');
    expect(await bcrypt.compare('NewPassw0rd!', existing.password as string)).toBe(true);
    expect(existing.save).toHaveBeenCalledTimes(1);
    expect(mocks.sendOtpEmail).toHaveBeenCalledWith('tester@example.com', expect.any(String));
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it('keeps the old details when the OTP cannot be sent yet', async () => {
    const existing = makeUser();
    mocks.userFindOne.mockResolvedValue(existing);
    mocks.otpFindOne.mockReturnValue({ sort: vi.fn().mockResolvedValue({ lastSentAt: new Date() }) });

    await expect(register(registerInput as never)).rejects.toThrow();
    expect(existing.save).not.toHaveBeenCalled();
  });

  it('still rejects a verified email', async () => {
    mocks.userFindOne.mockResolvedValue(makeUser({ isEmailVerified: true }));

    await expect(register(registerInput as never)).rejects.toMatchObject({ code: ErrorCode.DUPLICATE_ENTRY });
  });
});

describe('googleAuth', () => {
  it('asks the Google owner to complete their profile instead of logging into an unverified signup', async () => {
    const existing = makeUser();
    mocks.userFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(existing);

    const result = await googleAuth({ idToken: 'token' } as never);

    expect(result).toMatchObject({ needsProfile: true, email: 'tester@example.com', googleName: 'Maria Google' });
    expect(result).not.toHaveProperty('accessToken');
    expect(existing.save).not.toHaveBeenCalled();
    expect(mocks.refreshCreate).not.toHaveBeenCalled();
  });

  it('still links and logs into a verified local account', async () => {
    const existing = makeUser({ isEmailVerified: true });
    mocks.userFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(existing);

    const result = await googleAuth({ idToken: 'token' } as never);

    expect(result).toHaveProperty('accessToken');
    expect(existing.firebaseUid).toBe('firebase-uid-1');
    expect(existing.firstName).toBe('Juan');
  });
});

describe('googleComplete', () => {
  it('claims an unverified signup with the Google owner details and drops the unproven password', async () => {
    const existing = makeUser();
    mocks.userFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(existing) });

    const result = await googleComplete({
      idToken: 'token',
      firstName: 'Maria',
      lastName: 'Bago',
      phone: '+639171111111',
    } as never);

    expect(existing.firstName).toBe('Maria');
    expect(existing.lastName).toBe('Bago');
    expect(existing.password).toBeUndefined();
    expect(existing.provider).toBe('google');
    expect(existing.firebaseUid).toBe('firebase-uid-1');
    expect(existing.isEmailVerified).toBe(true);
    expect(existing.save).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ user: { firstName: 'Maria', lastName: 'Bago' } });
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it('logs into an existing verified account without changing it', async () => {
    const existing = makeUser({ isEmailVerified: true, firebaseUid: 'firebase-uid-1' });
    mocks.userFindOne.mockReturnValue({ select: vi.fn().mockResolvedValue(existing) });

    const result = await googleComplete({
      idToken: 'token',
      firstName: 'Maria',
      lastName: 'Bago',
      phone: '+639171111111',
    } as never);

    expect(existing.firstName).toBe('Juan');
    expect(existing.save).not.toHaveBeenCalled();
    expect(result).toMatchObject({ user: { firstName: 'Juan' } });
  });
});
