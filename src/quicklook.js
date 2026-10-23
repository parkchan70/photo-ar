import * as THREE from "three";
import { USDZExporter } from "./vendor/USDZExporter.js";

/**
 * iPhone/iPad have no WebXR, but Safari can open a .usdz in Apple's built-in
 * AR viewer (AR Quick Look): placement, move/rotate/scale and a photo shutter.
 * iOS Chrome/Firefox/Google app use the same WebKit and support it too.
 */
export function supportsQuickLook(ua = navigator.userAgent) {
  const a = document.createElement("a");
  if (a.relList?.supports?.("ar")) return true;
  return /iPhone|iPad|iPod/.test(ua) && /CriOS|EdgiOS|FxiOS|GSA/.test(ua);
}

/**
 * Exports the model as a USDZ blob URL, sized for the room (meters).
 * @param {THREE.Group} model - bottom at y=0, long side = 1 unit
 * @param {number} sizeMeters
 * @returns {Promise<string>} object URL; revoke when replaced
 */
export async function exportUsdz(model, sizeMeters = 0.4) {
  const copy = model.clone(); // shares geometry/material; the original stays untouched
  copy.position.set(0, 0, 0);
  copy.rotation.set(0, 0, 0);
  copy.scale.setScalar(sizeMeters);
  copy.visible = true;
  const root = new THREE.Group();
  root.add(copy);
  root.updateMatrixWorld(true);

  const data = await new USDZExporter().parse(root, { quickLookCompatible: true });
  return URL.createObjectURL(new Blob([data], { type: "model/vnd.usdz+zip" }));
}
