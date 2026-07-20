import type {
  PiProviderConfigDto,
  PiProviderPreset,
  PiProviderRevisionStatus,
  PiProviderTestStatus,
} from '../../../../../packages/contracts/src/index.js';
import type {
  PiProviderCardRecord,
  PiProviderCardRevisionRecord,
  PiProviderCredentialRecord,
  PiProviderRepositories,
  PiProviderRevisionTestRecord,
  PiProviderUnitOfWork,
} from '../../application/pi-provider-repositories.js';
import { serializeTransactions } from '../../application/transaction-serialization.js';
import type { SqliteDatabase } from './repositories.js';

function sqliteText(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : String(value ?? '');
}

function sqliteInt(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function sqliteNullableInt(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : Number(value);
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
    displayName: sqliteText(row, 'display_name'),
    notes: sqliteNullableText(row, 'notes'),
    consoleUrl: sqliteNullableText(row, 'console_url'),
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
  let modelCandidates: string[] = [];
  try {
    const parsed = JSON.parse(sqliteText(row, 'model_candidates_json') || '[]') as unknown;
    if (Array.isArray(parsed)) {
      modelCandidates = parsed.filter((item): item is string => typeof item === 'string');
    }
  } catch {
    modelCandidates = [];
  }
  return {
    id: sqliteText(row, 'id'),
    preset: sqliteText(row, 'preset') as PiProviderPreset,
    credentialRef: sqliteText(row, 'credential_ref'),
    draftRevisionId: sqliteNullableText(row, 'draft_revision_id'),
    publishedRevisionId: sqliteNullableText(row, 'published_revision_id'),
    modelCandidates,
    modelCandidatesUpdatedAt: sqliteNullableInt(row, 'model_candidates_updated_at'),
    createdBy: sqliteText(row, 'created_by'),
    createdAt: sqliteInt(row, 'created_at'),
    updatedAt: sqliteInt(row, 'updated_at'),
  };
}

function mapTest(row: Record<string, unknown>): PiProviderRevisionTestRecord {
  return {
    id: sqliteText(row, 'id'),
    cardId: sqliteText(row, 'card_id'),
    draftRevisionId: sqliteText(row, 'draft_revision_id'),
    configSummary: sqliteText(row, 'config_summary'),
    status: sqliteText(row, 'status') as PiProviderTestStatus,
    textOk: sqliteInt(row, 'text_ok') === 1,
    toolCallOk: sqliteInt(row, 'tool_call_ok') === 1,
    responseModel: sqliteNullableText(row, 'response_model'),
    finishReasonText: sqliteNullableText(row, 'finish_reason_text'),
    finishReasonTool: sqliteNullableText(row, 'finish_reason_tool'),
    usageInputTokens: sqliteNullableInt(row, 'usage_input_tokens'),
    usageOutputTokens: sqliteNullableInt(row, 'usage_output_tokens'),
    durationMs: sqliteInt(row, 'duration_ms'),
    diagnosticCode: sqliteNullableText(row, 'diagnostic_code'),
    testedBy: sqliteText(row, 'tested_by'),
    testedAt: sqliteInt(row, 'tested_at'),
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
            id, card_id, status, display_name, notes, console_url, protocol, base_url, endpoint_mode, model_id,
            timeout_ms, max_output_tokens, compatibility_params_json, created_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.id,
          input.cardId,
          input.status,
          input.displayName,
          input.notes,
          input.consoleUrl,
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
            id, preset, credential_ref, draft_revision_id, published_revision_id,
            model_candidates_json, model_candidates_updated_at, created_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.id,
          input.preset,
          input.credentialRef,
          input.draftRevisionId,
          input.publishedRevisionId,
          JSON.stringify(input.modelCandidates ?? []),
          input.modelCandidatesUpdatedAt,
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
          SET draft_revision_id = ?, published_revision_id = ?,
              model_candidates_json = ?, model_candidates_updated_at = ?, updated_at = ?
          WHERE id = ?
        `).run(
          input.draftRevisionId,
          input.publishedRevisionId,
          JSON.stringify(input.modelCandidates ?? []),
          input.modelCandidatesUpdatedAt,
          input.updatedAt,
          input.id,
        );
        return input;
      },
    },
    tests: {
      async create(input) {
        db.prepare(`
          INSERT INTO pi_provider_revision_tests (
            id, card_id, draft_revision_id, config_summary, status, text_ok, tool_call_ok,
            response_model, finish_reason_text, finish_reason_tool,
            usage_input_tokens, usage_output_tokens, duration_ms, diagnostic_code, tested_by, tested_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.id,
          input.cardId,
          input.draftRevisionId,
          input.configSummary,
          input.status,
          input.textOk ? 1 : 0,
          input.toolCallOk ? 1 : 0,
          input.responseModel,
          input.finishReasonText,
          input.finishReasonTool,
          input.usageInputTokens,
          input.usageOutputTokens,
          input.durationMs,
          input.diagnosticCode,
          input.testedBy,
          input.testedAt,
        );
        return input;
      },
      async getLatestByCard(cardId) {
        const row = db.prepare(
          'SELECT * FROM pi_provider_revision_tests WHERE card_id = ? ORDER BY tested_at DESC LIMIT 1',
        ).get(cardId) as Record<string, unknown> | undefined;
        return row ? mapTest(row) : null;
      },
    },
  };
}

export function createSqlitePiProviderPersistence(db: SqliteDatabase): {
  repositories: PiProviderRepositories;
  unitOfWork: PiProviderUnitOfWork;
} {
  const repositories = createSqlitePiProviderRepositories(db);
  const runTransaction = serializeTransactions<PiProviderRepositories>(async (operation) => {
    db.exec('BEGIN IMMEDIATE;');
    try {
      const result = await operation(repositories);
      db.exec('COMMIT;');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch { /* preserve original */ }
      throw error;
    }
  });
  return {
    repositories,
    unitOfWork: { run: runTransaction },
  };
}
