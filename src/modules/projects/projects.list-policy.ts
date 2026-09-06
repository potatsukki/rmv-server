import { ProjectStatus, Role } from '../../utils/constants.js';

export function canViewProjectTotalCost(
  actorRoles: Role[],
  customerOwnsProject = false,
) {
  if (actorRoles.some((role) => [Role.SALES_STAFF, Role.CASHIER].includes(role))) {
    return true;
  }

  return actorRoles.includes(Role.CUSTOMER) && customerOwnsProject;
}

function projectCustomerId(customerId: unknown): string | undefined {
  if (typeof customerId === 'string') return customerId;
  if (!customerId || typeof customerId !== 'object') return undefined;

  const populatedId = (customerId as { _id?: unknown })._id;
  if (populatedId !== undefined && populatedId !== null) return String(populatedId);

  const value = String(customerId);
  return value === '[object Object]' ? undefined : value;
}

export function maskProjectTotalCostForActor<T extends Record<string, any>>(
  project: T,
  actorId: string,
  actorRoles: Role[],
): T {
  const customerOwnsProject = actorRoles.includes(Role.CUSTOMER)
    && projectCustomerId(project.customerId) === actorId;

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
