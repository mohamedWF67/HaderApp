// Builds the certificate PDF when it is downloaded (nothing to store in S3).

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export async function makePdf(cert) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([842, 595]); // A4 landscape
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const normal = await doc.embedFont(StandardFonts.TimesRoman);
  const blue = rgb(0.13, 0.37, 0.6);

  const center = (text, size, y, font = normal, color = rgb(0.1, 0.1, 0.1)) => {
    const width = font.widthOfTextAtSize(text, size);
    page.drawText(text, { x: (842 - width) / 2, y, size, font, color });
  };

  page.drawRectangle({ x: 25, y: 25, width: 792, height: 545, borderColor: blue, borderWidth: 2 });
  center('Certificate of Completion', 38, 440, bold);
  center('This certifies that', 16, 385);
  center(cert.attendee_name, 30, 335, bold);
  center('attended every session of', 16, 290);
  center(cert.workshop_title.slice(0, 60), 22, 250, bold, blue);
  center(`Issued ${new Date(cert.issued_at).toDateString()}`, 12, 140);
  center(`Verification code: ${cert.verification_code}`, 12, 115);
  center(`Verify at ${(process.env.FRONTEND_ORIGIN || '').split(',')[0].trim()}/certificate/verify.html`, 10, 95);

  return doc.save();
}
