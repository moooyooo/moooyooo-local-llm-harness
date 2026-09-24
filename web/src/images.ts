import { MAX_IMAGES } from '../../shared/protocol';

export { MAX_IMAGES };

/** An image attached to the message being written. */
export interface Attachment {
  id: string;
  /** PNG or JPEG data URL, for the preview; the part after the comma is sent. */
  dataUrl: string;
}

/**
 * Longest side after scaling. An image costs about width × height / 1024 tokens (qwen3.8), so a full-size
 * screenshot would fill a small context; 1600 px keeps screenshot text readable at ~1,500 tokens.
 */
const MAX_SIDE = 1600;

/** Reads an image file (pasted, dropped or chosen), scaled down and converted to PNG or JPEG, which Ollama reads. */
export async function readImage(file: Blob): Promise<Attachment> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // Photos stay JPEG; screenshots and everything else become PNG, which keeps text sharp.
    const dataUrl = file.type === 'image/jpeg' ? canvas.toDataURL('image/jpeg', 0.9) : canvas.toDataURL('image/png');
    return { id: `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, dataUrl };
  } finally {
    bitmap.close();
  }
}

/** The plain base64 Ollama expects (it rejects a `data:` prefix). */
export function base64Of(dataUrl: string): string {
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

/** A data URL for base64 image data from history, typed by its first bytes. */
export function imageDataUrl(base64: string): string {
  return `data:${base64.startsWith('/9j/') ? 'image/jpeg' : 'image/png'};base64,${base64}`;
}

/** Image files among pasted or dropped items. */
export function imageFiles(items: DataTransferItemList | FileList | null | undefined): File[] {
  if (!items) return [];
  const files = Array.from(items as ArrayLike<DataTransferItem | File>).map((it) => ('getAsFile' in it ? (it.kind === 'file' ? it.getAsFile() : null) : it));
  return files.filter((f): f is File => !!f && f.type.startsWith('image/'));
}
