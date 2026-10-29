# Telinha — prova de identidade do Discord entre peers

Status: **protótipo** em `src/plugins/telinha/core/identity/` (ainda não ligado à sessão).
Sem servidor nosso: só o Discord (OIDC) e os próprios peers.

## O problema

Hoje cada peer **anuncia** o seu `discordUserId` no handshake/presença e nós só conferimos se
esse id está no nosso canal de voz. Um cliente modificado pode anunciar o id de alguém que está na
call e assistir às transmissões sem estar nela.

## A ideia em uma frase

Cada peer apresenta um **id_token do Discord** (JWT RS256) cujo `nonce` é o hash do fingerprint do
**seu certificado DTLS persistente**; quem verifica confere a assinatura com o JWKS público do
Discord, `sub == id anunciado`, `aud == nosso client id`, e `nonce == hash(fingerprint DTLS que o
peer usou NESTA conexão)`. Copiar o token de outra pessoa não adianta: falta a chave privada do
certificado dela.

```
nonce = base64url( SHA-256( "telinha-dtls-v1|sha-256:" + hex_minúsculo(SHA-256(DER do certificado)) ) )
```

Sem janela de tempo no nonce: o `exp` do token já limita a validade, e uma janela só obrigaria a
reautorizar mais vezes.

## Respostas (com evidências)

### 1. Cliente público + PKCE + `nonce` pelo `OAuth2AuthorizeModal`? — **Sim**

- `https://discord.com/.well-known/openid-configuration` (baixado em 2026-10-29): `issuer`
  `https://discord.com`, `token_endpoint` `https://discord.com/api/oauth2/token`, `jwks_uri`
  `https://discord.com/api/oauth2/keys`, `id_token_signing_alg_values_supported: ["RS256"]`,
  `code_challenge_methods_supported: ["S256"]`, `authorization_response_iss_parameter_supported: true`.
