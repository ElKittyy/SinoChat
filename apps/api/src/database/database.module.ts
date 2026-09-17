import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { MatrixDeviceListPublisher } from "./matrix-device-list.publisher";

@Global()
@Module({
  providers: [PrismaService, MatrixDeviceListPublisher],
  exports: [PrismaService, MatrixDeviceListPublisher]
})
export class DatabaseModule {}
