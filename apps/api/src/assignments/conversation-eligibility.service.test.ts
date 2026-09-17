import { equal, match, rejects } from "node:assert/strict";
import { describe, it } from "node:test";
import { PrismaService } from "../database/prisma.service";
import { ConversationEligibilityService } from "./conversation-eligibility.service";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";

function sqlText(query: unknown): string {
  if (query && typeof query === "object" && "sql" in query) {
    return String(query.sql);
  }
  return String(query);
}

function assertExactPolicy(sql: string): void {
  match(sql, /clock_timestamp/);
  match(sql, /approval_status[^]*APPROVED/);
  match(sql, /email_verified_at[^]*IS NOT NULL/);
  match(sql, /phone_verified_at[^]*IS NOT NULL/);
  match(sql, /cashier_user[^]*status[^]*ACTIVE/);
  match(sql, /cashier_user[^]*password_reset_required[^]*FALSE/);
  match(sql, /cs\."status" = 'ACTIVE'/);
  match(sql, /starts_at[^]*<= "current_clock"\."now"/);
  match(sql, /ends_at[^]*> "current_clock"\."now"/);
}

describe("ConversationEligibilityService", () => {
  it("bloquea la fila del usuario y rechaza operaciones durante el cambio obligatorio", async () => {
    let sql = "";
    const transaction = {
      $queryRaw: async (query: unknown) => {
        sql = sqlText(query);
        return [];
      }
    };
    const service = new ConversationEligibilityService({} as PrismaService);

    await rejects(() =>
      service.lockOperationalUser(transaction as never, USER_ID)
    );
    match(sql, /password_reset_required[^]*FALSE/);
    match(sql, /FOR SHARE OF u/);
  });

  it("centraliza la politica exacta para conversacion, presencia y realtime", async () => {
    const statements: string[] = [];
    const prisma = {
      $queryRaw: async (query: unknown) => {
        statements.push(sqlText(query));
        return [];
      }
    } as unknown as PrismaService;
    const service = new ConversationEligibilityService(prisma);

    equal(await service.findCurrent(USER_ID, CONVERSATION_ID), null);
    equal((await service.listCurrentCounterparts(USER_ID)).length, 0);
    equal(
      await service.findCurrentNewMessage(
        "33333333-3333-4333-8333-333333333333",
        CONVERSATION_ID,
        USER_ID
      ),
      null
    );
    equal(
      await service.findCurrentReceiptMessage(
        "33333333-3333-4333-8333-333333333333",
        USER_ID
      ),
      null
    );

    equal(statements.length, 4);
    for (const sql of statements) {
      assertExactPolicy(sql);
    }
  });

  it("considera vencido el periodo cuando endsAt es igual al reloj DB", async () => {
    const boundary = new Date("2026-08-02T15:00:00.000Z");
    const prisma = {
      $queryRaw: async () => [{ now: boundary }]
    } as unknown as PrismaService;
    const service = new ConversationEligibilityService(prisma);

    await rejects(() =>
      service.assertPeriodStillActive(prisma, boundary)
    );
  });

  it("bloquea tambien perfil, verificaciones y suscripcion", async () => {
    let sql = "";
    const transaction = {
      $queryRaw: async (query: unknown) => {
        sql = sqlText(query);
        return [];
      }
    };
    const service = new ConversationEligibilityService(
      {} as PrismaService
    );

    await rejects(() =>
      service.lockCurrent(
        transaction as never,
        USER_ID,
        CONVERSATION_ID
      )
    );
    assertExactPolicy(sql);
    match(
      sql,
      /FOR SHARE OF c, a, cp, cashier_user, client_user, cs/
    );
  });

  it("aplica la misma politica al rotar una invitacion de cajero", async () => {
    let sql = "";
    const transaction = {
      $queryRaw: async (query: unknown) => {
        sql = sqlText(query);
        return [];
      }
    };
    const service = new ConversationEligibilityService(
      {} as PrismaService
    );

    await rejects(() =>
      service.lockCurrentCashier(transaction as never, USER_ID)
    );
    assertExactPolicy(sql);
    match(sql, /cashier_user[^]*role[^]*CASHIER/);
    match(sql, /FOR SHARE OF cp, cashier_user, cs/);
  });
});
