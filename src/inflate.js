import * as THREE from "three";

const GRID = 170; // vertices along the long side of the photo

/**
 * Inflates a cut-out silhouette into a closed "balloon" mesh: front surface
 * bulges out, the back mirrors it, and side walls seal the rim. The photo is
 * mapped on both faces (the back shows it mirrored, like seeing through).
 *
 * The result stands upright with its bottom at y=0, long side = 1 unit.
 *
 * @param {HTMLImageElement} image
 * @param {{mask: Uint8Array, width: number, height: number}} seg
 * @param {number} thickness - roughly depth/width ratio at the fattest part
 */
export function buildInflatedMesh(image, seg, thickness = 0.5) {
  const { mask, width: W, height: H } = seg;
  const height = computeHeightField(mask, W, H, thickness);

  const L = Math.max(W, H);
  const step = L / GRID;
  const cols = Math.floor((W - 1) / step) + 1;
  const rows = Math.floor((H - 1) / step) + 1;

  const gridIdx = new Int32Array(cols * rows).fill(-1);
  const px = []; // pixel-space x, y, z (z = half-thickness)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = Math.min(W - 1, Math.round(c * step));
      const y = Math.min(H - 1, Math.round(r * step));
      if (!mask[y * W + x]) continue;
      gridIdx[r * cols + c] = px.length / 3;
      px.push(c * step, r * step, height[y * W + x]);
    }
  }
  const nFront = px.length / 3;
  if (nFront < 3) throw new Error("그림 영역이 너무 작아요.");

  // Front triangles (CCW seen from +z once y is flipped to point up).
  const front = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = gridIdx[r * cols + c];
      const b = gridIdx[r * cols + c + 1];
      const cc = gridIdx[(r + 1) * cols + c];
      const d = gridIdx[(r + 1) * cols + c + 1];
      const n = (a >= 0) + (b >= 0) + (cc >= 0) + (d >= 0);
      if (n === 4) front.push(a, cc, b, b, cc, d);
      else if (n === 3) {
        if (d < 0) front.push(a, cc, b);
        else if (a < 0) front.push(b, cc, d);
        else if (b < 0) front.push(a, cc, d);
        else front.push(a, d, b);
      }
    }
  }

  // Rim = directed front edges with no opposite twin.
  const edgeSet = new Set();
  for (let t = 0; t < front.length; t += 3) {
    for (let k = 0; k < 3; k++) edgeSet.add(front[t + k] * nFront + front[t + ((k + 1) % 3)]);
  }
  const rim = [];
  for (const key of edgeSet) {
    const u = Math.floor(key / nFront), v = key % nFront;
    if (!edgeSet.has(v * nFront + u)) rim.push(u, v);
  }

  smoothRim(px, rim, 4);

  // Pixel space -> model space, normalized to the drawing's bounding box.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < nFront; i++) {
    minX = Math.min(minX, px[i * 3]); maxX = Math.max(maxX, px[i * 3]);
    minY = Math.min(minY, px[i * 3 + 1]); maxY = Math.max(maxY, px[i * 3 + 1]);
  }
  const size = Math.max(maxX - minX, maxY - minY) || 1;
  const cx = (minX + maxX) / 2;

  const positions = new Float32Array(nFront * 2 * 3);
  const uvs = new Float32Array(nFront * 2 * 2);
  for (let i = 0; i < nFront; i++) {
    const x = (px[i * 3] - cx) / size;
    const y = (maxY - px[i * 3 + 1]) / size; // bottom of drawing at y=0
    const z = px[i * 3 + 2] / size;
    const u = px[i * 3] / (W - 1);
    const v = 1 - px[i * 3 + 1] / (H - 1);
    positions.set([x, y, z], i * 3);
    positions.set([x, y, -z], (i + nFront) * 3);
    uvs.set([u, v], i * 2);
    uvs.set([u, v], (i + nFront) * 2);
  }

  const indices = [];
  for (let t = 0; t < front.length; t += 3) {
    indices.push(front[t], front[t + 1], front[t + 2]);
    indices.push(front[t] + nFront, front[t + 2] + nFront, front[t + 1] + nFront);
  }
  for (let e = 0; e < rim.length; e += 2) {
    const u = rim[e], v = rim[e + 1];
    const ub = u + nFront, vb = v + nFront;
    indices.push(u, ub, v, v, ub, vb);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const texture = new THREE.Texture(image);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;

  const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.85, metalness: 0 });
  const mesh = new THREE.Mesh(geometry, material);

  const group = new THREE.Group();
  group.add(mesh);
  return group;
}

