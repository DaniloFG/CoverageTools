# Coverage Tools — design

Data: 2026-11-24
Status: aguardando aprovação

## 1. Intenção e porquê

O VS Code mostra cobertura de testes de forma nativa (view "Test Coverage",
percentual e barra por arquivo, linhas marcadas no editor), mas só de **uma
execução por vez**. Em um workspace com vários projetos ou várias pastas
(multi-root), rodar a cobertura do projeto B faz a do projeto A sumir.

**Coverage Tools** é uma extensão do VS Code que funciona como um
**acumulador**: guarda a cobertura de todos os projetos do workspace, exibe
tudo junto pela API nativa de testes e, quando um projeto é reexecutado,
atualiza só a parte dele.

Público: quem desenvolve em workspaces com vários projetos .NET e/ou
JavaScript/TypeScript com Jest e quer a visão de cobertura do workspace
inteiro sem sair da interface nativa.

## 2. Objetivos, não-objetivos e anti-objetivos

### Objetivos

1. Exibir, pela API nativa de cobertura do VS Code, a cobertura acumulada de
   todos os projetos do workspace: percentual e barra por arquivo e por pasta,
   e detalhe linha a linha no editor.
2. Manter essa cobertura até que uma nova execução a atualize ou o VS Code
   (ou a extensão) reinicie.
3. Detectar sozinha execuções de teste com cobertura feitas fora da extensão
   (terminal, tasks, scripts) e incorporá-las.
4. Oferecer um comando para rodar a cobertura de todos os projetos de uma vez.
5. Oferecer, no botão direito do Explorer, a execução da cobertura de um
   projeto, pasta ou arquivo de teste. O item de menu só aparece onde há
   testes de fato.
6. Suportar `dotnet test` (relatório Cobertura) e Jest (via `yarn`/`npm`/`pnpm`).
7. Manter um `README.md` em inglês que explique o que a ferramenta faz e
   reflita sempre o estado real do que está implementado, e um `CHANGELOG.md`
   em inglês que registre o que está planejado, em andamento e entregue.

### Não-objetivos (primeira versão)

- Guardar cobertura entre reinícios do VS Code. A extensão começa vazia.
- Outros frameworks (Vitest, Mocha, pytest etc.).
- Cobertura por teste individual ("qual teste cobriu esta linha").
- Substituir o Test Explorer do C# Dev Kit ou da extensão do Jest.
- Histórico, tendências ou metas mínimas de cobertura.
- Publicação no Marketplace. A entrega é o código e um `.vsix` instalável.

### Anti-objetivos

- Ter aparência diferente do nativo (decorações próprias no estilo Coverage
  Gutters, árvore própria de cobertura).
- Perder a cobertura acumulada de outros projetos quando um projeto roda.
- Exigir que o usuário altere a configuração dos projetos dele para a
  extensão funcionar.

## 3. Restrições

- **A API nativa mostra uma execução por vez.** Não existe "somar" na API. A
  extensão contorna isso guardando o acumulado e republicando o conjunto
  inteiro como uma nova execução (`TestRun`) a cada mudança.
- **Execuções de outras extensões tomam a tela.** Se o usuário rodar
  cobertura pelo C# Dev Kit ou pela extensão do Jest, o VS Code passa a
  exibir a execução delas. A extensão não tem como impedir nem detectar isso.
  O acumulado permanece em memória e o comando "Show Coverage" o republica.
- **Só existe cobertura se o teste gravar relatório.** `dotnet test` sem
  coletor e `yarn test` sem `--coverage` não geram nada e são ignorados.
- **Dados podem ficar defasados.** Se um arquivo é editado depois da
  execução, as linhas marcadas podem não corresponder mais. O nativo tem o
  mesmo comportamento.
- **Ambiente de desenvolvimento.** No contêiner onde a extensão está sendo
  construída não há .NET SDK e o download do VS Code é bloqueado pela rede.
  Ver a seção 9 para o impacto na verificação.
- API mínima: `engines.vscode` `^1.90.0` (a API de cobertura é estável desde
  a 1.88).

## 4. Abordagens consideradas

