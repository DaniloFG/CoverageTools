## Global Constraints

- `engines.vscode`: `^1.90.0`. Extensão: `name` `coverage-tools`, `displayName` `Coverage Tools`, `publisher` `DaniloFG` (same as GitTools); extension ID `DaniloFG.coverage-tools`.
- `activationEvents`: somente `onStartupFinished`. A função `activate` não lê arquivos nem cria temporizadores.
- Tudo o que é voltado ao usuário é **somente em inglês**: títulos de comandos, mensagens, descrições de configuração, `README.md`, `CHANGELOG.md`.
- Sem telemetria e sem acesso à rede. Nenhuma dependência de execução além do `c8`. Parser de XML próprio, sem biblioteca.
- IDs fixos: controlador `coverageTools`; comandos `coverageTools.runAll`, `coverageTools.runHere`, `coverageTools.show`, `coverageTools.clear`; chave de contexto `coverageTools.runnablePaths`; canal de saída `Coverage Tools`.
- O controlador de testes **não registra itens de teste** (salvo se a Tarefa 2 obrigar ao plano B).
- Uma execução por vez. Toda execução da extensão grava seus relatórios em um diretório temporário **fora do workspace** e nunca alimenta o observador.
- Relatórios que já existem no disco ao iniciar não são carregados.
- Em workspace não confiável nada é executado; só relatórios estáticos são lidos.
- Exclusões padrão: `**/node_modules/**`, `**/bin/**`, `**/obj/**`, `**/.venv/**`, `**/venv/**`, `**/__pycache__/**`.
- Metas de leveza (seção 6.1 do design): ativação < 20 ms; zero leituras de arquivo na ativação; zero temporizadores em repouso; bloqueio máximo da linha principal < 50 ms ao incorporar 5.000 arquivos; memória adicional < 50 MB com 5.000 arquivos; `dist/extension.js` + `dist/worker.js` < 200 KB. Meta estourada é reportada ao usuário, nunca afrouxada em silêncio.
- Valores de tempo: debounce do observador 750 ms; janela de supressão após execução própria 2.000 ms; debounce de publicação 150 ms; nova tentativa de relatório ilegível após 1.000 ms, uma vez.
- Toda tarefa que entrega algo visível ao usuário move, no mesmo commit, a linha correspondente em `CHANGELOG.md` (`Planned` → `Done`) e na tabela "Feature status" do `README.md`.
- Mensagens de commit em inglês, no estilo `feat:` / `test:` / `docs:` / `chore:`.

## Estrutura de arquivos

```
package.json  tsconfig.json  esbuild.mjs  eslint.config.mjs  vitest.config.ts  .vscodeignore
.github/workflows/ci.yml
src/
  model.ts                 modelo compacto e resumo
  merge.ts                 união de registros do mesmo arquivo
  store.ts                 acumulado por projeto
  details.ts               modelo → detalhe (linhas, ramos, declarações), sem VS Code
  settings.ts              tipo Settings e valores padrão
  parsers/ types.ts paths.ts xml.ts cobertura.ts istanbul.ts lcov.ts load.ts
  worker/  protocol.ts worker.ts client.ts
  adapters/ types.ts index.ts nodeShared.ts jest.ts vitest.ts nodeGeneric.ts
            python.ts dotnetShared.ts dotnetVstest.ts dotnetMtp.ts custom.ts
  discovery.ts             projetos, aninhamento, caminhos elegíveis, resolução de alvo
  runner/  exec.ts queue.ts runProject.ts
  watcher/ attribution.ts batcher.ts coveragepy.ts
  vscode/  publisher.ts statusBar.ts config.ts fsReader.ts reportWatcher.ts commands.ts
  extension.ts
test/
  unit/**            Vitest, sem VS Code
  e2e/**             Vitest, roda as ferramentas reais sobre samples/
  perf/**            Vitest, metas de leveza
  ui/**              VS Code real dirigido pelo Playwright
  fixtures/reports/  relatórios pequenos escritos à mão e relatórios reais capturados
samples/             um projeto mínimo por variação + samples.code-workspace
scripts/             setup-samples.mjs  check-size.mjs  screenshots.mjs
docs/images/         capturas reais para o README
```

