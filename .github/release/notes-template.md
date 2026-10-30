<!--
  Release notes of every Telinha release, filled in by `node scripts/release.mjs notes` in CI (docs/releases.md).
  Placeholders: {{VERSION}} the version (0.2.6); {{NOVIDADES}} the "## Novidades" section of the pull request merged
  into main, up to the next heading or --- line (write it there, in Portuguese, for the people who use Telinha;
  "**Da 0.2.x:**" recap lines included);
  {{CHECKSUMS}} the SHA-256 lines of TelinhaInstaller.exe and the add-on zip, which the installer and the add-on's
  automatic updater read: generated, never write them here; {{COMMIT}} the commit the files were built from.
  Every placeholder must stay. This comment is not published. Edit the fixed text below freely: CI renders this file
  and runs the result through the updater's own checks on every pull request (addon/test/run-release-test.mjs).
-->
O **Telinha** deixa quem está no **mesmo canal de voz** transmitir a **tela inteira ou uma janela** pros outros e assistir **dentro do Discord**, direto de PC pra PC, até 1080p a 60 fps, sem servidor e de graça.

**Já tem o Telinha?** Não precisa fazer nada: ele baixa a {{VERSION}} sozinho e avisa dentro do Discord ("Reiniciar agora / Depois").

## Novidades da {{VERSION}}

{{NOVIDADES}}

## Como instalar

**Precisa ter o [Vencord oficial](https://vencord.dev/download/) instalado.**

1. Baixe o **[`TelinhaInstaller.exe`](https://github.com/HumbertoFernandes7/Telinha/releases/latest/download/TelinhaInstaller.exe)**.
2. Dê dois cliques nele. Se o Windows avisar "O Windows protegeu o computador", clique em **Mais informações → Executar assim mesmo** (o instalador ainda não tem assinatura digital).
3. Clique em **Instalar**. Ele baixa o Telinha deste GitHub, confere se o arquivo não foi alterado e pede pra fechar o Discord.
4. Abra o Discord. O **Telinha** já vem ligado. Na primeira call, clique em **"Autorize o Telinha no Discord"**.

**Atualização automática:** quando sair uma versão nova, o Telinha baixa em segundo plano e avisa dentro do Discord. Nunca troca no meio de uma transmissão, e se a versão nova der problema ele volta sozinho pra anterior.
**Pra desinstalar:** rode o instalador e clique em **Desinstalar**. O Vencord volta exatamente como estava.

O `Telinha-addon-*.zip` é o pacote que o instalador baixa sozinho: você não precisa baixar ele.

## O que dá pra fazer

- **Transmitir:** na call, **"Transmitir com Telinha"** (embaixo do painel da conexão de voz) → escolha a tela ou uma janela e quem pode assistir (**Todos da call**, **Só meus amigos do Discord**, **Só quem eu aprovar** ou **Com senha**).
  - Janela: vai o som só daquele programa. Tela inteira: vai todo o som do PC, **menos o do Discord**.
- **Assistir:** **"Assistir"** no quadradinho da pessoa na tela da call, na etiqueta **TELINHA** ao lado do nome dela, ou na barra do Telinha. Também abre em janela separada, com tela cheia e volume.
- **Ver quem está assistindo** e **expulsar** alguém da sua transmissão.
- **Identidade verificada pelo próprio Discord** (selo "✔ verificado"), **qualidade automática**, **sons de entrar e sair** e **aviso de tela preta** (jogo em tela cheia exclusiva → use **Sem bordas**).

Todos que vão transmitir ou assistir precisam ter o Telinha e estar no mesmo canal de voz.

## Avisos

- **Privacidade:** a conexão é direta, então quem está na call consegue ver o IP dos outros. Só quem está no mesmo canal de voz é aceito, e você escolhe quem pode assistir.
- **Upload:** cada pessoa que assiste recebe uma cópia separada da sua transmissão (até 20 Mbps cada em 1080p60). Se a sua internet não aguentar, a qualidade baixa sozinha.
- **Atualização do Discord e do Vencord:** o Telinha continua funcionando. Se você usar o **"Reparar"** do instalador do Vencord, rode o instalador do Telinha de novo.
- **Som da tela inteira:** usa o `telinha-audio.exe` (código aberto neste repositório), ainda sem assinatura; o antivírus pode bloquear. Se bloquear, a tela vai sem som.
- Mods de cliente vão contra os Termos de Serviço do Discord: use por sua conta e risco.

## Deu problema?

Nas configurações do Telinha, **"Copiar diagnóstico"**, e mande o texto pra quem te passou o Telinha.

## Conferência dos arquivos (SHA-256)

{{CHECKSUMS}}

Código-fonte desta versão: commit `{{COMMIT}}`.

O Telinha é baseado no [Vencord](https://github.com/Vendicated/Vencord) (GPL-3.0) e não é afiliado nem suportado pela equipe do Vencord nem pelo Discord.
