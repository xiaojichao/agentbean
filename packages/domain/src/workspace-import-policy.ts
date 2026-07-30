/**
 * #964 Project Channel Workspace import policy.
 *
 * Pure functions for validating workspace file paths and import manifests.
 * These ensure imported paths are safe relative paths without absolute-path
 * leakage or traversal attempts — regardless of which device performed the import.
 */

/**
 * Validate and normalize a single workspace file path.
 *
 * Rejects absolute paths, Windows drive letters, path traversal, and control characters.
 * Returns null when the path fails validation.
 */
export function normalizeWorkspacePath(value: string): string | null {
  const path = value.trim().replaceAll('\\', '/');
  if (
    !path ||
    path.startsWith('/') ||
    /^[a-zA-Z]:/.test(path) ||
    /[\x00-\x1F\x7F]/.test(path) ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    return null;
  }
  return path;
}

export type ValidateWorkspaceImportFilesOutput =
  | { readonly ok: true; readonly value: { readonly files: ReadonlyArray<{ readonly path: string; readonly artifactId: string }> } }
  | { readonly ok: false; readonly error: 'EMPTY_FILES' | 'INVALID_PATH' | 'DUPLICATE_PATH' };

/** Validate a list of file entries for a workspace import. */
export function validateWorkspaceImportFiles(
  entries: ReadonlyArray<{ readonly path: string; readonly artifactId: string }>,
): ValidateWorkspaceImportFilesOutput {
  if (entries.length === 0) return { ok: false, error: 'EMPTY_FILES' };
  const seen = new Set<string>();
  const files: Array<{ path: string; artifactId: string }> = [];
  for (const entry of entries) {
    const path = normalizeWorkspacePath(entry.path);
    if (!path) return { ok: false, error: 'INVALID_PATH' };
    if (seen.has(path)) return { ok: false, error: 'DUPLICATE_PATH' };
    seen.add(path);
    files.push({ path, artifactId: entry.artifactId });
  }
  return { ok: true, value: { files } };
}
