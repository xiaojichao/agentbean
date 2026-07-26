'use client';

import { Snowflake } from 'lucide-react';
import type {
  ProjectReferenceSelectionSourceKind,
  ProjectReferenceSetDto,
} from '@agentbean/contracts';

const SOURCE_LABEL: Record<ProjectReferenceSelectionSourceKind, string> = {
  bundle_all: '整包',
  bundle_subset: '包内多选',
  document: '文档',
  artifact_version: '产物版本',
};

export function ProjectReferenceChips({ referenceSet }: { referenceSet: ProjectReferenceSetDto }) {
  return (
    <div data-smoke="project-reference-chips" className="mt-2 flex flex-wrap gap-1.5">
      {referenceSet.selections.flatMap((selection) =>
        selection.items.map((item) => (
          <span
            key={`${selection.id}:${item.kind}:${item.kind === 'document_revision' ? item.revisionId : item.versionId}`}
            className="inline-flex items-center gap-1 border border-sky-200 bg-sky-50 px-2 py-1 text-[11px] text-sky-800"
            title={`${SOURCE_LABEL[selection.sourceKind]} · 合同 v${referenceSet.contractVersion}`}
          >
            <Snowflake size={11} />
            <span className="font-medium">{item.filename}</span>
            <span className="text-sky-600">
              已冻结 v{item.kind === 'document_revision' ? item.revisionNumber : item.versionNumber}
            </span>
            <span className="border-l border-sky-200 pl-1 text-sky-500">
              {selection.bundle?.name ?? SOURCE_LABEL[selection.sourceKind]}
            </span>
          </span>
        )),
      )}
    </div>
  );
}
