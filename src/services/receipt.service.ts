import PDFDocument from 'pdfkit';
import { formatCurrency, generateReceiptNumber } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

export interface ReceiptData {
  receiptNumber: string;
  customerName: string;
  customerEmail: string;
  projectTitle: string;
  stageName: string;
  amountPaid: number;
  paymentMethod: string;
  referenceNumber?: string;
  creditApplied: number;
  excessCredit: number;
  verifiedByName: string;
  verifiedAt: Date;
  totalProjectCost: number;
  totalPaid: number;
  totalOutstanding: number;
}

/**
 * Generate a receipt PDF and return as Buffer
 */
export async function generateReceiptPdf(data: ReceiptData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 50,
        info: {
          Title: `Receipt ${data.receiptNumber}`,
          Author: 'RMV Stainless Steel Fabrication',
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const pageWidth = doc.page.width - 100; // margins

      // ── Header ──
      doc
        .fontSize(20)
        .font('Helvetica-Bold')
        .text('RMV STAINLESS STEEL FABRICATION', { align: 'center' });

      doc
        .fontSize(10)
        .font('Helvetica')
        .text('Malabon City, Metro Manila, Philippines', { align: 'center' })
        .moveDown(0.5);

      doc
        .fontSize(16)
        .font('Helvetica-Bold')
        .text('OFFICIAL RECEIPT', { align: 'center' })
        .moveDown(1);

      // ── Receipt Info ──
      drawLine(doc);
      doc.moveDown(0.5);

      const leftCol = 50;
      const rightCol = 350;
      const lineHeight = 18;

      let y = doc.y;

      // Left side
      doc.fontSize(10).font('Helvetica-Bold').text('Receipt No:', leftCol, y);
      doc.font('Helvetica').text(data.receiptNumber, leftCol + 80, y);

      // Right side
      doc.font('Helvetica-Bold').text('Date:', rightCol, y);
      doc.font('Helvetica').text(
        data.verifiedAt.toLocaleDateString('en-PH', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          timeZone: 'Asia/Manila',
        }),
        rightCol + 40,
        y,
      );

      y += lineHeight + 5;

      doc.font('Helvetica-Bold').text('Customer:', leftCol, y);
      doc.font('Helvetica').text(data.customerName, leftCol + 80, y);

      doc.font('Helvetica-Bold').text('Email:', rightCol, y);
      doc.font('Helvetica').text(data.customerEmail, rightCol + 40, y, {
        width: pageWidth - rightCol + 50,
      });

      y += lineHeight + 5;

      doc.font('Helvetica-Bold').text('Project:', leftCol, y);
      doc.font('Helvetica').text(data.projectTitle, leftCol + 80, y, {
        width: 230,
      });

      doc.y = y + lineHeight + 15;

      // ── Payment Details Table ──
      drawLine(doc);
      doc.moveDown(0.5);

      doc.fontSize(12).font('Helvetica-Bold').text('PAYMENT DETAILS');
      doc.moveDown(0.5);

      const tableData = [
        ['Stage', data.stageName],
        ['Payment Method', data.paymentMethod.replace(/_/g, ' ').toUpperCase()],
        ['Amount Paid', formatCurrency(data.amountPaid)],
      ];

      if (data.referenceNumber) {
        tableData.push(['Reference No.', data.referenceNumber]);
      }

      if (data.creditApplied > 0) {
        tableData.push(['Credit Applied', formatCurrency(data.creditApplied)]);
      }

      if (data.excessCredit > 0) {
        tableData.push(['Excess Credit (Carry Forward)', formatCurrency(data.excessCredit)]);
      }

      for (const [label, value] of tableData) {
        y = doc.y;
        doc.fontSize(10).font('Helvetica-Bold').text(label + ':', leftCol, y, { width: 200 });
        doc.font('Helvetica').text(value, leftCol + 210, y);
        doc.moveDown(0.3);
      }

      doc.moveDown(1);

      // ── Project Summary ──
      drawLine(doc);
      doc.moveDown(0.5);

      doc.fontSize(12).font('Helvetica-Bold').text('PROJECT SUMMARY');
      doc.moveDown(0.5);

      const summaryData = [
        ['Total Project Cost', formatCurrency(data.totalProjectCost)],
        ['Total Paid', formatCurrency(data.totalPaid)],
        ['Outstanding Balance', formatCurrency(data.totalOutstanding)],
      ];

      for (const [label, value] of summaryData) {
        y = doc.y;
        doc.fontSize(10).font('Helvetica-Bold').text(label + ':', leftCol, y, { width: 200 });
        doc.font('Helvetica').text(value, leftCol + 210, y);
        doc.moveDown(0.3);
      }

      doc.moveDown(1);

      // ── Verified By ──
      drawLine(doc);
      doc.moveDown(0.5);

      doc.fontSize(10).font('Helvetica-Bold').text('Verified By: ', leftCol);
      doc.font('Helvetica').text(data.verifiedByName, leftCol + 80, doc.y - doc.currentLineHeight());

      doc.moveDown(2);

      // ── Footer ──
      drawLine(doc);
      doc.moveDown(0.5);

      doc
        .fontSize(8)
        .font('Helvetica')
        .fillColor('#666666')
        .text(
          'This is a system-generated receipt. For questions or concerns, please contact RMV Stainless Steel Fabrication.',
          { align: 'center' },
        )
        .moveDown(0.3)
        .text(
          `Generated on ${new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}`,
          { align: 'center' },
        );

      doc.end();
    } catch (error) {
      logger.error('Failed to generate receipt PDF', error);
      reject(error);
    }
  });
}

function drawLine(doc: PDFKit.PDFDocument) {
  const y = doc.y;
  doc
    .strokeColor('#cccccc')
    .lineWidth(1)
    .moveTo(50, y)
    .lineTo(doc.page.width - 50, y)
    .stroke();
}
