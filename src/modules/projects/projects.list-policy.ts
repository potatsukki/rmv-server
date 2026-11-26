import { AppError } from '../../utils/appError.js';
import { ProjectStatus, Role } from '../../utils/constants.js';

/**
 * Projects a customer may see: every project of theirs, with or without a signed contract
 * (user decision 2026-11-26; it used to wait for the contract). The project list and the customer
 * dashboard counts both use this, so the numbers match what the customer can open.
 */
export function customerVisibleProjectsFilter(customerId: string): Record<string, unknown> {
  return { customerId };
}

export function usesFabricationProjectScope(roles: readonly string[]) {
  return roles.includes(Role.FABRICATION_STAFF)
    && ![Role.ADMIN, Role.SALES_STAFF, Role.ENGINEER, Role.CASHIER].some((role) => roles.includes(role));
}

export function assignedFabricationProjectsFilter(actorId: string) {
  return {
    $or: [
      { fabricationLeadId: actorId },
      { fabricationAssistantIds: actorId },
      { deliveryCrewIds: actorId },
    ],
  };
}

interface FabricationAssignment {
  fabricationLeadId?: unknown;
  fabricationAssistantIds?: readonly unknown[] | null;
  deliveryCrewIds?: readonly unknown[] | null;
}

export function isAssignedFabricationMember(project: FabricationAssignment, actorId: string) {
  return [project.fabricationLeadId, ...(project.fabricationAssistantIds ?? []), ...(project.deliveryCrewIds ?? [])]
    .some((member) => projectUserId(member) === actorId);
}

export function assertFabricatorProjectAccess(project: FabricationAssignment, actorId: string, roles: readonly Role[]) {
  if (usesFabricationProjectScope(roles) && !isAssignedFabricationMember(project, actorId)) {
    throw AppError.forbidden('You are not assigned to this project');
  }
}

export function canViewProjectTotalCost(
  actorRoles: Role[],
  customerOwnsProject = false,
) {
  if (actorRoles.some((role) => [Role.SALES_STAFF, Role.CASHIER].includes(role))) {
    return true;
  }

  return actorRoles.includes(Role.CUSTOMER) && customerOwnsProject;
}

function projectUserId(userId: unknown): string | undefined {
  if (typeof userId === 'string') return userId;
  if (!userId || typeof userId !== 'object') return undefined;

  const populatedId = (userId as { _id?: unknown })._id;
  if (populatedId !== undefined && populatedId !== null) return String(populatedId);

  const value = String(userId);
  return value === '[object Object]' ? undefined : value;
}

export function maskProjectTotalCostForActor<T extends Record<string, any>>(
  project: T,
  actorId: string,
  actorRoles: Role[],
): T {
  const customerOwnsProject = actorRoles.includes(Role.CUSTOMER)
    && projectUserId(project.customerId) === actorId;

  if (canViewProjectTotalCost(actorRoles, customerOwnsProject)) return project;
  return { ...project, totalCost: undefined };
}

export function activeProjectStatusesForRoles(actorRoles: Role[]) {
  const isAdmin = actorRoles.includes(Role.ADMIN);
  const isCustomerOnly = actorRoles.includes(Role.CUSTOMER)
    && !actorRoles.some((role) => [Role.ADMIN, Role.SALES_STAFF, Role.ENGINEER].includes(role));
  const isSalesOnly = actorRoles.includes(Role.SALES_STAFF)
    && !actorRoles.includes(Role.ADMIN);
  const isEngineerOnly = actorRoles.includes(Role.ENGINEER)
    && !actorRoles.some((role) => [Role.ADMIN, Role.SALES_STAFF].includes(role));
  const isFabricationOnly = actorRoles.includes(Role.FABRICATION_STAFF)
    && !actorRoles.some((role) => [Role.ADMIN, Role.ENGINEER].includes(role));

  if (isFabricationOnly) return [ProjectStatus.FABRICATION];
  if (isEngineerOnly) return [ProjectStatus.SUBMITTED, ProjectStatus.BLUEPRINT, ProjectStatus.FABRICATION];
  if (isSalesOnly) {
    return [
      ProjectStatus.DRAFT,
      ProjectStatus.SUBMITTED,
      ProjectStatus.BLUEPRINT,
      ProjectStatus.APPROVED,
      ProjectStatus.FABRICATION,
    ];
  }
  if (isCustomerOnly || isAdmin) {
    return [
      ProjectStatus.SUBMITTED,
      ProjectStatus.BLUEPRINT,
      ProjectStatus.APPROVED,
      ProjectStatus.PAYMENT_PENDING,
      ProjectStatus.FABRICATION,
    ];
  }

  return [
    ProjectStatus.SUBMITTED,
    ProjectStatus.BLUEPRINT,
    ProjectStatus.APPROVED,
    ProjectStatus.FABRICATION,
  ];
}
