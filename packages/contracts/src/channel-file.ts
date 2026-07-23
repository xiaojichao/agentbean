import type { ID, UnixMs } from './common.js';
import type { ArtifactDto, ArtifactRole } from './artifact.js';

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
  logicalPath?: string;
  role?: ArtifactRole;
}

export interface ListChannelFilesInput {
  userId: ID;
  teamId: ID;
  channelId: ID;
  path?: string;
  role?: ArtifactRole | 'all';
  cursor?: string;
  pageSize?: number;
}

export interface SearchChannelFilesInput extends ListChannelFilesInput {
  query: string;
}

export interface ChannelFilesResultDto {
  files: ChannelFileEntryDto[];
  directories?: ChannelFileDirectoryDto[];
  path?: string;
  nextCursor?: string;
}

export interface ChannelFileDirectoryDto {
  path: string;
  name: string;
  fileCount: number;
  updatedAt: UnixMs;
  sourceRoot?: ArtifactDto['sourceRoot'];
}