## Contratos

Tipos compartilhados entre tarefas. Linhas são base 1 e colunas base 0 no modelo.

```ts
// C1 — src/model.ts
export const EOL = 0xffffffff;            // "até o fim da linha" em endCol
export interface FileCoverageData {
  readonly path: string;                  // absoluto, no formato nativo da plataforma
  readonly statements: Uint32Array;       // passo 5: startLine, startCol, endLine, endCol, count
                                          // endLine === 0 → cobertura de linha inteira
  readonly branches: Uint32Array;         // passo 4: line, col, arm, count
  readonly declarations: Uint32Array;     // passo 6: startLine, startCol, endLine, endCol, count, nameIndex
  readonly names: readonly string[];
}
export interface Count { covered: number; total: number }
export interface FileSummary { statements: Count; branches: Count; declarations: Count }
export function summarize(file: FileCoverageData): FileSummary;
export class FileBuilder {
  constructor(path: string);
  addLine(line: number, count: number): void;
  addStatement(startLine: number, startCol: number, endLine: number, endCol: number, count: number): void;
  addBranch(line: number, col: number, arm: number, count: number): void;
  addDeclaration(name: string, startLine: number, startCol: number, endLine: number, endCol: number, count: number): void;
  build(): FileCoverageData;              // ordena por chave e soma duplicatas
}

// C2 — src/merge.ts
export function unionFiles(parts: readonly FileCoverageData[]): FileCoverageData;   // mesmo path
export function unionFileLists(a: readonly FileCoverageData[], b: readonly FileCoverageData[]): FileCoverageData[];

// C3 — src/store.ts
export interface MergedEntry { path: string; parts: readonly FileCoverageData[]; summary: FileSummary }
export class CoverageStore {
  replace(key: string, files: readonly FileCoverageData[]): void;
  union(key: string, files: readonly FileCoverageData[]): void;
  clear(key?: string): void;
  keys(): string[];
  merged(): readonly MergedEntry[];       // ordenado por path; em cache até a próxima mudança
  totals(): Count;                        // instruções de merged()
  onDidChange(listener: () => void): { dispose(): void };
}

// C4 — src/parsers/types.ts e load.ts
export type ReportFormat = 'istanbul' | 'cobertura' | 'lcov' | 'coveragepy';
export const FORMAT_PRIORITY: readonly ReportFormat[];   // istanbul, cobertura, lcov, coveragepy
export interface ParseContext { reportDir: string; roots: readonly string[]; fileExists(p: string): boolean }
export interface ParsedReport { files: FileCoverageData[]; signature: string; dropped: number }
export class ReportParseError extends Error {}
export class NotCoverageReportError extends Error {}
export function formatOf(reportPath: string): ReportFormat | undefined;
export function loadReport(reportPath: string, roots: readonly string[]): ParsedReport;  // fs síncrono; roda no worker

// C5 — src/worker/client.ts
export class ParserClient {
  constructor(workerFile: string);
  parse(reportPath: string, roots: readonly string[]): Promise<ParsedReport>;  // rejeita com as classes de C4
  dispose(): void;
}

// C6 — src/settings.ts
export interface Settings {
  watchEnabled: boolean; watchGlobs: string[]; exclude: string[];
  nestedProjects: 'inner' | 'outer';
  dotnetCollector: string; dotnetExtraArgs: string[];
  nodeExtraArgs: string[];
  pythonInterpreter: string; pythonExtraArgs: string[];
  commands: Record<string, string>;
}
export const DEFAULT_SETTINGS: Settings;

// C7 — src/adapters/types.ts
export type AdapterId = 'dotnet-vstest' | 'dotnet-mtp' | 'jest' | 'vitest' | 'node-generic' | 'python' | 'custom';
export type Ecosystem = 'dotnet' | 'node' | 'python' | 'custom';
export interface Project {
  key: string;                 // `project:${definingFile ?? dir}`
  adapter: AdapterId; ecosystem: Ecosystem;
  dir: string; definingFile?: string; name: string;
  supportsPartial: boolean;
  meta: Readonly<Record<string, unknown>>;
}
export type RunTarget = { kind: 'full' } | { kind: 'partial'; paths: readonly string[] };
export interface CommandSpec { command: string; args: readonly string[]; cwd: string; env?: Readonly<Record<string, string>>; shell?: boolean }
export interface RunPlan { steps: readonly CommandSpec[]; reportSearchDir: string; hint: string }
export interface FsReader {
  readText(path: string): Promise<string | undefined>;
  exists(path: string): Promise<boolean>;
  find(dir: string, include: readonly string[], exclude: readonly string[]): Promise<string[]>;
}
export interface PlanContext {
  tmpDir: string; fs: FsReader; settings: Settings; c8Bin: string;
  probe(spec: CommandSpec): Promise<{ code: number | null; stdout: string }>;
}
export interface Adapter {
  readonly id: AdapterId; readonly ecosystem: Ecosystem;
  detect(candidate: string, fs: FsReader): Promise<Project | undefined>;  // candidate: .csproj, package.json ou diretório
  isTestFile(project: Project, path: string, fs: FsReader): Promise<boolean>;
  plan(project: Project, target: RunTarget, ctx: PlanContext): Promise<RunPlan>;
}

// C8 — src/runner
export function exec(spec: CommandSpec, opts: { onOutput(chunk: string): void; signal: AbortSignal }): Promise<{ code: number | null }>;
export class RunQueue {
  enqueue<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T>;
  cancelAll(): void;
  readonly busy: boolean;
  onDidChangeBusy(listener: (busy: boolean) => void): { dispose(): void };
}
export type RunStatus = 'ok' | 'tests-failed' | 'no-report' | 'bad-report' | 'cancelled' | 'spawn-error';
export interface RunOutcome { status: RunStatus; message?: string; hint?: string }
export interface RunDeps {
  adapters: ReadonlyMap<AdapterId, Adapter>; store: CoverageStore; parser: ParserClient;
  fs: FsReader; settings: Settings; roots: readonly string[]; c8Bin: string;
  output(chunk: string): void;
  suppress(projectKey: string): { release(): void };   // observador ignora o projeto até release + 2.000 ms
}
export function runProject(project: Project, target: RunTarget, deps: RunDeps, signal: AbortSignal): Promise<RunOutcome>;

// C9 — src/discovery.ts
export interface DiscoveryState { folders: readonly string[]; projects: readonly Project[]; runnablePaths: ReadonlySet<string>; testFiles: ReadonlyMap<string, readonly string[]> }
export function discover(folders: readonly string[], fs: FsReader, settingsOf: (folder: string) => Settings, adapters: readonly Adapter[]): Promise<DiscoveryState>;
export function resolveTarget(path: string, isDirectory: boolean, state: DiscoveryState): Array<{ project: Project; target: RunTarget }>;

// C10 — src/watcher
export function ownerOf(reportPath: string, projects: readonly Project[]): Project | undefined;
export function resultsRootOf(reportPath: string): string;
export function unownedKey(reportPath: string, signature: string): string;   // `unowned:${resultsRootOf(reportPath)}#${signature}`

// C11 — src/details.ts (posições base 0, convenção do VS Code)
export interface Pos { line: number; character: number }
export interface BranchDetail { executed: number; label: string }
export interface StatementDetail { kind: 'statement'; executed: number; start: Pos; end?: Pos; branches: BranchDetail[] }
export interface DeclarationDetail { kind: 'declaration'; name: string; executed: number; start: Pos; end?: Pos }
export function toDetails(file: FileCoverageData): Array<StatementDetail | DeclarationDetail>;
```

---

