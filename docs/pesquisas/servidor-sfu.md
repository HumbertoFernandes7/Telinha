# Telinha: servidor no meio (SFU) gratuito? Pesquisa (29/10/2026)

Conta usada em tudo: 1080p60 a 8 Mbps = **3,6 GB por espectador-hora** (vh). "N" = número de espectadores (quem transmite não conta).

## TL;DR

- **Melhor opção grátis: Cloudflare Realtime SFU + um Cloudflare Worker grátis** que guarda o segredo e faz a troca de SDP. Tem 1.000 GB/mês grátis, a entrada (upload de quem transmite) é grátis, é anycast e tem PoPs em ~33 cidades do Brasil, usa WebRTC puro sem SDK, e o TURN sai de graça junto.
- **Capacidade:** 1.000 GB ÷ 3,6 ≈ **278 vh/mês**. Isso dá ~93 h/mês com 3 espectadores (~3 h/dia) e ~31 h/mês com 9 (~1 h/dia).
- **Modelo para o open source:** o P2P continua o padrão. O servidor é **opt-in por grupo** e só funciona com um **convite do grupo** (URL do Worker + token do grupo). Não vem nenhum servidor embutido no download do GitHub. Quem quiser monta o próprio, com o mesmo Worker na própria conta Cloudflare grátis.
- **Alternativa quase "ilimitada": Oracle Always Free (São Paulo/Vinhedo)** rodando um SFU próprio. São 10 TB/mês de saída (~2.780 vh), mas pede cartão, a VM precisa de manutenção, há risco de a Oracle recuperar instância ociosa e os limites mudam sem aviso (em 2026 cortaram o A1 pela metade). Fica como plano B.
- **Riscos principais:** não está claro se a Cloudflare pede cartão para ativar o Realtime. Não achei teto de gasto: com cartão cadastrado, o excesso custa US$ 0,05/GB, então o Worker precisa de um limitador de orçamento. Com um encode só, perde-se a adaptação de qualidade por espectador que o Telinha faz hoje. Sem E2EE, a Cloudflare consegue ver o conteúdo.

---

## 1. Serviços gerenciados com plano grátis

| Serviço | Grátis por mês | Depois do grátis | Cartão? | Brasil | 1080p60 + áudio | Auth / token | vh grátis/mês (N=3 → horas) |
|---|---|---|---|---|---|---|---|
| **Cloudflare Realtime SFU (+TURN)** | **1.000 GB de saída**, compartilhados entre SFU e TURN. Entrada grátis | US$ 0,05/GB | **Incerto.** O site lista 1.000 GB na coluna "Free plan". Um pedido na comunidade ("No-CC TURN free tier") diz que ativar o TURN pediu dados de cobrança | Anycast: cada cliente cai no PoP mais próximo. ~33 cidades no BR | Sim. H.264/H.265/VP8/VP9/AV1 + Opus. Sem teto de bitrate documentado | App ID + **App Secret só no backend**. Um Worker grátis faz o proxy (100k req/dia) | **278 vh → ~93 h** |
| LiveKit Cloud (Build) | 5.000 participante-min + **50 GB de download** + 100 conexões simultâneas | Não cobra: **novos pedidos falham** (teto duro). O plano Ship custa US$ 50/mês | Não ("No credit card required") | Tem região `sa` (Brasil) | Sim | JWT HS256 com API key/secret. Dá para gerar num Worker | 13,9 vh → **~4,6 h** |
| Daily | 10.000 participante-min (conta quem transmite) | US$ 0,004/participante-min. No plano grátis sem cartão, o post de 2019 diz que não há cobrança de excesso | Não (segundo o próprio Daily) | Sim, `sa-east-1` (São Paulo) | Sim, com send settings custom. Cobra igual em HD | Sala/meeting token pela REST API com chave secreta | ~42 h (cobra por pessoa, não por GB) |
| 100ms | 10.000 min de conferência | US$ 0,004/min | Não informado | Região BR não encontrada | Provável (não verificado) | Token com segredo no servidor | ~42 h (se for por participante) |
| Agora | 10.000 **minutos-padrão**. Full HD vale 9 min-padrão por minuto, por espectador | Plano grátis: **suspende** ao estourar. Full HD custa US$ 8,99 por 1.000 min | Não informado | SD-RTN global, sem detalhe de BR | Sim (tier Full HD) | App Certificate → token (HMAC) | 18,5 vh → **~6 h** |
| Metered | **Sem SFU grátis recorrente**. Só US$ 30 de crédito uma vez. TURN: 500 MB de teste. Open Relay: 20 GB de TURN | US$ 0,003/participante-min | O teste de TURN não pede | "31+ regiões", sem citar o BR | n/v | Chave de API | uma vez só |
| (extra) NTT SkyWay | 500 GB SFU + 500 GB TURN | Não comercial, sem SLA | n/v | Região não documentada (provavelmente Japão) | n/v | n/v | Descartado pela latência e incerteza |

