/**
 * Migration script: Drop old unique indexes that were replaced
 * by item-scoped or many-per-parent records.
 *
 * This is needed because we now support multiple visit reports, projects,
 * blueprints, payment plans, and blueprint drafts per parent record/item.
 *
 * Run once after deploying the schema change:
 *   npx tsx src/scripts/dropUniqueIndexes.ts
 *
 * Safe to run multiple times — it silently skips if indexes don't exist.
 */
import mongoose from 'mongoose';
import { connectDB } from '../config/database.js';
import { logger } from '../utils/logger.js';

async function dropUniqueIndexes(): Promise<void> {
  try {
    await connectDB();
    const db = mongoose.connection.db!;

    // ── VisitReport: drop unique index on appointmentId ──
    const vrCollection = db.collection('visitreports');
    const vrIndexes = await vrCollection.indexes();
    const vrUnique = vrIndexes.find(
      (idx) =>
        idx.unique &&
        idx.key &&
        Object.keys(idx.key).length === 1 &&
        'appointmentId' in idx.key,
    );

    if (vrUnique) {
      await vrCollection.dropIndex(vrUnique.name!);
      logger.info(`Dropped unique index "${vrUnique.name}" from visitreports`);
    } else {
      logger.info('No unique appointmentId index found on visitreports — already clean.');
    }

    // ── Project: drop unique index on appointmentId ──
    const projCollection = db.collection('projects');
    const projIndexes = await projCollection.indexes();
    const projUnique = projIndexes.find(
      (idx) =>
        idx.unique &&
        idx.key &&
        Object.keys(idx.key).length === 1 &&
        'appointmentId' in idx.key,
    );

    if (projUnique) {
      await projCollection.dropIndex(projUnique.name!);
      logger.info(`Dropped unique index "${projUnique.name}" from projects`);
    } else {
      logger.info('No unique appointmentId index found on projects — already clean.');
    }

    // ── Blueprint: drop old unique projectId + version index ──
    const blueprintCollection = db.collection('blueprints');
    const blueprintIndexes = await blueprintCollection.indexes();
    const blueprintProjectVersionUnique = blueprintIndexes.find(
      (idx) =>
        idx.unique &&
        idx.key &&
        Object.keys(idx.key).length === 2 &&
        idx.key.projectId === 1 &&
        idx.key.version === 1,
    );

    if (blueprintProjectVersionUnique) {
      await blueprintCollection.dropIndex(blueprintProjectVersionUnique.name!);
      logger.info(`Dropped unique index "${blueprintProjectVersionUnique.name}" from blueprints`);
    } else {
      logger.info('No old unique projectId/version index found on blueprints — already clean.');
    }

    // ── PaymentPlan: drop old unique projectId-only index ──
    const paymentPlanCollection = db.collection('paymentplans');
    const paymentPlanIndexes = await paymentPlanCollection.indexes();
    const paymentPlanProjectUnique = paymentPlanIndexes.find(
      (idx) =>
        idx.unique &&
        idx.key &&
        Object.keys(idx.key).length === 1 &&
        idx.key.projectId === 1,
    );

    if (paymentPlanProjectUnique) {
      await paymentPlanCollection.dropIndex(paymentPlanProjectUnique.name!);
      logger.info(`Dropped unique index "${paymentPlanProjectUnique.name}" from paymentplans`);
    } else {
      logger.info('No old unique projectId index found on paymentplans — already clean.');
    }

    // ── BlueprintDraft: drop old unique projectId-only index ──
    const blueprintDraftCollection = db.collection('blueprintdrafts');
    const blueprintDraftIndexes = await blueprintDraftCollection.indexes();
    const blueprintDraftProjectUnique = blueprintDraftIndexes.find(
      (idx) =>
        idx.unique &&
        idx.key &&
        Object.keys(idx.key).length === 1 &&
        idx.key.projectId === 1,
    );

    if (blueprintDraftProjectUnique) {
      await blueprintDraftCollection.dropIndex(blueprintDraftProjectUnique.name!);
      logger.info(`Dropped unique index "${blueprintDraftProjectUnique.name}" from blueprintdrafts`);
    } else {
      logger.info('No old unique projectId index found on blueprintdrafts — already clean.');
    }

    // ── ProjectItem: drop old unique projectId + serviceType index ──
    // Replaced by { projectId, serviceType, selectedDesignTemplateId } so one project can hold
    // several items of the same service (one per selected design).
    const projectItemCollection = db.collection('projectitems');
    const projectItemIndexes = await projectItemCollection.indexes();
    const projectItemServiceUnique = projectItemIndexes.find(
      (idx) =>
        idx.unique &&
        idx.key &&
        Object.keys(idx.key).length === 2 &&
        idx.key.projectId === 1 &&
        idx.key.serviceType === 1,
    );

    if (projectItemServiceUnique) {
      await projectItemCollection.dropIndex(projectItemServiceUnique.name!);
      logger.info(`Dropped unique index "${projectItemServiceUnique.name}" from projectitems`);
    } else {
      logger.info('No old unique projectId/serviceType index found on projectitems — already clean.');
    }

    logger.info('Migration complete.');
    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    logger.error('Migration failed:', error);
    await mongoose.connection.close();
    process.exit(1);
  }
}

dropUniqueIndexes();
