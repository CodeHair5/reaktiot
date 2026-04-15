/**
 * Tube.js
 *
 * Yksittäinen koeputki: lasin kuori, nesteen runko ja meniskus.
 * Kaikki tilamuutokset (väri, haze, poreilu, aaltoilu) tapahtuvat
 * tämän luokan julkisten metodien kautta — SceneManager ei kosketa
 * sisäisiin meshehin suoraan.
 *
 * Muistivuodon esto:
 *   • dispose() vapauttaa kaikki geometriat + materiaalit.
 *   • Ei luo uusia Three.js-objekteja hot-pathissa (update-silmukka).
 */

import * as THREE                 from 'three';
import * as BufferGeometryUtils   from 'three/addons/utils/BufferGeometryUtils.js';
import { WATER_VERTEX_SHADER }    from '../shaders/waterVertex.js';
import { BOIL_VERTEX_SHADER }     from '../shaders/boilVertex.js';
import { RIPPLE_VERTEX_SHADER }   from '../shaders/rippleVertex.js';

// ── Vakiot ────────────────────────────────────────────────────────────────────
const TUBE_RADIUS    = 0.5;
const TUBE_HEIGHT    = 4.0;
const WALL_THICKNESS = 0.05;
const LIQUID_RADIUS  = TUBE_RADIUS - WALL_THICKNESS;
const LIQUID_LEVEL   = TUBE_HEIGHT / 2;   // nesteen pinnan korkeus group-avaruudessa

// Jaettu lasimateriaali — kloonataan per putki, ei mutatoida suoraan
const _GLASS_MAT = new THREE.MeshPhysicalMaterial({
    color:           0xffffff,
    metalness:       0.0,
    roughness:       0.05,
    ior:             1.5,
    transmission:    0.98,
    transparent:     true,
    opacity:         0.22,
    envMapIntensity: 0.3,
    depthWrite:      false,
    side:            THREE.DoubleSide,
});

/**
 * Luo koeputken geometria: sylinteri + pallokupoli pohjassa.
 * @param {number} radius
 * @param {number} height
 * @returns {THREE.BufferGeometry}
 */
function buildTubeGeometry(radius, height) {
    const cylH = height - radius;
    const cyl  = new THREE.CylinderGeometry(radius, radius, cylH, 64, 1, true)
        .translate(0, cylH / 2, 0);
    const cap  = new THREE.SphereGeometry(radius, 64, 32, 0, Math.PI * 2, 0, Math.PI / 2)
        .rotateX(Math.PI);
    // Poistetaan UV ennen yhdistämistä — mahdollistaa saumaverteksien
    // hitsauksen (mergeVertices), mikä poistaa näkyvän pystyviivan lasissa.
    cyl.deleteAttribute('uv');
    cap.deleteAttribute('uv');
    const merged = BufferGeometryUtils.mergeGeometries([cap, cyl])
        .translate(0, radius, 0);
    const welded = BufferGeometryUtils.mergeVertices(merged);
    welded.computeVertexNormals();
    return welded;
}

