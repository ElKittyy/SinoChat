export const E2EE_RELEASE = Object.freeze({
  state: "BLOCKED" as const,
  reasonCode: "E2EE_INTEGRATION_INCOMPLETE" as const,
  protocol: "Matrix Olm/Megolm" as const,
  clientLibrary: "@matrix-org/matrix-sdk-crypto-wasm" as const,
  clientLibraryVersion: "18.6.0" as const,
  matrixSpecificationVersion: "v1.18" as const,
  messageRetentionHours: 48 as const,
  message:
    "El chat permanece deshabilitado hasta completar la integracion Matrix, la recuperacion segura y la revision independiente."
});

export type E2eeReleaseStatus = typeof E2EE_RELEASE;

/**
 * Esta funcion solo puede devolver true cuando el estado compilado cambie a
 * READY junto con la implementacion y sus pruebas. No existe una variable de
 * entorno que permita saltar accidentalmente este gate en produccion.
 */
export function isE2eeReleased(): boolean {
  return (E2EE_RELEASE.state as string) === "READY";
}
