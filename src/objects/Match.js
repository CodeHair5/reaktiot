/**
 * Match.js - Tulitikku koeputkien kaasutesteihin.
 *
 * Rakenne:
 *   - Group-origo = palava karki (z = 0 group-avaruudessa)
 *   - Tikku ulottuu +Z suuntaan, eli kayttajan puoleen (kamera z=14)
 *   - Karki osoittaa kohti putkia (z = 0 maailmassa)
 *   - Liekki: Points-partikkelit, nousevat Y-suuntaan karjesta
 *
 * Julkinen API:
 *   light(), extinguish(), moveToTube(pos, idx), setRestPosition(camera)
 *   triggerH2Pop(), triggerO2Brighten(), update(dt), dispose(), prewarm()
 */

import * as THREE from 'three';
import { FLAME_LAYERS, getFlameTexture, getGlowTexture, getWaveTexture } from '../shaders/flameSprites.js';

// ── Vakiot ────────────────────────────────────────────────────────────────────
const STICK_LENGTH   = 1.6;
const STICK_RADIUS   = 0.022;
const TIP_RADIUS     = 0.034;

// ── Luokka ────────────────────────────────────────────────────────────────────
export class Match {

    constructor(scene) {
        this._scene  = scene;
        this._group  = new THREE.Group();
        this._group.visible = false;

        this._isLit          = false;
        this._isMoving       = false;
        this._targetPos      = new THREE.Vector3();
        this._targetTubeIdx  = -1;

        this._popFlash           = 0;
        this._popFlashMax        = 0.35;
        this._extinguishAfterPop = false;
        this._brightening        = 0;

        this._tip                = null;
        this._flameSprites        = [];
        this._flameLight          = null;
        this._masterFlameOpacity  = 1.0;

        // Efektianimaatiot
        this._flameFading     = false;
        this._flameFadeT      = 1.0;     // 1 = täysin läpinäkymätön, laskee → 0
        this._flameFadeSpeed  = 1.8;     // kuinka nopeasti fade etenee (1/s)
        this._pressureWaveT   = -1;      // < 0 = ei aktiivinen
        this._pressureWaveDur = 0.40;
        this._o2GlowT         = 0;       // jäljellä oleva hehkuaika (s) — yksisuuntainen
        this._o2GlowDur       = 3.0;
        this._o2ContinuousMode = false;  // true = O₂ jatkuva tila
        this._o2FlameT         = 0;      // kertynyt O₂-aika (s) — ohjaa liekin kasvua
        this._o2GlowSprite    = null;
        this._pressureWave    = null;

        // Kvaternioni-interpolaatio asentoa varten
        this._targetQuat  = new THREE.Quaternion();
        this._currentQuat = new THREE.Quaternion();
        this._isRotating  = false;

        this._build();
        scene.add(this._group);
    }

    get group()          { return this._group; }
    get isLit()           { return this._isLit && !this._flameFading; }
    get isMoving()        { return this._isMoving; }
    get visible()         { return this._group.visible; }
    get o2Continuous()   { return this._o2ContinuousMode; }
    get o2FlameT()        { return this._o2FlameT; }

    // ── Julkinen API ──────────────────────────────────────────────────────────

    light() {
        this._group.visible                   = true;
        this._isLit                           = true;
        this._popFlash                        = 0;
        this._brightening                     = 0;
        this._extinguishAfterPop              = false;
        this._flameFading                     = false;
        this._flameFadeT                      = 1.0;
        this._pressureWaveT                   = -1;
        this._o2GlowT                         = 0;
        this._o2ContinuousMode                = false;
        this._o2FlameT                        = 0;
        this._masterFlameOpacity = 1.0;
        for (const s of this._flameSprites) s.visible = true;
        this._flameLight.visible   = true;
        this._flameLight.intensity = 2.2;
        if (this._o2GlowSprite) { this._o2GlowSprite.material.opacity = 0; this._o2GlowSprite.visible = false; }
    }

