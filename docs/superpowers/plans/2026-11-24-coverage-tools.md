# Coverage Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Quem despacha tarefas deve entregar a cada implementador, junto com o texto da tarefa, as seções **Global Constraints** e **Contratos** deste plano.

**Goal:** Construir a extensão do VS Code "Coverage Tools", que acumula a cobertura de testes de todos os projetos do workspace (.NET, Node, Python) e a exibe pela API nativa de cobertura.

**Architecture:** Um núcleo sem dependência do VS Code (modelo compacto, parsers de Cobertura/Istanbul/LCOV, armazenamento por projeto, adaptadores por ferramenta, descoberta, fila de execução) e uma casca fina que liga esse núcleo ao VS Code (publicação por `TestController`, observador de relatórios, comandos, menu do Explorer, barra de status). Relatórios são lidos em uma thread de trabalho; a linha principal guarda só arranjos compactos.

**Tech Stack:** TypeScript 5, esbuild, Vitest (unitário, ponta a ponta com ferramentas reais, desempenho), `@vscode/test-electron` + `playwright-core` (interface em VS Code real), ESLint, `@vscode/vsce`, GitHub Actions. Única dependência de execução: `c8` 10.x.

**Spec:** `docs/superpowers/specs/2026-11-24-coverage-tools-design.md`

## Global Constraints

- `engines.vscode`: `^1.90.0`. Extensão: `name` `coverage-tools`, `displayName` `Coverage Tools`, `publisher` `danilofg`.
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

## Review Focus

1. **Caminhos difíceis** — espaços, acentos, barras invertidas e letra de unidade do Windows em relatórios e em linhas de comando; o arquivo deve ser encontrado e o comando deve rodar. Testes nas Tarefas 5 e 11.
2. **Relatório lido enquanto ainda é gravado** — o observador dispara no meio da escrita e o conteúdo vem truncado; os dados anteriores do projeto são mantidos e a leitura é refeita uma vez. Testes nas Tarefas 8 e 10.
3. **Mesmo arquivo com estruturas diferentes** — dois projetos (ou duas execuções, com o arquivo editado entre elas) relatam conjuntos de linhas distintos; nada some e nada é contado duas vezes. Teste na Tarefa 3.
4. **Relatório com arquivos que não existem, estão fora do workspace ou vazio** — arquivos inexistentes são descartados sem erro; relatório sem arquivos substitui o projeto por vazio. Testes nas Tarefas 5 e 4.
5. **Processo que não termina** — ferramenta entra em modo watch ou espera resposta no terminal (por exemplo, o Vitest oferecendo instalar o provedor de cobertura); a entrada padrão fica fechada e cancelar encerra a árvore de processos. Teste na Tarefa 11.

---

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

## Fase 1 — Acumular e exibir

Ao fim desta fase a extensão já detecta relatórios gravados por qualquer execução externa e os exibe acumulados.

### Task 1: Esqueleto, build e CI

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.mjs`, `eslint.config.mjs`, `vitest.config.ts`, `.vscodeignore`, `.gitignore`, `.github/workflows/ci.yml`, `scripts/check-size.mjs`, `src/extension.ts`, `test/unit/smoke.test.ts`

**Interfaces:**
- Produces: scripts npm `build`, `lint`, `test` (unit), `test:e2e`, `test:perf`, `test:ui`, `check:size`, `package`; `dist/extension.js` e `dist/worker.js`.

- [ ] **Step 1: Escrever o teste que falha** — `test/unit/smoke.test.ts`:

```ts
import manifest from '../../package.json';
test('manifest follows the global constraints', () => {
  expect(manifest.name).toBe('coverage-tools');
  expect(manifest.publisher).toBe('danilofg');
  expect(manifest.engines.vscode).toBe('^1.90.0');
  expect(manifest.activationEvents).toEqual(['onStartupFinished']);
  expect(manifest.main).toBe('./dist/extension.js');
  expect(manifest.capabilities.untrustedWorkspaces.supported).toBe('limited');
  expect(Object.keys(manifest.dependencies)).toEqual(['c8']);
});
```

- [ ] **Step 2: Rodar e ver falhar** — `npx vitest run test/unit/smoke.test.ts` → FAIL (sem `package.json`).
- [ ] **Step 3: Criar o esqueleto.**
  - `package.json`: campos do teste; `dependencies: { "c8": "^10.1.3" }`; `devDependencies`: `typescript`, `esbuild`, `vitest`, `eslint`, `typescript-eslint`, `@types/vscode@1.90.0`, `@types/node@20`, `@vscode/test-electron`, `playwright-core`, `@vscode/vsce`. `contributes` vazio por enquanto.
  - `esbuild.mjs`: duas entradas (`src/extension.ts` → `dist/extension.js`, `src/worker/worker.ts` → `dist/worker.js`), `platform: 'node'`, `format: 'cjs'`, `external: ['vscode']`, `minify` em produção. Enquanto `src/worker/worker.ts` não existir, a segunda entrada é omitida se o arquivo faltar.
  - `vitest.config.ts`: três projetos — `unit` (`test/unit/**`), `e2e` (`test/e2e/**`, `testTimeout: 300_000`), `perf` (`test/perf/**`). O script `test` roda só `unit`.
  - `src/extension.ts`: `export function activate() {}` e `export function deactivate() {}`.
  - `scripts/check-size.mjs`: soma os bytes de `dist/extension.js` e `dist/worker.js` (se existir) e sai com código 1 acima de 204.800.
  - `.vscodeignore`: exclui tudo exceto `dist/**`, `node_modules/c8/**` e suas dependências de produção, `README.md`, `CHANGELOG.md`, `LICENSE`, `docs/images/**`, `package.json`.
  - `ci.yml`: em `push` e `pull_request`, Ubuntu, Node 20: `npm ci`, `npm run lint`, `npm run build`, `npm run check:size`, `npm test`. Os demais jobs são acrescentados pelas tarefas que criam o que eles rodam.
- [ ] **Step 4: Verificar** — `npm install && npm run lint && npm run build && npm run check:size && npm test` → tudo verde.
- [ ] **Step 5: Commit** — `chore: scaffold extension, build and CI`.

### Task 2: Harness de interface e validação do risco principal

Confirma, em um VS Code real, que uma execução sem itens de teste e só com cobertura aparece na view nativa. É a primeira coisa validada porque decide o desenho do `publisher`.

**Files:**
- Create: `test/ui/harness.ts`, `test/ui/run.mjs`, `test/ui/spike.ui.test.ts`, `test/ui/fixtures/spike-extension/{package.json,extension.js}`, `test/ui/fixtures/spike-workspace/a.txt`
- Modify: `package.json` (script `test:ui`), `.github/workflows/ci.yml` (job `ui` com `xvfb-run -a npm run test:ui`)

**Interfaces:**
- Produces: `launchVSCode(opts: { extensionPath: string; workspace: string; settings?: object }): Promise<VSCodeSession>`, com `VSCodeSession = { page: import('playwright-core').Page; runCommand(title: string): Promise<void>; coverageViewText(): Promise<string>; close(): Promise<void> }`. `coverageViewText` foca a view Test Coverage e devolve o texto dela.

- [ ] **Step 1: Escrever o harness.** `launchVSCode` baixa o VS Code com `downloadAndUnzipVSCode('stable')`, inicia com `_electron.launch({ executablePath, args })` usando `--extensionDevelopmentPath`, `--user-data-dir` e `--extensions-dir` temporários, `--disable-workspace-trust`, `--skip-welcome`, `--skip-release-notes`, `--window-size=1280,800` e o caminho do workspace. `runCommand` abre a paleta com F1, digita o título e confirma. `test/ui/run.mjs` roda os arquivos `*.ui.test.ts` em série com o runner do Vitest (projeto `ui`, `fileParallelism: false`, `testTimeout: 180_000`).
- [ ] **Step 2: Escrever a extensão de sonda.** `spike-extension/extension.js`, ativada em `onStartupFinished`: cria `tests.createTestController('spike', 'Spike')`, um perfil `TestRunProfileKind.Coverage` com `loadDetailedCoverage` devolvendo duas `StatementCoverage` (linha 0 executada, linha 1 não), e um comando `spike.publish` que cria `createTestRun(new TestRunRequest(undefined, undefined, profile), 'Spike', false)`, chama `addCoverage(new FileCoverage(uri de a.txt, new TestCoverageCount(1, 2)))` e `end()`.
- [ ] **Step 3: Escrever o teste.**

```ts
test('a coverage-only run with no test items shows in the native Test Coverage view', async () => {
  const s = await launchVSCode({ extensionPath: spikeExtension, workspace: spikeWorkspace });
  await s.runCommand('Spike: Publish');
  const text = await s.coverageViewText();
  expect(text).toContain('a.txt');
  expect(text).toContain('50');
  await s.close();
});
```

- [ ] **Step 4: Rodar** — `xvfb-run -a npm run test:ui`. Instalar antes as bibliotecas de sistema do Electron que faltarem (`apt-get install -y libnss3 libgtk-3-0 libgbm1 libasound2t64 libxkbfile1 libsecret-1-0`).
- [ ] **Step 5: Registrar o resultado.** Se passou: acrescentar ao fim da seção "Publicação pela API nativa" do design a linha "Validado em VS Code <versão> em <data>: execução sem itens de teste é exibida." Se falhou: alterar a sonda para registrar um `TestItem` por projeto e incluí-lo na requisição, repetir até passar, registrar no design que o plano B foi adotado e **parar para avisar o usuário** antes de seguir, porque a Tarefa 9 muda.
- [ ] **Step 6: Commit** — `test: add UI harness and validate coverage-only test runs`.

### Task 3: Modelo compacto e união

**Files:**
- Create: `src/model.ts`, `src/merge.ts`
- Test: `test/unit/model.test.ts`, `test/unit/merge.test.ts`

**Interfaces:**
- Produces: C1, C2.

- [ ] **Step 1: Testes que falham.**

```ts
// model.test.ts
test('builder sorts records, sums duplicates and summarizes', () => {
  const b = new FileBuilder('/w/a.ts');
  b.addLine(3, 0); b.addLine(1, 2); b.addLine(1, 1);
  b.addBranch(1, 0, 0, 1); b.addBranch(1, 0, 1, 0);
  b.addDeclaration('f', 1, 0, 0, 0, 3);
  const f = b.build();
  expect(Array.from(f.statements)).toEqual([1, 0, 0, 0, 3, 3, 0, 0, 0, 0]);
  expect(summarize(f)).toEqual({
    statements: { covered: 1, total: 2 }, branches: { covered: 1, total: 2 }, declarations: { covered: 1, total: 1 },
  });
});
test('counts saturate at 0xffffffff instead of wrapping', () => {
  const b = new FileBuilder('/w/a.ts'); b.addLine(1, 0xffffffff); b.addLine(1, 5);
  expect(b.build().statements[4]).toBe(0xffffffff);
});

// merge.test.ts
test('union sums matching records and keeps unmatched ones from both sides', () => {
  const a = file('/w/a.ts', [[1, 1], [2, 0]]);          // helper: linhas [linha, contagem]
  const b = file('/w/a.ts', [[2, 4], [9, 1]]);
  expect(lines(unionFiles([a, b]))).toEqual([[1, 1], [2, 4], [9, 1]]);
});
test('a line record and a range record on the same line are different statements', () => { /* 2 registros */ });
test('declarations match by name and start line; branches by line, col and arm', () => { /* soma só o que casa */ });
test('unionFileLists unions by path and keeps files present on one side only', () => { /* 3 arquivos de 2+2 */ });
test('unionFiles does not mutate its inputs', () => { /* cópias dos arranjos iguais antes e depois */ });
```

- [ ] **Step 2: Rodar e ver falhar** — `npx vitest run test/unit/model.test.ts test/unit/merge.test.ts`.
- [ ] **Step 3: Implementar C1 e C2.** Chaves de ordenação e de casamento: instrução `(startLine, startCol, endLine, endCol)`; ramo `(line, col, arm)`; declaração `(nome, startLine)`. `unionFiles` é uma intercalação linear de arranjos já ordenados. Os objetos devolvidos são imutáveis por convenção: nenhuma função altera um `FileCoverageData` recebido.
- [ ] **Step 4: Rodar e ver passar.**
- [ ] **Step 5: Commit** — `feat: add compact coverage model and union`.

### Task 4: Armazenamento por projeto

**Files:**
- Create: `src/store.ts`
- Test: `test/unit/store.test.ts`

**Interfaces:**
- Consumes: C1, C2. Produces: C3.

- [ ] **Step 1: Testes que falham.**

```ts
test('replace swaps one project and leaves the others untouched', () => {
  const s = new CoverageStore();
  s.replace('p1', [file('/w/a.ts', [[1, 1]])]);
  s.replace('p2', [file('/w/b.ts', [[1, 0]])]);
  s.replace('p1', [file('/w/c.ts', [[1, 1]])]);
  expect(s.merged().map(e => e.path)).toEqual(['/w/b.ts', '/w/c.ts']);
});
test('union adds to a project without dropping what was covered', () => {
  const s = new CoverageStore();
  s.replace('p1', [file('/w/a.ts', [[1, 1], [2, 0]])]);
  s.union('p1', [file('/w/a.ts', [[2, 1]])]);
  expect(s.merged()[0].summary.statements).toEqual({ covered: 2, total: 2 });
});
test('a file covered by two projects shows the union and lists both parts', () => { /* parts.length === 2 */ });
test('replace with an empty list empties the project', () => { /* merged() vazio, keys() contém a chave */ });
test('totals sums statements across merged files', () => { /* {covered: 3, total: 5} */ });
test('clear(key) removes one project; clear() removes all', () => {});
test('onDidChange fires once per mutation and not when nothing changed', () => { /* clear() em store vazio não dispara */ });
test('merged() returns the same array until the next mutation', () => { /* toBe */ });
```

- [ ] **Step 2–4: Rodar, implementar, rodar.** `merged()` calcula o resumo de arquivo com uma só parte por `summarize` direto e, com mais de uma, por `summarize(unionFiles(parts))`.
- [ ] **Step 5: Commit** — `feat: add per-project coverage store`.

### Task 5: Resolução de caminhos, leitor de XML e parser Cobertura

**Files:**
- Create: `src/parsers/types.ts`, `src/parsers/paths.ts`, `src/parsers/xml.ts`, `src/parsers/cobertura.ts`
- Test: `test/unit/parsers/paths.test.ts`, `test/unit/parsers/xml.test.ts`, `test/unit/parsers/cobertura.test.ts`
- Fixtures: `test/fixtures/reports/cobertura-coverlet.xml`, `cobertura-coveragepy.xml`, `cobertura-istanbul.xml`, `cobertura-mscoverage.xml` (pequenos, escritos à mão no dialeto de cada ferramenta)

**Interfaces:**
- Produces: tipos de C4; `resolveReportPath(raw: string, sources: readonly string[], ctx: ParseContext): string | undefined`; `scanXml(xml: string, h: { open(name: string, attrs: Record<string, string>): void; text(t: string): void; close(name: string): void }): void`; `parseCobertura(xml: string, ctx: ParseContext): ParsedReport`.

- [ ] **Step 1: Testes que falham.**

```ts
// paths.test.ts — ctx.fileExists é um Set de caminhos
test.each([
  ['absolute existing path', '/w/src/a.cs', [], '/w/src/a.cs'],
  ['relative to a <source>', 'src/a.cs', ['/w'], '/w/src/a.cs'],
  ['relative to the report directory', 'a.cs', [], '/w/TestResults/x/a.cs'],
  ['relative to a workspace root', 'src/a.cs', [], '/w/src/a.cs'],
  ['deterministic build prefix /_/', '/_/src/a.cs', [], '/w/src/a.cs'],
  ['path with spaces and accents', 'meu código/a.cs', ['/w'], '/w/meu código/a.cs'],
])('%s', (_n, raw, sources, expected) => { /* resolveReportPath(...) === expected */ });
test('a path that exists nowhere resolves to undefined', () => {});
test('Windows: backslashes and drive-letter case are normalized', () => {
  // ctx com path.win32: 'c:\\w\\src\\a.cs' e sources ['C:\\w'] → 'C:\\w\\src\\a.cs'
});

