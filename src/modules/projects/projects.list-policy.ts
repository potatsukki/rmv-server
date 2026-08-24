import { ProjectStatus, Role } from '../../utils/constants.js';

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
