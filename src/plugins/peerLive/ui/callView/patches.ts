/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
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
// era; a janela propria continua funcionando.

export const callViewPatches = [
    {
        find: ".displayName=\"CallTileOverlay\"",
        replacement: {
            match: /(?<=(\i)\.type===(\i\.\i)\.USER\?\(0,\i\.jsxs?\)\("div",.{0,250}?containerDimensions:.{0,80}?\):null,)\i(?=,)/,
            replace: (content: string, participant: string, types: string) =>
                `${content},$self.renderCallTileStream(${participant},${participant}.type===${types}.USER)`
        }
    }
];