1. **Acumulador + observador de relatórios (escolhida).** A extensão mantém
   em memória a cobertura por projeto e republica o conjunto pela API nativa.
   Observa os arquivos de relatório no disco e também tem comandos próprios
   de execução. Cobre execuções vindas de qualquer lugar e mantém um único
   caminho de leitura de relatórios. Custo: precisa de regras de mesclagem.
2. **Só execuções disparadas pela extensão.** Mais simples, e a extensão
   sempre sabe o escopo do que rodou. Descartada porque um `dotnet test` com
   cobertura no terminal passaria despercebido, e detectar é um requisito.
3. **Interceptar comandos do terminal** (integração de shell). Descartada:
   depende de a integração de shell estar ativa, não enxerga tasks nem
   scripts, e interpretar linhas de comando arbitrárias é frágil.
4. **Decorações e árvore próprias.** Descartada: é o que o Coverage Gutters
   faz e contraria o requisito de ter a cara do nativo.

Decisão do usuário: o "como" foi delegado; a abordagem 1 foi a escolhida por
quem escreveu este design e apresentada na conversa.

## 5. Comportamento

### 5.1 O que o usuário vê

A view nativa **Test Coverage**, as barras no Explorer e as marcações de
linha no editor, exatamente como em uma execução nativa com cobertura, mas
com os arquivos de todos os projetos do workspace:

```
TEST COVERAGE
▾ api            (pasta 1 do workspace)
    Services/OrderService.cs      █████████░  91%
    Services/TaxService.cs        ███░░░░░░░  34%
▾ web            (pasta 2 do workspace)
    components/Cart.tsx           ████████░░  80%
```

As cores (vermelho, amarelo, verde) e os limites vêm da configuração nativa
`testing.coverageBarThresholds`. A extensão não implementa cores próprias.

Além disso, um item na barra de status mostra o percentual total acumulado
(linhas cobertas ÷ linhas totais de todos os arquivos) e indica quando há
execução em andamento. Clicar nele executa "Show Coverage".

### 5.2 Projetos

Um **projeto** é a unidade de armazenamento e de execução:

- **.NET:** um `.csproj` de testes — que referencia `Microsoft.NET.Test.Sdk`
  ou declara `<IsTestProject>true</IsTestProject>`.
- **Jest:** um diretório com `package.json` que tem configuração própria de
  Jest: a chave `jest` no `package.json`, um arquivo `jest.config.*`, ou um
  script `test` que chama `jest` ou `react-scripts test`. Ter `jest` apenas
  nas dependências não basta.

A extensão descobre os projetos em todas as pastas do workspace na ativação
e redescobre quando `.csproj`, `package.json`, `jest.config.*` ou as pastas
do workspace mudam. Ignora `node_modules`, `bin` e `obj`.

**Projetos Jest aninhados (monorepo).** Quando um diretório que se qualifica
contém outros diretórios que também se qualificam, só os de dentro são
projetos. O de fora é tratado como orquestrador e não é executado, para não
rodar os mesmos testes duas vezes nem repassar argumentos do Jest a um
script que só distribui a execução. *(Decisão de quem escreveu o design, a
confirmar com o usuário.)*

**.NET sobre Microsoft.Testing.Platform.** A primeira versão executa apenas
projetos baseados em VSTest. Projetos que usam o Microsoft.Testing.Platform
(`MSTest.Sdk`, `<TestingPlatformDotnetTestSupport>`,
`<EnableMSTestRunner>`, `<UseMicrosoftTestingPlatformRunner>`, ou
`global.json` selecionando esse executor) são reconhecidos e marcados como
não suportados: ficam fora do "Run All" e do botão direito, com um aviso
único e uma linha no canal de saída explicando o motivo. Relatórios
Cobertura gerados por eles fora da extensão continuam sendo detectados e
incorporados normalmente. *(Decisão de quem escreveu o design, a confirmar
com o usuário.)*

### 5.3 Formas de alimentar o acumulado

**A. Execução pela extensão.** A extensão roda o comando, grava o relatório
em um diretório temporário próprio (fora do workspace) e o lê ao terminar.

