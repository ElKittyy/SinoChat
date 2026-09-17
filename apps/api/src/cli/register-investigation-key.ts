import "../config/load-env";
import { PrismaService } from "../database/prisma.service";
import {
  isHelpRequest,
  parseInvestigationKeyInput
} from "./operational-input";
import {
  databaseClock,
  lockOperationalResource,
  runOperationalTransaction
} from "./operational-transaction";

const HELP = `
Registra y activa una clave PÚBLICA de investigación.

Uso:
  npm run investigation-key:register -- \\
    --public-key-base64 <DER-SPKI-en-Base64> \\
    --algorithm <identificador> \\
    --fingerprint <sha256-hex> \\
    --version <entero>

Variables equivalentes:
  INVESTIGATION_PUBLIC_KEY_BASE64
  INVESTIGATION_KEY_ALGORITHM
  INVESTIGATION_KEY_FINGERPRINT
  INVESTIGATION_KEY_VERSION

Esta CLI rechaza argumentos desconocidos y variables conocidas de clave privada.
`.trim();

interface RegistrationResult {
  created: boolean;
  key: {
    id: string;
    version: number;
    algorithm: string;
    fingerprint: string;
    activatedAt: Date;
    retiredAt: Date | null;
  };
  previousRetired?: {
    id: string;
    version: number;
    retiredAt: Date;
  };
}

async function registerInvestigationKey(): Promise<void> {
  const argv = process.argv.slice(2);
  if (isHelpRequest(argv)) {
    console.log(HELP);
    return;
  }
  const input = parseInvestigationKeyInput(argv, process.env);

  const prisma = new PrismaService();
  try {
    await prisma.$connect();
    const result = await runOperationalTransaction(
      prisma,
      async (tx): Promise<RegistrationResult> => {
        await lockOperationalResource(
          tx,
          "sinochat:investigation-key-rotation"
        );
        const now = await databaseClock(tx);

        const existingVersion =
          await tx.investigationKey.findUnique({
            where: { version: input.version },
            select: {
              id: true,
              version: true,
              algorithm: true,
              publicKey: true,
              fingerprint: true,
              activatedAt: true,
              retiredAt: true
            }
          });
        if (existingVersion) {
          const isSame =
            existingVersion.algorithm === input.algorithm &&
            existingVersion.fingerprint === input.fingerprint &&
            Buffer.from(existingVersion.publicKey).equals(
              input.publicKey
            );
          if (!isSame) {
            throw new Error(
              "La versión ya existe con otro algoritmo o material público."
            );
          }
          const isActive =
            existingVersion.activatedAt <= now &&
            (!existingVersion.retiredAt ||
              existingVersion.retiredAt > now);
          if (!isActive) {
            throw new Error(
              "La clave ya existe pero está retirada; una clave retirada nunca se reactiva."
            );
          }
          return {
            created: false,
            key: existingVersion
          };
        }

        const sameFingerprint =
          await tx.investigationKey.findUnique({
            where: { fingerprint: input.fingerprint },
            select: { version: true }
          });
        if (sameFingerprint) {
          throw new Error(
            `El fingerprint ya pertenece a la versión ${sameFingerprint.version}.`
          );
        }

        const [latest, activeKeys, unretiredKeys] =
          await Promise.all([
            tx.investigationKey.findFirst({
              orderBy: { version: "desc" },
              select: { version: true }
            }),
            tx.investigationKey.findMany({
              where: {
                activatedAt: { lte: now },
                OR: [
                  { retiredAt: null },
                  { retiredAt: { gt: now } }
                ]
              },
              orderBy: { activatedAt: "desc" },
              take: 2,
              select: {
                id: true,
                version: true,
                activatedAt: true,
                retiredAt: true
              }
            }),
            tx.investigationKey.findMany({
              where: { retiredAt: null },
              orderBy: { activatedAt: "desc" },
              take: 2,
              select: {
                id: true,
                version: true,
                activatedAt: true
              }
            })
          ]);

        if (latest && input.version <= latest.version) {
          throw new Error(
            "La nueva versión debe ser mayor que todas las anteriores."
          );
        }
        if (activeKeys.length > 1 || unretiredKeys.length > 1) {
          throw new Error(
            "El historial contiene más de una clave activa o sin retiro."
          );
        }
        if (
          unretiredKeys[0] &&
          unretiredKeys[0].activatedAt > now
        ) {
          throw new Error(
            "Ya existe una rotación futura programada; no se activó otra clave."
          );
        }
        if (
          activeKeys[0] &&
          unretiredKeys[0] &&
          activeKeys[0].id !== unretiredKeys[0].id
        ) {
          throw new Error(
            "El historial contiene una rotación programada incompatible."
          );
        }
        if (activeKeys[0]?.retiredAt) {
          throw new Error(
            "La clave activa ya tiene un retiro programado."
          );
        }

        let previousRetired: RegistrationResult["previousRetired"];
        if (activeKeys[0]) {
          if (now <= activeKeys[0].activatedAt) {
            throw new Error(
              "La nueva activación debe ser posterior a la clave anterior."
            );
          }
          const retired = await tx.investigationKey.updateMany({
            where: {
              id: activeKeys[0].id,
              retiredAt: null
            },
            data: { retiredAt: now }
          });
          if (retired.count !== 1) {
            throw new Error(
              "La clave activa cambió durante la rotación."
            );
          }
          previousRetired = {
            id: activeKeys[0].id,
            version: activeKeys[0].version,
            retiredAt: now
          };
        } else if (unretiredKeys[0]) {
          throw new Error(
            "Existe una clave sin retiro que no aparece como activa."
          );
        }

        const key = await tx.investigationKey.create({
          data: {
            version: input.version,
            algorithm: input.algorithm,
            publicKey: input.publicKey,
            fingerprint: input.fingerprint,
            createdAt: now,
            activatedAt: now
          },
          select: {
            id: true,
            version: true,
            algorithm: true,
            fingerprint: true,
            activatedAt: true,
            retiredAt: true
          }
        });
        return {
          created: true,
          key,
          previousRetired
        };
      }
    );

    console.log(
      JSON.stringify(
        {
          status: result.created ? "ACTIVATED" : "UNCHANGED",
          id: result.key.id,
          version: result.key.version,
          algorithm: result.key.algorithm,
          fingerprint: result.key.fingerprint,
          publicKeyByteSize: input.publicKey.byteLength,
          activatedAt: result.key.activatedAt.toISOString(),
          retiredAt: result.key.retiredAt?.toISOString() ?? null,
          previousRetired: result.previousRetired
            ? {
                ...result.previousRetired,
                retiredAt:
                  result.previousRetired.retiredAt.toISOString()
              }
            : null
        },
        null,
        2
      )
    );
  } finally {
    await prisma.$disconnect();
  }
}

void registerInvestigationKey().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : "Error desconocido";
  console.error(
    `No se pudo registrar la clave pública de investigación: ${message}`
  );
  process.exitCode = 1;
});
