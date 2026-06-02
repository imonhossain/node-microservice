import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';
import { WorkspaceMiddleware } from './workspace.middleware';

@Module({
  controllers: [WorkspaceController],
  providers: [WorkspaceService, WorkspaceMiddleware],
  exports: [WorkspaceService],
})
export class WorkspaceModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(WorkspaceMiddleware)
      .forRoutes(
        { path: 'api/workspaces/:slug/*', method: RequestMethod.ALL },
        { path: 'api/workspaces/:slug', method: RequestMethod.ALL },
      );
  }
}
