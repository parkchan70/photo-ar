/**
 * Cuts a drawing out of a photo of paper. Tuned for crayon/pen drawings on
 * light paper: ink is anything noticeably darker or more colorful than the
 * paper around it (adaptive threshold, so shadows across the sheet are fine).
 *
 * Paper fully enclosed by strokes ("holes") is ambiguous: a gap between an
 * arm and the body, or an outlined-but-uncolored face. Only tiny holes (gaps
 * between crayon strokes) are filled by default; the rest can be toggled by
 * the user with toggleHoleAt().
 *
 * @param {HTMLImageElement} image
 * @param {number} maxSize - working resolution (long side, px)
 * @returns {Segmentation} {mask, width, height, ...state for toggleHoleAt}
 */
export function segmentDrawing(image, maxSize = 512) {
  const srcW = image.naturalWidth || image.width;
  const srcH = image.naturalHeight || image.height;
  const scale = Math.min(1, maxSize / Math.max(srcW, srcH));
  const W = Math.max(1, Math.round(srcW * scale));
  const H = Math.max(1, Math.round(srcH * scale));

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, W, H);
  const px = ctx.getImageData(0, 0, W, H).data;

  const N = W * H;
  const gray = new Float32Array(N);
  const sat = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    sat[i] = Math.max(r, g, b) - Math.min(r, g, b);
  }

  const radius = Math.max(4, Math.round(Math.max(W, H) / 16));
  const meanGray = boxMean(gray, W, H, radius);
  const meanSat = boxMean(sat, W, H, radius);

  const unit = Math.max(1, Math.round(Math.max(W, H) / 170));
  // Only look for ink on the sheet itself; otherwise the table just outside
  // the paper edge reads as "darker than its surroundings" and wins.
  const paper = erode(paperRegion(gray, W, H), W, H, unit * 2);

  let fg = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    fg[i] = paper[i] && (gray[i] < meanGray[i] - 12 || sat[i] > meanSat[i] + 30) ? 1 : 0;
  }
  const strokes = erode(dilate(fg, W, H, unit), W, H, unit); // connect crayon strokes

  const { labels: holeLabels, regions } = labelRegions(strokes, W, H, 0);

  // Enclosed regions are either bare paper (gap between limbs, uncolored face)
  // or the inside of a big solid-colored area, which the adaptive threshold
  // misses because it matches its own surroundings. Tell them apart by color.
  const sumGray = new Float64Array(regions.length), sumSat = new Float64Array(regions.length);
  let paperGray = 0, paperSat = 0, paperCount = 0;
  for (let i = 0; i < N; i++) {
    const id = holeLabels[i];
    if (id < 0) continue;
    sumGray[id] += gray[i];
    sumSat[id] += sat[i];
    if (regions[id].touchesBorder && paper[i]) { paperGray += gray[i]; paperSat += sat[i]; paperCount++; }
  }
  if (paperCount > 0) { paperGray /= paperCount; paperSat /= paperCount; }
  else { paperGray = 220; paperSat = 20; }

  const smallHole = Math.max(40, 0.002 * N);
  const holes = regions.map((r, id) => {
    const g = sumGray[id] / r.area, s = sumSat[id] / r.area;
    const paperLike = g > paperGray - Math.max(25, 0.15 * paperGray) && s < paperSat + 25;
    return {
      area: r.area,
      // Border-touching regions are the open paper; a huge one is the sheet itself.
      toggleable: !r.touchesBorder && r.area < 0.4 * N,
      filled: !r.touchesBorder && (!paperLike || r.area <= smallHole),
    };
  });

  const seg = {
    width: W, height: H, strokes, holeLabels, holes, mask: null,
    // Used by texture cleanup to repaint paper showing between crayon strokes.
    ink: fg, unit, smallHole, paperGray, paperSat,
  };
  rebuildMask(seg);
  let area = 0;
  for (let i = 0; i < N; i++) area += seg.mask[i];
  if (area < N * 0.005) {
    throw new Error("사진에서 그림을 찾지 못했어요. 밝은 종이 위의 그림을 가까이서 찍어주세요.");
  }
  return seg;
}

/**
 * Flips an enclosed paper region at (x, y) (working-resolution pixels)
 * between kept and removed. Returns true if something changed.
 */
export function toggleHoleAt(seg, x, y) {
  const { width: W, height: H } = seg;
  const cx = Math.round(x), cy = Math.round(y);
  // Holes can be thin slivers; accept a tap that lands just beside one.
  const reach = Math.max(2, Math.round(Math.max(W, H) / 80));
  let best = -1, bestD = Infinity;
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const px = cx + dx, py = cy + dy;
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      const id = seg.holeLabels[py * W + px];
      const d = dx * dx + dy * dy;
      if (id >= 0 && seg.holes[id].toggleable && d < bestD) { best = id; bestD = d; }
    }
  }
  if (best < 0) return false;
  seg.holes[best].filled = !seg.holes[best].filled;
  rebuildMask(seg);
  return true;
}

