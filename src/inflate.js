import * as THREE from "three";

const GRID = 170; // vertices along the long side of the photo

/**
 * Inflates a cut-out silhouette into a closed "balloon" mesh: front surface
 * bulges out, the back mirrors it, and side walls seal the rim. The photo is
 * mapped on both faces (the back shows it mirrored, like seeing through).
 *
 * The result stands upright with its bottom at y=0, long side = 1 unit.
 *
 * @param {HTMLImageElement|HTMLCanvasElement} image - texture, same framing as the segmented photo
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
  liftRim(px, front, rim);

  // Pixel space -> model space, normalized to the drawing's bounding box.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < nFront; i++) {
    minX = Math.min(minX, px[i * 3]); maxX = Math.max(maxX, px[i * 3]);
    minY = Math.min(minY, px[i * 3 + 1]); maxY = Math.max(maxY, px[i * 3 + 1]);
  }
  const size = Math.max(maxX - minX, maxY - minY) || 1;
  const cx = (minX + maxX) / 2;
  const uvAt = outlineAwareUv(mask, W, H);

  const positions = new Float32Array(nFront * 2 * 3);
  const uvs = new Float32Array(nFront * 2 * 2);
  for (let i = 0; i < nFront; i++) {
    const x = (px[i * 3] - cx) / size;
    const y = (maxY - px[i * 3 + 1]) / size; // bottom of drawing at y=0
    const z = px[i * 3 + 2] / size;
    const [tx, ty] = uvAt.surface(px[i * 3], px[i * 3 + 1]);
    const u = tx / (W - 1);
    const v = 1 - ty / (H - 1);
    positions.set([x, y, z], i * 3);
    positions.set([x, y, -z], (i + nFront) * 3);
    uvs.set([u, v], i * 2);
    uvs.set([u, v], (i + nFront) * 2);
  }

  const surface = [];
  for (let t = 0; t < front.length; t += 3) {
    surface.push(front[t], front[t + 1], front[t + 2]);
    surface.push(front[t] + nFront, front[t + 2] + nFront, front[t + 1] + nFront);
  }
  const wallTris = [];
  for (let e = 0; e < rim.length; e += 2) {
    const u = rim[e], v = rim[e + 1];
    wallTris.push(u, u + nFront, v, v, u + nFront, v + nFront);
  }

  // Normals from the shared mesh, so shading stays smooth around the rim.
  const shaded = new THREE.BufferGeometry();
  shaded.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  shaded.setIndex(surface.concat(wallTris));
  shaded.computeVertexNormals();
  const normals = shaded.getAttribute("normal").array;

  // The rim walls get their own copies of the rim vertices (same position and
  // normal) textured from just inside the outline, so the sides show the body
  // color instead of the drawing's outline stretched into a thick black band.
  const rimVerts = [...new Set(rim)];
  const nBase = nFront * 2;
  const total = nBase + rimVerts.length * 2;
  const allPos = new Float32Array(total * 3);
  const allNrm = new Float32Array(total * 3);
  const allUv = new Float32Array(total * 2);
  allPos.set(positions);
  allNrm.set(normals);
  allUv.set(uvs);
  const copyOf = new Map();
  rimVerts.forEach((vi, k) => {
    const [tx, ty] = uvAt.wall(px[vi * 3], px[vi * 3 + 1]);
    const u = tx / (W - 1), v = 1 - ty / (H - 1);
    for (const [src, dst] of [[vi, nBase + k * 2], [vi + nFront, nBase + k * 2 + 1]]) {
      allPos.set(positions.subarray(src * 3, src * 3 + 3), dst * 3);
      allNrm.set(normals.subarray(src * 3, src * 3 + 3), dst * 3);
      allUv.set([u, v], dst * 2);
    }
    copyOf.set(vi, nBase + k * 2);
  });
  const walls = wallTris.map((idx) => (idx < nFront ? copyOf.get(idx) : copyOf.get(idx - nFront) + 1));
  shaded.dispose();

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(allPos, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(allNrm, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(allUv, 2));
  geometry.setIndex(surface.concat(walls));

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

/**
 * Half-thickness per pixel, from the Poisson equation Δu = -1 inside the
 * silhouette (u = 0 outside) with height = 2·√u. A round blob becomes an
 * exact hemisphere and a long limb a round tube, with no crease along the
 * middle (a distance-transform profile leaves a sharp ridge there).
 */
