import * as THREE from "three";

const MIN_SCALE = 0.1;
const MAX_SCALE = 3;
const DEPTH = 1.6; // model distance from the camera, in model units

/**
 * Selfie mode: the phone's front (or rear) camera via getUserMedia, with the
 * 3D model drawn on a transparent canvas on top. WebXR AR only ever uses the
 * rear camera, so this is how the model and the user end up in one photo.
 * The model floats in screen space (no room tracking): 1-finger drag moves it,
 * "rotate" mode spins it, 2 fingers pinch to scale and twist to tilt.
 */
export class SelfieScene {
  constructor({ containerEl, overlayEl }) {
    this.containerEl = containerEl;
    this.overlayEl = overlayEl;
    this.facing = "user";
    this.stream = null;
    this.modelGroup = null;
    this.interactionMode = "move";
    this.running = false;

    this.video = document.createElement("video");
    this.video.className = "selfie-video";
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.setAttribute("playsinline", "");

    // preserveDrawingBuffer so capture can copy the canvas at any moment.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.classList.add("xr-canvas", "selfie-canvas");

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 50);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.2));
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(1, 2, 2);
    this.scene.add(dir);

    this._pointers = new Map(); // pointerId -> {x, y}
    this._gesture = null;
    this._onDown = this._onPointerDown.bind(this);
    this._onMove = this._onPointerMove.bind(this);
    this._onUp = this._onPointerUp.bind(this);
    this._onResize = () => this._resize();
    // Mouse wheel = pinch, for PCs with a webcam.
    this._onWheel = (e) => {
      if (!this.modelGroup || e.target.closest("#arControls, .ar-ui")) return;
      e.preventDefault();
      const s = this.modelGroup.scale.x * Math.exp(-e.deltaY * 0.001);
      this.modelGroup.scale.setScalar(THREE.MathUtils.clamp(s, MIN_SCALE, MAX_SCALE));
    };
  }

  static isSupported() {
    return !!navigator.mediaDevices?.getUserMedia;
  }

  setModel(group) {
    this.modelGroup = group;
    group.rotation.order = "ZYX"; // twist turns around the view axis even after a spin
    this.scene.add(group);
    this._needsPlacement = true; // placed once the screen size is known (start)
  }

  /** Lower middle of the screen, above the buttons; about a third of the screen tall. */
  resetPlacement() {
    const g = this.modelGroup;
    if (!g) return;
    g.rotation.set(0, 0, 0);
    g.scale.setScalar(1);
    g.position.set(0, 0, -DEPTH);
    g.updateMatrixWorld(true);
    const size = new THREE.Box3().setFromObject(g).getSize(new THREE.Vector3());
    const halfH = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * DEPTH;
    const halfW = halfH * this.camera.aspect;
    const scale = Math.min((halfH * 0.7) / (size.y || 1), (halfW * 1.2) / (size.x || 1));
    g.scale.setScalar(THREE.MathUtils.clamp(scale, MIN_SCALE, MAX_SCALE));
    g.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(g);
    const center = box.getCenter(new THREE.Vector3());
    g.position.x -= center.x;
    g.position.y += -halfH * 0.5 - box.min.y; // feet a quarter of the screen above the bottom
    this._needsPlacement = false;
  }

  /** @param {"user"|"environment"} facing */
  async start(facing = "user") {
    this.facing = facing;
    await this._openCamera();
    if (!this.video.parentNode) this.containerEl.prepend(this.video);
    if (!this.renderer.domElement.parentNode) this.video.after(this.renderer.domElement);
    this.video.classList.toggle("mirrored", facing === "user");
    this._resize();
    if (this._needsPlacement) this.resetPlacement();
    if (!this.running) {
      this.running = true;
      window.addEventListener("resize", this._onResize);
      this.overlayEl.addEventListener("pointerdown", this._onDown);
      this.overlayEl.addEventListener("pointermove", this._onMove);
      this.overlayEl.addEventListener("pointerup", this._onUp);
      this.overlayEl.addEventListener("pointercancel", this._onUp);
      this.overlayEl.addEventListener("wheel", this._onWheel, { passive: false });
      this.renderer.setAnimationLoop(() => this.renderer.render(this.scene, this.camera));
    }
  }

  async _openCamera() {
    this._stopTracks();
    const constraints = {
      video: { facingMode: { ideal: this.facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    };
    let stream;
    // Right after a WebXR session ends the camera can still be busy for a moment.
    for (let attempt = 0; ; attempt++) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        break;
      } catch (err) {
        if (attempt >= 3 || !["NotReadableError", "AbortError"].includes(err?.name)) throw err;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    this.stream = stream;
    this.video.srcObject = stream;
    await this.video.play().catch(() => {});
    if (!this.video.videoWidth) {
      await new Promise((r) => this.video.addEventListener("loadedmetadata", r, { once: true }));
    }
  }

  _stopTracks() {
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
  }

  stop() {
    this._stopTracks();
    this.video.srcObject = null;
    this.video.remove();
    this.renderer.domElement.remove();
    this.renderer.setAnimationLoop(null);
    window.removeEventListener("resize", this._onResize);
    this.overlayEl.removeEventListener("pointerdown", this._onDown);
    this.overlayEl.removeEventListener("pointermove", this._onMove);
    this.overlayEl.removeEventListener("pointerup", this._onUp);
    this.overlayEl.removeEventListener("pointercancel", this._onUp);
    this.overlayEl.removeEventListener("wheel", this._onWheel);
    this._pointers.clear();
    this._gesture = null;
    if (this.modelGroup) this.modelGroup.rotation.order = "XYZ";
    this.running = false;
  }

  setInteractionMode(mode) {
    this.interactionMode = mode;
    this._initGesture();
  }

  _resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** The photo as seen on screen: camera picture (cropped like the preview) plus the model. */
  async capture() {
    const gl = this.renderer.domElement;
    const W = gl.width;
    const H = gl.height;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");

    // Same crop as CSS object-fit: cover.
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    const s = Math.max(W / vw, H / vh);
    const dw = vw * s;
    const dh = vh * s;
    ctx.save();
    if (this.facing === "user") {
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(this.video, (W - dw) / 2, (H - dh) / 2, dw, dh);
    ctx.restore();

    this.renderer.render(this.scene, this.camera);
    ctx.drawImage(gl, 0, 0, W, H);

    return new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("이미지 변환 실패"))), "image/jpeg", 0.92)
    );
  }

  // ---------- Gestures ----------
  _onPointerDown(e) {
    if (e.target.closest("#arControls, .ar-ui")) return;
    e.preventDefault();
    this.overlayEl.setPointerCapture?.(e.pointerId);
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this._initGesture();
  }

  _onPointerMove(e) {
    if (!this._pointers.has(e.pointerId)) return;
    e.preventDefault();
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this._applyGesture();
  }

  _onPointerUp(e) {
    if (!this._pointers.delete(e.pointerId)) return;
    this._initGesture();
  }

  _initGesture() {
    const pts = Array.from(this._pointers.values());
    if (pts.length === 1) {
      this._gesture = { mode: this.interactionMode, lastX: pts[0].x, lastY: pts[0].y };
    } else if (pts.length >= 2) {
      const [a, b] = pts;
      this._gesture = {
        mode: "transform",
        prevDist: Math.hypot(b.x - a.x, b.y - a.y) || 1,
        prevAngle: Math.atan2(b.y - a.y, b.x - a.x),
      };
    } else {
      this._gesture = null;
    }
  }

  _applyGesture() {
    const g = this.modelGroup;
    const st = this._gesture;
    if (!g || !st) return;
    const pts = Array.from(this._pointers.values());

    if (pts.length === 1 && st.mode === "rotate") {
      g.rotation.y += (pts[0].x - st.lastX) * ((2 * Math.PI) / window.innerWidth);
    } else if (pts.length === 1) {
      // Screen pixels -> world units at the model's depth, so it stays under the finger.
      const depth = -g.position.z;
      const unitsPerPx = (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * depth) / window.innerHeight;
      g.position.x += (pts[0].x - st.lastX) * unitsPerPx;
      g.position.y -= (pts[0].y - st.lastY) * unitsPerPx;
    } else if (pts.length >= 2 && st.mode === "transform") {
      const [a, b] = pts;
      const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      g.scale.setScalar(THREE.MathUtils.clamp(g.scale.x * (dist / st.prevDist), MIN_SCALE, MAX_SCALE));
      let d = angle - st.prevAngle;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      g.rotation.z -= d;
      st.prevDist = dist;
      st.prevAngle = angle;
      return;
    }
    if (pts.length === 1) {
      st.lastX = pts[0].x;
      st.lastY = pts[0].y;
    }
  }
}
