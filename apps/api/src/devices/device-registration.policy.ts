export type FirstDeviceRegistrationDecision =
  | "ALLOW"
  | "DEVICE_HISTORY_EXISTS"
  | "SESSION_ALREADY_BOUND";

export function evaluateFirstDeviceRegistration(
  historicalDeviceCount: number,
  sessionDeviceId: string | null
): FirstDeviceRegistrationDecision {
  if (historicalDeviceCount > 0) {
    return "DEVICE_HISTORY_EXISTS";
  }
  if (sessionDeviceId !== null) {
    return "SESSION_ALREADY_BOUND";
  }
  return "ALLOW";
}