// xml.test.ts
test('reports elements, attributes, text and entities; skips prolog, DOCTYPE, comments and CDATA markers', () => {
  // '<?xml version="1.0"?><!DOCTYPE coverage SYSTEM "x"><a b="1 &amp; 2"><!-- c --><d>t&lt;</d></a>'
  // → open a {b:'1 & 2'}, open d {}, text 't<', close d, close a
});
test('throws ReportParseError on truncated input', () => { /* '<a><b' */ });

// cobertura.test.ts
test('coverlet dialect: lines, condition coverage and methods', () => {
  const r = parseCobertura(read('cobertura-coverlet.xml'), ctx);
  expect(r.files.map(f => f.path)).toEqual(['/w/src/Calc.cs']);
  expect(lines(r.files[0])).toEqual([[5, 2], [6, 2], [10, 0], [11, 0]]);
  expect(Array.from(r.files[0].branches)).toEqual([10, 0, 0, 0, 10, 0, 1, 0]);   // condition-coverage="0% (0/2)"
  expect(r.files[0].names).toEqual(['Add', 'Divide']);
  expect(r.signature).toBe('Calc');                                             // nomes de <package>, ordenados, unidos por '|'
});
test('condition-coverage "50% (1/2)" yields arm 0 covered and arm 1 uncovered', () => {});
test('the same file listed under two <class> elements is merged into one file', () => {});
test('coverage.py dialect: filename relative to <source>, no methods', () => {});
test('files that do not exist are dropped and counted in dropped', () => { /* dropped === 1 */ });
test('an existing file outside every workspace root is kept', () => { /* /elsewhere/Shared.cs existe → presente em files */ });
test('a root element other than <coverage> throws NotCoverageReportError', () => {});
test('a report with no classes yields zero files', () => {});
```

- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.** Ordem de tentativa em `resolveReportPath`: caminho absoluto existente; cada `<source>` + caminho; `reportDir` + caminho; cada raiz + caminho; se começa com `/_/`, cada raiz + o restante. Em cada linha `<line>`: `addLine(number, hits)`; com `branch="true"`, lê `(c/t)` de `condition-coverage` e adiciona `t` braços, os `c` primeiros com contagem 1. Cada `<method>` vira declaração na primeira linha do método, com a contagem dessa linha; nome do atributo `name`.
- [ ] **Step 4: Rodar e ver passar.**
- [ ] **Step 5: Commit** — `feat: add Cobertura parser with path resolution`.

### Task 6: Parser Istanbul JSON

**Files:**
- Create: `src/parsers/istanbul.ts`
- Test: `test/unit/parsers/istanbul.test.ts`
- Fixture: `test/fixtures/reports/coverage-final.json` (escrito à mão: dois arquivos, um com `branchMap` e `fnMap`)

**Interfaces:**
- Consumes: C1, tipos de C4, `resolveReportPath`. Produces: `parseIstanbul(json: string, ctx: ParseContext): ParsedReport`.

- [ ] **Step 1: Testes que falham.**

```ts
test('keeps exact statement ranges and counts', () => {
  const f = parseIstanbul(read('coverage-final.json'), ctx).files[0];
  expect(Array.from(f.statements.slice(0, 5))).toEqual([1, 0, 1, 24, 3]);   // start {1,0} end {1,24}, s = 3
});
test('branches use the branch location and one arm per count', () => { /* b: {"0":[2,0]} em {line:4,column:2} → [4,2,0,2, 4,2,1,0] */ });
test('functions become declarations using fnMap loc and name', () => {});
test('a null end column becomes EOL', () => { /* endCol === EOL */ });
test('truncated JSON throws ReportParseError', () => { /* '{"/w/a.ts":{"path":' */ });
test('signature is the empty string', () => {});
```

- [ ] **Step 2–4: Rodar, implementar, rodar.** A chave do objeto e o campo `path` são o caminho bruto; resolver com `sources = []`.
- [ ] **Step 5: Commit** — `feat: add Istanbul JSON parser`.

### Task 7: Parser LCOV

**Files:**
- Create: `src/parsers/lcov.ts`
- Test: `test/unit/parsers/lcov.test.ts`

**Interfaces:**
- Produces: `parseLcov(text: string, ctx: ParseContext): ParsedReport`.

- [ ] **Step 1: Testes que falham.**

```ts
const SAMPLE = `TN:
SF:src/a.js
FN:1,add
FN:5,9,divide
FNDA:2,add
FNDA:0,divide
DA:2,2
DA:6,0
BRDA:6,0,0,-
BRDA:6,0,1,3
end_of_record
`;
test('reads DA, BRDA, FN and FNDA', () => {
  const f = parseLcov(SAMPLE, ctx).files[0];
  expect(lines(f)).toEqual([[2, 2], [6, 0]]);
  expect(Array.from(f.branches)).toEqual([6, 0, 0, 0, 6, 0, 1, 3]);   // '-' é 0
  expect(f.names).toEqual(['add', 'divide']);
});
test('FN accepts both "line,name" and "line,endLine,name"', () => {});
test('a function name containing commas is kept whole', () => { /* FN:1,a(b,c) */ });
test('two records for the same SF are merged', () => {});
test('CRLF line endings are accepted', () => {});
test('a file with no end_of_record at the end still yields its record', () => {});
```

- [ ] **Step 2–4: Rodar, implementar, rodar.**
- [ ] **Step 5: Commit** — `feat: add LCOV parser`.

### Task 8: Carregamento de relatórios e thread de trabalho

**Files:**
- Create: `src/parsers/load.ts`, `src/worker/protocol.ts`, `src/worker/worker.ts`, `src/worker/client.ts`
- Test: `test/unit/parsers/load.test.ts`, `test/unit/worker/client.test.ts` (usa `dist/worker.js`; o script `test` passa a rodar `build` antes)

**Interfaces:**
- Consumes: os três parsers. Produces: `formatOf`, `FORMAT_PRIORITY`, `loadReport` (C4); `ParserClient` (C5).

- [ ] **Step 1: Testes que falham.**

```ts
// load.test.ts
test.each([
  ['coverage/coverage-final.json', 'istanbul'], ['out/custom.json', 'istanbul'],
  ['coverage/lcov.info', 'lcov'], ['coverage.lcov', 'lcov'],
  ['TestResults/g/coverage.cobertura.xml', 'cobertura'], ['coverage.xml', 'cobertura'],
  ['.coverage', 'coveragepy'], ['notes.txt', undefined],
])('formatOf(%s) is %s', (p, f) => expect(formatOf(p)).toBe(f));
test('loadReport reads a real file from disk and resolves against roots', () => { /* tmpdir com lcov.info + src/a.js */ });
test('loadReport on a .coverage file throws ReportParseError: conversion happens before loading', () => {});

