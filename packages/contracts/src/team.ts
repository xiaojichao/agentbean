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
