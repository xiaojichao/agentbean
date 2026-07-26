'use client';

import type { ProjectReferenceSelectionRequestDto } from '@agentbean/contracts';

export function ProjectDocumentReferenceButton({
  documentId,
  revisionId,
  selected,
  disabled = false,
  onChange,
}: {
  documentId: string;
  revisionId: string;
  selected: boolean;
  disabled?: boolean;
  onChange: (selection: ProjectReferenceSelectionRequestDto | null) => void;
}) {
  return (
    <button
      type="button"
      data-smoke="project-reference-document"
      aria-pressed={selected}
      disabled={disabled}
      onClick={() => onChange(selected
        ? null
        : {
          kind: 'document',
          documentId,
          expectedRevisionId: revisionId,
        })}
      className={`shrink-0 border px-2 py-1 text-[10px] font-medium disabled:opacity-40 ${selected
        ? 'border-sky-500 bg-sky-50 text-sky-800'
        : 'border-neutral-300 bg-white text-neutral-600 hover:border-neutral-900'}`}
    >
      {selected ? '已引用' : '引用文档'}
    </button>
  );
}
