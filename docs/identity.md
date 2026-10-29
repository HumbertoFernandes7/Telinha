# Telinha — prova de identidade do Discord entre peers

Status: **integrado** à sessão (branch `feat/identity`), com o Client ID do app "Telinha" em
`src/plugins/telinha/core/identity/config.ts`. Falta o teste manual com o app real (checklist no fim).
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

### Carência depois do `exp` (7 dias)

O id_token real do Discord dura **~60 min** (medido: "Identidade do Discord pronta (válida por ~60 min)"), e
pela OIDC Core 12.2 um id_token renovado pelo `refresh_token` *não deveria* trazer o `nonce`, ou seja, a
renovação sem janela pode não gerar uma prova amarrada; sobra o modal `prompt=none` (no máximo 1× a cada 24 h).
Como o binding ao certificado é o que impede o replay (um token copiado falha em qualquer outro certificado
com `fingerprint-mismatch`, antes de qualquer checagem de tempo), um token com assinatura, `iss`, `aud`, `sub` e
`nonce`/fingerprint corretos continua valendo como prova até **`exp` + `MAX_TOKEN_AGE_MS` (7 dias)**, ±5 min de
relógio; depois disso é `expired` (não verificado). Risco residual: uma conta que perdeu o acesso (revogou o
app, trocou a senha) continua aparecendo como verificada por até 7 dias nesse PC, porque o id_token é um JWT sem
estado e a verificação é offline.

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
  access token vale ~7 dias). **Medido com o app real: ~60 min.** O peer é verificado **na conexão** e
  continua verificado enquanto a conexão durar (o binding DTLS garante que do outro lado continua a mesma
  chave); e um token amarrado ao certificado ainda vale por 7 dias depois do `exp` (ver "Carência" acima).
- **Consentimento**: `prompt=consent` (padrão) mostra a tela toda vez; `prompt=none` só na primeira
  vez (depois o modal pisca e fecha sozinho). O usuário pode revogar em Configurações → Apps
  autorizados; isso não invalida um id_token já emitido (JWT sem estado), que vale até o `exp` + a carência.

### 2. Verificar RS256 no renderer com WebCrypto + JWKS — **Sim**

- JWKS atual: 1 chave `kty: RSA, alg: RS256, use: sig, kid: yQ5JCk8z…`, módulo de **4096 bits**,
  `Cache-Control: public, max-age=3600`. Importada com
  `crypto.subtle.importKey("jwk", …, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" })` (testado
  contra a chave real).
- `JwksCache`: TTL 1 h; busca de novo quando aparece um `kid` desconhecido (rotação), no máximo
  1×/min; sem rede usa o último JWKS por até 30 dias; persiste no DataStore.
- Claims conferidas (`verify.ts`): `alg === "RS256"` e sem `crit` (barra `none`/HS256); assinatura;
  `iss === "https://discord.com"`; `aud === client id` (lista: precisa de `azp` = client id);
  `sub` = snowflake = id anunciado; `nonce` = hash do fingerprint remoto; `exp` + 7 dias de carência
  (±5 min); `iat`/`nbf` não no futuro (±5 min). As claims de **binding** (iss/aud/sub/nonce) vêm antes
  das de tempo: um token copiado e vencido continua sendo "inválido", não só "não verificado".

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
  passa pela vítima até o fim da carência (`exp` + 7 dias); quem controla a conta do Discord também.
- O próprio Discord (é a autoridade que assina).
- Privacidade: o id_token só tem o id (escopo `openid`), que o hello já anuncia; o fingerprint
  persistente é um identificador estável para quem conecta com você (que já vê o seu id).

### 5. UX e política (implementado)

