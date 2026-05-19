import type { Express, Request, Response, NextFunction } from 'express';
import type multer from 'multer';
import { mkdirSync, renameSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { StorageManager } from './storage.js';
import { newId } from './ids.js';
import { logger } from './log.js';
import { verifyUserToken } from './auth.js';

type MulterUpload = ReturnType<typeof multer>;
interface MulterRequest extends Request { file?: Express.Multer.File; }

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
};

function guessMime(filename: string): string {
  const ext = filename.toLowerCase().replace(/^.*\./, '.');
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

export interface ArtifactRoutesDeps {
  app: Express;
  storageManager: StorageManager;
  upload: MulterUpload;
  token: string;
  globalDb?: {
    users: { get(id: string): { id: string } | null };
    networks: { get(id: string): { id: string; visibility: 'public' | 'private' } | null };
    networkMembers: { isMember(networkId: string, userId: string): boolean };
  };
}

function validateNetworkId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

export function attachArtifactRoutes(deps: ArtifactRoutesDeps): void {
  const { app, storageManager, upload, token, globalDb } = deps;

  const auth = (req: Request, res: Response, next: NextFunction) => {
    const networkId = req.params.networkId;
    const hdr = req.headers.authorization;
    const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
    const bearer = hdr?.startsWith('Bearer ') ? hdr.slice('Bearer '.length) : undefined;
    const provided = bearer ?? queryToken;
    if (!networkId || !validateNetworkId(networkId)) return res.status(400).json({ error: 'invalid networkId' });
    if (provided === token) return next();
    if (provided && globalDb) {
      const parsed = verifyUserToken(provided, globalDb);
      if (parsed?.networkId === networkId) {
        const network = globalDb.networks.get(networkId);
        if (network?.visibility === 'public' || globalDb.networkMembers.isMember(networkId, parsed.userId)) {
          return next();
        }
      }
    }
    return res.status(401).json({ error: 'unauthorized' });
  };

  app.post('/api/networks/:networkId/artifacts/upload', auth, upload.single('file'), (req: MulterRequest, res: Response) => {
    const networkId = req.params.networkId!;
    if (!validateNetworkId(networkId)) return res.status(400).json({ error: 'invalid networkId' });
    const file = req.file;
    const channelId = req.body.channelId as string | undefined;
    if (!file) return res.status(400).json({ error: 'no file' });
    if (!channelId) return res.status(400).json({ error: 'no channelId' });

    const space = storageManager.getSpace(networkId);
    const artifactDir = space.artifactDir;

    const id = newId();
    const filename = file.originalname || basename(file.path);
    const mimeType = guessMime(filename);
    const subDir = join(artifactDir, id.slice(0, 4), id.slice(4));
    mkdirSync(subDir, { recursive: true });
    const storagePath = join(id.slice(0, 4), id.slice(4), filename);
    const destPath = join(artifactDir, storagePath);

    try {
      renameSync(file.path, destPath);
    } catch (err: any) {
      logger.error({ err: err.message }, 'artifact rename failed');
      return res.status(500).json({ error: 'storage error' });
    }

    const uploaderId = (req.body.uploaderId as string) ?? 'unknown';
    const metaJson = (req.body.metaJson as string) ?? null;

    space.artifacts.create({
      id, messageId: null, uploaderId, filename, mimeType,
      sizeBytes: file.size, storagePath, createdAt: Date.now(), metaJson,
    });

    logger.info({ id, filename, channelId, sizeBytes: file.size }, 'artifact uploaded');

    res.status(201).json({
      id, filename, mimeType, sizeBytes: file.size,
      downloadUrl: `/api/networks/${networkId}/artifacts/${id}/download`,
    });
  });

  app.get('/api/networks/:networkId/artifacts/:id/download', auth, (req: Request<{ networkId: string; id: string }>, res: Response) => {
    const { networkId, id } = req.params;
    if (!validateNetworkId(networkId)) return res.status(400).json({ error: 'invalid networkId' });
    const space = storageManager.getSpace(networkId);
    const row = space.artifacts.get(id);
    if (!row) return res.status(404).json({ error: 'not found' });
    const absPath = join(space.artifactDir, row.storagePath);
    if (!existsSync(absPath)) return res.status(404).json({ error: 'file missing' });
    res.setHeader('Content-Type', row.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${row.filename}"`);
    res.sendFile(absPath);
  });

  app.get('/api/networks/:networkId/artifacts/:id/preview', auth, (req: Request<{ networkId: string; id: string }>, res: Response) => {
    const { networkId, id } = req.params;
    if (!validateNetworkId(networkId)) return res.status(400).json({ error: 'invalid networkId' });
    const space = storageManager.getSpace(networkId);
    const row = space.artifacts.get(id);
    if (!row) return res.status(404).json({ error: 'not found' });
    const absPath = join(space.artifactDir, row.storagePath);
    if (!existsSync(absPath)) return res.status(404).json({ error: 'file missing' });
    res.setHeader('Content-Type', row.mimeType);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(absPath);
  });
}