Observações que pesam contra os outros:
- **Daily** carrega o "call machine" de `*.daily.co` em tempo de execução. Isso exige `script-src` remoto dentro do Discord, ou seja, rodar código remoto no renderer. O gerenciador de CSP do Vencord nem deixa o usuário liberar `script-src`. Por isso, ruim para um plugin.
- **LiveKit/Agora**: a cota grátis é minúscula para 1080p60. O LiveKit pelo menos tem teto duro, então nunca gera cobrança.
- **100ms**: a página fala de "AI Agents for healthcare" (100ms.ai), um sinal de foco mudando. Não achei nenhum anúncio de descontinuação.
- **RealtimeKit (Cloudflare)** não tem plano grátis. Não confundir com o SFU.

## 2. SFU próprio em VM sempre-grátis

**Oracle Cloud Always Free**
- **A1 (Arm):** desde ~15/06/2026 são **2 OCPU / 12 GB** (1.500 OCPU-h e 9.000 GB-h). Antes eram 4/24. A Oracle não avisou: só mudou a documentação.
- **Rede:** 1 Gbps por OCPU, ou seja, 2 Gbps. A saída é **10 TB/mês** (~2.780 vh). Com N=3 dá para ficar ligado o mês todo.
- **Micro AMD (E2.1.Micro), 2 VMs:** 1/8 OCPU, 1 GB e **50 Mbps**, o que aguenta só ~5 espectadores a 8 Mbps. Serve de reserva.
- **Regiões:** São Paulo (`sa-saopaulo-1`) e Vinhedo (`sa-vinhedo-1`). Os recursos grátis ficam só na home region, e só se assina 1 região. Há relatos de "out of host capacity" para A1 em São Paulo.
- **Cadastro:** pede **cartão** para verificação. Recusa pré-pago e virtual, e cartões costumam falhar sem explicação.
- **Instância ociosa:** a Oracle pode recuperá-la se, em 7 dias, CPU p95, rede e memória ficarem todas abaixo de 20%. Um SFU de amigos fica ocioso quase sempre. O remédio documentado é migrar a conta para **Pay As You Go**: continua R$ 0 dentro dos limites, mas aí qualquer excesso vira cobrança.

**Outros:** o GCP e2-micro tem só **1 GB/mês** de saída e fica nos EUA, então é inútil. A AWS hoje é por créditos com prazo, não sempre-grátis (100 GB/mês de saída ≈ 28 vh). A **Render** não serve: só HTTP nas portas 80/443, sem UDP. A **Fly.io** tem UDP (precisa de IPv4 dedicado e bind em `fly-global-services`), mas **não tem plano grátis** para contas novas.

**Qual SFU usar:**
- **MediaMTX** ou **Broadcast Box** (Go/Pion, WHIP/WHEP): o mais simples para "1 transmite, vários assistem". O cliente é WebRTC puro + um POST de SDP, sem SDK. Têm auth (usuários/JWT/hook HTTP no MediaMTX, webhook no Broadcast Box) e UDP mux numa porta só.
- **LiveKit server** (Go/Pion): completo, com TURN embutido e config gerada (Caddy + TLS automático). Exige domínio e as portas 443, 80, 7881/tcp, 3478/udp e 50000-60000/udp. O SDK do cliente tem ~555 KB minificado (143 KB gzip).
- **mediasoup**: é uma biblioteca. Você escreve o servidor de sinalização e o cliente inteiros, então dá mais trabalho.
- **Janus**: maduro, mas operar é mais pesado (C, plugins).
- **Manter:** abrir as portas na security list da VCN **e** no firewall do SO (as imagens da Oracle vêm restritivas), ter um domínio (DuckDNS serve), atualizar o SO, renovar o TLS (o Caddy faz sozinho) e vigiar a conta.

## 3. Distribuição open source: quem paga a cota?

