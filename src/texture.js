const MAX_TEXTURE_SIDE = 2048;

/**
 * Returns a copy of the photo where paper showing through crayon strokes
 * (inside the cut-out) is repainted with the nearby crayon color, so the 3D
 * model doesn't look striped with white. Large enclosed paper areas the user
 * chose to keep (e.g. an uncolored face) are left as drawn.
 *
 * @param {HTMLImageElement} image
 * @param {object} seg - result of segmentDrawing()
 * @returns {HTMLCanvasElement}
 */
export function buildCleanTexture(image, seg) {
  const { width: W, height: H, mask, ink, strokes, holeLabels, holes, unit } = seg;

  // Coarse "may repaint here" map; the actual paper-vs-crayon decision is made
  // per full-resolution pixel below (at this resolution gaps blur into ink).
  const repaint = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue;
    const id = holeLabels[i];
    if (strokes[i] || (id >= 0 && holes[id].area <= seg.smallHole)) repaint[i] = 1;
  }

  const small = document.createElement("canvas");
  small.width = W;
  small.height = H;
  const sctx = small.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(image, 0, 0, W, H);
  const sp = sctx.getImageData(0, 0, W, H).data;

  const inkColor = averageInkColor(sp, ink, W, H, [unit * 3, unit * 10]);

  const srcW = image.naturalWidth || image.width;
  const srcH = image.naturalHeight || image.height;
  const s = Math.min(1, MAX_TEXTURE_SIDE / Math.max(srcW, srcH));
  const FW = Math.round(srcW * s), FH = Math.round(srcH * s);
  const out = document.createElement("canvas");
  out.width = FW;
  out.height = FH;
  const octx = out.getContext("2d", { willReadFrequently: true });
  octx.drawImage(image, 0, 0, FW, FH);
  const full = octx.getImageData(0, 0, FW, FH);
  const d = full.data;

  const grayMin = seg.paperGray - Math.max(25, 0.15 * seg.paperGray);
  const satMax = seg.paperSat + 25;
  for (let y = 0; y < FH; y++) {
    const wy = Math.min(H - 1, Math.floor((y * H) / FH));
    for (let x = 0; x < FW; x++) {
      const wi = wy * W + Math.min(W - 1, Math.floor((x * W) / FW));
      if (!repaint[wi] || inkColor[wi * 4 + 3] === 0) continue;
      const k = (y * FW + x) * 4;
      const r = d[k], g = d[k + 1], b = d[k + 2];
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      // Only the paper-colored pixels; fine crayon texture stays untouched.
      if (gray > grayMin && sat < satMax) {
        d[k] = inkColor[wi * 4];
        d[k + 1] = inkColor[wi * 4 + 1];
        d[k + 2] = inkColor[wi * 4 + 2];
      }
    }
  }
  octx.putImageData(full, 0, 0);
  return out;
}

/**
 * Per pixel: mean color of ink pixels within the first radius that has any.
 * Alpha 255 = found, 0 = no ink nearby.
 */
function averageInkColor(px, ink, W, H, radii) {
  const S = W + 1;
  const I = [0, 1, 2, 3].map(() => new Float64Array(S * (H + 1)));
  for (let y = 0; y < H; y++) {
    const row = [0, 0, 0, 0];
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (ink[i]) { row[0] += px[i * 4]; row[1] += px[i * 4 + 1]; row[2] += px[i * 4 + 2]; row[3] += 1; }
      for (let c = 0; c < 4; c++) I[c][(y + 1) * S + x + 1] = I[c][y * S + x + 1] + row[c];
    }
  }
  const box = (c, x0, y0, x1, y1) =>
    I[c][(y1 + 1) * S + x1 + 1] - I[c][y0 * S + x1 + 1] - I[c][(y1 + 1) * S + x0] + I[c][y0 * S + x0];

  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (const r of radii) {
        const x0 = Math.max(0, x - r), x1 = Math.min(W - 1, x + r);
        const y0 = Math.max(0, y - r), y1 = Math.min(H - 1, y + r);
        const n = box(3, x0, y0, x1, y1);
        if (n > 0) {
          const k = (y * W + x) * 4;
          out[k] = box(0, x0, y0, x1, y1) / n;
          out[k + 1] = box(1, x0, y0, x1, y1) / n;
          out[k + 2] = box(2, x0, y0, x1, y1) / n;
          out[k + 3] = 255;
          break;
        }
      }
    }
  }
  return out;
}
