import type { Express, Request, Response, NextFunction } from 'express';
import type multer from 'multer';
import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
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
  '.md': 'text/markdown', '.markdown': 'text/markdown',
};

function guessMime(filename: string): string {
  const ext = filename.toLowerCase().replace(/^.*\./, '.');
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

interface FileMoveOps {
  renameSync(source: string, dest: string): void;
  copyFileSync(source: string, dest: string): void;
  unlinkSync(source: string): void;
}

export function moveUploadedFile(source: string, dest: string, ops: FileMoveOps = { renameSync, copyFileSync, unlinkSync }): void {
  try {
    ops.renameSync(source, dest);
  } catch (err: any) {
    if (err?.code !== 'EXDEV') throw err;
    ops.copyFileSync(source, dest);
    ops.unlinkSync(source);
  }
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
    agents?: { listVisibleInNetwork(networkId: string): { id: string; name: string }[] };
  };
}

function validateNetworkId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

function parseMetaJson(raw?: string | null): Record<string, any> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function workspaceRunsForAgent(space: ReturnType<StorageManager['getSpace']>, networkId: string, agentId: string) {
  const rows = space.artifacts.listByUploader(agentId, 500);
  const runs = new Map<string, { runId: string; createdAt: number; updatedAt: number; files: any[] }>();

  for (const row of rows) {
    const meta = parseMetaJson(row.metaJson);
    if (meta.kind !== 'agent-workspace-file') continue;
    if (meta.teamId && meta.teamId !== networkId) continue;
    if (meta.agentId && meta.agentId !== agentId) continue;
    const runId = typeof meta.runId === 'string' && meta.runId.trim() ? meta.runId : 'unknown';
    const current = runs.get(runId) ?? { runId, createdAt: row.createdAt, updatedAt: row.createdAt, files: [] };
    current.createdAt = Math.min(current.createdAt, row.createdAt);
    current.updatedAt = Math.max(current.updatedAt, row.createdAt);
    current.files.push({
      id: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      createdAt: row.createdAt,
      pathKind: meta.pathKind ?? 'output',
      relativePath: meta.relativePath ?? row.filename,
      originalPath: meta.originalPath ?? null,
      sha256: meta.sha256 ?? null,
      deviceId: meta.deviceId ?? null,
      downloadUrl: `/api/networks/${networkId}/artifacts/${row.id}/download`,
      previewUrl: `/api/networks/${networkId}/artifacts/${row.id}/preview`,
    });
    runs.set(runId, current);
  }

  return [...runs.values()]
    .map((run) => ({ ...run, files: run.files.sort((a, b) => a.createdAt - b.createdAt) }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
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
      moveUploadedFile(file.path, destPath);
    } catch (err: any) {
      logger.error({ err: err.message }, 'artifact rename failed');
      return res.status(500).json({ error: 'storage error' });
    }

    const uploaderId = (req.body.uploaderId as string) ?? 'unknown';
    const metaJson = (req.body.metaJson as string) ?? null;

    const createdAt = Date.now();
    space.artifacts.create({
      id, messageId: null, uploaderId, filename, mimeType,
      sizeBytes: file.size, storagePath, createdAt, metaJson,
    });

    logger.info({ id, filename, channelId, sizeBytes: file.size }, 'artifact uploaded');

    res.status(201).json({
      id, filename, mimeType, sizeBytes: file.size, createdAt,
      downloadUrl: `/api/networks/${networkId}/artifacts/${id}/download`,
      previewUrl: `/api/networks/${networkId}/artifacts/${id}/preview`,
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

  app.get('/api/networks/:networkId/agents/:agentId/workspace', auth, (req: Request<{ networkId: string; agentId: string }>, res: Response) => {
    const { networkId, agentId } = req.params;
    if (!validateNetworkId(networkId)) return res.status(400).json({ error: 'invalid networkId' });
    const space = storageManager.getSpace(networkId);
    res.json({ ok: true, networkId, agentId, runs: workspaceRunsForAgent(space, networkId, agentId) });
  });

  app.get('/api/networks/:networkId/workspace', auth, (req: Request<{ networkId: string }>, res: Response) => {
    const { networkId } = req.params;
    if (!validateNetworkId(networkId)) return res.status(400).json({ error: 'invalid networkId' });
    const space = storageManager.getSpace(networkId);
    const agents = globalDb?.agents?.listVisibleInNetwork(networkId) ?? [];
    const payload = agents
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        runs: workspaceRunsForAgent(space, networkId, agent.id),
      }))
      .filter((agent) => agent.runs.length > 0);
    res.json({ ok: true, networkId, agents: payload });
  });
}