// client.test.ts
test('parses in a worker and returns typed arrays', async () => {
  const r = await client.parse(lcovPath, [root]);
  expect(r.files[0].statements).toBeInstanceOf(Uint32Array);
});
test('rejects with ReportParseError for a truncated report', async () => {});
test('rejects with NotCoverageReportError for a non-Cobertura coverage.xml', async () => {});
test('the worker is started on demand and terminated when no request is pending', async () => {
  expect(client.running).toBe(false);
  const p = client.parse(lcovPath, [root]);
  expect(client.running).toBe(true);
  await p; await client.idle();
  expect(client.running).toBe(false);
});
test('concurrent requests share one worker and all resolve', async () => {});
```

- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.** O worker responde `{ id, ok: true, report }` transferindo os `ArrayBuffer` dos arranjos, ou `{ id, ok: false, kind: 'parse' | 'not-coverage' | 'io', message }`; o cliente reconstrói a classe de erro. O worker é encerrado no instante em que a contagem de pedidos pendentes chega a zero — **sem temporizador de ociosidade**. `client.running` e `client.idle()` existem para teste.
- [ ] **Step 4: Rodar e ver passar.** Reativar a segunda entrada no `esbuild.mjs`.
- [ ] **Step 5: Commit** — `feat: load coverage reports in an on-demand worker`.

### Task 9: Publicação nativa, Show/Clear e barra de status

**Files:**
- Create: `src/details.ts`, `src/vscode/publisher.ts`, `src/vscode/statusBar.ts`
- Modify: `src/extension.ts`, `package.json` (`contributes.commands`)
- Test: `test/unit/details.test.ts`, `test/ui/publish.ui.test.ts`
- Delete: `test/ui/spike.ui.test.ts`, `test/ui/fixtures/spike-extension/` (o teste novo cobre o mesmo comportamento)

**Interfaces:**
- Consumes: C1–C3, C11, harness da Tarefa 2.
- Produces: `class Publisher { constructor(store: CoverageStore); publishNow(): void; close(): Thenable<void>; dispose(): void }`; `class StatusBar { constructor(store: CoverageStore, queue?: RunQueue); dispose(): void }`; `activate()` passa a devolver `ExtensionApi = { store: CoverageStore; ready: Promise<void> }`; comandos `coverageTools.show` (título `Coverage Tools: Show Coverage`) e `coverageTools.clear` (`Coverage Tools: Clear Coverage`).

- [ ] **Step 1: Teste unitário que falha — `details.test.ts`.**

```ts
test('line-only statements become a position at column 0, zero-based', () => {
  expect(toDetails(file('/w/a.ts', [[3, 2]]))).toEqual([
    { kind: 'statement', executed: 2, start: { line: 2, character: 0 }, branches: [] },
  ]);
});
test('range statements keep start and end; EOL maps to character 0x7fffffff', () => {});
test('branches attach to the statement that starts on their line', () => {
  // linha 6 com dois braços [0 → 0, 1 → 3] → branches: [{executed: 0, label: 'branch 1'}, {executed: 3, label: 'branch 2'}]
});
test('a branch on a line with no statement creates a statement with the summed count', () => {});
test('declarations carry name, count and position', () => {});
```

- [ ] **Step 2: Rodar e ver falhar; implementar `toDetails`; rodar e ver passar.**
- [ ] **Step 3: Teste de interface que falha — `publish.ui.test.ts`.** O teste abre `test/ui/fixtures/publish-workspace/` (dois arquivos-fonte, `a.js` e `b.js`, e um `seed.lcov` com `a.js` 100% e `b.js` 0%). Como a detecção de relatórios só chega na Tarefa 10, nesta tarefa o acumulado é semeado por um gancho provisório: se a variável de ambiente `COVERAGE_TOOLS_TEST_SEED` aponta para um relatório, a extensão o carrega pelo `ParserClient` em `store.replace('seed', …)` logo depois de ativar. A Tarefa 10 remove o gancho.

```ts
test('accumulated coverage shows in the native view with per-file percentages', async () => {
  const text = await s.coverageViewText();
  expect(text).toContain('a.js'); expect(text).toContain('b.js');
  expect(text).toMatch(/50(\.00)?%/);
});
test('opening a file shows covered and uncovered line decorations', async () => { /* abre a.js, alterna "Test: Show Inline Coverage" e espera elementos de decoração de cobertura */ });
test('Clear Coverage empties the view; Show Coverage with an empty store shows an information message', async () => {});
test('the status bar shows the accumulated total', async () => { /* texto contém '50%' */ });
```

- [ ] **Step 4: Implementar.**
  - `Publisher`: cria `tests.createTestController('coverageTools', 'Coverage Tools')` e um perfil `Coverage` cujo `runHandler` chama `publishNow()`. Assina `store.onDidChange` e publica após 150 ms sem novas mudanças. `publishNow` cria o `TestRun` (sem persistência), adiciona, para cada `MergedEntry`, uma instância de `AccumulatedFileCoverage extends vscode.FileCoverage` que guarda `parts`, e encerra. `loadDetailedCoverage` devolve `toDetails(unionFiles(parts))` convertido para `StatementCoverage`/`BranchCoverage`/`DeclarationCoverage`. Com o acumulado vazio, não cria execução. `close()` executa o comando nativo de fechar cobertura (`testing.coverage.close`; confirmar o ID no VS Code real e ajustar se for outro).
  - `StatusBar`: item à esquerda com `$(beaker) 50%` (uma casa decimal quando não inteiro), oculto com o acumulado vazio, comando `coverageTools.show`, tooltip com o percentual por projeto. Com `queue.busy`, mostra `$(sync~spin)`.
  - `coverageTools.clear`: `store.clear()` e `publisher.close()`.
- [ ] **Step 5: Rodar** — `npm test && xvfb-run -a npm run test:ui` → verde.
- [ ] **Step 6: Commit** — `feat: publish accumulated coverage through the native testing API`.

### Task 10: Detecção de relatórios externos

**Files:**
- Create: `src/settings.ts`, `src/watcher/attribution.ts`, `src/watcher/batcher.ts`, `src/vscode/config.ts`, `src/vscode/reportWatcher.ts`
- Modify: `src/extension.ts` (remove a semeadura por variável de ambiente), `package.json` (`contributes.configuration`: `coverageTools.watch.enabled`, `coverageTools.watch.globs`, `coverageTools.exclude`, todas com escopo `resource`)
- Test: `test/unit/watcher/attribution.test.ts`, `test/unit/watcher/batcher.test.ts`, `test/ui/watch.ui.test.ts`; `test/ui/publish.ui.test.ts` passa a semear gravando o relatório no workspace

**Interfaces:**
- Consumes: C3–C6, C7 (`Project`), C10.
- Produces: C6, C10; `class ReportBatcher { constructor(o: { debounceMs: number; retryMs: number; groupOf(path: string): string; isSuppressed(group: string): boolean; ingest(group: string, reportPath: string): Promise<'ok' | 'retry' | 'drop'>; timers: { set(fn: () => void, ms: number): unknown; clear(h: unknown): void } }); push(path: string): void; dispose(): void }`; `class ReportWatcher { constructor(deps: { store; parser; settingsOf; projects(): readonly Project[]; isSuppressed(key: string): boolean; log(msg: string): void }); dispose(): void }`; `readSettings(scope?: vscode.Uri): Settings`.

- [ ] **Step 1: Testes unitários que falham.**

```ts
// attribution.test.ts
test('a report belongs to the nearest project above it', () => {
  expect(ownerOf('/w/api/Tests/TestResults/g1/coverage.cobertura.xml', [p('/w/api/Tests'), p('/w/api')])!.dir).toBe('/w/api/Tests');
});
test('a report with no project above has no owner', () => {});
test('resultsRootOf strips the GUID folder under TestResults, otherwise uses the report directory', () => {
  expect(resultsRootOf('/w/TestResults/3f2a…/coverage.cobertura.xml')).toBe('/w/TestResults');
  expect(resultsRootOf('/w/coverage/lcov.info')).toBe('/w/coverage');
});
test('unownedKey combines results root and signature', () => {
  expect(unownedKey('/w/TestResults/g/coverage.cobertura.xml', 'A|B')).toBe('unowned:/w/TestResults#A|B');
});

