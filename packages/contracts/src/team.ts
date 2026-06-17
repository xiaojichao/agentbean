import type { ID, UnixMs } from './common.js';
import type { TeamMemberRole } from './auth.js';

export type TeamVisibility = 'private' | 'public';

export interface TeamDto {
  id: ID;
  name: string;
  path: string;
  visibility: TeamVisibility;
  ownerId: ID;
  currentUserRole: TeamMemberRole;
  createdAt: UnixMs;
  updatedAt?: UnixMs;
}

export interface ListTeamsAckDto {
  currentTeamId?: ID;
  teams: TeamDto[];
}

export interface CreateTeamCommandDto {
  userId: ID;
  name: string;
}

export interface CreateTeamAckDto {
  team: TeamDto;
  defaultChannel: {
    id: ID;
    teamId: ID;
    kind: 'channel';
    name: 'all';
    visibility: 'public';
    createdBy?: ID;
    createdAt: UnixMs;
    updatedAt?: UnixMs;
  };
}

export interface SwitchTeamCommandDto {
  userId: ID;
  teamId: ID;
}

export interface SwitchTeamAckDto {
  currentTeam: TeamDto;
}

export interface JoinLinkDto {
  id: ID;
  code: string;
  teamId: ID;
  createdBy: ID;
  createdAt: UnixMs;
  expiresAt?: UnixMs;
  maxUses?: number;
  usesCount: number;
  revokedAt?: UnixMs;
}

export interface CreateJoinLinkCommandDto {
  userId: ID;
  teamId: ID;
  expiresAt?: UnixMs;
  maxUses?: number;
}

export interface ValidateJoinLinkCommandDto {
  code: string;
}

export interface JoinLinkAckDto {
  link: JoinLinkDto;
  team: TeamDto;
}

export interface ListJoinLinksCommandDto {
  userId: ID;
  teamId: ID;
}

export interface RevokeJoinLinkCommandDto {
  userId: ID;
  teamId: ID;
  code: string;
}

export interface ListJoinLinksAckDto {
  links: JoinLinkDto[];
}

export interface RevokeJoinLinkAckDto {
  link: JoinLinkDto;
}
