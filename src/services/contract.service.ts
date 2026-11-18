import React from 'react';
import { renderToBuffer } from '@react-pdf/renderer';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import { r2Client } from '../config/r2.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { ContractDocument } from './contract.document.js';

/**
 * Download a file from R2 as a Buffer (used for embedding signature images)
 */
async function downloadR2Buffer(key: string): Promise<Buffer | null> {
  try {
    const command = new GetObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key: key,
    });
    const response = await r2Client.send(command);
    if (!response.Body) return null;
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (err) {
    logger.warn(`Failed to download R2 file ${key} for contract embedding`, err);
    return null;
  }
}

export interface ContractData {
  projectTitle: string;
  projectDescription: string;
  siteAddress: string;
  serviceType: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  customerAddress?: string;
  engineerNames: string[];
  totalAmount: number;
  paymentType: 'full' | 'installment';
  stages: { label: string; percentage: number; amount: number; description?: string }[];
  estimatedDuration?: string;
  materialType?: string;
  finishColor?: string;
  quantity: number;
  customerSignatureKey?: string | null;
  engineerSignatureKey?: string | null;
  contractSignedAt?: Date | string | null;
  lineItems?: { label: string; length?: number; width?: number; height?: number; quantity?: number; notes?: string }[];
  measurementUnit?: string;
  quotationLineItems?: { label: string; quantity: number; materials: number; labor: number; amount: number }[];
  quotationFees?: number;
  /** Row label for quotationFees; "Other Fees" when not set. */
  quotationFeesLabel?: string;
  quotationValidityDays?: number;
  scopeOfWork?: string;
}

/**
 * Generate a SERVICE CONTRACT PDF using @react-pdf/renderer, return as Buffer
 */
export async function generateContractPdf(
  data: ContractData,
  watermark: 'ORIGINAL' | 'COPY',
): Promise<Buffer> {
  let signatureDataUri: string | null = null;
  if (data.customerSignatureKey) {
    const buf = await downloadR2Buffer(data.customerSignatureKey);
    if (buf) {
      signatureDataUri = `data:image/png;base64,${buf.toString('base64')}`;
    }
  }

  let engineerSignatureDataUri: string | null = null;
  if (data.engineerSignatureKey) {
    const buf = await downloadR2Buffer(data.engineerSignatureKey);
    if (buf) {
      engineerSignatureDataUri = `data:image/png;base64,${buf.toString('base64')}`;
    }
  }

  const element = React.createElement(ContractDocument, {
    data,
    watermark,
    signatureDataUri,
    engineerSignatureDataUri,
  });

  const pdfBuffer = await renderToBuffer(element as any);
  return Buffer.from(pdfBuffer);
}

/**
 * Generate both ORIGINAL and COPY contract PDFs, upload to R2, return keys
 */
export async function generateAndUploadContract(
  data: ContractData,
): Promise<{ originalKey: string; copyKey: string }> {
  const [originalBuf, copyBuf] = await Promise.all([
    generateContractPdf(data, 'ORIGINAL'),
    generateContractPdf(data, 'COPY'),
  ]);

  const id = uuidv4();
  const originalKey = `contracts/${id}-original.pdf`;
  const copyKey = `contracts/${id}-copy.pdf`;

  await Promise.all([
    r2Client.send(
      new PutObjectCommand({
        Bucket: env.R2_BUCKET_NAME,
        Key: originalKey,
        Body: originalBuf,
        ContentType: 'application/pdf',
      }),
    ),
    r2Client.send(
      new PutObjectCommand({
        Bucket: env.R2_BUCKET_NAME,
        Key: copyKey,
        Body: copyBuf,
        ContentType: 'application/pdf',
      }),
    ),
  ]);

  logger.info(`Contract PDFs uploaded: ${originalKey}, ${copyKey}`);

  return { originalKey, copyKey };
}