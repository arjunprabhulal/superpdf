// Makes examples/quarterly-report.pdf: a heading, a paragraph, a ruled table and a bar chart drawn as vector shapes,
// like a typical exported report. Used for the README image and as a file to try the CLI on.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { writeFile } from 'node:fs/promises';

const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
const page = pdf.addPage([612, 792]);
const ink = rgb(0.08, 0.1, 0.13), indigo = rgb(0.263, 0.22, 0.792), grey = rgb(0.55, 0.57, 0.6);
page.drawText('Quarterly report', { x: 72, y: 712, size: 24, font: bold, color: ink });
page.drawText('Revenue grew in every region this quarter. North led with the largest increase.', { x: 72, y: 682, size: 11, font, color: ink });
page.drawText('Revenue by region', { x: 72, y: 640, size: 14, font: bold, color: ink });
const rows = [['Region', 'Q1', 'Q2', 'Change'], ['North', '120', '150', '+25%'], ['South', '90', '99', '+10%'], ['West', '75', '81', '+8%']];
const cols = [72, 222, 312, 402, 522], top = 626, h = 22;
rows.forEach((row, r) => row.forEach((cell, c) => page.drawText(cell, { x: cols[c] + 6, y: top - (r + 1) * h + 7, size: 11, font: r ? font : bold, color: ink })));
for (let r = 0; r <= rows.length; r++) page.drawLine({ start: { x: cols[0], y: top - r * h }, end: { x: cols.at(-1), y: top - r * h }, thickness: 0.8, color: grey });
for (const x of cols) page.drawLine({ start: { x, y: top }, end: { x, y: top - rows.length * h }, thickness: 0.8, color: grey });
page.drawText('Q2 revenue (thousands)', { x: 72, y: 500, size: 14, font: bold, color: ink });
const base = 300, scale = 1.2, values = [['North', 150], ['South', 99], ['West', 81]];
page.drawLine({ start: { x: 110, y: base }, end: { x: 110, y: base + 190 }, thickness: 0.8, color: grey });
page.drawLine({ start: { x: 110, y: base }, end: { x: 420, y: base }, thickness: 0.8, color: grey });
for (const v of [0, 50, 100, 150]) page.drawText(String(v), { x: 84, y: base + v * scale - 3, size: 9, font, color: grey });
values.forEach(([label, v], i) => {
  const x = 140 + i * 95;
  page.drawRectangle({ x, y: base, width: 50, height: v * scale, color: indigo });
  page.drawText(label, { x: x + 8, y: base - 16, size: 10, font, color: ink });
});
await writeFile(new URL('./quarterly-report.pdf', import.meta.url), await pdf.save());