// ── Luokka ────────────────────────────────────────────────────────────────────
export class Tube {
    /**
     * @param {number}         id             - putken indeksi (0-3)
     * @param {THREE.Vector3}  position       - group-positio scene-avaruudessa
     * @param {string}         baseSolution   - esim. 'HCl', 'CuSO4'
     * @param {number}         liquidColor    - alkuperäinen nesteen väri (hex)
     */
    constructor(id, position, baseSolution, liquidColor) {
        this.id           = id;
        this.baseSolution = baseSolution;

        /** Reaktiotila — ChemistryEngine ja SceneManager käyttävät tätä */
        this.state = {
            id,
            baseSolution,
            addedIngredients:   [],
            pendingIngredients: [],
            additionCounts:     {},
            isBubbling:         false,
            isSmoking:          false,
            steamIntensity:     0,      // 0 = ei höyryä; STEAM_INTENSITY-arvo
            hasHaze:            false,
            currentLiquidColor: liquidColor,
            bubblingIntensity:  1.0,
            producesGas:        null,   // 'H2' | 'O2' | null — tulitikkutesti
            exhausted:          false,  // true kun reagenssi on kulutettu loppuun
        };

        this._initialColor = liquidColor;
        this._liquidLevel  = LIQUID_LEVEL;
        this._glowColor    = null;   // null = ei hohto

        this._group           = new THREE.Group();
        this._group.position.copy(position);

        this._glassMesh      = null;
        this._liquidBody     = null;
        this._meniscus       = null;
        this._meniscusUnder  = null;  // BackSide levy — näkyy vain alhaalta
        this._nh4ClFog       = null;
        this._uniforms       = null;   // shader-uniformit meniskukselle

        // Haze-animaatio (NH₄Cl-kerrostuma kasvaa hiljakseen)
        this._hazeTarget = 0;
        this._hazeRate   = 0.12;  // opacity/s

        // Luminol-hohto: flash joka feidaa hiljalleen
        this._glowFlashIntensity = 0;  // nykyinen intensiteetti (feidaa → 0)
        this._glowDecay          = 0.4; // intensiteetti/s

        // Huurtuminen (H₂O kondensaatio lasin pintaan H₂-poksahduksen jälkeen)
        this._frostTimer    = 0;
        this._frostDuration = 0;
        this._boilTarget    = 0.0;
        this._rippleTarget  = 0.0;

        // Kaikki vapautettavat GPU-resurssit
        this._geometries = [];
        this._materials  = [];
    }

    // ── Getterit ──────────────────────────────────────────────────────────────

    get group()        { return this._group; }
    get glassMesh()    { return this._glassMesh; }
    get liquidLevel()  { return this._liquidLevel; }
    get liquidRadius() { return LIQUID_RADIUS; }
    get tubeHeight()   { return TUBE_HEIGHT; }
    get isBoiling()    { return this._boilTarget > 0.05; }
    get isRippling()   { return this._rippleTarget > 0.02; }

    // ── Rakentaminen ──────────────────────────────────────────────────────────

    /**
     * Rakentaa kaikki Three.js-objektit.
     * Kutsutaan kerran sen jälkeen, kun group on lisätty sceneen.
     * @returns {THREE.Group} this._group
     */
    build() {
        this._buildGlass();
        this._buildLiquid();
        this._buildNH4Fog();
        return this._group;
    }

    // ── Julkinen API ──────────────────────────────────────────────────────────

    /**
     * Laukaisee aaltoiluefektin nesteen pinnalla.
     * @param {THREE.Vector2} uvCenter  - impaktin UV (0–1), yleensä (0.5, 0.5)
     * @param {number}        [strength=1.0]
     */
    triggerRipple(uvCenter, strength = 1.0) {
        const u = this._uniforms;
        if (!u) return;
        u.uDropTime.value     = u.uTime.value;
        u.uDropStrength.value = strength;
    }

    /**
     * Päivittää nesteen värin välittömästi (body + meniskus).
     * @param {number} hexColor
     */
    updateColor(hexColor) {
        this.state.currentLiquidColor = hexColor;
        const c = new THREE.Color(hexColor);
        if (this._liquidBody) {
            this._liquidBody.material.color.copy(c);
            this._liquidBody.material.attenuationColor.copy(c);
        }
        if (this._meniscus) {
            this._meniscus.material.color.copy(c);
            this._meniscus.material.attenuationColor.copy(c);
        }
        if (this._meniscusUnder) {
            this._meniscusUnder.material.color.copy(c);
            this._meniscusUnder.material.attenuationColor.copy(c);
        }
    }

    /**
     * Laukaisee Luminol-hohtoefektin: kirkas väläys joka feidaa hiljalleen.
     * Jokainen kutsu lisää intensiteettiin (kumulatiivinen).
     * @param {number} hexColor
     * @param {number} [intensityAdd=2.5]  — lisätty intensiteetti per lisäys
     * @param {number} [decay=0.40]        — intensiteetti/s fade-nopeus
     */
    /** Julkinen lukija — SceneManager synkronoi PointLightin tähän */
    get glowFlashIntensity() { return this._glowFlashIntensity; }

