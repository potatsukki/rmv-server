import { Role } from '../../utils/constants.js';
import { emitRoleEvent, emitUserEvent } from '../notifications/socket.service.js';

/** Socket event: a project's fabrication team, stage or status changed. Payload: `{ projectId }`. */
export const FABRICATION_TEAM_UPDATED_EVENT = 'fabrication:team-updated';

/**
 * Roles that open a team, assistants or fabricator picker. The picker lists every fabricator's
 * load, so all of them must refresh, not only the people on this project.
 */
const TEAM_VIEWER_ROLES = [Role.ADMIN, Role.ENGINEER, Role.FABRICATION_STAFF];

/**
 * Realtime, no browser refresh (2026-11-28). Tells every open screen that shows this project's
 * team, its fabrication stage, or anyone's workload to reload. The payload is only the project id,
 * and each screen refetches what its own user may see. A missed push never fails the change.
 */
export function emitFabricationTeamChanged(project: { _id: unknown; customerId?: unknown; salesStaffId?: unknown }) {
  try {
    const payload = { projectId: String(project._id) };
    for (const role of TEAM_VIEWER_ROLES) emitRoleEvent(role, FABRICATION_TEAM_UPDATED_EVENT, payload);
    for (const userId of new Set([project.customerId, project.salesStaffId].filter(Boolean).map(String))) {
      emitUserEvent(userId, FABRICATION_TEAM_UPDATED_EVENT, payload);
    }
  } catch {
    // Lists still refresh on their 30 s poll and when the socket reconnects.
  }
}
