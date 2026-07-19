import type {
  PiProviderConfigDto,
  PiProviderPreset,
  PiProviderRevisionStatus,
} from '../../../../../packages/contracts/src/index.js';
import type {
  PiProviderCardRecord,
  PiProviderCardRevisionRecord,
  PiProviderCredentialRecord,
  PiProviderRepositories,
} from '../../application/pi-provider-repositories.js';
import type { SqliteDatabase } from './repositories.js';

function sqliteText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : String(value ?? '');
}

function sqliteInt(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function sqliteNullableText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : String(value);
}

function mapCredential(row: Record<string, unknown>): PiProviderCredentialRecord {
  return {
    id: sqliteText(row, 'id'),
    keyVersion: sqliteInt(row, 'key_version'),
    encryptedPayload: sqliteText(row, 'encrypted_payload'),
    fingerprint: sqliteText(row, 'fingerprint'),
    createdAt: sqliteInt(row, 'created_at'),
    updatedAt: sqliteInt(row, 'updated_at'),
  };
}

function mapRevision(row: Record<string, unknown>): PiProviderCardRevisionRecord {
  let compatibilityParams: PiProviderConfigDto['compatibilityParams'] = {};
  try {
    const parsed = JSON.parse(sqliteText(row, 'compatibility_params_json')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed as object).length === 0) {
      compatibilityParams = {};
    }
  } catch {
    compatibilityParams = {};
  }
  return {
    id: sqliteText(row, 'id'),
    cardId: sqliteText(row, 'card_id'),
    status: sqliteText(row, 'status') as PiProviderRevisionStatus,
    config: {
      protocol: 'openai_chat_completions',
      baseUrl: sqliteText(row, 'base_url'),
      endpointMode: 'chat_completions',
      modelId: sqliteText(row, 'model_id'),
      timeoutMs: sqliteInt(row, 'timeout_ms'),
      maxOutputTokens: sqliteInt(row, 'max_output_tokens'),
      compatibilityParams,
    },
    createdBy: sqliteText(row, 'created_by'),
    createdAt: sqliteInt(row, 'created_at'),
  };
}

function mapCard(row: Record<string, unknown>): PiProviderCardRecord {
  return {
    id: sqliteText(row, 'id'),
    displayName: sqliteText(row, 'display_name'),
    preset: sqliteText(row, 'preset') as PiProviderPreset,
    notes: sqliteNullableText(row, 'notes'),
    consoleUrl: sqliteNullableText(row, 'console_url'),
    credentialRef: sqliteText(row, 'credential_ref'),
    draftRevisionId: sqliteNullableText(row, 'draft_revision_id'),
    publishedRevisionId: sqliteNullableText(row, 'published_revision_id'),
    createdBy: sqliteText(row, 'created_by'),
    createdAt: sqliteInt(row, 'created_at'),
    updatedAt: sqliteInt(row, 'updated_at'),
  };
}

export function createSqlitePiProviderRepositories(db: SqliteDatabase): PiProviderRepositories {
  return {
    credentials: {
      async create(input) {
        db.prepare(`
          INSERT INTO pi_provider_credentials (id, key_version, encrypted_payload, fingerprint, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(input.id, input.keyVersion, input.encryptedPayload, input.fingerprint, input.createdAt, input.updatedAt);
        return input;
      },
      async getById(id) {
        const row = db.prepare('SELECT * FROM pi_provider_credentials WHERE id = ?').get(id) as Record<string, unknown> | undefined;
        return row ? mapCredential(row) : null;
      },
      async update(input) {
        db.prepare(`
          UPDATE pi_provider_credentials
          SET key_version = ?, encrypted_payload = ?, fingerprint = ?, updated_at = ?
          WHERE id = ?
        `).run(input.keyVersion, input.encryptedPayload, input.fingerprint, input.updatedAt, input.id);
        return input;
      },
    },
    revisions: {
      async create(input) {
        db.prepare(`
          INSERT INTO pi_provider_card_revisions (
            id, card_id, status, protocol, base_url, endpoint_mode, model_id,
            timeout_ms, max_output_tokens, compatibility_params_json, created_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.id,
          input.cardId,
          input.status,
          input.config.protocol,
          input.config.baseUrl,
          input.config.endpointMode,
          input.config.modelId,
          input.config.timeoutMs,
          input.config.maxOutputTokens,
          JSON.stringify(input.config.compatibilityParams ?? {}),
          input.createdBy,
          input.createdAt,
        );
        return input;
      },
      async getById(id) {
        const row = db.prepare('SELECT * FROM pi_provider_card_revisions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
        return row ? mapRevision(row) : null;
      },
      async listByCard(cardId) {
        const rows = db.prepare(
          'SELECT * FROM pi_provider_card_revisions WHERE card_id = ? ORDER BY created_at DESC',
        ).all(cardId) as Record<string, unknown>[];
        return rows.map(mapRevision);
      },
    },
    cards: {
      async create(input) {
        db.prepare(`
          INSERT INTO pi_provider_cards (
            id, display_name, preset, notes, console_url, credential_ref,
            draft_revision_id, published_revision_id, created_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.id,
          input.displayName,
          input.preset,
          input.notes,
          input.consoleUrl,
          input.credentialRef,
          input.draftRevisionId,
          input.publishedRevisionId,
          input.createdBy,
          input.createdAt,
          input.updatedAt,
        );
        return input;
      },
      async getById(id) {
        const row = db.prepare('SELECT * FROM pi_provider_cards WHERE id = ?').get(id) as Record<string, unknown> | undefined;
        return row ? mapCard(row) : null;
      },
      async list() {
        const rows = db.prepare('SELECT * FROM pi_provider_cards ORDER BY updated_at DESC').all() as Record<string, unknown>[];
        return rows.map(mapCard);
      },
      async update(input) {
        db.prepare(`
          UPDATE pi_provider_cards
          SET display_name = ?, notes = ?, console_url = ?, draft_revision_id = ?,
              published_revision_id = ?, updated_at = ?
          WHERE id = ?
        `).run(
          input.displayName,
          input.notes,
          input.consoleUrl,
          input.draftRevisionId,
          input.publishedRevisionId,
          input.updatedAt,
          input.id,
        );
        return input;
      },
    },
  };
}