| Alvo | Comando |
|------|---------|
| Projeto .NET | `dotnet test "<csproj>" --collect:"XPlat Code Coverage" --results-directory "<tmp>"` |
| Arquivo ou pasta de teste .NET | o mesmo, mais `--filter` com as classes de teste encontradas no arquivo/pasta (`FullyQualifiedName~Namespace.Classe`, unidas por `\|`) |
| Projeto Jest | `<pm> test --coverage --coverageReporters=json --coverageDirectory="<tmp>"`, com `CI=true` no ambiente para evitar modo watch |
| Arquivo ou pasta de teste Jest | o mesmo, mais o caminho relativo como filtro de testes |

`<pm>` é `yarn`, `pnpm` ou `npm`, escolhido pelo lockfile presente (padrão
`yarn` na ausência de lockfile). Com `npm`, os argumentos vão depois de `--`.

**B. Execução externa detectada.** A extensão observa arquivos de relatório
no workspace e, quando um aparece ou muda, lê e incorpora:

- `**/TestResults/**/*.cobertura.xml`
- `**/coverage/coverage-final.json`
- `**/coverage/lcov.info`
- `**/coverage/cobertura-coverage.xml`

O relatório é atribuído ao projeto descoberto mais próximo acima dele na
árvore de diretórios. Mudanças são agrupadas por uma pequena janela de
espera (debounce); se vários formatos aparecem juntos para o mesmo projeto,
usa-se um só, nesta ordem de preferência: Istanbul JSON, Cobertura, LCOV.

**Relatório sem projeto dono.** Acontece, por exemplo, com
`dotnet test --results-directory ./TestResults` na raiz de uma solução: os
relatórios de todos os projetos caem em `TestResults/<GUID novo>/`, sem
`.csproj` acima, e o relatório não diz qual projeto de testes o gerou. Nesse
caso a chave é a **raiz de resultados** (o diretório acima da pasta de GUID
no padrão `TestResults`, ou o diretório do relatório nos demais casos) mais
uma **assinatura do conteúdo** (a lista ordenada dos assemblies/pacotes do
relatório). Um relatório novo substitui o anterior de mesma chave, de modo
que reexecutar atualiza em vez de acumular lixo, e os relatórios de projetos
diferentes de uma mesma execução não se sobrescrevem. Limitação aceita: dois
projetos de teste que instrumentam exatamente o mesmo conjunto de assemblies
e gravam na mesma raiz compartilhada são confundidos, e o último substitui o
anterior. *(Decisão de quem escreveu o design.)*

Relatórios que já existem no disco quando a extensão inicia **não** são
carregados (a extensão começa vazia).

### 5.4 Regras de mesclagem

O acumulado é um mapa `projeto → cobertura por arquivo`.

- **Execução completa de um projeto** (pela extensão, ou qualquer execução
  externa detectada) **substitui** os dados daquele projeto.
- **Execução parcial pela extensão** (arquivo ou pasta de teste) **soma** aos
  dados do projeto: as contagens de execução de cada linha, ramo e função são
  somadas, e nada do que já estava coberto é derrubado.
- **A exibição é a união entre projetos.** Se dois projetos de teste cobrem o
  mesmo arquivo-fonte (por exemplo, uma biblioteca compartilhada), as
  contagens são somadas na exibição.
- Depois de cada alteração no acumulado, o conjunto inteiro é republicado.
  Em "Run All", isso acontece ao fim de cada projeto, para a tela ir
  enchendo.

Consequência conhecida: uma execução parcial feita no **terminal** é tratada
como completa e substitui os dados do projeto. Para execução parcial sem
perda, usa-se o botão direito.

### 5.5 Comandos e menus

| Comando | Onde | O que faz |
|---------|------|-----------|
| `Coverage Tools: Run All Coverage` | paleta, título da view de testes | Roda todos os projetos descobertos, um por vez, com progresso e cancelamento |
| `Coverage Tools: Run Coverage Here` | botão direito no Explorer | Roda a cobertura do alvo clicado (ver abaixo) |
| `Coverage Tools: Show Coverage` | paleta, barra de status | Republica o acumulado (traz a exibição de volta) |
| `Coverage Tools: Clear Coverage` | paleta | Esvazia o acumulado e fecha a exibição nativa |

Alvos válidos do botão direito, e o que cada um executa:

