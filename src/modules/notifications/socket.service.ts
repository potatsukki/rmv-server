import { Server as SocketServer, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { Notification, User } from '../../models/index.js';
import { NotificationCategory, Role } from '../../utils/constants.js';
import { logger } from '../../utils/logger.js';
import type { Types } from 'mongoose';

let io: SocketServer | null = null;

const INTERNAL_APPOINTMENT_NOTIFICATION_ROLES = new Set<Role>([
  Role.APPOINTMENT_AGENT,
  Role.SALES_STAFF,
  Role.ADMIN,
]);

interface JwtPayload {
  userId: string;
  roles: Role[];
}

export function initializeSocket(server: HttpServer): SocketServer {
  io = new SocketServer(server, {
    cors: {
      origin: env.CORS_ORIGIN,
      credentials: true,
    },
  });

  io.use(async (socket: Socket, next) => {
    try {
      // Read access token from auth payload first (sessionStorage-based), then cookie fallback
      let token: string | undefined;
      token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) {
        const cookieHeader = socket.handshake.headers?.cookie;
        if (cookieHeader) {
          const match = cookieHeader.match(/(?:^|;\s*)accessToken=([^;]+)/);
          if (match) token = match[1];
        }
      }
      if (!token) {
        next(new Error('Authentication required'));
        return;
      }

      const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtPayload;
      const user = await User.findById(decoded.userId);
      if (!user || !user.isActive) {
        next(new Error('Invalid user'));
        return;
      }

      (socket as unknown as Record<string, unknown>).userId = decoded.userId;
      (socket as unknown as Record<string, unknown>).userRoles = decoded.roles;
      next();
    } catch {
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const userId = (socket as unknown as Record<string, unknown>).userId as string;
    const roles = (socket as unknown as Record<string, unknown>).userRoles as Role[];

    // Join personal room
    socket.join(`user:${userId}`);

    // Join role-based rooms
    for (const role of roles) {
      socket.join(`role:${role}`);
    }

    logger.debug(`Socket connected: user ${userId}`);

    socket.on('disconnect', () => {
      logger.debug(`Socket disconnected: user ${userId}`);
    });
  });

  return io;
}

export function getIO(): SocketServer {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
}

// ── Notification Helpers ──

export async function createAndSendNotification(
  userId: string | Types.ObjectId,
  category: NotificationCategory,
  title: string,
  message: string,
  link?: string,
): Promise<void> {
  try {
    // Check user notification preferences BEFORE saving
    if (category !== NotificationCategory.SYSTEM) {
      const user = await User.findById(userId);
      if (user) {
        const bypassPreferenceCheck = category === NotificationCategory.APPOINTMENT
          && user.roles.some((role) => INTERNAL_APPOINTMENT_NOTIFICATION_ROLES.has(role));

        if (!bypassPreferenceCheck) {
          const prefKey = category as keyof typeof user.notificationPreferences;
          if (user.notificationPreferences[prefKey] === false) {
            return; // User has explicitly disabled this category — skip entirely
          }
        }
      }
    }

    const notification = await Notification.create({
      userId,
      category,
      title,
      message,
      link,
    });

    // Push via socket
    if (io) {
      io.to(`user:${userId.toString()}`).emit('notification:new', {
        _id: notification._id,
        userId: notification.userId,
        category,
        title,
        message,
        link,
        isRead: false,
        createdAt: notification.createdAt,
      });
    }
  } catch (error) {
    logger.error('Failed to create notification:', error);
  }
}

export async function notifyRole(
  role: Role,
  category: NotificationCategory,
  title: string,
  message: string,
  link?: string,
): Promise<void> {
  try {
    // Find all users with this role
    const users = await User.find({ roles: role, isActive: true });
    for (const user of users) {
      await createAndSendNotification(user._id, category, title, message, link);
    }
  } catch (error) {
    logger.error('Failed to notify role:', error);
  }
}

export function emitRoleEvent(
  role: Role,
  event: string,
  payload: Record<string, unknown>,
): void {
  if (!io) return;
  io.to(`role:${role}`).emit(event, payload);
}

/**
 * Notify all active users in the system.
 * Used for high-priority broadcast like scheduled maintenance.
 */
export async function notifyAllUsers(
  category: NotificationCategory,
  title: string,
  message: string,
  link?: string,
): Promise<void> {
  try {
    // 1. Get all active users
    const users = await User.find({ isActive: true }).select('_id');
    if (!users.length) return;

    // 2. Bulk insert notifications (bypass pref check for broadcast SYSTEM messages usually)
    const notifications = users.map((u) => ({
      userId: u._id,
      category,
      title,
      message,
      link,
    }));

    const docs = await Notification.insertMany(notifications);
    const firstDoc = docs[0]; // To get timestamp

    // 3. Broadcast via Socket to all connected users
    if (io) {
      io.emit('notification:new', {
        category,
        title,
        message,
        link,
        isRead: false,
        createdAt: firstDoc?.createdAt || new Date(),
      });
    }

    logger.info(`Broadcasted notification to ${users.length} users: ${title}`);
  } catch (err) {
    logger.error('Failed to notify all users:', err);
  }
}

