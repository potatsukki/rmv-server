import React from 'react';
import {
  Document,
  Page,
  View,
  Text,
  Image,
  StyleSheet,
} from '@react-pdf/renderer';
import type { ContractData } from './contract.service.js';

/* ── Currency formatter (no ₱ needed – plain ASCII) ── */
function pdfCurrency(amount: number): string {
  return (
    'Php ' +
    amount.toLocaleString('en-PH', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

/* ── Styles ── */
const s = StyleSheet.create({
  page: {
    paddingTop: 50,
    paddingBottom: 60,
    paddingHorizontal: 50,
    fontFamily: 'Helvetica',
    fontSize: 9,
    color: '#333',
    lineHeight: 1.5,
  },

  /* watermark */
  watermark: {
    position: 'absolute',
    top: '38%',
    left: 0,
    right: 0,
    alignItems: 'center',
    transform: 'rotate(-45deg)',
    opacity: 0.05,
  },
  watermarkText: {
    fontSize: 72,
    fontFamily: 'Helvetica-Bold',
    color: '#000',
  },

  /* header */
  headerWrap: { alignItems: 'center', marginBottom: 10 },
  companyName: { fontSize: 16, fontFamily: 'Helvetica-Bold', color: '#1a1a1a' },
  companyAddr: { fontSize: 8, color: '#666', marginTop: 2 },
  title: { fontSize: 13, fontFamily: 'Helvetica-Bold', color: '#1a1a1a', marginTop: 8 },
  dateText: { fontSize: 8, color: '#888', marginTop: 4 },

  /* section primitives */
  divider: { borderBottomWidth: 0.5, borderBottomColor: '#ddd', marginVertical: 8 },
  sectionTitle: { fontSize: 10.5, fontFamily: 'Helvetica-Bold', color: '#1a1a1a', marginBottom: 4, marginTop: 2 },
  paragraph: { fontSize: 9, color: '#333', marginBottom: 4, lineHeight: 1.5 },
  bullet: { fontSize: 9, color: '#333', marginBottom: 2, paddingLeft: 14 },
  fieldRow: { flexDirection: 'row', marginBottom: 2 },
  fieldLabel: { fontFamily: 'Helvetica-Bold', fontSize: 9, color: '#555' },
  fieldValue: { fontSize: 9, color: '#1a1a1a', marginLeft: 4 },

  /* table */
  tHead: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: '#ccc', paddingBottom: 3, marginBottom: 3 },
  tRow: { flexDirection: 'row', marginBottom: 2 },
  th: { fontSize: 8, fontFamily: 'Helvetica-Bold', color: '#555' },
  td: { fontSize: 8, color: '#333' },

  /* signatures */
  sigSection: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginTop: 14 },
  sigBlock: { width: '45%', alignItems: 'center' },
  sigParty: { width: '100%', fontSize: 9, color: '#555', textAlign: 'center' },
  sigImage: { width: 150, height: 30, marginTop: 8 },
  sigLine: { width: '100%', borderBottomWidth: 0.5, borderBottomColor: '#333', marginBottom: 4 },
  sigName: { fontSize: 9, color: '#1a1a1a', textAlign: 'center' },
  sigRole: { fontSize: 8, color: '#888', marginTop: 2, textAlign: 'center' },

  /* footer */
  footer: {
    position: 'absolute',
    bottom: 25,
    left: 50,
    right: 50,
    alignItems: 'center',
    fontSize: 7,
    color: '#999',
  },
});

/* ── Tiny helpers ── */

const Divider = () => <View style={s.divider} />;
const Spacer = ({ h = 4 }: { h?: number }) => <View style={{ height: h }} />;

const SectionTitle = ({ children }: { children: string }) => (
  <Text style={s.sectionTitle}>{children}</Text>
);

const P = ({ children }: { children: string }) => (
  <Text style={s.paragraph}>{children}</Text>
);

const Bullet = ({ children }: { children: string }) => (
  <Text style={s.bullet}>{'\u2022  '}{children}</Text>
);

const Field = ({ label, value }: { label: string; value: string }) => (
  <View style={s.fieldRow}>
    <Text style={s.fieldLabel}>{label}:</Text>
    <Text style={s.fieldValue}>{value}</Text>
  </View>
);

/* ── Main Document ── */

export interface ContractDocumentProps {
  data: ContractData;
  watermark: 'ORIGINAL' | 'COPY';
  signatureDataUri?: string | null;
  engineerSignatureDataUri?: string | null;
}

export const ContractDocument: React.FC<ContractDocumentProps> = ({
  data,
  watermark,
  signatureDataUri,
  engineerSignatureDataUri,
}) => {
  const now = new Date();
  const fmtDate = now.toLocaleDateString('en-PH', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'Asia/Manila',
  });
  const fmtDateTime = now.toLocaleString('en-PH', { timeZone: 'Asia/Manila' });

  return (
    <Document
      title={`Service Contract - ${data.projectTitle} (${watermark})`}
      author="RMV Stainless Steel Fabrication"
    >
      <Page size="A4" style={s.page} wrap>
        {/* Watermark – fixed on every page */}
        <View style={s.watermark} fixed>
          <Text style={s.watermarkText}>{watermark}</Text>
        </View>

        {/* ── Header ── */}
        <View style={s.headerWrap}>
          <Text style={s.companyName}>RMV STAINLESS STEEL FABRICATION</Text>
          <Text style={s.companyAddr}>Quezon City, Metro Manila, Philippines</Text>
          <Text style={s.title}>SERVICE CONTRACT</Text>
          <Text style={s.dateText}>Date: {fmtDate}</Text>
        </View>
        <Divider />

        {/* ── 1  Parties ── */}
        <SectionTitle>1. PARTIES &amp; DATE</SectionTitle>
        <P>{`This Service Contract ("Contract") is entered into on ${fmtDate} by and between:`}</P>
        <Field label="Service Provider" value="RMV Stainless Steel Fabrication" />
        <Field label="Address" value="Quezon City, Metro Manila, Philippines" />
        <Spacer />
        <Field label="Client" value={data.customerName} />
        <Field label="Email" value={data.customerEmail} />
        {data.customerPhone ? <Field label="Phone" value={data.customerPhone} /> : null}
        {data.customerAddress ? <Field label="Address" value={data.customerAddress} /> : null}
        <Divider />

        {/* ── 2  Scope of Work ── */}
        <SectionTitle>2. SCOPE OF WORK</SectionTitle>
        <P>The Service Provider agrees to perform the following fabrication services:</P>
        <Field label="Project Title" value={data.projectTitle} />
        <Field label="Items" value={data.serviceType.replace(/_/g, ' ').toUpperCase()} />
        <Field label="Description" value={data.projectDescription} />
        <Field label="Site / Delivery Address" value={data.siteAddress} />
        <Field label="Quantity" value={String(data.quantity)} />
        <Divider />

        {/* ── 3  Plans & Specs ── */}
        <SectionTitle>3. PLANS &amp; SPECIFICATIONS</SectionTitle>
        <P>All fabrication shall be executed in accordance with the approved blueprint and specifications provided by the Service Provider and agreed upon by the Client.</P>

        {data.lineItems && data.lineItems.length > 0 ? (
          <View style={{ marginBottom: 4 }}>
            <Text style={{ fontSize: 9, fontFamily: 'Helvetica-Bold', color: '#333', marginBottom: 3 }}>
              Line Items:
            </Text>
            {data.lineItems.map((item, i) => {
              const dims = [item.length, item.width, item.height]
                .filter(Boolean)
                .join(' x ');
              const unit = data.measurementUnit || 'cm';
              return (
                <Text key={i} style={{ fontSize: 8, color: '#333', marginBottom: 1, paddingLeft: 10 }}>
                  {'- '}
                  {item.label}
                  {dims ? ` (${dims} ${unit})` : ''}
                  {item.quantity && item.quantity > 1 ? ` x${item.quantity}` : ''}
                  {item.notes ? ` -- ${item.notes}` : ''}
                </Text>
              );
            })}
          </View>
        ) : null}

        <Bullet>Any deviation from the approved plans must be documented as a Change Order (see Section 7).</Bullet>
        <Divider />

        {/* ── 4  Price & Payment ── */}
        <SectionTitle>4. CONTRACT PRICE &amp; PAYMENT TERMS</SectionTitle>
        <Field label="Total Contract Amount" value={pdfCurrency(data.totalAmount)} />
        <Field label="Payment Type" value={data.paymentType === 'full' ? 'Full Payment' : 'Installment Plan'} />
        {data.quotationValidityDays ? (
          <Field label="Quotation Validity" value={`${data.quotationValidityDays} days from contract date`} />
        ) : null}

        {/* Itemised pricing table */}
        {data.quotationLineItems && data.quotationLineItems.length > 0 ? (
          <View style={{ marginTop: 6, marginBottom: 4 }}>
            <Text style={{ fontSize: 9, fontFamily: 'Helvetica-Bold', color: '#333', marginBottom: 4 }}>
              Itemized Pricing:
            </Text>

            {/* header row */}
            <View style={s.tHead}>
              <Text style={[s.th, { width: '40%' }]}>Item</Text>
              <Text style={[s.th, { width: '10%', textAlign: 'center' }]}>Qty</Text>
              <Text style={[s.th, { width: '17%', textAlign: 'right' }]}>Materials</Text>
              <Text style={[s.th, { width: '17%', textAlign: 'right' }]}>Labor</Text>
              <Text style={[s.th, { width: '16%', textAlign: 'right' }]}>Amount</Text>
            </View>

            {/* data rows */}
            {data.quotationLineItems.map((item, i) => (
              <View key={i} style={s.tRow}>
                <Text style={[s.td, { width: '40%' }]}>{item.label}</Text>
                <Text style={[s.td, { width: '10%', textAlign: 'center' }]}>{item.quantity}</Text>
                <Text style={[s.td, { width: '17%', textAlign: 'right' }]}>
                  {pdfCurrency(item.materials * item.quantity)}
                </Text>
                <Text style={[s.td, { width: '17%', textAlign: 'right' }]}>
                  {pdfCurrency(item.labor * item.quantity)}
                </Text>
                <Text style={[s.td, { width: '16%', textAlign: 'right' }]}>
                  {pdfCurrency(item.amount)}
                </Text>
              </View>
            ))}

            {/* fees row */}
            {data.quotationFees && data.quotationFees > 0 ? (
              <View style={[s.tRow, { borderTopWidth: 0.3, borderTopColor: '#ccc', paddingTop: 2 }]}>
                <Text style={[s.td, { width: '84%' }]}>{data.quotationFeesLabel || 'Other Fees'}</Text>
                <Text style={[s.td, { width: '16%', textAlign: 'right' }]}>
                  {pdfCurrency(data.quotationFees)}
                </Text>
              </View>
            ) : null}

            {/* total */}
            <View style={[s.tRow, { borderTopWidth: 0.8, borderTopColor: '#333', paddingTop: 3, marginTop: 2 }]}>
              <Text style={[s.th, { width: '84%', fontSize: 9, color: '#1a1a1a' }]}>TOTAL</Text>
              <Text style={[s.th, { width: '16%', textAlign: 'right', fontSize: 9, color: '#1a1a1a' }]}>
                {pdfCurrency(data.totalAmount)}
              </Text>
            </View>
          </View>
        ) : null}

        {/* scope of work */}
        {data.scopeOfWork ? (
          <View style={{ marginBottom: 4 }}>
            <Text style={{ fontSize: 9, fontFamily: 'Helvetica-Bold', color: '#555', marginBottom: 2 }}>
              Scope of Work:
            </Text>
            <P>{data.scopeOfWork}</P>
          </View>
        ) : null}

        <P>
          The above amount covers all materials, labor, and fabrication costs as outlined in the approved blueprint and quotation. The Client agrees to make payments according to the following schedule:
        </P>

        {data.stages.map((stage, i) => (
          <Text key={i} style={{ fontSize: 8, color: '#333', marginBottom: 2, paddingLeft: 10 }}>
            {'- '}
            {stage.label} -- {stage.percentage}% -- {pdfCurrency(stage.amount)}
            {stage.description ? ` -- ${stage.description}` : ''}
          </Text>
        ))}

        <Spacer />
        <Bullet>All payments shall be made via the methods provided in the system (GCash, Bank Transfer, QRPH, or Cash).</Bullet>
        <Bullet>The project timeline begins upon receipt of the first payment.</Bullet>
        <Bullet>Failure to make payments on schedule may result in work suspension.</Bullet>
        <Divider />

        {/* ── 5  Material & Color ── */}
        <SectionTitle>5. MATERIAL &amp; COLOR SELECTION</SectionTitle>
        <P>
          The following material and finish selections have been agreed upon by both parties. Any changes to material or color after approval may incur additional costs and timeline adjustments.
        </P>
        {data.materialType ? <Field label="Primary Material" value={data.materialType} /> : null}
        {data.finishColor ? <Field label="Finish / Color" value={data.finishColor} /> : null}
        {!data.materialType && !data.finishColor ? (
          <P>Material and color to be specified upon blueprint approval.</P>
        ) : null}
        <Divider />

        {/* ── 6  Timeline ── */}
        <SectionTitle>6. TIMELINE &amp; SCHEDULE</SectionTitle>
        {data.estimatedDuration ? (
          <Field label="Estimated Duration" value={data.estimatedDuration} />
        ) : null}
        <P>
          The estimated timeline begins upon receipt of the initial payment and is subject to change based on material availability, design complexity, and site conditions. The Service Provider will notify the Client of any significant delays.
        </P>
        <Divider />

        {/* ── 7  Change Orders ── */}
        <SectionTitle>7. CHANGE ORDERS</SectionTitle>
        <P>
          Any modifications to the scope of work, materials, or design after blueprint approval shall be documented as a Change Order. Change orders may result in additional charges and timeline adjustments, which must be agreed upon by both parties before implementation.
        </P>
        <Divider />

        {/* ── 8  Permits ── */}
        <SectionTitle>8. PERMITS &amp; APPROVALS</SectionTitle>
        <P>
          The Client shall be responsible for obtaining all necessary permits, clearances, and approvals required for the installation of the fabricated items, unless otherwise agreed in writing. The Service Provider shall cooperate in providing documentation that may be required for such permits.
        </P>
        <Divider />

        {/* ── 9  Warranties ── */}
        <SectionTitle>9. WARRANTIES</SectionTitle>
        <P>
          The Service Provider warrants all fabricated items against manufacturing defects for a period of one (1) year from the date of completion and delivery, under normal use conditions. This warranty does not cover:
        </P>
        <Bullet>Damage caused by misuse, abuse, or negligence</Bullet>
        <Bullet>Normal wear and tear</Bullet>
        <Bullet>Modifications made by third parties</Bullet>
        <Bullet>Environmental damage (e.g., excessive moisture, chemical exposure)</Bullet>
        <Divider />

        {/* ── 10  Limitation of Liability ── */}
        <SectionTitle>10. LIMITATION OF LIABILITY</SectionTitle>
        <P>
          The Service Provider shall not be held liable for any indirect, incidental, or consequential damages arising from the use of the fabricated items. The total liability shall not exceed the total contract amount. The Client is responsible for ensuring that the installation site meets all necessary safety and structural requirements.
        </P>
        <Divider />

        {/* ── 11  Cancellation ── */}
        <SectionTitle>11. CANCELLATION &amp; TERMINATION</SectionTitle>
        <Bullet>Strictly No Refunds: Once the initial payment is made and fabrication has been scheduled or started, no refunds shall be issued under any circumstances.</Bullet>
        <Bullet>Rescheduling: Clients may request to reschedule installation dates subject to the Service Provider's availability and rescheduling policy.</Bullet>
        <Bullet>The Service Provider reserves the right to terminate the project if the Client fails to meet payment obligations, subject to written notice.</Bullet>
        <Divider />

        {/* ── 12  Force Majeure ── */}
        <SectionTitle>12. FORCE MAJEURE</SectionTitle>
        <P>
          Neither party shall be liable for delays or failure to perform obligations due to events beyond their reasonable control, including but not limited to: natural disasters, war, pandemic, government restrictions, labor disputes, or supply chain disruptions. The affected party shall notify the other party within a reasonable timeframe.
        </P>
        <Divider />

        {/* ── 13  Dispute Resolution ── */}
        <SectionTitle>13. DISPUTE RESOLUTION</SectionTitle>
        <P>
          Any disputes arising from this contract shall first be resolved through good-faith negotiation between the parties. If a resolution cannot be reached, the dispute shall be submitted to mediation or arbitration in accordance with the laws of the Republic of the Philippines. The venue for any legal proceedings shall be the courts of Metro Manila.
        </P>
        <Divider />

        {/* ── 14  Entire Agreement ── */}
        <SectionTitle>14. ENTIRE AGREEMENT</SectionTitle>
        <P>
          This contract, together with the approved blueprint and quotation, constitutes the entire agreement between the parties. No verbal or written modifications shall be binding unless signed by both parties. This contract supersedes all prior negotiations, representations, or agreements relating to this subject matter.
        </P>
        <Divider />

        {/* ── 15  Signatures ── */}
        <SectionTitle>15. SIGNATURES</SectionTitle>
        <P>
          By signing below, both parties acknowledge that they have read, understood, and agree to all terms and conditions stated in this Service Contract.
        </P>

        <View style={s.sigSection}>
          {/* Client */}
          <View style={s.sigBlock}>
            <Text style={s.sigParty}>Client:</Text>
            {signatureDataUri ? (
              <Image
                src={signatureDataUri}
                style={s.sigImage}
              />
            ) : null}
            <View style={[s.sigLine, { marginTop: signatureDataUri ? 8 : 30 }]} />
            <Text style={s.sigName}>{data.customerName}</Text>
            <Text style={s.sigRole}>
              Date:{' '}
              {data.contractSignedAt
                ? new Date(data.contractSignedAt).toLocaleDateString('en-PH', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                    timeZone: 'Asia/Manila',
                  })
                : '____________________'}
            </Text>
          </View>

          {/* Company */}
          <View style={s.sigBlock}>
            <Text style={s.sigParty}>Service Provider:</Text>
            {engineerSignatureDataUri ? (
              <Image
                src={engineerSignatureDataUri}
                style={s.sigImage}
              />
            ) : null}
            <View style={[s.sigLine, { marginTop: engineerSignatureDataUri ? 8 : 30 }]} />
            <Text style={s.sigName}>{data.engineerNames[0] || 'Authorized Representative'}</Text>
            <Text style={s.sigRole}>RMV Stainless Steel Fabrication</Text>
            <Text style={s.sigRole}>
              Date:{' '}
              {data.contractSignedAt
                ? new Date(data.contractSignedAt).toLocaleDateString('en-PH', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                    timeZone: 'Asia/Manila',
                  })
                : '____________________'}
            </Text>
          </View>
        </View>

        {/* ── Footer (fixed on every page) ── */}
        <View style={s.footer} fixed>
          <Text>
            This is a system-generated contract document. {watermark} copy. Generated on {fmtDateTime}
          </Text>
        </View>
      </Page>
    </Document>
  );
};

export default ContractDocument;