- `.csproj` de testes → execução completa do projeto.
- `.sln` → execução completa de cada projeto de testes listado na solução.
- `package.json` de projeto Jest → execução completa do projeto.
- Pasta que contém um ou mais projetos (inclusive a raiz de uma pasta do
  workspace) → execução completa de cada um.
- Pasta dentro de um projeto que contém arquivos de teste → execução parcial.
- Arquivo de teste → execução parcial.

Arquivo de teste é:

- **Jest:** arquivo dentro de um projeto Jest que casa com o padrão do Jest
  (`**/__tests__/**/*.[jt]s?(x)` ou `**/?(*.)+(spec|test).[jt]s?(x)`,
  incluindo `.mjs`/`.cjs`/`.mts`/`.cts`).
- **.NET:** arquivo `.cs` dentro de um projeto de testes cujo conteúdo tem
  atributos de teste (`[Fact]`, `[Theory]`, `[Test]`, `[TestCase]`,
  `[TestMethod]`, `[DataTestMethod]`).

A visibilidade do menu é controlada por uma chave de contexto com o conjunto
de caminhos elegíveis, mantida pela descoberta
(`resourcePath in coverageTools.runnablePaths`). Fora desses caminhos o item
não aparece.

### 5.6 Execução e erros

- Uma execução por vez; pedidos feitos durante uma execução entram em fila.
- A saída dos comandos vai para o canal de saída "Coverage Tools".
- **Testes falharam mas há relatório:** a cobertura é incorporada e um aviso
  informa que houve falhas.
- **Sem relatório:** notificação de erro com botão para abrir a saída. Para
  .NET, a mensagem sugere verificar o pacote `coverlet.collector` no projeto
  de testes.
- **Relatório malformado:** registrado na saída e ignorado; os dados
  anteriores do projeto são mantidos.
- **Arquivos do relatório que não existem no disco** são descartados (por
  exemplo, caminhos de build determinístico que não resolvem).
- Cancelar encerra o processo em execução e esvazia a fila.

### 5.7 Configurações

| Chave | Padrão | Função |
|-------|--------|--------|
| `coverageTools.watch.enabled` | `true` | Liga a detecção de execuções externas |
| `coverageTools.watch.globs` | os quatro padrões da seção 5.3 | Onde procurar relatórios |
| `coverageTools.exclude` | `**/node_modules/**`, `**/bin/**`, `**/obj/**` | Ignorado na descoberta e na observação |
| `coverageTools.dotnet.collector` | `XPlat Code Coverage` | Valor de `--collect` |
| `coverageTools.dotnet.extraArgs` | `[]` | Argumentos adicionais para `dotnet test` |
| `coverageTools.jest.command` | `""` (automático: `<pm> test`) | Comando base do Jest |
| `coverageTools.jest.extraArgs` | `[]` | Argumentos adicionais para o Jest |

## 6. Arquitetura

Módulos, com fronteiras pensadas para que tudo o que não é interface possa
ser testado sem o VS Code:

| Módulo | Responsabilidade | Depende do VS Code? |
|--------|------------------|---------------------|
| `model` | Tipos normalizados de cobertura: por arquivo, lista de instruções (intervalo + contagem), ramos (posição + contagem por braço) e declarações (nome + intervalo + contagem) | não |
| `parsers/cobertura` | XML Cobertura → `model`. Resolve caminhos com `<sources>`; linhas viram instruções; `condition-coverage` vira ramos; `<method>` vira declarações | não |
| `parsers/istanbul` | `coverage-final.json` → `model`, preservando intervalos exatos | não |
| `parsers/lcov` | `lcov.info` → `model` (`DA`, `BRDA`, `FN`/`FNDA`) | não |
| `store` | Mapa `projeto → arquivos`; `replace`, `union`, `clear`, `merged()`; emite evento de mudança | não |
| `discovery` | Encontra projetos e alvos elegíveis; calcula o conjunto `runnablePaths` | parcial (busca de arquivos atrás de uma interface) |
| `commands` (construção) | Monta linha de comando e ambiente para cada alvo | não |
| `runner` | Executa processos, fila, cancelamento, saída | parcial (canal de saída, progresso) |
| `watcher` | Observa os globs, agrupa mudanças, atribui ao projeto, chama parser + `store.replace` | sim |
| `publisher` | `TestController` + perfil de cobertura; converte `store.merged()` em `FileCoverage` e publica um `TestRun`; responde `loadDetailedCoverage` | sim |
| `extension` | Ativação, registro de comandos, menus, barra de status, ligação entre módulos | sim |