// batcher.test.ts — temporizadores falsos injetados
test('events for one group within 750 ms are ingested once', () => {});
test('when several formats arrive together, the highest priority one is ingested', () => { /* lcov.info + coverage-final.json → o json */ });
test('among same-format reports, the most recently pushed wins', () => { /* dois GUIDs de TestResults → o último */ });
test('events for a suppressed group are discarded', () => {});
test('a "retry" result re-ingests once after 1000 ms and then gives up', () => { /* 2 chamadas a ingest, nunca 3 */ });
test('no timer is left pending after the last flush', () => { /* timers.pending === 0 */ });
```

- [ ] **Step 2: Rodar, implementar `attribution.ts` e `batcher.ts`, rodar.** Grupo de um relatório: a chave do projeto dono; sem dono, `dir:${dirname}`. `DEFAULT_SETTINGS.watchGlobs` são exatamente os sete padrões da seção 5.3 do design: `**/TestResults/**/*.cobertura.xml`, `**/coverage/coverage-final.json`, `**/coverage/lcov.info`, `**/coverage/cobertura-coverage.xml`, `**/coverage.xml`, `**/coverage.lcov`, `**/.coverage`. Os demais padrões de `DEFAULT_SETTINGS` vêm da tabela 5.7.
- [ ] **Step 3: Teste de interface que falha — `watch.ui.test.ts`** sobre um workspace multi-root de fixture (`one/`, `two/`):

```ts
test('a report written to the workspace is picked up without any command', async () => {});
test('reports from two folders accumulate; rewriting one keeps the other', async () => {
  // grava one/coverage/lcov.info → vê a.js; grava two/coverage/lcov.info → vê a.js e b.js;
  // regrava one com outros números → b.js continua, a.js mostra o número novo
});
test('a truncated report keeps the previous coverage and is retried', async () => {
  // grava metade do JSON, espera 300 ms, grava o JSON inteiro → a view mostra o inteiro
});
test('a report already on disk at startup is not loaded', async () => {});
test('with coverageTools.watch.enabled false nothing is picked up', async () => {});
```

- [ ] **Step 4: Implementar `ReportWatcher`.** Um `FileSystemWatcher` por pasta do workspace e por glob (`RelativePattern`), reagindo a criação e alteração; caminhos que casam com `exclude` são ignorados. `ingest`: `parser.parse` → com dono, `store.replace(owner.key, files)`; sem dono, `store.replace(unownedKey(path, report.signature), files)`. `ReportParseError` → `'retry'`; `NotCoverageReportError` → `'drop'` em silêncio; os demais erros vão para o log. Arquivos `.coverage` são descartados aqui (a conversão entra na Tarefa 15). Recria os observadores quando a configuração ou as pastas mudam.
- [ ] **Step 5: Rodar** — `npm test && xvfb-run -a npm run test:ui` → verde.
- [ ] **Step 6: Commit** — `feat: detect coverage reports written outside the extension`. Mover em `CHANGELOG.md` e `README.md`: cobertura acumulada na UI nativa, detecção automática, leitura dos três formatos, `Show Coverage`/`Clear Coverage`, barra de status.

---

## Fase 2 — Descobrir e executar

### Task 11: Contrato de adaptador, execução de processos e fila

**Files:**
- Create: `src/adapters/types.ts`, `src/runner/exec.ts`, `src/runner/queue.ts`, `src/runner/runProject.ts`
- Test: `test/unit/runner/exec.test.ts`, `test/unit/runner/queue.test.ts`, `test/unit/runner/runProject.test.ts`

**Interfaces:**
- Consumes: C3–C6. Produces: C7, C8.

- [ ] **Step 1: Testes que falham.**

```ts
// exec.test.ts — usa process.execPath como comando
test('streams output and resolves with the exit code', async () => {});
test('arguments with spaces, quotes and accents reach the process intact', async () => {
  // node -e "console.log(JSON.stringify(process.argv.slice(1)))" 'a b' 'c"d' 'é' → mesmos três valores
});
test('stdin is closed: a process that reads stdin gets EOF instead of hanging', async () => {});
test('abort kills the whole process tree', async () => {
  // o filho inicia um neto que grava um arquivo de pulso a cada 100 ms; após abort, o arquivo para de mudar
});
test('a command that does not exist rejects with a spawn error', async () => {});
test('shell: true runs a full command line', async () => {});

// queue.test.ts
test('jobs run one at a time, in order', async () => {});
test('busy toggles true while a job runs and false when the queue drains', async () => {});
test('cancelAll aborts the running job and drops queued ones, which resolve as cancelled', async () => {});

