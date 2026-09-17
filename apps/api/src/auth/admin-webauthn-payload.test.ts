import { equal, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractWebAuthnChallenge,
  hashWebAuthnChallenge
} from "./admin-webauthn-payload";

const CHALLENGE = "A".repeat(43);

function responseWithClientData(value: unknown) {
  return {
    response: {
      clientDataJSON: Buffer.from(JSON.stringify(value), "utf8").toString(
        "base64url"
      )
    }
  };
}

describe("admin WebAuthn client data", () => {
  it("extrae el desafío canónico que luego verifica la biblioteca", () => {
    equal(
      extractWebAuthnChallenge(
        responseWithClientData({
          type: "webauthn.get",
          challenge: CHALLENGE,
          origin: "http://localhost:5173"
        })
      ),
      CHALLENGE
    );
    equal(hashWebAuthnChallenge(CHALLENGE).length, 64);
  });

  it("rechaza Base64 no canónico, UTF-8 inválido y desafíos débiles", () => {
    throws(
      () =>
        extractWebAuthnChallenge({
          response: { clientDataJSON: "e30=" }
        }),
      /WEBAUTHN_CLIENT_DATA_INVALID/
    );
    throws(
      () =>
        extractWebAuthnChallenge({
          response: {
            clientDataJSON: Buffer.from([0xff, 0xfe]).toString("base64url")
          }
        }),
      /WEBAUTHN_CLIENT_DATA_INVALID/
    );
    throws(
      () =>
        extractWebAuthnChallenge(
          responseWithClientData({ challenge: "corto" })
        ),
      /WEBAUTHN_CHALLENGE_INVALID/
    );
  });

  it("rechaza ceremonias delegadas por un origen superior", () => {
    throws(
      () =>
        extractWebAuthnChallenge(
          responseWithClientData({
            type: "webauthn.get",
            challenge: CHALLENGE,
            origin: "http://localhost:5173",
            crossOrigin: true,
            topOrigin: "https://sitio-hostil.example"
          })
        ),
      /WEBAUTHN_CROSS_ORIGIN_FORBIDDEN/
    );
    throws(
      () =>
        extractWebAuthnChallenge(
          responseWithClientData({
            type: "webauthn.get",
            challenge: CHALLENGE,
            origin: "http://localhost:5173",
            crossOrigin: "false"
          })
        ),
      /WEBAUTHN_CROSS_ORIGIN_FORBIDDEN/
    );
    throws(
      () =>
        extractWebAuthnChallenge(
          responseWithClientData({
            type: "webauthn.get",
            challenge: CHALLENGE,
            origin: "http://localhost:5173",
            crossOrigin: false,
            topOrigin: "http://localhost:5173"
          })
        ),
      /WEBAUTHN_CROSS_ORIGIN_FORBIDDEN/
    );
  });
});