    setGlowFlash(hexColor, intensityAdd = 2.5, decay = 0.40) {
        this._glowColor           = hexColor;
        this._glowDecay           = decay;
        this._glowFlashIntensity  = Math.min(this._glowFlashIntensity + intensityAdd, 4.5);
        const col = new THREE.Color(hexColor);
        if (this._liquidBody) {
            this._liquidBody.material.emissive.copy(col);
        }
        if (this._meniscus) {
            this._meniscus.material.emissive.copy(col);
        }
    }

    /** Poistaa hohdon välittömästi (reset). */
    clearGlow() {
        this._glowColor          = null;
        this._glowFlashIntensity = 0;
        const black = new THREE.Color(0x000000);
        if (this._liquidBody) {
            this._liquidBody.material.emissive.copy(black);
            this._liquidBody.material.emissiveIntensity = 0;
        }
        if (this._meniscus) {
            this._meniscus.material.emissive.copy(black);
            this._meniscus.material.emissiveIntensity = 0;
        }
    }

    /**
     * Huuruttaa lasin väliaikaisesti (H₂O-kondensaatio poksahduksen jälkeen).
     * @param {number} duration  - huurteen kesto sekunteina
     */
    frost(duration) {
        this._frostTimer    = duration;
        this._frostDuration = duration;
        const mat = this._glassMesh?.material;
        if (!mat) return;
        mat.transmission = 0.10;
        mat.roughness    = 0.78;
        mat.opacity      = 0.82;
        mat.color.setHex(0xd4ecff);  // kylmähko sinertava huurre
    }

    /** Asettaa NH₄Cl-kerrostuman opacity (0=kirkas, max=0.65).
     * @param {number} intensity  0–1
     */
    setHaze(intensity) {
        this.state.hasHaze = intensity > 0;
        if (intensity <= 0) {
            // Välitön nollaus (reset)
            this._hazeTarget = 0;
            if (this._nh4ClFog) this._nh4ClFog.material.opacity = 0;
        } else {
            // Aseta tavoite — update()-silmukka animoi hiljakseen
            this._hazeTarget = Math.max(0, Math.min(0.65, intensity));
        }
    }

    /**
     * Aktivoi tai poistaa konvektio-välkkeen (poreilu-efekti pinnalla).
     * @param {boolean} active
     */
    setBubbling(active) {
        this.state.isBubbling = active;
        // uShimmer ei kytketä poreiluun — kuplat ovat ainoa visuaali, ei pintaaaltoilua
    }

    startBoiling(intensity = 1.0) {
        this._boilTarget = Math.max(0, Math.min(1, intensity));
    }

    stopBoiling() {
        this._boilTarget = 0.0;
    }

    startRippling(intensity = 1.0) {
        this._rippleTarget = Math.max(0, Math.min(1, intensity));
    }

    stopRippling() {
        this._rippleTarget = 0.0;
    }

