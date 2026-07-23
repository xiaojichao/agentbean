import type { ID, UnixMs } from './common.js';
import type { ArtifactDto } from './artifact.js';

export interface ChannelFileSourceDto {
  messageId: ID;
  threadId?: ID;
  senderKind: 'human' | 'agent' | 'system';
  senderId: ID | null;
  messageCreatedAt: UnixMs;
}

export interface ChannelFileEntryDto {
  artifact: ArtifactDto;
  source: ChannelFileSourceDto;
}

export interface ListChannelFilesInput {
  userId: ID;
  teamId: ID;
  channelId: ID;
  cursor?: string;
  pageSize?: number;
}

export interface SearchChannelFilesInput extends ListChannelFilesInput {
  query: string;
}

export interface ChannelFilesResultDto {
  files: ChannelFileEntryDto[];
  nextCursor?: string;
}