function rebuildMask(seg) {
  const { width: W, height: H, strokes, holeLabels, holes } = seg;
  const fg = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    fg[i] = strokes[i] || (holeLabels[i] >= 0 && holes[holeLabels[i]].filled) ? 1 : 0;
  }
  seg.mask = pickMainComponent(fg, W, H);
}

/**
 * The sheet of paper as a filled convex region: convex hull of the largest
 * bright area. Hull (not hole-filling) so drawings that run off the paper
 * edge stay inside. Falls back to the whole photo when no clear sheet shows.
 */
function paperRegion(gray, W, H) {
  const N = W * H;
  const all = new Uint8Array(N).fill(1);

  const hist = new Float64Array(256);
  for (let i = 0; i < N; i++) hist[Math.min(255, gray[i] | 0)]++;
  const t = otsu(hist, N);
  const bright = new Uint8Array(N);
  for (let i = 0; i < N; i++) bright[i] = gray[i] > t ? 1 : 0;

  const { labels, regions } = labelRegions(bright, W, H, 1);
  let best = -1;
  regions.forEach((r, id) => { if (best < 0 || r.area > regions[best].area) best = id; });
  if (best < 0 || regions[best].area < 0.15 * N) return all;

  // Leftmost/rightmost pixel per row is enough to get the hull.
  const pts = [];
  for (let y = 0; y < H; y++) {
    let l = -1, r = -1;
    for (let x = 0; x < W; x++) {
      if (labels[y * W + x] === best) { if (l < 0) l = x; r = x; }
    }
    if (l >= 0) { pts.push([l, y]); if (r !== l) pts.push([r, y]); }
  }
  const hull = convexHull(pts);
  if (hull.length < 3) return all;

  const out = new Uint8Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) out[y * W + x] = insideConvex(hull, x, y) ? 1 : 0;
  }
  return out;
}

function otsu(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) { bestVar = between; best = t; }
  }
  return best;
}

// Andrew's monotone chain; returns CCW hull (in image coords, y down).
function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function insideConvex(hull, x, y) {
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    if ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) < 0) return false;
  }
  return true;
}

function integral(src, W, H) {
  const I = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += src[y * W + x];
      I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row;
    }
  }
  return I;
}

function boxSum(I, W, x0, y0, x1, y1) {
  // inclusive pixel box [x0..x1] x [y0..y1]
  const s = W + 1;
  return I[(y1 + 1) * s + x1 + 1] - I[y0 * s + x1 + 1] - I[(y1 + 1) * s + x0] + I[y0 * s + x0];
}

function boxMean(src, W, H, r) {
  const I = integral(src, W, H);
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H - 1, y + r);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W - 1, x + r);
      out[y * W + x] = boxSum(I, W, x0, y0, x1, y1) / ((x1 - x0 + 1) * (y1 - y0 + 1));
    }
  }
  return out;
}

function dilate(m, W, H, r) {
  const I = integral(m, W, H);
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H - 1, y + r);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W - 1, x + r);
      out[y * W + x] = boxSum(I, W, x0, y0, x1, y1) > 0 ? 1 : 0;
    }
  }
  return out;
}

function erode(m, W, H, r) {
  const I = integral(m, W, H);
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H - 1, y + r);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W - 1, x + r);
      const full = (x1 - x0 + 1) * (y1 - y0 + 1);
      out[y * W + x] = boxSum(I, W, x0, y0, x1, y1) === full ? 1 : 0;
    }
  }
  return out;
}

/** Labels 4-connected regions where m[i] === value. */
function labelRegions(m, W, H, value) {
  const labels = new Int32Array(W * H).fill(-1);
  const regions = [];
  const queue = new Int32Array(W * H);
  for (let start = 0; start < W * H; start++) {
    if (m[start] !== value || labels[start] !== -1) continue;
    const id = regions.length;
    let head = 0, tail = 0, area = 0, touchesBorder = false;
    queue[tail++] = start;
    labels[start] = id;
    while (head < tail) {
      const i = queue[head++];
      area++;
      const x = i % W, y = (i / W) | 0;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) touchesBorder = true;
      const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
      for (const j of nb) {
        if (j >= 0 && m[j] === value && labels[j] === -1) {
          labels[j] = id;
          queue[tail++] = j;
        }
      }
    }
    regions.push({ area, touchesBorder });
  }
  return { labels, regions };
}

function pickMainComponent(fg, W, H) {
  const { labels, regions } = labelRegions(fg, W, H, 1);
  let best = -1, bestInner = -1;
  regions.forEach((r, id) => {
    if (best < 0 || r.area > regions[best].area) best = id;
    if (!r.touchesBorder && (bestInner < 0 || r.area > regions[bestInner].area)) bestInner = id;
  });
  // Prefer a region away from the photo edges (edges tend to be table/paper
  // borders) unless it's much smaller than the biggest thing found.
  const chosen = bestInner >= 0 && regions[bestInner].area >= 0.3 * regions[best].area ? bestInner : best;
  const mask = new Uint8Array(W * H);
  if (chosen < 0) return mask;
  for (let i = 0; i < W * H; i++) mask[i] = labels[i] === chosen ? 1 : 0;
  return mask;
}