// runProject.test.ts — adaptador falso cujo plano roda um script Node que grava lcov.info em ctx.tmpDir
test('full run replaces the project data', async () => { /* status 'ok'; store.merged() tem o arquivo */ });
test('partial run unions into the project data', async () => {});
test('non-zero exit with a report yields tests-failed and still ingests', async () => {});
test('no report yields no-report with the adapter hint', async () => {});
test('a plan with no steps runs nothing and yields no-report with the plan hint', async () => {});
test('an unreadable report yields bad-report and keeps the previous data', async () => {});
test('the temp directory is outside every root and removed afterwards', async () => {});
test('the project is suppressed during the run and released at the end, even on failure', async () => {});
test('abort yields cancelled and changes nothing in the store', async () => {});
```

- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.** `exec`: `spawn` com `stdio: ['ignore', 'pipe', 'pipe']`; em POSIX `detached: true` e encerramento por `process.kill(-pid)`; no Windows `shell: true` com argumentos entre aspas e encerramento por `taskkill /pid <pid> /T /F`. `runProject`: cria o diretório com `mkdtemp` em `os.tmpdir()`; `adapter.plan`; executa os passos em ordem (falha de `spawn` → `spawn-error`); procura em `plan.reportSearchDir`, recursivamente, o primeiro relatório por `FORMAT_PRIORITY` (`coveragepy` excluído); `parser.parse`; `store.replace` ou `store.union` conforme o alvo; remove o diretório em `finally`.
- [ ] **Step 4: Rodar e ver passar.**
- [ ] **Step 5: Commit** — `feat: add adapter contract, process runner and run queue`.

### Task 12: Adaptador Jest

**Files:**
- Create: `src/adapters/nodeShared.ts`, `src/adapters/jest.ts`, `samples/node-jest/**` (yarn; `src/calc.js` com `add` e `divide`; `src/calc.test.js` testa só `add`; `src/other.test.js` testa `divide`), `scripts/setup-samples.mjs`
- Test: `test/unit/adapters/nodeShared.test.ts`, `test/unit/adapters/jest.test.ts`, `test/e2e/jest.e2e.test.ts`
- Modify: `.github/workflows/ci.yml` (job `e2e`: `node scripts/setup-samples.mjs && npm run test:e2e`)

**Interfaces:**
- Consumes: C7. Produces: `jestAdapter: Adapter`; de `nodeShared.ts`: `packageManagerOf(dir: string, fs: FsReader): Promise<'yarn' | 'pnpm' | 'npm'>`, `scriptTailCalls(pkg: PackageJson, tool: RegExp): string | undefined` (nome do script cuja linha termina na ferramenta, seguindo um nível de redirecionamento), `scriptCommand(pm, script: string, extra: readonly string[]): { command: string; args: string[] }`, `localBin(pm, bin: string, extra: readonly string[]): { command: string; args: string[] }`, `NODE_TEST_FILE: RegExp`.

- [ ] **Step 1: Testes unitários que falham.**

```ts
// nodeShared.test.ts
test.each([
  [{ test: 'jest' }, 'test'], [{ test: 'cross-env CI=1 jest --ci' }, 'test'],
  [{ test: 'react-scripts test' }, 'test'],
  [{ test: 'npm run test:unit', 'test:unit': 'jest' }, 'test:unit'],
  [{ test: 'jest && eslint .' }, undefined], [{ test: 'eslint . ; jest' }, undefined],
  [{ test: 'echo "Error: no test specified" && exit 1' }, undefined], [{}, undefined],
])('scriptTailCalls(%j) is %s', (scripts, expected) => {});
test('package manager comes from the nearest lockfile at or above the project, default npm', async () => {});
test('npm puts script arguments after "--"; yarn and pnpm do not', () => {
  expect(scriptCommand('npm', 'test', ['--coverage'])).toEqual({ command: 'npm', args: ['run', 'test', '--', '--coverage'] });
  expect(scriptCommand('yarn', 'test', ['--coverage'])).toEqual({ command: 'yarn', args: ['run', 'test', '--coverage'] });
});
test('localBin uses "yarn jest", "pnpm exec jest" and "npx --no-install jest"', () => {});

// jest.test.ts
test('detects by jest key, jest.config.*, or a test script that ends in jest or react-scripts test', async () => {});
test('jest only in devDependencies is not a Jest project', async () => {});
test('full plan uses the script when it tail-calls jest', async () => {
  // args terminam com '--coverage', '--coverageReporters=json', `--coverageDirectory=${tmp}`; env.CI === 'true'
});
test('full plan calls the local binary when there is no usable script', async () => {});
test('partial plan appends the paths relative to the project, with forward slashes, after extra args', async () => {});
test('isTestFile follows the default Jest patterns including .mjs/.cjs/.mts/.cts', async () => {});
```

- [ ] **Step 2: Rodar, implementar, rodar.** `hint`: `Jest did not write a coverage report. Check that the project's tests run with "--coverage".`
- [ ] **Step 3: Teste ponta a ponta que falha — `jest.e2e.test.ts`** (usa `runProject` real, `ParserClient` real e `exec` real):

```ts
test('full run reports add covered and divide uncovered', async () => {
  expect((await run({ kind: 'full' })).status).toBe('ok');   // com as duas suítes
  // calc.js: toda linha de add e de divide com contagem > 0
});
test('partial run of calc.test.js then other.test.js accumulates to full coverage', async () => {});
test('nothing is written inside the sample directory', async () => { /* git status --porcelain samples/node-jest vazio */ });
```

- [ ] **Step 4: Rodar** — `node scripts/setup-samples.mjs && npm run test:e2e` → verde.
- [ ] **Step 5: Commit** — `feat: add Jest adapter`. Mover a linha "Node support: Jest".

### Task 13: Adaptador Vitest

**Files:**
- Create: `src/adapters/vitest.ts`, `samples/node-vitest/**` (npm, TypeScript, com `@vitest/coverage-v8`; mesma forma do sample do Jest)
- Test: `test/unit/adapters/vitest.test.ts`, `test/e2e/vitest.e2e.test.ts`

**Interfaces:**
- Consumes: C7, `nodeShared`. Produces: `vitestAdapter: Adapter`.

- [ ] **Step 1: Testes unitários que falham.**

```ts
test('detects by vitest.config.*, a test block in vite.config.*, or a test script that ends in vitest', async () => {});
test('full plan passes --coverage, --coverage.reporter=json and --coverage.reportsDirectory=<tmp> with CI=true', async () => {});
test('when calling the local binary, the "run" subcommand is used', async () => { /* npx --no-install vitest run … */ });
test('partial plan appends relative paths after extra args', async () => {});
```

- [ ] **Step 2–4:** rodar, implementar, rodar; depois o ponta a ponta (mesmos três testes da Tarefa 12, sobre `samples/node-vitest`). `hint`: `Vitest did not write a coverage report. Install its coverage provider: "@vitest/coverage-v8".`
- [ ] **Step 5: Commit** — `feat: add Vitest adapter`. Mover a linha "Node support: Vitest".

### Task 14: Adaptador genérico de Node com `c8` embutido

**Files:**
- Create: `src/adapters/nodeGeneric.ts`, `samples/node-mocha/**` (JavaScript), `samples/node-mocha-ts/**` (TypeScript via `tsx`), `samples/node-test/**` (`node --test`), `samples/node-nyc/**` (script `nyc --reporter=lcov mocha`)
- Test: `test/unit/adapters/nodeGeneric.test.ts`, `test/e2e/nodeGeneric.e2e.test.ts`

**Interfaces:**
- Consumes: C7, `nodeShared`. Produces: `nodeGenericAdapter: Adapter`; `c8BinPath(extensionRoot: string): string` (`node_modules/c8/bin/c8.js`).

- [ ] **Step 1: Testes unitários que falham.**

```ts
test('detects a real test script or a .mocharc.* file; rejects the npm init placeholder', async () => {});
test('supportsPartial is false', async () => {});
test('full plan wraps the test command in the bundled c8 run by node', async () => {
  // command 'node'; args [c8Bin, '--reporter=json', `--reports-dir=${tmp}`, `--temp-directory=${tmp}/v8`, 'npm', 'run', 'test']
});
test('without a script but with .mocharc.*, the wrapped command is the local mocha binary', async () => {});
test('a script that already calls nyc or c8 is run unwrapped and the report is searched in the project', async () => {
  // steps[0] é o script puro; reportSearchDir === project.dir
});
```

- [ ] **Step 2: Rodar, implementar, rodar.** `hint` normal: `No coverage report was produced. Coverage for this project is collected with c8, which needs Node.js 18 or later.` `hint` do caso `nyc`/`c8`: `The test script runs its own coverage tool but wrote no report the extension can read. Add an "lcov" or "json" reporter.`
- [ ] **Step 3: Ponta a ponta que falha.**

```ts
test.each(['node-mocha', 'node-mocha-ts', 'node-test'])('%s: full run covers add and not divide', async (sample) => {});
test('node-mocha-ts reports the .ts source file, not transpiled output', async () => {});
test('node-nyc: the unwrapped script report is found in the project and ingested', async () => {});
```

- [ ] **Step 4: Rodar.** Se `node-mocha-ts` não reportar o `.ts` corretamente, este é o "segundo risco" do design: registrar o que foi observado e **parar para avisar o usuário** com as alternativas (aceitar a limitação documentada, ou tratar TypeScript em tempo de execução como caso de comando personalizado).
- [ ] **Step 5: Commit** — `feat: add generic Node adapter using bundled c8`. Mover a linha "Node support: any other tool, through c8".

### Task 15: Adaptador Python e conversão de `.coverage`

**Files:**
- Create: `src/adapters/python.ts`, `src/watcher/coveragepy.ts`, `samples/python-pytest/**` (`pyproject.toml`, `calc.py`, `tests/test_calc.py`, `tests/test_other.py`, `requirements.txt` com `pytest` e `pytest-cov`), `samples/python-pytest-configured/**` (`addopts = --cov=pkg` e um `pkg/unused.py` nunca importado), `samples/python-unittest/**` (só `coverage`)
- Modify: `src/vscode/reportWatcher.ts` (converte `.coverage` antes de ingerir), `package.json` (`coverageTools.python.interpreter`, `coverageTools.python.extraArgs`), `scripts/setup-samples.mjs` (um `.venv` por sample)
- Test: `test/unit/adapters/python.test.ts`, `test/unit/watcher/coveragepy.test.ts`, `test/e2e/python.e2e.test.ts`

**Interfaces:**
- Consumes: C6, C7.
- Produces: `pythonAdapter: Adapter`; `resolveInterpreter(projectDir: string, settings: Settings, fs: FsReader, selectedByPythonExtension: string | undefined): Promise<string>`; `conversionSpec(coverageFile: string, outXml: string, python: string): CommandSpec`.

- [ ] **Step 1: Testes unitários que falham.**

```ts
test('interpreter order: setting, project .venv, project venv, Python extension selection, python3', async () => {});
test('.venv uses bin/python on POSIX and Scripts\\python.exe on Windows', async () => {});
test.each([
  [{ pytest: true, pytest_cov: true, coverage: true }, ['-m', 'pytest', '--cov', '--cov-report=xml:<tmp>/coverage.xml']],
  [{ pytest: true, pytest_cov: false, coverage: true }, ['-m', 'coverage', 'run', '--data-file=<tmp>/.coverage', '-m', 'pytest']],
  [{ pytest: false, pytest_cov: false, coverage: true }, ['-m', 'coverage', 'run', '--data-file=<tmp>/.coverage', '-m', 'unittest', 'discover']],
])('probe %j plans %j', async (probe, firstStepArgs) => {});
test('the coverage.py variants add a second step: coverage xml --data-file=<tmp>/.coverage -o <tmp>/coverage.xml', async () => {});
test('no coverage.py installed: the plan has no steps and the hint names coverage and pytest-cov', async () => {});
test.each(['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini'])('--cov already in %s: no extra --cov is added, only --cov-report', async (file) => {});
test('every step sets COVERAGE_FILE to <tmp>/.coverage', async () => {});
test('partial paths come last, after python.extraArgs', async () => {});
test('isTestFile matches test_*.py and *_test.py', async () => {});
test('conversionSpec runs "<python> -m coverage xml --data-file=<file> -o <out>" in the file directory', () => {});
```

- [ ] **Step 2: Rodar, implementar, rodar.** A sondagem é um único `ctx.probe` com `<python> -c` que imprime um JSON com os três booleanos (via `importlib.util.find_spec`). `hint` sem coverage.py: `No coverage tool found in this project's Python environment. Install "coverage" or "pytest-cov".`
- [ ] **Step 3: Ponta a ponta que falha.**

```ts
test('pytest + pytest-cov: full run, then partial runs accumulate', async () => {});
test('project with --cov=pkg in addopts keeps its source filter', async () => {
  // pkg/unused.py aparece com 0%; os arquivos de teste não aparecem — igual ao terminal
});
test('unittest with only coverage.py installed', async () => {});
test('no .coverage or coverage.xml is written inside the sample directory', async () => {});
test('a .coverage written by "pytest --cov" in a terminal is converted and ingested by the watcher', async () => {
  // teste de interface: roda o pytest do sample por exec e espera a view mostrar calc.py
});
```

- [ ] **Step 4: Implementar a conversão no observador.** Ao receber um `.coverage`: resolver o interpretador do projeto dono (ou da pasta), executar `conversionSpec` para um diretório temporário, ingerir o XML resultante, remover o temporário. Falha na conversão vai só para o canal de saída. Em workspace não confiável o arquivo é ignorado.
- [ ] **Step 5: Rodar** — unitário, ponta a ponta e interface verdes.
- [ ] **Step 6: Commit** — `feat: add Python adapter and coverage.py data detection`. Mover a linha "Python support: pytest and unittest".

### Task 16: Adaptador .NET sobre VSTest

**Files:**
- Create: `src/adapters/dotnetShared.ts`, `src/adapters/dotnetVstest.ts`, `samples/dotnet-vstest-coverlet/**` (xUnit + `coverlet.collector`; biblioteca `Calc` e projeto `Calc.Tests` com `CalcTests.cs` e `OtherTests.cs`), `samples/dotnet-vstest-plain/**` (NUnit, sem coverlet), `samples/dotnet-vstest-msbuild/**` (`coverlet.msbuild`)
- Modify: `package.json` (`coverageTools.dotnet.collector`, `coverageTools.dotnet.extraArgs`), `scripts/setup-samples.mjs` (`dotnet restore`), `ci.yml` (`actions/setup-dotnet` 8.0.x no job `e2e`)
- Test: `test/unit/adapters/dotnetShared.test.ts`, `test/unit/adapters/dotnetVstest.test.ts`, `test/e2e/dotnetVstest.e2e.test.ts`

**Interfaces:**
- Consumes: C6, C7.
- Produces: `dotnetVstestAdapter: Adapter`; de `dotnetShared.ts`: `readProjectFacts(csproj: string, fs: FsReader): Promise<ProjectFacts>` com `ProjectFacts = { isTest: boolean; usesMtp: boolean; packages: ReadonlySet<string>; sdk: string; targetFrameworks: string[]; framework: 'mstest' | 'nunit' | 'xunit' | 'xunit3' | 'tunit' | undefined }`; `testClassesIn(source: string): string[]` (nomes qualificados); `hasTestAttributes(source: string): boolean`; `projectsInSolution(slnText: string, slnPath: string): string[]`.

- [ ] **Step 1: Testes unitários que falham.**

```ts
// dotnetShared.test.ts
test('facts merge the csproj with Directory.Build.props and Directory.Packages.props above it', async () => {});
test('package names are matched case-insensitively', async () => {});
test.each([
  ['Sdk="MSTest.Sdk"', true], ['<EnableMSTestRunner>true</EnableMSTestRunner>', true],
  ['<EnableNUnitRunner>true</EnableNUnitRunner>', true], ['<UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner>', true],
  ['<TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>', true],
  ['<PackageReference Include="TUnit" />', true], ['<PackageReference Include="Microsoft.NET.Test.Sdk" />', false],
])('usesMtp for %s is %s', async () => {});
test('global.json with test.runner "Microsoft.Testing.Platform" above the project sets usesMtp', async () => {});
test('MSTest.Sdk with <UseVSTest>true</UseVSTest> is not MTP', async () => {});
test('testClassesIn handles file-scoped and block namespaces and nested namespaces', () => {
  expect(testClassesIn('namespace A.B;\npublic class CalcTests { [Fact] public void T() {} }')).toEqual(['A.B.CalcTests']);
});
test('hasTestAttributes recognises Fact, Theory, Test, TestCase, TestMethod and DataTestMethod', () => {});
test('projectsInSolution reads .sln and .slnx and resolves backslash paths', () => {});

// dotnetVstest.test.ts
test('detects a test csproj that is not MTP', async () => {});
test.each([
  [['coverlet.collector'], ['--collect:XPlat Code Coverage']],
  [['coverlet.msbuild'], ['/p:CollectCoverage=true', '/p:CoverletOutputFormat=cobertura', '/p:CoverletOutput=<tmp>/']],
  [[], ['--collect:Code Coverage;Format=cobertura']],
])('packages %j choose collection args %j', async () => {});
test('the dotnet.collector setting overrides the automatic choice', async () => {});
test('full plan is dotnet test <csproj> <collection> --results-directory <tmp>', async () => {});
test('partial plan adds --filter with FullyQualifiedName~ for each test class, joined by |', async () => {});
test('a partial target with no test classes yields a plan with no steps and an explanatory hint', async () => {});
```

- [ ] **Step 2: Rodar, implementar, rodar.**
- [ ] **Step 3: Ponta a ponta que falha** (instalar antes `dotnet-sdk-8.0` pelo `apt`):

```ts
test.each(['dotnet-vstest-coverlet', 'dotnet-vstest-plain', 'dotnet-vstest-msbuild'])('%s: full run reports Add covered and Divide uncovered', async () => {});
test('coverlet sample: partial runs of two test files accumulate', async () => {});
test('no TestResults folder is created inside the sample', async () => {});
```

- [ ] **Step 4: Rodar.** Se uma linha de comando do design não funcionar como escrita, corrigir o adaptador **e** a tabela da seção 5.3 do design no mesmo commit, e listar a correção na mensagem de commit.
- [ ] **Step 5: Commit** — `feat: add .NET VSTest adapter`. Mover a linha ".NET support: VSTest".

### Task 17: Adaptador .NET sobre Microsoft.Testing.Platform

**Files:**
- Create: `src/adapters/dotnetMtp.ts`, `samples/dotnet-mtp-mstest/**`, `samples/dotnet-mtp-nunit/**`, `samples/dotnet-mtp-xunit3/**`, `samples/dotnet-mtp-tunit/**` (todos com `Microsoft.Testing.Extensions.CodeCoverage`), `samples/dotnet-mtp-nocoverage/**` (xUnit v3 sem o pacote)
- Test: `test/unit/adapters/dotnetMtp.test.ts`, `test/e2e/dotnetMtp.e2e.test.ts`

**Interfaces:**
- Consumes: C7, `dotnetShared`. Produces: `dotnetMtpAdapter: Adapter`; `mtpFilterArgs(framework: ProjectFacts['framework'], classes: readonly string[]): string[] | undefined`.

- [ ] **Step 1: Testes unitários que falham.**

```ts
test('detects a test csproj that uses MTP', async () => {});
test('full plan is dotnet run --project <csproj> -- --coverage --coverage-output-format cobertura --coverage-output <tmp>/coverage.cobertura.xml', async () => {});
test('a multi-targeted project adds --framework with the first target', async () => {});
test.each([
  ['mstest', ['A.B.C'], ['--filter', 'FullyQualifiedName~A.B.C']],
  ['nunit', ['A.B.C', 'A.D'], ['--filter', 'FullyQualifiedName~A.B.C|FullyQualifiedName~A.D']],
  ['xunit3', ['A.B.C', 'A.D'], ['--filter-class', 'A.B.C', '--filter-class', 'A.D']],
  ['tunit', ['A.B.C'], ['--treenode-filter', '/*/A.B/C/*']],
  [undefined, ['A.B.C'], undefined],
])('mtpFilterArgs(%s, %j) is %j', () => {});
test('supportsPartial is true only when mtpFilterArgs is defined for the project framework', async () => {});
```

- [ ] **Step 2: Rodar, implementar, rodar.** `hint`: `The test project did not write a coverage report. Microsoft.Testing.Platform projects need the "Microsoft.Testing.Extensions.CodeCoverage" package.`
- [ ] **Step 3: Ponta a ponta que falha.**

```ts
test.each(['mstest', 'nunit', 'xunit3', 'tunit'])('dotnet-mtp-%s: full run reports Add covered and Divide uncovered', async () => {});
test.each(['mstest', 'nunit', 'xunit3', 'tunit'])('dotnet-mtp-%s: a partial run of one test file runs only that class', async () => {
  // a cobertura de Divide continua 0 depois de rodar só CalcTests.cs
});
test('dotnet-mtp-nocoverage: the run ends as no-report with the package hint', async () => {});
```

- [ ] **Step 4: Rodar e ajustar à realidade.** Para cada framework cujo teste de execução parcial não passar depois de corrigir a sintaxe com base na ajuda da própria ferramenta (`dotnet run --project <csproj> -- --help`): remover o framework de `mtpFilterArgs` (fica "só execução completa"), ajustar o teste unitário e o ponta a ponta correspondentes, corrigir a seção 5.3 do design e listar o framework no `README.md` em "Known limitations". O mesmo vale para a linha de comando da execução completa.
- [ ] **Step 5: Commit** — `feat: add .NET Microsoft.Testing.Platform adapter`. Mover a linha ".NET support: Microsoft.Testing.Platform".

### Task 18: Descoberta de projetos e alvos elegíveis

**Files:**
- Create: `src/adapters/custom.ts`, `src/adapters/index.ts`, `src/discovery.ts`
- Test: `test/unit/discovery.test.ts` (árvores reais em diretório temporário, `FsReader` sobre `node:fs`), `test/unit/adapters/custom.test.ts`

**Interfaces:**
- Consumes: C6, C7 e todos os adaptadores. Produces: C9; `ADAPTERS: readonly Adapter[]` na ordem `jest`, `vitest`, `node-generic`, `python`, `dotnet-vstest`, `dotnet-mtp`; `customAdapter: Adapter`.

- [ ] **Step 1: Testes que falham.**

```ts
test('finds one project per ecosystem in a mixed workspace', async () => { /* 3 projetos, adaptadores certos */ });
test('excluded directories are never searched', async () => { /* package.json em node_modules é ignorado */ });
test('in one Node directory the order is custom, jest, vitest, node-generic', async () => {});
test('nested Node projects: inner by default, outer with nestedProjects "outer"', async () => {
  // raiz com script test + packages/a e packages/b com jest → inner: [a, b]; outer: [raiz]
});
test('nesting is per ecosystem: a Python project inside a Node project keeps both', async () => {});
test('.NET projects are never dropped by the nesting rule', async () => {});
test('Python: the project is the nearest marker directory above the test files; with no marker, the workspace folder', async () => {});
test('a custom command directory becomes a project and suppresses every discovered project inside it', async () => {});
test('custom command keys are relative to their own workspace folder in a multi-root workspace', async () => {});
test('runnable paths', async () => {
  // contém: arquivo que define cada projeto; diretório de cada projeto; ancestrais até a pasta do workspace;
  // .sln com ao menos um projeto de testes; arquivos de teste e seus diretórios quando supportsPartial
  // não contém: arquivo-fonte comum; arquivo de teste de projeto node-generic; .sln sem projeto de testes
});
test('a .cs file without test attributes inside a test project is not runnable', async () => {});
test('resolveTarget', () => {
  // arquivo de definição → [{project, full}];  .sln → full de cada projeto de testes da solução;
  // pasta com dois projetos → dois full;  pasta dentro de projeto → [{project, partial:[pasta]}];
  // arquivo de teste → [{project, partial:[arquivo]}];  caminho não elegível → []
});
test('an MTP project with an unknown framework is runnable as a whole but its test files are not', async () => {});

