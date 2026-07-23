import type { ID, UnixMs } from './common.js';
import type { ArtifactDto } from './artifact.js';
import type { MessageDto } from './message.js';

export type ChannelDocumentRevisionSource = 'attachment' | 'run' | 'edit' | 'restore';

export interface ChannelDocumentPublicationDto {
  id: ID;
  messageId: ID;
  publishedBy: ID;
  publishedAt: UnixMs;
}

export interface ChannelDocumentRevisionDto {
  id: ID;
  documentId: ID;
  artifact: ArtifactDto;
  revision: number;
  createdBy: ID;
  createdAt: UnixMs;
  source: ChannelDocumentRevisionSource;
  restoredFromRevisionId?: ID;
  published: boolean;
  publication?: ChannelDocumentPublicationDto;
}

export interface ChannelDocumentDto {
  id: ID;
  teamId: ID;
  channelId: ID;
  filename: string;
  currentRevisionId: ID;
  currentRevision: ChannelDocumentRevisionDto;
  createdAt: UnixMs;
  updatedAt: UnixMs;
}

export interface ListChannelDocumentsInput {
  userId: ID;
  teamId: ID;
  channelId: ID;
}

export interface GetChannelDocumentInput extends ListChannelDocumentsInput {
  documentId: ID;
}

export interface ListChannelDocumentRevisionsInput extends GetChannelDocumentInput {}

export interface SaveChannelDocumentInput extends GetChannelDocumentInput {
  baseRevisionId: ID;
  content: string;
  filename?: string;
  idempotencyKey?: string;
}

export interface RestoreChannelDocumentInput extends GetChannelDocumentInput {
  revisionId: ID;
  baseRevisionId: ID;
  idempotencyKey: string;
}

export interface PublishChannelDocumentInput extends SaveChannelDocumentInput {}

export interface PublishChannelDocumentResultDto extends ChannelDocumentResultDto {
  message: MessageDto;
}

export interface ChannelDocumentResultDto {
  document: ChannelDocumentDto;
}

export interface ChannelDocumentRevisionsResultDto {
  document: ChannelDocumentDto;
  revisions: ChannelDocumentRevisionDto[];
}
