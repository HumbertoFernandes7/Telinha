/*
 * Telinha, transmissão de tela P2P dentro do Discord
 * Copyright (c) 2026 Humberto Fernandes
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Contas da janelinha (o video que fica flutuando quando se sai da tela da call): tamanho, canto padrao, empilhar,
// manter dentro da janela, desviar do PiP do proprio Discord e distinguir clique de arraste. Tudo puro: sem DOM, sem
// React e sem importar nada do plugin; quem chama passa o tamanho da janela e os retangulos a evitar.
// O canto padrao (embaixo, a direita) e so estas constantes: PIP_MARGIN_RIGHT / PIP_MARGIN_BOTTOM e a conta em
// initialPipPos. Trocar de canto e mexer aqui e em mais lugar nenhum.

export const PIP_WIDTH = 320;
export const PIP_HEIGHT = 180;
/** Espaco entre uma janelinha e a de cima dela quando ha varias */
export const PIP_GAP = 12;
export const PIP_MARGIN_RIGHT = 16;
/** Folga maior que a de cima: nao cobre a caixa de mensagem */
export const PIP_MARGIN_BOTTOM = 72;
/** Folga minima entre a janelinha e a borda da janela do Discord */
export const PIP_EDGE = 8;
/** Mexeu mais que isto (px) entre apertar e soltar = arraste; ate isto e clique */
export const PIP_DRAG_THRESHOLD = 4;

export interface Pos { x: number; y: number; }
export interface Rect { left: number; top: number; right: number; bottom: number; }

function clampAxis(v: number, size: number, win: number): number {
    // Janela menor que a janelinha: o max ganha e ela fica colada na folga de cima/esquerda (nunca negativa)
    return Math.max(PIP_EDGE, Math.min(v, win - size - PIP_EDGE));
}

/** Mantem a janelinha inteira dentro da janela (PIP_EDGE de folga) */
export function clampPip(pos: Pos, winW: number, winH: number): Pos {
    return { x: clampAxis(pos.x, PIP_WIDTH, winW), y: clampAxis(pos.y, PIP_HEIGHT, winH) };
}

function overlaps(pos: Pos, r: Rect): boolean {
    return pos.x < r.right && pos.x + PIP_WIDTH > r.left && pos.y < r.bottom && pos.y + PIP_HEIGHT > r.top;
}

/** Canto de baixo a direita, empilhando para cima por `index`; `remembered` (ultimo arraste) vale para o index 0;
 *  se cair em cima de um retangulo de `avoid` (o PiP do proprio Discord), sobe para cima dele */
export function initialPipPos(o: { winW: number; winH: number; index: number; remembered?: Pos | null; avoid?: Rect[]; }): Pos {
    const { winW, winH, index, remembered, avoid = [] } = o;

    // O lugar que o usuario escolheu arrastando vale como esta (so clampado): nao desviamos de ninguem
    if (index === 0 && remembered) return clampPip(remembered, winW, winH);

    let pos = clampPip({
        x: winW - PIP_WIDTH - PIP_MARGIN_RIGHT,
        y: winH - PIP_HEIGHT - PIP_MARGIN_BOTTOM - index * (PIP_HEIGHT + PIP_GAP)
    }, winW, winH);

    // Sobe para cima do retangulo em que caiu. Subir pode cair em outro, entao repete (no maximo uma vez por
    // retangulo: cada passada sai de ao menos um deles para sempre, pois so sobe)
    for (let pass = 0; pass <= avoid.length; pass++) {
        const hit = avoid.find(r => overlaps(pos, r));
        if (!hit) break;
        pos = clampPip({ x: pos.x, y: hit.top - PIP_GAP - PIP_HEIGHT }, winW, winH);
    }
    return pos;
}

export function isDrag(dx: number, dy: number): boolean {
    return Math.hypot(dx, dy) > PIP_DRAG_THRESHOLD;
}
