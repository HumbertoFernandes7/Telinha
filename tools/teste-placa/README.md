# Telinha — teste da placa de vídeo

`teste-placa.html` é uma página de um arquivo só (CSS e JS embutidos, sem rede, sem CDN) que testa o
encoder de vídeo da placa **fora do Discord**, no Chrome ou no Edge, que usam o mesmo Chromium e o mesmo
encoder MediaFoundation do Discord. Serve para descobrir, sem pedir para o amigo transmitir e mandar log
várias vezes, se a placa dele gera vídeo H.264 e em qual configuração.

Ela abre direto do disco (`file://`): não precisa de servidor.

## Como mandar para um amigo

1. Arraste `tools/teste-placa/teste-placa.html` para a conversa do Discord com ele (vai como anexo).
2. Ele baixa o arquivo e dá dois cliques. Se abrir em outro navegador (Firefox, Opera), é só clicar com o
   botão direito → **Abrir com** → **Google Chrome** ou **Microsoft Edge**.
3. **Passo 1:** ele clica no botão azul e espera com a página na frente (1 a 2 minutos).
4. **Passo 2:** ele clica em **Passo 2: testar com a minha tela** e escolhe **Tela inteira**.
5. Por último, ele coloca a versão do driver, se achar (a página explica onde: AMD Software → engrenagem →
   Sistema, ou NVIDIA App → Drivers, ou `edge://gpu`). Depois clica em **Copiar resultado** e cola na
   conversa. Se o texto passar de 2000 caracteres, o Discord vira um `message.txt`; tudo bem.

O passo 2 não é opcional na prática: só com uma captura ativa o Chromium mostra `encoderImplementation` e
`powerEfficientEncoder` no `getStats`. Com a animação eles saem como `enc ?`, e uma placa que falha no
`InitEncode` cai calada para o OpenH264 e aparece como "FUNCIONA". A captura de tela também entrega quadros
na GPU, como no Discord, enquanto o canvas entrega quadros I420 na CPU.

## O que a página testa

**Parte 1, WebCodecs** (o encoder sozinho, sem WebRTC; só no passo 1). Cada teste roda num `Worker` novo
(criado por `Blob`, que funciona em `file://`): `isConfigSupported`, depois 60 quadros de um `OffscreenCanvas`
no ritmo do fps, `flush()` e `close()`. Anota se é suportado, quantos pacotes saíram, quantos são
quadros-chave, o tempo até o primeiro pacote e qualquer erro. Ordem: VP9 por software (controle), depois H.264
com `prefer-hardware`, e por fim uma linha `no-preference`. Se um H.264 na placa não gerar nada ou travar,
os H.264 seguintes da parte 1 são pulados (com o motivo no texto): cada um travaria de novo, e o
`no-preference` também tenta a placa primeiro.

O WebCodecs confere o nível H.264 contra o tamanho: `avc1.42001f` (nível 3.1) é recusado em 1080p. Por
isso 1080p usa `avc1.42002a`, que é o mesmo perfil Baseline do Telinha com nível 4.2. No WebRTC isso não
acontece, porque o Chromium passa para a placa só o perfil, não o nível do SDP.

**Parte 2, WebRTC** (como o Telinha). Um par de `RTCPeerConnection` em loopback na página, com conexões
novas a cada teste e fechadas antes do próximo. O codec nunca é trocado no ar. No passo 1 a fonte é um
`<canvas>` 1920x1080 animado (`captureStream(fps)`) e só rodam o VP9 (controle) e o "igual ao Telinha hoje".
No passo 2 a fonte é a tela e roda a lista inteira:

1. VP9 (controle);
2. H.264 42001f em 720p30, 1080p30 e 1080p60 (este é o igual ao Telinha hoje);
3. 42e01f;
4. Main e High 5.2, só se o navegador oferecer o perfil;
5. por último, as variantes de nível 5.2 (420034 e 42e034).

O teste "igual ao Telinha hoje" repete o plugin:

- `core/codec.ts`: `setCodecPreferences` com o perfil 42001f na frente e o resto como alternativa;
- `core/sdp.ts`: o mesmo perfil na frente do SDP remoto, mais `x-google-start-bitrate`/`x-google-max-bitrate`;
- `core/streaming.ts` e `core/quality/levels.ts`: `contentHint "motion"`, `maxBitrate`, `maxFramerate`,
  `scaleResolutionDownBy` par (`evenScale`), `priority`/`networkPriority "high"` e
  `degradationPreference "maintain-framerate-and-resolution"` (senão `"maintain-framerate"`), e o
  `x-google-start-bitrate` fixo em 4000.

O perfil pedido entra no SDP dos dois lados (setCodecPreferences + munging) e é conferido no
`getStats` (`codecId` → `sdpFmtpLine`, a coluna `neg` do resultado). Cada teste lê o `getStats` uma vez por
segundo durante 6 s:

- `outbound-rtp`: `encoderImplementation`, `powerEfficientEncoder`, `framesEncoded`, `framesSent`, `bytesSent`,
  `frameWidth`/`frameHeight` e `qualityLimitationReason`;
- `inbound-rtp`: `framesDecoded` e `decoderImplementation`;
- `media-source`: os quadros da captura.

**Aba escondida.** Com a aba escondida, o Chromium segura os timers e a animação cai para ~1 fps. Por isso
a parte 2 trata a aba escondida assim:

- Só começa um teste com a aba visível. A página mostra "Volte para esta aba para continuar" e muda o título.
- Se a aba some durante a medição, as leituras são jogadas fora e a medição recomeça quando ela volta.
- Se a aba fica escondida mais de 1 minuto, o teste é **REPETIR**: fecha (é seguro, porque o encoder gerou
  quadros ou nenhum quadro chegou nele) e é refeito do zero quando a aba volta. Se ainda assim não der, fica
  para o **Continuar**.
- Uma captura que não entregou nenhum quadro ao encoder também vira REPETIR.

Mantenha esses trechos em sincronia com o plugin quando ele mudar.

## Segurança contra travamento

- Todo `getStats`, `createOffer`/`createAnswer`, `set*Description`, `setParameters` e `replaceTrack` tem
  limite de 4 s. Na parte 1, o Worker tem 5 s sem dar sinal em qualquer fase. Estourou = **TRAVOU**, e a
  rodada para.
- Encoder preso não é tocado:
  - Um Worker que travou fica como está (sem `terminate()`).
  - Uma conexão WebRTC cujo envio recebeu quadros e não gerou imagem fica aberta e intocada: sem `close`,
    `setParameters`, `removeTrack`, `replaceTrack` ou `getStats`. Desmontar um encoder de hardware preso trava
    a thread de WebRTC do processo inteiro.
  - Um fechamento que estourou o limite também deixa as conexões em paz.

  Em todos esses casos, os botões ficam bloqueados até reabrir o navegador.
- O progresso vai para o **IndexedDB**, uma transação `durability: "strict"` por gravação, esperada antes de
  cada fase arriscada. O localStorage fica de reserva. O localStorage do Chromium grava no disco em lote (o
  primeiro depois de ~5 s, depois com limite de ritmo), então matar o navegador pelo Gerenciador de Tarefas
  perdia o que estava pendente: morto no teste 12, voltava oferecendo o teste 3.
- Ao reabrir, o teste em andamento aparece como TRAVOU e o botão vira **Continuar o passo N**. Se o navegador
  não deixar guardar nada, a página avisa ao abrir.
- O aviso de travamento manda clicar em **Sair das páginas** quando aparecer "Página sem resposta" (mata só a
  aba). Se o navegador inteiro travar, manda usar o Gerenciador de Tarefas.

## O texto do resultado

O texto traz:

- o `navigator.userAgent` e o `userAgentData` (`fullVersionList` e `platformVersion`);
- a placa pelo WebGPU (`adapter.info`) e pelo WebGL (`UNMASKED_RENDERER_WEBGL`), e a versão do driver
  informada;
- os perfis H.264 de envio e de recebimento;
- a sonda do Telinha (`encodingInfo`, 1080p60, 8 Mbps);
- onde o progresso ficou guardado;
- uma linha por teste com os números.

Nenhum SDP entra no texto. Mesmo assim, linhas de candidato ICE e nomes mDNS são removidos. Não há regra de
IP "solta", porque ela comia versões de driver com 4 partes (`32.0.12.19`).

Exemplo (Edge 156 em modo headless, RTX 3070, captura falsa no passo 2):

```text
Sonda do Telinha (encodingInfo 1080p60 8M): 42001f=placa 42e01f=proc 4d001f=placa 640032=placa
02 WC avc1.42001f 720p30 hw: FUNCIONA | suportado | 60 quadros → 60 pacotes (1 chave) 1.08MB | 1o pacote 170ms | fila máx 5 | 1969ms
13 RTC H264 42001f 1080p60 (=Telinha): FUNCIONA (placa) | neg 42001f asym=1 | enc MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT) hw | cod 119 env 119 dec 119 | ...
14 RTC H264 42e01f 720p30: FUNCIONA (processador) | neg 42e01f asym=1 | enc OpenH264 sw | ...
```

## Testar localmente

Abra o arquivo no Chrome ou no Edge e faça os dois passos. Para automatizar, use o Edge em modo headless com
`--remote-debugging-port` e um perfil temporário (`--user-data-dir`), e clique nos botões pelo DevTools
Protocol. Para o passo 2, use `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`. Para testar
o caminho de matar o navegador, use `taskkill /T /F` na árvore do Edge no meio de um teste e reabra com o
mesmo perfil.
