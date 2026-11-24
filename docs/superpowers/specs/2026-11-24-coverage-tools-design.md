# Coverage Tools — design

Data: 2026-11-24
Status: aprovado pelo usuário em 2026-11-24 (revisão 3). Revisão 4, feita ao
escrever o plano: atualiza os fatos sobre o ambiente de desenvolvimento
(seções 3 e 9) e precisa onde a mesclagem roda (seção 6.1, item 4).
Plano: `docs/superpowers/plans/2026-11-24-coverage-tools.md`

## 1. Intenção e porquê

O VS Code mostra cobertura de testes de forma nativa (view "Test Coverage",
percentual e barra por arquivo, linhas marcadas no editor), mas só de **uma
execução por vez**. Em um workspace com vários projetos ou várias pastas
(multi-root), rodar a cobertura do projeto B faz a do projeto A sumir.

**Coverage Tools** é uma extensão do VS Code que funciona como um
**acumulador**: guarda a cobertura de todos os projetos do workspace, exibe
tudo junto pela API nativa de testes e, quando um projeto é reexecutado,
atualiza só a parte dele.

Público: quem desenvolve em workspaces com vários projetos — .NET, Node e
Python, inclusive misturados — e quer a visão de cobertura do workspace
inteiro sem sair da interface nativa e sem ficar reexecutando e alternando
entre projetos.

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
6. Suportar três ecossistemas na primeira versão:
   - **.NET com C#** (`dotnet test`);
   - **Node** com Jest, Vitest ou qualquer outra ferramenta de teste que rode
     pelo script `test` do `package.json`;
   - **Python** com pytest.
7. **Ser muito leve.** A extensão não pode deixar o VS Code lento nem
   carregado; em repouso, deve parecer que nem está ali. Este é um requisito
   central, com metas mensuráveis (seção 6.1).
8. **Ser agnóstica.** Nenhuma regra pode depender de como um time específico
   organiza seus projetos. A extensão se adapta ao que encontra: com ou sem
   script `test`, projeto único ou monorepo, qualquer executor de testes .NET,
   qualquer forma de coletar cobertura.
9. Manter um `README.md` em inglês que explique o que a ferramenta faz, mostre
   com **imagens** como usá-la corretamente e reflita sempre o estado real do
   que está implementado; e um `CHANGELOG.md` em inglês que registre o que
   está planejado, em andamento e entregue.
10. **Publicar automaticamente**, pelo mesmo esquema do repositório GitTools e
    no mesmo lugar: VS Code Marketplace sob o publisher `DaniloFG`,
    opcionalmente Open VSX, e um release no GitHub com o `.vsix` anexado a
    cada publicação (pedido do usuário depois da aprovação do design).

### Não-objetivos (primeira versão)

- Guardar cobertura entre reinícios do VS Code. A extensão começa vazia.
- Outros ecossistemas (Java, Go, Rust etc.).
- Cobertura por teste individual ("qual teste cobriu esta linha").
- Substituir o Test Explorer do C# Dev Kit, da extensão do Jest ou da
  extensão de Python.
- Histórico, tendências ou metas mínimas de cobertura.

### Anti-objetivos

- Ter aparência diferente do nativo (decorações próprias no estilo Coverage
  Gutters, árvore própria de cobertura).
- Perder a cobertura acumulada de outros projetos quando um projeto roda.
- Exigir que o usuário altere a configuração dos projetos dele para a
  extensão funcionar.
- Imagens no README que não sejam capturas reais da extensão funcionando.
- Qualquer trabalho da extensão que o usuário perceba como lentidão: travar a
  digitação, atrasar a abertura do VS Code, varrer o disco sem necessidade.

## 3. Restrições

- **A API nativa mostra uma execução por vez.** Não existe "somar" na API. A
  extensão contorna isso guardando o acumulado e republicando o conjunto
  inteiro como uma nova execução (`TestRun`) a cada mudança.
- **Execuções de outras extensões tomam a tela.** Se o usuário rodar
  cobertura pelo C# Dev Kit, pela extensão do Jest ou pela de Python, o VS
  Code passa a exibir a execução delas. A extensão não tem como impedir nem
  detectar isso. O acumulado permanece em memória e o comando "Show Coverage"
  o republica.
- **Só existe cobertura se o teste gravar um relatório legível.** Execuções
  sem opção de cobertura não geram nada e são ignoradas.
- **Dados podem ficar defasados.** Se um arquivo é editado depois da
  execução, as linhas marcadas podem não corresponder mais. O nativo tem o
  mesmo comportamento.
- **Ambiente de desenvolvimento.** O contêiner onde a extensão é construída
  tem Node e Python; o .NET SDK (8 e 10) instala pelo gerenciador de pacotes
  do sistema; e o download do VS Code foi liberado em um ambiente próprio
  deste repositório. As três frentes e a interface podem ser testadas de
  verdade ali.
