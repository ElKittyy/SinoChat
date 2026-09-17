import type { Prisma } from "../generated/prisma/client";

/**
 * Publicar/retirar términos y registrar una aceptación forman un único
 * ciclo de vida. Todos esos escritores deben tomar este mismo advisory lock
 * transaccional antes de consultar el reloj y el documento vigente.
 */
export const TERMS_LIFECYCLE_ADVISORY_LOCK =
  "sinochat:terms-lifecycle";

export async function lockTermsLifecycle(
  transaction: Prisma.TransactionClient
): Promise<void> {
  const [row] = await transaction.$queryRaw<Array<{ locked: number }>>`
    SELECT 1 AS locked
      FROM (
        SELECT pg_advisory_xact_lock(
          hashtextextended(${TERMS_LIFECYCLE_ADVISORY_LOCK}, 0)
        )
      ) AS acquired
  `;
  if (row?.locked !== 1) {
    throw new Error(
      "No se pudo adquirir el bloqueo del ciclo de vida legal."
    );
  }
}
