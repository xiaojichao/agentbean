import type { ID, UnixMs } from './common';
import type { TeamMemberRole } from './auth';

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
