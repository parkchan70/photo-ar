import { segmentDrawing } from "./segment.js";
import { buildInflatedMesh, disposeModel } from "./inflate.js";
import { PreviewScene } from "./previewScene.js";
import { ARScene } from "./arScene.js";

const $ = (id) => document.getElementById(id);

const uploadBox = $("uploadBox");
const fileInput = $("fileInput");
const uploadPlaceholder = $("uploadPlaceholder");
const previewImg = $("previewImg");
const depthSlider = $("depthSlider");
const convertBtn = $("convertBtn");
const statusText = $("statusText");
const previewWrap = $("previewWrap");
const previewCanvas = $("previewCanvas");
const goArBtn = $("goArBtn");
const arSupportText = $("arSupportText");

const setupScreen = $("setup-screen");
const arScreenEl = $("ar-screen");
const arOverlay = $("ar-overlay");
const arHint = $("arHint");
const arControls = $("arControls");
const captureBtn = $("captureBtn");
const resetBtn = $("resetBtn");
const exitArBtn = $("exitArBtn");

let sourceImage = null; // HTMLImageElement
let segmentation = null; // {mask, width, height}
let modelGroup = null; // THREE.Group, lives in exactly one scene at a time

const preview = new PreviewScene(previewCanvas);

let arSupported = false;
ARScene.isSupported().then((supported) => {
  arSupported = supported;
  arSupportText.textContent = supported
    ? ""
    : "이 브라우저/기기는 WebXR AR을 지원하지 않아요. Android Chrome 최신 버전에서 열어보세요.";
});

let arScene = null;
function getArScene() {
  if (!arScene) {
    arScene = new ARScene({
      overlayEl: arOverlay,
      onPlacementChanged: (isPlaced) => {
        arHint.hidden = isPlaced;
        arControls.hidden = !isPlaced;
      },
      onSessionEnd: () => {
        exitArUI();
      },
    });
  }
  return arScene;
}

// ---------- Upload ----------
uploadBox.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;

  const url = URL.createObjectURL(file);
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = url;
  });

  sourceImage = img;
  previewImg.src = url;
  previewImg.hidden = false;
  uploadPlaceholder.hidden = true;
  convertBtn.disabled = false;
  previewWrap.hidden = true;
  goArBtn.disabled = true;
  statusText.textContent = "";
});

// ---------- Convert to 3D ----------
const thickness = () => 0.2 + (Number(depthSlider.value) / 100) * 1.2;

function rebuildModel({ resetView }) {
  const next = buildInflatedMesh(sourceImage, segmentation, thickness());
  const prev = modelGroup;
  modelGroup = next;
  preview.setModel(modelGroup, { resetView });
  if (prev) disposeModel(prev);
}

convertBtn.addEventListener("click", async () => {
  if (!sourceImage) return;
  convertBtn.disabled = true;
  statusText.textContent = "그림을 오려내는 중...";
  await new Promise((r) => setTimeout(r, 30)); // let the status text paint

  try {
    segmentation = segmentDrawing(sourceImage);
    statusText.textContent = "입체로 부풀리는 중...";
    await new Promise((r) => setTimeout(r, 30));
    rebuildModel({ resetView: true });

    previewWrap.hidden = false;
    goArBtn.disabled = !arSupported;
    statusText.textContent = "완료! 아래 미리보기를 돌려서 앞뒤를 확인해보세요.";
  } catch (err) {
    console.error(err);
    statusText.textContent = "3D 변환 중 오류가 발생했어요: " + (err?.message || err);
  } finally {
    convertBtn.disabled = false;
  }
});

depthSlider.addEventListener("change", () => {
  if (modelGroup && segmentation) rebuildModel({ resetView: false });
});

// ---------- Enter AR ----------
goArBtn.addEventListener("click", async () => {
  if (!modelGroup) return;
  const scene = getArScene();
  modelGroup.position.set(0, 0, 0);
  modelGroup.rotation.set(0, 0, 0);
  modelGroup.scale.setScalar(0.4); // ~40cm tall/wide in the room to start
  scene.setModel(modelGroup); // moves it out of the preview scene automatically

  setupScreen.classList.remove("active");
  arScreenEl.classList.add("active");
  arHint.hidden = false;
  arControls.hidden = true;

  try {
    await scene.start();
  } catch (err) {
    console.error(err);
    alert("AR 세션을 시작하지 못했어요: " + (err?.message || err));
    exitArUI();
  }
});

function exitArUI() {
  arScreenEl.classList.remove("active");
  setupScreen.classList.add("active");
  if (modelGroup) {
    modelGroup.position.set(0, 0, 0);
    modelGroup.rotation.set(0, 0, 0);
    modelGroup.scale.setScalar(1);
    modelGroup.visible = true;
    preview.setModel(modelGroup); // bring it back to the turntable preview
  }
}

exitArBtn.addEventListener("click", async () => {
  if (arScene) await arScene.end();
});

resetBtn.addEventListener("click", () => {
  if (arScene) arScene.resetPlacement();
});

captureBtn.addEventListener("click", async () => {
  if (!arScene) return;
  const result = await arScene.requestCapture();
  if (result.ok) {
    showCapturePreview(result.dataUrl);
  } else {
    alert("캡처에 실패했어요: " + (result.error?.message || result.error));
  }
});

function showCapturePreview(dataUrl) {
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:50;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:20px;";

  const img = document.createElement("img");
  img.src = dataUrl;
  img.style.cssText = "max-width:90%;max-height:70%;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,0.5);";

  const hint = document.createElement("p");
  hint.textContent = "이미지를 길게 눌러 저장하거나, 아래 버튼으로 다운로드하세요.";
  hint.style.cssText = "color:#fff;font-size:13px;text-align:center;margin:0;";

  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:12px;";

  const saveBtn = document.createElement("a");
  saveBtn.href = dataUrl;
  saveBtn.download = `ar-capture-${Date.now()}.png`;
  saveBtn.textContent = "다운로드";
  saveBtn.style.cssText =
    "background:#6d8cff;color:#fff;padding:10px 20px;border-radius:10px;text-decoration:none;font-weight:600;";

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "닫기";
  closeBtn.style.cssText =
    "background:rgba(255,255,255,0.15);color:#fff;padding:10px 20px;border-radius:10px;border:none;font-weight:600;";
  closeBtn.onclick = () => overlay.remove();

  row.appendChild(saveBtn);
  row.appendChild(closeBtn);
  overlay.appendChild(img);
  overlay.appendChild(hint);
  overlay.appendChild(row);
  document.body.appendChild(overlay);
}
