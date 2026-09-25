import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

/**
 * Small non-AR turntable preview so users can sanity-check the relief mesh
 * on desktop or before entering AR (WebXR only works on-device).
 */
export class PreviewScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    this.camera.position.set(0, 0, 1.6);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.2));
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(1, 2, 2);
    this.scene.add(dir);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.minDistance = 0.3;
    this.controls.maxDistance = 4;

    this.currentModel = null;

    this._resize();
    window.addEventListener("resize", () => this._resize());
    // The canvas starts out inside a `hidden` container (0x0 layout box), so
    // window 'resize' never fires when it's later revealed. Watch the
    // element itself instead of relying only on the window event.
    this._resizeObserver = new ResizeObserver(() => this._resize());
    this._resizeObserver.observe(canvas);
    this.renderer.setAnimationLoop(() => this._tick());
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _tick() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  setModel(group, { resetView = true } = {}) {
    if (this.currentModel) {
      this.scene.remove(this.currentModel);
    }
    this.currentModel = group;
    this.scene.add(group);
    if (!resetView) return;

    const center = new THREE.Box3().setFromObject(group).getCenter(new THREE.Vector3());
    this.controls.target.copy(center);
    this.camera.position.set(center.x + 0.5, center.y + 0.2, center.z + 1.4);
    this.controls.update();
  }
}