- API mínima: `engines.vscode` `^1.90.0` (a API de cobertura é estável desde
  a 1.88).

## 4. Abordagens consideradas

1. **Acumulador + observador de relatórios (escolhida).** A extensão mantém
   em memória a cobertura por projeto e republica o conjunto pela API nativa.
   Observa os arquivos de relatório no disco e também tem comandos próprios
   de execução. Cobre execuções vindas de qualquer lugar e mantém um único
   caminho de leitura de relatórios. Custo: precisa de regras de mesclagem.
2. **Só execuções disparadas pela extensão.** Mais simples, e a extensão
   sempre sabe o escopo do que rodou. Descartada porque uma execução com
   cobertura no terminal passaria despercebida, e detectar é um requisito.
3. **Interceptar comandos do terminal** (integração de shell). Descartada:
   depende de a integração de shell estar ativa, não enxerga tasks nem
   scripts, e interpretar linhas de comando arbitrárias é frágil.
4. **Decorações e árvore próprias.** Descartada: é o que o Coverage Gutters
   faz e contraria o requisito de ter a cara do nativo.

Decisão do usuário: o "como" foi delegado; a abordagem 1 foi a escolhida por
quem escreveu este design e apresentada na conversa.

A abordagem 1 também é a que torna barato atender três ecossistemas: a
leitura de relatórios depende do **formato** (Cobertura, Istanbul JSON,
LCOV), não da ferramenta. Quase toda ferramenta de teste de .NET, Node e
Python sabe gravar um desses três. O que é específico de cada ferramenta fica
isolado em um **adaptador** pequeno (seção 6).

## 5. Comportamento

### 5.1 O que o usuário vê

A view nativa **Test Coverage**, as barras no Explorer e as marcações de
linha no editor, exatamente como em uma execução nativa com cobertura, mas
com os arquivos de todos os projetos do workspace:

```
TEST COVERAGE
▾ api            (pasta 1 do workspace, .NET)
    Services/OrderService.cs      █████████░  91%
    Services/TaxService.cs        ███░░░░░░░  34%
▾ web            (pasta 2 do workspace, Node)
    components/Cart.tsx           ████████░░  80%
▾ jobs           (pasta 3 do workspace, Python)
    jobs/cleanup.py               ██████░░░░  62%
```

As cores (vermelho, amarelo, verde) e os limites vêm da configuração nativa
`testing.coverageBarThresholds`. A extensão não implementa cores próprias.

Além disso, um item na barra de status mostra o percentual total acumulado
(linhas cobertas ÷ linhas totais de todos os arquivos) e indica quando há
execução em andamento. Clicar nele executa "Show Coverage".

### 5.2 Projetos e adaptadores

Um **projeto** é a unidade de armazenamento e de execução. Cada projeto é
reconhecido por um **adaptador**, que também sabe montar o comando de
cobertura dele. O reconhecimento se baseia na configuração da ferramenta, não
em convenções de um time.

| Adaptador | Um projeto é… | Execução parcial (arquivo/pasta)? |
|-----------|---------------|-----------------------------------|
| `dotnet-vstest` | um `.csproj` de testes sobre VSTest: referencia `Microsoft.NET.Test.Sdk` ou declara `<IsTestProject>true</IsTestProject>`, e não se enquadra na linha de baixo | sim |
| `dotnet-mtp` | um `.csproj` de testes sobre Microsoft.Testing.Platform: SDK `MSTest.Sdk`, `<EnableMSTestRunner>`, `<EnableNUnitRunner>`, `<UseMicrosoftTestingPlatformRunner>`, `<TestingPlatformDotnetTestSupport>`, referência a `TUnit`, ou `global.json` selecionando esse executor | depende do framework (seção 5.3) |
| `jest` | um diretório com `package.json` e Jest configurado: chave `jest`, arquivo `jest.config.*`, ou script `test` que chama `jest` ou `react-scripts test` | sim |
| `vitest` | um diretório com `package.json` e Vitest configurado: arquivo `vitest.config.*`, bloco `test` em `vite.config.*`, ou script `test` que chama `vitest` | sim |
| `node-generic` | qualquer outro diretório com `package.json` que tenha um script `test` real ou um arquivo `.mocharc.*` (Mocha, AVA, `node --test`, Jasmine, tap etc.) | não |
| `python` | um diretório com marcador de projeto Python (`pyproject.toml`, `setup.py`, `setup.cfg`, `pytest.ini` ou `tox.ini`) que contenha arquivos de teste; sem marcador, a pasta do workspace que contém os arquivos de teste. Atende pytest e `unittest` | sim |