function computeHeightField(mask, W, H, thickness) {
  const L = Math.max(W, H);
  // Coarse solve first; its result is the starting guess for the fine grid,
  // which then converges in far fewer passes.
  const coarse = solvePoisson(mask, W, H, Math.max(1, L / 90), null);
  const { u, gw, gh, cell } = solvePoisson(mask, W, H, Math.max(1, L / 180), coarse);

  const h = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const gy = y / cell, j0 = Math.floor(gy), fy = gy - j0;
    for (let x = 0; x < W; x++) {
      if (!mask[y * W + x]) continue;
      const gx = x / cell, i0 = Math.floor(gx), fx = gx - i0;
      const k = j0 * gw + i0;
      const i1 = i0 + 1 < gw ? 1 : 0, j1 = j0 + 1 < gh ? gw : 0;
      const v = (u[k] * (1 - fx) + u[k + i1] * fx) * (1 - fy) + (u[k + j1] * (1 - fx) + u[k + j1 + i1] * fx) * fy;
      h[y * W + x] = thickness * 2 * Math.sqrt(Math.max(0, v));
    }
  }
  return blur(h, W, H, 1);
}

/** Δu = -1 inside the silhouette, u = 0 outside, on a grid of `cell` px (SOR). */
function solvePoisson(mask, W, H, cell, init) {
  const gw = Math.ceil((W - 1) / cell) + 1;
  const gh = Math.ceil((H - 1) / cell) + 1;
  const u = new Float64Array(gw * gh);
  const interior = [];
  for (let j = 1; j < gh - 1; j++) {
    for (let i = 1; i < gw - 1; i++) {
      const x = Math.min(W - 1, Math.round(i * cell)), y = Math.min(H - 1, Math.round(j * cell));
      if (!mask[y * W + x]) continue;
      const k = j * gw + i;
      interior.push(k);
      if (init) u[k] = sampleGrid(init, i * cell, j * cell);
    }
  }
  const c2 = cell * cell;
  const n = Math.max(gw, gh);
  const omega = 2 / (1 + Math.sin(Math.PI / n));
  const tol = 0.1 * c2; // heights end up within ~0.1 px of a fully converged solve
  for (let it = 0; it < 4 * n; it++) {
    let maxDelta = 0;
    for (const k of interior) {
      const delta = (u[k - 1] + u[k + 1] + u[k - gw] + u[k + gw] + c2) / 4 - u[k];
      u[k] += omega * delta;
      if (delta > maxDelta) maxDelta = delta;
      else if (-delta > maxDelta) maxDelta = -delta;
    }
    if (maxDelta < tol) break;
  }
  return { u, gw, gh, cell };
}

function sampleGrid({ u, gw, gh, cell }, x, y) {
  const gx = Math.min(gw - 1.001, x / cell), gy = Math.min(gh - 1.001, y / cell);
  const i0 = Math.floor(gx), j0 = Math.floor(gy), fx = gx - i0, fy = gy - j0;
  const k = j0 * gw + i0;
  return (u[k] * (1 - fx) + u[k + 1] * fx) * (1 - fy) + (u[k + gw] * (1 - fx) + u[k + gw + 1] * fx) * fy;
}

/**
 * Where each vertex should sample the texture. Drawings usually have a dark
 * outline right at the silhouette, and the inflated sides are near vertical,
 * so sampled as-is that thin line paints a thick band down the sides. This
 * squeezes the outline band into the outermost rim and pulls the sides'
 * texture from just inside it (only near the edge; the interior is untouched).
 */
