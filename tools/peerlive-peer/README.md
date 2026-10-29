# PeerLive — amigo virtual

Página fora do Discord que fala **exatamente o protocolo P2P v1** do plugin
`src/plugins/peerLive` (Trystero 0.26.0 via Nostr + WebRTC direto, só STUN). Serve para
testar o plugin do Discord localmente **sem uma segunda pessoa**: a página entra na mesma
sala do canal de voz, transmite (padrão de teste ou uma tela/aba do navegador) e assiste à
transmissão do plugin.

As constantes do protocolo (app id `peerlive-v1`, derivação da sala, relays, ICE, ações
`presence`/`watch`, handshake `peerlive-hello`, metadado `peerlive-screen`, versão 1) estão
duplicadas em `peerlive-peer.js` e em `src/plugins/peerLive/protocol.ts` — **mantenha as
duas em sincronia**.

Arquivos: `index.html` + `peerlive-peer.js` (sem build; o Trystero vem do jsDelivr, versão
fixa `trystero@0.26.0`).

## Como servir

Módulos ES não funcionam por `file://`; sirva por HTTP local, a partir da raiz do
repositório:

```sh
python -m http.server 8788 --directory tools/peerlive-peer
```

Abra `http://localhost:8788`. (`localhost` conta como contexto seguro, então
`getDisplayMedia` funciona.)

## Campos

| Campo | Para quê |
| --- | --- |
| ID do Discord (falso) | Vai no handshake e na presença. Já vem aleatório (um por janela). Se o plugin só aceita quem está no canal de voz, use o ID de uma conta real que está na call. |
| Nome | Aparece para o plugin (padrão `Amigo virtual`). |
| guildId | ID do servidor. Vazio ou `dm` = DM/grupo. |
| channelId | ID do canal de voz. A sala é `SHA-256("peerlive-v1\|" + (guildId ou "dm") + "\|" + channelId)` em hex minúsculo. |
| Senha do grupo | Vira o `password` do Trystero; precisa ser igual à do plugin (vazio = sem senha). |
| IDs "no canal de voz" | Opcional: simula a admissão. Peers fora da lista aparecem marcados "FORA DO CANAL" (ou são recusados, se marcar a caixa). Vazio = não verifica. |
| Anunciar `caps.h264HwDecode` | Pré-marcado com o resultado de `navigator.mediaCapabilities.decodingInfo` (WebRTC H.264 1080p60 8 Mbps → `powerEfficient`; `false` em erro). Desmarque/marque para **sobrescrever** e testar a escolha de codec do plugin; "usar o detectado" volta ao valor real. Mudar a caixa reenvia a presença. |

Atalhos por URL (todos opcionais): `?guild=...&channel=...&name=...&user=...&password=...&members=...`.
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
3. No Discord (plugin PeerLive, na mesma call), a página deve aparecer como transmitindo
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

Se o navegador bloquear o autoplay com som, o vídeo inicia mudo (ligue o som nos
controles do vídeo).

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
- Para automação/console: `window.peerlive` (`state()`, `join({...})`, `leave()`,
  `startTestStream()`, `stopStream()`, `watch(peerId)`, `stopWatching(peerId)`, `log()`).