export function disposeModel(group) {
  group.traverse((o) => {
    if (o.isMesh) {
      o.geometry.dispose();
      o.material.map?.dispose();
      o.material.dispose();
    }
  });
}

/** Half-thickness per pixel: rounded (sqrt-of-distance) profile, lightly blurred. */
function computeHeightField(mask, W, H, thickness) {
  const dist2 = distanceTransform(mask, W, H);
  let dMax = 0;
  for (let i = 0; i < dist2.length; i++) dMax = Math.max(dMax, dist2[i]);
  dMax = Math.sqrt(dMax);

  const h = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const d = Math.sqrt(dist2[i]);
    h[i] = mask[i] ? thickness * Math.sqrt(Math.max(0, d - 1) * dMax) : 0;
  }
  const r = Math.max(1, Math.round(Math.max(W, H) / 200));
  return blur(blur(h, W, H, r), W, H, r);
}

/** Squared Euclidean distance to the nearest background pixel (image edge counts as background). */
function distanceTransform(mask, W, H) {
  const PW = W + 2, PH = H + 2;
  const INF = 1e20;
  const f = new Float64Array(PW * PH);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[(y + 1) * PW + x + 1] = mask[y * W + x] ? INF : 0;
  }
  const n = Math.max(PW, PH);
  const line = new Float64Array(n), out = new Float64Array(n);
  const v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < PW; x++) {
    for (let y = 0; y < PH; y++) line[y] = f[y * PW + x];
    edt1d(line, PH, out, v, z);
    for (let y = 0; y < PH; y++) f[y * PW + x] = out[y];
  }
  for (let y = 0; y < PH; y++) {
    for (let x = 0; x < PW; x++) line[x] = f[y * PW + x];
    edt1d(line, PW, out, v, z);
    for (let x = 0; x < PW; x++) f[y * PW + x] = out[x];
  }
  const res = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) res[y * W + x] = f[(y + 1) * PW + x + 1];
  }
  return res;
}

// Felzenszwalb & Huttenlocher 1D squared distance transform.
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

function blur(src, W, H, r) {
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0, c = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(W - 1, x + r); k++) { s += src[y * W + k]; c++; }
      tmp[y * W + x] = s / c;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0, c = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(H - 1, y + r); k++) { s += tmp[k * W + x]; c++; }
      out[y * W + x] = s / c;
    }
  }
  return out;
}

/** Laplacian smoothing of rim vertices in XY to soften the grid staircase. */
function smoothRim(px, rim, iterations) {
  const nbrs = new Map();
  for (let e = 0; e < rim.length; e += 2) {
    const u = rim[e], v = rim[e + 1];
    if (!nbrs.has(u)) nbrs.set(u, []);
    if (!nbrs.has(v)) nbrs.set(v, []);
    nbrs.get(u).push(v);
    nbrs.get(v).push(u);
  }
  for (let it = 0; it < iterations; it++) {
    const next = new Map();
    for (const [i, ns] of nbrs) {
      let sx = 0, sy = 0;
      for (const j of ns) { sx += px[j * 3]; sy += px[j * 3 + 1]; }
      next.set(i, [
        px[i * 3] * 0.5 + (sx / ns.length) * 0.5,
        px[i * 3 + 1] * 0.5 + (sy / ns.length) * 0.5,
      ]);
    }
    for (const [i, [x, y]] of next) { px[i * 3] = x; px[i * 3 + 1] = y; }
  }
}
