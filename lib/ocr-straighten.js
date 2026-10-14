// A tilted scan (fed in crooked, or photographed at an angle) is read by superPDF OCR straightened: Tesseract's
// rotateAuto measures the tilt from the lines of text and turns the picture level before reading it. This puts the
// words read back where they are printed. DOM-free; shared by the app (ocr.js) and the CLI, MCP server and API
// (pdf-node.js).

/**
 * A scan read straightened (Tesseract's rotateAuto turns the picture about its centre by `data.rotateRadians` before
 * reading it) with each word and line baseline turned back to where it is in the `width` x `height` picture, so the
 * words land on the page where they are printed. Words keep their size. Data read untilted is returned as it is.
 */
export function straightened(data, width, height) {
  const t = data?.rotateRadians;
  if (!t) return data;
  const c = Math.cos(t), s = Math.sin(t), cx = width / 2, cy = height / 2;
  const back = (x, y) => [cx + (x - cx) * c + (y - cy) * s, cy - (x - cx) * s + (y - cy) * c];
  const box = b => {
    const [x, y] = back((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2), w = (b.x1 - b.x0) / 2, h = (b.y1 - b.y0) / 2;
    return { x0: x - w, y0: y - h, x1: x + w, y1: y + h };
  };
  const line = l => {
    let baseline = l.baseline;
    if (baseline && Number.isFinite(baseline.y0)) {
      const [x0, y0] = back(baseline.x0, baseline.y0), [x1, y1] = back(baseline.x1, baseline.y1);
      baseline = { ...baseline, x0, y0, x1, y1 };
    }
    return { ...l, baseline, ...(l.bbox && { bbox: box(l.bbox) }), words: (l.words || []).map(w => ({ ...w, bbox: box(w.bbox) })) };
  };
  return { ...data, blocks: (data.blocks || []).map(b => ({ ...b, paragraphs: (b.paragraphs || []).map(p => ({ ...p, lines: (p.lines || []).map(line) })) })) };
}
