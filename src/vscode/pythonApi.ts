// Kept free of the `vscode` import so that it can be unit-tested; see pythonExtension.ts for the wiring.

export const PYTHON_EXTENSION_ID = 'ms-python.python';

/** The part of `vscode.extensions` used here. */
export interface ExtensionsLike {
  getExtension(id: string): { readonly isActive: boolean; readonly exports: unknown } | undefined;
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

/**
 * The interpreter the Microsoft Python extension selected for `resource`, read through its API
 * (`environments.getActiveEnvironmentPath(resource).path`). Only when that extension is installed
 * and already active: it is never activated from here. Anything unexpected means "no selection".
 */
export function pythonExtensionSelection(extensions: ExtensionsLike, resource: unknown): string | undefined {
  try {
    const ext = extensions.getExtension(PYTHON_EXTENSION_ID);
    if (!ext?.isActive) return undefined;
    const environments = field(ext.exports, 'environments');
    const getActive = field(environments, 'getActiveEnvironmentPath');
    if (typeof getActive !== 'function') return undefined;
    const selected = field(getActive.call(environments, resource), 'path');
    return typeof selected === 'string' && selected !== '' ? selected : undefined;
  } catch {
    return undefined;
  }
}
