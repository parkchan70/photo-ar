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
  const unit = Math.max(1, Math.round(Math.max(W, H) / 170));

  // Digital pictures (AI/illustration exports) have a transparent, flat or
  // fake-checkerboard background instead of paper; cut those by color.
  const digitalBg = detectDigitalBackground(px, W, H);
  if (digitalBg) {
    const seg = segmentDigital(px, W, H, unit, digitalBg);
    if (seg) return seg;
  }

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

  const seg = finishSegmentation(W, H, unit, strokes, holeLabels, holes, {
    // Used by texture cleanup to repaint paper showing between crayon strokes.
    ink: fg, smallHole, paperGray, paperSat,
  });
  if (!seg) throw new Error("사진에서 그림을 찾지 못했어요. 밝은 종이 위의 그림을 가까이서 찍어주세요.");
  return seg;
}

/**
 * Shared tail: adds the tappable "open holes", brush state and the mask.
 * Returns null if almost nothing is left.
 */
function finishSegmentation(W, H, unit, strokes, holeLabels, holes, extra) {
  const N = W * H;
  // Kids' outlines often have small breaks, so the paper inside leaks into the
  // open sheet and isn't a "hole". Closing the strokes harder bridges those
  // breaks; regions enclosed only then are offered as tappable "open holes".
  const gap = unit * 4;
  const bridged = erode(dilate(strokes, W, H, gap), W, H, gap);
  const { labels: openLabels, regions: openRegions } = labelRegions(bridged, W, H, 0);
  const openHoles = openRegions.map((r) => ({
    toggleable: !r.touchesBorder && r.area < 0.4 * N,
    filled: false,
  }));

  const seg = {
    width: W, height: H, strokes, holeLabels, holes, openLabels, openHoles, mask: null,
    // Brush edits: 1 = force keep, -1 = force remove, 0 = automatic.
    paint: new Int8Array(N),
    unit,
    ...extra,
  };
  rebuildMask(seg);
  let area = 0;
  for (let i = 0; i < N; i++) area += seg.mask[i];
  return area < N * 0.005 ? null : seg;
}

/**
 * Recognizes a digital background from the image border:
 *  - {kind: "alpha"}: mostly transparent border (a real transparent PNG)
 *  - {kind: "color", colors}: border is almost exactly one flat color, or the
 *    two colors of a fake "transparency" checkerboard baked into the pixels.
 * Photos of paper have noise and lighting falloff at the border, so they
 * don't come close to this and keep the paper path.
 */
function detectDigitalBackground(px, W, H) {
  const border = [];
  for (let x = 0; x < W; x++) for (const y of [0, 1, H - 2, H - 1]) border.push((y * W + x) * 4);
  for (let y = 2; y < H - 2; y++) for (const x of [0, 1, W - 2, W - 1]) border.push((y * W + x) * 4);

  let transparent = 0;
  for (const k of border) if (px[k + 3] < 128) transparent++;
  if (transparent > 0.6 * border.length) return { kind: "alpha" };

  // Two most common colors (coarse 16-level bins), refined to their mean.
  const bins = new Map();
  for (const k of border) {
    const key = (px[k] >> 4) * 256 + (px[k + 1] >> 4) * 16 + (px[k + 2] >> 4);
    const b = bins.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    b.n++; b.r += px[k]; b.g += px[k + 1]; b.b += px[k + 2];
    bins.set(key, b);
  }
  const colors = [...bins.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, 2)
    .filter((b) => b.n >= 0.1 * border.length)
    .map((b) => [b.r / b.n, b.g / b.n, b.b / b.n]);
  if (colors.length === 0) return null;

  const share = (cs, maxDist) => {
    let n = 0;
    for (const k of border) if (cs.some((c) => colorDist(px, k, c) <= maxDist)) n++;
    return n / border.length;
  };

  // Fake transparency: two colors that really alternate like a checkerboard
  // along the top and bottom edges (a desk or paper never does this).
  if (colors.length === 2 && share(colors, 6) >= 0.8) {
    let switches = 0;
    for (const y of [0, H - 1]) {
      let prev = 0;
      for (let x = 0; x < W; x++) {
        const k = (y * W + x) * 4;
        const d0 = colorDist(px, k, colors[0]), d1 = colorDist(px, k, colors[1]);
        const cur = Math.min(d0, d1) > 6 ? 0 : d0 < d1 ? 1 : 2;
        if (cur && prev && cur !== prev) switches++;
        if (cur) prev = cur;
      }
    }
    if (switches >= 8) return { kind: "color", colors };
  }

  // Flat background: essentially every border pixel is the same exact color.
  // Photos always drift a few levels across the frame (lighting, lens falloff).
  if (share([colors[0]], 3) >= 0.95) return { kind: "color", colors: [colors[0]] };
  return null;
}

