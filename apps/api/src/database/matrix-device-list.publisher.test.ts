import { deepEqual, equal, match } from "node:assert/strict";
import { describe, it } from "node:test";
import type { Prisma } from "../generated/prisma/client";
import { MatrixDeviceListPublisher } from "./matrix-device-list.publisher";

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const CASHIER_ID = "22222222-2222-4222-8222-222222222222";
const DEVICE_ID = "33333333-3333-4333-8333-333333333333";

describe("MatrixDeviceListPublisher", () => {
  it("versiona una lista de dispositivos y hace fanout con una sola posicion", async () => {
    const createdAt = new Date("2026-08-28T10:00:00.000Z");
    let rawCall = 0;
    let createdRows: Array<Record<string, unknown>> = [];
    const transaction = {
      $queryRaw: async () => {
        rawCall += 1;
        return rawCall === 1
          ? [{ userId: CASHIER_ID }]
          : [{ version: 0n }];
      },
      matrixDeviceListState: {
        update: async () => ({ version: 1n })
      },
      matrixDeviceListStream: {
        update: async () => ({ position: 9n })
      },
      matrixDeviceListChange: {
        createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
          createdRows = data;
          return { count: data.length };
        }
      }
    } as unknown as Prisma.TransactionClient;

    await new MatrixDeviceListPublisher().publishDeviceSetChanged(
      transaction,
      CLIENT_ID,
      DEVICE_ID,
      createdAt
    );

    equal(createdRows.length, 2);
    deepEqual(
      createdRows.map((row) => row.recipientUserId),
      [CLIENT_ID, CASHIER_ID]
    );
    equal(createdRows[0]?.subjectVersion, 1n);
    equal(createdRows[0]?.streamPosition, 9n);
    equal(createdRows[0]?.sourceDeviceId, DEVICE_ID);
    equal(createdRows[0]?.changeType, "CHANGED");
    equal(createdRows[0]?.changeId, createdRows[1]?.changeId);
    match(String(createdRows[0]?.changeId), /^[0-9a-f-]{36}$/);
  });

  it("publica LEFT simetrico sin inventar una lista version cero", async () => {
    let rawCall = 0;
    let streamPosition = 0n;
    const createdRows: Array<Record<string, unknown>> = [];
    const transaction = {
      $queryRaw: async () => {
        rawCall += 1;
        return rawCall === 1 ? [{ version: 0n }] : [{ version: 4n }];
      },
      matrixDeviceListStream: {
        update: async () => ({ position: (streamPosition += 1n) })
      },
      matrixDeviceListChange: {
        createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
          createdRows.push(...data);
          return { count: data.length };
        }
      }
    } as unknown as Prisma.TransactionClient;

    await new MatrixDeviceListPublisher().publishRelationshipChanged(
      transaction,
      CLIENT_ID,
      CASHIER_ID,
      "LEFT",
      new Date("2026-08-28T10:00:00.000Z")
    );

    equal(createdRows.length, 1);
    equal(createdRows[0]?.subjectUserId, CASHIER_ID);
    equal(createdRows[0]?.recipientUserId, CLIENT_ID);
    equal(createdRows[0]?.subjectVersion, 4n);
    equal(createdRows[0]?.changeType, "LEFT");
    equal(streamPosition, 1n);
  });
});