- **Uma vez por conta/PC**: aviso discreto na barra do Telinha ("Autorize o Telinha no Discord para provar
  que é você", com **Autorizar** e um × que esconde até o Discord reiniciar) e, na página do plugin, a seção
  "Identidade no Discord" com **Autorizar o Telinha no Discord** / **Desvincular**. O fluxo é o modal do
  próprio Discord ("Telinha quer acessar sua conta: saber quem você é"). O aviso só aparece com Client ID e
  enquanto a conta não autorizou (ou a última tentativa falhou); autorização vencida não gera aviso.
- **Renovação**: ao entrar numa sala, quando o token tem mais de ~24 h desde a emissão (ou falta menos de 1 dia
  para o fim da carência): sem UI pelo `refresh_token` (falhou: só tenta de novo depois de 30 min; o
  refresh_token novo que o Discord devolve é guardado mesmo se o id_token não servir); senão o modal com
  `prompt=none` no máximo 1× a cada 24 h. Nunca no meio da call; nunca para quem nunca autorizou. Enquanto
  a renovação não dá certo, o token antigo continua sendo enviado até o fim da carência; passado esse fim, nunca.
- **Selo por peer**: "✔ verificado", "não verificado" (sem token, versão antiga, vencido) ou "✖ identidade
  falsa", em "Quem está transmitindo", "Quem está assistindo" (assistindo, pedidos, suspeitos), no pedido de
  aprovação da barra e na dica da etiqueta TELINHA.
- **Identidade falsa** (assinatura, conta, aplicativo ou certificado errados; token copiado): nunca é
  admitida, não vê a presença, não recebe a transmissão nem respostas, o que ela manda (presença, pedidos,
  stream) é ignorado, sai da lista de peers e vira só um alerta "Uma conexão apresentou uma prova de identidade
  falsa de Ana — ignorada". Log uma vez (sem IPs).
- **`requireVerifiedIdentity`** ("Exigir identidade verificada", **ligada por padrão**, escondida sem Client
  ID), vale para "Quem pode assistir: Todos da call": quem não está verificado e está no seu canal de voz continua
  vendo a sua presença, mas o pedido para assistir cai em Permitir/Recusar, e o pedido mostra "não verificado".
  **Desligada**: não verificado funciona como na v0.1.0. Mudar a opção no meio da transmissão não derruba quem já
  assiste. Os outros modos de "Quem pode assistir" (v0.2.0, `core/access.ts`): "Só meus amigos do Discord" só
  aceita verificado **e** amigo; "Só quem eu aprovar" sempre pede Permitir; "Com senha" aceita quem acertar a
  senha, mesmo não verificado. Identidade falsa nunca, em nenhum modo.
- **Identidade duplicada**: conexão verificada nunca é marcada; verificada + não verificada com o mesmo id →
  só a não verificada é bloqueada ("Uma conexão não verificada diz ser Ana, que já provou a identidade — só ela
  fica bloqueada"); duas verificadas = a mesma pessoa em dois PCs; duas não verificadas = regra de hoje.
- **Senha do grupo**: complementar. A senha esconde a sala de quem não a tem (sinalização cifrada, desafio do
  Trystero), mas não diz **quem** é quem. A identidade prova quem é quem, mas não esconde a sala.
- **Sem Client ID** (`DISCORD_CLIENT_ID` vazio): nada muda em relação à v0.1.0 — sem certificado próprio, sem
  token no hello, sem ação "identity", sem aviso, sem opção, mesma admissão e mesma regra de duplicados.
- O amigo virtual (`tools/telinha-peer`) não tem token: nos testes com ele, desligue `requireVerifiedIdentity`
  (senão cada pedido dele para assistir precisa de Permitir).

## O que o usuário faz no Discord Developer Portal

1. https://discord.com/developers/applications → **New Application** → nome **Telinha** (é o nome
   que aparece no modal) → aceitar os termos de desenvolvedor.
2. **OAuth2** → **Redirects** → **Add Redirect** → `http://127.0.0.1/telinha/callback` → **Save Changes**.
3. **OAuth2** → **Public Client** → **ligado** (é a flag `PUBLIC_OAUTH2_CLIENT`: troca do code só com
   PKCE, sem client secret) → **Save Changes**.
4. **Installation** → **Install Link** → **None** (o app não é instalado em servidores; só OAuth).
5. Não usar bot nem gerar/usar **Client Secret** (nunca vai no plugin).
6. Copiar o **Client ID** (OAuth2 → Client information, = Application ID) para `DISCORD_CLIENT_ID`
   em `src/plugins/telinha/core/identity/config.ts`.

**Feito em 2026-10-29**: app "Telinha", Client ID `1565419793446862929` já em `config.ts`.

Conferido contra o app real **sem login** (2026-10-29):
- `GET /api/v10/oauth2/applications/1565419793446862929/rpc` → 200, `name: "Telinha"`. O Discord criou um
  usuário bot automaticamente (`bot_public: true`); não é usado (Install Link = None), mas dá para desligar
  "Public Bot" na aba Bot por arrumação.
- `POST /api/oauth2/token` com `client_id` real, `code` inválido, `code_verifier` e sem `client_secret` →
  `400 {"error": "invalid_grant", "error_description": "Invalid \"code\" in request."}`, com
  `access-control-allow-origin: https://discord.com`. Com um client id falso → `400 {"error":"invalid_client"}`.
  Ou seja: o app existe e o endpoint responde no formato que `requestToken` espera. **Não** dá para provar
  sem login que "Public Client" está ligado (o Discord valida o code antes; sem `code_verifier` também
  responde `invalid_grant`): isso aparece no primeiro teste real (`invalid_client` na troca = Public Client
  desligado).
- `refresh_token` inválido → `400 {"error": "invalid_grant"}`. JWKS e `openid-configuration` como na seção 2.
- `GET /api/v10/oauth2/authorize?...` sem login → redireciona para a página web de autorização (esperado;
  o modal do cliente usa a sessão do usuário).

## Integração (onde está cada coisa)

- `core/identity/policy.ts` (**puro**, testado): `isAdmitted` (falsa e "conferindo" nunca; o resto pela regra
  do canal de voz), `identityRequiresApproval` (não verificado com a opção ligada; usado por `decideWatch` em
  `core/access.ts` no modo "Todos da call") e `watchNeedsApproval` (a regra da v0.1.0 com o antigo approveViewers,
  só para os testes de compatibilidade), `findDuplicates` (regras acima), `nextPeerIdentity` (verificada não é rebaixada, falsa não vira
  confiável), `initialPeerIdentity`. `configured` sempre por parâmetro: o caminho sem Client ID é testado sem
  depender da constante.
- `protocol.ts`: `HelloMessage.idToken?`, `parseHello` (só campos conhecidos; token ruim sai e o peer fica "não
  verificado"), `buildHello` (sem token = hello da v0.1.0), `ACTION_IDENTITY = "identity"`, `isIdentityMessage`.
  `PROTOCOL_VERSION` continua 1. A cópia em `tools/telinha-peer` não precisa mudar (campos opcionais).
- `core/identity/index.ts`: estado local `disabled | loading | unauthorized | expired | authorizing | ready |
  error`; `prepareIdentity()` devolve `{ certificates, fingerprint }` (sem Client ID: vazio, sem gerar
  certificado); `getLocalIdToken({ fingerprint })` só devolve o token amarrado ao certificado da sala;
  `localIdentityDiagnostics()`.
- `core/session.ts`: `prepareIdentity` (máx. 3 s) antes do `joinRoom` + `rtcConfig.certificates`;
  `renewIdentity({ interactive: true })` ao entrar; hello com token; `onPeerJoin` marca "conferindo" quem mandou
  token e chama `verifyRemoteIdentity` (máx. 10 s → "não verificado"; 1 nova tentativa se o fingerprint ainda não
  der para ler); ação "identity" (1 verificação por peer a cada 10 s, ignorada para verificado/falso); o token
  novo/renovado vai uma vez por peer (`announcedTo`); `checkIdentities` com `findDuplicates`;
  `peerIdentityDiagnostics()`. Nada disso lança para fora dos handlers do Trystero.
- `core/streaming.ts`: cada pedido decidido por `decideWatch` (`core/access.ts`: modo da transmissão + identidade);
  `onApprovalPolicyChanged` (requireVerifiedIdentity e troca do modo no ar); `reviewPendingApprovals` (pedidos
  pendentes decididos de novo, ex.: quem provou a identidade é atendido).
- `core/viewing.ts`: não assiste a "conferindo"/falsa; para de assistir quem vira falsa.
- `types.ts`: `PeerIdentityStatus`, `RemotePeer.identity?`, `PendingViewer.identity?`, `IdentityAlert.kind?`
  (`duplicate | impostor | fake`). Sem Client ID os campos não aparecem (snapshot igual ao da v0.1.0).
- UI: `ui/IdentityUI.tsx` (selo, aviso da barra, seção da página do plugin), `VoiceBar`, `StreamersModal`,
  `ViewersModal`, `VoiceUserTag`, `notices`; "Copiar diagnóstico" inclui a identidade (sem tokens nem IPs).

## Testes

`pnpm test:file src/plugins/telinha/core/identity/identity.test.ts` (também no `pnpm test:unit`) — 54 testes das partes puras: os 32 do protótipo (token válido, copiado, vencido, `sub`/
`aud`/`iss` errados, assinatura, `kid`, `alg`, entradas malformadas, fingerprint remoto, PKCE, `location` do
modal, troca do code, `JwksCache`) e mais: **sem Client ID = v0.1.0** para todas as combinações (hello byte a
byte, admissão, aprovação, duplicados, nenhum token vira "falso"); admissão para verificado / não verificado
com a opção ligada e desligada / falso (token copiado, assinatura falsa, conta errada) / conferindo; regras de
duplicado; `nextPeerIdentity`; timeout = não verificado; hello sem `idToken` (v0.1.0) e com `idToken` ruim
continuam válidos; ação "identity". O teste do renderer confere que "Exigir identidade verificada" nasce ligada.

## Teste manual com o app real (checklist)

Dois PCs (ou duas contas) com este build, no mesmo canal de voz. Ter "Copiar diagnóstico" à mão.

1. **Autorizar**: a barra mostra "Autorize o Telinha no Discord…" → **Autorizar** → aparece o modal do
   Discord com o nome **Telinha** pedindo só "saber quem você é" → Autorizar. Toast "Telinha autorizado"; o
   aviso some; no log: "Identidade do Discord pronta (válida por ~N min)" → **anotar N** (o `exp` real).
   Se der `invalid_client`: ligar **Public Client** no portal. Se der erro de escopo: testar
   `OAUTH_SCOPES = ["openid", "identify"]`.
2. **Página do plugin**: "Identidade no Discord: autorizado" + **Desvincular**; "Exigir identidade verificada"
   aparece ligada.
3. **Verificado**: com os dois autorizados, cada um vê o outro com "✔ verificado" em "Quem está transmitindo"
   e "Quem está assistindo"; a dica da etiqueta TELINHA diz "(identidade verificada)"; assistir funciona sem
   pedido de aprovação (transmitindo com "Quem pode assistir: Todos da call").
4. **Não verificado**: no PC B, **Desvincular** e sair/entrar na call. A vê B como "não verificado"; B ainda
   vê A transmitindo; B pede para assistir → A recebe "B quer assistir · não verificado" com Permitir/Recusar
   (em "Todos da call"); Permitir → B assiste; Recusar → B vê a recusa.
5. **Opção desligada**: em A, desligar "Exigir identidade verificada" → B (não verificado) assiste direto,
   como na v0.1.0. Religar.
6. **Autorizar no meio da call**: B autoriza com os dois na call → em A, B passa de "não verificado" para
   "✔ verificado" sem reconectar (ação "identity").
7. **Renovação**: com o token emitido há mais de 24 h, entrar numa call → o selo continua "verificado" e o
   token é renovado sem clicar em nada (o "Copiar diagnóstico" mostra a nova hora em "prova renovada em"): ou
   pela renovação sem janela, ou pelo modal que pisca e fecha (`prompt=none`). Anotar
   se o `refresh_token` devolve id_token **com** o mesmo `nonce` (se não, o log mostra
   "fingerprint-mismatch"/"sem id_token" na renovação sem janela).
8. **Mesmo id, verificado + não verificado**: precisa de um cliente modificado ou do amigo virtual anunciando o
   id de B (`tools/telinha-peer`, que não tem token) → só a conexão não verificada fica bloqueada, alerta
   "Uma conexão não verificada diz ser B, que já provou a identidade — só ela fica bloqueada"; B verificado
   continua assistindo.
9. **Identidade falsa**: cliente modificado reapresentando o id_token capturado de B (aparece no hello de B; dá
   para pegar com um breakpoint no `parseHello`) → "✖ identidade falsa", alerta "prova de identidade falsa de
   B — ignorada", log uma vez, nenhuma presença/stream/resposta para ele.
10. **Diagnóstico**: "Copiar diagnóstico" traz `identidade: configurada (app …); local: pronta…`, a lista de
    peers com verificado/não verificado e as últimas falhas — sem nenhum `eyJ…` (token) e sem IPs.
11. **Versão antiga**: um PC com a v0.1.0 na mesma call: ele vê e assiste o PC novo (com Permitir, se a
    opção estiver ligada), e o PC novo o vê como "não verificado"; nenhum erro no console da v0.1.0.

## A medir com o app real

- Se o `refresh_token` devolve um id_token com o mesmo `nonce` (item 7 acima); o `exp` já foi medido: ~60 min.
- Se o Discord exige `identify` junto com `openid` (o build pede só `openid`).
- Se `prompt=none` realmente fecha sozinho no modal do cliente desktop.
