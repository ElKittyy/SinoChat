import "../config/load-env";
import { AccountStatus, UserRole } from "../generated/prisma/enums";
import { PasswordService } from "../auth/password.service";
import { PrismaService } from "../database/prisma.service";

async function bootstrapAdmin(): Promise<void> {
  const username = process.env.ADMIN_BOOTSTRAP_USERNAME?.trim();
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;

  if (!username || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
    throw new Error("ADMIN_BOOTSTRAP_USERNAME no es válido.");
  }
  if (!password || password.length < 14) {
    throw new Error(
      "ADMIN_BOOTSTRAP_PASSWORD debe tener al menos 14 caracteres."
    );
  }

  const prisma = new PrismaService();
  try {
    await prisma.$connect();
    const normalizedUsername = username.toLowerCase();
    const existing = await prisma.user.findUnique({
      where: { normalizedUsername },
      select: { id: true, role: true }
    });

    if (existing) {
      if (existing.role !== UserRole.ADMIN) {
        throw new Error("El nombre ya pertenece a otro tipo de cuenta.");
      }
      console.log("La cuenta administradora ya existe; no se modificó.");
      return;
    }

    const passwords = new PasswordService();
    const passwordHash = await passwords.hash(password);
    await prisma.user.create({
      data: {
        username,
        normalizedUsername,
        passwordHash,
        role: UserRole.ADMIN,
        status: AccountStatus.ACTIVE
      }
    });

    console.log("Cuenta administradora creada correctamente.");
  } finally {
    await prisma.$disconnect();
  }
}

void bootstrapAdmin().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Error desconocido";
  console.error(`No se pudo crear la cuenta administradora: ${message}`);
  process.exitCode = 1;
});
