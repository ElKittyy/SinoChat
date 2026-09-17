import {
  Injectable,
  ServiceUnavailableException,
  type CanActivate
} from "@nestjs/common";
import { E2EE_RELEASE, isE2eeReleased } from "./e2ee-release";

@Injectable()
export class E2eeReleaseGuard implements CanActivate {
  canActivate(): boolean {
    if (!isE2eeReleased()) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: E2EE_RELEASE.reasonCode,
        message: E2EE_RELEASE.message
      });
    }

    return true;
  }
}
