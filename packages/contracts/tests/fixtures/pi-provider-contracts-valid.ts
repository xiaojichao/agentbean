import type {
  CopyPiProviderCardInput,
  CreatePiProviderCardInput,
  ListPiProviderCardsResult,
  ListPiProviderPresetsResult,
  PiProviderCardDto,
  UpdatePiProviderCardInput,
} from '../../src/index.js';

export const createInput: CreatePiProviderCardInput = {
  preset: 'openai',
  displayName: 'OpenAI',
  baseUrl: 'https://api.openai.com/v1',
  endpointMode: 'chat_completions',
  modelId: 'gpt-4.1-mini',
  timeoutMs: 60_000,
  maxOutputTokens: 4096,
  apiKey: 'sk-test',
};

export const revisionShape = {
  id: 'rev-1',
  cardId: 'card-1',
  status: 'draft' as const,
  displayName: 'OpenAI',
  notes: null as string | null,
  consoleUrl: null as string | null,
  config: createInput && {
    protocol: 'openai_chat_completions' as const,
    baseUrl: 'https://api.openai.com/v1',
    endpointMode: 'chat_completions' as const,
    modelId: 'gpt-4.1-mini',
    timeoutMs: 60_000,
    maxOutputTokens: 4096,
    compatibilityParams: {},
  },
  createdBy: 'admin-1',
  createdAt: 1,
};

export const updateInput: UpdatePiProviderCardInput = {
  cardId: 'card-1',
  displayName: 'OpenAI',
  baseUrl: 'https://api.openai.com/v1',
  endpointMode: 'chat_completions',
  modelId: 'gpt-4.1-mini',
  timeoutMs: 60_000,
  maxOutputTokens: 4096,
};

export const copyInput: CopyPiProviderCardInput = {
  sourceCardId: 'card-1',
  displayName: 'OpenAI copy',
};

export const listResult: ListPiProviderCardsResult = {
  cards: [] as PiProviderCardDto[],
};

export const presetResult: ListPiProviderPresetsResult = {
  presets: [],
};
