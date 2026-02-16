import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import sgMail from '@sendgrid/mail';
import Handlebars from 'handlebars';
import { env } from '../../config/env.js';
import { EmailLog } from '../../models/index.js';
import { EmailLogStatus } from '../../utils/constants.js';
import { logger } from '../../utils/logger.js';

type EmailAttachment = { content: string; filename: string; type: string };

const useSendGridApi = env.EMAIL_PROVIDER === 'sendgrid_api';

if (useSendGridApi) {
  sgMail.setApiKey(env.SENDGRID_API_KEY);
}

const transporter: Transporter | null = useSendGridApi
  ? null
  : nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
      },
    });

// Template definitions
const templates: Record<string, string> = {
  otp: `
    <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
      <div style="text-align: center; padding: 20px; background: #1a1a2e; color: white; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0;">RMV Stainless Steel</h1>
      </div>
      <div style="padding: 30px; background: #f9f9f9; border-radius: 0 0 8px 8px;">
        <h2>Email Verification</h2>
        <p>Your OTP code is:</p>
        <div style="text-align: center; padding: 20px; background: white; border-radius: 8px; margin: 20px 0;">
          <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #1a1a2e;">{{otp}}</span>
        </div>
        <p style="color: #666;">This code expires in 3 minutes. Do not share it with anyone.</p>
      </div>
    </div>
  `,
  password_reset: `
    <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
      <div style="text-align: center; padding: 20px; background: #1a1a2e; color: white; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0;">RMV Stainless Steel</h1>
      </div>
      <div style="padding: 30px; background: #f9f9f9; border-radius: 0 0 8px 8px;">
        <h2>Password Reset</h2>
        <p>Your password reset OTP is:</p>
        <div style="text-align: center; padding: 20px; background: white; border-radius: 8px; margin: 20px 0;">
          <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #1a1a2e;">{{otp}}</span>
        </div>
        <p style="color: #666;">This code expires in 3 minutes. If you didn't request this, ignore this email.</p>
      </div>
    </div>
  `,
  appointment_confirmed: `
    <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
      <div style="text-align: center; padding: 20px; background: #1a1a2e; color: white; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0;">RMV Stainless Steel</h1>
      </div>
      <div style="padding: 30px; background: #f9f9f9; border-radius: 0 0 8px 8px;">
        <h2>Appointment Confirmed</h2>
        <p>Your appointment has been confirmed:</p>
        <ul>
          <li><strong>Date:</strong> {{date}}</li>
          <li><strong>Time:</strong> {{time}}</li>
          <li><strong>Type:</strong> {{type}}</li>
        </ul>
        <p style="color: #666;">Please arrive on time. Contact us if you need to reschedule.</p>
      </div>
    </div>
  `,
  blueprint_uploaded: `
    <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
      <div style="text-align: center; padding: 20px; background: #1a1a2e; color: white; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0;">RMV Stainless Steel</h1>
      </div>
      <div style="padding: 30px; background: #f9f9f9; border-radius: 0 0 8px 8px;">
        <h2>Blueprint Ready for Review</h2>
        <p>A new blueprint (Version {{version}}) has been uploaded for your project <strong>{{projectTitle}}</strong>.</p>
        <p>Please review and approve or request changes within 1 day.</p>
      </div>
    </div>
  `,
  payment_verified: `
    <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
      <div style="text-align: center; padding: 20px; background: #1a1a2e; color: white; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0;">RMV Stainless Steel</h1>
      </div>
      <div style="padding: 30px; background: #f9f9f9; border-radius: 0 0 8px 8px;">
        <h2>Payment Verified</h2>
        <p>Your payment of <strong>{{amount}}</strong> for <strong>{{stageLabel}}</strong> has been verified.</p>
        <p>Receipt number: <strong>{{receiptNumber}}</strong></p>
        <p>A receipt PDF is attached to this email.</p>
      </div>
    </div>
  `,
  payment_declined: `
    <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
      <div style="text-align: center; padding: 20px; background: #1a1a2e; color: white; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0;">RMV Stainless Steel</h1>
      </div>
      <div style="padding: 30px; background: #f9f9f9; border-radius: 0 0 8px 8px;">
        <h2>Payment Proof Declined</h2>
        <p>Your payment proof for <strong>{{stageLabel}}</strong> has been declined.</p>
        <p><strong>Reason:</strong> {{reason}}</p>
        <p>Please resubmit a valid proof of payment.</p>
      </div>
    </div>
  `,
  fabrication_update: `
    <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
      <div style="text-align: center; padding: 20px; background: #1a1a2e; color: white; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0;">RMV Stainless Steel</h1>
      </div>
      <div style="padding: 30px; background: #f9f9f9; border-radius: 0 0 8px 8px;">
        <h2>Fabrication Update</h2>
        <p>Your project <strong>{{projectTitle}}</strong> has been updated to: <strong>{{status}}</strong></p>
        <p>{{notes}}</p>
      </div>
    </div>
  `,
};

// Compile templates
const compiledTemplates: Record<string, HandlebarsTemplateDelegate> = {};
for (const [key, html] of Object.entries(templates)) {
  compiledTemplates[key] = Handlebars.compile(html);
}

// Retry config
const RETRY_DELAYS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000]; // 1min, 5min, 15min

