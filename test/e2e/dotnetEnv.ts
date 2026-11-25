import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

const VARIABLES = ['VSTEST_ARTIFACTS_BASE_DIRECTORY', 'DOTNET_CLI_TELEMETRY_OPTOUT', 'TESTINGPLATFORM_TELEMETRY_OPTOUT', 'DOTNET_NOLOGO'];

/**
 * Environment for the .NET e2e tests of the calling file, inherited by the commands they run, and
 * restored after its tests. `dotnet test` keeps its session artifacts in a private directory under
 * `/run/user/<uid>` and warns ("The test session artifacts were not saved") on containers that have
 * none; `VSTEST_ARTIFACTS_BASE_DIRECTORY` names a temp directory instead, removed afterwards. The
 * .NET CLI and test platform telemetry are turned off.
 */
export function prepareDotnetEnv(): void {
  const saved = new Map(VARIABLES.map(name => [name, process.env[name]]));
  const artifacts = mkdtempSync(path.join(os.tmpdir(), 'coverage-tools-vstest-'));
  process.env.VSTEST_ARTIFACTS_BASE_DIRECTORY = artifacts;
  process.env.DOTNET_CLI_TELEMETRY_OPTOUT = '1';
  process.env.TESTINGPLATFORM_TELEMETRY_OPTOUT = '1';
  process.env.DOTNET_NOLOGO = '1';
  afterAll(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(artifacts, { recursive: true, force: true });
  });
}