- discord-userdoccers, `topics/oauth2`: escopo `openid` "includes an ID token in the token
  exchange"; o authorize aceita `nonce` ("only applicable for authorization code grants with the
  `openid` scope"), `code_challenge`/`code_challenge_method=S256`, `prompt`; na troca do code,
  `client_secret` só é exigido se o app **não** tiver a flag `PUBLIC_OAUTH2_CLIENT` ou se faltar o
  `code_verifier`. A doc oficial (`developers/topics/oauth2.mdx`) confirma `prompt=none` ("skip the
  authorization screen") e o `iss` no redirect (RFC 9207).
- **Bundle do cliente Discord** (web, `web.*.js`, 2026-10-29): o componente exportado como
  `OAuth2AuthorizeModal` desestrutura `clientId, responseType, redirectUri, codeChallenge,
  codeChallengeMethod, state, nonce, prompt, …, callback, callbackWithoutPost`, e faz
  `POST /oauth2/authorize` com `query: {client_id, response_type, redirect_uri, code_challenge,
  code_challenge_method, scope, state, nonce}`. Com `callback`, chama
  `callback({ location, … })` e fecha — **não navega** (só navega quando não há callback). Com
  `prompt === "none"` e uma autorização anterior (`authorized`), o modal se confirma sozinho.
  Enum do prompt: `{ NONE: "none", CONSENT: "consent" }`.
- **Troca do code no renderer funciona**: o token endpoint responde CORS para a própria origem do
  Discord (`access-control-allow-origin: https://discord.com`, idem `https://ptb.discord.com`;
  testado com `curl -H Origin`), e um POST com PKCE e client_id falso devolve
  `400 {"error":"invalid_client"}` em JSON. `native.ts` não é necessário. Usamos
  `credentials: "omit"` (nada de cookies, nunca o token do usuário).
- **Redirect URI**: qualquer URI registrada no app serve, porque o modal não navega até ela. Usamos
  `http://127.0.0.1/telinha/callback` (mesmo padrão que a doc oficial do Social SDK recomenda para
  desktop: `http://127.0.0.1/callback`).
- **Validade (`exp`) do id_token: não documentada** (nem na doc oficial nem na userdoccers; o
  access token vale ~7 dias). Não dá para medir sem o app. O desenho não depende disso: o peer é
  verificado **na conexão** e continua verificado enquanto a conexão durar (o binding DTLS garante
  que do outro lado continua a mesma chave). O primeiro token real loga "válida por ~N min".
- **Consentimento**: `prompt=consent` (padrão) mostra a tela toda vez; `prompt=none` só na primeira
  vez (depois o modal pisca e fecha sozinho). O usuário pode revogar em Configurações → Apps
  autorizados; isso não invalida um id_token já emitido (JWT sem estado) até o `exp`.

### 2. Verificar RS256 no renderer com WebCrypto + JWKS — **Sim**

- JWKS atual: 1 chave `kty: RSA, alg: RS256, use: sig, kid: yQ5JCk8z…`, módulo de **4096 bits**,
  `Cache-Control: public, max-age=3600`. Importada com
  `crypto.subtle.importKey("jwk", …, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" })` (testado
  contra a chave real).
- `JwksCache`: TTL 1 h; busca de novo quando aparece um `kid` desconhecido (rotação), no máximo
  1×/min; sem rede usa o último JWKS por até 30 dias; persiste no DataStore.
- Claims conferidas (`verify.ts`): `alg === "RS256"` e sem `crit` (barra `none`/HS256); assinatura;
  `iss === "https://discord.com"`; `aud === client id` (lista: precisa de `azp` = client id);
  `sub` = snowflake = id anunciado; `nonce` = hash do fingerprint remoto; `exp` (±5 min); `iat`/`nbf`
  não no futuro (±5 min). As claims de **binding** (iss/aud/sub/nonce) vêm antes das de tempo: um
  token copiado e vencido continua sendo "inválido", não só "não verificado".

### 3. Binding DTLS com o Trystero 0.26 — **Sim**

- `@trystero-p2p/core/dist/peer.mjs`: `new (rtcPolyfill ?? RTCPeerConnection)({ iceServers, ...rtcConfig })`
  para ofertas (`strategy.mjs` `makeOffer`) e respostas (`signal-handler.mjs` `initPeer`): passar
  `rtcConfig.certificates: [cert]` faz **todas** as conexões usarem o nosso certificado.
- O handshake do Trystero (`handshake.mjs`) roda pelo data channel, ou seja, com o DTLS já
  estabelecido; mas `room.getPeers()` só lista peers **ativos** (`activePeerMap`, preenchido logo
  antes do `onPeerJoin`). Por isso a verificação acontece no `onPeerJoin`, **antes de admitir**: a
  mídia só vai para admitidos (presença e `addStream` dependem de `admitted`).
- Fingerprint remoto (`remoteFingerprint.ts`), exige `RTCDtlsTransport.state === "connected"` e
  que todas as fontes disponíveis concordem: `getRemoteCertificates()` (Chromium; SHA-256 do DER),
  `getStats()` (`transport.remoteCertificateId → certificate.fingerprint`) e o `a=fingerprint` do
  SDP remoto (o WebRTC só completa o DTLS se o certificado bater com ele).
- Persistência: `RTCCertificate` é serializável (W3C webrtc-pc; o Chromium grava inclusive a chave
  privada no IndexedDB), então vai no DataStore do Vencord. `generateCertificate` aceita `expires`
  (padrão 30 dias; o Chromium limita a ~1 ano): pedimos 180 dias e trocamos 14 dias antes de vencer
  (trocar invalida o token, que é refeito). Se a gravação falhar, o certificado vale até fechar o
  Discord.

### 4. Modelo de ameaças

Impede:
- **Personificação**: um cliente modificado anunciando o id de quem está na call sem ter um token
  daquela pessoa → "não verificado" (sem token) ou "inválido" (token de outro).
- **Replay de token**: um peer que recebeu o seu token numa call anterior (ou de um relay) e o
  reapresenta → o fingerprint DTLS dele não bate com o `nonce` → "inválido".
- **Relay/MITM na sinalização**: quem lê a sinalização (relays Nostr; a chave sem senha deriva de
  ids públicos do canal) e troca os fingerprints do SDP para ficar no meio → o token do peer legítimo
  não bate com o fingerprint visto → "inválido".
- O nonce nunca vem da rede: um atacante não consegue fazer o seu cliente pedir um token com o
  fingerprint dele.

Não impede:
- **Participante legítimo que sai da call** mas deixa a sala aberta: continua coberto pela checagem
  de membership de voz (`reevaluateAdmission`), que segue valendo junto com a identidade.
- **Quem está legitimamente na call** gravando ou retransmitindo a sua tela.
- **Cliente/PC comprometido**: malware que lê o IndexedDB do Discord leva certificado + token e se
  passa pela vítima até o `exp`; quem controla a conta do Discord também.
- O próprio Discord (é a autoridade que assina).
- Privacidade: o id_token só tem o id (escopo `openid`), que o hello já anuncia; o fingerprint
  persistente é um identificador estável para quem conecta com você (que já vê o seu id).

### 5. UX e política

- **Uma vez por conta/PC**: botão "Autorizar o Telinha" (configurações e aviso na barra de voz) →
  modal do próprio Discord ("Telinha quer acessar sua conta: saber quem você é") → pronto.
- **Renovação**: pelo `refresh_token` sem UI (se o Discord devolver id_token com o mesmo `nonce`;
  a medir); senão, ao entrar numa sala, o modal com `prompt=none` (pisca e fecha). Nunca no meio da
  call; nunca para quem nunca autorizou.
- **Peers**: selo "✔ verificado", "não verificado" (sem token/vencido) ou "✖ identidade falsa"
  (token inválido: log de aviso, nunca é aceito).
- **Recomendação**: opção `requireVerifiedIdentity` **ligada por padrão** — presença e transmissão
  só para verificados. Quem não autorizou vê no próprio cliente "seus amigos não conseguem confirmar
  que é você — Autorizar". Desligada: não verificados no canal de voz são aceitos, mas o pedido para
  assistir cai na aprovação manual com aviso. "Inválido" nunca é aceito.
- **Senha do grupo**: complementar. A senha esconde a sala de quem não a tem (sinalização cifrada,
  desafio do Trystero), mas não diz **quem** é quem (qualquer um com a senha anuncia qualquer id).
  A identidade prova quem é quem, mas não esconde a sala. Com a identidade ligada a senha vira
  opcional.
- Enquanto `DISCORD_CLIENT_ID` for o placeholder vazio, tudo fica "não verificado" e a política não
  muda nada (comportamento de hoje).
- O amigo virtual (`tools/telinha-peer`) não tem token: nos testes com ele, desligue
  `requireVerifiedIdentity`.

## O que o usuário faz no Discord Developer Portal

1. https://discord.com/developers/applications → **New Application** → nome **Telinha** (é o nome
   que aparece no modal) → aceitar os termos de desenvolvedor.
