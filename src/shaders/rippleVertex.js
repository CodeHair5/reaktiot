/**
 * rippleVertex.js
 *
 * Kevyt pintaväreily-shader kevyille reaktioille (esim. Mg + HCl).
 * Samankaltainen kuin BOIL_VERTEX_SHADER mutta pienemmillä amplitudilla ja
 * hitaammilla nopeuksilla — luo vaikutelman hiljaisesta poreilusta.
 *
 * Käyttö Tube.js:ssä onBeforeCompile-callbackissa (kuten BOIL_VERTEX_SHADER).
 * Olettaa, että WATER_VERTEX_SHADER on jo prepend-jonossa → `uTime` on käytettävissä.
 *
 * Lisää uniform:   uRipple  (float, 0 = lepotila, 1 = täysi poreiluintensiteetti)
 * Lisää funktio:   getRippleHeight(localPos) → float  (vertex Y-siirtymä)
 */

export const RIPPLE_VERTEX_SHADER = /* glsl */`
uniform float uRipple;

// ── Kevyt pintaväreily ────────────────────────────────────────────────────────
// max(0, sin(...)) tuottaa positiivisia kuplamaissia kumpuja aaltojen huipuissa.
// Amplitudit ~1/5 kiehumisesta, nopeudet kohtuulliset → hiljainen poreiluvaikutelma.
float getRippleHeight(vec3 localPos) {
    if (uRipple <= 0.0) return 0.0;

    float x = localPos.x;
    float z = localPos.z;

    // Vaimenna lähellä lasin seinämiä (kuplat eivät paina seinää)
    float r        = length(localPos.xz) / 0.45;
    float wallFade = smoothstep(1.02, 0.68, r);

    // ── Pienet kuplabumput (hidas, satunnainen sijainti) ──────────────────────
    float bump = 0.0;
    bump += 0.011 * max(0.0, sin(x *  8.4 + z *  6.1 + uTime * 2.1));
    bump += 0.009 * max(0.0, sin(x *  6.2 + z *  9.5 - uTime * 1.7));
    bump += 0.008 * max(0.0, sin(x * 10.6 - z *  7.2 + uTime * 2.5));
    bump += 0.007 * max(0.0, sin(-x * 7.3 + z * 11.0 - uTime * 1.4));

    // ── Hienovarainen pintaaaltoilu (normaali sini, ei leikkaus) ─────────────
    float wave = 0.004 * sin(x * 15.3 + z * 12.2 + uTime * 3.4)
               + 0.003 * sin(-x * 11.8 + z * 17.6 - uTime * 4.0);

    return uRipple * wallFade * (bump + wave);
}
`;
