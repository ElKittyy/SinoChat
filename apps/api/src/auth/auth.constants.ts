import {
  readNodeEnvironment,
  readSessionConfig
} from "../config/runtime-config";

const settings = () => readSessionConfig();

export const sessionCookieName = () => settings().sessionCookieName;

export const csrfCookieName = () => settings().csrfCookieName;

export const sessionCookieOptions = (maxAge?: number) => ({
  httpOnly: true,
  secure: readNodeEnvironment() === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: maxAge ?? settings().sessionTtlHours * 60 * 60 * 1_000
});

export const csrfCookieOptions = (maxAge?: number) => ({
  ...sessionCookieOptions(maxAge),
  httpOnly: false
});
