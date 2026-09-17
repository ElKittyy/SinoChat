import { Prisma } from "../generated/prisma/client";
import type { PrismaService } from "../database/prisma.service";

export async function runOperationalTransaction<T>(
  prisma: PrismaService,
  operation: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5_000,
        timeout: 30_000
      });
    } catch (error) {
      const retryable =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034";
      if (!retryable || attempt === maxAttempts) {
        throw error;
      }
    }
  }
  throw new Error("No se pudo completar la transacción operativa.");
}

export async function lockOperationalResource(
  tx: Prisma.TransactionClient,
  resource: string
): Promise<void> {
  const [row] = await tx.$queryRaw<Array<{ locked: number }>>`
    SELECT 1 AS locked
      FROM (
        SELECT pg_advisory_xact_lock(hashtextextended(${resource}, 0))
      ) AS acquired
  `;
  if (row?.locked !== 1) {
    throw new Error("No se pudo adquirir el bloqueo operativo.");
  }
}

export async function databaseClock(
  tx: Prisma.TransactionClient
): Promise<Date> {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT clock_timestamp() AS now
  `;
  if (!row?.now) {
    throw new Error("No se pudo consultar el reloj de PostgreSQL.");
  }
  return row.now;
}
