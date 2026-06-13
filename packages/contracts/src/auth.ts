import type { ID } from './common.js';

export type UserRole = 'user' | 'admin';
export type TeamMemberRole = 'owner' | 'admin' | 'member';

export interface UserDto {
  id: ID;
  username: string;
  role: UserRole;
  displayName?: string;
  avatarUrl?: string;
  primaryTeamId?: ID;
  email?: string | null;
}

export interface HumanMemberDto {
  id: ID;
  teamId: ID;
  userId: ID;
  username: string;
  role: TeamMemberRole;
  displayName?: string;
  avatarUrl?: string;
}
