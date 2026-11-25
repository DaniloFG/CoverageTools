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

