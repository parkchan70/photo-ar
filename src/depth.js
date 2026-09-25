import { pipeline, env, RawImage } from "@huggingface/transformers";

// Let the runtime pick the best available backend (WebGPU if present, else WASM).
env.allowLocalModels = false;

let estimatorPromise = null;

function getEstimator(onProgress) {
  if (!estimatorPromise) {
    estimatorPromise = pipeline(
      "depth-estimation",
      "onnx-community/depth-anything-v2-small",
      { progress_callback: onProgress }
    );
  }
  return estimatorPromise;
}

/**
 * Runs monocular depth estimation on an image.
 * @param {HTMLImageElement|HTMLCanvasElement} image
 * @param {(p: any) => void} [onProgress]
 * @returns {Promise<{data: Uint8Array, width: number, height: number}>} grayscale depth map, 0=far 255=near
 */
export async function estimateDepth(image, onProgress) {
  const estimator = await getEstimator(onProgress);

  // The pipeline's image loader doesn't accept a bare HTMLImageElement, so
  // rasterize to a canvas first and hand it a RawImage instance.
  const canvas = document.createElement("canvas");
  canvas.width = image.width || image.naturalWidth;
  canvas.height = image.height || image.naturalHeight;
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  const raw = RawImage.fromCanvas(canvas);

  const output = await estimator(raw);
  const { data, width, height } = output.depth;
  return { data, width, height };
}
