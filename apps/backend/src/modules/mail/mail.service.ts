import { Injectable, Logger } from '@nestjs/common';
import nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 1025),
    secure: false,
  });

  async sendInvite(opts: {
    to: string;
    inviter: string;
    workspaceName: string;
    acceptUrl: string;
  }) {
    const info = await this.transport.sendMail({
      from: 'Syncra <noreply@syncra.dev>',
      to: opts.to,
      subject: `You've been invited to ${opts.workspaceName}`,
      text: `${opts.inviter} invited you to join "${opts.workspaceName}" on Syncra.\n\nAccept: ${opts.acceptUrl}\n\nThis link expires in 7 days.`,
      html: `<p>${opts.inviter} invited you to join <strong>${opts.workspaceName}</strong>.</p>
             <p><a href="${opts.acceptUrl}">Accept invitation</a></p>
             <p style="color:#888;font-size:12px">This link expires in 7 days.</p>`,
    });
    this.logger.log(`invite -> ${opts.to} (messageId ${info.messageId})`);
  }
}