### Publicação pela API nativa

- Um `TestController` (`coverageTools`) com um `TestRunProfile` do tipo
  `Coverage` que implementa `loadDetailedCoverage`.
- A cada mudança no `store` (com debounce), o `publisher` cria um `TestRun`
  com esse perfil, chama `addCoverage` para cada arquivo do acumulado e
  encerra a execução.
- Cada `FileCoverage` publicado carrega o detalhe daquele instante (subclasse
  de `FileCoverage`), de modo que execuções antigas no histórico continuam
  mostrando o que valia quando foram publicadas.
- O controlador não registra itens de teste, para não duplicar o Test
  Explorer nem ser disparado pelo "Run All with Coverage" nativo.

**Risco técnico principal:** confirmar em um VS Code real que uma execução
sem itens de teste, só com cobertura, é exibida normalmente. A API não
proíbe, mas isso precisa ser a primeira coisa validada. Plano B, se for
necessário: registrar um item de teste por projeto e incluí-lo na execução.

### Mesclagem no modelo

A união de dois registros do mesmo arquivo casa instruções por intervalo,
ramos por posição e índice do braço, e declarações por nome e linha inicial,
somando as contagens. O que não casa (arquivo mudou entre execuções) é
mantido dos dois lados.

## 7. Pilha técnica (decisões de quem escreveu o design)

- TypeScript, empacotado com esbuild.
- Testes unitários com Vitest para os módulos sem VS Code.
- Testes de integração com `@vscode/test-electron`.
- Lint com ESLint; empacotamento com `@vscode/vsce`.
- GitHub Actions: lint, testes unitários, testes de integração e geração do
  `.vsix` em cada push e pull request.
- Tudo o que é voltado ao usuário fica **somente em inglês**: textos da
  interface, `README.md` e `CHANGELOG.md` (decisão do usuário).
- `CHANGELOG.md` segue o formato Keep a Changelog, com a seção
  `[Unreleased]` dividida em "Planned", "In progress" e "Done". O `README.md`
  tem uma tabela de estado por funcionalidade. Os dois são atualizados no
  mesmo commit de cada mudança visível ao usuário.
- Identificação: nome `coverage-tools`, nome de exibição "Coverage Tools",
  publisher `danilofg`.

## 8. Fora do escopo desta versão, mas previsto pelo desenho

- Carregar relatórios existentes ao iniciar (seria uma configuração a mais
  sobre o `watcher`).
- Novos formatos e frameworks (um parser novo e uma entrada na descoberta).

## 9. Verificação

- **Unitário:** parsers contra relatórios de exemplo (Cobertura no formato do
  coverlet; Istanbul JSON e LCOV gerados por um Jest real), mesclagem do
  `store`, descoberta em árvores de diretório temporárias, construção de
  comandos, resolução de caminhos.
- **Ponta a ponta com Jest real:** um projeto de exemplo em `samples/` é
  executado de verdade no ambiente de desenvolvimento.
- **Integração no VS Code:** ativação, registro de comandos, publicação de
  uma cobertura de exemplo sem erros. Roda no GitHub Actions, onde o download
  do VS Code funciona.
- **.NET real e aparência final:** não podem ser verificados no contêiner de
  desenvolvimento (sem .NET SDK, VS Code bloqueado pela rede). Ficam cobertos
  por relatórios de exemplo, pelo CI e por uma verificação manual do usuário
  com o `.vsix` em um workspace `samples/` multi-root (um projeto Jest e um
  projeto .NET), salvo se o ambiente for liberado para baixar o VS Code e o
  .NET SDK.

## 10. O que fica a cargo de quem implementa

- Nomes internos, organização fina de arquivos e assinatura das funções.
- Valores exatos de debounce e formato das mensagens.
- Como derivar as classes de teste de um arquivo `.cs` para o `--filter`.
- Detalhes de escape de argumentos por sistema operacional.
- Estrutura dos projetos de exemplo em `samples/`.