// custom.test.ts
test('the plan runs the command line through a shell with ${coverageDir} replaced by the temp directory', async () => {});
test('supportsPartial is false', async () => {});
```

- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.** Uma única chamada `fs.find` por pasta do workspace para todos os marcadores (`**/*.csproj`, `**/*.sln`, `**/*.slnx`, `**/package.json`, `**/pyproject.toml`, `**/setup.py`, `**/setup.cfg`, `**/pytest.ini`, `**/tox.ini`, `**/test_*.py`, `**/*_test.py`), com as exclusões. O conteúdo de `.cs` só é lido para arquivos dentro de projetos de teste, em lotes de 20 com devolução do controle entre lotes (`setImmediate`). A regra de aninhamento vale para `node` e `python`.
- [ ] **Step 4: Rodar e ver passar.**
- [ ] **Step 5: Commit** — `feat: discover test projects and runnable targets`.

### Task 19: Ligação ao VS Code — Run All, botão direito, confiança

**Files:**
- Create: `src/vscode/fsReader.ts`, `src/vscode/commands.ts`
- Modify: `src/extension.ts`, `src/vscode/reportWatcher.ts` (supressão), `package.json` (comandos `coverageTools.runAll` — `Coverage Tools: Run All Coverage` — e `coverageTools.runHere` — `Coverage Tools: Run Coverage Here`; menus `explorer/context` com `when: resourcePath in coverageTools.runnablePaths`, `view/title` da view de testes para `runAll`; configurações restantes de C6, todas com escopo `resource`; `commandPalette` oculta `runHere`)
- Test: `test/ui/run.ui.test.ts` sobre `samples/samples.code-workspace` (pastas `node-jest`, `python-pytest`, `dotnet-vstest-coverlet`)

**Interfaces:**
- Consumes: tudo de C3–C10, `Publisher`, `StatusBar`, `ReportWatcher`.
- Produces: `vscodeFsReader(): FsReader` (sobre `workspace.findFiles` e `workspace.fs`); `registerCommands(deps): vscode.Disposable`; `ExtensionApi.ready` resolve quando a primeira descoberta termina.

- [ ] **Step 1: Testes de interface que falham.**

```ts
test('Run All Coverage runs every project and the view shows files from all three ecosystems', async () => {
  // calc.js, calc.py e Calc.cs presentes; notificação de progresso visível durante a execução
});
test('running one project again keeps the other two on screen', async () => {});
test('the Explorer menu shows Run Coverage Here on a test file and not on a plain source file', async () => {
  // botão direito em calc.test.js → item presente; em calc.js → ausente
});
test('Run Coverage Here on a test file runs a partial run that adds to the project', async () => {});
test('a run made by the extension is not ingested a second time by the watcher', async () => {
  // python-pytest-configured grava relatório no workspace; após execução parcial, a cobertura do projeto não cai
});
test('cancelling the progress notification stops the run and empties the queue', async () => {});
test('with no test project in the workspace, Run All shows "No test projects found in this workspace."', async () => {});
test('a failing run shows an error with a "Show Output" action and the adapter hint', async () => {});
test('in an untrusted workspace the run commands are unavailable and written reports are still picked up', async () => {
  // harness sem --disable-workspace-trust, workspace não confiado
});
```

- [ ] **Step 2: Implementar.**
  - `activate`: registra comandos, cria `Publisher`, `RunQueue`, `StatusBar` (agora recebendo a fila), `ReportWatcher`, e devolve a API. Depois de devolver, agenda a descoberta com `setImmediate`. Nada de arquivo é lido antes disso.
  - Descoberta: ao terminar, grava `setContext('coverageTools.runnablePaths', objeto caminho → true)`. Observadores para os marcadores da Tarefa 18 e para `.cs` dentro de projetos de teste refazem a descoberta com debounce de 750 ms; mudança em `.cs` reavalia só aquele arquivo.
  - `runAll`: enfileira `runProject` para cada projeto, dentro de `window.withProgress` com cancelamento ligado a `queue.cancelAll()` e mensagem `Running coverage: <nome> (n/N)`.
  - `runHere(uri)`: `resolveTarget` e enfileira cada item. Sem itens: `No tests to run here.`
  - Resultado por execução: `tests-failed` → aviso `Tests failed in <nome>; coverage was still loaded.`; `no-report`, `bad-report`, `spawn-error` → erro com `hint` e ação `Show Output`; `cancelled` → nada.
  - `suppress`: conjunto de chaves em execução mais as liberadas há menos de 2.000 ms, consultado por `ReportWatcher`.
  - Confiança: `runAll` e `runHere` têm `enablement: isWorkspaceTrusted`; a conversão de `.coverage` verifica `workspace.isTrusted`; ao conceder confiança (`onDidGrantWorkspaceTrust`) nada precisa ser refeito.
- [ ] **Step 3: Rodar** — `npm test && xvfb-run -a npm run test:ui` → verde.
- [ ] **Step 4: Commit** — `feat: add Run All Coverage and Run Coverage Here`. Mover as linhas de Run All, Run Coverage Here, comando personalizado, monorepos e workspaces não confiáveis.

---

## Fase 3 — Leveza, documentação e entrega

### Task 20: Metas de leveza

**Files:**
- Create: `test/perf/activation.perf.test.ts`, `test/perf/ingest.perf.test.ts`, `test/perf/fakeVscode.ts`, `scripts/gen-big-report.mjs`
- Modify: `ci.yml` (job `perf`: `npm run build && npm run test:perf`)

**Interfaces:**
- Consumes: `dist/extension.js`, `dist/worker.js`, `ParserClient`, `CoverageStore`.

- [ ] **Step 1: Escrever os testes.**

```ts
// activation.perf.test.ts — carrega dist/extension.js com o módulo 'vscode' substituído por fakeVscode
test('activate performs no file reads', async () => {
  // espiões em node:fs (sync, callback e promises) e em fakeVscode.workspace.fs / findFiles
  // contagem de chamadas entre o início e o retorno de activate() === 0
});
test('activate returns in under 20 ms', async () => { /* mediana de 20 execuções em processos novos */ });
test('no timer is pending once discovery has settled on an empty workspace', async () => {
  // await api.ready; process.getActiveResourcesInfo() não contém 'Timeout'
});

