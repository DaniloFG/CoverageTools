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
/** Imported by MSBuild before the project body, in this order. */
const PROPS_FILES = ['Directory.Build.props', 'Directory.Packages.props'];
/** Imported by MSBuild after the project body. */
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
const IMPORT_ELEMENT = /<Import\b[^>]*?\sProject\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const GLOBAL_JSON_RUNNER = /"test"\s*:\s*\{[^{}]*?"runner"\s*:\s*"([^"]*)"/i;

/**
 * File texts by path, shared by the `readProjectFacts` calls of one discovery pass so that the
 * MSBuild files above several projects are read once.
 */
export type FileCache = Map<string, Promise<string | undefined>>;

/**
 * Whether an MSBuild file imports the next file of the same name above it, the way MSBuild documents
 * it: `GetPathOfFileAbove('<name>', …)` or `GetDirectoryNameOfFileAbove(…, <name>)`.
 */
function importsFileAbove(text: string, name: string): boolean {
  const lower = name.toLowerCase();
  for (const m of text.replace(XML_COMMENT, '').matchAll(IMPORT_ELEMENT)) {
    const value = (m[1] ?? m[2]).toLowerCase();
    if (/getpathoffileabove|getdirectorynameoffileabove/.test(value) && value.includes(lower)) return true;
  }
  return false;
}

/**
 * Reads the facts of a project from its `.csproj`, the `Directory.Build.props`,
 * `Directory.Packages.props` and `Directory.Build.targets` MSBuild imports for it, and the nearest
 * `global.json`. Like MSBuild, only the nearest file of each name (at most MAX_LEVELS levels up)
 * applies; the next one above applies too only when that file imports it explicitly. Text-based:
 * MSBuild is not run, so conditions are not evaluated. Conditional elements of the imported files
 * are skipped (they usually target some projects only, e.g. `'$(IsTestProject)' == 'true'`); those
 * of the csproj are kept (they usually select a target framework). Properties of the csproj override
 * those of the props files, and those of the targets files override both. Pass the same `cache` to
 * the calls of one discovery pass to read each file once.
 */