- **Um servidor do dono para todo mundo que baixar: não.** A URL e o token ficam no código público, estranhos gastam os 1.000 GB e, com cartão, o excesso é cobrado. Ainda há risco de abuso e suspensão.
- **Recomendação:**
  1. **P2P continua o padrão.** Não muda nada para quem não configurar servidor.
  2. **Servidor opt-in por grupo.** Nas configurações vai um **código de convite**: URL do Worker + token do grupo assinado (HMAC com segredo do Worker), com validade e possibilidade de revogação. O dono gera os convites só para os amigos dele.
  3. **"Traga seu servidor".** A mesma configuração aceita o Worker de qualquer pessoa. Publicamos o código do Worker no repositório e qualquer grupo faz deploy na própria conta Cloudflare grátis. Como opção avançada, aceitar também um endpoint WHIP/WHEP próprio (Oracle).
  4. **Limitador no Worker.** Teto de sessões simultâneas e de minutos por token, mais um orçamento mensal contado de forma conservadora: cada assinatura de espectador = duração × 8 Mbps, guardado em KV ou Durable Object. Passou de ~900 GB, o Worker recusa e o Telinha volta para P2P. É necessário porque **não achei teto de gasto** nem métrica de uso do SFU via API (só existe a do TURN).
  5. **Usar o SFU só quando compensa.** Por exemplo, a partir de 3 ou 4 espectadores, ou em modo "transbordo": os primeiros espectadores via P2P e o resto pelo SFU. A cota rende bem mais assim.

## 4. Encaixe no design atual do Telinha

- **Descoberta continua P2P (Trystero/Nostr).** O SFU só carrega mídia. Quem transmite publica no SFU e anuncia `{sessionId, trackName}` pelo canal Trystero. Os espectadores pedem a assinatura ao Worker. O SFU da Cloudflare **não tem "salas"**: o estado da sala é da aplicação, e isso o Trystero já faz.
- **Fluxo Cloudflare** (base `https://rtc.live.cloudflare.com/v1/apps/{appId}`):
  - Publicar: o cliente gera a offer, o Worker chama `sessions/new` e `tracks/new` (`location: local`) e devolve a answer. São ~2 chamadas.
  - Assistir: o Worker chama `sessions/new` e `tracks/new` (`location: remote`, sessionId do streamer), o SFU devolve uma offer, o cliente responde e o Worker chama `PUT renegotiate`. São ~3 chamadas.
  - O Worker grátis (100k req/dia, 10 ms de CPU) sobra.
- **Tamanho no cliente:** Cloudflare e WHIP/WHEP usam **WebRTC puro + fetch**, sem SDK (zero KB extra). LiveKit acrescenta ~555 KB minificado. Agora e 100ms também trazem SDK proprietário.
- **CSP:** o CSP do Discord só bloqueia o **HTTP/WebSocket** da sinalização (`connect-src`). A mídia (RTCPeerConnection) não passa pelo CSP.
  - Para o Worker oficial: entrada estática em `CspPolicies` no `native.ts` (como já é feito com os relays), o que pede reiniciar o Discord.
  - Para servidores do usuário (URL arbitrária): ou `VencordNative.csp.requestAddOverride(url, ["connect-src"], "Telinha")`, que abre um diálogo de permissão e também pede reinício, ou **fazer as chamadas HTTP no processo main via IPC** (Node não é limitado pelo CSP). A segunda opção dispensa reinício.
- **Encode:** quem transmite **continua precisando de hardware encoding**, mas faz **um encode só** e um upload só (~8 Mbps em vez de 8 × N).
  - **Perda:** hoje o Telinha ajusta a qualidade por espectador (`setParameters` por peer em `streaming.ts`). Com SFU e uma camada só, um espectador lento sofre ou puxa a qualidade de todos para baixo.
  - **Saída:** simulcast (o Cloudflare suporta `preferredRid` por assinante), com camadas de 1080p60 a 8 Mbps + 720p a ~2,5 Mbps + 360p. Custa mais encode e ~+30% de upload.
- **Bônus:** o Telinha hoje não tem TURN e falha quando não existe caminho P2P. Pelo SFU, cada cliente só fala com a Cloudflare (IP público, anycast), então resolve a maioria dos NATs ruins. Ainda dá para usar o TURN da Cloudflare de graça junto.
- **Privacidade:** o SFU vê IPs, horários, quem assiste quem e bitrates. O DTLS-SRTP termina no SFU, então **sem E2EE a Cloudflare consegue ler a mídia**.
  - **Com E2EE** (insertable streams/encoded transform): o Chromium do Discord tem `createEncodedStreams` desde o M86, e o `RTCRtpScriptTransform` padrão foi lançado em 2025.
  - A chave de grupo vai pelo canal P2P do Trystero e o SFU não vê o conteúdo. É o mesmo princípio do DAVE do próprio Discord.
  - Deixar os bytes de cabeçalho do codec sem cifrar, se for usar simulcast (troca de camada/keyframe).
