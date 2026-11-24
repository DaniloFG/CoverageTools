import path from 'node:path';
import type { FsReader } from './types';

export type DotnetTestFramework = 'mstest' | 'nunit' | 'xunit' | 'xunit3' | 'tunit';

/** What the .NET adapters need to know about a project, read from its MSBuild files as text. */
export interface ProjectFacts {
  isTest: boolean;
  /** The tests run on Microsoft.Testing.Platform rather than VSTest. */
  usesMtp: boolean;
  /** Referenced package names, lower-cased. */
  packages: ReadonlySet<string>;
  /** The project SDK without its version (e.g. `Microsoft.NET.Sdk`), '' when none is declared. */
  sdk: string;
  targetFrameworks: string[];
  framework: DotnetTestFramework | undefined;
}

/** How far up from the project directory imported MSBuild files and global.json are looked for. */
const MAX_LEVELS = 20;
const PROPS_FILES = ['Directory.Build.props', 'Directory.Packages.props'];
const TARGETS_FILES = ['Directory.Build.targets'];

const MTP_RUNNER_PROPERTIES = [
  'enablemstestrunner',
  'enablenunitrunner',
  'usemicrosofttestingplatformrunner',
  'testingplatformdotnettestsupport',
];

const XML_COMMENT = /<!--[\s\S]*?-->/g;
/** An element with a Condition attribute, self-closing or up to its closing tag (MSBuild groups do not nest). */
const CONDITIONAL_ELEMENT = /<([A-Za-z_][\w.-]*)\b[^>]*?\sCondition\s*=\s*(?:"[^"]*"|'[^']*')[^>]*?(?:\/>|>[\s\S]*?<\/\1\s*>)/g;
/** An element with only text inside: an MSBuild property (or item metadata, which no fact depends on). */
const SIMPLE_ELEMENT = /<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>([^<]*)<\/\1\s*>/g;
const PACKAGE_REFERENCE = /<(?:Global)?PackageReference\b[^>]*?\sInclude\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const PROJECT_SDK = /<Project\b[^>]*?\sSdk\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const SDK_ELEMENT = /<Sdk\b[^>]*?\sName\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const GLOBAL_JSON_RUNNER = /"test"\s*:\s*\{[^{}]*?"runner"\s*:\s*"([^"]*)"/i;

/**
 * Reads the facts of a project from its `.csproj`, every `Directory.Build.props`,
 * `Directory.Packages.props` and `Directory.Build.targets` from its directory up to the file system
 * root (at most MAX_LEVELS levels), and the nearest `global.json`. Text-based: MSBuild is not run, so
 * conditions are not evaluated. Conditional elements of the imported files are skipped (they usually
 * target some projects only, e.g. `'$(IsTestProject)' == 'true'`); those of the csproj are kept
 * (they usually select a target framework). Properties of the csproj override those of the props
 * files, and those of the targets files override both.
 */