// ingest.perf.test.ts — relatório Cobertura sintético de 5.000 arquivos × 200 linhas
test('ingesting 5,000 files never blocks the main thread for 50 ms', async () => {
  // perf_hooks.monitorEventLoopDelay({ resolution: 5 }) durante parse → store.replace → merged()
  // histogram.max < 50 ms
});
test('5,000 accumulated files add less than 50 MB', async () => {
  // global.gc() antes e depois; diferença de heapUsed + arrayBuffers < 50 * 1024 * 1024
});
test('a partial-run union over 5,000 files stays under the same 50 ms bound', async () => {});
```

- [ ] **Step 2: Rodar** — `npm run build && npm run test:perf`.
- [ ] **Step 3: Corrigir o que estourar.** Remédios na ordem: fatiar `store.replace`/`union`/`merged` em lotes com devolução do controle; adiar o cálculo de resumos; reduzir o que o worker transfere. Se uma meta continuar fora depois disso, **parar e reportar ao usuário** com o número medido; não alterar o limite no teste.
- [ ] **Step 4: Commit** — `test: enforce the lightweight budgets`. Mover a linha "Lightweight operation".

### Task 21: Capturas de tela e seção de uso do README

**Files:**
- Create: `scripts/screenshots.mjs`, `docs/images/01-run-all.png`, `02-coverage-view.png`, `03-line-detail.png`, `04-explorer-menu.png`, `05-terminal-detection.png`, `06-status-bar.png`
- Modify: `README.md` (seção "Usage" com uma imagem por passo; remover a frase que diz que as capturas serão adicionadas), `package.json` (script `screenshots`), `CHANGELOG.md`

**Interfaces:**
- Consumes: harness da Tarefa 2, `samples/samples.code-workspace`.

- [ ] **Step 1: Escrever o script.** Usa `launchVSCode` com o tema padrão e janela 1280×800, e grava com `page.screenshot`. Roteiro, na ordem: (1) paleta aberta com `Run All Coverage` digitado; (2) view Test Coverage com os três projetos, após a execução terminar; (3) `calc.js` aberto com a cobertura em linha ligada; (4) menu de contexto do Explorer sobre `calc.test.js` com `Run Coverage Here` em destaque; (5) terminal integrado depois de `yarn test --coverage` em `node-jest`, com a view atualizada ao lado; (6) recorte da barra de status com o total.
- [ ] **Step 2: Rodar** — `xvfb-run -a npm run screenshots` → seis arquivos PNG.
- [ ] **Step 3: Conferir cada imagem abrindo-a.** Cada uma deve mostrar o que o passo descreve, sem diálogo de erro, sem notificação sobreposta e com texto legível. Refazer o que não servir.
- [ ] **Step 4: Atualizar o README.** Em "Usage", cada passo ganha `![<descrição>](docs/images/<arquivo>.png)` logo abaixo do texto. Conferir que todo comando, configuração e limitação citados no README existe com o mesmo nome no `package.json` e no código.
- [ ] **Step 5: Commit** — `docs: add usage screenshots to the README`. Mover a linha "Usage screenshots".

### Task 22: Empacotamento e primeira versão

**Files:**
- Modify: `package.json` (`version` `0.1.0`, `repository`, `categories: ["Testing"]`, `keywords`, `icon` se houver), `.vscodeignore`, `CHANGELOG.md` (seção `[0.1.0] - <data>` com tudo o que está em `Done`, em `Added`; `Unreleased` volta a ter só os três subtítulos), `README.md` (remover o aviso "in design"; "Installation" com o passo de instalar o `.vsix`; tabela de estado com tudo o que foi entregue como `Released in 0.1.0`), `ci.yml` (job `package`: `npm run package` e upload do `.vsix`), `docs/superpowers/specs/2026-11-24-coverage-tools-design.md` (status "implementado na 0.1.0" e lista de desvios registrados nas Tarefas 2, 14, 16, 17 e 20)
- Test: `test/ui/vsix.ui.test.ts`

**Interfaces:**
- Consumes: tudo.

- [ ] **Step 1: Teste que falha — `vsix.ui.test.ts`.**

```ts
test('the packaged .vsix installs into a clean VS Code and Run All works', async () => {
  // instala com `<code> --install-extension <vsix>` em diretórios temporários, sem --extensionDevelopmentPath;
  // abre samples/node-mocha (usa o c8 embutido) e roda Run All → a view mostra calc.js
});
test('the .vsix contains dist, the bundled c8 and no source or test files', async () => {
  // lista do zip: tem extension/dist/extension.js, extension/dist/worker.js, extension/node_modules/c8/bin/c8.js;
  // não tem extension/src/, extension/test/, extension/samples/
});
```

- [ ] **Step 2: Rodar e ver falhar; ajustar `.vscodeignore` e o script `package` (`vsce package --no-yarn`); rodar e ver passar.**
- [ ] **Step 3: Verificação completa** — `npm run lint && npm run build && npm run check:size && npm test && npm run test:e2e && npm run test:perf && xvfb-run -a npm run test:ui && npm run package`. Tudo verde, e anotar o tamanho final do `.vsix` e o tempo de ativação medido.
- [ ] **Step 4: Conferência manual da ativação.** Com o harness, abrir "Developer: Show Running Extensions" e registrar o tempo de ativação mostrado para Coverage Tools; deve estar abaixo de 20 ms.
- [ ] **Step 5: Commit** — `chore: release 0.1.0`.

### Task 23: Publicação automática do `.vsix` (mesmo esquema do GitTools)

Pedido do usuário depois da aprovação do plano: ao publicar, gerar e entregar o `.vsix` automaticamente, como o workflow `publish-extension.yml` do repositório `DaniloFG/GitTools`. Uma cópia de leitura daquele repositório está em `/home/user/danilofg/gittools` (workflow em `.github/workflows/publish-extension.yml`, script em `scripts/extension-version.mjs`); use-a como referência de estrutura, sem copiar os portões de texto específicos daquele projeto.

**Files:**
- Create: `.github/workflows/publish-extension.yml`, `scripts/extension-version.mjs`, `scripts/release-notes.mjs`
- Modify: `package.json` (script `package` grava em `release/` com `--baseContentUrl https://github.com/DaniloFG/CoverageTools/blob/main --baseImagesUrl https://github.com/DaniloFG/CoverageTools/raw/main`), `.gitignore` (`release/`), `.github/workflows/ci.yml` (o job `package` usa o mesmo script e guarda `release/*.vsix`), `README.md` ("Installation": baixar o `.vsix` da página de Releases e instalar com `Extensions: Install from VSIX...`), `CHANGELOG.md`, `test/ui/vsix.ui.test.ts` (caminho do `.vsix`)
- Test: `test/unit/scripts/extensionVersion.test.ts`, `test/unit/scripts/releaseNotes.test.ts`, `test/unit/scripts/publishWorkflow.test.ts`

