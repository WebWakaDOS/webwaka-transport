/**
 * Core PDF Generation Utility — Digital Passenger Manifest
 *
 * T-TRN-02: FRSC-compliant passenger manifest generation
 *
 * Design principles:
 *   - Pure function: no I/O, no side effects, no file system access
 *   - Works in Cloudflare Workers (V8 runtime), Node.js, and browsers
 *   - Modular: reuse for invoice generation (Phase 4+) by adapting ManifestPdfInput
 *   - NDPR compliance: sensitive PII is masked on the printed copy
 *
 * PII masking rules:
 *   - NIN / BVN / passport number: never stored raw; passenger_id_hash (SHA-256)
 *     is truncated to 8 hex chars for "ID Ref" column — proves capture without exposing raw NIN
 *   - Next-of-kin phone: middle digits masked (080****4321)
 */

import { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from 'pdf-lib';

// ── Input shape ───────────────────────────────────────────────────────────────

export interface ManifestPassenger {
  serial: number;
  seat_numbers: string;
  passenger_names: string[];
  next_of_kin_name?: string | null;
  next_of_kin_phone?: string | null;
  id_type?: string | null;
  id_hash?: string | null;
  boarded_at?: number | null;
  source: 'booking' | 'agent';
}

export interface ManifestPdfInput {
  operator_name: string;
  trip: {
    id: string;
    origin: string;
    destination: string;
    departure_time: number;
    state: string;
    plate_number?: string | null;
  };
  driver: {
    name: string;
    phone: string;
    license_number?: string | null;
  } | null;
  passengers: ManifestPassenger[];
  total_seats: number;
  generated_at: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString('en-NG', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

/** NDPR: mask middle digits of a phone number  e.g. 08012345678 → 080****5678 */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return '****';
  return digits.slice(0, 3) + '****' + digits.slice(-4);
}

/** Return first 8 hex chars of hash + '…' to prove ID was captured without exposing it */
export function maskIdHash(hash: string | null | undefined): string {
  if (!hash || hash.length < 4) return '—';
  return hash.slice(0, 8).toUpperCase() + '…';
}

function truncate(str: string, max: number): string {
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

// ── Table column definitions ──────────────────────────────────────────────────

interface ColDef { label: string; width: number }

const COLS: ColDef[] = [
  { label: '#',            width: 22  },
  { label: 'Seat',         width: 38  },
  { label: 'Passenger',    width: 133 },
  { label: 'Next of Kin',  width: 108 },
  { label: 'ID Ref',       width: 90  },
  { label: 'Boarded',      width: 64  },
  { label: 'Via',          width: 60  },
];
const TABLE_WIDTH = COLS.reduce((s, c) => s + c.width, 0); // 515

// ── Layout constants ──────────────────────────────────────────────────────────

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN_X = 40;
const MARGIN_TOP = 40;
const MARGIN_BOT = 40;
const CONTENT_TOP = PAGE_H - MARGIN_TOP;
const CONTENT_BOT = MARGIN_BOT;
const ROW_H = 20;
const HEADER_H = 22;

// ── Row drawing helpers ───────────────────────────────────────────────────────

interface DrawCtx {
  page: PDFPage;
  bold: PDFFont;
  regular: PDFFont;
}

function drawTableHeaderRow(ctx: DrawCtx, y: number): void {
  const { page, bold } = ctx;
  let x = MARGIN_X;
  page.drawRectangle({
    x, y: y - HEADER_H, width: TABLE_WIDTH, height: HEADER_H,
    color: rgb(0.11, 0.37, 0.97),
  });
  for (const col of COLS) {
    page.drawText(col.label, {
      x: x + 4, y: y - HEADER_H + 6,
      size: 8, font: bold, color: rgb(1, 1, 1),
    });
    x += col.width;
  }
}

function drawTableRow(ctx: DrawCtx, y: number, passenger: ManifestPassenger, rowIndex: number): void {
  const { page, regular, bold } = ctx;
  const bg = rowIndex % 2 === 0 ? rgb(0.97, 0.97, 1) : rgb(1, 1, 1);
  let x = MARGIN_X;

  page.drawRectangle({ x, y: y - ROW_H, width: TABLE_WIDTH, height: ROW_H, color: bg });

  const names = passenger.passenger_names.join(' / ');
  const nokName = passenger.next_of_kin_name ? truncate(passenger.next_of_kin_name, 18) : '—';
  const nokPhone = passenger.next_of_kin_phone ? maskPhone(passenger.next_of_kin_phone) : '';
  const nokCell = nokPhone ? `${nokName}\n${nokPhone}` : nokName;
  const idRef = passenger.id_type
    ? `${passenger.id_type}: ${maskIdHash(passenger.id_hash)}`
    : '—';
  const boarded = passenger.boarded_at
    ? new Date(passenger.boarded_at).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })
    : '—';
  const via = passenger.source === 'agent' ? 'Agent' : 'Online';

  const cells: string[] = [
    String(passenger.serial),
    truncate(passenger.seat_numbers, 5),
    truncate(names, 22),
    truncate(nokCell.split('\n')[0]!, 18),
    truncate(idRef, 16),
    boarded,
    via,
  ];

  for (let i = 0; i < COLS.length; i++) {
    const col = COLS[i]!;
    const cell = cells[i] ?? '';
    page.drawText(cell, {
      x: x + 4, y: y - ROW_H + 6,
      size: 8, font: i === 0 ? bold : regular,
      color: rgb(0.1, 0.1, 0.1),
      maxWidth: col.width - 6,
    });
    // NOK phone on second micro-line if present
    if (i === 3 && passenger.next_of_kin_phone) {
      page.drawText(maskPhone(passenger.next_of_kin_phone), {
        x: x + 4, y: y - ROW_H + 1,
        size: 6, font: regular, color: rgb(0.45, 0.45, 0.45),
        maxWidth: col.width - 6,
      });
    }
    x += col.width;
  }

  // Light bottom border
  page.drawLine({
    start: { x: MARGIN_X, y: y - ROW_H },
    end:   { x: MARGIN_X + TABLE_WIDTH, y: y - ROW_H },
    thickness: 0.3,
    color: rgb(0.85, 0.85, 0.85),
  });
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Generates a FRSC-compliant passenger manifest PDF.
 *
 * @param data - Structured manifest data from the API manifest endpoint
 * @returns Uint8Array of the PDF binary (ready for `Content-Type: application/pdf`)
 *
 * Usage (Cloudflare Worker):
 *   const pdfBytes = await generateManifestPdf(data);
 *   return new Response(pdfBytes, { headers: { 'Content-Type': 'application/pdf' } });
 *
 * Future reuse (invoice generation):
 *   Define InvoicePdfInput, copy layout helpers, replace table columns.
 */
export async function generateManifestPdf(data: ManifestPdfInput): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);

  function newPage(): { page: PDFPage; ctx: DrawCtx } {
    const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    return { page, ctx: { page, bold: boldFont, regular: regularFont } };
  }

  // ── Page 1 setup ──────────────────────────────────────────────────────────
  let { page, ctx } = newPage();
  let curY = CONTENT_TOP;

  // ── Header ────────────────────────────────────────────────────────────────
  page.drawText('DIGITAL PASSENGER MANIFEST', {
    x: MARGIN_X, y: curY - 18,
    size: 16, font: boldFont, color: rgb(0.11, 0.37, 0.97),
  });
  page.drawText('Federal Road Safety Corps (FRSC) Compliance Document', {
    x: MARGIN_X, y: curY - 32,
    size: 8, font: regularFont, color: rgb(0.45, 0.45, 0.45),
  });
  page.drawText(data.operator_name.toUpperCase(), {
    x: MARGIN_X + TABLE_WIDTH - boldFont.widthOfTextAtSize(data.operator_name.toUpperCase(), 9), y: curY - 18,
    size: 9, font: boldFont, color: rgb(0.2, 0.2, 0.2),
  });
  curY -= 46;

  // Divider
  page.drawLine({
    start: { x: MARGIN_X, y: curY }, end: { x: MARGIN_X + TABLE_WIDTH, y: curY },
    thickness: 1.2, color: rgb(0.11, 0.37, 0.97),
  });
  curY -= 12;

  // ── Trip info grid ────────────────────────────────────────────────────────
  const infoRows: [string, string][] = [
    ['Route',        `${data.trip.origin} → ${data.trip.destination}`],
    ['Departure',    formatDate(data.trip.departure_time)],
    ['Trip ID',      data.trip.id],
    ['Vehicle',      data.trip.plate_number ?? 'N/A'],
    ['Driver',       data.driver ? `${data.driver.name} | Lic: ${data.driver.license_number ?? 'N/A'}` : 'Not assigned'],
    ['Trip Status',  data.trip.state.toUpperCase()],
  ];
  const halfW = TABLE_WIDTH / 2;
  for (let i = 0; i < infoRows.length; i += 2) {
    const left  = infoRows[i]!;
    const right = infoRows[i + 1];
    const yPos = curY - 14;
    page.drawText(`${left[0]}:`, { x: MARGIN_X, y: yPos, size: 8, font: boldFont, color: rgb(0.3, 0.3, 0.3) });
    page.drawText(left[1],      { x: MARGIN_X + 58, y: yPos, size: 8, font: regularFont, color: rgb(0.1, 0.1, 0.1), maxWidth: halfW - 64 });
    if (right) {
      page.drawText(`${right[0]}:`, { x: MARGIN_X + halfW, y: yPos, size: 8, font: boldFont, color: rgb(0.3, 0.3, 0.3) });
      page.drawText(right[1],      { x: MARGIN_X + halfW + 58, y: yPos, size: 8, font: regularFont, color: rgb(0.1, 0.1, 0.1), maxWidth: halfW - 64 });
    }
    curY -= 16;
  }
  curY -= 6;

  // ── Summary bar ───────────────────────────────────────────────────────────
  const totalBoarded = data.passengers.filter(p => p.boarded_at).length;
  const summaryText =
    `Total Passengers: ${data.passengers.length}   |   ` +
    `Boarded: ${totalBoarded}   |   ` +
    `Remaining Seats: ${Math.max(0, data.total_seats - data.passengers.length)}   |   ` +
    `Total Seats: ${data.total_seats}`;
  page.drawRectangle({
    x: MARGIN_X, y: curY - 16, width: TABLE_WIDTH, height: 16,
    color: rgb(0.95, 0.97, 1),
  });
  page.drawText(summaryText, {
    x: MARGIN_X + 6, y: curY - 11,
    size: 7.5, font: boldFont, color: rgb(0.15, 0.2, 0.5),
    maxWidth: TABLE_WIDTH - 12,
  });
  curY -= 24;

  // ── Passenger table ───────────────────────────────────────────────────────
  drawTableHeaderRow(ctx, curY);
  curY -= HEADER_H;

  for (let i = 0; i < data.passengers.length; i++) {
    // Page break check
    if (curY - ROW_H < CONTENT_BOT + 80) {
      // Footer on current page
      drawPageFooter(ctx, data.generated_at);
      // New page
      ({ page, ctx } = newPage());
      curY = CONTENT_TOP;
      // Repeat table header
      drawTableHeaderRow(ctx, curY);
      curY -= HEADER_H;
    }
    drawTableRow(ctx, curY, data.passengers[i]!, i);
    curY -= ROW_H;
  }

  curY -= 16;

  // ── Driver signature block ─────────────────────────────────────────────────
  if (curY - 80 < CONTENT_BOT) {
    drawPageFooter(ctx, data.generated_at);
    ({ page, ctx } = newPage());
    curY = CONTENT_TOP;
  }

  page.drawRectangle({
    x: MARGIN_X, y: curY - 80, width: TABLE_WIDTH, height: 80,
    borderColor: rgb(0.7, 0.7, 0.7), borderWidth: 0.8, color: rgb(1, 1, 1),
  });
  page.drawText('DRIVER DECLARATION', {
    x: MARGIN_X + 8, y: curY - 14,
    size: 9, font: boldFont, color: rgb(0.1, 0.1, 0.1),
  });
  page.drawText(
    'I confirm that the passenger list above is complete and accurate as at time of departure.',
    { x: MARGIN_X + 8, y: curY - 28, size: 7.5, font: regularFont, color: rgb(0.3, 0.3, 0.3), maxWidth: TABLE_WIDTH - 16 }
  );

  const sigY = curY - 52;
  const sigParts: [string, number][] = [
    ['Driver Name: ' + (data.driver?.name ?? '________________________'), 0],
    ['Signature: ________________________', 190],
    ['Date: ________________________', 390],
  ];
  for (const [text, offsetX] of sigParts) {
    page.drawText(text, {
      x: MARGIN_X + 8 + offsetX, y: sigY,
      size: 8, font: regularFont, color: rgb(0.2, 0.2, 0.2), maxWidth: 180,
    });
  }

  curY -= 96;

  // ── Page footer ──────────────────────────────────────────────────────────
  drawPageFooter(ctx, data.generated_at);

  return pdfDoc.save();
}

function drawPageFooter(ctx: DrawCtx, generatedAt: number): void {
  const { page, regular, bold } = ctx;
  const y = CONTENT_BOT - 4;
  page.drawLine({
    start: { x: MARGIN_X, y: y + 12 }, end: { x: MARGIN_X + TABLE_WIDTH, y: y + 12 },
    thickness: 0.4, color: rgb(0.8, 0.8, 0.8),
  });
  page.drawText(`Generated: ${formatDate(generatedAt)}`, {
    x: MARGIN_X, y, size: 7, font: regular, color: rgb(0.55, 0.55, 0.55),
  });
  page.drawText('WebWaka Transport Suite', {
    x: MARGIN_X + TABLE_WIDTH - bold.widthOfTextAtSize('WebWaka Transport Suite', 7), y,
    size: 7, font: bold, color: rgb(0.11, 0.37, 0.97),
  });
  page.drawText(
    'NDPR Notice: ID references are cryptographic hashes. Full NINs are never stored or displayed.',
    { x: MARGIN_X, y: y - 10, size: 6.5, font: regular, color: rgb(0.6, 0.6, 0.6), maxWidth: TABLE_WIDTH }
  );
}
