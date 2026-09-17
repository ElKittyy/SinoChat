import { equal, rejects } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecutionContext } from "@nestjs/common";
import { BrowserMutationGuard } from "./browser-mutation.guard";

describe("BrowserMutationGuard", () => {
  it("permite lecturas y JSON desde el origen configurado", () => {
    withTestEnvironment(() => {
      const guard = new BrowserMutationGuard();
      equal(
        guard.canActivate(context("GET", undefined, undefined, false)),
        true
      );
      equal(
        guard.canActivate(
          context(
            "POST",
            "http://localhost:5173",
            "same-site",
            true
          )
        ),
        true
      );
    });
  });

  it("rechaza formularios, Origin ajeno y Fetch Metadata cross-site", async () => {
    await withTestEnvironment(async () => {
      const guard = new BrowserMutationGuard();

      await rejects(async () =>
        guard.canActivate(
          context("POST", "http://localhost:5173", "same-site", false)
        )
      );
      await rejects(async () =>
        guard.canActivate(
          context("POST", "https://atacante.example", "same-site", true)
        )
      );
      await rejects(async () =>
        guard.canActivate(
          context("POST", "http://localhost:5173", "cross-site", true)
        )
      );
    });
  });
});

function withTestEnvironment<T>(operation: () => T): T {
  const previousNodeEnvironment = process.env.NODE_ENV;
  const previousWebOrigin = process.env.WEB_ORIGIN;
  process.env.NODE_ENV = "test";
  process.env.WEB_ORIGIN = "http://localhost:5173";

  try {
    const result = operation();
    if (result instanceof Promise) {
      return result.finally(() => {
        restore("NODE_ENV", previousNodeEnvironment);
        restore("WEB_ORIGIN", previousWebOrigin);
      }) as T;
    }
    restore("NODE_ENV", previousNodeEnvironment);
    restore("WEB_ORIGIN", previousWebOrigin);
    return result;
  } catch (error) {
    restore("NODE_ENV", previousNodeEnvironment);
    restore("WEB_ORIGIN", previousWebOrigin);
    throw error;
  }
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function context(
  method: string,
  origin: string | undefined,
  fetchSite: string | undefined,
  isJson: boolean
): ExecutionContext {
  const request = {
    method,
    get(name: string) {
      if (name.toLowerCase() === "origin") return origin;
      if (name.toLowerCase() === "sec-fetch-site") return fetchSite;
      return undefined;
    },
    is(type: string) {
      return type === "application/json" && isJson;
    }
  };

  return {
    getType: () => "http",
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => undefined,
      getNext: () => undefined
    })
  } as unknown as ExecutionContext;
}
