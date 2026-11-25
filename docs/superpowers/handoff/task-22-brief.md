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