export async function readProjectFacts(csproj: string, fs: FsReader): Promise<ProjectFacts> {
  const dirs: string[] = [];
  for (let dir = path.dirname(path.resolve(csproj)); dirs.length < MAX_LEVELS; dir = path.dirname(dir)) {
    dirs.push(dir);
    if (path.dirname(dir) === dir) break;
  }
  const read = (files: readonly string[]) =>
    Promise.all(dirs.flatMap(dir => files.map(file => fs.readText(path.join(dir, file)))));
  const [projectText, props, targets, globalJsons] = await Promise.all([
    fs.readText(csproj),
    read(PROPS_FILES),
    read(TARGETS_FILES),
    read(['global.json']),
  ]);

  const imported = (texts: ReadonlyArray<string | undefined>) =>
    texts.filter((t): t is string => t !== undefined).map(t => t.replace(XML_COMMENT, '').replace(CONDITIONAL_ELEMENT, ''));
  const project = (projectText ?? '').replace(XML_COMMENT, '');
  // From the lowest precedence to the highest; `read` lists the innermost directory first.
  const documents = [...imported(props).reverse(), project, ...imported(targets).reverse()];

  const properties = new Map<string, string>();
  const packages = new Set<string>();
  for (const doc of documents) {
    for (const [, name, value] of doc.matchAll(SIMPLE_ELEMENT)) properties.set(name.toLowerCase(), value.trim());
    for (const m of doc.matchAll(PACKAGE_REFERENCE)) {
      for (const name of (m[1] ?? m[2]).split(';')) {
        const n = name.trim().toLowerCase();
        if (n !== '' && !n.includes('$(')) packages.add(n);
      }
    }
  }
  const isTrue = (name: string) => properties.get(name)?.toLowerCase() === 'true';

  const sdks: string[] = [];
  const sdkMatch = PROJECT_SDK.exec(project);
  if (sdkMatch !== null) sdks.push(...(sdkMatch[1] ?? sdkMatch[2]).split(';'));
  for (const m of project.matchAll(SDK_ELEMENT)) sdks.push(m[1] ?? m[2]);
  const sdkNames = sdks.map(s => s.split('/')[0].trim()).filter(s => s !== '');
  const usesMSTestSdk = sdkNames.some(s => s.toLowerCase() === 'mstest.sdk');

  const globalJson = globalJsons.find(t => t !== undefined);
  const runner = globalJson === undefined ? undefined : GLOBAL_JSON_RUNNER.exec(globalJson)?.[1];

  const usesMtp =
    (usesMSTestSdk && !isTrue('usevstest')) ||
    MTP_RUNNER_PROPERTIES.some(isTrue) ||
    packages.has('tunit') ||
    runner?.toLowerCase() === 'microsoft.testing.platform';

  const frameworks = properties.get('targetframeworks') ?? properties.get('targetframework') ?? '';
  return {
    isTest: packages.has('microsoft.net.test.sdk') || isTrue('istestproject') || usesMSTestSdk || packages.has('tunit'),
    usesMtp,
    packages,
    sdk: sdkNames[0] ?? '',
    targetFrameworks: frameworks.split(';').map(f => f.trim()).filter(f => f !== '' && !f.includes('$(')),
    framework: frameworkOf(packages, usesMSTestSdk),
  };
}

function frameworkOf(packages: ReadonlySet<string>, usesMSTestSdk: boolean): DotnetTestFramework | undefined {
  const names = [...packages];
  if (packages.has('tunit')) return 'tunit';
  if (usesMSTestSdk || names.some(n => n === 'mstest' || n.startsWith('mstest.'))) return 'mstest';
  if (packages.has('nunit')) return 'nunit';
  if (names.some(n => n === 'xunit.v3' || n.startsWith('xunit.v3.'))) return 'xunit3';
  if (packages.has('xunit') || packages.has('xunit.core')) return 'xunit';
  return undefined;
}

/**
 * C# source with comments and the contents of string and character literals replaced by spaces, so
 * that braces and brackets can be counted. Interpolation holes are blanked with their string.
 */
