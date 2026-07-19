import type {
  PiProviderCardDto,
  PiProviderCredentialRefDto,
  PiProviderCardRevisionDto,
} from '../../src/index.js';

const forbiddenCredentialCiphertext: PiProviderCredentialRefDto = {
  credentialRef: 'cred-1',
  configured: true,
  apiKeyCiphertext: 'must-not-compile',
};

const forbiddenEncryptedApiKey: PiProviderCredentialRefDto = {
  credentialRef: 'cred-1',
  configured: true,
  encryptedApiKey: 'must-not-compile',
};

const forbiddenSecretOnCard: PiProviderCardDto = {
  id: 'card-1',
  displayName: 'OpenAI',
  preset: 'openai',
  notes: null,
  consoleUrl: null,
  credential: { credentialRef: 'cred-1', configured: true },
  draftRevision: null,
  publishedRevision: null,
  modelCandidates: [],
  modelCandidatesUpdatedAt: null,
  latestTest: null,
  canPublish: false,
  createdBy: 'admin-1',
  createdAt: 1,
  updatedAt: 1,
  secret: 'must-not-compile',
};

const forbiddenTeamProviderCard: PiProviderCardDto = {
  id: 'card-1',
  displayName: 'OpenAI',
  preset: 'openai',
  notes: null,
  consoleUrl: null,
  credential: { credentialRef: 'cred-1', configured: true },
  draftRevision: null,
  publishedRevision: null,
  modelCandidates: [],
  modelCandidatesUpdatedAt: null,
  latestTest: null,
  canPublish: false,
  createdBy: 'admin-1',
  createdAt: 1,
  updatedAt: 1,
  teamProviderCard: true,
};

const forbiddenRevisionSecret: PiProviderCardRevisionDto = {
  id: 'rev-1',
  cardId: 'card-1',
  status: 'draft',
  displayName: 'OpenAI',
  notes: null,
  consoleUrl: null,
  config: {
    protocol: 'openai_chat_completions',
    baseUrl: 'https://api.openai.com/v1',
    endpointMode: 'chat_completions',
    modelId: 'gpt-4.1-mini',
    timeoutMs: 60_000,
    maxOutputTokens: 4096,
    compatibilityParams: {},
  },
  createdBy: 'admin-1',
  createdAt: 1,
  secret: 'must-not-compile',
};

void forbiddenCredentialCiphertext;
void forbiddenEncryptedApiKey;
void forbiddenSecretOnCard;
void forbiddenTeamProviderCard;
void forbiddenRevisionSecret;
