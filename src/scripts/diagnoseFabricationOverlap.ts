/**
 * Read-only diagnostic for the fabrication team rules (QA 2026-11-28: "walang overlap, walang
 * double assign"). Run it on the server after a deploy:
 *
 *   npx tsx src/scripts/diagnoseFabricationOverlap.ts
 *
 * Problems:
 * - a fabricator on two or more projects still in the workshop;
 * - a person twice on one team;
 * - a project the system assigned more than once.
 *
 * For information only:
 * - paid projects waiting for a fabricator;
 * - workshop projects whose lead is inactive, On Leave or Unavailable.
 *
 * Only reads; it never writes to the database.
 */
import mongoose from 'mongoose';
import { connectDB } from '../config/database.js';
import { Project, User } from '../models/index.js';
import { StaffAvailabilityStatus } from '../utils/constants.js';
import { listProjectsWaitingForFabricator } from '../modules/projects/fabrication-auto-assign.js';
import { ACTIVE_FABRICATION_STATUSES } from '../modules/projects/fabrication-scheduling.js';
import { findFabricationTeamProblems } from '../modules/projects/fabrication-team-audit.js';

async function diagnoseFabricationOverlap() {
  await connectDB();
  const problems = await findFabricationTeamProblems();

  console.log('\nFabrication teams: one project in the workshop per fabricator, one assignment per project\n');
  if (!problems.overlaps.length && !problems.doubleOnTeam.length && !problems.repeatedAutoAssign.length) {
    console.log('No overlap: every fabricator has at most one project in the workshop, and no project was assigned twice.');
  }
  for (const overlap of problems.overlaps) {
    console.log(`OVERLAP  ${overlap.name} (${overlap.staffId}) is on ${overlap.projects.length} workshop projects: `
      + overlap.projects.map((project) => `${project.projectNumber ?? project.projectId} (${project.role})`).join(', '));
  }
  for (const double of problems.doubleOnTeam) {
    console.log(`DOUBLE   ${double.projectNumber ?? double.projectId}: ${double.problem === 'lead_is_assistant'
      ? 'the lead is also listed as an assistant'
      : 'an assistant is listed twice'}`);
  }
  for (const repeated of problems.repeatedAutoAssign) {
    console.log(`DOUBLE   ${repeated.projectNumber ?? repeated.projectId} was assigned automatically ${repeated.count} times`);
  }

  const waiting = await listProjectsWaitingForFabricator();
  console.log(`\nInfo: ${waiting.length} paid project(s) waiting for a fabricator${waiting.length
    ? `: ${waiting.map((project) => project.projectNumber ?? String(project._id)).join(', ')}` : ''}.`);

  const active = await Project.find({ status: { $in: ACTIVE_FABRICATION_STATUSES }, fabricationLeadId: { $ne: null } })
    .select('projectNumber fabricationLeadId').lean();
  const leadIds = active.map((project) => project.fabricationLeadId).filter(Boolean).map(String);
  const leads = await User.find({ _id: { $in: leadIds } })
    .select('firstName lastName isActive availabilityStatus').lean();
  const away = new Map(leads
    .filter((lead) => !lead.isActive || [StaffAvailabilityStatus.ON_LEAVE, StaffAvailabilityStatus.UNAVAILABLE].includes(lead.availabilityStatus as StaffAvailabilityStatus))
    .map((lead) => [String(lead._id), `${lead.firstName ?? ''} ${lead.lastName ?? ''}`.trim() + (lead.isActive ? ` (${lead.availabilityStatus})` : ' (inactive)')]));
  for (const project of active) {
    const lead = away.get(String(project.fabricationLeadId));
    if (lead) console.log(`Info: ${project.projectNumber}: the lead ${lead} cannot work on it now; the engineer or admin can change the team.`);
  }

  const problemCount = problems.overlaps.length + problems.doubleOnTeam.length + problems.repeatedAutoAssign.length;
  if (problemCount) process.exitCode = 2;
}

diagnoseFabricationOverlap()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
