<p align="center"><img src="assets/telinha-icon-256.png" alt="Telinha" width="256" height="256"></p>

<p align="center"><a href="https://github.com/HumbertoFernandes7/Telinha/actions/workflows/ci.yml"><img src="https://github.com/HumbertoFernandes7/Telinha/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a></p>

# Telinha

**Transmita sua tela para os amigos do canal de voz e assistam uns aos outros dentro do Discord, direto de PC para PC, de graça e sem servidor nosso no meio.**

*(antigo nome: PeerLive)*

> **Status:** o Telinha já funciona e é uma versão oficial ([veja a mais recente](https://github.com/HumbertoFernandes7/Telinha/releases/latest)), mas ainda está em evolução (veja [Status](#status)). Quer usar? Vá para [Como instalar](#como-instalar).

---

## O que é

O Telinha é um plugin para o [Vencord](https://github.com/Vendicated/Vencord) (um mod do cliente do Discord) que permite que quem está no **mesmo canal de voz** transmita a **tela inteira ou uma janela** para os outros e todos assistam **dentro do Discord**. Você continua com o **Vencord oficial**: o instalador do Telinha só acrescenta o plugin por cima dele.

- **Peer-to-peer (P2P):** o vídeo vai direto de um PC para o outro, via WebRTC.
- **Gratuito e sem servidor nosso:** não existe backend do Telinha. Ninguém paga nada e nada passa por nós.
- **Até 1080p a 60 fps.** (A captura no Windows moderno é limitada a cerca de 60 fps.)
- **Som da janela:** ao transmitir uma janela, o som daquele aplicativo vai junto (só dele, não do resto do PC).
- **Som da tela inteira:** ao transmitir a tela inteira, vai todo o som do PC, **menos o do Discord** (seus amigos não ouvem a própria voz de volta). Exige Windows 10 versão 2004 ou superior.
- **Codec automático:** H.264 por hardware quando os dois lados suportam; caso contrário, VP9.

## Como funciona

Os amigos precisam se achar uns aos outros e, depois disso, o vídeo segue por conexão direta.

```
                 relays públicos do Nostr
                (via biblioteca Trystero)
                 só para "se encontrar"
                    ^                ^
                    |                |
              "estou aqui"     "estou aqui"
                    |                |
   +----------------+--+          +--+----------------+
   |  PC de quem       |  vídeo   |  PC de quem       |
   |  transmite        | =======> |  assiste          |
   |  Discord+Telinha | (WebRTC, |  Discord+Telinha |
   +-------------------+  direto) +-------------------+
```

1. Cada PC entra numa "sala" derivada do canal de voz do Discord e avisa que está lá. Esse aviso passa por **relays públicos do Nostr** (usando a biblioteca [Trystero](https://github.com/dmotz/trystero)), e **só serve para descobrir quem está por perto**.
2. Os PCs fazem o handshake WebRTC e abrem uma **conexão direta**. Usamos apenas servidores **STUN** (para descobrir endereço público); **o vídeo e o áudio nunca passam por servidor**.
3. Quem transmite captura a tela ou a janela e envia para cada espectador.

## Status

Na [versão mais recente](https://github.com/HumbertoFernandes7/Telinha/releases/latest), o que já foi **verificado**:

- [x] Captura de tela e de janela dentro do Discord oficial, no Windows.
- [x] Áudio da janela.
- [x] Conexão direta entre duas casas diferentes (720p, ~57 fps, 0% de perda).
- [x] Assistir em uma janela separada do Discord.
- [x] **Instalador + add-on sobre o Vencord oficial**, verificados em um PC real: instalação pelo `TelinhaInstaller.exe` e transmissão com o **áudio da tela inteira** funcionando (todo o som do PC, menos o do Discord; veja as [Limitações](#limitações)).

Já está disponível, mas **ainda não foi testado entre dois PCs reais**:

- Assistir **dentro da tela da call**: um botão **Assistir** no quadradinho da pessoa, na grade da call do Discord, toca a transmissão ali mesmo. Ela também pode ser aberta em uma janela separada.
- Lista **"Quem está assistindo"**, que abre ao clicar em **"Ao vivo · N assistindo"** na barra do Telinha, com **Expulsar** e **Liberar**.
- Aviso quando **duas conexões dizem ser a mesma conta do Discord**: nesse caso, nenhuma das duas recebe a transmissão.
- **Quem pode assistir**, escolhido na hora de transmitir: Todos da call, Só meus amigos do Discord, Só quem eu aprovar ou Com senha.
- **Identidade verificada** pelo próprio Discord: o selo "✔ verificado" mostra que a pessoa é mesmo dona daquela conta.

Ainda falta:

- [ ] O instalador ainda não é assinado digitalmente (por isso o aviso do SmartScreen).

## Requisitos

- Windows 10 (versão 2004 ou superior) ou Windows 11.
- Discord desktop com o **Vencord oficial já instalado** ([vencord.dev/download](https://vencord.dev/download/)).
- **Todo mundo que transmite ou assiste precisa ter o Telinha.**
- Funciona com a aceleração de hardware do Discord **ligada ou desligada** (desligada usa mais CPU).

## Como instalar

> **Aviso:** o Telinha é instalado pelo **`TelinhaInstaller.exe`, por cima do Vencord oficial**. Ele **não mexe nos arquivos do Vencord** (nem em suas configurações, temas e outros plugins): só troca o pequeno arquivo que o Vencord coloca no Discord (`app.asar`) por um que carrega o Vencord e também o Telinha, guardando uma cópia do original.

1. Tenha o **Vencord oficial** instalado: [vencord.dev/download](https://vencord.dev/download/). (Sem ele, o instalador avisa e não faz nada.)
2. Baixe o [**`TelinhaInstaller.exe`**](https://github.com/HumbertoFernandes7/Telinha/releases/latest/download/TelinhaInstaller.exe) (download direto da versão mais recente; as notas da versão ficam na [página da versão mais recente](https://github.com/HumbertoFernandes7/Telinha/releases/latest)).
3. Dê dois cliques nele. O Windows (SmartScreen) vai avisar, porque o instalador ainda não é assinado digitalmente: clique em **Mais informações > Executar assim mesmo**.
4. Clique em **Instalar**. Se o Discord estiver aberto, o instalador pede para fechá-lo.
5. Quando aparecer "Pronto!", **abra o Discord de novo** (se ele ainda estiver aberto, feche por completo antes: botão direito no ícone dele na bandeja do sistema, perto do relógio > "Sair do Discord"). O Telinha já vem **ativado**; se não aparecer, confira em **Configurações do usuário > Vencord > Plugins**.

O instalador registra o que fez em `%APPDATA%\Telinha\logs\installer.log`.

**Atualização automática**: o Telinha se atualiza sozinho. Ao abrir o Discord (e a cada 6 horas), ele procura uma versão nova no GitHub, baixa em segundo plano e confere se o arquivo é exatamente o publicado. A versão nova só entra quando o Discord reinicia, nunca no meio de uma transmissão: aparece o aviso "Telinha X.Y.Z pronto", com **Reiniciar agora** ou **Depois**. Se a versão nova não iniciar direito, o Telinha volta sozinho para a anterior. Para só ser avisado, desligue **"Atualizar automaticamente"** nas configurações do Telinha (Configurações → Vencord → Plugins → Telinha), onde também ficam a versão instalada e o botão **"Procurar atualização"**. Também dá para atualizar rodando o `TelinhaInstaller.exe` mais novo e escolhendo **Atualizar ou reparar**.

**Para desinstalar**: rode o `TelinhaInstaller.exe` de novo e clique em **Desinstalar**. O Vencord volta **exatamente como estava antes** de você instalar o Telinha.

**Se usar o "Reparar" do instalador do próprio Vencord** (ou reinstalar o Vencord), o Discord volta ao Vencord puro e o Telinha deixa de carregar: **rode o `TelinhaInstaller.exe` de novo** para colocá-lo de volta.

Instalou uma das versões de teste antigas (o ZIP com `instalar.cmd`)? Veja a [nota no fim](#versões-de-teste-antigas) antes.

## Como usar

**Transmitir**

1. Entre no mesmo canal de voz que os amigos (todos com o Telinha).
2. No painel da conexão de voz (canto inferior esquerdo), clique em **"Transmitir com Telinha"**.
3. Escolha uma **tela** ou uma **janela**. Janela = vai com o som daquela janela; tela inteira = vai todo o som do PC, menos o do Discord.
4. Escolha a qualidade (até 1080p60) e **quem pode assistir** (veja abaixo), e clique em **Transmitir**.

**Quem pode assistir**

Na hora de transmitir, escolha uma destas opções:

- **Todos da call** (padrão): qualquer um do canal de voz com o Telinha. Com **"Exigir identidade verificada"** ligada (o padrão), quem não autorizou o Telinha só assiste depois do seu **Permitir**.
- **Só meus amigos do Discord**: seus amigos com a identidade verificada entram direto; os outros são recusados.
- **Só quem eu aprovar**: cada pedido espera o seu **Permitir** ou **Recusar**.
- **Com senha**: digite ou gere uma senha só para aquela transmissão (ela nunca fica salva) e passe para os amigos por mensagem. Quem errar 5 vezes fica bloqueado até a transmissão acabar. A senha não trafega pela rede: o Telinha só troca uma prova dela.

Dá para mudar durante a transmissão, na barra do Telinha (**"Quem assiste: … Mudar"**); quem já está assistindo continua. Quem vai assistir vê o modo de cada transmissão: 🔒 com senha, 👥 só amigos, ✋ com aprovação. O padrão fica nas configurações do Telinha, em **"Quem pode assistir (padrão)"**.

**Identidade verificada**

Na primeira vez, o Telinha pede para você autorizá-lo no Discord (a janela é do próprio Discord e só diz quem você é: ele não lê mensagens, não entra em servidores e não age em seu nome). Assim seus amigos veem o selo **"✔ verificado"** ao seu lado, e ninguém consegue se passar por você na call. Você autoriza uma vez só: a prova se renova sozinha quando você entra numa call. Quem não autorizou aparece como **"não verificado"**; uma conexão com prova falsa é ignorada e aparece como **"✖ identidade falsa"**. Para desfazer, use **"Desvincular"** nas configurações do Telinha (e, no Discord, Configurações → Apps autorizados).

**Assistir** (qualquer uma destas formas)

- Clique em **Assistir** no quadradinho da pessoa, na tela da call. A transmissão toca ali mesmo.
- Clique na etiqueta **TELINHA** ao lado do nome da pessoa na lista do canal de voz. O Discord vai para a tela da call, com o quadradinho dela em destaque, e a transmissão toca ali mesmo.
- Clique em **Assistir** na barra do Telinha.
- Menu da caixa de ferramentas do Vencord (topo do Discord) > **Quem está transmitindo**.

A transmissão também pode abrir em uma **janela separada** (no quadradinho da call, use **Abrir em janela**; pela barra do Telinha e pelo menu ela já abre assim), com tela cheia, volume e "Parar de assistir".

**Quem está assistindo**

Quem transmite clica em **"Ao vivo · N assistindo"**, na barra do Telinha, e vê quem está recebendo a transmissão. Dali dá para **Expulsar** alguém (para de enviar na hora) e, depois, **Liberar** a pessoa de novo. Se duas conexões disserem ser a mesma conta do Discord, o Telinha avisa e nenhuma das duas recebe a transmissão.

**Jogos:** use o modo **borderless / sem bordas**. Em tela cheia exclusiva a imagem pode aparecer preta.

## Privacidade

- **Conexão direta significa que quem está na call pode ver o IP das outras pessoas.** Use só com quem você confia.
- Por padrão, **só são aceitas pessoas que estão no mesmo canal de voz** (configuração **"Recusar quem não está na call"**).
- Você escolhe **quem pode assistir** a cada transmissão (todos da call, só amigos do Discord, só quem você aprovar ou com senha), e a **identidade de cada pessoa é conferida pelo próprio Discord**.
- Você pode **expulsar** quem está assistindo a qualquer momento (**Expulsar**, na lista "Quem está assistindo").
- Opcional: nas configurações do plugin você pode definir uma **senha do grupo** (todos precisam usar a mesma).
- Os relays do Nostr só servem para as pessoas se encontrarem; eles não recebem seu vídeo.
- Os **logs do plugin nunca contêm endereços IP**.
- Não existe servidor nosso que guarde dados: o Telinha não tem backend.

## Limitações

- **Cada espectador recebe uma cópia separada** do vídeo, enviada pelo PC de quem transmite. O upload cresce com o número de espectadores: em 1080p60 cada um pode usar até 20 Mbps (se a internet não aguentar, a qualidade automática baixa sozinha). Recomendamos **2 a 4 espectadores**. Em 1080p60, 1 ou 2 é o ideal.
- Sem aceleração de hardware no Discord, o Telinha usa mais CPU.
- Jogos em **tela cheia exclusiva** podem aparecer pretos. Use borderless.
- Como só usamos STUN (sem servidor de retransmissão), em redes muito restritivas a conexão direta pode não se estabelecer.
- O Telinha **não injeta DLLs em jogos** (de propósito, por segurança com sistemas anti-cheat).
- O áudio da tela inteira usa um pequeno programa auxiliar que vem no pacote, o `telinha-audio.exe` (Windows 10 versão 2004 ou superior). Ele **ainda não é assinado digitalmente**, então o antivírus ou o Controle Inteligente de Aplicativos (Smart App Control) do Windows pode marcá-lo ou bloqueá-lo. Se for bloqueado, a tela é transmitida **sem som** (o seletor mostra o motivo); transmitir uma janela com som não depende dele.

## Perguntas frequentes

**Por que cada pessoa precisa ter o Telinha?**
Porque o vídeo não passa pelo Discord nem por nenhum servidor: ele vai direto entre os PCs, e é o plugin que faz a captura, a conexão e a exibição de cada lado. Sem o Telinha em quem assiste, não há como receber a transmissão.

**Funciona sem aceleração de hardware?**
Sim. Funciona com a aceleração de hardware do Discord ligada ou desligada. Desligada, usa mais CPU. O codec é escolhido automaticamente: H.264 por hardware quando os dois lados têm, senão VP9.

**Dá ban?**
Mods de cliente **violam os Termos de Serviço do Discord**, então o uso é **por sua conta e risco**. Não temos conhecimento de bans por plugins que não fazem nada abusivo, mas não há garantia nenhuma.

**Isso é afiliado ao Discord ou ao Vencord?**
Não. O Telinha não é afiliado ao Discord nem à equipe do Vencord, e a equipe do Vencord **não dá suporte** ao Telinha. Não peça suporte do Telinha por lá.

**Preciso pagar ou criar conta em algum serviço?**
Não. É gratuito e não existe servidor nem conta do Telinha.

**Qualquer pessoa pode entrar na minha transmissão?**
Por padrão, só quem está no mesmo canal de voz que você (e tem o Telinha). Você também pode definir uma senha do grupo.

**Posso transmitir meu jogo?**
Pode, de preferência em modo borderless (tela cheia exclusiva pode aparecer preta). O Telinha não injeta DLL nenhuma no jogo, de propósito, por segurança com anti-cheat.

**O instalador vai estragar meu Vencord?**
Não: ele não altera os arquivos do Vencord. Só troca o pequeno `app.asar` do Discord (o que o Vencord colocou lá) por um que também carrega o Telinha, e guarda uma cópia do original em `%APPDATA%\Telinha\backup`. Rodar o `TelinhaInstaller.exe` de novo e clicar em **Desinstalar** devolve o do Vencord exatamente como estava. Se o Discord não abrir, tente **Desinstalar**; se nem isso resolver, reinstale o Vencord oficial em [vencord.dev/download](https://vencord.dev/download/).

**Deu problema. E agora?**
Nas configurações do plugin, clique em **"Copiar diagnóstico"** e mande o texto para quem compartilhou o Telinha com você ou para o autor (Humberto, [@HumbertoFernandes7](https://github.com/HumbertoFernandes7)). Os logs não contêm IPs. As Issues do GitHub não são usadas neste repositório.

## Para desenvolvedores

Este repositório tem **só o código do Telinha**. O Vencord oficial é uma dependência de build: o commit fixado em [`vencord.json`](vencord.json) (Vencord 1.15.13, `443688b5`) é baixado pelo `pnpm bootstrap` para `.vencord/`, que fica fora do git (nunca é commitado nem copiado para cá).

Requisitos: Windows, Node.js 22+, [pnpm](https://pnpm.io/) 11, git, Go 1.26+ (instalador) e, para compilar o `telinha-audio.exe`, Visual Studio 2019+ ou Build Tools com "Desenvolvimento para desktop com C++".

```sh
pnpm bootstrap         # instala as dependências, baixa o Vencord fixado em .vencord/, instala as dependências
                       # dele (lockfile dele, congelado) e gera o build oficial dele em .vencord/dist
pnpm build:helper      # compila native-audio/bin/telinha-audio.exe (MSVC) e copia para dist/
pnpm typecheck         # tsc do plugin contra as fontes do Vencord fixado
pnpm lint              # ESLint com as regras de plugin do Vencord
pnpm lint-styles       # Stylelint do CSS do plugin
pnpm test:unit         # testes de unidade do plugin (tsx --test: src/**/*.test.ts(x) e test/**; ver test/README.md)
pnpm test:file <arq>   # um arquivo de teste só
pnpm build:addon       # dist/addon/Telinha-addon-<commit>.zip + smoke e checagem de ABI contra .vencord/dist
pnpm test:addon        # testes offline do add-on (rode o build:addon antes)
pnpm test              # test:unit + test:addon
pnpm test:coverage     # cobertura (c8) do plugin e do carregador do add-on: coverage/lcov.info e coverage-summary.json
pnpm test:coverage:go  # cobertura do instalador em Go: coverage/go/
pnpm coverage:check    # compara a cobertura atual com o piso de coverage-floor.json (o CI falha abaixo dele)
pnpm coverage:ratchet  # sobe o piso para a cobertura atual (nunca desce); ver "Coverage floor" em test/README.md
pnpm build:installer   # dist/installer/TelinhaInstaller.exe e TelinhaInstaller-cli.exe (roda go vet e go test antes)
pnpm check             # typecheck, lint, lint-styles, test:unit, build:addon e test:addon, nessa ordem
```

- O `pnpm bootstrap` é idempotente: numa segunda vez só confere o que já está pronto. `pnpm bootstrap --force` refaz tudo e descarta edições locais dentro de `.vencord/`. (O nome não é `setup` porque `pnpm setup` é um comando do próprio pnpm, que mexe no PATH do usuário.)
- **Como o add-on é montado:** o plugin é compilado contra `.vencord/src`, mas **sem empacotar o Vencord**: cada import de `@api/*`, `@components/*`, `@utils/*` e `@webpack` vira uma referência ao `window.Vencord` do Vencord oficial que está rodando (só `@utils/types` é embutido). O build falha se alguma fonte do Vencord acabar dentro do pacote.
- **O que o build:addon e os testes garantem:** carregam o pacote por cima do `renderer.js` do Vencord oficial (`.vencord/dist`) numa página simulada do Discord. Falham se o add-on lançar erro ao ser carregado (JSX, `Vencord.*` ou webpack usados no topo de um módulo, antes de o Discord carregar), se o plugin não se registrar ou se algum export do Vencord usado pelo pacote não existir no build oficial (checagem de ABI). Para testar contra outro build do Vencord: `--vencord-dist <pasta>`.
- **Atualizar o Vencord:** mude `commit` e `version` em `vencord.json`, rode `pnpm bootstrap` e depois `pnpm check`.
- **Versões (releases):** saem sozinhas pelo CI. O trabalho do dia a dia vai na branch `develop`; cada PR de `develop` para `main` que muda o produto vira uma versão nova no GitHub (instalador, pacote do add-on, SHA-256 e notas), e a seção `## Novidades` do PR vira as novidades da versão. Ninguém edita número de versão à mão. Detalhes em [`docs/releases.md`](docs/releases.md).
- Onde fica cada coisa: o plugin em [`src/plugins/telinha/`](src/plugins/telinha/) (mesmo layout de plugin do Vencord, por isso os imports `@plugins/telinha/...`; o protocolo P2P está em `protocol.ts`), o carregador e o build do add-on em [`addon/`](addon/) (contrato do pacote em [`addon/PAYLOAD.md`](addon/PAYLOAD.md)), o instalador em Go em [`installer/`](installer/), o auxiliar de áudio em C++ em [`native-audio/`](native-audio/) e o desenho da prova de identidade em [`docs/identity.md`](docs/identity.md).
- **Amigo virtual** para testar sozinho, sem uma segunda pessoa: uma página que fala o mesmo protocolo do plugin, em [`tools/telinha-peer/`](tools/telinha-peer/). Sirva com:

  ```sh
  python -m http.server 8788 --directory tools/telinha-peer
  ```

  e abra `http://localhost:8788`. Detalhes em [`tools/telinha-peer/README.md`](tools/telinha-peer/README.md).
- As constantes do protocolo estão duplicadas entre o plugin e o amigo virtual; mantenha as duas em sincronia.
- **Teste da placa de vídeo** para mandar a um amigo: [`tools/teste-placa/teste-placa.html`](tools/teste-placa/teste-placa.html), um arquivo só que abre direto do disco no Chrome ou no Edge, testa o encoder de vídeo da placa (WebCodecs e WebRTC em loopback) e gera um texto para colar de volta. Detalhes em [`tools/teste-placa/README.md`](tools/teste-placa/README.md).

## Créditos e licença

Criado por **Humberto Fernandes** ([@HumbertoFernandes7](https://github.com/HumbertoFernandes7)).

O Telinha é **baseado no [Vencord](https://github.com/Vendicated/Vencord)**, da equipe do Vencord: é um plugin do Vencord, compilado contra o código-fonte dele e carregado pelo Vencord oficial instalado no seu PC. Usa também a biblioteca [Trystero](https://github.com/dmotz/trystero) para descoberta de pares. Este projeto **não é afiliado** ao Discord nem à equipe do Vencord, e **não tem suporte** da equipe do Vencord.

Licenciado sob a **GPL-3.0-or-later**, a mesma licença do Vencord. Veja o arquivo [`LICENSE`](LICENSE).

## Versões de teste antigas

As primeiras versões de teste (`teste-1` e `teste-2`) eram um fork do Vencord 1.15.13 com o Telinha incluído, num ZIP com `instalar.cmd` e `restaurar.cmd`, que substituía os arquivos de `%APPDATA%\Vencord\dist`. Elas e o código daquela época estão no repositório arquivado [Telinha-fork-antigo](https://github.com/HumbertoFernandes7/Telinha-fork-antigo). Não use mais: se instalou uma delas, rode o `restaurar.cmd` dela (com o Discord fechado por completo) **antes** de usar o `TelinhaInstaller.exe`.

---

## English summary

**Telinha** lets friends in the same Discord voice channel stream their screen or a window to each other and watch **inside Discord**, directly between their PCs (peer-to-peer, WebRTC). It is free and there is no server of ours: public Nostr relays (through the Trystero library) are used only so peers can find each other, and the video goes straight PC to PC (STUN only). It supports up to 1080p at 60 fps, and captures audio: the sound of a single window, or, for whole-screen streams, all PC sound except Discord's (Windows 10 2004+; done by a small unsigned helper, `telinha-audio.exe`, which antivirus or Smart App Control may block, in which case the screen streams without sound).

It is a plugin for [Vencord](https://github.com/Vendicated/Vencord) (a Discord client mod): early, but an official release ([latest version](https://github.com/HumbertoFernandes7/Telinha/releases/latest)). You keep the **official Vencord**: install Telinha with [**`TelinhaInstaller.exe`**](https://github.com/HumbertoFernandes7/Telinha/releases/latest/download/TelinhaInstaller.exe) (direct download of the latest release; notes on the [latest release page](https://github.com/HumbertoFernandes7/Telinha/releases/latest)). SmartScreen will warn because it is not code-signed yet: "More info" > "Run anyway". Click Install and reopen Discord; Telinha comes enabled. It does not modify Vencord's files; running the installer again and choosing Uninstall puts Vencord back exactly as before. Telinha updates itself: when Discord opens (and every 6 hours) it checks GitHub, downloads a new version in the background, verifies its SHA-256 and applies it on the next Discord restart, rolling back on its own if the new version fails to start ("Atualizar automaticamente" in the plugin settings turns this into a notice only). If you use the Vencord installer's "Repair", run the Telinha installer again. It needs official Vencord to be installed first.

- **Requirements:** Windows 10 2004+/11, Discord desktop with official Vencord. Everyone who streams or watches needs Telinha.
- **Verified so far:** screen/window capture in stock Discord on Windows, window audio, a direct connection between two homes (720p, ~57 fps, 0% loss), viewing in a separate Discord window, and the installer + add-on on top of the official Vencord on a real PC (streaming with whole-screen audio working).
- **Available, not yet tested between two real PCs:** watching right inside the call view (an "Assistir" button on the person's tile, which can still pop out into a separate window) and the viewer controls: a "Quem está assistindo" (who is watching) list with Expulsar (kick) and Liberar (unblock), a warning when two connections claim the same Discord account (neither gets the stream), "Quem pode assistir" (who can watch), chosen when you start streaming: everyone in the call, only your Discord friends, only people you approve, or a per-stream password; and Discord-verified identity (a one-time "Autorizar" in Discord's own window, so nobody can pretend to be someone else in the call).
- **Privacy:** a direct connection means people in the call can see each other's IP. Only people in the same voice channel are accepted by default, there is an optional group password, and logs never contain IP addresses.
- **Limitations:** each viewer gets a separate copy from the streamer (2-4 viewers recommended); exclusive-fullscreen games may show black (use borderless); no DLL injection into games.
- **Support:** use "Copy diagnostics" in the plugin settings and send it to the author; GitHub Issues are not used in this repository.
- **Developers:** this repo holds only Telinha's code; the official Vencord commit pinned in `vencord.json` is fetched into `.vencord/` (gitignored) by `pnpm bootstrap`. See [Para desenvolvedores](#para-desenvolvedores) for the commands (`pnpm check`, `pnpm build:addon`, `pnpm build:installer`).
- **Credits and disclaimer:** based on Vencord by the Vencord team; not affiliated with Discord or the Vencord team, and not supported by the Vencord team. Client mods violate Discord's Terms of Service, so use it at your own risk.
- **License:** GPL-3.0-or-later, like Vencord.
- **Old test builds:** `teste-1` and `teste-2` (a Vencord 1.15.13 fork installed from a zip with `instalar.cmd`) are obsolete and live in the archived repo [Telinha-fork-antigo](https://github.com/HumbertoFernandes7/Telinha-fork-antigo); run their `restaurar.cmd` before using the installer.