2. **OAuth2** → **Redirects** → **Add Redirect** → `http://127.0.0.1/telinha/callback` → **Save Changes**.
3. **OAuth2** → **Public Client** → **ligado** (é a flag `PUBLIC_OAUTH2_CLIENT`: troca do code só com
   PKCE, sem client secret) → **Save Changes**.
4. **Installation** → **Install Link** → **None** (o app não é instalado em servidores; só OAuth).
5. Não criar bot, não gerar/usar **Client Secret** (nunca vai no plugin).
6. Copiar o **Client ID** (OAuth2 → Client information, = Application ID) para `DISCORD_CLIENT_ID`
   em `src/plugins/telinha/core/identity/config.ts`.
7. Primeiro teste: autorizar e conferir no log "Identidade do Discord pronta (válida por ~N min)".
   Se a autorização falhar com escopo, testar `OAUTH_SCOPES = ["openid", "identify"]`.

## Integração (para quem mexe em session/settings/UI)

API do protótipo (`@plugins/telinha/core/identity`): `prepareIdentity()`, `getLocalIdToken()`,
`authorizeIdentity({ silent })`, `renewIdentity({ interactive })`, `forgetIdentity()`,
`getLocalIdentityState()`, `subscribeLocalIdentity(cb)`, `verifyRemoteIdentity({ pc, idToken, claimedUserId })`;
`isIdentityConfigured()` em `./identity/config`.

