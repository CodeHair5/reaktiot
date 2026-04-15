/**
 * flameSprites.js
 *
 * Tulitikun liekki- ja efektispriteiden tekstuurit ja kerrosmäärittelyt.
 *
 * Viennit:
 *   FLAME_LAYERS       — kerrossprite-liekki (pohja → kärki)
 *   getFlameTexture()  — liekki-piste (canvas radial-gradientti)
 *   getGlowTexture()   — O₂-hehku (laaja pehmeä kehä)
 *   getWaveTexture()   — H₂-paineaaltorengas
 */

import * as THREE from 'three';

// ── Kerrossprite-liekki ───────────────────────────────────────────────────────
// y: Y-offset kärjestä, sw/sh: leveys/korkeus, op: periopacity, phase: lepatus
// 8 kerrosta tiheällä asettelulla → yhtenäinen, pehmeä liekki ilman erillisiä palloja
export const FLAME_LAYERS = [
    { y: 0.000, sw: 0.30, sh: 0.22, op: 0.70, phase: 0.00, color: 0xfffee0 },
    { y: 0.028, sw: 0.27, sh: 0.26, op: 0.74, phase: 0.70, color: 0xffee40 },
    { y: 0.058, sw: 0.24, sh: 0.28, op: 0.76, phase: 1.40, color: 0xffdd30 },
    { y: 0.090, sw: 0.21, sh: 0.26, op: 0.72, phase: 2.10, color: 0xffc020 },
    { y: 0.120, sw: 0.18, sh: 0.24, op: 0.70, phase: 2.51, color: 0xff9010 },
    { y: 0.152, sw: 0.14, sh: 0.21, op: 0.64, phase: 0.78, color: 0xff6800 },
    { y: 0.182, sw: 0.10, sh: 0.17, op: 0.54, phase: 1.90, color: 0xff4400 },
    { y: 0.210, sw: 0.07, sh: 0.13, op: 0.40, phase: 3.14, color: 0xff2200 },
];

// ── Liekki-piste ──────────────────────────────────────────────────────────────
// Pehmeä, pystysuunnassa venytetty liekki-globe — AdditiveBlending tekee kokonaisuudesta uskottavan
function _makeFlameSprite() {
    const S   = 64;
    const c   = document.createElement('canvas');
    c.width   = S;
    c.height  = S;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, S, S);

    // Gradientin keskipiste on spriten alaosassa ja muoto venytetty pystysuunnassa.
    // Tämä luo pisaramaisen profiilin joka limittyy paremmin: kirkas pohja → häipyvä yläosa.
    const cx = S / 2, cy = S * 0.62;

    // Ulkoreuna: oranssi-punainen hehku (pystysuuntaan venytetty)
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1.0, 1.5);
    const outer = ctx.createRadialGradient(0, 0, 0, 0, 0, S * 0.42);
    outer.addColorStop(0,    'rgba(255,140, 10,0.80)');
    outer.addColorStop(0.40, 'rgba(220, 50,  0,0.50)');
    outer.addColorStop(0.70, 'rgba(120, 10,  0,0.22)');
    outer.addColorStop(1.0,  'rgba(  0,  0,  0,0.0)');
    ctx.fillStyle = outer;
    ctx.fillRect(-S, -S, S * 3, S * 3);
    ctx.restore();

    // Sisäosa: kirkas kelta-valkoinen ydin (pystysuuntaan venytetty)
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1.0, 1.5);
    const inner = ctx.createRadialGradient(0, 0, 0, 0, 0, S * 0.18);
    inner.addColorStop(0,   'rgba(255,255,230,1.0)');
    inner.addColorStop(0.5, 'rgba(255,220, 60,0.90)');
    inner.addColorStop(1.0, 'rgba(255,160, 10,0.0)');
    ctx.fillStyle = inner;
    ctx.fillRect(-S, -S, S * 3, S * 3);
    ctx.restore();

    return new THREE.CanvasTexture(c);
}

let _flameTex = null;
export function getFlameTexture() {
    if (!_flameTex) _flameTex = _makeFlameSprite();
    return _flameTex;
}

// ── O₂-hehku ─────────────────────────────────────────────────────────────────
// Laaja pehmeä ympyrä, AdditiveBlending — hehkuefekti happireaktion aikana
let _glowTex = null;
export function getGlowTexture() {
    if (_glowTex) return _glowTex;
    const S = 128, c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(S/2, S/2, 0, S/2, S/2, S/2);
    g.addColorStop(0.00, 'rgba(255,245,200,1.0)');
    g.addColorStop(0.20, 'rgba(255,220,120,0.85)');
    g.addColorStop(0.55, 'rgba(255,160, 40,0.40)');
    g.addColorStop(1.00, 'rgba(255,100,  0,0.00)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    return (_glowTex = new THREE.CanvasTexture(c));
}

// ── H₂-paineaaltorengas ───────────────────────────────────────────────────────
// Rengasmainen sprite, laajenee poksahduksessa
let _waveTex = null;
export function getWaveTexture() {
    if (_waveTex) return _waveTex;
    const S = 128, c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d');
    const cx = S / 2, cy = S / 2;
    const g = ctx.createRadialGradient(cx, cy, S * 0.28, cx, cy, S * 0.50);
    g.addColorStop(0.00, 'rgba(255,230,150,0.00)');
    g.addColorStop(0.25, 'rgba(255,220,120,1.00)');
    g.addColorStop(0.65, 'rgba(255,160, 60,0.60)');
    g.addColorStop(1.00, 'rgba(255,100,  0,0.00)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    return (_waveTex = new THREE.CanvasTexture(c));
}
