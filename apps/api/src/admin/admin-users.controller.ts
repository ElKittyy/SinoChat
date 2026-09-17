import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards
} from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import type { PublicUser } from "../auth/auth.types";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { AssignmentsService } from "../assignments/assignments.service";
import { UserRole } from "../generated/prisma/enums";
import {
  ActivateSubscriptionDto,
  AdminActionDto
} from "./dto/admin-action.dto";
import {
  DeleteAdminUserDto,
  ResetAdminPasswordDto,
  UpdateAdminUserDto
} from "./dto/admin-user-mutation.dto";
import {
  AdminAssignmentsQueryDto,
  AdminSubscriptionsQueryDto
} from "./dto/admin-directory-query.dto";
import { AdminUsersQueryDto } from "./dto/admin-users-query.dto";
import { ADMIN_AUTOMATIC_REASON } from "./admin-automatic-reason";
import { AdminUsersService } from "./admin-users.service";

@Controller("admin")
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminUsersController {
  constructor(
    private readonly users: AdminUsersService,
    private readonly assignments: AssignmentsService
  ) {}

  @Get("users")
  list(@Query() query: AdminUsersQueryDto) {
    return this.users.list(query);
  }

  @Get("assignments")
  listAssignments(@Query() query: AdminAssignmentsQueryDto) {
    return this.users.listAssignments(query);
  }

  @Get("subscriptions")
  listSubscriptions(@Query() query: AdminSubscriptionsQueryDto) {
    return this.users.listSubscriptions(query);
  }

  @Get("users/:userId")
  detail(
    @Param("userId", new ParseUUIDPipe({ version: "4" })) userId: string
  ) {
    return this.users.detail(userId);
  }

  @Patch("users/:userId")
  update(
    @CurrentUser() admin: PublicUser,
    @Param("userId", new ParseUUIDPipe({ version: "4" })) userId: string,
    @Body() input: UpdateAdminUserDto
  ) {
    return this.users.update(admin.id, userId, input);
  }

  @Delete("users/:userId")
  deleteUser(
    @CurrentUser() admin: PublicUser,
    @Param("userId", new ParseUUIDPipe({ version: "4" })) userId: string,
    @Body() _input: DeleteAdminUserDto
  ) {
    return this.users.deleteUser(admin.id, userId);
  }

  @Patch("users/:userId/password")
  resetPassword(
    @CurrentUser() admin: PublicUser,
    @Param("userId", new ParseUUIDPipe({ version: "4" })) userId: string,
    @Body() _input: ResetAdminPasswordDto
  ) {
    return this.users.resetPassword(admin.id, userId);
  }

  @Patch("cashiers/:userId/approve")
  approveCashier(
    @CurrentUser() admin: PublicUser,
    @Param("userId", new ParseUUIDPipe({ version: "4" })) userId: string,
    @Body() _input: AdminActionDto
  ) {
    return this.users.approveCashier(admin.id, userId);
  }

  @Patch("users/:userId/suspend")
  suspend(
    @CurrentUser() admin: PublicUser,
    @Param("userId", new ParseUUIDPipe({ version: "4" })) userId: string,
    @Body() _input: AdminActionDto
  ) {
    return this.users.suspend(admin.id, userId);
  }

  @Patch("users/:userId/reactivate")
  reactivate(
    @CurrentUser() admin: PublicUser,
    @Param("userId", new ParseUUIDPipe({ version: "4" })) userId: string,
    @Body() _input: AdminActionDto
  ) {
    return this.users.reactivate(admin.id, userId);
  }

  @Patch("cashiers/:userId/subscription/activate")
  activateSubscription(
    @CurrentUser() admin: PublicUser,
    @Param("userId", new ParseUUIDPipe({ version: "4" })) userId: string,
    @Body() input: ActivateSubscriptionDto
  ) {
    return this.users.activateSubscription(
      admin.id,
      userId,
      input.endsAt
    );
  }

  @Patch("cashiers/:userId/subscription/deactivate")
  deactivateSubscription(
    @CurrentUser() admin: PublicUser,
    @Param("userId", new ParseUUIDPipe({ version: "4" })) userId: string,
    @Body() _input: AdminActionDto
  ) {
    return this.users.deactivateSubscription(admin.id, userId);
  }

  @Post("clients/:userId/reassign")
  reassign(
    @CurrentUser() admin: PublicUser,
    @Param("userId", new ParseUUIDPipe({ version: "4" })) userId: string,
    @Body() _input: AdminActionDto
  ) {
    return this.assignments.reassignAdministrative(
      admin.id,
      userId,
      ADMIN_AUTOMATIC_REASON.CLIENT_REASSIGNED
    );
  }

  @Post("assignments/:assignmentId/reassign")
  reassignAssignment(
    @CurrentUser() admin: PublicUser,
    @Param("assignmentId", new ParseUUIDPipe({ version: "4" }))
    assignmentId: string,
    @Body() _input: AdminActionDto
  ) {
    return this.assignments.reassignAssignmentAdministrative(
      admin.id,
      assignmentId,
      ADMIN_AUTOMATIC_REASON.CLIENT_REASSIGNED
    );
  }
}