**protocol.ts** (e a cópia em `tools/telinha-peer/telinha-peer.js`):

```ts
export const ACTION_IDENTITY = "identity";
export type HelloMessage = { type: typeof HELLO_TYPE; v: number; discordUserId: string; username: string; idToken?: string; };
export type IdentityMessage = { idToken: string; };
export const isIdentityMessage = (d: unknown): d is IdentityMessage =>
    isObject(d) && typeof d.idToken === "string" && d.idToken.length <= 8192;
```

**context.ts**: `PeerEntry.identity: "pending" | IdentityVerdict`, `PeerEntry.identityReason?: IdentityFailure`;
`rt.identityAction: MessageAction<IdentityMessage> | null`; `publish()` copia `identity` para `RemotePeer`.

**presence.ts**:

```ts
export function selfHello(): HelloMessage {
    const { id, username } = me();
    const idToken = getLocalIdToken();
    return { type: HELLO_TYPE, v: PROTOCOL_VERSION, discordUserId: id, username, ...(idToken ? { idToken } : {}) };
}

export function computeAdmitted(entry: PeerEntry) {
    if (entry.incompatible || !entry.hello) return false;
    if (entry.identity === "invalid") return false;
    if (isIdentityConfigured() && settings.store.requireVerifiedIdentity && entry.identity !== "verified") return false;
    return entry.inVoice || !settings.store.rejectOutsiders;
}
```

**session.ts**:

```ts
// switchRoom: depois do `await leaving` e antes do joinNow
const { certificates } = await prepareIdentity();
if (seq !== joinSeq || !active) return;
void renewIdentity({ interactive: true }); // so faz algo se ja autorizou e o token falta/esta vencendo
joinNow(roomId, reason, certificates);

// joinNow(roomId, reason, certificates: RTCCertificate[])
rtcConfig: { iceServers: ICE_SERVERS, ...(certificates.length ? { certificates } : {}) },
// ...
rt.identityAction = room.makeAction<IdentityMessage>(ACTION_IDENTITY);
rt.identityAction.onMessage = onIdentity;

// handshake: guardar o token junto com o hello
const hello: HelloMessage = { ..., ...(typeof data.idToken === "string" && data.idToken.length <= 8192 ? { idToken: data.idToken } : {}) };

// onPeerJoin: entry.identity = "pending" (computeAdmitted da false enquanto isso) e, depois de rt.peers.set:
if (hello && !claimsSelf) void checkPeerIdentity(peerId, hello.idToken);

async function checkPeerIdentity(peerId: PeerId, idToken: unknown) {
    const entry = rt.peers.get(peerId);
    if (!entry?.hello || entry.incompatible) return;
    const pc = rt.room?.getPeers()[peerId];
    const { verdict, result } = await verifyRemoteIdentity({ pc, idToken, claimedUserId: entry.hello.discordUserId });
    if (rt.peers.get(peerId) !== entry) return; // saiu ou a sala mudou no meio
    if (entry.identity === "verified" && verdict === "unverified") return; // renovacao ruim nao rebaixa
    entry.identity = verdict;
    entry.identityReason = result.ok ? undefined : result.reason;
    if (verdict === "invalid") logThrottled(`id-invalid:${peerId}`, "warn",
        `${peerLabel(peerId)} apresentou uma prova de identidade inválida (${entry.identityReason}): pode ser alguém se passando por ${entry.hello.username}; ignorado`, 60_000);
    else if (verdict === "verified") log.info(`${peerLabel(peerId)}: identidade do Discord verificada`);
    checkIdentities();
    reevaluateAdmission();
    publish();
}

function onIdentity(data: IdentityMessage, { peerId }: { peerId: string; }) {
    if (!isIdentityMessage(data)) return;
    const entry = rt.peers.get(peerId);
    if (!entry?.hello || entry.incompatible) return;
    void checkPeerIdentity(peerId, data.idToken); // limitar a ~1 por 10 s por peer
}

// startSession: anunciar token novo/renovado a todos os peers compativeis (nao so admitidos:
// eles precisam do nosso token para NOS admitir)
unsubscribeIdentity = subscribeLocalIdentity(s => {
    const idToken = s.status === "ready" ? getLocalIdToken() : null;
    const targets = [...rt.peers.values()].filter(p => p.hello && !p.incompatible).map(p => p.peerId);
    if (idToken && targets.length) rt.identityAction?.send({ idToken }, { target: targets }).catch(() => { });
    publish();
});
// stopSession: unsubscribeIdentity?.(); leaveRoom: rt.identityAction = null

// checkIdentities (duplicados): ignorar peers "invalid" no agrupamento e nunca marcar um
// "verified" como duplicado (o nao verificado do par e o suspeito; dois verificados = a mesma
// pessoa em dois PCs).
```

