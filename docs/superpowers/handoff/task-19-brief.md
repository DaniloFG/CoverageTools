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

