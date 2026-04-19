import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getData(): { message: string } {
    return { message: 'Hello from Syncra API' };
  }

  getHealth(): { status: string; uptime: number } {
    return { status: 'ok', uptime: process.uptime() };
  }
}