function colorDist(px, k, c) {
  return Math.hypot(px[k] - c[0], px[k + 1] - c[1], px[k + 2] - c[2]);
}

/** Distance from a pixel's color to the line segment between two colors (checkerboard blends lie on it). */
function distToSegment(px, k, a, b) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2] || 1;
  const t = Math.min(1, Math.max(0,
    ((px[k] - a[0]) * d[0] + (px[k + 1] - a[1]) * d[1] + (px[k + 2] - a[2]) * d[2]) / len2));
  return Math.hypot(px[k] - (a[0] + t * d[0]), px[k + 1] - (a[1] + t * d[1]), px[k + 2] - (a[2] + t * d[2]));
}

/**
 * Character = everything that isn't background-colored. Background colors
 * fully surrounded by the character (white eyes, or a gap between an arm and
 * the body) become tappable holes: kept by default unless they clearly are
 * background (transparent, the checkerboard pattern, or a big flat patch).
 */
function segmentDigital(px, W, H, unit, bg) {
  const N = W * H;
  const TOL = 14; // tight enough that cream/white character colors aren't taken for a gray checker
  const isBg = new Uint8Array(N);
  const which = new Uint8Array(N); // checkerboard: which of the two colors (1 or 2)
  for (let i = 0; i < N; i++) {
    const k = i * 4;
    if (bg.kind === "alpha") {
      isBg[i] = px[k + 3] < 128 ? 1 : 0;
      continue;
    }
    const [a, b] = bg.colors;
    const d = b ? distToSegment(px, k, a, b) : colorDist(px, k, a);
    isBg[i] = d <= TOL ? 1 : 0;
    if (isBg[i] && b) which[i] = colorDist(px, k, a) <= colorDist(px, k, b) ? 1 : 2;
  }
  const strokes = new Uint8Array(N);
  for (let i = 0; i < N; i++) strokes[i] = isBg[i] ? 0 : 1;

  const { labels: holeLabels, regions } = labelRegions(strokes, W, H, 0);
  const counts = regions.map(() => [0, 0]);
  for (let i = 0; i < N; i++) {
    const id = holeLabels[i];
    if (id >= 0 && which[i]) counts[id][which[i] - 1]++;
  }
  // Rough size of the character: its drawn pixels plus everything they enclose.
  let charArea = 0;
  for (let i = 0; i < N; i++) charArea += strokes[i];
  regions.forEach((r) => { if (!r.touchesBorder) charArea += r.area; });

  const holes = regions.map((r, id) => {
    let background;
    if (bg.kind === "alpha") background = true;
    else if (bg.colors.length === 2) {
      // The fake checkerboard shows both of its colors; a white eye shows one.
      background = Math.min(counts[id][0], counts[id][1]) >= 0.15 * r.area;
    } else {
      // Same color as the background, fully enclosed: a gap between limbs is
      // mid-sized; a highlight is tiny; a white body/face is most of the character.
      background = r.area > 0.01 * N && r.area < 0.15 * charArea;
    }
    return {
      area: r.area,
      toggleable: !r.touchesBorder && r.area < 0.4 * N,
      filled: !r.touchesBorder && !background,
    };
  });

  const seg = finishSegmentation(W, H, unit, strokes, holeLabels, holes, {
    digital: bg.kind,
    ink: strokes,
    smallHole: 0,
  });
  if (!seg) return null;
  // A "character" filling most of the frame means this was really a photo
  // (e.g. a sheet of paper on a plain desk); let the paper path handle it.
  if (bg.kind !== "alpha") {
    let area = 0;
    for (let i = 0; i < N; i++) area += seg.mask[i];
    if (area > 0.6 * N) return null;
  }
  return seg;
}