    /**
     * Päivittää shader-uniformit — kutsu joka frame.
     * @param {number} _dt    - delta-aika (ei käytössä toistaiseksi)
     * @param {number} time   - kertynyt aika (THREE.Clock.getElapsedTime)
     */
    update(_dt, time) {
        if (this._uniforms) {
            this._uniforms.uTime.value = time;
            const boilCur = this._uniforms.uBoil.value;
            const boilTgt = this._boilTarget ?? 0;
            if (Math.abs(boilCur - boilTgt) > 0.001) {
                const spd = boilTgt > boilCur ? 0.6 : 1.5;
                this._uniforms.uBoil.value = boilCur + Math.sign(boilTgt - boilCur)
                    * Math.min(spd * _dt, Math.abs(boilTgt - boilCur));
            }
            const rippleCur = this._uniforms.uRipple.value;
            const rippleTgt = this._rippleTarget ?? 0;
            if (Math.abs(rippleCur - rippleTgt) > 0.001) {
                const spd = rippleTgt > rippleCur ? 0.7 : 1.2;
                this._uniforms.uRipple.value = rippleCur + Math.sign(rippleTgt - rippleCur)
                    * Math.min(spd * _dt, Math.abs(rippleTgt - rippleCur));
            }
        }
        // Haze-animaatio: opacity kasvaa hiljakseen tavoitteeseen
        if (this._hazeTarget > 0 && this._nh4ClFog) {
            const cur = this._nh4ClFog.material.opacity;
            if (cur < this._hazeTarget) {
                this._nh4ClFog.material.opacity = Math.min(
                    this._hazeTarget, cur + this._hazeRate * _dt
                );
            }
        }
        // Luminol-hohto: feidaa hiljalleen nollaan
        if (this._glowColor !== null && this._glowFlashIntensity > 0) {
            this._glowFlashIntensity = Math.max(
                0, this._glowFlashIntensity - this._glowDecay * _dt
            );
            const i = this._glowFlashIntensity;
            if (this._liquidBody) this._liquidBody.material.emissiveIntensity = i;
            if (this._meniscus)   this._meniscus.material.emissiveIntensity   = i * 0.7;
            if (i === 0) {
                this._glowColor = null;
                const black = new THREE.Color(0x000000);
                if (this._liquidBody) {
                    this._liquidBody.material.emissive.copy(black);
                    this._liquidBody.material.emissiveIntensity = 0;
                }
                if (this._meniscus) {
                    this._meniscus.material.emissive.copy(black);
                    this._meniscus.material.emissiveIntensity = 0;
                }
            }
        }

        // Huurre-animaatio: palaa kirkkaaseen lasiin kun ajastin laskee nollaan
        if (this._frostTimer > 0) {
            this._frostTimer -= _dt;
            const mat = this._glassMesh?.material;
            if (mat) {
                // t = 0 huurre, 1 = kirkas lasi
                const t = Math.max(0, 1 - this._frostTimer / this._frostDuration);
                // Hidastuvalla easing-funktiolla: kirkkaus palaa nopeammin loppua kohden
                const ease = t * t;
                mat.transmission = 0.10 + (0.98 - 0.10) * ease;
                mat.roughness    = 0.78 + (0.05 - 0.78) * ease;
                mat.opacity      = 0.82 + (0.22 - 0.82) * ease;
                const r = Math.round((0xd4 + (0xff - 0xd4) * ease));
                const g = Math.round((0xec + (0xff - 0xec) * ease));
                const b = Math.round((0xff + (0xff - 0xff) * ease));
                mat.color.setRGB(r / 255, g / 255, b / 255);
                if (this._frostTimer <= 0) {
                    mat.color.setHex(0xffffff);
                    this._frostTimer = 0;
                }
            }
        }
    }

    /** Nollaa tilan alkuperäiseksi (reset). */
    reset() {
        this.state.addedIngredients.length = 0;
        this.state.additionCounts          = {};
        this.state.isBubbling         = false;
        this.state.isSmoking          = false;
        this.state.steamIntensity     = 0;
        this.state.hasHaze            = false;
        this.state.bubblingIntensity  = 1.0;
        this.state.producesGas        = null;
        this.state.exhausted          = false;
        this.updateColor(this._initialColor);
        this.setBubbling(false);
        this.setHaze(0);
        this.clearGlow();
        // Poista huurre
        this._frostTimer = 0;
        const gmat = this._glassMesh?.material;
        if (gmat) {
            gmat.transmission = 0.98;
            gmat.roughness    = 0.05;
            gmat.opacity      = 0.22;
            gmat.color.setHex(0xffffff);
        }
        this._boilTarget   = 0.0;
        this._rippleTarget = 0.0;
        if (this._uniforms) {
            this._uniforms.uDropTime.value = -1000;
            this._uniforms.uShimmer.value  = 0.0;   // nollaa erikseen koska setBubbling ei enää aseta
            this._uniforms.uBoil.value     = 0.0;
            this._uniforms.uRipple.value   = 0.0;
        }
    }

    /**
     * Poistaa groupin scenestä ja vapauttaa kaikki GPU-resurssit.
     * Kutsu vain kun putki poistetaan lopullisesti.
     */
    dispose() {
        if (this._group.parent) this._group.parent.remove(this._group);
        for (const g of this._geometries) g.dispose();
        for (const m of this._materials)  m.dispose();
        this._geometries.length = 0;
        this._materials.length  = 0;
    }

    // ── Yksityiset rakentajat ─────────────────────────────────────────────────

