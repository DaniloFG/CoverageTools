import path from 'node:path';
import {
  fullyQualifiedNameFilter, isTestSourceFile, NO_TEST_CLASSES_HINT, readProjectFacts, testTypesOf,
  type ProjectFacts, type TestType,
} from './dotnetShared';
import type { Adapter, FsReader, PlanContext, Project, RunPlan, RunTarget } from './types';

const HINT =
  'The test project did not write a coverage report. Microsoft.Testing.Platform projects need the "Microsoft.Testing.Extensions.CodeCoverage" package.';
const PARTIAL_HINT =
  'The test project did not write a coverage report. Either no test matched the selection, or the project lacks the "Microsoft.Testing.Extensions.CodeCoverage" package.';
const NO_PARTIAL_HINT = 'This test framework cannot run part of a project on Microsoft.Testing.Platform; run the whole project instead.';

const asType = (c: string | TestType): TestType => (typeof c === 'string' ? { name: c, generic: false } : c);

/** `Ns.Outer+Inner` → `['Ns', 'Outer+Inner']`; a class in the global namespace has namespace ''. */
function splitNamespace(name: string): [string, string] {
  const plus = name.indexOf('+');
  const dot = name.lastIndexOf('.', plus < 0 ? name.length : plus);
  return dot < 0 ? ['', name] : [name.slice(0, dot), name.slice(dot + 1)];
}

/** One segment of a tree-node filter that matches any of `values`. */
function anyOf(values: readonly string[]): string {
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : `(${unique.join('|')})`;
}

/**
 * The test application arguments that run only the tests of `classes` (qualified as `testTypesIn`
 * gives them), or undefined when the framework has no filter confirmed by real runs. MSTest and NUnit
 * take a VSTest filter expression; xUnit v3 one `--filter-class` per class (exact names); TUnit a
 * tree-node filter `/<assembly>/<namespace>/<class>/<test>`, whose segments can only be OR-ed one by
 * one, so classes of several namespaces also select same-named classes across those namespaces.
 */
export function mtpFilterArgs(
  framework: ProjectFacts['framework'],
  classes: ReadonlyArray<string | TestType>,
): string[] | undefined {
  const types = classes.map(asType);
  switch (framework) {
    case 'mstest':
    case 'nunit':
      return ['--filter', fullyQualifiedNameFilter(types)];
    case 'xunit3':
      return types.flatMap(t => ['--filter-class', t.name]);
    case 'tunit': {
      const parts = types.map(t => splitNamespace(t.name));
      // The global namespace has no segment a filter can name, only `*`, which covers every namespace.
      const namespaces = parts.some(([ns]) => ns === '') ? '*' : anyOf(parts.map(([ns]) => ns));
      // Generic classes are named without type arguments, as TUnit's tree does.
      return ['--treenode-filter', `/*/${namespaces}/${anyOf(parts.map(([, c]) => c))}/*`];
    }
    default:
      return undefined;
  }
}

export const dotnetMtpAdapter: Adapter = {
  id: 'dotnet-mtp',
  ecosystem: 'dotnet',

  async detect(candidate: string, fs: FsReader): Promise<Project | undefined> {
    if (!candidate.toLowerCase().endsWith('.csproj')) return undefined;
    const facts = await readProjectFacts(candidate, fs);
    if (!facts.isTest || !facts.usesMtp) return undefined;
    return {
      key: `project:${candidate}`,
      adapter: 'dotnet-mtp',
      ecosystem: 'dotnet',
      dir: path.dirname(candidate),
      definingFile: candidate,
      name: path.basename(candidate, path.extname(candidate)),
      supportsPartial: mtpFilterArgs(facts.framework, ['X']) !== undefined,
      meta: { facts },
    };
  },

  isTestFile(project: Project, file: string, fs: FsReader): Promise<boolean> {
    return isTestSourceFile(project.dir, file, fs);
  },

  /**
   * `dotnet run --project <csproj> --no-launch-profile [--framework <first target>] -- <coverage options>
   * [filter] [extra]`: the test project is an executable, so this works the same with every SDK and
   * `dotnet test` mode; `Properties/launchSettings.json` is not applied to coverage runs.
   * The report and every other result file go to the run's temp directory (`--results-directory`).
   */
  async plan(project: Project, target: RunTarget, ctx: PlanContext): Promise<RunPlan> {
    const csproj = project.definingFile ?? project.dir;
    const facts = (project.meta.facts as ProjectFacts | undefined) ?? (await readProjectFacts(csproj, ctx.fs));
    const filter: string[] = [];
    if (target.kind === 'partial') {
      if (mtpFilterArgs(facts.framework, ['X']) === undefined) return { steps: [], reportSearchDir: ctx.tmpDir, hint: NO_PARTIAL_HINT };
      const types = await testTypesOf(target.paths, ctx.settings.exclude, ctx.fs);
      if (types.length === 0) return { steps: [], reportSearchDir: ctx.tmpDir, hint: NO_TEST_CLASSES_HINT };
      filter.push(...(mtpFilterArgs(facts.framework, types) ?? []));
    }
    const framework = facts.targetFrameworks.length > 1 ? ['--framework', facts.targetFrameworks[0]] : [];
    const args = [
      'run', '--project', csproj, '--no-launch-profile', ...framework, '--',
      '--coverage', '--coverage-output-format', 'cobertura',
      '--coverage-output', path.join(ctx.tmpDir, 'coverage.cobertura.xml'),
      '--results-directory', ctx.tmpDir,
      ...filter,
      ...ctx.settings.dotnetExtraArgs,
    ];
    // A filter that matches no test makes the application exit with code 8 without writing a report.
    const hint = target.kind === 'partial' ? PARTIAL_HINT : HINT;
    return { steps: [{ command: 'dotnet', args, cwd: project.dir }], reportSearchDir: ctx.tmpDir, hint };
  },
};
