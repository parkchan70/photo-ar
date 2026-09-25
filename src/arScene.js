import * as THREE from "three";

const MIN_SCALE = 0.05;
const MAX_SCALE = 5;

/**
 * Handles the WebXR immersive-ar session: hit-test placement, and
 * touch gestures (1-finger drag = move, 2-finger twist = rotate,
 * 2-finger pinch = scale) on the placed model.
 */
export class ARScene {
  constructor({ overlayEl, onPlacementChanged, onSessionEnd }) {
    this.overlayEl = overlayEl;
    this.onPlacementChanged = onPlacementChanged;
    this.onSessionEnd = onSessionEnd;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.xr.enabled = true;
    this.renderer.domElement.classList.add("xr-canvas");

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      70,
      window.innerWidth / window.innerHeight,
      0.01,
      20
    );

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.2));
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(1, 2, 1);
    this.scene.add(dir);

    this.reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.06, 0.075, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x6d8cff })
    );
    this.reticle.matrixAutoUpdate = false;
    this.reticle.visible = false;
    this.scene.add(this.reticle);

    this.hitTestSource = null;
    this.hitTestSourceRequested = false;
    this.modelGroup = null; // the object the user places
    this.placed = false;

    this._floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._raycaster = new THREE.Raycaster();
    this._touches = new Map(); // id -> {x, y}
    this._gestureState = null;

    this._captureRequested = false;
    this._onCaptured = null;

    this._boundOnSelect = this._onSelect.bind(this);
    this._boundTouchStart = this._onTouchStart.bind(this);
    this._boundTouchMove = this._onTouchMove.bind(this);
    this._boundTouchEnd = this._onTouchEnd.bind(this);
  }

  static async isSupported() {
    if (!navigator.xr) return false;
    try {
      return await navigator.xr.isSessionSupported("immersive-ar");
    } catch {
      return false;
    }
  }

  setModel(group) {
    this.modelGroup = group;
    this.modelGroup.visible = false;
    this.scene.add(this.modelGroup);
  }

  async start() {
    const session = await navigator.xr.requestSession("immersive-ar", {
      requiredFeatures: ["hit-test"],
      optionalFeatures: ["dom-overlay"],
      domOverlay: { root: this.overlayEl },
    });

    document.body.appendChild(this.renderer.domElement);
    // three.js defaults to 'local-floor', which many phones reject; 'local' is
    // guaranteed for immersive sessions and hit-test gives us the floor anyway.
    this.renderer.xr.setReferenceSpaceType("local");
    try {
      await this.renderer.xr.setSession(session);
    } catch (err) {
      // Don't leave a half-started session holding the camera with a black screen.
      await session.end().catch(() => {});
      if (this.renderer.domElement.parentNode) {
        this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
      }
      throw err;
    }

    this.placed = false;
    this.hitTestSource = null;
    this.hitTestSourceRequested = false;
    this.reticle.visible = false;
    if (this.modelGroup) this.modelGroup.visible = false;

    this.overlayEl.addEventListener("touchstart", this._boundTouchStart, { passive: false });
    this.overlayEl.addEventListener("touchmove", this._boundTouchMove, { passive: false });
    this.overlayEl.addEventListener("touchend", this._boundTouchEnd, { passive: false });
    this.overlayEl.addEventListener("touchcancel", this._boundTouchEnd, { passive: false });
    session.addEventListener("select", this._boundOnSelect);

    session.addEventListener("end", () => this._onSessionEnd());

    this.renderer.setAnimationLoop((timestamp, frame) => this._tick(timestamp, frame));
    this.session = session;
  }

  async end() {
    if (this.session) {
      await this.session.end();
    }
  }

  _onSessionEnd() {
    this.renderer.setAnimationLoop(null);
    this.overlayEl.removeEventListener("touchstart", this._boundTouchStart);
    this.overlayEl.removeEventListener("touchmove", this._boundTouchMove);
    this.overlayEl.removeEventListener("touchend", this._boundTouchEnd);
    this.overlayEl.removeEventListener("touchcancel", this._boundTouchEnd);
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
    this.session = null;
    if (this.onSessionEnd) this.onSessionEnd();
  }

  /** Re-arm placement so the user can drop the model somewhere else. */
  resetPlacement() {
    this.placed = false;
    if (this.modelGroup) this.modelGroup.visible = false;
    if (this.onPlacementChanged) this.onPlacementChanged(false);
  }

  requestCapture() {
    return new Promise((resolve) => {
      this._captureRequested = true;
      this._onCaptured = resolve;
    });
  }

  _tick(timestamp, frame) {
    if (frame) {
      const referenceSpace = this.renderer.xr.getReferenceSpace();
      const session = this.renderer.xr.getSession();

      if (!this.hitTestSourceRequested) {
        this.hitTestSourceRequested = true;
        session.requestReferenceSpace("viewer").then((viewerSpace) => {
          session.requestHitTestSource({ space: viewerSpace }).then((source) => {
            this.hitTestSource = source;
          });
        });
      }

      if (this.hitTestSource && !this.placed) {
        const hits = frame.getHitTestResults(this.hitTestSource);
        if (hits.length > 0) {
          const pose = hits[0].getPose(referenceSpace);
          this.reticle.visible = true;
          this.reticle.matrix.fromArray(pose.transform.matrix);
          this._lastHitPose = pose;
        } else {
          this.reticle.visible = false;
          this._lastHitPose = null;
        }
      } else {
        this.reticle.visible = false;
      }
    }

    this.renderer.render(this.scene, this.camera);

    if (this._captureRequested) {
      this._captureRequested = false;
      try {
        const dataUrl = this.renderer.domElement.toDataURL("image/png");
        if (this._onCaptured) this._onCaptured({ ok: true, dataUrl });
      } catch (err) {
        if (this._onCaptured) this._onCaptured({ ok: false, error: err });
      }
      this._onCaptured = null;
    }
  }

  _onSelect() {
    if (this.placed || !this.reticle.visible || !this.modelGroup) return;
    this.modelGroup.position.setFromMatrixPosition(this.reticle.matrix);
    // Stand upright (model's bottom is at local y=0) facing the camera.
    const camPos = new THREE.Vector3();
    this.camera.getWorldPosition(camPos);
    const toCam = new THREE.Vector3().subVectors(camPos, this.modelGroup.position);
    const angle = Math.atan2(toCam.x, toCam.z);
    this.modelGroup.rotation.set(0, Number.isFinite(angle) ? angle : 0, 0);
    this.modelGroup.visible = true;
    this.placed = true;
    this._floorPlane.constant = -this.modelGroup.position.y;
    if (this.onPlacementChanged) this.onPlacementChanged(true);
  }

  _touchListFromEvent(e) {
    return Array.from(e.touches).filter((t) => {
      const el = document.elementFromPoint(t.clientX, t.clientY);
      return !el || !el.closest("#arControls");
    });
  }

  _onTouchStart(e) {
    if (!this.placed) return;
    const touches = this._touchListFromEvent(e);
    if (touches.length === 0) return;
    e.preventDefault();
    this._touches.clear();
    for (const t of touches) this._touches.set(t.identifier, { x: t.clientX, y: t.clientY });
    this._initGesture();
  }

  _onTouchMove(e) {
    if (!this.placed || this._touches.size === 0) return;
    const touches = this._touchListFromEvent(e).filter((t) => this._touches.has(t.identifier));
    if (touches.length === 0) return;
    e.preventDefault();
    for (const t of touches) this._touches.set(t.identifier, { x: t.clientX, y: t.clientY });
    this._applyGesture();
  }

  _onTouchEnd(e) {
    if (this._touches.size === 0) return;
    const stillDown = new Set(Array.from(e.touches).map((t) => t.identifier));
    for (const id of Array.from(this._touches.keys())) {
      if (!stillDown.has(id)) this._touches.delete(id);
    }
    this._initGesture();
  }

  _initGesture() {
    const pts = Array.from(this._touches.values());
    if (pts.length === 1) {
      this._gestureState = { mode: "move" };
    } else if (pts.length >= 2) {
      const [a, b] = pts;
      this._gestureState = {
        mode: "transform",
        prevDist: Math.hypot(b.x - a.x, b.y - a.y),
        prevAngle: Math.atan2(b.y - a.y, b.x - a.x),
      };
    } else {
      this._gestureState = null;
    }
  }

  _screenToNDC(x, y) {
    return new THREE.Vector2(
      (x / window.innerWidth) * 2 - 1,
      -(y / window.innerHeight) * 2 + 1
    );
  }

  _applyGesture() {
    if (!this.modelGroup || !this._gestureState) return;
    const pts = Array.from(this._touches.values());

    if (this._gestureState.mode === "move" && pts.length === 1) {
      const ndc = this._screenToNDC(pts[0].x, pts[0].y);
      this._raycaster.setFromCamera(ndc, this.camera);
      const hit = new THREE.Vector3();
      if (this._raycaster.ray.intersectPlane(this._floorPlane, hit)) {
        this.modelGroup.position.x = hit.x;
        this.modelGroup.position.z = hit.z;
      }
    } else if (this._gestureState.mode === "transform" && pts.length >= 2) {
      const [a, b] = pts;
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const angle = Math.atan2(b.y - a.y, b.x - a.x);

      const scaleFactor = dist / this._gestureState.prevDist;
      const newScale = THREE.MathUtils.clamp(
        this.modelGroup.scale.x * scaleFactor,
        MIN_SCALE,
        MAX_SCALE
      );
      this.modelGroup.scale.setScalar(newScale);

      const deltaAngle = angle - this._gestureState.prevAngle;
      this.modelGroup.rotation.y -= deltaAngle;

      this._gestureState.prevDist = dist;
      this._gestureState.prevAngle = angle;
    }
  }
}
