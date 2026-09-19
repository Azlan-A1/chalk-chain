import { photoHash } from '@chalk/shared';

export const MAX_EDGE = 1600;

export function fitWithin(w: number, h: number, maxEdge = MAX_EDGE): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

export interface PreparedPhoto {
  blob: Blob;
  bytes: Uint8Array;
  hash: Uint8Array;
  url: string;
}

/**
 * Downscale to at most 1600 px on the long edge and re-encode as JPEG.
 * The hash is over these exact bytes: they are what gets committed on-chain and uploaded.
 */
export async function preparePhoto(file: Blob): Promise<PreparedPhoto> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const { width, height } = fitWithin(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not read the photo.');
  ctx.drawImage(bmp, 0, 0, width, height);
  bmp.close();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read the photo.'))), 'image/jpeg', 0.85),
  );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { blob, bytes, hash: photoHash(bytes), url: URL.createObjectURL(blob) };
}
