import { Controller, Get } from "@nestjs/common";
import { E2EE_RELEASE } from "./e2ee-release";

@Controller("e2ee")
export class E2eeController {
  @Get("status")
  getStatus() {
    return E2EE_RELEASE;
  }
}
