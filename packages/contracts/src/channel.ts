import type { ID, UnixMs } from './common';

export type ChannelKind = 'channel' | 'direct';
export type ChannelVisibility = 'public' | 'private';

export interface ChannelDto {
  id: ID;
  teamId: ID;
  kind: ChannelKind;
  name: string;
  visibility: ChannelVisibility;
  title?: string;
  createdBy?: ID;
  createdAt: UnixMs;
  updatedAt?: UnixMs;
}
