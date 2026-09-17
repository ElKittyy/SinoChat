import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnsupportedMediaTypeException
} from "@nestjs/common";
import type { Request } from "express";
import {
  readNodeEnvironment,
  readWebOrigin
} from "../config/runtime-config";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Primera barrera contra CSRF de inicio de sesión y formularios cross-site.
 *
 * Las rutas públicas de ingreso y registro todavía no tienen una sesión con la
 * cual validar un token CSRF. Exigir JSON y un Origin confiable impide que un
 * sitio externo las invoque mediante un formulario HTML tradicional.
 */
@Injectable()
export class BrowserMutationGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== "http") {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request>();

    if (SAFE_METHODS.has(request.method.toUpperCase())) {
      return true;
    }

    if (!request.is("application/json")) {
      throw new UnsupportedMediaTypeException(
        "Las operaciones que modifican datos requieren application/json."
      );
    }

    const fetchSite = request.get("sec-fetch-site")?.toLowerCase();
    if (fetchSite === "cross-site") {
      throw new ForbiddenException("Origen de solicitud no permitido.");
    }

    const nodeEnvironment = readNodeEnvironment();
    const configuredOrigin = readWebOrigin(process.env, nodeEnvironment);
    const requestOrigin = request.get("origin");

    if (requestOrigin && this.normalizeOrigin(requestOrigin) !== configuredOrigin) {
      throw new ForbiddenException("Origen de solicitud no permitido.");
    }

    if (!requestOrigin && nodeEnvironment === "production") {
      throw new ForbiddenException("La solicitud debe declarar un origen.");
    }

    return true;
  }

  private normalizeOrigin(value: string): string {
    try {
      return new URL(value).origin;
    } catch {
      return "";
    }
  }
}
