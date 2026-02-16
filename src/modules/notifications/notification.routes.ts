import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authenticate } from '../../middleware/auth.js';
import { Notification } from '../../models/index.js';
import { Request, Response } from 'express';

const router = Router();

// Get notifications for current user
router.get(
  '/',
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const unreadOnly = req.query.unreadOnly === 'true';

    const filter: Record<string, unknown> = { userId: req.userId };
    if (unreadOnly) filter.isRead = false;

    const [notifications, total] = await Promise.all([
      Notification.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Notification.countDocuments(filter),
    ]);

    const unreadCount = await Notification.countDocuments({ userId: req.userId, isRead: false });

    res.json({
      success: true,
      data: {
        items: notifications,
        total,
        hasMore: page * limit < total,
        unreadCount,
      },
    });
  }),
);

// Mark notification as read
router.patch(
  '/:id/read',
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      { isRead: true },
    );
    res.json({ success: true, data: { message: 'Marked as read' } });
  }),
);

// Mark all as read
router.patch(
  '/read-all',
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    await Notification.updateMany(
      { userId: req.userId, isRead: false },
      { isRead: true },
    );
    res.json({ success: true, data: { message: 'All notifications marked as read' } });
  }),
);

export default router;
