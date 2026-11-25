// Builds the certificate PDF when it is downloaded (nothing to store in S3).
// The PDF carries the public verification link WITH the code (verify.html?code=...),
// printed, clickable, and as a QR code, so anyone holding it can check it in one step.

import { PDFDocument, PDFName, PDFString, StandardFonts, rgb } from 'pdf-lib';
import QRCode from 'qrcode';

const W = 842; // A4 landscape
const H = 595;

export function verifyUrl(code) {
  const origin = (process.env.FRONTEND_ORIGIN || '').split(',')[0].trim();
  return `${origin}/certificate/verify.html?code=${encodeURIComponent(code)}`;
}

// Makes a rectangle on the page open `url` when clicked (PDF link annotation).
function addLink(doc, page, url, x, y, width, height) {
  const link = doc.context.register(doc.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [x, y, x + width, y + height],
    Border: [0, 0, 0],
    A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) },
  }));
  const existing = page.node.lookup(PDFName.of('Annots'));
  if (existing) existing.push(link);
  else page.node.set(PDFName.of('Annots'), doc.context.obj([link]));
}

export async function makePdf(cert) {
  const doc = await PDFDocument.create();
  doc.setTitle(`Certificate - ${cert.workshop_title}`);
  const page = doc.addPage([W, H]);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const normal = await doc.embedFont(StandardFonts.TimesRoman);
  const blue = rgb(0.13, 0.37, 0.6);
  const grey = rgb(0.35, 0.35, 0.35);

  const center = (text, size, y, font = normal, color = rgb(0.1, 0.1, 0.1)) => {
    const width = font.widthOfTextAtSize(text, size);
    page.drawText(text, { x: (W - width) / 2, y, size, font, color });
    return { x: (W - width) / 2, width };
  };

  page.drawRectangle({ x: 25, y: 25, width: W - 50, height: H - 50, borderColor: blue, borderWidth: 2 });
  center('Certificate of Completion', 38, 440, bold);
  center('This certifies that', 16, 385);
  center(cert.attendee_name, 30, 335, bold);
  center('attended every session of', 16, 290);
  center(cert.workshop_title.slice(0, 60), 22, 250, bold, blue);
  center(`Issued ${new Date(cert.issued_at).toDateString()}`, 12, 140);
  center(`Verification code: ${cert.verification_code}`, 12, 115);

  // Clickable verification link (includes the code)
  const url = verifyUrl(cert.verification_code);
  const linkSize = 9;
  const { x: linkX, width: linkW } = center(url, linkSize, 95, normal, blue);
  page.drawLine({ start: { x: linkX, y: 93 }, end: { x: linkX + linkW, y: 93 }, thickness: 0.5, color: blue });
  addLink(doc, page, url, linkX, 90, linkW, linkSize + 4);

  // QR code with the same link, bottom-right inside the border
  const qrPng = await QRCode.toBuffer(url, { errorCorrectionLevel: 'M', margin: 1, width: 300 });
  const qr = await doc.embedPng(qrPng);
  const qrSize = 92;
  const qrX = W - 45 - qrSize;
  const qrY = 52;
  page.drawImage(qr, { x: qrX, y: qrY, width: qrSize, height: qrSize });
  addLink(doc, page, url, qrX, qrY, qrSize, qrSize);
  const label = 'Scan to verify';
  page.drawText(label, { x: qrX + (qrSize - normal.widthOfTextAtSize(label, 9)) / 2, y: qrY - 12, size: 9, font: normal, color: grey });

  return doc.save();
}
