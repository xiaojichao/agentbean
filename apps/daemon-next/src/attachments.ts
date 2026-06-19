import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** Mirrors packages/contracts DispatchAttachmentDto (field is `name`, not `filename`). */
export interface DispatchAttachment {
  id: string;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface DownloadedAttachment extends DispatchAttachment {
  localPath: string;
}

export interface DownloadAttachmentsInput {
  serverUrl: string;
  token: string;
  teamId: string;
  inputDir: string;
  fetch?: typeof fetch;
}

export function safeAttachmentFilename(filename: string): string {
  return basename(filename)
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Downloads each attachment from the server artifact download route into inputDir.
 * Failures (non-ok or network error) are skipped rather than aborting the dispatch;
 * a missing attachment must not block command execution.
 */
export async function downloadAttachments(
  input: DownloadAttachmentsInput,
  attachments: DispatchAttachment[],
): Promise<DownloadedAttachment[]> {
  const fetchFn = input.fetch ?? fetch;
  const results: DownloadedAttachment[] = [];
  for (const attachment of attachments) {
    const url = `${input.serverUrl}/api/teams/${encodeURIComponent(input.teamId)}/artifacts/${encodeURIComponent(attachment.id)}/download`;
    try {
      const response = await fetchFn(url, { headers: { Authorization: `Bearer ${input.token}` } });
      if (!response.ok) {
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const localPath = join(input.inputDir, `${attachment.id}-${safeAttachmentFilename(attachment.name)}`);
      writeFileSync(localPath, bytes);
      results.push({ ...attachment, localPath });
    } catch {
      // skip on network error; never abort the dispatch
    }
  }
  return results;
}
