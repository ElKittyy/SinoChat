import { SetMetadata } from "@nestjs/common";

export const SKIP_CSRF_KEY = "sinochat:skip-csrf";
export const SkipCsrf = () => SetMetadata(SKIP_CSRF_KEY, true);

