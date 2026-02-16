import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import { connectDB } from '../config/database.js';
import { User } from '../models/index.js';
import { Role } from '../utils/constants.js';
import { logger } from '../utils/logger.js';

async function seedSuperAdmin(): Promise<void> {
  try {
    await connectDB();

    const existingAdmin = await User.findOne({
      email: env.SUPER_ADMIN_EMAIL,
      roles: Role.ADMIN,
    });

    if (existingAdmin) {
      logger.info('Super admin already exists, skipping seed.');
      await mongoose.connection.close();
      process.exit(0);
    }

    const salt = await bcrypt.genSalt(12);
    const hashedPassword = await bcrypt.hash(env.SUPER_ADMIN_PASSWORD, salt);

    const admin = await User.create({
      firstName: env.SUPER_ADMIN_FIRST_NAME,
      lastName: env.SUPER_ADMIN_LAST_NAME,
      email: env.SUPER_ADMIN_EMAIL,
      phone: '+639000000000',
      password: hashedPassword,
      roles: [Role.ADMIN],
      isEmailVerified: true,
      isActive: true,
    });

    logger.info(`✅ Super admin created: ${admin.email}`);
    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    logger.error('Failed to seed super admin:', error);
    await mongoose.connection.close();
    process.exit(1);
  }
}

seedSuperAdmin();
