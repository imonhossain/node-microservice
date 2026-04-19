import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let app: TestingModule;

  beforeAll(async () => {
    app = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();
  });

  describe('getData', () => {
    it('should return the greeting', () => {
      const appController = app.get<AppController>(AppController);
      expect(appController.getData()).toEqual({
        message: 'Hello from Syncra API',
      });
    });
  });

  describe('getHealth', () => {
    it('should report status ok', () => {
      const appController = app.get<AppController>(AppController);
      const result = appController.getHealth();
      expect(result.status).toBe('ok');
      expect(typeof result.uptime).toBe('number');
    });
  });
});