    extinguish() {
        this._isLit                           = false;
        this._flameFading                     = false;
        this._flameFadeT                      = 1.0;
        this._o2ContinuousMode                = false;
        this._o2GlowT                         = 0;
        this._o2FlameT                        = 0;
        this._pressureWaveT                   = -1;
        this._masterFlameOpacity = 1.0;
        for (const s of this._flameSprites) s.visible = false;
        this._flameLight.visible = false;
        this._group.visible      = false;
        if (this._o2GlowSprite)  { this._o2GlowSprite.material.opacity = 0; this._o2GlowSprite.visible  = false; }
        if (this._pressureWave)  { this._pressureWave.material.opacity  = 0; this._pressureWave.visible  = false; }
    }

    /** Piilottaa tulitikun välittömästi (käytetään poistonapissa). */
    hide() {
        this.extinguish();
    }

    /**
     * Sammuttaa liekin pehmeästi animoiden — tikku jää edelleen näkyviin.
     * Käytetään CO₂- ja H₂-reaktioissa.
     */
    extinguishFlame() {
        if (!this._isLit || this._flameFading) return;
        this._o2ContinuousMode = false;
        this._o2GlowT          = 0;
        this._o2FlameT         = 0;
        if (this._o2GlowSprite) { this._o2GlowSprite.material.opacity = 0; this._o2GlowSprite.visible = false; }
        this._flameFading = true;
        this._flameFadeT  = 1.0;
    }

    // tubeTopPos = tube.group.position + (0, tube.tubeHeight, 0)
    moveToTube(tubeTopPos, tubeIdx) {
        if (!this._isLit) return;
        this._targetPos.copy(tubeTopPos);
        this._targetPos.y  += 0.10;
        this._targetTubeIdx = tubeIdx;
        this._isMoving      = true;

        // Kaanna vaakatasoon: tikku osoittaa +X (kayttajasta poispain),
        // karki (group-origo) osoittaa putken suulle
        // rotX = -0.12 rad pieni alaviiste, rotY = -PI/2 tikku oikealle
        const e = new THREE.Euler(-0.12, -Math.PI / 2, 0, 'XYZ');
        this._targetQuat.setFromEuler(e);
        this._currentQuat.copy(this._group.quaternion);
        this._isRotating = true;
    }

    /**
     * Lepopaikka telineen oikealla puolella, karki kohti putkia.
     * camera-param sailytetty rajapintayhteensopivuutta varten.
     */
    setRestPosition(_camera) {
        // Pystyasento: tikku roikkuu alaspain (+Z -> -Y kun rotX=+PI/2)
        // karki (group-origo) on ylhaalla, tikku laskeutuu alas
        this._group.position.set(5.2, 6.2, 1.2);
        // rotX = +PI/2 : paikallinen +Z -> maailman -Y -> tikku alaspain
        // pieni rotY-kallistus katsojaan pain, pieni Z-kallistus luonnollisuuden vuoksi
        this._group.rotation.set(Math.PI / 2 - 0.12, 0.18, 0.05);
        this._currentQuat.copy(this._group.quaternion);
        this._targetQuat.copy(this._group.quaternion);
        this._isRotating = false;
    }

    triggerH2Pop() {
        this._popFlash           = this._popFlashMax;
        this._extinguishAfterPop = true;
        this._pressureWaveT      = 0;   // käynnistä paineaaltoanimaatio
    }

    triggerO2Brighten() {
        this._brightening = 2.0;
        this._o2GlowT     = this._o2GlowDur;   // käynnistä O₂-hehkuefekti
    }

    /**
     * Aloittaa jatkuvan O₂-hehkupulssin — käytetään kun tulitikku on
     * asetettu O₂:ta tuottavan putken päälle. Korvaa triggerO2Brighten.
     */
    startO2Continuous() {
        if (!this._isLit) return;
        this._o2ContinuousMode = true;
        this._o2FlameT         = 0;   // aloita liekinkasvu alusta
        this._brightening      = 0;
    }

    /**
     * Lopettaa jatkuvan O₂-hehkupulssin (kaasu loppui, tikku siirrettiin).
     */
    stopO2Continuous() {
        this._o2ContinuousMode = false;
        this._o2FlameT         = 0;
    }