- **Latência:** Cloudflare conecta cada um no PoP mais próximo (BR) e repassa internamente. Ela diz que 95% da população fica a até 50 ms de um PoP e que a conexão sobe em ~100–250 ms. Espero algo parecido com P2P dentro do Brasil, com dezenas de ms a mais no pior caso. **Não foi medido:** vale um teste A/B com `getStats()`.

## 5. Recomendação

**Cloudflare Realtime SFU + Worker grátis, opt-in por grupo, com P2P como padrão.**

Capacidade a 8 Mbps (1.000 GB/mês):

| Espectadores (N) | 2 | 3 | 4 | 5 | 6 | 9 |
|---|---|---|---|---|---|---|
| Horas/mês | 139 | 93 | 69 | 56 | 46 | 31 |
| ≈ horas/dia | 4,6 | 3,1 | 2,3 | 1,9 | 1,5 | 1,0 |

- A 6 Mbps a cota rende ~33% a mais. Em modo transbordo (P2P para os 2–3 primeiros), rende bem mais.
- Excesso, se houver cartão: 1 h com 3 espectadores = 10,8 GB ≈ US$ 0,54.

**O que o dono precisa fazer (não dá para automatizar):**
1. Criar uma conta Cloudflare grátis e ver se o painel do Realtime pede cartão. Se pedir, decidir se aceita. O limitador do Worker mantém o uso abaixo de 1.000 GB.
2. Em Realtime → SFU, criar o app e copiar o **App ID** e o **App Secret**.
3. Rodar `wrangler login` e `wrangler deploy` do Worker que vamos escrever, e cadastrar os segredos (`SFU_APP_ID`, `SFU_APP_SECRET`, `INVITE_SECRET`). São uns 10 minutos.
4. Gerar convites para os amigos (com um script nosso) e colar no Telinha.

**O que nós automatizamos:** o código do Worker (proxy validado + convites HMAC + limitador de orçamento/concorrência + credenciais TURN), o adaptador "servidor" no Telinha com fallback para P2P, as entradas de CSP (ou IPC no main), o simulcast e E2EE opcionais, o script de convites e o guia "traga seu servidor".

**Riscos:**
1. Exigência de cartão incerta e nenhum teto de gasto documentado.
2. Free tier pode mudar (a Oracle cortou o dela pela metade em 2026 sem avisar).
3. Token de grupo vazado → precisa de revogação e rotação.
4. Uma camada só = um espectador lento afeta a qualidade (precisa de simulcast).
5. Sem E2EE a Cloudflare vê o conteúdo.
6. Latência não medida.

**Plano B:** Oracle Always Free em São Paulo/Vinhedo com MediaMTX ou Broadcast Box (WHIP/WHEP). Dá ~10× mais capacidade, mas tem cartão, manutenção, risco de recuperação por ociosidade (ou PAYG) e mudanças de regra.

---

