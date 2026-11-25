import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Environment for the .NET e2e tests, inherited by the commands they run. `dotnet test` keeps its
 * session artifacts in a private directory under `/run/user/<uid>` and warns ("The test session
 * artifacts were not saved") on containers that have none; `VSTEST_ARTIFACTS_BASE_DIRECTORY` names
 * another base directory. The .NET CLI and test platform telemetry are turned off.
 */
export function prepareDotnetEnv(): void {
  process.env.VSTEST_ARTIFACTS_BASE_DIRECTORY ??= mkdtempSync(path.join(os.tmpdir(), 'coverage-tools-vstest-'));
  process.env.DOTNET_CLI_TELEMETRY_OPTOUT = '1';
  process.env.TESTINGPLATFORM_TELEMETRY_OPTOUT = '1';
  process.env.DOTNET_NOLOGO = '1';
}