**Interfaces:**
- Produces: `nextExtensionVersion(fileVersion: string, tags?: string[]): string` (em `scripts/extension-version.mjs`; executado direto, imprime a versão a partir do `package.json` da raiz e de `git tag -l 'v*'`); `releaseNotes(changelog: string, version: string, allowNeutral: boolean): string` (em `scripts/release-notes.mjs`; executado como `node scripts/release-notes.mjs <versão> <arquivo de saída> <neutral|strict>`).

- [ ] **Step 1: Testes que falham.**

```ts
// extensionVersion.test.ts
test.each([
  ['0.1.0', [], '0.1.0'],                         // sem tag: vale a do arquivo
  ['0.2.0', ['v0.1.3'], '0.2.0'],                 // arquivo acima da última tag: subida manual
  ['0.1.0', ['v0.1.0'], '0.1.1'],                 // igual: próximo patch
  ['0.1.0', ['v0.1.9', 'v0.1.10'], '0.1.11'],     // comparação numérica, não de texto
  ['0.1.0', ['v0.1.2', 'nightly', 'v1'], '0.1.3'],// tags fora do formato são ignoradas
])('nextExtensionVersion(%s, %j) is %s', (file, tags, expected) => expect(nextExtensionVersion(file, tags)).toBe(expected));
test('an invalid file version throws', () => expect(() => nextExtensionVersion('1.0')).toThrow());

// releaseNotes.test.ts
test('uses the section of the version when the changelog has one', () => { /* corpo de "## [0.1.0] - …" até o próximo "## [" */ });
test('otherwise uses the Done list under Unreleased', () => {});
test('with nothing to say: neutral mode returns "Maintenance release."; strict mode throws', () => {});

// publishWorkflow.test.ts — lê o YAML como texto e como objeto (python3 -c "import yaml, json" via execFileSync)
test('triggers on push to main, on v* tags and manually with a version input', () => {});
test('top-level permissions are read-only and only the publish job can write contents', () => {});
test('no ${{ github.event.* }} expression appears inside a run: block', () => { /* entradas do evento só por env */ });
test('the release step has no condition: the .vsix is always attached to a GitHub release', () => {});
```

- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar.** O workflow segue a ordem do GitTools: `checkout` com `fetch-depth: 0`; Node 22 com cache npm; `npm ci`; `lint`, `build`, `check:size`, `npm test`; definir a versão (entrada manual, ou a da tag, ou `scripts/extension-version.mjs`), validar `x.y.z` e gravá-la no `package.json`; gerar as notas com `scripts/release-notes.mjs` (modo `neutral` só em push na branch); `npm run package`; publicar no Marketplace se existir o segredo `VSCE_PAT` (versão já publicada vira aviso, não erro); publicar no Open VSX se existir `OVSX_PAT`; anexar `release/*.vsix` a um release `v<versão>` com `softprops/action-gh-release@v2` e `body_path` das notas; guardar o `.vsix` como artifact `coverage-tools-vsix`. `concurrency: publish-extension`, sem cancelamento. Filtro de caminhos no push: `src/**`, `scripts/**`, `package.json`, `package-lock.json`, `esbuild.mjs`, `tsconfig.json`, `.vscodeignore`, `README.md`, `CHANGELOG.md`, `docs/images/**`. **Diferença deliberada em relação ao GitTools:** lá o release só é criado em tag ou quando o Marketplace publicou; aqui o release com o `.vsix` é criado sempre, porque o pedido é entregar a extensão a cada publicação mesmo sem Marketplace configurado.
- [ ] **Step 4: Rodar e ver passar; simular o passo de versão** — executar localmente o trecho de shell do passo "definir a versão" com `INPUT_VERSION` vazio, com `0.3.0` e com `abc` (este deve falhar), e `npm run package` deve produzir `release/coverage-tools-<versão>.vsix`.
- [ ] **Step 5: Commit** — `ci: publish the .vsix automatically on release`. Acrescentar ao `CHANGELOG.md` a linha sobre releases automáticos.
