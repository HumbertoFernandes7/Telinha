/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Patch da tela da call (as "tiles" de cada participante). So dados: nada aqui roda no carregamento do modulo.
//
// Alvo: o componente CallTile do Discord (`ew.displayName="CallTile"`, modulo 175203 no build de 2026-10). Cada
// tile e um Clickable cujos filhos sao, em ordem: efeitos de voz, o fundo de efeitos (so para participante USER, com
// `containerDimensions:`), o conteudo (`e2`: avatar ou camera), indicadores, o CallTileOverlay (nome + botoes) e a
// borda de quem fala. Inserimos o nosso elemento logo DEPOIS do conteudo: fica por cima do avatar/camera, mas por
// baixo do nome, dos botoes do Discord e da borda de quem fala. Como fica dentro do proprio tile, cresce junto quando
// o Discord foca/amplia o tile.
//
// Trecho real (minificado; os nomes mudam a cada build e entre as duas copias do modulo):
//   u.type===ek.lp.USER?(0,t.jsx)("div",{className:eU.nl,children:(0,t.jsx)(W.A,{userId:ey,channelId:S.id,
//   guildId:S.getGuildId(),containerDimensions:{width:e9??0,height:e3??0}})}):null,e2,R?null:...
// vira
//   ...:null,e2,$self.renderCallTileStream(u,u.type===ek.lp.USER),R?null:...
//
// Se o Discord mudar esse trecho o patch simplesmente nao aplica (o Vencord so avisa no console) e a call fica como
// era; a janela propria continua funcionando, e a etiqueta TELINHA da lista de voz cai no painel flutuante.

//
// Segundo patch: o componente de volume do Discord (modulo 821747 no build de 2026-10/11, duas copias identicas salvo
// um id de import), o controle do canto inferior direito da barra da call. Hoje ele mexe no volume da VOZ do amigo
// (`setLocalVolume(userId,v,context)`). Trocamos so a chamada interna do slider por $self.TrayVolume, que recebe o
// slider e as props originais: com a live do amigo tocando na tile em foco ele controla o volume da live, senao devolve
// o slider do Discord como era. O `find` ("currentVolume:") so aparece neste modulo (o VolumeBooster usa o mesmo).
// Nao depende do `maxValue` (o VolumeBooster reescreve esse trecho): o match so exige `{currentWindow:` ate o
// `toggleLocalMute(userId,context)}` final e captura os nomes minificados do codigo.
//
// Trecho real (minificado):
//   function g(e){let{className:n,iconClassName:t,sliderClassName:l,userId:g,context:x,currentWindow:C=window,location:f}=e,
//   {currentVolume:p,muted:E}=(0,a.cf)([d.Ay],()=>({currentVolume:d.Ay.getLocalVolume(g,x),muted:d.Ay.isLocalMute(g,x)}));
//   return(0,i.jsx)(h.A,{children:(0,i.jsx)(c.A,{currentWindow:C,iconClassName:s()(t,m.pd),sliderClassName:l,className:n,
//   value:(0,u.M)(p),muted:E,maxValue:A.isPlatformEmbedded?200:100,onValueChange:e=>{...},onToggleMute:()=>{null!=f&&
//   (0,o.XJ)(f,o.OP.VOLUME,E),r.default.toggleLocalMute(g,x)}})})}
// vira
//   (0,i.jsx)($self.TrayVolume,{Slider:c.A,discordProps:{currentWindow:C,...,onToggleMute:()=>{...}},userId:g,context:x})
//
// Se o patch nao aplicar, ninguem registra a barra (trayVolume.ts) e a tile mantem o slider dela.
// `all: true`: o modulo pode existir em dois chunks e sem isso o Vencord so patcha o primeiro que contem o `find`;
// `noWarn: true`: o VolumeBooster ja mexe no mesmo modulo e a copia que nao casa nao deve gerar aviso.

export const callViewPatches = [
    {
        find: ".displayName=\"CallTileOverlay\"",
        replacement: {
            match: /(?<=(\i)\.type===(\i\.\i)\.USER\?\(0,\i\.jsxs?\)\("div",.{0,250}?containerDimensions:.{0,80}?\):null,)\i(?=,)/,
            replace: (content: string, participant: string, types: string) =>
                `${content},$self.renderCallTileStream(${participant},${participant}.type===${types}.USER)`
        }
    },
    // Volume da barra da call (canto inferior direito, so com a tile em foco): ver o segundo trecho do comentario acima
    {
        find: "currentVolume:",
        all: true,
        noWarn: true,
        replacement: {
            match: /\(0,(\i)\.jsx\)\((\i\.\i),(\{currentWindow:\i,.+?onToggleMute:\(\)=>\{.+?toggleLocalMute\((\i),(\i)\)\}\})\)/,
            replace: "(0,$1.jsx)($self.TrayVolume,{Slider:$2,discordProps:$3,userId:$4,context:$5})"
        }
    }
];
