/**
 * smokeWispShader.js
 *
 * Sammutussavun "wisp"-shader: ohut, kiemurteleva savuvana
 * joka nousee ylöspäin kynttilän tai tulitikun sammuttua.
 *
 * Geometria: kaksi ristiin asetettua PlaneGeometrya (X-suuntainen
 * + Z-suuntainen) → näkyy joka kulmasta.
 *
 * Uniforms:
 *   uTime       – globaali kellonaika (s)
 *   uBirth      – hetki jolloin wisp syntyi (s)
 *   uLifeDur    – wispin kokonaiskesto (s)
 *   uSeed       – per-wisp satunnaissiemen (0–1)
 *   uHeight     – wispin maksimikorkeus
 */

export const WISP_VERTEX = /* glsl */`
uniform float uTime;
uniform float uBirth;
uniform float uLifeDur;
uniform float uSeed;
uniform float uHeight;

varying float vH;     // normalized height 0–1
varying float vU;     // horizontal UV (-0.5 … 0.5)
varying float vLife;  // life progress 0 → 1

// Cheap value noise
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(hash(i), hash(i + vec2(1,0)), f.x),
        mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x),
        f.y
    );
}

void main() {
    float age = uTime - uBirth;
    float life = clamp(age / uLifeDur, 0.0, 1.0);
    vLife = life;

    // Normalized height along the ribbon (0 = base, 1 = tip)
    float h = position.y / uHeight;
    vH = h;
    vU = position.x;   // plane x range roughly -0.03 … +0.03

    vec3 pos = position;

    // ── Rise: bottom vertices stay, upper vertices rise over lifetime ──
    // The ribbon "grows" upward as it ages
    float riseProgress = smoothstep(0.0, 0.7, life);
    pos.y *= 0.2 + 0.8 * riseProgress;

    // ── Curl / meander ── increasing with height for natural look ──
    float t = uTime * 0.6 + uSeed * 50.0;
    float curlAmt = h * h * 0.38;   // stronger near top — more wobble

    // Primary S-curve
    pos.x += sin(h * 5.0 + t * 1.1) * curlAmt;
    // Secondary ripple (stronger)
    pos.x += sin(h * 9.0 + t * 2.3 + 2.0) * curlAmt * 0.5;
    // Z-axis sway
    pos.z += cos(h * 4.0 + t * 0.7 + uSeed * 3.14) * curlAmt * 0.5;

    // Gentle drift sideways as wisp ages
    float drift = life * 0.12;
    pos.x += sin(uSeed * 6.28) * drift;
    pos.z += cos(uSeed * 6.28) * drift;

    // Micro turbulence via noise (stronger at top)
    float n = vnoise(vec2(h * 6.0 + t * 0.5, uSeed * 10.0));
    pos.x += (n - 0.5) * 0.09 * h;
    pos.z += (n - 0.5) * 0.07 * h;

    // Taper width: less narrowing at top for wider smoke
    float taper = 1.0 - h * 0.35;
    pos.x *= taper;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
`;

export const WISP_FRAGMENT = /* glsl */`
uniform float uOpacity;

varying float vH;
varying float vU;
varying float vLife;

void main() {
    // Soft horizontal Gaussian falloff (ribbon is ~0.14 wide per half)
    float normU = vU / 0.06;   // normalize to roughly -1…1
    float hFall = exp(-normU * normU * 1.8);

    // Vertical density: denser at base, thins out toward top
    float vFade = 1.0 - smoothstep(0.0, 1.0, vH * vH);

    // Life: fade in quickly, hold, fade out slowly
    float fadeIn  = smoothstep(0.0, 0.08, vLife);
    float fadeOut = 1.0 - smoothstep(0.5, 1.0, vLife);

    float alpha = hFall * vFade * fadeIn * fadeOut * uOpacity;

    // Color: warm gray at base (from hot tip), cool light gray at top
    vec3 warmGray = vec3(0.50, 0.47, 0.45);
    vec3 coolGray = vec3(0.72, 0.71, 0.70);
    vec3 color = mix(warmGray, coolGray, vH);

    gl_FragColor = vec4(color, alpha);
}
`;
