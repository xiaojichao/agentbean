import type { ID, UnixMs } from './common.js';
import type { ArtifactDto } from './artifact.js';

export interface ChannelDocumentRevisionDto {
  id: ID;
  documentId: ID;
  artifact: ArtifactDto;
  revision: number;
  createdBy: ID;
  createdAt: UnixMs;
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
}

export interface ChannelDocumentResultDto {
  document: ChannelDocumentDto;
}

export interface ChannelDocumentRevisionsResultDto {
  document: ChannelDocumentDto;
  revisions: ChannelDocumentRevisionDto[];
}
