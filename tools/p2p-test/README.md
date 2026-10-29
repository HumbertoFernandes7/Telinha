# PeerLive — página de teste do spike P2P

Página fora do Discord que fala **exatamente o mesmo protocolo** do plugin
`src/plugins/peerLiveP2PTest` (Trystero 0.26.0 via Nostr + WebRTC direto, só STUN):
mesmo app id, mesma derivação da sala, mesma senha, mesmos relays, mesmas ações
(`presence`, `watch`) e mesmo handshake. As constantes estão duplicadas em
`p2p-test.js` e em `src/plugins/peerLiveP2PTest/protocol.ts` — **mantenha as duas
em sincronia**.

Arquivos:

- `index.html` + `p2p-test.js` — a página (Trystero vem do jsDelivr, versão fixa
  `trystero@0.26.0`).
- `measure-relays.mjs` — mede os relays Nostr a partir da sua máquina (conexão,
  REQ→EOSE, publicação→OK e publicação→entrega do evento efêmero do Trystero).

## Como servir

Módulos ES não funcionam por `file://`; use qualquer servidor HTTP local, a partir
da raiz do repositório:

```sh
npx serve tools/p2p-test
# ou
python -m http.server 8787 --directory tools/p2p-test
```

Abra o endereço que aparecer (ex.: `http://localhost:3000` ou
`http://localhost:8787`).

## Teste com duas janelas

1. Abra a página em **duas janelas lado a lado** (de preferência não em abas: aba em
   segundo plano é estrangulada pelo navegador e distorce as medidas; o relógio do
   padrão roda num Worker para minimizar isso).
2. Em cada janela use um "ID do Discord (falso)" diferente (já vem aleatório) e o
   **mesmo** `guildId`, `channelId` e senha do grupo. Qualquer texto serve como
   channelId para teste.
3. Clique **Entrar na sala** nas duas. Em ~1 s cada uma deve ver a outra em
   "Peers na sala", com o tipo da conexão (ex.: `host ↔ host · UDP · mDNS/mDNS`).
4. Numa janela clique **Transmitir padrão de teste**; na outra, **Assistir**. Os
   tempos (ICE, ontrack, 1º quadro) e as stats por segundo aparecem na tela.
5. **Baixar log** salva o mesmo JSON que o plugin grava em
   `%APPDATA%\PeerLive-test\` (sem IPs).

Atalho por URL (a senha nunca vai na URL):
`?userId=111&username=ana&guildId=teste&channelId=canal1&members=222`

O campo "IDs no canal de voz" simula o `VoiceStateStore`: peers cujo ID não está na
lista aparecem marcados "FORA DO CANAL" (ou são recusados, se marcar a caixa).

## Testar contra o Discord

Para a página conversar com um Discord rodando o plugin, digite o `guildId` (vazio
ou `dm` em DM/grupo) e o `channelId` reais do canal de voz (modo desenvolvedor do
Discord → botão direito → Copiar ID) e a mesma senha do grupo. O plugin vai marcar a
página como "FORA DO CANAL", porque o ID falso não está na call — é o esperado.

## Medir os relays de novo

```sh
node tools/p2p-test/measure-relays.mjs 3                 # lista padrão, 3 rodadas
node tools/p2p-test/measure-relays.mjs 5 nos.lol relay.primal.net
```

Só relays com `ok 3/3` (aceitaram **e** entregaram o evento) servem para a
sinalização. Se trocar a lista, atualize `protocol.ts` e `p2p-test.js` juntos.
