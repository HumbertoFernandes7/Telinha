# Telinha — amigo virtual

Página fora do Discord que fala **exatamente o protocolo P2P v1** do plugin
`src/plugins/telinha` (Trystero 0.26.0 via Nostr + WebRTC direto, só STUN). Serve para
testar o plugin do Discord localmente **sem uma segunda pessoa**: a página entra na mesma
sala do canal de voz, transmite (padrão de teste ou uma tela/aba do navegador) e assiste à
transmissão do plugin.

As constantes do protocolo (app id `telinha-v1`, derivação da sala, relays, ICE, ações
`presence`/`watch`, handshake `telinha-hello`, metadado `telinha-screen`, versão 1) estão
duplicadas em `telinha-peer.js` e em `src/plugins/telinha/protocol.ts` — **mantenha as
duas em sincronia**.

Arquivos: `index.html` + `telinha-peer.js` + `password-proof.js` (sem build; o Trystero vem do
jsDelivr, versão fixa `trystero@0.26.0`). `password-proof.js` é a cópia da prova de senha de
`src/plugins/telinha/core/access.ts`, com o **mesmo vetor de teste**: `pnpm test:file src/plugins/telinha/core/access.test.ts` confere as
duas sem navegador, e a página roda o vetor ao carregar ("Prova de senha: vetor de teste
compartilhado com o plugin OK" em Eventos).

## Como servir

Módulos ES não funcionam por `file://`; sirva por HTTP local, a partir da raiz do
repositório:

```sh
python -m http.server 8788 --directory tools/telinha-peer
```

Abra `http://localhost:8788`. (`localhost` conta como contexto seguro, então
`getDisplayMedia` funciona.)

## Campos

| Campo | Para quê |
| --- | --- |
| ID do Discord (falso) | Vai no handshake e na presença. Já vem aleatório (um por janela). Se o plugin só aceita quem está no canal de voz, use o ID de uma conta real que está na call. |
| Nome | Aparece para o plugin (padrão `Amigo virtual`). |
| guildId | ID do servidor. Vazio ou `dm` = DM/grupo. |
| channelId | ID do canal de voz. A sala é `SHA-256("telinha-v1\|" + (guildId ou "dm") + "\|" + channelId)` em hex minúsculo. |
| Senha do grupo | Vira o `password` do Trystero; precisa ser igual à do plugin (vazio = sem senha). |
| IDs "no canal de voz" | Opcional: simula a admissão. Peers fora da lista aparecem marcados "FORA DO CANAL" (ou são recusados, se marcar a caixa). Vazio = não verifica. |
| Senha da minha transmissão | Opcional: com texto, a transmissão desta página é "Com senha" (`stream.access: "password"` na presença; desafio-resposta igual ao do plugin, 5 erros bloqueiam até parar de transmitir). Vazio = "Todos da call". Mudar no meio da transmissão vale para os próximos pedidos. Nunca é lembrada. |
| Anunciar `caps.h264HwDecode` | Pré-marcado com o resultado de `navigator.mediaCapabilities.decodingInfo` (WebRTC H.264 1080p60 8 Mbps → `powerEfficient`; `false` em erro). Desmarque/marque para **sobrescrever** e testar a escolha de codec do plugin; "usar o detectado" volta ao valor real. Mudar a caixa reenvia a presença. |

Atalhos por URL (todos opcionais): `?guild=...&channel=...&name=...&user=...&password=...&members=...&streamPassword=...`.
Também valem `autojoin=1` (entra na sala sozinho, exige `channel`) e `autostream=1`
(já transmite o padrão de teste). Cuidado: a senha na URL fica no histórico do navegador —
use só senhas de teste. O ID falso e a senha não são lembrados entre janelas; guild, canal e
nome são (último usado).

## Como pegar guildId / channelId

1. Discord → Configurações → Avançado → ative **Modo desenvolvedor**.
2. Botão direito no **servidor** (ícone) → **Copiar ID do servidor** = `guildId`.
3. Botão direito no **canal de voz** → **Copiar ID do canal** = `channelId`.
4. Em DM/chamada de grupo não há guildId: deixe vazio (ou `dm`) e use o ID da DM/grupo como
   `channelId`.

## Fluxo 1 — a página transmite, o Discord assiste

1. Abra a página, preencha guildId/channelId (e a senha, se houver) e clique **Entrar na sala**.
2. Clique **Transmitir padrão de teste** (canvas 1920x1080 @ 60 fps, relógio grande em ms,
   contador de quadros e um tom baixo) ou **Transmitir uma tela/aba do navegador**
   (`getDisplayMedia`, com áudio se o navegador oferecer).
3. No Discord (plugin Telinha, na mesma call), a página deve aparecer como transmitindo
   ("Amigo virtual — Padrão de teste"). Peça para assistir.
4. Aqui, em "Minha transmissão", aparecem por espectador: resolução, fps, bitrate, codec,
   RTT, perda e o motivo de limitação do encoder. Cada espectador recebe `contentHint=motion`,
   `maxBitrate` 8 Mbps e `maxFramerate` 60.
5. **Parar transmissão** envia presença `streaming:false` e remove o stream de todos.

Trocar de fonte (padrão ↔ tela) passa por `streaming:false` → `streaming:true`; o espectador
precisa pedir de novo.

## Fluxo 2 — o Discord transmite, a página assiste

1. Entre na sala aqui e comece a transmitir no Discord com o plugin.
2. Em "Peers na sala" o peer do plugin aparece com "● transmitindo" (título, tipo
   `screen`/`window`, resolução, fps, áudio) e o botão **Assistir** (envia `watch start`).
3. O vídeo aparece com stats ao vivo: resolução, fps, kbps, **codec** (ex.: `H264
   (42e01f)` ou `VP8`), decoder (software/HW), perda, jitter, quadros perdidos, e os tempos
   até o 1º quadro. **Parar** envia `watch stop`.
4. Para testar a escolha de codec do plugin, alterne a caixa `caps.h264HwDecode`, peça
   para assistir de novo e confira o codec mostrado (o plugin lê `caps` da presença).

**O som começa sempre desligado (cuidado com o eco).** Todo stream recebido inicia
**mudo**; cada vídeo tem o botão **"Ativar som (cuidado: no mesmo PC causa eco)"** (volta a
"Silenciar" quando ligado; vale também o botão de volume do próprio player). Motivo: ao
testar **no mesmo PC**, a transmissão do plugin leva o áudio da tela inteira (o do PC menos
o Discord); se esta página tocasse esse áudio com som, o que ela toca entraria de novo na
captura do streamer e voltaria para cá, em eco infinito. Só ligue o som se o streamer e esta
página estiverem em PCs diferentes (fones não resolvem: a captura pega tudo o que o PC
reproduz, seja em caixa ou em fone). Um stream sem trilha de áudio mostra o botão
desabilitado ("Sem áudio nesta transmissão").

## Fluxo 3 — aprovação e expulsão (o Discord decide quem assiste)

Testa o lado transmissor do plugin: a página é o espectador e o plugin aprova, recusa ou
expulsa. O plugin responde na própria ação `watch` com `{ op: "pending" }` (esperando a
aprovação) ou `{ op: "denied", reason }`; a página trata as duas (a validação é a mesma de
`parseWatchReply` em `src/plugins/telinha/protocol.ts`; motivo desconhecido vira "recusou").

1. No Discord, comece a transmitir com **Quem pode assistir: Só quem eu aprovar** (ou deixe "Todos da call" com "Exigir identidade verificada" ligada: o amigo virtual é sempre "não verificado").
2. Aqui, entre na sala com o ID de uma conta que está na call (veja "Campos") e clique
   **Assistir** no peer do plugin.
3. O card de "Assistindo" mostra **Aguardando o transmissor aprovar…** (o plugin espera até
   60 s; a página só desiste depois de 75 s). No Discord, o pedido aparece na barra do
   Telinha. Resultados:
   - **Permitir**: o vídeo chega normalmente e a linha de estado some.
   - **Recusar**: o card mostra **O transmissor recusou**.
   - **Expulsar** (no pedido pendente ou com a página já assistindo): **O transmissor te
     expulsou**. Vale até o transmissor sair da call (ou usar **Liberar** na lista de
     espectadores); pedir de novo antes disso volta a ser recusado.
   - Não responder por 60 s: **O pedido expirou (pode pedir de novo)**.
   - **Outra conexão diz ser a mesma conta do Discord**: com a primeira janela aguardando ou
     assistindo, abra uma segunda janela da página com o *mesmo* ID falso (`?user=...` igual
     nas duas) na mesma sala; o plugin nega às duas.
4. Em qualquer recusa a página para de esperar, solta o vídeo, mostra o motivo em vermelho,
   registra o evento no log e a linha do peer volta a mostrar **Assistir** (clique para pedir
   de novo; **Parar** no card só fecha o card, sem avisar o transmissor, que já sabe).

Sem aprovação ligada o plugin não manda `pending`: o card fica em **Conectando…** até o
vídeo chegar (ou 30 s sem resposta); expulsar e duplicata continuam valendo.

## Fluxo 4 — "Quem pode assistir" (senha, só amigos, aprovação)

Em "Peers na sala", a linha de quem transmite mostra **quem pode assistir** (o `stream.access` da
presença): "todos da call", "🔒 com senha", "👥 só amigos" ou "✋ com aprovação" (sem o campo =
v0.1.0).

- **Com senha** (o Discord transmite com "Com senha"): **Assistir** → o card mostra
  **Transmissão com senha: digite a senha** e um campo. **Enviar senha** calcula a prova
  (`HMAC-SHA256`, a senha nunca trafega) e manda `{ op: "start", proof }`. Senha errada: **Senha
  incorreta (restam N tentativas)**; na 5ª: **Senha errada 5 vezes: bloqueado até a transmissão
  acabar** (o plugin mostra a pessoa em "Removidos", com **Liberar**). A senha certa fica lembrada
  enquanto aquela transmissão durar: **Parar** e **Assistir** de novo não pergunta outra vez.
  No console: `telinha.submitPassword(peerId, "senha")`.
- **Só meus amigos do Discord**: o amigo virtual não tem token do Discord, então é sempre "não
  verificado" e recebe **Não verificado…** (`notVerified`), mesmo usando o ID de um amigo de verdade.
  É o resultado esperado.
- **Só quem eu aprovar**: igual ao Fluxo 3 (`pending` → Permitir/Recusar).
- **A página transmite com senha** (campo "Senha da minha transmissão"): o Discord, ao clicar em
  Assistir, mostra o pedido de senha; os erros e o bloqueio aparecem em Eventos. Serve para testar o
  lado espectador do plugin com um PC só.

## Teste com duas janelas (sem Discord)

Abra a página em duas janelas **lado a lado** (de preferência não em abas: aba em segundo
plano é estrangulada e distorce medidas; o relógio do padrão roda num Worker para minimizar
isso), com o mesmo guildId/channelId/senha (qualquer texto serve para um teste só entre as
duas). Em ~1 s cada uma vê a outra; uma transmite, a outra assiste.

## Diagnóstico

- "Conexão" mostra só tipo de candidato, protocolo e família (`host ↔ host · UDP ·
  mDNS/mDNS`), nunca endereços IP. Há ping pelo canal de dados e RTT do par ICE.
- **Baixar log** salva um JSON (eventos, tempos, conexões, stats por segundo; sem IPs).
- Sem TURN: se não houver caminho P2P direto, a conexão falha (aparece em "Eventos").
- Peers que não falam v1 (handshake inválido ou `v` diferente) são recusados e o motivo
  vai para o log.
- Para automação/console: `window.telinha` (`state()`, `join({...})`, `leave()`,
  `startTestStream()`, `stopStream()`, `watch(peerId)`, `stopWatching(peerId)`,
  `submitPassword(peerId, senha)`, `log()`).