Regras comuns:

- **O script `test` não é obrigatório.** Para Jest, Vitest e Mocha, basta a
  configuração da ferramenta existir. Se há um script `test` que chama a
  ferramenta, a extensão usa o script, para respeitar as opções de quem montou
  o projeto; se não há, chama o executável local da ferramenta diretamente.
- Em um mesmo diretório Node, a ordem de escolha é: comando personalizado
  (seção 5.7), `jest`, `vitest`, `node-generic`. Ter `jest` ou `vitest`
  apenas nas dependências não basta. O script padrão do `npm init`
  (`echo "Error: no test specified" && exit 1`) não conta como script real.
- Propriedades de projeto .NET são procuradas no `.csproj` e nos arquivos
  `Directory.Build.props` e `Directory.Packages.props` acima dele.
- A descoberta acontece em todas as pastas do workspace depois da ativação e
  é refeita quando `.csproj`, `package.json`, arquivos de configuração das
  ferramentas, marcadores Python ou as pastas do workspace mudam. Ignora
  `node_modules`, `bin`, `obj`, `.venv`, `venv` e `__pycache__`.
- **Projetos aninhados (monorepo).** Quando um diretório que se qualifica
  contém outros diretórios que também se qualificam **no mesmo ecossistema**,
  por padrão só os de dentro são projetos, e o de fora é tratado como
  orquestrador. Isso evita rodar os mesmos testes duas vezes e funciona tanto
  para projetos independentes quanto para monorepos, sem configuração. Quem
  tem o caso inverso (a raiz roda tudo de uma vez) muda
  `coverageTools.nestedProjects` para `outer`.

### 5.3 Formas de alimentar o acumulado

**A. Execução pela extensão.** A extensão roda o comando do adaptador, faz o
relatório ser gravado em um diretório temporário próprio (fora do workspace)
e o lê ao terminar.

| Adaptador | Comando (execução completa) | Filtro na execução parcial |
|-----------|-----------------------------|----------------------------|
| `dotnet-vstest` | `dotnet test "<csproj>" <coleta> --results-directory "<tmp>"` | `--filter` com as classes de teste do arquivo/pasta (`FullyQualifiedName~Namespace.Classe`, unidas por `\|`) |
| `dotnet-mtp` | `dotnet run --project "<csproj>" -- --coverage --coverage-output-format cobertura --coverage-output "<tmp>/coverage.cobertura.xml"` | conforme o framework (abaixo) |
| `jest` | `<jest> --coverage --coverageReporters=json --coverageDirectory="<tmp>"`, com `CI=true` | caminho relativo do arquivo/pasta |
| `vitest` | `<vitest> --coverage --coverage.reporter=json --coverage.reportsDirectory="<tmp>"`, com `CI=true` | caminho relativo do arquivo/pasta |
| `node-generic` | `c8 --reporter=json --reports-dir="<tmp>" <comando de teste>`, usando o `c8` embutido na extensão | — |
| `python` | conforme o que existe no ambiente (abaixo) | caminho relativo do arquivo/pasta |

**Node**

- `<pm>` é `yarn`, `pnpm` ou `npm`, escolhido pelo lockfile presente no
  projeto ou acima dele (padrão `npm` na ausência de lockfile).
- `<jest>` e `<vitest>` são `<pm> test` **somente quando o script `test`
  termina na chamada da ferramenta**, de modo que argumentos acrescentados
  cheguem a ela. Isso inclui prefixos de ambiente (`cross-env X=1 jest`) e
  um nível de redirecionamento (`"test": "npm run test:unit"`, caso em que se
  usa o script de destino). Em qualquer outro caso — não há script, ou ele
  encadeia comandos (`jest && eslint .`) — a extensão chama o executável
  local (`yarn jest`, `pnpm exec jest`, `npx --no-install jest`). Variáveis e
  opções que só existiam no script encadeado se perdem nesse caminho; quem
  depende delas usa o comando personalizado (seção 5.7). Com `npm`, os
  argumentos do script vão depois de `--`.
- `CI=true` evita modo watch em Jest (inclusive via `react-scripts`) e Vitest.
- **`node-generic` e o `c8`.** O `c8` mede cobertura pelo próprio motor V8 do
  Node, por fora, então funciona com qualquer executor de testes sem mexer no
  projeto. Ele é distribuído dentro do `.vsix`, chamado com o `node` do
  usuário e só roda como processo separado, durante uma execução; não pesa na
  extensão em repouso. A versão embutida deve aceitar Node 18 ou superior; com
  um Node mais antigo, a execução falha com uma mensagem dizendo isso. O comando de teste é `<pm> test` ou, sem script e com
  `.mocharc.*`, o executável local do Mocha. Exceção: se o script `test` já
  chama `nyc` ou `c8`, a extensão não embrulha de novo; roda o script como
  está e depois procura um relatório reconhecido dentro do projeto (os mesmos
  padrões da detecção externa). Se não encontrar, avisa que o script precisa
  gravar um relatório `lcov` ou `json`.

