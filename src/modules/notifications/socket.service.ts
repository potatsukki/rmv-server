import { Server as SocketServer, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { Notification, User } from '../../models/index.js';
import { NotificationCategory, Role } from '../../utils/constants.js';
import { logger } from '../../utils/logger.js';
import type { Types } from 'mongoose';

let io: SocketServer | null = null;

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
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
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
    const notification = await Notification.create({
      userId,
      category,
      title,
      message,
      link,
    });

    // Check user notification preferences
    const user = await User.findById(userId);
    if (user) {
      const prefKey = category as keyof typeof user.notificationPreferences;
      if (category !== NotificationCategory.SYSTEM && !user.notificationPreferences[prefKey]) {
        return; // User has disabled this category
      }
    }

    // Push via socket
    if (io) {
      io.to(`user:${userId.toString()}`).emit('notification:new', {
        id: notification._id,
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
