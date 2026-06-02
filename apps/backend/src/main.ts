import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { ExpressAuth } from '@auth/express';
import { AppModule } from './app/app.module';
import { authConfig } from './auth/auth.config';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.use(cookieParser());

  // Auth.js handles every /api/auth/* route (signin, callback, signout, session).
  // It MUST be mounted before Nest's router so it owns those paths.
  // Express 5: mount as a path prefix (no bare '*' — that's not a valid pattern anymore).
  app.use('/api/auth', ExpressAuth(authConfig));

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  Logger.log(`API running on http://localhost:${port}`);
}

bootstrap();