const fineHoleAt = (seg, i) => {
  const id = seg.holeLabels[i];
  return id >= 0 && seg.holes[id].toggleable ? seg.holes[id] : null;
};
const openHoleAt = (seg, i) => {
  const id = seg.openLabels[i];
  return id >= 0 && seg.openHoles[id].toggleable ? seg.openHoles[id] : null;
};

/** True where tapping would bring a removed paper area back (shown pink). */
export function isTapRestorable(seg, i) {
  return !seg.mask[i] && seg.paint[i] !== -1 && !!(fineHoleAt(seg, i) || openHoleAt(seg, i));
}

/**
 * Tap at (x, y) (working-resolution pixels): a kept paper area is removed,
 * a removed one (enclosed, or nearly enclosed by a broken outline) comes
 * back. Returns true if something changed.
 */
export function toggleHoleAt(seg, x, y) {
  const { width: W, height: H } = seg;
  const cx = Math.round(x), cy = Math.round(y);
  // Holes can be thin slivers; accept a tap that lands just beside one.
  const reach = Math.max(2, Math.round(Math.max(W, H) / 80));
  let hit = -1, bestD = Infinity;
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const px = cx + dx, py = cy + dy;
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      const i = py * W + px, d = dx * dx + dy * dy;
      if (d < bestD && (fineHoleAt(seg, i) || openHoleAt(seg, i))) { hit = i; bestD = d; }
    }
  }
  if (hit < 0) return false;

  const fine = fineHoleAt(seg, hit), open = openHoleAt(seg, hit);
  if (seg.mask[hit]) {
    // Remove whatever is keeping it.
    if (fine) fine.filled = false;
    if (open) open.filled = false;
  } else if (fine) {
    fine.filled = true; // smallest region first, so only what was tapped comes back
  } else {
    open.filled = true;
  }
  // A tap overrides earlier brush strokes inside the region it changed.
  for (let i = 0; i < W * H; i++) {
    if ((fine && fineHoleAt(seg, i) === fine) || (!fine && open && openHoleAt(seg, i) === open)) seg.paint[i] = 0;
  }
  rebuildMask(seg);
  return true;
}

/**
 * Brush stroke from (x0, y0) to (x1, y1): value 1 keeps, -1 removes.
 * Coordinates and radius are in working-resolution pixels.
 */
export function paintStroke(seg, x0, y0, x1, y1, radius, value) {
  const { width: W, height: H, paint } = seg;
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (radius * 0.5)));
  const r2 = radius * radius;
  for (let s = 0; s <= steps; s++) {
    const cx = x0 + ((x1 - x0) * s) / steps, cy = y0 + ((y1 - y0) * s) / steps;
    const xa = Math.max(0, Math.floor(cx - radius)), xb = Math.min(W - 1, Math.ceil(cx + radius));
    const ya = Math.max(0, Math.floor(cy - radius)), yb = Math.min(H - 1, Math.ceil(cy + radius));
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) paint[y * W + x] = value;
      }
    }
  }
  rebuildMask(seg);
}

/** Copy of everything the user can edit, for undo. */
export function snapshotEdits(seg) {
  return {
    paint: seg.paint.slice(),
    holes: seg.holes.map((h) => h.filled),
    openHoles: seg.openHoles.map((h) => h.filled),
  };
}

export function restoreEdits(seg, snap) {
  seg.paint.set(snap.paint);
  snap.holes.forEach((f, k) => (seg.holes[k].filled = f));
  snap.openHoles.forEach((f, k) => (seg.openHoles[k].filled = f));
  rebuildMask(seg);
}

function rebuildMask(seg) {
  const { width: W, height: H, strokes, holeLabels, holes, openLabels, openHoles, paint } = seg;
  const N = W * H;
  const fg = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const auto = strokes[i] ||
      (holeLabels[i] >= 0 && holes[holeLabels[i]].filled) ||
      (openLabels[i] >= 0 && openHoles[openLabels[i]].filled);
    fg[i] = paint[i] === 1 || (auto && paint[i] !== -1) ? 1 : 0;
  }
  // Keep the main drawing; brushed-in bits stay even if they don't touch it.
  const mask = pickMainComponent(fg, W, H);
  for (let i = 0; i < N; i++) if (paint[i] === 1) mask[i] = 1;
  seg.mask = mask;
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
