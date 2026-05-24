import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';
import { IdentityMiddleware } from './identity.middleware';

@Module({
  controllers: [IdentityController],
  providers: [IdentityService, IdentityMiddleware],
  exports: [IdentityService],
})
export class IdentityModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Run the identity middleware on every API route except auth itself.
    // Express 5 / path-to-regexp v8 requires named wildcards (no bare '*').
    consumer.apply(IdentityMiddleware).forRoutes('api/*path');
  }
}