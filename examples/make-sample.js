// Makes examples/quarterly-report.pdf: a one-page business report with a header line, a heading, a paragraph, a ruled
// table and a bar chart drawn as vector shapes, like a typical exported report. Used for the README image and as a file
// to try the CLI on: `superpdf export examples/quarterly-report.pdf --output report.md`.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { writeFile } from 'node:fs/promises';

const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
const page = pdf.addPage([612, 792]);
const ink = rgb(0.12, 0.13, 0.15), muted = rgb(0.42, 0.45, 0.5), rule = rgb(0.78, 0.8, 0.83);
const shade = rgb(0.95, 0.96, 0.97), bar = rgb(0.16, 0.39, 0.62);

page.drawText('Northwind Ltd', { x: 72, y: 748, size: 9, font: bold, color: muted });
page.drawText('Q2 2026', { x: 506, y: 748, size: 9, font, color: muted });
page.drawLine({ start: { x: 72, y: 740 }, end: { x: 540, y: 740 }, thickness: 0.6, color: rule });

page.drawText('Quarterly report', { x: 72, y: 700, size: 22, font: bold, color: ink });
page.drawText('Revenue grew in every region this quarter. North led with the largest increase.', { x: 72, y: 674, size: 10.5, font, color: ink });

page.drawText('Revenue by region', { x: 72, y: 636, size: 13, font: bold, color: ink });
const rows = [['Region', 'Q1', 'Q2', 'Change'], ['North', '120', '150', '+25%'], ['South', '90', '99', '+10%'], ['West', '75', '81', '+8%']];
const cols = [72, 222, 312, 402, 540], top = 622, h = 22;
page.drawRectangle({ x: cols[0], y: top - h, width: cols.at(-1) - cols[0], height: h, color: shade });
rows.forEach((row, r) => row.forEach((cell, c) => page.drawText(cell, { x: cols[c] + 8, y: top - (r + 1) * h + 7, size: 10, font: r ? font : bold, color: ink })));
for (let r = 0; r <= rows.length; r++) page.drawLine({ start: { x: cols[0], y: top - r * h }, end: { x: cols.at(-1), y: top - r * h }, thickness: 0.6, color: rule });
for (const x of cols) page.drawLine({ start: { x, y: top }, end: { x, y: top - rows.length * h }, thickness: 0.6, color: rule });

page.drawText('Q2 revenue by region (thousands)', { x: 72, y: 498, size: 13, font: bold, color: ink });
const base = 310, scale = 1.1, left = 110, right = 420;
for (const v of [0, 50, 100, 150]) {
  page.drawLine({ start: { x: left, y: base + v * scale }, end: { x: right, y: base + v * scale }, thickness: v ? 0.4 : 0.8, color: v ? shade : rule });
  page.drawText(String(v), { x: left - 24, y: base + v * scale - 3, size: 8.5, font, color: muted });
}
[['North', 150], ['South', 99], ['West', 81]].forEach(([label, v], i) => {
  const x = left + 30 + i * 95;
  page.drawRectangle({ x, y: base, width: 48, height: v * scale, color: bar });
  page.drawText(label, { x: x + 8, y: base - 15, size: 9, font, color: ink });
});

page.drawLine({ start: { x: 72, y: 60 }, end: { x: 540, y: 60 }, thickness: 0.6, color: rule });
page.drawText('Page 1 of 1', { x: 498, y: 46, size: 8.5, font, color: muted });
await writeFile(new URL('./quarterly-report.pdf', import.meta.url), await pdf.save());