**.NET**

- **`<coleta>` no VSTest** é escolhida pelo que o projeto já tem, sem exigir
  pacote novo: com `coverlet.collector`, `--collect:"XPlat Code Coverage"`;
  com `coverlet.msbuild`, `/p:CollectCoverage=true
  /p:CoverletOutputFormat=cobertura /p:CoverletOutput="<tmp>/"`; sem nenhum
  dos dois, `--collect:"Code Coverage;Format=cobertura"`, que usa o coletor
  da Microsoft que já acompanha o `Microsoft.NET.Test.Sdk`. A configuração
  `coverageTools.dotnet.collector` força um valor.
- **Microsoft.Testing.Platform.** O projeto de testes é um executável, então
  `dotnet run` funciona igual em qualquer versão do SDK e modo de
  `dotnet test`. As opções `--coverage*` vêm da extensão de cobertura da
  plataforma (`Microsoft.Testing.Extensions.CodeCoverage`), que já vem no
  `MSTest.Sdk` e precisa ser referenciada nos demais frameworks; sem ela, a
  execução falha com uma dica dizendo qual pacote falta. Em projetos com mais
  de um framework de destino, usa-se o primeiro.
- **Execução parcial no Microsoft.Testing.Platform** depende do framework de
  testes, reconhecido pelas referências do projeto: MSTest e NUnit,
  `--filter "FullyQualifiedName~Namespace.Classe"`; xUnit v3,
  `--filter-class Namespace.Classe`; TUnit,
  `--treenode-filter "/*/Namespace/Classe/*"`. Framework não reconhecido
  aceita só execução completa. Cada sintaxe só entra na versão final depois
  de confirmada por um teste real no GitHub Actions; a que não for confirmada
  sai como "só execução completa".

**Python**

- **`<python>`** é resolvido **por projeto**, nesta ordem: configuração
  `coverageTools.python.interpreter` (definível por pasta do workspace);
  `.venv` ou `venv` dentro do próprio projeto; interpretador selecionado na
  extensão de Python da Microsoft para aquela pasta, se instalada; `python3`;
  `python`. O ambiente do próprio projeto vem antes da seleção geral porque
  uma mesma pasta pode ter vários projetos, cada um com o seu.
- No momento da execução, a extensão pergunta ao interpretador o que está
  instalado (`pytest`, `pytest-cov`, `coverage`) e escolhe:

  | Ambiente | Comando |
  |----------|---------|
  | pytest + pytest-cov | `<python> -m pytest --cov --cov-report=xml:"<tmp>/coverage.xml"` |
  | pytest + coverage.py | `<python> -m coverage run --data-file="<tmp>/.coverage" -m pytest`, depois `<python> -m coverage xml` |
  | só coverage.py | `<python> -m coverage run --data-file="<tmp>/.coverage" -m unittest discover`, depois `<python> -m coverage xml` |
  | sem coverage.py | erro com dica: instalar `coverage` ou `pytest-cov` |

- **A extensão mede o que o projeto mede.** Se a configuração do pytest do
  projeto (`pytest.ini`, `pyproject.toml`, `setup.cfg` ou `tox.ini`) já tem
  `--cov` nas opções padrão, a extensão **não** acrescenta outro `--cov` e
  passa só o `--cov-report`. Um `--cov` a mais anularia o filtro de origem do
  projeto e mudaria o percentual em relação à execução no terminal. Quando a
  extensão acrescenta o `--cov`, vale o padrão do coverage.py, que inclui os
  arquivos de teste, igual ao que o usuário vê no terminal.
- O caminho do arquivo/pasta na execução parcial vai sempre por último,
  depois de `coverageTools.python.extraArgs`, para não ser lido como valor de
  `--cov`.
- Toda execução Python pela extensão define `COVERAGE_FILE="<tmp>/.coverage"`,
  para que nada seja gravado dentro do projeto.

**Execuções da extensão não alimentam o observador.** Além de gravar tudo
fora do workspace, a extensão ignora eventos de relatório de um projeto
enquanto ela mesma o executa e por uma pequena janela depois. Sem isso, um
projeto cuja própria configuração grava relatório no workspace teria a
execução parcial somada e, em seguida, sobrescrita pela detecção, que trata
todo relatório como execução completa.

**B. Execução externa detectada.** A extensão observa arquivos de relatório
no workspace e, quando um aparece ou muda, lê e incorpora:

