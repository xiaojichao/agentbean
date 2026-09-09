import React from 'react';
import type { ProjectArtifactLibraryDto, ProjectReferenceSelectionRequestDto } from '@agentbean/contracts';

/** 部分包引用逐个展示已冻结的文件版本；外层移除动作仍移除这一组选择。 */
export function PackageMemberReferenceLabels({ selection, library }: {
  selection: Extract<ProjectReferenceSelectionRequestDto, { kind: 'package_members' }>;
  library?: ProjectArtifactLibraryDto | null;
}) {
  return <span className="inline-flex flex-wrap gap-1">
    {selection.members.map((member) => {
      const collection = library?.collections.find((entry) => entry.id === member.collectionId);
      const version = collection?.versions.find((entry) => entry.id === member.versionId);
      return <span key={`${member.collectionId}:${member.versionId}`} className="rounded border border-sky-200 bg-white px-1.5 py-0.5" title={member.versionId}>
        {version ? `${version.artifact.filename} · v${version.versionNumber}` : `${collection?.name ?? '文件'} · ${member.versionId}`}
      </span>;
    })}
  </span>;
}
