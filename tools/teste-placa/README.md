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
3. Ele clica em **Testar minha placa de vídeo** e espera uns 2 minutos com a página na frente.
4. No fim, ele clica em **Copiar resultado** e cola na conversa. Se o texto passar de 2000 caracteres, o
   Discord vira um `message.txt`; tudo bem.
5. Opcional: **Testar também com a minha tela** repete a parte 2 com a tela de verdade (pede para
   compartilhar a tela inteira). É o único jeito de ver `encoderImplementation`/`powerEfficientEncoder`: o
   Chromium só mostra esses campos no `getStats` quando a página tem uma captura ativa. Com a animação eles
   saem como `enc ?`.

Ele também pode colar a versão do driver no campo opcional (o `chrome://gpu` mostra "Driver version").

## O que a página testa

**Parte 1, WebCodecs** (o encoder sozinho, sem WebRTC). Cada teste roda num `Worker` novo (criado por
`Blob`, que funciona em `file://`): `isConfigSupported`, depois 60 quadros de um `OffscreenCanvas` no ritmo
do fps, `flush()` e `close()`. Anota se é suportado, quantos pacotes saíram, quantos são quadros-chave,
o tempo até o primeiro pacote e qualquer erro. Ordem: VP9 por software (controle), depois H.264 com
`prefer-hardware`, e por fim uma linha `no-preference`.

O WebCodecs confere o nível H.264 contra o tamanho: `avc1.42001f` (nível 3.1) é recusado em 1080p. Por
isso 1080p usa `avc1.42002a`, que é o mesmo perfil Baseline do Telinha com nível 4.2. No WebRTC isso não
acontece, porque o Chromium passa para a placa só o perfil, não o nível do SDP.

**Parte 2, WebRTC** (como o Telinha). Um par de `RTCPeerConnection` em loopback na página, com conexões
novas a cada teste e fechadas antes do próximo. O codec nunca é trocado no ar. A fonte é um `<canvas>`
1920x1080 animado (`captureStream(fps)`) ou a tela. O teste "igual ao Telinha hoje" repete o plugin:

- `core/codec.ts`: `setCodecPreferences` com o perfil 42001f na frente e o resto como alternativa;
- `core/sdp.ts`: o mesmo perfil na frente do SDP remoto, mais `x-google-start-bitrate`/`x-google-max-bitrate`;
- `core/streaming.ts` e `core/quality/levels.ts`: `contentHint "motion"`, `maxBitrate`, `maxFramerate`,
  `scaleResolutionDownBy` par (`evenScale`), `priority`/`networkPriority "high"` e
  `degradationPreference "maintain-framerate"`.

O perfil pedido entra no SDP dos dois lados (setCodecPreferences + munging) e é conferido no
`getStats` (`codecId` → `sdpFmtpLine`, a coluna `neg` do resultado). Cada teste lê o `getStats` uma vez por
segundo durante 6 s:

- `outbound-rtp`: `encoderImplementation`, `powerEfficientEncoder`, `framesEncoded`, `framesSent`, `bytesSent`,
  `frameWidth`/`frameHeight` e `qualityLimitationReason`;
- `inbound-rtp`: `framesDecoded` e `decoderImplementation`;
- `media-source`: os quadros da captura.

Ordem: VP9 (controle); H.264 42001f em 720p30, 1080p30 e 1080p60 (= Telinha); 42e01f; Main e High (só se
o navegador oferecer o perfil); e por último as variantes de nível 5.2 (420034, 42e034).

Mantenha esses trechos em sincronia com o plugin quando ele mudar.

## Segurança contra travamento

- Todo `getStats`, `createOffer`/`createAnswer`, `set*Description`, `setParameters` e `replaceTrack` tem
  limite de 4 s. Na parte 1, o Worker tem 5 s sem dar sinal em qualquer fase. Estourou = **TRAVOU**, e a
  rodada para.
- Encoder preso não é tocado. Um Worker que travou fica como está (sem `terminate()`). Uma conexão WebRTC
  cujo envio não gera imagem fica aberta e intocada, sem `close`, `setParameters`, `removeTrack`,
  `replaceTrack` ou `getStats`: desmontar um encoder de hardware preso trava a thread de WebRTC do processo
  inteiro, que é o que derrubou o Discord do amigo. A rodada para, e a página pede para fechar o navegador
  antes de continuar.
- Só um envio que funcionou é fechado: `replaceTrack(null)` com limite, depois `close()`, com o tempo medido.
- O progresso vai para o `localStorage` antes de cada fase e depois de cada teste. Se a página travar e for
  reaberta, o teste em andamento aparece como TRAVOU e o botão vira **Continuar do teste N**.

## O texto do resultado

O texto traz:

- o `navigator.userAgent` e o `userAgentData` (`fullVersionList` e `platformVersion`);
- a placa pelo WebGPU (`adapter.info`) e pelo WebGL (`UNMASKED_RENDERER_WEBGL`), e o driver se ele informou;
- os perfis H.264 de envio e de recebimento;
- a sonda do Telinha (`encodingInfo`, 1080p60, 8 Mbps);
- uma linha por teste com os números.

Não tem endereço de IP: é loopback e nada de SDP vai para o texto, mas a página ainda limpa qualquer coisa
com cara de IP ou de candidato ICE.

Exemplo (Edge 156 em modo headless, RTX 3070, captura falsa na parte 2):

```text
Sonda do Telinha (encodingInfo 1080p60 8M): 42001f=placa 42e01f=proc 4d001f=placa 640032=placa
02 WC avc1.42001f 720p30 hw: FUNCIONA | suportado | 60 quadros → 60 pacotes (1 chave) 1.08MB | 1o pacote 216ms | fila máx 7 | 1970ms
13 RTC H264 42001f 1080p60 (=Telinha): FUNCIONA (placa) | neg 42001f asym=1 | enc MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT) hw | cod 119 env 119 dec 119 | ...
14 RTC H264 42e01f 720p30: FUNCIONA (processador) | neg 42e01f asym=1 | enc OpenH264 sw | ...
```

## Testar localmente

Abra o arquivo no Chrome ou no Edge e clique no botão. Para automatizar, use o Edge em modo headless com
`--remote-debugging-port` e um perfil temporário (`--user-data-dir`), e clique nos botões pelo DevTools
Protocol. Para a parte 2 com tela, use `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`.