| Padrão | Formato | Quem costuma gravar |
|--------|---------|---------------------|
| `**/TestResults/**/*.cobertura.xml` | Cobertura | `dotnet test` com coletor |
| `**/coverage/coverage-final.json` | Istanbul JSON | Jest, Vitest, nyc, c8 |
| `**/coverage/lcov.info` | LCOV | Jest, Vitest, nyc, c8, `node --test` |
| `**/coverage/cobertura-coverage.xml` | Cobertura | Jest, Vitest, nyc, c8 |
| `**/coverage.xml` | Cobertura | pytest-cov, coverage.py |
| `**/coverage.lcov` | LCOV | pytest-cov, coverage.py |
| `**/.coverage` | dados do coverage.py | `pytest --cov`, `coverage run` |

- O arquivo `.coverage` é um banco de dados binário do coverage.py. Quando
  ele muda, a extensão o converte com
  `<python> -m coverage xml --data-file=<arquivo> -o <tmp>/coverage.xml` e lê
  o resultado. Assim um `pytest --cov` simples no terminal é detectado sem
  exigir `--cov-report=xml`. Se a conversão falhar (coverage.py ausente no
  interpretador resolvido), o motivo vai para o canal de saída, sem
  notificação.
- Um arquivo `coverage.xml` que não seja Cobertura (elemento raiz diferente
  de `<coverage>`) é ignorado em silêncio.
- O relatório é atribuído ao projeto descoberto mais próximo acima dele na
  árvore de diretórios. Mudanças são agrupadas por uma pequena janela de
  espera (debounce); se vários formatos aparecem juntos para o mesmo projeto,
  usa-se um só, nesta ordem de preferência: Istanbul JSON, Cobertura, LCOV,
  `.coverage`.
- Relatórios que já existem no disco quando a extensão inicia **não** são
  carregados (a extensão começa vazia).

**Relatório sem projeto dono.** Acontece, por exemplo, com
`dotnet test --results-directory ./TestResults` na raiz de uma solução: os
relatórios de todos os projetos caem em `TestResults/<GUID novo>/`, sem
`.csproj` acima, e o relatório não diz qual projeto de testes o gerou. Nesse
caso a chave é a **raiz de resultados** (o diretório acima da pasta de GUID
no padrão `TestResults`, ou o diretório do relatório nos demais casos) mais
uma **assinatura do conteúdo** (a lista ordenada dos assemblies/pacotes do
relatório; para formatos sem pacotes, a string vazia). Um relatório novo
substitui o anterior de mesma chave, de modo que reexecutar atualiza em vez
de acumular lixo, e os relatórios de projetos diferentes de uma mesma
execução não se sobrescrevem. Limitação aceita: dois projetos de teste que
instrumentam exatamente o mesmo conjunto de assemblies e gravam na mesma raiz
compartilhada são confundidos, e o último substitui o anterior. *(Decisão de
quem escreveu o design.)*

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

- Arquivo que define um projeto (`.csproj` de testes, `package.json` de
  projeto Node, `pyproject.toml`/`setup.py`/`setup.cfg`/`pytest.ini`/`tox.ini`
  de projeto Python) → execução completa do projeto.
- `.sln` → execução completa de cada projeto de testes listado na solução.
- Pasta que é a raiz de um projeto, ou que contém um ou mais projetos
  (inclusive a raiz de uma pasta do workspace) → execução completa de cada
  um.
- Pasta dentro de um projeto que contém arquivos de teste, quando o
  adaptador aceita execução parcial → execução parcial.
- Arquivo de teste, quando o adaptador aceita execução parcial → execução
  parcial.

Arquivo de teste é:

- **`jest` e `vitest`:** arquivo dentro do projeto que casa com
  `**/__tests__/**/*.[jt]s?(x)` ou `**/?(*.)+(spec|test).[jt]s?(x)`,
  incluindo `.mjs`/`.cjs`/`.mts`/`.cts`.
- **`dotnet-vstest` e `dotnet-mtp`:** arquivo `.cs` dentro de um projeto de testes cujo conteúdo
  tem atributos de teste (`[Fact]`, `[Theory]`, `[Test]`, `[TestCase]`,
  `[TestMethod]`, `[DataTestMethod]`; no TUnit, `[Test]`).
- **`python`:** arquivo `test_*.py` ou `*_test.py` dentro do projeto.

A visibilidade do menu é controlada por uma chave de contexto com o conjunto
de caminhos elegíveis, mantida pela descoberta
(`resourcePath in coverageTools.runnablePaths`). Fora desses caminhos o item
não aparece.

### 5.6 Execução e erros