**settings.ts**:

```ts
requireVerifiedIdentity: {
    type: OptionType.BOOLEAN,
    description: "Só mostrar sua presença e transmitir para quem provou ser quem diz (conta do Discord) (recomendado). Desligado: amigos não verificados no seu canal de voz também são aceitos, com aviso e aprovação manual.",
    default: true,
    onChange: () => onAdmissionSettingChanged()
},
identity: { type: OptionType.COMPONENT, component: IdentitySettingRow } // estado + "Autorizar o Telinha" / "Desvincular"
```

**types.ts / UI**: `RemotePeer.identity?: "pending" | "verified" | "unverified" | "invalid"` e
`TelinhaState.localIdentity: LocalIdentityState["status"]`; selo por peer (StreamersModal/VoiceUserTag);
aviso na VoiceBar quando `localIdentity` é `unauthorized`/`error` com botão que chama
`authorizeIdentity()`; com `requireVerifiedIdentity` desligado, pedido de não verificado vai para a
aprovação manual com o texto "não verificado".

## Testes

`pnpm exec tsx --test src/plugins/telinha/core/identity/identity.test.ts` — 32 testes das partes
puras: token válido; fingerprint no formato SDP; token copiado (fingerprint diferente) e copiado +
vencido; `sub` errado; vencido e tolerância de relógio; `iat`/`nbf` no futuro; `aud`/`azp`/`iss`;
payload adulterado; outra chave com o mesmo `kid`; `kid` desconhecido; sem `kid`; `alg` none/HS256/`crit`;
entradas malformadas; placeholder; chave RSA curta; nonce/normalização/SDP; fingerprint remoto com
RTCPeerConnection falsa (fontes concordam, só SDP, DTLS não conectado, certificado ≠ SDP); PKCE
(vetor da RFC 7636); `location` do modal (state, iss, redirect, erro); troca do code sem
`client_secret` e sem cookies; erro do token endpoint; `JwksCache` (TTL, refetch limitado, offline).

## A medir com o app real

- `exp` do id_token e se o `refresh_token` devolve um id_token com o mesmo `nonce`.
- Se o Discord exige `identify` junto com `openid` (o protótipo pede só `openid`).
- Se `prompt=none` realmente fecha sozinho no modal do cliente desktop.
- Ponta a ponta: dois clientes reais, um modificado anunciando o id do outro (deve sair "não
  verificado") e reapresentando o token capturado do outro (deve sair "identidade falsa").