    _buildGlass() {
        const geom = buildTubeGeometry(TUBE_RADIUS, TUBE_HEIGHT);
        const mat  = _GLASS_MAT.clone();
        this._geometries.push(geom);
        this._materials.push(mat);

        const mesh = new THREE.Mesh(geom, mat);
        mesh.renderOrder = 5;
        this._glassMesh  = mesh;
        this._group.add(mesh);

        this._buildRim();
    }

    /**
     * Lisää realistisen lasirengas-suuaukon koeputken ylälaitaan.
     * Torus jäljittelee tulipoltettua lasisuuaukkoa: lasi on
     * reunassa hieman paksumpi ja heijastaa valoa terävemmin.
     */
    _buildRim() {
        // Reuna-rengas: torusgeometria suuaukon ympärillä
        // Torus-säde vastaa putkirunkoa; putkisäde on n. 2× seinämä
        const rimRadius    = TUBE_RADIUS;              // 0.5 — renkaan keskiviiva
        const rimTube      = WALL_THICKNESS * 0.2;     // ~0.035 — hienovarainen reunus
        const rimGeom      = new THREE.TorusGeometry(rimRadius, rimTube, 16, 72);
        rimGeom.rotateX(Math.PI / 2);                  // käännetään vaakatasoon (XZ)

        // Reunamateriaali: hieman vähemmän läpinäkyvä ja terävämmin kiiltävä
        // kuin putken seinämä — jäljittelee tulipoltetun lasin luonnetta
        const rimMat = new THREE.MeshPhysicalMaterial({
            color:           0xffffff,
            metalness:       0.0,
            roughness:       0.02,
            ior:             1.52,
            transmission:    0.88,
            transparent:     true,
            opacity:         0.38,
            reflectivity:    1.0,
            envMapIntensity: 0.55,
            clearcoat:       1.0,
            clearcoatRoughness: 0.02,
            depthWrite:      false,
            side:            THREE.DoubleSide,
        });

        this._geometries.push(rimGeom);
        this._materials.push(rimMat);

        const rimMesh = new THREE.Mesh(rimGeom, rimMat);
        rimMesh.position.y  = TUBE_HEIGHT;    // suuaukon korkeus (y = 4.0)
        rimMesh.renderOrder = 6;              // rendataan lasin päällä
        this._group.add(rimMesh);
    }