- Uma execução por vez; pedidos feitos durante uma execução entram em fila.
- A saída dos comandos vai para o canal de saída "Coverage Tools".
- **Testes falharam mas há relatório:** a cobertura é incorporada e um aviso
  informa que houve falhas.
- **Sem relatório:** notificação de erro com botão para abrir a saída e uma
  dica específica do adaptador: extensão de cobertura da plataforma (.NET
  sobre Microsoft.Testing.Platform), `coverage` ou `pytest-cov` (Python),
  provedor de cobertura do Vitest (`@vitest/coverage-v8`), ou relatório
  `lcov`/`json` no script (Node com `nyc`/`c8` próprio).
- **Relatório malformado:** registrado na saída e ignorado; os dados
  anteriores do projeto são mantidos.
- **Arquivos do relatório que não existem no disco** são descartados (por
  exemplo, caminhos de build determinístico que não resolvem).
- Cancelar encerra o processo em execução e esvazia a fila.

### 5.7 Configurações

| Chave | Padrão | Função |
|-------|--------|--------|
| `coverageTools.watch.enabled` | `true` | Liga a detecção de execuções externas |
| `coverageTools.watch.globs` | os padrões da seção 5.3 | Onde procurar relatórios |
| `coverageTools.exclude` | `**/node_modules/**`, `**/bin/**`, `**/obj/**`, `**/.venv/**`, `**/venv/**`, `**/__pycache__/**` | Ignorado na descoberta e na observação |
| `coverageTools.nestedProjects` | `inner` | Em projetos aninhados, rodar os de dentro (`inner`) ou o de fora (`outer`) |
| `coverageTools.dotnet.collector` | `""` (automático) | Força o valor de `--collect` no VSTest |
| `coverageTools.dotnet.extraArgs` | `[]` | Argumentos adicionais para `dotnet test` |
| `coverageTools.node.extraArgs` | `[]` | Argumentos adicionais para o comando de testes Node |
| `coverageTools.python.interpreter` | `""` (automático) | Interpretador Python a usar |
| `coverageTools.python.extraArgs` | `[]` | Argumentos adicionais para o executor de testes Python |
| `coverageTools.commands` | `{}` | Comando personalizado por projeto (ver abaixo) |

**Comando personalizado.** Para qualquer projeto que os adaptadores não
atendam (por exemplo, `unittest` puro, ou um executor Node incomum),
`coverageTools.commands` mapeia o caminho do projeto, relativo à pasta do
workspace, para uma linha de comando. O texto `${coverageDir}` é trocado pelo
diretório temporário, e a extensão procura ali um relatório reconhecido ao
fim. Um diretório listado aqui vira projeto mesmo que nenhum adaptador o
reconheça, e aceita apenas execução completa. É a saída para qualquer
estrutura que as regras automáticas não cubram.

- A configuração é por pasta do workspace (escopo de recurso): em multi-root,
  cada pasta tem o seu mapa, e os caminhos são relativos a ela.
- Um diretório com comando personalizado **suprime os projetos descobertos
  dentro dele**, de qualquer ecossistema. É uma escolha explícita do usuário
  de que aquele comando roda tudo ali, então nada é executado nem contado
  duas vezes.

### 5.8 Workspace não confiável

Em um workspace que o usuário não marcou como confiável (Workspace Trust do
VS Code), a extensão **não executa nada**: nem comandos de teste, nem comando
personalizado, nem o interpretador Python para converter `.coverage`. Esses
caminhos rodariam código vindo do repositório. Nesse modo ela apenas lê
relatórios estáticos (Cobertura, Istanbul JSON, LCOV) que aparecerem, e os
comandos de execução ficam indisponíveis. O manifesto declara suporte
limitado a workspaces não confiáveis.

## 6. Arquitetura

Módulos, com fronteiras pensadas para que tudo o que não é interface possa
ser testado sem o VS Code:

