import { dotnetMtpAdapter } from './dotnetMtp';
import { dotnetVstestAdapter } from './dotnetVstest';
import { jestAdapter } from './jest';
import { nodeGenericAdapter } from './nodeGeneric';
import { pythonAdapter } from './python';
import type { Adapter } from './types';
import { vitestAdapter } from './vitest';

/**
 * The adapters discovery tries, in order: within one Node directory the first that recognizes it
 * wins (after any custom command), and the .NET ones are mutually exclusive. The custom adapter is
 * not listed: its projects come from the `coverageTools.commands` setting (see `customAdapter`).
 */
export const ADAPTERS: readonly Adapter[] = Object.freeze([
  jestAdapter,
  vitestAdapter,
  nodeGenericAdapter,
  pythonAdapter,
  dotnetVstestAdapter,
  dotnetMtpAdapter,
]);