function stripCode(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end < 0 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || ((c === '@' || c === '$') && /^[@$]*"/.test(source.slice(i, i + 4)))) {
      let j = i;
      let verbatim = false;
      while (source[j] === '@' || source[j] === '$') verbatim ||= source[j++] === '@';
      let quotes = 0;
      while (source[j + quotes] === '"') quotes++;
      let stop: number;
      if (quotes >= 3) {
        const end = source.indexOf('"'.repeat(quotes), j + quotes);
        stop = end < 0 ? source.length : end + quotes;
      } else if (quotes === 2) {
        stop = j + 2; // an empty string
      } else {
        let k = j + 1;
        for (; k < source.length; k++) {
          const ch = source[k];
          if (verbatim) {
            if (ch === '"') {
              if (source[k + 1] === '"') k++;
              else break;
            }
          } else if (ch === '\\') k++;
          else if (ch === '"' || ch === '\n') break;
        }
        stop = k + 1;
      }
      blank(i, stop);
      i = stop;
    } else if (c === "'") {
      let k = i + 1;
      for (; k < source.length && source[k] !== "'" && source[k] !== '\n'; k++) if (source[k] === '\\') k++;
      blank(i, k + 1);
      i = k + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

const TEST_ATTRIBUTE_SOURCE =
  String.raw`[\[,]\s*(?:global::)?(?:\w+\.)*(?:Fact|Theory|Test|TestCase|TestCaseSource|TestMethod|DataTestMethod)(?:Attribute)?\s*[\](,]`;
const TEST_ATTRIBUTE = new RegExp(TEST_ATTRIBUTE_SOURCE);

/** Whether the source applies a test attribute of xUnit, NUnit, MSTest or TUnit (comments and strings excluded). */
export function hasTestAttributes(source: string): boolean {
  return TEST_ATTRIBUTE.test(stripCode(source));
}

const TOKEN = new RegExp(
  [
    String.raw`\bnamespace\s+(@?[\w.]+)\s*([;{])`,
    String.raw`\b(?:record\s+(?:class|struct)|class|struct|interface|record)\s+@?([A-Za-z_]\w*)`,
    '([{};])',
    `(${TEST_ATTRIBUTE_SOURCE})`,
  ].join('|'),
  'g',
);

type Scope = { kind: 'namespace'; name: string } | { kind: 'type'; index: number } | { kind: 'block' };

/**
 * The qualified names of the test classes declared in a C# source, in order of appearance, each once:
 * `Namespace.Class`, with nested classes as `Namespace.Outer+Inner` (the form test names use). Handles
 * file-scoped, block and nested namespaces. Only classes whose own body has a test attribute are
 * returned; when no attribute could be placed in a class, every class of a file that has one is.
 */
export function testClassesIn(source: string): string[] {
  const types: Array<{ name: string; tested: boolean }> = [];
  const stack: Scope[] = [];
  let fileNamespace: string | undefined;
  let pending: string | undefined;
  let anyAttribute = false;

  const qualified = (name: string) => {
    for (let k = stack.length - 1; k >= 0; k--) {
      const scope = stack[k];
      if (scope.kind === 'type') return `${types[scope.index].name}+${name}`;
    }
    const namespaces = stack.flatMap(s => (s.kind === 'namespace' ? [s.name] : []));
    return [...(fileNamespace === undefined ? [] : [fileNamespace]), ...namespaces, name].join('.');
  };

  for (const m of stripCode(source).matchAll(TOKEN)) {
    const [, namespace, terminator, typeName, punctuation, attribute] = m;
    if (namespace !== undefined) {
      if (terminator === ';') fileNamespace = namespace.replace(/@/g, '');
      else stack.push({ kind: 'namespace', name: namespace.replace(/@/g, '') });
      pending = undefined;
    } else if (typeName !== undefined) {
      pending = typeName;
    } else if (punctuation === '{') {
      if (pending === undefined) stack.push({ kind: 'block' });
      else {
        types.push({ name: qualified(pending), tested: false });
        stack.push({ kind: 'type', index: types.length - 1 });
      }
      pending = undefined;
    } else if (punctuation === '}') {
      stack.pop();
    } else if (punctuation === ';') {
      pending = undefined;
    } else if (attribute !== undefined) {
      anyAttribute = true;
      for (let k = stack.length - 1; k >= 0; k--) {
        const scope = stack[k];
        if (scope.kind === 'type') {
          types[scope.index].tested = true;
          break;
        }
      }
    }
  }

  const tested = types.filter(t => t.tested);
  const chosen = tested.length > 0 ? tested : anyAttribute ? types : [];
  return [...new Set(chosen.map(t => t.name))];
}

const SLN_PROJECT = /^\s*Project\("[^"]*"\)\s*=\s*"[^"]*"\s*,\s*"([^"]*)"/gm;
const SLNX_PROJECT = /<Project\b[^>]*?\sPath\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** The absolute paths of the C# projects a `.sln` or `.slnx` lists, in the order listed. */
export function projectsInSolution(slnText: string, slnPath: string): string[] {
  const relative = slnPath.toLowerCase().endsWith('.slnx') || slnText.trimStart().startsWith('<')
    ? [...slnText.replace(XML_COMMENT, '').matchAll(SLNX_PROJECT)].map(m => m[1] ?? m[2])
    : [...slnText.matchAll(SLN_PROJECT)].map(m => m[1]);
  const dir = path.dirname(slnPath);
  return relative
    .filter(p => p.toLowerCase().endsWith('.csproj'))
    .map(p => path.resolve(dir, p.replace(/[\\/]/g, path.sep)));
}