| Módulo | Responsabilidade | Depende do VS Code? |
|--------|------------------|---------------------|
| `model` | Tipos normalizados de cobertura: por arquivo, lista de instruções (intervalo + contagem), ramos (posição + contagem por braço) e declarações (nome + intervalo + contagem) | não |
| `parsers/cobertura` | XML Cobertura → `model`. Resolve caminhos com `<sources>`; linhas viram instruções; `condition-coverage` vira ramos; `<method>` vira declarações. Atende os dialetos do coverlet, do Istanbul e do coverage.py | não |
| `parsers/istanbul` | `coverage-final.json` → `model`, preservando intervalos exatos | não |
| `parsers/lcov` | `lcov.info` → `model` (`DA`, `BRDA`, `FN`/`FNDA`) | não |
| `store` | Mapa `projeto → arquivos`; `replace`, `union`, `clear`, `merged()`; emite evento de mudança | não |
| `adapters/*` | Um por linha da tabela 5.2: reconhece o projeto, lista arquivos de teste, monta comando, ambiente e local do relatório para execução completa e parcial | não |
| `discovery` | Percorre o workspace em segundo plano, aplica os adaptadores e a regra de aninhamento, calcula o conjunto `runnablePaths` | parcial (busca de arquivos atrás de uma interface) |
| `worker` | Thread de trabalho que hospeda parsers e mesclagem, criada sob demanda | não |
| `runner` | Executa processos, fila, cancelamento, saída | parcial (canal de saída, progresso) |
| `watcher` | Observa os globs, agrupa mudanças, converte `.coverage`, atribui ao projeto, chama parser + `store.replace`. Ignora projetos que o `runner` está executando | sim |
| `publisher` | `TestController` + perfil de cobertura; converte `store.merged()` em `FileCoverage` e publica um `TestRun`; responde `loadDetailedCoverage` | sim |
| `extension` | Ativação, registro de comandos, menus, barra de status, ligação entre módulos | sim |

Acrescentar uma ferramenta nova é escrever um adaptador; acrescentar um
formato novo é escrever um parser. Nenhum dos dois toca em `store` ou
`publisher`.

### 6.1 Leveza (requisito central)

Princípios, todos obrigatórios:

1. **Ativação sem custo.** A extensão ativa em `onStartupFinished`, depois
   que o VS Code já abriu, e na ativação só registra comandos e observadores.
   Não lê arquivo nenhum nesse momento.
2. **Repouso de verdade.** Sem temporizadores e sem varredura periódica. Em
   repouso, a única coisa viva são os observadores de arquivo do próprio VS
   Code, que já vigiam o workspace para o Explorer.
3. **Descoberta em segundo plano.** A busca por projetos usa a busca de
   arquivos do VS Code, com as exclusões aplicadas, roda depois da ativação e
   em lotes pequenos que devolvem o controle entre um e outro. Depois disso,
   só refaz a parte afetada por uma mudança. A leitura de conteúdo
   (por exemplo, achar atributos de teste em `.cs`) fica restrita a projetos
   de teste, é guardada em cache por data de modificação e refeita arquivo a
   arquivo ao salvar.
4. **Leitura de relatórios fora da linha principal.** Os parsers rodam em
   uma thread de trabalho (`worker_threads`), criada sob demanda e encerrada
   assim que não há pedido pendente. Um relatório de dezenas de megabytes não
   pode travar o processo de extensões, que é compartilhado com o IntelliSense
   e com as outras extensões. A união de registros (por arquivo, sobre
   arranjos compactos já ordenados) roda na linha principal, porque os dados
   acumulados vivem ali; ela é barata e fica presa à meta de 50 ms abaixo,
   verificada por teste.
5. **Detalhe sob demanda.** Na publicação vão só os totais por arquivo. O
   detalhe linha a linha é entregue quando o VS Code pede, arquivo a arquivo
   (`loadDetailedCoverage`).
6. **Memória compacta.** O relatório bruto é descartado depois de lido; o
   modelo guarda números em arranjos compactos, não objetos por linha.
7. **Carga limitada nas execuções.** Um projeto por vez, em processo
   separado. O `c8` e os conversores só existem como processos durante uma
   execução.
8. **Pacote enxuto.** Um único arquivo JavaScript minificado, sem
   dependências de execução além do `c8`, e sem telemetria nem acesso à rede.

Metas mensuráveis, verificadas em teste automatizado e conferidas antes de
cada versão:

| Meta | Limite |
|------|--------|
| Tempo de ativação (medido pelo VS Code em "Show Running Extensions") | abaixo de 20 ms |
| Leituras de arquivo durante a ativação | zero |
| Temporizadores ativos em repouso | zero |
| Maior bloqueio da linha principal ao incorporar um relatório de 5.000 arquivos | abaixo de 50 ms |
| Memória adicional com 5.000 arquivos acumulados | abaixo de 50 MB |
| Tamanho do JavaScript da extensão (sem o `c8`) | abaixo de 200 KB |

Os limites são pontos de partida de quem escreveu o design; se algum se
mostrar irreal na implementação, o desvio é reportado ao usuário em vez de
ajustado em silêncio.

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

**Outros riscos, a validar com execuções reais:** as linhas de comando do
adaptador `dotnet-mtp` e do coletor da Microsoft no VSTest foram escritas sem
poder rodar .NET no ambiente de desenvolvimento e precisam ser confirmadas no
GitHub Actions antes de serem dadas como prontas. E o adaptador `node-generic` depende de o `c8` embutido
medir corretamente projetos que transpilam em tempo de execução (ts-node,
tsx, Babel). Deve ser validado com projetos de exemplo reais (Mocha em
JavaScript, Mocha em TypeScript e `node --test`).

