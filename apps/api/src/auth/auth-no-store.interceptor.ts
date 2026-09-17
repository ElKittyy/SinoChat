import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor
} from "@nestjs/common";
import type { Response } from "express";
import type { Observable } from "rxjs";

@Injectable()
export class AuthNoStoreInterceptor implements NestInterceptor {
  intercept(
    context: ExecutionContext,
    next: CallHandler
  ): Observable<unknown> {
    const response = context.switchToHttp().getResponse<Response>();
    response.setHeader("Cache-Control", "no-store, max-age=0");
    response.setHeader("Pragma", "no-cache");
    response.setHeader("Expires", "0");
    return next.handle();
  }
}
