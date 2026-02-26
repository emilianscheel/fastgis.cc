
export async function fetchTileBitmap(url) {
  const response = await fetch(url, { mode: "cors", credentials: "omit" });
  if (!response.ok) {
    throw new Error(`Tile request failed with status ${response.status}`);
  }
  const blob = await response.blob();
  return await createImageBitmap(blob);
}

export function sampleTileEdgeColors(bitmap) {
  let canvas;
  if (typeof OffscreenCanvas !== "undefined") {
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  } else if (typeof document !== "undefined") {
    canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
  } else {
    throw new Error("No canvas API available for tile color sampling");
  }

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("Could not create 2D context for tile color sampling");
  }

  ctx.drawImage(bitmap, 0, 0);

  const sampleRow = (y) => {
    const row = ctx.getImageData(0, y, bitmap.width, 1).data;
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < row.length; i += 4) {
      const a = row[i + 3];
      if (a === 0) continue;
      r += row[i];
      g += row[i + 1];
      b += row[i + 2];
      n += 1;
    }
    if (n === 0) return [0, 0, 0];
    return [r / n, g / n, b / n];
  };

  const top = sampleRow(0);
  const bottom = sampleRow(Math.max(0, bitmap.height - 1));
  return [top[0], top[1], top[2], bottom[0], bottom[1], bottom[2]];
}

export async function fetchTileBytes(url) {
  const response = await fetch(url, { mode: "cors", credentials: "omit" });
  if (!response.ok) {
    throw new Error(`Tile request failed with status ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export function webgpuSupported() {
  return typeof navigator !== "undefined" && !!navigator.gpu;
}