### Mesclagem no modelo

A união de dois registros do mesmo arquivo casa instruções por intervalo,
ramos por posição e índice do braço, e declarações por nome e linha inicial,
somando as contagens. O que não casa (arquivo mudou entre execuções) é
mantido dos dois lados.

## 7. Pilha técnica e documentação

Decisões de quem escreveu o design, salvo onde indicado:

- TypeScript, empacotado com esbuild. O `c8` vai no `.vsix` como dependência
  de execução.
- Testes unitários com Vitest para os módulos sem VS Code.
- Testes de integração com `@vscode/test-electron`.
- Lint com ESLint; empacotamento com `@vscode/vsce`.
- GitHub Actions: lint, testes unitários, testes de integração e geração do
  `.vsix` em cada push e pull request.
- Identificação: nome `coverage-tools`, nome de exibição "Coverage Tools",
  publisher `DaniloFG` (o mesmo do GitTools).
- Tudo o que é voltado ao usuário fica **somente em inglês**: textos da
  interface, `README.md` e `CHANGELOG.md` (decisão do usuário).
- `CHANGELOG.md` segue o formato Keep a Changelog, com a seção
  `[Unreleased]` dividida em "Planned", "In progress" e "Done". O `README.md`
  tem uma tabela de estado por funcionalidade. Os dois são atualizados no
  mesmo commit de cada mudança visível ao usuário.

### Imagens de uso no README (pedido do usuário)

O README ganha uma seção "Usage" em passos, cada passo com uma imagem:

1. Rodar tudo: paleta de comandos com `Run All Coverage` e o progresso.
2. Resultado: view Test Coverage com projetos de mais de um ecossistema.
3. Linha a linha: um arquivo aberto com linhas cobertas e não cobertas.
4. Botão direito: menu do Explorer com `Run Coverage Here` em um arquivo de
   teste.
5. Detecção automática: terminal rodando um teste com cobertura e a view
   atualizando.
6. Barra de status com o total e `Show Coverage`.

Regras:

- As imagens são **capturas reais** da extensão rodando sobre o workspace de
  exemplo `samples/`, guardadas em `docs/images/`. Nada de montagens.
- A captura é feita por um script automatizado (`npm run screenshots`), para
  poder ser refeita sempre que a interface mudar.
- Enquanto não houver capturas reais, o README não mostra imagens; a tabela
  de estado indica que estão pendentes.

## 8. Fora do escopo desta versão, mas previsto pelo desenho

- Carregar relatórios existentes ao iniciar (seria uma configuração a mais
  sobre o `watcher`).
- Novos ecossistemas (um adaptador novo; parser novo só se o formato for
  diferente dos três já lidos).

## 9. Verificação

- **Unitário:** parsers contra relatórios de exemplo de cada dialeto,
  mesclagem do `store`, descoberta em árvores de diretório temporárias,
  construção de comandos de cada adaptador, resolução de caminhos.
- **Ponta a ponta com ferramentas reais, no ambiente de desenvolvimento:**
  projetos de exemplo em `samples/` para Jest, Vitest, Mocha (via
  `node-generic`), `node --test`, pytest e `unittest` são executados de
  verdade, e os
  relatórios gerados alimentam os testes dos parsers.
- **Integração no VS Code:** ativação, registro de comandos, publicação de
  uma cobertura de exemplo sem erros. Roda no ambiente de desenvolvimento e
  no GitHub Actions.
- **.NET real:** projetos de exemplo de cada variação (VSTest com
  `coverlet.collector`, com `coverlet.msbuild` e sem coverlet; e
  Microsoft.Testing.Platform com MSTest, NUnit, xUnit v3 e TUnit) são
  executados de verdade no ambiente de desenvolvimento e no GitHub Actions.
- **Leveza:** testes automatizados para as metas da seção 6.1 — ativação sem
  leitura de arquivo e sem temporizadores, tempo de bloqueio e memória com um
  relatório sintético de 5.000 arquivos, e limite de tamanho do pacote
  verificado no GitHub Actions.
- **Aparência final e capturas de tela:** um VS Code real é baixado e
  dirigido por automação (Playwright sobre o Electron do VS Code), tanto para
  os testes de interface quanto para o script que gera as imagens do README.

## 10. O que fica a cargo de quem implementa

- Nomes internos, organização fina de arquivos e assinatura das funções.
- Valores exatos de debounce e formato das mensagens.
- Como derivar as classes de teste de um arquivo `.cs` para o `--filter`.
- Detalhes de escape de argumentos por sistema operacional.
- Estrutura dos projetos de exemplo em `samples/`.
- Como o script de captura dirige o VS Code.