async function sendWithProvider(
  to: string,
  subject: string,
  html: string,
  attachments?: EmailAttachment[],
): Promise<void> {
  if (useSendGridApi) {
    await sgMail.send({
      to,
      from: {
        email: env.SMTP_FROM_EMAIL,
        name: env.SMTP_FROM_NAME,
      },
      subject,
      html,
      attachments: attachments?.map(a => ({
        content: a.content,
        filename: a.filename,
        type: a.type,
        disposition: 'attachment',
      })),
    });
    return;
  }

  if (!transporter) {
    throw new Error('SMTP transporter is not configured');
  }

  await transporter.sendMail({
    to,
    from: `"${env.SMTP_FROM_NAME}" <${env.SMTP_FROM_EMAIL}>`,
    subject,
    html,
    attachments: attachments?.map(a => ({
      content: Buffer.from(a.content, 'base64'),
      filename: a.filename,
      contentType: a.type,
    })),
  });
}

// Core send function
async function sendEmail(
  to: string,
  subject: string,
  templateKey: string,
  data: Record<string, unknown>,
  attachments?: EmailAttachment[],
): Promise<void> {
  const htmlContent = compiledTemplates[templateKey]
    ? compiledTemplates[templateKey](data)
    : `<p>${JSON.stringify(data)}</p>`;

  const emailLog = await EmailLog.create({
    to,
    subject,
    template: templateKey,
    status: EmailLogStatus.PENDING,
    relatedType: data.relatedType as string,
    relatedId: data.relatedId as import('mongoose').Types.ObjectId,
  });

  try {
    await sendWithProvider(to, subject, htmlContent, attachments);

    emailLog.status = EmailLogStatus.SENT;
    emailLog.attempts = 1;
    emailLog.lastAttemptAt = new Date();
    await emailLog.save();
  } catch (error) {
    logger.error('Email send failed:', { to, subject, error });
    emailLog.status = EmailLogStatus.FAILED;
    emailLog.attempts = 1;
    emailLog.lastAttemptAt = new Date();
    emailLog.errorMessage = (error as Error).message;

    // Schedule retry
    if (RETRY_DELAYS.length > 0) {
      emailLog.nextRetryAt = new Date(Date.now() + RETRY_DELAYS[0]);
    }
    await emailLog.save();
  }
}

// Public email functions

export async function sendOtpEmail(to: string, otp: string): Promise<void> {
  await sendEmail(to, 'Email Verification - RMV Stainless Steel', 'otp', { otp });
}

export async function sendPasswordResetEmail(to: string, otp: string): Promise<void> {
  await sendEmail(to, 'Password Reset - RMV Stainless Steel', 'password_reset', { otp });
}

export async function sendAppointmentConfirmedEmail(
  to: string,
  data: { date: string; time: string; type: string },
): Promise<void> {
  await sendEmail(to, 'Appointment Confirmed - RMV Stainless Steel', 'appointment_confirmed', data);
}

export async function sendBlueprintUploadedEmail(
  to: string,
  data: { version: number; projectTitle: string },
): Promise<void> {
  await sendEmail(to, 'Blueprint Ready for Review - RMV Stainless Steel', 'blueprint_uploaded', data);
}

export async function sendPaymentVerifiedEmail(
  to: string,
  data: { amount: string; stageLabel: string; receiptNumber: string },
  receiptPdf?: Buffer,
): Promise<void> {
  const attachments = receiptPdf
    ? [{ content: receiptPdf.toString('base64'), filename: `receipt-${data.receiptNumber}.pdf`, type: 'application/pdf' }]
    : undefined;

  await sendEmail(to, `Payment Receipt ${data.receiptNumber} - RMV Stainless Steel`, 'payment_verified', data, attachments);
}

export async function sendPaymentDeclinedEmail(
  to: string,
  data: { stageLabel: string; reason: string },
): Promise<void> {
  await sendEmail(to, 'Payment Proof Declined - RMV Stainless Steel', 'payment_declined', data);
}

export async function sendFabricationUpdateEmail(
  to: string,
  data: { projectTitle: string; status: string; notes: string },
): Promise<void> {
  await sendEmail(to, 'Fabrication Update - RMV Stainless Steel', 'fabrication_update', data);
}

// Retry processor (called by cron or startup)
export async function processEmailRetries(): Promise<void> {
  const failedEmails = await EmailLog.find({
    status: EmailLogStatus.FAILED,
    nextRetryAt: { $lte: new Date() },
    attempts: { $lt: 4 }, // Max 3 retries + 1 initial
  });

  for (const emailLog of failedEmails) {
    try {
      const htmlContent = compiledTemplates[emailLog.template]
        ? compiledTemplates[emailLog.template]({})
        : '';

      await sendWithProvider(emailLog.to, emailLog.subject, htmlContent);

      emailLog.status = EmailLogStatus.SENT;
      emailLog.lastAttemptAt = new Date();
      emailLog.attempts += 1;
      await emailLog.save();
    } catch (error) {
      emailLog.attempts += 1;
      emailLog.lastAttemptAt = new Date();
      emailLog.errorMessage = (error as Error).message;

      const retryIndex = emailLog.attempts - 1;
      if (retryIndex < RETRY_DELAYS.length) {
        emailLog.nextRetryAt = new Date(Date.now() + RETRY_DELAYS[retryIndex]);
      } else {
        emailLog.nextRetryAt = undefined;
      }
      await emailLog.save();
    }
  }
}