    update(dt) {
        if (!this._group.visible) return;

        // ── Liike kohteeseen ──────────────────────────────────────────────────
        if (this._isMoving) {
            this._group.position.lerp(this._targetPos, 1 - Math.pow(0.02, dt));
            if (this._group.position.distanceTo(this._targetPos) < 0.05) {
                this._group.position.copy(this._targetPos);
                this._isMoving = false;
            }
        }

        // ── Kvaternioni-kaeanto ───────────────────────────────────────────────
        if (this._isRotating) {
            this._currentQuat.slerp(this._targetQuat, 1 - Math.pow(0.015, dt));
            this._group.quaternion.copy(this._currentQuat);
            if (this._currentQuat.angleTo(this._targetQuat) < 0.008) {
                this._group.quaternion.copy(this._targetQuat);
                this._currentQuat.copy(this._targetQuat);
                this._isRotating = false;
            }
        }

        // ── Kärkipisteen maailmakoordinaatit (tarvitaan myös efekteille) ────────
        const tipWorld = new THREE.Vector3();
        this._tip.getWorldPosition(tipWorld);

        // ── H2-paineaalto: laajenee nopeasti ja häipyy ───────────────────────
        if (this._pressureWaveT >= 0) {
            this._pressureWaveT += dt;
            const p = Math.min(1, this._pressureWaveT / this._pressureWaveDur);
            this._pressureWave.position.copy(tipWorld);
            this._pressureWave.scale.setScalar(0.08 + p * 3.2);
            this._pressureWave.material.opacity = (1.0 - p) * 0.82;
            this._pressureWave.visible = true;
            if (p >= 1) {
                this._pressureWaveT        = -1;
                this._pressureWave.visible = false;
            }
        }

        // ── O₂-hehku: liekki kasvaa ja kirkastuu — ei sykkivää palloa ──────────
        if (this._o2ContinuousMode && this._isLit) {
            this._o2FlameT += dt;   // kertaa kauanko O₂-tilassa on oltu
        } else if (this._o2GlowT > 0) {
            this._o2GlowT -= dt;
            const t = Math.max(0, this._o2GlowT) / this._o2GlowDur;
            const opacity = t > 0.85 ? 1.0 : (t / 0.85);
            this._o2GlowSprite.position.copy(tipWorld);
            this._o2GlowSprite.material.opacity = opacity * 0.72;
            this._o2GlowSprite.scale.setScalar(0.5 + t * 2.0);
            this._o2GlowSprite.visible = true;
            if (this._o2GlowT <= 0) {
                this._o2GlowSprite.material.opacity = 0;
                this._o2GlowSprite.visible          = false;
            }
        }

        // ── Liekin pehmeä sammuminen (CO₂ / H₂ jälkeen) ─────────────────────
        if (this._flameFading) {
            this._flameFadeT -= dt * this._flameFadeSpeed;
            const opacity = Math.max(0, this._flameFadeT);
            this._masterFlameOpacity   = opacity;
            this._flameLight.intensity = 2.2 * opacity;
            if (opacity <= 0) {
                this._flameFading = false;
                this._isLit       = false;
                for (const s of this._flameSprites) s.visible = false;
                this._flameLight.visible = false;
                // _group pysyy näkyvissä — tikku jää näkymään sammumisen jälkeen
            }
        }

        if (!this._flameSprites[0]?.visible) return;

        // ── Valo seuraa kärkeä ────────────────────────────────────────────────
        this._flameLight.position.copy(tipWorld);

        // ── Kirkkaus / lepatus ────────────────────────────────────────────────
        const t    = performance.now() * 0.001;
        let bright = 1.0;

        if (this._popFlash > 0) {
            this._popFlash -= dt;
            const tf = Math.max(0, this._popFlash) / this._popFlashMax;
            // tf: 1→0 — liekki leimahdetaan poksahduksen hetkellä
            bright = 1.0 + tf * 3.0;
            this._flameLight.intensity = 2.2 + tf * 5;
            if (this._popFlash <= 0) {
                if (this._extinguishAfterPop) {
                    this._extinguishAfterPop = false;
                    this.extinguishFlame();
                    return;
                }
            }
        } else if (this._brightening > 0) {
            this._brightening -= dt;
            bright = 1.0 + Math.max(0, this._brightening) * 1.8;
            this._flameLight.intensity = 2.2 * bright;
        } else {
            // Lepatteleva: hidas perusaalto + nopea kipina + satunnainen pulssi
            const flicker = 0.76
                + 0.18 * Math.sin(t * 1.7)
                + 0.10 * Math.sin(t * 5.1 + 0.8)
                + 0.04 * Math.sin(t * 11.3 + 2.1)
                + 0.02 * Math.sin(t * 23.7 + 1.3);
            bright = flicker;
            this._flameLight.intensity = 2.2 * flicker;
        }

        // ── O₂-tilamultiplikkeeri: liekki kasvaa hitaasti happiatmosfäärissä ──
        let o2Mul = 1.0;
        if (this._o2ContinuousMode && this._isLit) {
            // Kasvaa 1.0 → 2.6 kuuden sekunnin aikana
            o2Mul = 1.0 + Math.min(this._o2FlameT / 6.0, 1.0) * 1.6;
            this._flameLight.intensity *= o2Mul;
        }

        // ── Kerrossprite-liekki: yhtenäinen lepattava liekki ───────────────
        // Yhteinen heilahdus — koko liekki kelluu yhtenä kappaleena
        const swayX = Math.sin(t * 1.9) * 0.028 * bright;
        const swayZ = Math.cos(t * 1.4) * 0.016 * bright;

        for (let i = 0; i < FLAME_LAYERS.length; i++) {
            const L = FLAME_LAYERS[i];
            const s = this._flameSprites[i];
            // Per-kerros itäinen värinä (korkeilla taajuuksilla)
            const flutter = 1.0
                + 0.08 * Math.sin(t * 7.3 + L.phase)
                + 0.04 * Math.sin(t * 15.7 + L.phase * 1.9)
                + 0.02 * Math.sin(t * 29.1 + L.phase * 0.7);
            const f = bright * flutter;
            // Yläkerrokset heiluvat enemmän (kevyempi lieki nkärki)
            const sf = 0.35 + i * 0.16;
            s.position.set(
                tipWorld.x + swayX * sf,
                tipWorld.y + L.y * (0.94 + 0.06 * bright),
                tipWorld.z + swayZ * sf
            );
            s.scale.set(L.sw * f * o2Mul, L.sh * f * o2Mul, 1);
            s.material.opacity = L.op * Math.min(1.2, f) * this._masterFlameOpacity;
        }
    }