function outlineAwareUv(mask, W, H) {
  const L = Math.max(W, H);
  const OUTLINE = Math.max(2, L / 100); // typical outline width (px)
  const REACH = 3 * OUTLINE;            // beyond this the texture isn't moved

  const dist2 = distanceTransform(mask, W, H);
  const dist = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) dist[i] = Math.sqrt(dist2[i]);
  const local = maxFilter(dist, W, H, Math.ceil(REACH)); // ~half-width of the part here

  const at = (x, y, wall) => {
    let ix = Math.min(W - 2, Math.max(1, Math.round(x)));
    let iy = Math.min(H - 2, Math.max(1, Math.round(y)));
    // Rim smoothing can leave a vertex just outside the cut-out (no inward
    // direction there); work from the nearest inside pixel instead.
    if (!mask[iy * W + ix]) {
      let best = -1, bestD = Infinity;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const qx = ix + dx, qy = iy + dy;
          if (qx < 1 || qy < 1 || qx > W - 2 || qy > H - 2 || !mask[qy * W + qx]) continue;
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; best = qy * W + qx; }
        }
      }
      if (best < 0) return [x, y];
      ix = best % W;
      iy = (best / W) | 0;
      x = ix;
      y = iy;
    }
    const i = iy * W + ix;
    let gx = (dist[i + 1] - dist[i - 1]) / 2, gy = (dist[i + W] - dist[i - W]) / 2;
    const g = Math.hypot(gx, gy);
    if (g < 1e-3) return [x, y];
    gx /= g;
    gy /= g;

    // Thin parts: never pull past the middle into the other side's outline.
    const T = Math.min(OUTLINE, 0.45 * local[i]);
    const T2 = Math.min(REACH, 0.9 * local[i]);
    const e = Math.max(0, dist[i] - 0.5); // distance from the actual edge
    let s;
    if (wall) {
      s = Math.max(e, T2); // well past the outline: body color
    } else {
      const a = T / 4;
      if (e < a) s = (e * T) / a;
      else if (e < T2 && T2 > a) s = T + ((e - a) * (T2 - T)) / (T2 - a);
      else s = e;
    }
    const shift = Math.max(0, s - e);
    return [x + gx * shift, y + gy * shift];
  };
  return { surface: (x, y) => at(x, y, false), wall: (x, y) => at(x, y, true) };
}

/** Max over a (2r+1)² window: separable, monotonic-queue sliding max (cost independent of r). */
function maxFilter(src, W, H, r) {
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  const q = new Int32Array(Math.max(W, H));
  const pass = (read, write, len, count, stride, step) => {
    for (let line = 0; line < count; line++) {
      const base = line * stride;
      let head = 0, tail = 0;
      for (let i = 0; i < len + r; i++) {
        if (i < len) {
          const v = read[base + i * step];
          while (tail > head && read[base + q[tail - 1] * step] <= v) tail--;
          q[tail++] = i;
        }
        const c = i - r; // window center
        if (c < 0) continue;
        while (q[head] < c - r) head++;
        write[base + c * step] = read[base + q[head] * step];
      }
    }
  };
  pass(src, tmp, W, H, W, 1); // rows
  pass(tmp, out, H, W, 1, W); // columns
  return out;
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

/**
 * A rounded profile is vertical at the silhouette, so the true surface between
 * the rim and the first ring inside is basically a wall. Raising rim vertices
 * to that ring's height makes the (body-colored) side wall carry it, instead
 * of a tall row of outline-to-body triangles that reads as a dark band from
 * the side.
 */
function liftRim(px, front, rim) {
  const isRim = new Set(rim);
  const best = new Map();
  for (let t = 0; t < front.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = front[t + k];
      if (!isRim.has(a)) continue;
      for (let m = 1; m < 3; m++) {
        const b = front[t + ((k + m) % 3)];
        if (!isRim.has(b)) best.set(a, Math.max(best.get(a) || 0, px[b * 3 + 2]));
      }
    }
  }
  for (const [a, z] of best) px[a * 3 + 2] = Math.max(px[a * 3 + 2], 0.9 * z);
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
