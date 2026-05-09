import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { logger } from './log.js';

export interface UploadResult {
  id: string;
  filename: string;
  downloadUrl: string;
}

export async function uploadArtifact(input: {
  serverUrl: string;
  token: string;
  networkId: string;
  filePath: string;
  channelId: string;
  uploaderId?: string;
  metaJson?: string;
}): Promise<UploadResult | null> {
  const { serverUrl, token, networkId, filePath, channelId, uploaderId, metaJson } = input;
  const filename = basename(filePath);

  let buffer: Buffer;
  let size: number;
  try {
    const st = statSync(filePath);
    size = st.size;
    buffer = readFileSync(filePath);
  } catch (err: any) {
    logger.warn({ err: err.message, filePath }, 'artifact read failed');
    return null;
  }

  // Node Buffer is a Uint8Array; cast to satisfy strict DOM types
  const blob = new Blob([buffer as unknown as BlobPart]);
  const form = new FormData();
  form.append('channelId', channelId);
  form.append('file', blob, filename);
  if (uploaderId) form.append('uploaderId', uploaderId);
  if (metaJson) form.append('metaJson', metaJson);

  try {
    const resp = await fetch(`${serverUrl}/api/networks/${networkId}/artifacts/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (!resp.ok) {
      const text = await resp.text();
      logger.warn({ status: resp.status, body: text, filePath }, 'artifact upload rejected');
      return null;
    }
    const result = (await resp.json()) as UploadResult;
    logger.info({ id: result.id, filename, sizeBytes: size }, 'artifact uploaded');
    return result;
  } catch (err: any) {
    logger.warn({ err: err.message, filePath }, 'artifact upload failed');
    return null;
  }
}