    dispose() {
        for (const s of this._flameSprites) {
            if (s.parent) s.parent.remove(s);
        }
        if (this._flameLight?.parent)   this._flameLight.parent.remove(this._flameLight);
        if (this._o2GlowSprite?.parent) this._o2GlowSprite.parent.remove(this._o2GlowSprite);
        if (this._pressureWave?.parent) this._pressureWave.parent.remove(this._pressureWave);
        if (this._group.parent)         this._group.parent.remove(this._group);
    }

    /**
     * Esikäännös: ajetaan kerran init-vaiheessa ennen ensimmäistä sytyttamistä.
     * Partikkelit jakautuvat luonnollisesti ja GPU:n shader käännetään
     * etukäteen — ensimmäinen sytyttaminen ei töki.
     */
    prewarm(renderer, camera, composer) {
        const wasGroupVis = this._group.visible;
        // Tee spriteistä väliaikaisesti näkyvät shader-käännöstä varten
        this._group.visible = true;
        this._isLit         = true;
        for (const s of this._flameSprites) s.visible = true;
        this._flameLight.visible   = true;
        this._flameLight.intensity = 2.2;

        // renderer.render() pakottaa shaderien käännön JA tekstuurien latauksen GPU:lle.
        // Pelkkä renderer.compile() ei riitä — tekstuurit ladataan vasta ensimmäisellä
        // render-kutsulla, jolloin ensimmäinen sytyttyminen tökkii.
        // Ajetaan useita render-kutsuja varmistaaksemme GPU-putkiston täydellisen lämpiämisen.
        if (renderer && camera) {
            for (let i = 0; i < 5; i++) renderer.render(this._scene, camera);
        }
        // Lämmitellään myös bloom-composer, joka käyttää omaa luminosity-shaderiaan.
        // Ilman tätä bloom-passi käännetään ensimmäistä kertaa vasta kun liekki ilmestyy.
        if (composer) {
            for (let i = 0; i < 3; i++) composer.render();
        }

        // Palautetaan piilotettu tila — light() asettaa oikeat arvot myöhemmin
        this._isLit = false;
        for (const s of this._flameSprites) s.visible = false;
        this._flameLight.visible = false;
        this._group.visible      = wasGroupVis;
    }