    _buildLiquid() {
        const lev = this._liquidLevel;
        const r   = LIQUID_RADIUS;

        // ── Uniforms (jaettu vertex- ja fragment-vaiheille) ───────────────────
        this._uniforms = {
            uTime:         { value: 0 },
            uDropTime:     { value: -1000 },
            uDropStrength: { value: 1.0 },
            uShimmer:      { value: 0.0 },
            uBoil:         { value: 0.0 },
            uRipple:       { value: 0.0 },
        };
        const uniforms = this._uniforms;

        // ── Nesteen runko (ei vertex-displacementia — staattinen tilavuus) ────
        const bodyGeom = buildTubeGeometry(r, lev);
        // MeshPhysicalMaterial + transmission antaa aidon lasimaisen nesteen.
        // attenuationColor värjää nesteen syvyyden mukaan — ohuet osat kirkkaampia.
        const bodyCol = new THREE.Color(this.state.currentLiquidColor);
        const bodyMat  = new THREE.MeshPhysicalMaterial({
            color:              bodyCol,
            roughness:          0.06,
            metalness:          0.0,
            transmission:       0.82,
            thickness:          1.2,
            ior:                1.34,
            attenuationColor:   bodyCol,
            attenuationDistance: 1.2,
            envMapIntensity:    0.45,
            transparent:        true,
            opacity:            1.0,
            depthWrite:         false,
            side:               THREE.FrontSide,
        });
        this._geometries.push(bodyGeom);
        this._materials.push(bodyMat);

        const liquidBody = new THREE.Mesh(bodyGeom, bodyMat);
        liquidBody.renderOrder = 1;
        this._liquidBody = liquidBody;
        this._group.add(liquidBody);

        // ── Meniskus (tasainen levy + aaltoilu-shader) ────────────────────────────
        // LatheGeometry tasaisella profiililla (kaikki y=0) → 32 radiaalirengasta
        // × 64 kulmajaksoa. Profiili kulkee reunasta (r) keskelle (0) — tämä
        // tekee käämityssuunnasta vastapäivän ylhäältä katsottuna, jolloin
        // normaalit osoittavat YLÖSPÄIN (+Y). Jos profiili kulkisi 0→r,
        // normaalit osoittaisivat alaspäin ja aaltoilu näkyisi vain alhaalta.
        const pts = [];
        for (let i = 32; i >= 0; i--) pts.push(new THREE.Vector2(r * i / 32, 0));
        let meniscusGeom = new THREE.LatheGeometry(pts, 64);
        // Hitsaa saumaverteksit sileäksi (sama korjaus kuin buildTubeGeometry:ssa)
        meniscusGeom.deleteAttribute('uv');
        const _tmpMen = BufferGeometryUtils.mergeVertices(meniscusGeom);
        meniscusGeom.dispose();
        meniscusGeom = _tmpMen;
        meniscusGeom.computeVertexNormals();

        // Meniskus tarvitsee terävän heijastuksen, jotta aaltoilu erottuu.
        const meniscusMat  = new THREE.MeshPhysicalMaterial({
            color:              new THREE.Color(this.state.currentLiquidColor),
            roughness:          0.02,
            metalness:          0.0,
            transmission:       0.82,
            thickness:          0.3,
            ior:                1.34,
            attenuationColor:   new THREE.Color(this.state.currentLiquidColor),
            attenuationDistance: 1.5,
            clearcoat:          1.0,
            clearcoatRoughness: 0.01,
            envMapIntensity:    0.55,
            transparent:        true,
            opacity:            1.0,
            depthWrite:         false,
            side:               THREE.FrontSide,
        });

        // Yksikäsitteinen ohjelma-avain per putki-instanssi —
        // estää Three.js:ää jakamasta shader-ohjelmaa putkien välillä,
        // mikä sekoittaisi per-putki-uniformit.
        meniscusMat.customProgramCacheKey = () => `tube-meniscus-${this.id}`;

        meniscusMat.onBeforeCompile = (shader) => {
            // Kopioi viitteet uniformeihin shader-ohjelmaan
            Object.assign(shader.uniforms, uniforms);

            // Lisää uniform-deklaraatiot + aaltoilufunktiot vertex-shaderin alkuun
            shader.vertexShader = WATER_VERTEX_SHADER + BOIL_VERTEX_SHADER + RIPPLE_VERTEX_SHADER + shader.vertexShader
                // 1. Vertex displacement
                .replace(
                    '#include <begin_vertex>',
                    /* glsl */`
                    #include <begin_vertex>
                    transformed.y += getWaveHeight(position) + getConvectionHeight(position) + getBoilHeight(position) + getRippleHeight(position);
                    `
                )
                // 2. Normaaligradientin laskenta — ilman tätä spekulaari on väärä
                // (normaalit osoittaisivat aina ylös vaikka pinta aaltoilee)
                .replace(
                    '#include <beginnormal_vertex>',
                    /* glsl */`
                    #include <beginnormal_vertex>
                    {
                        float gs = 0.04;
                        vec3 pU = vec3(position.x + gs, position.y, position.z);
                        vec3 pD = vec3(position.x - gs, position.y, position.z);
                        vec3 pL = vec3(position.x,      position.y, position.z + gs);
                        vec3 pR = vec3(position.x,      position.y, position.z - gs);
                        float hU = getWaveHeight(pU) + getConvectionHeight(pU) + getBoilHeight(pU) + getRippleHeight(pU);
                        float hD = getWaveHeight(pD) + getConvectionHeight(pD) + getBoilHeight(pD) + getRippleHeight(pD);
                        float hL = getWaveHeight(pL) + getConvectionHeight(pL) + getBoilHeight(pL) + getRippleHeight(pL);
                        float hR = getWaveHeight(pR) + getConvectionHeight(pR) + getBoilHeight(pR) + getRippleHeight(pR);
                        objectNormal = normalize(vec3(
                            (hD - hU) / (2.0 * gs),
                            1.0,
                            (hR - hL) / (2.0 * gs)
                        ));
                    }
                    `
                );
        };

        this._geometries.push(meniscusGeom);
        this._materials.push(meniscusMat);

        const meniscus = new THREE.Mesh(meniscusGeom, meniscusMat);
        // Hieman putken rungon sisään (0.01) — estää näkyvän raon aaltoilun aikana
        meniscus.position.y  = lev - 0.01;
        meniscus.renderOrder = 2;
        this._meniscus = meniscus;
        this._group.add(meniscus);

        // ── Alapuolinen levy (näkyy vain alhaalta katsottuna) ─────────────────
        const underMat = new THREE.MeshPhysicalMaterial({
            color:              new THREE.Color(this.state.currentLiquidColor),
            roughness:          0.08,
            metalness:          0.0,
            transmission:       0.82,
            thickness:          0.5,
            ior:                1.34,
            attenuationColor:   new THREE.Color(this.state.currentLiquidColor),
            attenuationDistance: 1.5,
            envMapIntensity:    0.30,
            transparent:        true,
            opacity:            1.0,
            depthWrite:         false,
            side:               THREE.BackSide,
        });
        underMat.customProgramCacheKey = () => `tube-meniscus-under-${this.id}`;
        underMat.onBeforeCompile = (shader) => {
            Object.assign(shader.uniforms, uniforms);
            shader.vertexShader = WATER_VERTEX_SHADER + BOIL_VERTEX_SHADER + RIPPLE_VERTEX_SHADER + shader.vertexShader
                .replace(
                    '#include <begin_vertex>',
                    /* glsl */`
                    #include <begin_vertex>
                    transformed.y += getWaveHeight(position) + getConvectionHeight(position) + getBoilHeight(position) + getRippleHeight(position);
                    `
                )
                .replace(
                    '#include <beginnormal_vertex>',
                    /* glsl */`
                    #include <beginnormal_vertex>
                    {
                        float gs = 0.04;
                        vec3 pU = vec3(position.x + gs, position.y, position.z);
                        vec3 pD = vec3(position.x - gs, position.y, position.z);
                        vec3 pL = vec3(position.x,      position.y, position.z + gs);
                        vec3 pR = vec3(position.x,      position.y, position.z - gs);
                        float hU = getWaveHeight(pU) + getConvectionHeight(pU) + getBoilHeight(pU) + getRippleHeight(pU);
                        float hD = getWaveHeight(pD) + getConvectionHeight(pD) + getBoilHeight(pD) + getRippleHeight(pD);
                        float hL = getWaveHeight(pL) + getConvectionHeight(pL) + getBoilHeight(pL) + getRippleHeight(pL);
                        float hR = getWaveHeight(pR) + getConvectionHeight(pR) + getBoilHeight(pR) + getRippleHeight(pR);
                        objectNormal = normalize(vec3(
                            (hD - hU) / (2.0 * gs),
                            1.0,
                            (hR - hL) / (2.0 * gs)
                        ));
                    }
                    `
                );
        };
        this._materials.push(underMat);
        const meniscusUnder       = new THREE.Mesh(meniscusGeom, underMat);
        meniscusUnder.position.y  = lev - 0.01;
        meniscusUnder.renderOrder = 2;
        this._meniscusUnder       = meniscusUnder;
        this._group.add(meniscusUnder);
    }

    _buildNH4Fog() {
        const lev       = this._liquidLevel;
        const nh4Height = TUBE_HEIGHT - lev;

        const geom = new THREE.CylinderGeometry(
            LIQUID_RADIUS * 0.93,
            LIQUID_RADIUS * 0.93,
            nh4Height, 20, 1, true
        );
        const mat = new THREE.MeshBasicMaterial({
            color:       0xffffff,
            transparent: true,
            opacity:     0,
            depthWrite:  false,
            side:        THREE.DoubleSide,
        });
        this._geometries.push(geom);
        this._materials.push(mat);

        const fog = new THREE.Mesh(geom, mat);
        fog.renderOrder = 3;
        fog.position.y  = lev + nh4Height / 2;
        this._nh4ClFog  = fog;
        this._group.add(fog);
    }
}
