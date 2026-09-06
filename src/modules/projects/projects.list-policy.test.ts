import { describe, expect, it } from 'vitest';

import {
  activeProjectStatusesForRoles,
  canViewProjectTotalCost,
  maskProjectTotalCostForActor,
} from './projects.list-policy.js';
import { ProjectStatus, Role } from '../../utils/constants.js';

describe('activeProjectStatusesForRoles', () => {
  it('keeps fabrication staff active queue fabrication-only', () => {
    expect(activeProjectStatusesForRoles([Role.FABRICATION_STAFF])).toEqual([
      ProjectStatus.FABRICATION,
    ]);
  });

  it('keeps engineer active queue out of draft and payment-pending work', () => {
    expect(activeProjectStatusesForRoles([Role.ENGINEER])).toEqual([
      ProjectStatus.SUBMITTED,
      ProjectStatus.BLUEPRINT,
      ProjectStatus.FABRICATION,
    ]);
  });

  it('includes contract-required draft work in the sales active queue', () => {
    expect(activeProjectStatusesForRoles([Role.SALES_STAFF])).toEqual([
      ProjectStatus.DRAFT,
      ProjectStatus.SUBMITTED,
      ProjectStatus.BLUEPRINT,
      ProjectStatus.APPROVED,
      ProjectStatus.FABRICATION,
    ]);
  });
});

describe('canViewProjectTotalCost', () => {
  it.each([
    Role.SALES_STAFF,
    Role.CASHIER,
  ])('allows %s to view project totals', (role) => {
    expect(canViewProjectTotalCost([role])).toBe(true);
  });

  it('allows customers to view only an owned project total', () => {
    expect(canViewProjectTotalCost([Role.CUSTOMER], true)).toBe(true);
    expect(canViewProjectTotalCost([Role.CUSTOMER], false)).toBe(false);
  });

  it('does not let an additional customer role unmask another project for admin', () => {
    expect(canViewProjectTotalCost([Role.ADMIN, Role.CUSTOMER], false)).toBe(false);
  });

  it.each([
    Role.ADMIN,
    Role.ENGINEER,
    Role.FABRICATION_STAFF,
  ])('keeps project totals masked for %s', (role) => {
    expect(canViewProjectTotalCost([role])).toBe(false);
  });
});

describe('maskProjectTotalCostForActor', () => {
  const project = {
    _id: 'project-1',
    customerId: { _id: 'customer-1', firstName: 'Gene' },
    totalCost: 125_000,
  };

  it('keeps the amount for the owning customer and financial staff', () => {
    expect(maskProjectTotalCostForActor(project, 'customer-1', [Role.CUSTOMER]).totalCost).toBe(125_000);
    expect(maskProjectTotalCostForActor(project, 'sales-1', [Role.SALES_STAFF]).totalCost).toBe(125_000);
  });

  it.each([
    Role.ADMIN,
    Role.ENGINEER,
    Role.FABRICATION_STAFF,
  ])('removes the amount from %s mutation/read responses', (role) => {
    expect(maskProjectTotalCostForActor(project, 'staff-1', [role]).totalCost).toBeUndefined();
  });

  it('does not expose another customer project and leaves the source object unchanged', () => {
    const masked = maskProjectTotalCostForActor(project, 'customer-2', [Role.CUSTOMER]);
    expect(masked.totalCost).toBeUndefined();
    expect(project.totalCost).toBe(125_000);
  });
});