## Fontes
- Cloudflare SFU, preço: https://developers.cloudflare.com/realtime/sfu/platform/pricing/
- Cloudflare SFU, limites: https://developers.cloudflare.com/realtime/sfu/platform/limits/
- Cloudflare SFU, padrões de conexão e endpoints: https://developers.cloudflare.com/realtime/sfu/get-started/connection-patterns/
- Cloudflare SFU, sessions/tracks: https://developers.cloudflare.com/realtime/sfu/concepts/sessions-tracks/
- Cloudflare SFU, arquitetura: https://developers.cloudflare.com/realtime/sfu/concepts/architecture/
- Cloudflare SFU, boas práticas: https://developers.cloudflare.com/realtime/sfu/best-practices/
- Cloudflare SFU, simulcast: https://developers.cloudflare.com/realtime/sfu/features/simulcast/
- Cloudflare SFU, get started (segredo no Worker): https://developers.cloudflare.com/realtime/sfu/get-started/
- Cloudflare TURN (portas, grátis com SFU): https://developers.cloudflare.com/realtime/turn/
- Cloudflare TURN, analytics (só TURN no GraphQL): https://developers.cloudflare.com/realtime/turn/analytics/
- Cloudflare Realtime, página de produto (coluna Free plan): https://www.cloudflare.com/en-gb/developer-platform/products/cloudflare-realtime/
- Cloudflare TURN/SFU, página de produto: https://www.cloudflare.com/products/turn-sfu/
- Blog da Cloudflare (anycast, árvores em cascata, 95% a ≤50 ms): https://blog.cloudflare.com/cloudflare-calls-anycast-webrtc
- Comunidade Cloudflare, "No-CC TURN free tier": https://community.cloudflare.com/t/no-cc-turn-free-tier/846152
- Cipher, guia de Realtime/RealtimeKit (jul/2026): https://www.cipher.co.th/en/blogs/cloudflare-realtime-media-services/
- Cloudflare Workers, limites: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare no Brasil (33 cidades, Teletime ago/2026): https://teletime.com.br/10/08/2026/cloudflare-isps-expansao-brasil/
- LiveKit, preços: https://livekit.com/pricing
- LiveKit, cotas e limites (teto duro): https://docs.livekit.io/home/cloud/quotas-and-limits/
- LiveKit, region pinning (Brasil): https://docs.livekit.io/deploy/admin/regions/region-pinning.md
- LiveKit, self-host em VM: https://docs.livekit.io/home/self-hosting/vm/
- LiveKit, benchmark: https://docs.livekit.io/home/self-hosting/benchmark/
- livekit-client, tamanho do bundle: https://bundlephobia.com/package/livekit-client
- Daily, preço do SDK: https://www.daily.co/pricing/video-sdk/
- Daily, post de preço de 2019 (sem cartão, sem excesso): https://www.daily.co/blog/pricing-our-video-calling-api/
- Daily, guia de rede (sa-east-1): https://docs.daily.co/docs/guides/privacy-and-security/corporate-firewalls-nats-allowed-ip-list
- Daily, CSP (bundle carregado do CDN): https://docs.daily.co/docs/guides/privacy-and-security/content-security-policy
- Daily, screen share e send settings: https://docs.daily.co/reference/daily-js/instance-methods/update-send-settings
- 100ms, preços: https://www.100ms.live/pricing
- Agora, preços: https://www.agora.io/en/pricing/
- Agora, faturamento por resolução agregada: https://docs.agora.io/en/video-calling/overview/pricing
- Metered, preços: https://www.metered.ca/pricing
- Metered Open Relay: https://www.metered.ca/tools/openrelay/
- NTT SkyWay, preços: https://skyway.ntt.com/en/pricing
- Oracle, Always Free: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- Oracle, shapes (banda do A1): https://docs.oracle.com/en-us/iaas/Content/Compute/References/computeshapes.htm
- Oracle, regiões: https://docs.oracle.com/en-us/iaas/Content/General/Concepts/regions.htm
- InfoQ, corte do A1 (jul/2026): https://www.infoq.com/news/2026/07/oracle-cloud-free-tier-limits/
- terminalbytes, mudanças no free tier da Oracle em 2026: https://terminalbytes.com/oracle-cloud-free-tier-changes-2026/
- 51sec, recuperação de instância ociosa e PAYG: https://blog.51sec.org/2023/02/oracle-cloud-cleaning-up-idle-compute.html
- GCP, free tier: https://docs.cloud.google.com/free/docs/free-cloud-features
- Fly.io, UDP: https://fly.io/docs/networking/udp-and-tcp
- Fly.io, preço (sem plano grátis para conta nova; fonte de terceiros): https://costbench.com/software/cloud-infrastructure/fly-io/free-plan/
- Render, sem UDP: https://community.render.com/t/webrtc-udp-server-possible-the-render-com-server-will-be-the-central-peer/4109
- Broadcast Box: https://github.com/Glimesh/broadcast-box
- MediaMTX, autenticação: https://mediamtx.org/docs/features/authentication
- Discord DAVE (E2EE através de SFU): https://discord.com/blog/meet-dave-e2ee-for-audio-video
- Chromium, intent to ship do encoded transform: https://groups.google.com/a/chromium.org/g/blink-dev/c/QeosFeu-d8A
- Código local lido (não alterado): `Telinha/.vencord/src/main/csp/index.ts`, `.../csp/manager.ts`, `Telinha/src/plugins/telinha/native.ts`, `protocol.ts`, `core/streaming.ts`