export async function readProjectFacts(csproj: string, fs: FsReader, cache?: FileCache): Promise<ProjectFacts> {
  const dirs: string[] = [];
  for (let dir = path.dirname(path.resolve(csproj)); dirs.length < MAX_LEVELS; dir = path.dirname(dir)) {
    dirs.push(dir);
    if (path.dirname(dir) === dir) break;
  }
  const readText = (file: string): Promise<string | undefined> => {
    if (cache === undefined) return fs.readText(file);
    let text = cache.get(file);
    if (text === undefined) {
      text = fs.readText(file);
      cache.set(file, text);
    }
    return text;
  };
  /** The files of `name` that apply, from the outermost to the nearest. */
  const applying = async (name: string, chained: boolean): Promise<string[]> => {
    const found: string[] = [];
    for (const dir of dirs) {
      const text = await readText(path.join(dir, name));
      if (text === undefined) continue;
      found.push(text);
      if (!chained || !importsFileAbove(text, name)) break;
    }
    return found.reverse();
  };
  const [projectText, props, targets, globalJsons] = await Promise.all([
    fs.readText(csproj),
    Promise.all(PROPS_FILES.map(name => applying(name, true))),
    Promise.all(TARGETS_FILES.map(name => applying(name, true))),
    applying('global.json', false),
  ]);

  const imported = (texts: readonly string[]) => texts.map(t => t.replace(XML_COMMENT, '').replace(CONDITIONAL_ELEMENT, ''));
  const project = (projectText ?? '').replace(XML_COMMENT, '');
  // From the lowest precedence to the highest.
  const documents = [...imported(props.flat()), project, ...imported(targets.flat())];

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
  const valueOf = (name: string) => properties.get(name)?.toLowerCase();
  const isTrue = (name: string) => valueOf(name) === 'true';

  const sdks: string[] = [];
  const sdkMatch = PROJECT_SDK.exec(project);
  if (sdkMatch !== null) sdks.push(...(sdkMatch[1] ?? sdkMatch[2]).split(';'));
  for (const m of project.matchAll(SDK_ELEMENT)) sdks.push(m[1] ?? m[2]);
  const sdkNames = sdks.map(s => s.split('/')[0].trim()).filter(s => s !== '');
  const usesMSTestSdk = sdkNames.some(s => s.toLowerCase() === 'mstest.sdk');

  const globalJson = globalJsons[0];
  const runner = globalJson === undefined ? undefined : GLOBAL_JSON_RUNNER.exec(globalJson)?.[1];

  const usesMtp =
    (usesMSTestSdk && !isTrue('usevstest')) ||
    MTP_RUNNER_PROPERTIES.some(isTrue) ||
    packages.has('tunit') ||
    runner?.toLowerCase() === 'microsoft.testing.platform';

  const frameworks = properties.get('targetframeworks') ?? properties.get('targetframework') ?? '';
  const declaresTest = packages.has('microsoft.net.test.sdk') || isTrue('istestproject') || usesMSTestSdk || packages.has('tunit');
  return {
    isTest: valueOf('istestproject') !== 'false' && declaresTest,
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

/** Characters of a C# identifier after the first (Unicode categories of the C# specification). */
const ID_PART = String.raw`\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}\p{Cf}`;
/** A C# identifier, with the optional `@` that lets a keyword be one. */
const IDENTIFIER = String.raw`@?[\p{L}\p{Nl}_][${ID_PART}]*`;
/** Not preceded by an identifier character, so that a keyword is not the tail of an identifier. */
const KEYWORD_START = String.raw`(?<![${ID_PART}@])`;
const TEST_ATTRIBUTE_NAMES = ['Fact', 'Theory', 'Test', 'TestCase', 'TestCaseSource', 'TestMethod', 'DataTestMethod'];
/** One attribute of an attribute section: optionally qualified, with or without `Attribute`, then its arguments. */
const TEST_ATTRIBUTE = new RegExp(
  String.raw`^(?:global\s*::\s*)?(?:${IDENTIFIER}\s*\.\s*)*(?:${TEST_ATTRIBUTE_NAMES.join('|')})(?:Attribute)?\s*(?:\(|$)`,
  'u',
);
/** The target of an attribute section, as in `[method: Test]`. */
const ATTRIBUTE_TARGET = new RegExp(String.raw`^\s*${IDENTIFIER}\s*:(?!:)`, 'u');

/** Whether the inside of an attribute section (`[` … `]`) applies a test attribute. */
function isTestAttributeSection(section: string): boolean {
  const items: string[] = [];
  let depth = 0;
  let from = 0;
  const body = section.replace(ATTRIBUTE_TARGET, '');
  for (let k = 0; k < body.length; k++) {
    const c = body[k];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      items.push(body.slice(from, k));
      from = k + 1;
    }
  }
  items.push(body.slice(from));
  return items.some(item => TEST_ATTRIBUTE.test(item.trim()));
}

/**
 * The offsets of the attribute sections that apply a test attribute, in stripped code. A `[` opens an
 * attribute section only where a declaration can start: at the start of the code, after `;`, `{`,
 * `}` or another attribute section. Preprocessor lines are skipped.
 */
function testAttributeOffsets(code: string): number[] {
  const offsets: number[] = [];
  let canStartDeclaration = true;
  let lineStart = true;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '\n') {
      lineStart = true;
      continue;
    }
    if (/\s/.test(c)) continue;
    if (lineStart && c === '#') {
      const end = code.indexOf('\n', i);
      i = (end < 0 ? code.length : end) - 1;
      continue;
    }
    lineStart = false;
    if (c === '[' && canStartDeclaration) {
      let depth = 0;
      let end = i;
      for (; end < code.length; end++) {
        if (code[end] === '[') depth++;
        else if (code[end] === ']' && --depth === 0) break;
      }
      if (isTestAttributeSection(code.slice(i + 1, end))) offsets.push(i);
      i = end;
      continue;
    }
    canStartDeclaration = c === ';' || c === '{' || c === '}';
  }
  return offsets;
}

/** Whether the source applies a test attribute of xUnit, NUnit, MSTest or TUnit (comments and strings excluded). */
export function hasTestAttributes(source: string): boolean {
  return testAttributeOffsets(stripCode(source)).length > 0;
}

const TOKEN = new RegExp(
  [
    String.raw`${KEYWORD_START}namespace\s+(${IDENTIFIER}(?:\s*\.\s*${IDENTIFIER})*)\s*([;{])`,
    String.raw`${KEYWORD_START}(?:record\s+(?:class|struct)|class|struct|interface|record)\s+(${IDENTIFIER})(\s*<)?`,
    '([{};])',
  ].join('|'),
  'gu',
);

type Scope = { kind: 'namespace'; name: string } | { kind: 'type'; index: number } | { kind: 'block' };

/** A test class: its qualified name, and whether it or a class it is nested in is generic. */
export interface TestType {
  name: string;
  generic: boolean;
}

