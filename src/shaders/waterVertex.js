/**
 * waterVertex.js
 *
 * GLSL-fragmentit koeputken pintaefekteihin.
 *
 * WATER_VERTEX_SHADER  — uniform-deklaraatiot + aaltoilu- ja konvektio-
 *                        funktiot. Liitetään Three.js vertex-shaderiin
 *                        onBeforeCompile-callbackissa.
 *
 * Käyttö Tube.js:ssä:
 *   import { WATER_VERTEX_SHADER } from '../shaders/waterVertex.js';
 *   meniscusMat.onBeforeCompile = (shader) => {
 *       Object.assign(shader.uniforms, myUniforms);
 *       shader.vertexShader = WATER_VERTEX_SHADER
 *           + shader.vertexShader.replace('#include <begin_vertex>', `
 *               #include <begin_vertex>
 *               transformed.y += getWaveHeight(uv) + getConvectionHeight(uv);
 *           `);
 *   };
 */

// ─── Uniforms + vertex-funktiot ──────────────────────────────────────────────
//
// Käytetään position.xz-pohjaista etäisyyttä (ei UV) koska meniskus on
// LatheGeometry-paraboloidi — UV ei ole pyörähdyssymmetrinen.
export const WATER_VERTEX_SHADER = /* glsl */`
uniform float uTime;
uniform float uDropTime;
uniform float uDropStrength;
uniform float uShimmer;

// ── Osumisaaltoilu ────────────────────────────────────────────────────────────
// localPos: putken vertex-koordinaatti (position-attribuutti)
// dist: 0 = putken akseli, 1 = seinämä (säde 0.45)
float getWaveHeight(vec3 localPos) {
    float dist   = length(localPos.xz) / 0.45;

    float t = uTime - uDropTime;
    if (t < 0.0 || t > 5.0) return 0.0;

    float fadeIn = smoothstep(0.0, 0.06, t);

    // 1. Iskukuoppa
    float crater = -0.035 * uDropStrength
                 * fadeIn
                 * exp(-t * 7.0)
                 * exp(-dist * dist * 22.0);

    // 2. Päärengas
    float front     = t * 0.90;
    float ringW     = 0.08 + t * 0.04;
    float fromFront = dist - front;
    float ringMask  = exp(-(fromFront * fromFront) / (ringW * ringW));
    float amplitude = 0.055 * uDropStrength
                    * fadeIn
                    * exp(-t * 0.45)
                    * (1.0 - smoothstep(0.85, 1.05, dist));
    float wave = ringMask * (-cos(dist * 10.0 - t * 18.0)) * amplitude;

    // 3. Heijastusrengas (pintajännitys)
    float front2     = t * 0.55;
    float fromFront2 = dist - front2;
    float ring2W     = ringW * 1.4;
    float ring2Mask  = exp(-(fromFront2 * fromFront2) / (ring2W * ring2W));
    float wave2 = ring2Mask * cos(dist * 10.0 - t * 14.0)
                * 0.020 * uDropStrength * fadeIn * exp(-t * 1.0);

    // 4. Kapillaariaalto (hidas)
    float front3     = t * 0.32;
    float fromFront3 = dist - front3;
    float ring3W     = ringW * 2.2;
    float ring3Mask  = exp(-(fromFront3 * fromFront3) / (ring3W * ring3W));
    float wave3 = ring3Mask * sin(dist * 7.0 - t * 9.0)
                * 0.008 * uDropStrength * fadeIn * exp(-t * 0.65);

    return crater + wave + wave2 + wave3;
}

// ── Konvektio-välke (GPU-only, ei JS-kustannuksia per kupla) ─────────────────
float getConvectionHeight(vec3 localPos) {
    if (uShimmer <= 0.0) return 0.0;
    float cr      = length(localPos.xz) / 0.45;
    float ring    = sin(cr * 18.0 - uTime * 2.8);
    float fade    = 1.0 - smoothstep(0.60, 1.05, cr);
    float breathe = 0.5 + 0.5 * sin(uTime * 0.75);
    return uShimmer * 0.007 * ring * fade * breathe;
}
`;
