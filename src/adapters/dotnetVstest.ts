import path from 'node:path';
import {
  fullyQualifiedNameFilter, isTestSourceFile, NO_TEST_CLASSES_HINT, readProjectFacts, testTypesOf, type ProjectFacts,
} from './dotnetShared';
import type { Adapter, FsReader, PlanContext, Project, RunPlan, RunTarget } from './types';

const HINT = 'No coverage report was produced. Check that the test project builds and that its tests run with "dotnet test".';

/**
 * The `dotnet test` arguments that make the project write a Cobertura report into `tmpDir`: the
 * collector the setting names, else coverlet's collector or its MSBuild integration when the project
 * references one, else Microsoft's collector, which comes with Microsoft.NET.Test.Sdk. Each argument
 * is one argv element, without quotes (no shell is involved).
 */
function collectionArgs(facts: ProjectFacts, setting: string, tmpDir: string): string[] {
  const forced = setting.trim().replace(/^"(.*)"$/, '$1').trim();
  if (forced !== '') return [`--collect:${forced}`];
  if (facts.packages.has('coverlet.collector')) return ['--collect:XPlat Code Coverage'];
  if (facts.packages.has('coverlet.msbuild')) {
    // A forward slash, not path.sep: a trailing backslash would escape the closing quote on Windows.
    return ['/p:CollectCoverage=true', '/p:CoverletOutputFormat=cobertura', `/p:CoverletOutput=${tmpDir}/`];
  }
  return ['--collect:Code Coverage;Format=cobertura'];
}

export const dotnetVstestAdapter: Adapter = {
  id: 'dotnet-vstest',
  ecosystem: 'dotnet',

  async detect(candidate: string, fs: FsReader): Promise<Project | undefined> {
    if (!candidate.toLowerCase().endsWith('.csproj')) return undefined;
    const facts = await readProjectFacts(candidate, fs);
    if (!facts.isTest || facts.usesMtp) return undefined;
    return {
      key: `project:${candidate}`,
      adapter: 'dotnet-vstest',
      ecosystem: 'dotnet',
      dir: path.dirname(candidate),
      definingFile: candidate,
      name: path.basename(candidate, path.extname(candidate)),
      supportsPartial: true,
      meta: { facts },
    };
  },

  async isTestFile(project: Project, file: string, fs: FsReader): Promise<boolean> {
    return isTestSourceFile(project.dir, file, fs);
  },

  async plan(project: Project, target: RunTarget, ctx: PlanContext): Promise<RunPlan> {
    const csproj = project.definingFile ?? project.dir;
    const facts = (project.meta.facts as ProjectFacts | undefined) ?? (await readProjectFacts(csproj, ctx.fs));
    const filter: string[] = [];
    if (target.kind === 'partial') {
      const types = await testTypesOf(target.paths, ctx.settings.exclude, ctx.fs);
      if (types.length === 0) return { steps: [], reportSearchDir: ctx.tmpDir, hint: NO_TEST_CLASSES_HINT };
      filter.push('--filter', fullyQualifiedNameFilter(types));
    }
    const args = [
      'test', csproj,
      ...collectionArgs(facts, ctx.settings.dotnetCollector, ctx.tmpDir),
      '--results-directory', ctx.tmpDir,
      ...filter,
      ...ctx.settings.dotnetExtraArgs,
    ];
    return { steps: [{ command: 'dotnet', args, cwd: project.dir }], reportSearchDir: ctx.tmpDir, hint: HINT };
  },
};