    // ── Yksityinen rakentaja ──────────────────────────────────────────────────

    _build() {
        // Group-origo = karki (z=0). Tikku kulkee +Z-suuntaan (kohti kayttajaa).

        // -- Tikku --
        const stickGeom = new THREE.CylinderGeometry(STICK_RADIUS, STICK_RADIUS * 0.9, STICK_LENGTH, 8);
        stickGeom.rotateX(Math.PI / 2);   // CylinderGeometry on Y-akseli -> kaanna Z-akselille
        const stickMat = new THREE.MeshStandardMaterial({ color: 0xe8c97a, roughness: 0.85 });
        const stick    = new THREE.Mesh(stickGeom, stickMat);
        stick.position.z = STICK_LENGTH / 2;   // tikku lahee karjesta (+Z) kohti kayttajaa
        this._group.add(stick);

        // -- Fosforipaa (karki, group-origo z=0) --
        const tipGeom = new THREE.SphereGeometry(TIP_RADIUS, 12, 8);
        const tipMat  = new THREE.MeshStandardMaterial({ color: 0x8b1200, roughness: 0.55 });
        this._tip     = new THREE.Mesh(tipGeom, tipMat);
        this._tip.position.z = 0;
        this._group.add(this._tip);

        // -- Kerrossprite-liekki --
        // Viisi päällekkäistä spritea muodostavat yhtenäisen lepattavan liekin.
        this._flameSprites = [];
        const flameTex = getFlameTexture();
        for (let i = 0; i < FLAME_LAYERS.length; i++) {
            const L = FLAME_LAYERS[i];
            const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
                map:         flameTex,
                color:       L.color,
                transparent: true,
                opacity:     0,
                depthWrite:  false,
                blending:    THREE.AdditiveBlending,
            }));
            sprite.scale.set(L.sw, L.sh, 1);
            sprite.visible = false;
            this._scene.add(sprite);
            this._flameSprites.push(sprite);
        }

        // -- Liekkivalo --
        this._flameLight = new THREE.PointLight(0xffa840, 2.2, 4.0, 2);
        this._flameLight.visible = false;
        this._scene.add(this._flameLight);

        // -- O₂-hehkusprite (laaja pehmeä glow, additive) --
        this._o2GlowSprite = new THREE.Sprite(new THREE.SpriteMaterial({
            map:         getGlowTexture(),
            color:       0xfff4d0,
            transparent: true,
            opacity:     0,
            depthWrite:  false,
            blending:    THREE.AdditiveBlending,
        }));
        this._o2GlowSprite.scale.setScalar(1.5);
        this._o2GlowSprite.visible = false;
        this._scene.add(this._o2GlowSprite);

        // -- H2-paineaaltorengas (laajeneva sprite, additive) --
        this._pressureWave = new THREE.Sprite(new THREE.SpriteMaterial({
            map:         getWaveTexture(),
            color:       0xffe8a0,
            transparent: true,
            opacity:     0,
            depthWrite:  false,
            blending:    THREE.AdditiveBlending,
        }));
        this._pressureWave.scale.setScalar(0.08);
        this._pressureWave.visible = false;
        this._scene.add(this._pressureWave);
    }
}
