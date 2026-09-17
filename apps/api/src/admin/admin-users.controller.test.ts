import { deepEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { AssignmentsService } from "../assignments/assignments.service";
import { ADMIN_AUTOMATIC_REASON } from "./admin-automatic-reason";
import { AdminUsersController } from "./admin-users.controller";
import { AdminUsersService } from "./admin-users.service";

describe("contrato de acciones administrativas ordinarias", () => {
  it("no propaga motivos libres y genera la reasignación con un código del servidor", async () => {
    const calls: unknown[][] = [];
    const users = {
      update: async (...args: unknown[]) => calls.push(["update", ...args]),
      deleteUser: async (...args: unknown[]) =>
        calls.push(["delete", ...args]),
      resetPassword: async (...args: unknown[]) =>
        calls.push(["password", ...args]),
      approveCashier: async (...args: unknown[]) =>
        calls.push(["approve", ...args]),
      suspend: async (...args: unknown[]) =>
        calls.push(["suspend", ...args]),
      reactivate: async (...args: unknown[]) =>
        calls.push(["reactivate", ...args]),
      activateSubscription: async (...args: unknown[]) =>
        calls.push(["subscription-activate", ...args]),
      deactivateSubscription: async (...args: unknown[]) =>
        calls.push(["subscription-deactivate", ...args])
    } as unknown as AdminUsersService;
    const assignments = {
      reassignAdministrative: async (...args: unknown[]) =>
        calls.push(["client-reassign", ...args]),
      reassignAssignmentAdministrative: async (...args: unknown[]) =>
        calls.push(["assignment-reassign", ...args])
    } as unknown as AssignmentsService;
    const controller = new AdminUsersController(users, assignments);
    const admin = { id: "admin-id" } as never;
    const userId = "11111111-1111-4111-8111-111111111111";
    const assignmentId = "22222222-2222-4222-8222-222222222222";

    await controller.update(admin, userId, { username: "usuario-nuevo" });
    await controller.deleteUser(admin, userId, {});
    await controller.resetPassword(admin, userId, {});
    await controller.approveCashier(admin, userId, {});
    await controller.suspend(admin, userId, {});
    await controller.reactivate(admin, userId, {});
    await controller.activateSubscription(admin, userId, {
      endsAt: "2027-01-01T00:00:00.000Z"
    });
    await controller.deactivateSubscription(admin, userId, {});
    await controller.reassign(admin, userId, {});
    await controller.reassignAssignment(admin, assignmentId, {});

    deepEqual(calls, [
      ["update", "admin-id", userId, { username: "usuario-nuevo" }],
      ["delete", "admin-id", userId],
      ["password", "admin-id", userId],
      ["approve", "admin-id", userId],
      ["suspend", "admin-id", userId],
      ["reactivate", "admin-id", userId],
      [
        "subscription-activate",
        "admin-id",
        userId,
        "2027-01-01T00:00:00.000Z"
      ],
      ["subscription-deactivate", "admin-id", userId],
      [
        "client-reassign",
        "admin-id",
        userId,
        ADMIN_AUTOMATIC_REASON.CLIENT_REASSIGNED
      ],
      [
        "assignment-reassign",
        "admin-id",
        assignmentId,
        ADMIN_AUTOMATIC_REASON.CLIENT_REASSIGNED
      ]
    ]);
  });
});
