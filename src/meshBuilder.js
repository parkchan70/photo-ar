import * as THREE from "three";

/**
 * Builds a textured "relief" mesh: a subdivided plane displaced along its
 * normal by a monocular depth map, so the flat photo gains real 3D bulge.
 *
 * @param {HTMLImageElement|HTMLCanvasElement} image - source photo
 * @param {{data: Uint8Array, width: number, height: number}} depthMap - grayscale, 255 = closest
 * @param {number} strength - 0..1, how pronounced the relief is
 * @param {number} segments - grid resolution
 * @returns {THREE.Group}
 */
export function buildReliefMesh(image, depthMap, strength = 0.35, segments = 128) {
  const imgW = image.width;
  const imgH = image.height;
  const aspect = imgW / imgH;

  const width = aspect >= 1 ? 1 : aspect;
  const height = aspect >= 1 ? 1 / aspect : 1;

  const geometry = new THREE.PlaneGeometry(width, height, segments, segments);
  const posAttr = geometry.attributes.position;
  const uvAttr = geometry.attributes.uv;

  // Displacement is expressed relative to the plane's own size so it looks
  // consistent regardless of final real-world scale in AR.
  const maxDim = Math.max(width, height);
  const depthScale = maxDim * strength;

  const dW = depthMap.width;
  const dH = depthMap.height;
  const dData = depthMap.data;

  for (let i = 0; i < posAttr.count; i++) {
    const u = uvAttr.getX(i);
    const v = uvAttr.getY(i);

    const px = Math.min(dW - 1, Math.max(0, Math.round(u * (dW - 1))));
    const py = Math.min(dH - 1, Math.max(0, Math.round((1 - v) * (dH - 1))));
    const depthValue = dData[py * dW + px] / 255; // 0 far .. 1 near

    posAttr.setZ(i, depthValue * depthScale);
  }
  posAttr.needsUpdate = true;
  geometry.computeVertexNormals();

  const texture = new THREE.Texture(image);
  texture.needsUpdate = true;
  texture.colorSpace = THREE.SRGBColorSpace;

  const material = new THREE.MeshStandardMaterial({
    map: texture,
    side: THREE.DoubleSide,
    roughness: 0.9,
    metalness: 0,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = 0; // faces +Z by default (towards camera when placed upright)

  const group = new THREE.Group();
  group.add(mesh);
  group.userData.planeMaxDim = maxDim;
  return group;
}

/** Rebuilds only the displacement of an existing relief mesh group (fast slider updates). */
export function updateReliefStrength(group, depthMap, strength) {
  const mesh = group.children[0];
  const geometry = mesh.geometry;
  const posAttr = geometry.attributes.position;
  const uvAttr = geometry.attributes.uv;

  const maxDim = group.userData.planeMaxDim || 1;
  const depthScale = maxDim * strength;

  const dW = depthMap.width;
  const dH = depthMap.height;
  const dData = depthMap.data;

  for (let i = 0; i < posAttr.count; i++) {
    const u = uvAttr.getX(i);
    const v = uvAttr.getY(i);
    const px = Math.min(dW - 1, Math.max(0, Math.round(u * (dW - 1))));
    const py = Math.min(dH - 1, Math.max(0, Math.round((1 - v) * (dH - 1))));
    const depthValue = dData[py * dW + px] / 255;
    posAttr.setZ(i, depthValue * depthScale);
  }
  posAttr.needsUpdate = true;
  geometry.computeVertexNormals();
}
