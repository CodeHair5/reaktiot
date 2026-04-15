/**
 * boilVertex.js
 *
 * Kiehumis-/vaahtoilupinnan vertex-displacementti meniskus-meshille.
 *
 * Käyttö Tube.js:ssä onBeforeCompile-callbackissa yhdessä WATER_VERTEX_SHADERin
 * kanssa — molemmat prepend-stringit liitetään vertexShaderin eteen. BOIL_VERTEX_SHADER
 * käyttää WATER_VERTEX_SHADERin määrittelemää `uTime`-uniformia ilman uudelleenmäärittelyä.
 *
 * Lisää uniform:   uBoil  (float, 0 = lepotila, 1 = täysi kiehuminen)
 * Lisää funktio:   getBoilHeight(localPos) → float  (vertex Y-siirtymä)
 *
 * Liikkuvat kuplat syntyvät useista max(0, sin(...))-aalloista eri taajuuksilla
 * ja suunnissa — pelkät positiiviset huiput luovat kuplamaiset kummut aaltojen sijaan.
 */

export const BOIL_VERTEX_SHADER = /* glsl */`
uniform float uBoil;

// ── Kiehumispinnan vertex-siirtymä ────────────────────────────────────────────
// Useita kilpailevia sini-aaltoja eri taajuuksilla ja suunnissa.
// max(0, sin(...)) pitää vain positiiviset huiput → kuplamaiset kummut.
float getBoilHeight(vec3 localPos) {
    if (uBoil <= 0.0) return 0.0;

    float x = localPos.x;
    float z = localPos.z;

    // Vaimenna lasin seinämiä lähestyttäessä (kuplat eivät paina seinää)
    float r        = length(localPos.xz) / 0.45;
    float wallFade = smoothstep(1.02, 0.62, r);

    // ── Isot kuplat (hitaat, harvalukuiset huiput) ────────────────────────────
    float big = 0.0;
    big += 0.058 * max(0.0, sin(x *  7.1 + z *  5.3 + uTime * 6.5));
    big += 0.050 * max(0.0, sin(x *  5.2 + z *  8.7 - uTime * 7.5));
    big += 0.044 * max(0.0, sin(x *  9.3 - z *  6.1 + uTime * 7.0));
    big += 0.038 * max(0.0, sin(-x * 6.4 + z * 10.8 - uTime * 6.0));

    // ── Välipituiset kuplat ────────────────────────────────────────────────────
    float med = 0.0;
    med += 0.022 * max(0.0, sin(x  * 14.2 + z * 11.8 - uTime * 13.0));
    med += 0.018 * max(0.0, sin(x  * 11.5 - z * 16.3 + uTime * 14.0));
    med += 0.015 * max(0.0, sin(-x * 18.7 + z * 13.5 + uTime * 16.0));

    // ── Hienokuplinen pinta (vaahto) ───────────────────────────────────────────
    float foam = 0.008 * (sin( x * 26.4 + z * 22.1 + uTime * 22.0) * 0.5 + 0.5)
               + 0.006 * (sin(-x * 31.7 + z * 28.4 - uTime * 26.0) * 0.5 + 0.5);

    return uBoil * wallFade * (big + med + foam);
}
`;
