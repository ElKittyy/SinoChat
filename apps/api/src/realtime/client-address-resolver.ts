import { Injectable } from "@nestjs/common";
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import type { TrustProxySetting } from "../config/runtime-config";

type ProxyTrust = (address: string, index: number) => boolean;
interface ProxyAddressPackage {
  (request: IncomingMessage, trust: ProxyTrust): string;
  compile(value: string | string[]): ProxyTrust;
}

const proxyAddress = require("proxy-addr") as ProxyAddressPackage;

@Injectable()
export class ClientAddressResolver {
  private readonly trust: ProxyTrust;

  constructor(trustProxy: TrustProxySetting) {
    this.trust = compileTrustProxy(trustProxy);
  }

  resolve(request: IncomingMessage): string {
    const address = proxyAddress(request, this.trust);
    if (!address || isIP(address) === 0) {
      throw new Error("No se pudo resolver una dirección de cliente válida.");
    }
    return address;
  }
}

export function compileTrustProxy(
  trustProxy: TrustProxySetting
): ProxyTrust {
  if (trustProxy === false) {
    return () => false;
  }
  if (typeof trustProxy === "number") {
    return (_address, index) => index < trustProxy;
  }
  return proxyAddress.compile(trustProxy);
}
