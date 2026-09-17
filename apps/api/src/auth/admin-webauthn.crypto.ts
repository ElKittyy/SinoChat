import { Injectable } from "@nestjs/common";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type VerifiedAuthenticationResponse,
  type VerifiedRegistrationResponse
} from "@simplewebauthn/server";
import { readWebAuthnConfig } from "../config/runtime-config";

export interface StoredAdminPasskey {
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: AuthenticatorTransportFuture[];
}

@Injectable()
export class AdminWebAuthnCrypto {
  private readonly config = readWebAuthnConfig();

  registrationOptions(input: {
    username: string;
    userHandle: Uint8Array;
    credentials: readonly Pick<StoredAdminPasskey, "credentialId" | "transports">[];
  }): Promise<PublicKeyCredentialCreationOptionsJSON> {
    return generateRegistrationOptions({
      rpName: this.config.webAuthnRpName,
      rpID: this.config.webAuthnRpId,
      userID: input.userHandle,
      userName: input.username,
      userDisplayName: input.username,
      attestationType: "none",
      excludeCredentials: input.credentials.map((credential) => ({
        id: credential.credentialId,
        transports: credential.transports
      })),
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required"
      },
      timeout: 5 * 60_000
    });
  }

  authenticationOptions(
    credentials: readonly Pick<StoredAdminPasskey, "credentialId" | "transports">[]
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return generateAuthenticationOptions({
      rpID: this.config.webAuthnRpId,
      allowCredentials: credentials.map((credential) => ({
        id: credential.credentialId,
        transports: credential.transports
      })),
      userVerification: "required",
      timeout: 5 * 60_000
    });
  }

  verifyRegistration(
    response: RegistrationResponseJSON,
    challenge: string
  ): Promise<VerifiedRegistrationResponse> {
    return verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.config.webAuthnOrigin,
      expectedRPID: this.config.webAuthnRpId,
      requireUserPresence: true,
      requireUserVerification: true
    });
  }

  verifyAuthentication(
    response: AuthenticationResponseJSON,
    challenge: string,
    credential: StoredAdminPasskey
  ): Promise<VerifiedAuthenticationResponse> {
    return verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.config.webAuthnOrigin,
      expectedRPID: this.config.webAuthnRpId,
      credential: {
        id: credential.credentialId,
        publicKey: credential.publicKey,
        counter: credential.counter,
        transports: credential.transports
      },
      requireUserVerification: true
    });
  }
}