const cleanName = (name: string) => name.replace(/[@\s]/g, '');

/**
 * The test classes declared in a C# source, in order of appearance, each once: `Namespace.Class`,
 * with nested classes as `Namespace.Outer+Inner` (the form test names use) and without type
 * parameters. Handles file-scoped, block and nested namespaces and Unicode identifiers. Only classes
 * whose own body has a test attribute are returned; when no attribute could be placed in a class,
 * every class of a file that has one is.
 */
export function testTypesIn(source: string): TestType[] {
  const types: Array<TestType & { tested: boolean }> = [];
  const stack: Scope[] = [];
  let fileNamespace: string | undefined;
  let pending: { name: string; generic: boolean } | undefined;
  let anyAttribute = false;

  const enclosingType = () => {
    for (let k = stack.length - 1; k >= 0; k--) {
      const scope = stack[k];
      if (scope.kind === 'type') return types[scope.index];
    }
    return undefined;
  };
  const qualified = (name: string) => {
    const outer = enclosingType();
    if (outer !== undefined) return `${outer.name}+${name}`;
    const namespaces = stack.flatMap(s => (s.kind === 'namespace' ? [s.name] : []));
    return [...(fileNamespace === undefined ? [] : [fileNamespace]), ...namespaces, name].join('.');
  };

  const code = stripCode(source);
  const attributes = testAttributeOffsets(code);
  let nextAttribute = 0;
  const placeAttributesBefore = (offset: number) => {
    for (; nextAttribute < attributes.length && attributes[nextAttribute] < offset; nextAttribute++) {
      anyAttribute = true;
      const type = enclosingType();
      if (type !== undefined) type.tested = true;
    }
  };

  for (const m of code.matchAll(TOKEN)) {
    placeAttributesBefore(m.index);
    const [, namespace, terminator, typeName, generic, punctuation] = m;
    if (namespace !== undefined) {
      if (terminator === ';') fileNamespace = cleanName(namespace);
      else stack.push({ kind: 'namespace', name: cleanName(namespace) });
      pending = undefined;
    } else if (typeName !== undefined) {
      pending = { name: cleanName(typeName), generic: generic !== undefined };
    } else if (punctuation === '{') {
      if (pending === undefined) stack.push({ kind: 'block' });
      else {
        const outer = enclosingType();
        types.push({ name: qualified(pending.name), generic: pending.generic || (outer?.generic ?? false), tested: false });
        stack.push({ kind: 'type', index: types.length - 1 });
      }
      pending = undefined;
    } else if (punctuation === '}') {
      stack.pop();
    } else if (punctuation === ';') {
      pending = undefined;
    }
  }
  placeAttributesBefore(Infinity);

  const tested = types.filter(t => t.tested);
  const chosen = tested.length > 0 ? tested : anyAttribute ? types : [];
  const seen = new Set<string>();
  return chosen.filter(t => !seen.has(t.name) && seen.add(t.name)).map(({ name, generic }) => ({ name, generic }));
}

/** The qualified names of the test classes declared in a C# source; see `testTypesIn`. */
export function testClassesIn(source: string): string[] {
  return testTypesIn(source).map(t => t.name);
}

/** The test classes of the `.cs` files and of the `.cs` files under the folders of a partial target, each once. */
export async function testTypesOf(paths: readonly string[], exclude: readonly string[], fs: FsReader): Promise<TestType[]> {
  const files: string[] = [];
  for (const p of paths) {
    if (p.toLowerCase().endsWith('.cs')) files.push(p);
    else files.push(...(await fs.find(p, ['**/*.cs'], ['**/bin/**', '**/obj/**', ...exclude])));
  }
  const types = new Map<string, TestType>();
  for (const file of new Set(files)) {
    const text = await fs.readText(file);
    if (text === undefined || !hasTestAttributes(text)) continue;
    for (const t of testTypesIn(text)) if (!types.has(t.name)) types.set(t.name, t);
  }
  return [...types.values()];
}

/**
 * A VSTest filter expression that selects the tests of these classes: `FullyQualifiedName~<Class>.`
 * joined by `|`. The trailing dot keeps `~` (contains) from also matching classes whose name starts
 * the same; it is left out for generic classes, whose test names read `Ns.G<Int32>.Method`.
 */
export function fullyQualifiedNameFilter(types: readonly TestType[]): string {
  return types.map(t => `FullyQualifiedName~${t.name}${t.generic ? '' : '.'}`).join('|');
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
