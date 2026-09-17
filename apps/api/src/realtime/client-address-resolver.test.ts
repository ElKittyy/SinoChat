import { equal, throws } from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { describe, it } from "node:test";
import { ClientAddressResolver } from "./client-address-resolver";

describe("ClientAddressResolver", () => {
  it("ignora X-Forwarded-For cuando TRUST_PROXY=none", () => {
    const resolver = new ClientAddressResolver(false);
    equal(
      resolver.resolve(
        request("198.51.100.20", "203.0.113.99")
      ),
      "198.51.100.20"
    );
  });

  it("un par no confiable no puede falsificar la IP por header", () => {
    const resolver = new ClientAddressResolver(["10.0.0.0/8"]);
    equal(
      resolver.resolve(
        request("198.51.100.20", "203.0.113.99")
      ),
      "198.51.100.20"
    );
  });

  it("distingue clientes detrás del mismo reverse proxy confiable", () => {
    const resolver = new ClientAddressResolver(["10.0.0.0/8"]);
    const first = resolver.resolve(
      request("10.20.30.40", "203.0.113.10")
    );
    const second = resolver.resolve(
      request("10.20.30.40", "203.0.113.11")
    );
    equal(first, "203.0.113.10");
    equal(second, "203.0.113.11");
  });

  it("reproduce la semántica de cantidad de saltos de Express", () => {
    const resolver = new ClientAddressResolver(1);
    equal(
      resolver.resolve(
        request(
          "10.20.30.40",
          "198.51.100.10, 203.0.113.50"
        )
      ),
      "203.0.113.50"
    );
  });

  it("falla cerrado ante una dirección resuelta inválida", () => {
    const resolver = new ClientAddressResolver(["10.0.0.0/8"]);
    throws(
      () => resolver.resolve(request("10.20.30.40", "not-an-ip")),
      /dirección de cliente válida/
    );
  });
});

function request(
  remoteAddress: string,
  forwardedFor?: string
): IncomingMessage {
  return {
    headers: forwardedFor
      ? { "x-forwarded-for": forwardedFor }
      : {},
    socket: { remoteAddress }
  } as unknown as IncomingMessage;
}
