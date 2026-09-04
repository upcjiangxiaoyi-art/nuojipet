export const PET_STATES = Object.freeze({
    IDLE: 'idle',
    LISTENING: 'listening',
    THINKING: 'thinking',
    HAPPY: 'happy',
    CONFUSED: 'confused',
    PETTING: 'petting',
    SLEEPING: 'sleeping',
    WAVE: 'wave',
});

const DESIGN_SIZE = 500;
// The pet is at most 303 CSS px wide. A 750 px backing store remains crisp at
// that size while avoiding a 1000 x 1000 redraw on high-DPR iPhones.
const MAX_PIXEL_RATIO = 1.5;
const SKIN_URL = new URL('./assets/nuoji-base-v1.png', import.meta.url).href;
const BODY_LAYER_URL = new URL('./assets/nuoji-body-v2.png', import.meta.url).href;
const TAIL_LAYER_URL = new URL('./assets/nuoji-tail-v1.png', import.meta.url).href;
const UNDERPAINT_LAYER_URL = new URL('./assets/nuoji-underpaint-v1.png', import.meta.url).href;
const LEFT_EAR_LAYER_URL = new URL('./assets/nuoji-ear-left-v1.png', import.meta.url).href;
const RIGHT_EAR_LAYER_URL = new URL('./assets/nuoji-ear-right-v1.png', import.meta.url).href;
const CLOSED_EYES_URL = new URL('./assets/nuoji-closed-eyes-v2.png', import.meta.url).href;
const LYING_SKIN_URL = new URL('./assets/nuoji-lying-v2.png', import.meta.url).href;
const LYING_CLOSED_EYES_URL = new URL('./assets/nuoji-lying-closed-eyes-v2.png', import.meta.url).href;
const BALL_GREEN_URL = new URL('./assets/nuoji-ball-green-v1.png', import.meta.url).href;
const WALK_GREEN_URL = new URL('./assets/nuoji-walk-green-v1.png', import.meta.url).href;
const WALK_FORM_TRANSITION_MS = 190;
const WALK_FORM_SWITCH_ALPHA = 0.12;
const WALK_LAYER_URLS = Object.freeze({
    body: new URL('./assets/nuoji-walk-body-v2.png', import.meta.url).href,
    frontNear: new URL('./assets/nuoji-walk-leg-front-near-v4.png', import.meta.url).href,
    frontFar: new URL('./assets/nuoji-walk-leg-front-far-v3.png', import.meta.url).href,
    hindNear: new URL('./assets/nuoji-walk-leg-hind-near-v4.png', import.meta.url).href,
    hindFar: new URL('./assets/nuoji-walk-leg-hind-far-v3.png', import.meta.url).href,
});
const TAU = Math.PI * 2;
// A relaxed feline walk is a four-beat lateral-sequence gait. Each paw spends
// most of its cycle supporting the body; the short return stroke is the only
// part that lifts. The slightly uneven 0.27 / 0.23 spacing keeps the diagonal
// couplets soft instead of snapping two legs together like a trot.
const WALK_STANCE_PORTION = 0.72;
const WALK_LEGS = Object.freeze([
    {
        name: 'frontFar', pivot: { x: 450, y: 720 }, touchdown: 0.77,
        forwardAngle: 0.20, backwardAngle: 0.17, lift: 10.5, tuck: 0.038,
    },
    {
        name: 'hindFar', pivot: { x: 850, y: 710 }, touchdown: 0.50,
        forwardAngle: 0.19, backwardAngle: 0.21, lift: 10, tuck: 0.034,
    },
    {
        name: 'frontNear', pivot: { x: 370, y: 700 }, touchdown: 0.27,
        forwardAngle: 0.24, backwardAngle: 0.19, lift: 13, tuck: 0.048,
    },
    {
        name: 'hindNear', pivot: { x: 700, y: 710 }, touchdown: 0,
        forwardAngle: 0.23, backwardAngle: 0.24, lift: 12, tuck: 0.042,
    },
]);
const CLOSED_EYES_SOURCE = Object.freeze({ x: 305, y: 290, width: 305, height: 190 });
const TAIL_PIVOT = Object.freeze({ x: 690, y: 760 });
const LEFT_EAR_PIVOT = Object.freeze({ x: 270, y: 360 });
const RIGHT_EAR_PIVOT = Object.freeze({ x: 530, y: 335 });

function wrapUnit(value) {
    return ((value % 1) + 1) % 1;
}

function smootherStep(value) {
    const clamped = Math.min(1, Math.max(0, value));
    return clamped ** 3 * (clamped * (clamped * 6 - 15) + 10);
}

/**
 * Return one leg's pose for a distance-driven four-beat walking cycle.
 * Exported so the gait can be regression-tested without depending on timing.
 */
export function getWalkLegPose(phaseRadians, legName) {
    const leg = WALK_LEGS.find((candidate) => candidate.name === legName);
    if (!leg) {
        throw new RangeError(`Unknown walking leg: ${legName}`);
    }

    // `touchdown` is the point in the global stride at which this paw lands.
    // The order is hind-near -> front-near -> hind-far -> front-far.
    const cycle = wrapUnit((Number(phaseRadians) || 0) / TAU - leg.touchdown);
    if (cycle < WALK_STANCE_PORTION) {
        const progress = smootherStep(cycle / WALK_STANCE_PORTION);
        return {
            angle: leg.forwardAngle + (-leg.backwardAngle - leg.forwardAngle) * progress,
            lift: 0,
            tuck: 0,
            cycle,
            swinging: false,
        };
    }

    const swingProgress = (cycle - WALK_STANCE_PORTION) / (1 - WALK_STANCE_PORTION);
    // Finish the return stroke a little early, then leave one short visual
    // beat with the paw planted forward. At 24 fps this is the missing
    // “touchdown frame”: the paw descends, meets the ground, and only then
    // begins its weight-bearing rearward stroke instead of snapping at the
    // cycle boundary.
    const landingStart = leg.name === 'frontNear' ? 0.84 : 0.90;
    const travel = smootherStep(Math.min(1, swingProgress / landingStart));
    const arcProgress = Math.min(1, swingProgress / landingStart);
    const arc = Math.sin(arcProgress * Math.PI) ** 1.35;
    const landing = swingProgress >= landingStart;
    return {
        angle: -leg.backwardAngle + (leg.forwardAngle + leg.backwardAngle) * travel,
        lift: landing ? 0 : arc * leg.lift,
        tuck: landing ? 0 : arc * leg.tuck,
        cycle,
        landing,
        swinging: !landing,
    };
}

function drawWalkingLeg(ctx, image, leg, phase, still, walkWidth, walkHeight, walkFitScale) {
    const pose = still
        ? { angle: 0, lift: 0, tuck: 0 }
        : getWalkLegPose(phase, leg.name);
    const pivotX = -walkWidth / 2 + leg.pivot.x * walkFitScale;
    const pivotY = -walkHeight + leg.pivot.y * walkFitScale;
    ctx.save();
    ctx.translate(0, -pose.lift);
    ctx.translate(pivotX, pivotY);
    ctx.rotate(pose.angle);
    // A tiny shortening at mid-swing suggests elbow/hock flex without adding
    // extra images or exposing the hidden shoulder/hip seam.
    ctx.scale(1, 1 - pose.tuck);
    ctx.translate(-pivotX, -pivotY);
    ctx.drawImage(image, -walkWidth / 2, -walkHeight, walkWidth, walkHeight);
    ctx.restore();
}

function ellipse(ctx, x, y, radiusX, radiusY, fillStyle) {
    ctx.beginPath();
    ctx.ellipse(x, y, radiusX, radiusY, 0, 0, Math.PI * 2);
    ctx.fillStyle = fillStyle;
    ctx.fill();
}

function roundedTriangle(ctx, top, left, right, radius = 12) {
    const midpoint = {
        x: (left.x + right.x) / 2,
        y: (left.y + right.y) / 2,
    };

    ctx.beginPath();
    ctx.moveTo(midpoint.x, midpoint.y);
    ctx.lineTo(left.x + radius, left.y - radius * 0.15);
    ctx.quadraticCurveTo(left.x, left.y, left.x + radius * 0.55, left.y - radius);
    ctx.lineTo(top.x - radius * 0.4, top.y + radius);
    ctx.quadraticCurveTo(top.x, top.y, top.x + radius * 0.75, top.y + radius * 0.75);
    ctx.lineTo(right.x - radius, right.y - radius * 0.1);
    ctx.quadraticCurveTo(right.x, right.y, right.x - radius * 0.85, right.y + radius * 0.2);
    ctx.closePath();
}

function drawHeart(ctx, x, y, size, color, rotation = 0) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.scale(size / 30, size / 30);
    ctx.beginPath();
    ctx.moveTo(0, 9);
    ctx.bezierCurveTo(-22, -5, -15, -24, 0, -13);
    ctx.bezierCurveTo(15, -24, 22, -5, 0, 9);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
}

/**
 * Canvas renderer for Nuoji's painted skin and lightweight state animation.
 * The original vector kitten remains available only as an emergency fallback
 * when the bundled transparent artwork cannot be loaded.
 */
export class NuojiRenderer {
    constructor(canvas) {
        if (!(canvas instanceof HTMLCanvasElement)) {
            throw new TypeError('NuojiRenderer needs a canvas element.');
        }

        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', { alpha: true });
        this.state = PET_STATES.IDLE;
        this.stateStartedAt = performance.now();
        this.reducedMotion = false;
        this.settingsPreviewMode = false;
        this.running = false;
        this.frameId = 0;
        this.lastFrameAt = 0;
        this.pulseUntil = 0;
        this.skinImage = null;
        this.skinReady = false;
        this.skinFailed = false;
        this.layerImages = { body: null, tail: null, underpaint: null, leftEar: null, rightEar: null };
        this.layersReady = false;
        this.layersFailed = false;
        this.closedEyesImage = null;
        this.closedEyesReady = false;
        this.lyingImage = null;
        this.lyingReady = false;
        this.lyingLoading = false;
        this.lyingClosedEyesImage = null;
        this.lyingClosedEyesReady = false;
        this.lyingClosedEyesLoading = false;
        this.ballImage = null;
        this.ballReady = false;
        this.ballLoading = false;
        this.walkImage = null;
        this.walkLayers = {
            body: null,
            frontNear: null, frontFar: null, hindNear: null, hindFar: null,
        };
        this.walkLayersReady = false;
        this.walkReady = false;
        this.walkLoading = false;
        this.walkDirection = -1;
        this.walkPhase = 0;
        this.requestedForm = 'sitting';
        this.formWeights = { sitting: 1, lying: 0, ball: 0, walking: 0 };
        this.formTransitionFrom = { ...this.formWeights };
        this.formTransitionTarget = { ...this.formWeights };
        this.formTransitionStartedAt = 0;
        this.formTransitionDuration = 460;
        this.formTransitionMode = 'blend';
        this.formTransitionFromName = 'sitting';
        this.formTransitionTargetName = 'sitting';
        this.formTransitionStartOpacity = 1;
        this.formTransitionFold = 0;
        this.boundLoop = this.loop.bind(this);
        this.boundVisibilityChange = this.handleVisibilityChange.bind(this);

        this.resizeBackingStore();
        this.loadLayeredSkin();
        this.loadClosedEyes();
    }

    loadLayeredSkin() {
        const sources = {
            body: BODY_LAYER_URL,
            tail: TAIL_LAYER_URL,
            underpaint: UNDERPAINT_LAYER_URL,
            leftEar: LEFT_EAR_LAYER_URL,
            rightEar: RIGHT_EAR_LAYER_URL,
        };
        let remaining = Object.keys(sources).length;
        let failed = false;

        const finishOne = () => {
            remaining -= 1;
            if (remaining > 0) {
                return;
            }
            this.layersReady = !failed && Object.values(this.layerImages).every(Boolean);
            this.layersFailed = failed;
            if (failed) {
                console.warn('[Nuoji Pet] Animated skin layers failed to load; keeping the still painted skin.');
                this.loadSkin();
            }
            this.draw(performance.now());
        };

        for (const [name, url] of Object.entries(sources)) {
            const image = new Image();
            image.decoding = 'async';
            image.addEventListener('load', () => {
                this.layerImages[name] = image;
                finishOne();
            }, { once: true });
            image.addEventListener('error', () => {
                failed = true;
                this.layerImages[name] = null;
                finishOne();
            }, { once: true });
            image.src = url;
        }
    }

    loadSkin() {
        const image = new Image();
        image.decoding = 'async';
        image.addEventListener('load', () => {
            this.skinImage = image;
            this.skinReady = true;
            this.skinFailed = false;
            this.draw(performance.now());
        }, { once: true });
        image.addEventListener('error', () => {
            this.skinImage = null;
            this.skinReady = false;
            this.skinFailed = true;
            console.warn('[Nuoji Pet] Painted skin failed to load; using the emergency fallback.');
            this.draw(performance.now());
        }, { once: true });
        image.src = SKIN_URL;
    }

    loadClosedEyes() {
        const image = new Image();
        image.decoding = 'async';
        image.addEventListener('load', () => {
            this.closedEyesImage = image;
            this.closedEyesReady = true;
            this.draw(performance.now());
        }, { once: true });
        image.addEventListener('error', () => {
            this.closedEyesImage = null;
            this.closedEyesReady = false;
            console.warn('[Nuoji Pet] Closed-eye skin failed to load; keeping Nuoji\'s eyes open.');
            this.draw(performance.now());
        }, { once: true });
        image.src = CLOSED_EYES_URL;
    }

    loadLyingSkin() {
        if (this.lyingReady || this.lyingLoading) {
            return;
        }
        this.lyingLoading = true;
        const image = new Image();
        image.decoding = 'async';
        image.addEventListener('load', () => {
            this.lyingImage = image;
            this.lyingReady = Boolean(this.lyingImage);
            this.lyingLoading = false;
            if (this.requestedForm === 'lying') {
                this.setForm('lying');
            }
            this.draw(performance.now());
        }, { once: true });
        image.addEventListener('error', () => {
            this.lyingImage = null;
            this.lyingReady = false;
            this.lyingLoading = false;
            console.warn('[Nuoji Pet] Lying pose failed to load; keeping the sitting pose.');
        }, { once: true });
        image.src = LYING_SKIN_URL;
    }

    loadLyingClosedEyes() {
        if (this.lyingClosedEyesReady || this.lyingClosedEyesLoading) {
            return;
        }
        this.lyingClosedEyesLoading = true;
        const image = new Image();
        image.decoding = 'async';
        image.addEventListener('load', () => {
            this.lyingClosedEyesImage = image;
            this.lyingClosedEyesReady = true;
            this.lyingClosedEyesLoading = false;
            this.draw(performance.now());
        }, { once: true });
        image.addEventListener('error', () => {
            this.lyingClosedEyesImage = null;
            this.lyingClosedEyesReady = false;
            this.lyingClosedEyesLoading = false;
            console.warn('[Nuoji Pet] Lying closed-eye layer failed to load; keeping the reclining eyes open.');
        }, { once: true });
        image.src = LYING_CLOSED_EYES_URL;
    }

    loadBallSkin() {
        if (this.ballReady || this.ballLoading) {
            return;
        }
        this.ballLoading = true;
        const image = new Image();
        image.decoding = 'async';
        image.addEventListener('load', () => {
            this.ballImage = this.removeGreenScreen(image);
            this.ballReady = Boolean(this.ballImage);
            this.ballLoading = false;
            if (this.requestedForm === 'ball') {
                this.setForm('ball');
            }
            this.draw(performance.now());
        }, { once: true });
        image.addEventListener('error', () => {
            this.ballImage = null;
            this.ballReady = false;
            this.ballLoading = false;
            console.warn('[Nuoji Pet] Ball pose failed to load; keeping the sitting pose.');
        }, { once: true });
        image.src = BALL_GREEN_URL;
    }

    loadWalkSkin() {
        if (this.walkReady || this.walkLoading) {
            return;
        }
        this.walkLoading = true;
        let remaining = Object.keys(WALK_LAYER_URLS).length;
        let failed = false;
        const finish = () => {
            remaining -= 1;
            if (remaining > 0) {
                return;
            }
            this.walkLayersReady = !failed && Object.values(this.walkLayers).every(Boolean);
            if (this.walkLayersReady) {
                this.walkReady = true;
                this.walkLoading = false;
                if (this.requestedForm === 'walking') {
                    this.setForm('walking');
                }
                this.draw(performance.now());
                return;
            }
            console.warn('[Nuoji Pet] Walking layers failed to load; using the still walking fallback.');
            this.loadWalkFallback();
        };

        for (const [name, url] of Object.entries(WALK_LAYER_URLS)) {
            const image = new Image();
            image.decoding = 'async';
            image.addEventListener('load', () => {
                this.walkLayers[name] = image;
                finish();
            }, { once: true });
            image.addEventListener('error', () => {
                failed = true;
                this.walkLayers[name] = null;
                finish();
            }, { once: true });
            image.src = url;
        }
    }

    loadWalkFallback() {
        const image = new Image();
        image.decoding = 'async';
        image.addEventListener('load', () => {
            this.walkImage = this.removeGreenScreen(image);
            this.walkReady = Boolean(this.walkImage);
            this.walkLoading = false;
            if (this.requestedForm === 'walking' && this.walkReady) {
                this.setForm('walking');
            }
            this.draw(performance.now());
        }, { once: true });
        image.addEventListener('error', () => {
            this.walkImage = null;
            this.walkReady = false;
            this.walkLoading = false;
            console.warn('[Nuoji Pet] Walking fallback failed to load; keeping the sitting pose.');
        }, { once: true });
        image.src = WALK_GREEN_URL;
    }

    removeGreenScreen(image) {
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth || image.width;
        canvas.height = image.naturalHeight || image.height;
        const context = canvas.getContext('2d', { alpha: true, willReadFrequently: true });
        if (!context?.getImageData || !context?.putImageData) {
            // Test and very old canvas shims may not expose pixel writes. The
            // production browsers supported by SillyTavern do.
            return image;
        }

        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        const data = pixels.data;
        for (let index = 0; index < data.length; index += 4) {
            const red = data[index];
            const green = data[index + 1];
            const blue = data[index + 2];
            const screenScore = Math.min(
                green - blue - 8,
                green - (red - 18),
            );
            if (screenScore <= 0) {
                continue;
            }

            data[index + 1] = Math.min(green, Math.max(blue, red - 18));
            const keyProgress = Math.min(1, screenScore / 18);
            const eased = keyProgress * keyProgress * (3 - 2 * keyProgress);
            data[index + 3] = Math.min(data[index + 3], Math.round(255 * (1 - eased)));
        }
        context.putImageData(pixels, 0, 0);
        return canvas;
    }

    resizeBackingStore() {
        const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
        const size = Math.round(DESIGN_SIZE * pixelRatio);

        if (this.canvas.width !== size || this.canvas.height !== size) {
            this.canvas.width = size;
            this.canvas.height = size;
        }

        this.pixelRatio = pixelRatio;
        this.draw(performance.now());
    }

    setState(nextState) {
        if (!Object.values(PET_STATES).includes(nextState)) {
            return;
        }

        if (this.state !== nextState) {
            this.state = nextState;
            this.stateStartedAt = performance.now();
        }

        if (nextState === PET_STATES.SLEEPING) {
            this.loadLyingClosedEyes();
        }

        this.draw(performance.now());
    }

    setForm(nextForm, { immediate = false } = {}) {
        if (!['sitting', 'lying', 'ball', 'walking'].includes(nextForm)) {
            return;
        }
        this.requestedForm = nextForm;
        if (nextForm === 'lying' && !this.lyingReady) {
            this.loadLyingSkin();
        } else if (nextForm === 'ball' && !this.ballReady) {
            this.loadBallSkin();
        } else if (nextForm === 'walking' && !this.walkReady) {
            this.loadWalkSkin();
        }
        const now = performance.now();
        const current = this.currentFormWeights(now);
        const availableForm = nextForm === 'lying' && !this.lyingReady
            || nextForm === 'ball' && !this.ballReady
            || nextForm === 'walking' && !this.walkReady
            ? 'sitting'
            : nextForm;
        const target = {
            sitting: availableForm === 'sitting' ? 1 : 0,
            lying: availableForm === 'lying' ? 1 : 0,
            ball: availableForm === 'ball' ? 1 : 0,
            walking: availableForm === 'walking' ? 1 : 0,
        };
        if (Object.keys(target).every((form) => Math.abs(current[form] - target[form]) < 0.001)) {
            this.formWeights = target;
            this.formTransitionFrom = { ...target };
            this.formTransitionTarget = { ...target };
            this.formTransitionMode = 'blend';
            this.formTransitionFold = 0;
            return;
        }

        const currentForm = Object.entries(current).sort((a, b) => b[1] - a[1])[0][0];
        const serialWalkSwitch = !immediate
            && currentForm !== availableForm
            && (currentForm === 'walking' || availableForm === 'walking');
        this.formTransitionFrom = { ...current };
        this.formTransitionTarget = { ...target };
        this.formTransitionStartedAt = now;
        this.formTransitionMode = serialWalkSwitch ? 'serial-walk' : 'blend';
        this.formTransitionFromName = currentForm;
        this.formTransitionTargetName = availableForm;
        this.formTransitionStartOpacity = Math.max(
            WALK_FORM_SWITCH_ALPHA,
            Number(current[currentForm]) || 0,
        );
        this.formTransitionDuration = immediate
            ? 1
            : serialWalkSwitch ? WALK_FORM_TRANSITION_MS : 460;
        this.draw(now);
    }

    currentFormWeights(now) {
        const progress = Math.min(1, Math.max(0, (now - this.formTransitionStartedAt) / this.formTransitionDuration));
        if (this.formTransitionMode === 'serial-walk' && progress < 1) {
            const weights = { sitting: 0, lying: 0, ball: 0, walking: 0 };
            this.formTransitionFold = Math.sin(progress * Math.PI);
            if (progress < 0.5) {
                const outgoingProgress = progress / 0.5;
                const eased = outgoingProgress * outgoingProgress * (3 - 2 * outgoingProgress);
                weights[this.formTransitionFromName] = this.formTransitionStartOpacity
                    + (WALK_FORM_SWITCH_ALPHA - this.formTransitionStartOpacity) * eased;
            } else {
                const incomingProgress = (progress - 0.5) / 0.5;
                const eased = incomingProgress * incomingProgress * (3 - 2 * incomingProgress);
                weights[this.formTransitionTargetName] = WALK_FORM_SWITCH_ALPHA
                    + (1 - WALK_FORM_SWITCH_ALPHA) * eased;
            }
            this.formWeights = weights;
            return weights;
        }

        const eased = progress * progress * (3 - 2 * progress);
        const weights = {};
        for (const form of ['sitting', 'lying', 'ball', 'walking']) {
            weights[form] = this.formTransitionFrom[form]
                + (this.formTransitionTarget[form] - this.formTransitionFrom[form]) * eased;
        }
        this.formWeights = weights;
        if (progress >= 1) {
            this.formTransitionFrom = { ...this.formTransitionTarget };
            this.formWeights = { ...this.formTransitionTarget };
            this.formTransitionMode = 'blend';
            this.formTransitionFold = 0;
        }
        return this.formWeights;
    }

    currentForm(now = performance.now()) {
        const weights = this.currentFormWeights(now);
        return Object.entries(weights).sort((a, b) => b[1] - a[1])[0][0];
    }

    currentFormBlend(now) {
        return this.currentFormWeights(now).lying;
    }

    setWalkDirection(direction) {
        this.walkDirection = Number(direction) >= 0 ? 1 : -1;
        this.draw(performance.now());
    }

    setWalkProgress(traveledPixels, strideLengthPixels) {
        const stride = Math.max(1, Number(strideLengthPixels) || 1);
        this.walkPhase = Math.max(0, Number(traveledPixels) || 0) / stride * Math.PI * 2;
    }

    setReducedMotion(enabled) {
        this.reducedMotion = Boolean(enabled);
        this.draw(performance.now());
    }

    setSettingsPreviewMode(enabled) {
        const nextValue = Boolean(enabled);
        if (this.settingsPreviewMode === nextValue) {
            return;
        }

        this.settingsPreviewMode = nextValue;
        this.draw(performance.now());
    }

    pulse() {
        this.pulseUntil = performance.now() + 260;
    }

    start() {
        if (this.running) {
            return;
        }

        this.running = true;
        this.lastFrameAt = 0;
        document.addEventListener('visibilitychange', this.boundVisibilityChange);
        this.frameId = requestAnimationFrame(this.boundLoop);
    }

    stop() {
        this.running = false;
        cancelAnimationFrame(this.frameId);
        document.removeEventListener('visibilitychange', this.boundVisibilityChange);
    }

    destroy() {
        this.stop();
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.lyingImage = null;
        this.lyingClosedEyesImage = null;
        this.lyingClosedEyesReady = false;
        this.lyingClosedEyesLoading = false;
        this.ballImage = null;
        this.walkImage = null;
        this.walkLayers = {
            body: null,
            frontNear: null, frontFar: null, hindNear: null, hindFar: null,
        };
        this.walkLayersReady = false;
    }

    handleVisibilityChange() {
        if (!document.hidden && this.running) {
            this.lastFrameAt = 0;
            cancelAnimationFrame(this.frameId);
            this.frameId = requestAnimationFrame(this.boundLoop);
        }
    }

    loop(now) {
        if (!this.running) {
            return;
        }

        if (document.hidden) {
            this.frameId = requestAnimationFrame(this.boundLoop);
            return;
        }

        const minimumFrameTime = Math.max(
            this.reducedMotion ? 180 : 1000 / 24,
            this.settingsPreviewMode ? 1000 / 12 : 0,
        );
        if (now - this.lastFrameAt >= minimumFrameTime) {
            this.draw(now);
            this.lastFrameAt = now;
        }

        this.frameId = requestAnimationFrame(this.boundLoop);
    }

    draw(now) {
        const ctx = this.ctx;
        if (!ctx) {
            return;
        }

        const ratio = this.pixelRatio || 1;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.clearRect(0, 0, DESIGN_SIZE, DESIGN_SIZE);

        if ((this.skinReady && this.skinImage) || this.layersReady) {
            this.drawPaintedSkin(ctx, now);
            return;
        }

        // Avoid flashing the old vector skin while the local PNG is decoding.
        if (!this.skinFailed) {
            return;
        }

        const seconds = (now - this.stateStartedAt) / 1000;
        const still = this.reducedMotion;
        const sleeping = this.state === PET_STATES.SLEEPING;
        const breathing = still ? 0 : Math.sin(seconds * (sleeping ? 1.8 : 2.7)) * (sleeping ? 3.2 : 1.4);
        const celebratoryBounce = !still && [PET_STATES.HAPPY, PET_STATES.PETTING].includes(this.state)
            ? -Math.abs(Math.sin(seconds * 5.2)) * 5
            : 0;
        const streamingPulse = !still && now < this.pulseUntil
            ? Math.sin((this.pulseUntil - now) / 260 * Math.PI) * 2.5
            : 0;
        const confusedTilt = this.state === PET_STATES.CONFUSED ? -0.075 : 0;
        const listeningTilt = this.state === PET_STATES.LISTENING ? 0.035 : 0;
        const bodyY = breathing + celebratoryBounce - streamingPulse;

        ctx.save();
        ctx.translate(250, 270 + bodyY);
        ctx.rotate(confusedTilt + listeningTilt);
        ctx.translate(-250, -270);

        this.drawShadow(ctx, bodyY);
        this.drawTail(ctx, seconds, still);

        // Nuoji is fluffy, not round: keep a light cat-fox silhouette while the
        // oversized tail stays gloriously plush behind her.
        ctx.save();
        ctx.translate(250, 270);
        ctx.scale(0.84, 1.025);
        ctx.translate(-250, -270);
        this.drawBody(ctx, breathing);
        this.drawHead(ctx, seconds, still);
        this.drawFace(ctx, seconds, still);
        this.drawPaws(ctx, seconds, still);
        this.drawStateAccents(ctx, seconds, still);
        ctx.restore();

        ctx.restore();
    }

    drawPaintedSkin(ctx, now) {
        const seconds = (now - this.stateStartedAt) / 1000;
        const still = this.reducedMotion;
        const wave = still ? 0 : Math.sin(seconds * 2.5);
        const quickWave = still ? 0 : Math.sin(seconds * 6.2);
        const streamPulse = !still && now < this.pulseUntil
            ? Math.sin((this.pulseUntil - now) / 260 * Math.PI)
            : 0;
        const formWeights = this.currentFormWeights(now);
        const sittingBlend = formWeights.sitting;
        const lyingBlend = this.lyingReady ? formWeights.lying : 0;
        const ballBlend = this.ballReady ? formWeights.ball : 0;
        const walkingBlend = this.walkReady ? formWeights.walking : 0;
        const formFold = this.formTransitionFold;

        let offsetX = 0;
        let offsetY = 0;
        let rotation = 0;
        let scaleX = 1;
        let scaleY = 1;
        let alpha = 1;

        switch (this.state) {
            case PET_STATES.LISTENING:
                rotation = still ? 0.018 : 0.018 + wave * 0.008;
                scaleX = 1.008;
                scaleY = 1.008;
                break;
            case PET_STATES.THINKING:
                if (still) {
                    rotation = -0.008;
                } else {
                    // Two tiny nods followed by a short attentive pause. The
                    // motion stays obvious at iPhone scale without turning the
                    // whole cat into a bouncing ball.
                    const nodWindow = seconds % 2.8;
                    const nod = nodWindow < 1.1
                        ? Math.sin((nodWindow / 1.1) * Math.PI * 2) ** 2
                        : 0;
                    offsetY = nod * 6.5;
                    rotation = -0.008 + Math.sin(seconds * 1.4) * 0.003;
                    scaleX = 1 + nod * 0.004;
                    scaleY = 1 - nod * 0.01;
                }
                break;
            case PET_STATES.HAPPY:
                offsetY = still ? -2 : -Math.abs(quickWave) * 7;
                scaleX = still ? 1.01 : 1.01 + Math.abs(quickWave) * 0.012;
                scaleY = still ? 1.01 : 1.01 - Math.abs(quickWave) * 0.006;
                break;
            case PET_STATES.CONFUSED:
                offsetX = -3;
                rotation = -0.045;
                break;
            case PET_STATES.PETTING:
                offsetY = still ? 2 : 2 + Math.abs(quickWave) * 2;
                scaleX = still ? 1.012 : 1.012 + Math.abs(quickWave) * 0.008;
                scaleY = still ? 0.992 : 0.992 - Math.abs(quickWave) * 0.006;
                break;
            case PET_STATES.SLEEPING:
                offsetY = 5;
                rotation = -0.012;
                scaleX = 1.006;
                scaleY = 0.988;
                alpha = 0.94;
                break;
            case PET_STATES.WAVE:
                offsetX = still ? 0 : quickWave * 2.5;
                rotation = still ? 0.018 : quickWave * 0.022;
                break;
            case PET_STATES.IDLE:
            default: {
                const breath = still ? 0 : Math.sin(seconds * 2.1);
                offsetY = breath * 1.1;
                scaleX = 1 - breath * 0.0025;
                scaleY = 1 + breath * 0.0045;
                break;
            }
        }

        offsetY -= streamPulse * 2.2;

        ctx.save();
        ctx.globalAlpha = 0.13;
        const shadowRadius = 139 * sittingBlend + 193 * lyingBlend + 112 * ballBlend + 156 * walkingBlend;
        ellipse(ctx, 251, 469, shadowRadius, 13 - ballBlend * 2, '#1d2832');
        ctx.restore();

        const referenceImage = this.layersReady ? this.layerImages.body : this.skinImage;
        const naturalWidth = referenceImage.naturalWidth || referenceImage.width;
        const naturalHeight = referenceImage.naturalHeight || referenceImage.height;
        const fitScale = Math.min(438 / naturalWidth, 472 / naturalHeight);
        const drawWidth = naturalWidth * fitScale;
        const drawHeight = naturalHeight * fitScale;

        if (sittingBlend > 0.001) {
            ctx.save();
            ctx.globalAlpha = alpha * sittingBlend;
            ctx.translate(250 + offsetX, 468 + offsetY + (1 - sittingBlend) * 18);
            ctx.rotate(rotation * sittingBlend);
            ctx.scale(
                scaleX * (1 - formFold * 0.035),
                scaleY * (0.92 + sittingBlend * 0.08) * (1 - formFold * 0.14),
            );
            if (this.layersReady) {
                this.drawLayeredSkin(ctx, seconds, still, naturalWidth, drawWidth, drawHeight);
            } else {
                ctx.drawImage(this.skinImage, -drawWidth / 2, -drawHeight, drawWidth, drawHeight);
            }
            this.drawClosedEyesOverlay(ctx, now, naturalWidth, drawWidth, drawHeight);
            ctx.restore();
        }

        if (lyingBlend > 0.001 && this.lyingImage) {
            const lyingNaturalWidth = this.lyingImage.naturalWidth || this.lyingImage.width;
            const lyingNaturalHeight = this.lyingImage.naturalHeight || this.lyingImage.height;
            const lyingFitScale = Math.min(470 / lyingNaturalWidth, 382 / lyingNaturalHeight);
            const lyingWidth = lyingNaturalWidth * lyingFitScale;
            const lyingHeight = lyingNaturalHeight * lyingFitScale;
            const lyingBreath = still ? 0 : Math.sin(seconds * 1.8) * 0.004;
            ctx.save();
            ctx.globalAlpha = alpha * lyingBlend;
            ctx.translate(250, 468 + (1 - lyingBlend) * 16);
            ctx.scale(1 - (1 - lyingBlend) * 0.04, 0.94 + lyingBlend * 0.06 + lyingBreath);
            ctx.drawImage(this.lyingImage, -lyingWidth / 2, -lyingHeight, lyingWidth, lyingHeight);
            if (this.state === PET_STATES.SLEEPING && this.lyingClosedEyesReady) {
                ctx.drawImage(
                    this.lyingClosedEyesImage,
                    -lyingWidth / 2,
                    -lyingHeight,
                    lyingWidth,
                    lyingHeight,
                );
            }
            ctx.restore();
        }

        if (ballBlend > 0.001 && this.ballImage) {
            const ballNaturalWidth = this.ballImage.naturalWidth || this.ballImage.width;
            const ballNaturalHeight = this.ballImage.naturalHeight || this.ballImage.height;
            const ballFitScale = Math.min(374 / ballNaturalWidth, 374 / ballNaturalHeight);
            const ballWidth = ballNaturalWidth * ballFitScale;
            const ballHeight = ballNaturalHeight * ballFitScale;
            const rolling = still ? 0 : Math.sin(seconds * 4.6) * 0.12;
            const tokenKick = streamPulse * 0.075;
            const hop = still ? 0 : Math.abs(Math.sin(seconds * 4.6)) * 3.2;
            ctx.save();
            ctx.globalAlpha = alpha * ballBlend;
            ctx.translate(250, 506 - ballHeight / 2 - hop + (1 - ballBlend) * 14);
            ctx.rotate((rolling + tokenKick) * ballBlend);
            const squash = still ? 0 : Math.abs(Math.sin(seconds * 4.6)) * 0.012;
            ctx.scale(1 + squash, 1 - squash);
            ctx.drawImage(this.ballImage, -ballWidth / 2, -ballHeight / 2, ballWidth, ballHeight);
            ctx.restore();
        }

        if (walkingBlend > 0.001 && (this.walkLayersReady || this.walkImage)) {
            const gaitFrame = this.walkLayersReady ? this.walkLayers.body : this.walkImage;
            const walkNaturalWidth = gaitFrame.naturalWidth || gaitFrame.width;
            const walkNaturalHeight = gaitFrame.naturalHeight || gaitFrame.height;
            const walkFitScale = Math.min(465 / walkNaturalWidth, 382 / walkNaturalHeight);
            const walkWidth = walkNaturalWidth * walkFitScale;
            const walkHeight = walkNaturalHeight * walkFitScale;
            const phase = still ? 0 : this.walkPhase;
            // Four tiny weight transfers per stride, with a slower two-beat
            // shoulder/hip counter-shift underneath. Keep both subtle: the
            // paws should sell the walk, not a bouncing body plate.
            const transfer = still ? 0 : (1 - Math.cos(phase * 4)) * 0.5;
            const bob = transfer * 1.35;
            const lean = still ? 0 : Math.sin(phase * 2) * 0.0035 * this.walkDirection;
            const squash = still ? 0 : transfer * 0.0016;
            ctx.save();
            ctx.globalAlpha = alpha * walkingBlend;
            // The production plate has generous green-key margin below the paws.
            // Lower its canvas origin so the visible feet meet the shared ground line.
            ctx.translate(250, 512 - bob + (1 - walkingBlend) * 14);
            ctx.rotate(lean * walkingBlend);
            // The production plate faces left. Mirror it only while travelling right.
            ctx.scale(-this.walkDirection, 1);
            ctx.scale(
                (1 + squash) * (1 - formFold * 0.035),
                (1 - squash * 0.7) * (1 - formFold * 0.14),
            );
            if (this.walkLayersReady) {
                // All four complete legs go down first (far pair, then near
                // pair for depth), and the whole leg-free body is painted last.
                // The body plate is the mask: every shoulder/hip joint, cut
                // edge and joint cap stays hidden under the real chest and
                // belly fur, while the lower legs and paws that extend past
                // the silhouette stay visible. Nothing is drawn over the body,
                // so nothing can bulge out of it as the legs rotate.
                for (const leg of WALK_LEGS) {
                    drawWalkingLeg(
                        ctx, this.walkLayers[leg.name], leg, phase, still,
                        walkWidth, walkHeight, walkFitScale,
                    );
                }
                ctx.drawImage(this.walkLayers.body, -walkWidth / 2, -walkHeight, walkWidth, walkHeight);
            } else {
                ctx.drawImage(gaitFrame, -walkWidth / 2, -walkHeight, walkWidth, walkHeight);
            }
            ctx.restore();
        }

        this.drawPaintedAccents(ctx, seconds, still);
    }

    tailAngle(seconds, still) {
        if (still) {
            return 0;
        }

        switch (this.state) {
            case PET_STATES.HAPPY:
                return Math.sin(seconds * 5) * 0.11;
            case PET_STATES.PETTING:
                return Math.sin(seconds * 2.25) * 0.09;
            case PET_STATES.WAVE:
                return Math.sin(seconds * 4.2) * 0.1;
            case PET_STATES.LISTENING:
                return Math.sin(seconds * 2.2) * 0.045;
            case PET_STATES.THINKING:
                return Math.sin(seconds * 1.7) * 0.035;
            case PET_STATES.CONFUSED:
                return -0.02 + Math.sin(seconds * 1.4) * 0.02;
            case PET_STATES.SLEEPING:
                return Math.sin(seconds * 0.8) * 0.01;
            case PET_STATES.IDLE:
            default:
                return Math.sin(seconds * 1.6) * 0.035;
        }
    }

    earAngles(seconds, still) {
        switch (this.state) {
            case PET_STATES.LISTENING: {
                // Perk quickly with one soft overshoot, then stay visibly alert.
                const overshoot = !still && seconds < 0.38
                    ? Math.sin((seconds / 0.38) * Math.PI) * 0.055
                    : 0;
                const perk = 0.065 + overshoot;
                return { left: perk, right: -perk };
            }
            case PET_STATES.THINKING: {
                // One ear pops, then the other on the next cycle.
                const cycle = Math.floor(seconds / 2.4);
                const phase = seconds % 2.4;
                const pop = !still && phase < 0.42
                    ? Math.sin((phase / 0.42) * Math.PI) * 0.065
                    : 0;
                return cycle % 2 === 0
                    ? { left: 0.018 + pop, right: -0.018 }
                    : { left: 0.018, right: -0.018 - pop };
            }
            case PET_STATES.HAPPY: {
                // Two unmistakable little ear flicks, followed by a pause.
                const phase = seconds % 1.45;
                let flick = 0;
                if (!still && phase < 0.22) {
                    flick = Math.sin((phase / 0.22) * Math.PI) * 0.072;
                } else if (!still && phase >= 0.32 && phase < 0.54) {
                    flick = Math.sin(((phase - 0.32) / 0.22) * Math.PI) * 0.072;
                }
                return { left: flick, right: -flick };
            }
            case PET_STATES.CONFUSED:
                return {
                    left: -0.125 + (still ? 0 : Math.sin(seconds * 1.5) * 0.008),
                    right: 0.014,
                };
            case PET_STATES.PETTING: {
                const relax = still ? 0 : Math.sin(seconds * 2) * 0.01;
                return { left: -0.065 + relax, right: 0.065 - relax };
            }
            case PET_STATES.SLEEPING:
                return { left: -0.045, right: 0.045 };
            case PET_STATES.WAVE: {
                const twitch = still ? 0 : Math.sin(seconds * 5.2) * 0.058;
                return { left: twitch, right: -twitch };
            }
            case PET_STATES.IDLE:
            default: {
                if (still) {
                    return { left: 0, right: 0 };
                }
                const cycle = Math.floor(seconds / 5.2);
                const phase = seconds % 5.2;
                const flick = phase < 0.34
                    ? Math.sin((phase / 0.34) * Math.PI) * 0.045
                    : 0;
                return cycle % 2 === 0
                    ? { left: flick, right: 0 }
                    : { left: 0, right: -flick };
            }
        }
    }

    drawRotatedLayer(ctx, image, pivot, angle, sourceLeft, sourceTop, sourceScale, drawWidth, drawHeight) {
        const pivotX = sourceLeft + pivot.x * sourceScale;
        const pivotY = sourceTop + pivot.y * sourceScale;
        ctx.save();
        ctx.translate(pivotX, pivotY);
        ctx.rotate(angle);
        ctx.translate(-pivotX, -pivotY);
        ctx.drawImage(image, sourceLeft, sourceTop, drawWidth, drawHeight);
        ctx.restore();
    }

    drawLayeredSkin(ctx, seconds, still, naturalWidth, drawWidth, drawHeight) {
        const sourceScale = drawWidth / naturalWidth;
        const sourceLeft = -drawWidth / 2;
        const sourceTop = -drawHeight;

        // The underpaint is never visible at rest. It only fills the slim patch
        // behind the tail when the original painted tail swings away.
        ctx.drawImage(this.layerImages.underpaint, sourceLeft, sourceTop, drawWidth, drawHeight);

        this.drawRotatedLayer(
            ctx,
            this.layerImages.tail,
            TAIL_PIVOT,
            this.tailAngle(seconds, still),
            sourceLeft,
            sourceTop,
            sourceScale,
            drawWidth,
            drawHeight,
        );

        // The hidden crown underpaint is baked into the body layer. It only
        // peeks through the tiny gaps exposed by the independently moving ears.
        ctx.drawImage(this.layerImages.body, sourceLeft, sourceTop, drawWidth, drawHeight);

        const ears = this.earAngles(seconds, still);
        this.drawRotatedLayer(
            ctx,
            this.layerImages.leftEar,
            LEFT_EAR_PIVOT,
            ears.left,
            sourceLeft,
            sourceTop,
            sourceScale,
            drawWidth,
            drawHeight,
        );
        this.drawRotatedLayer(
            ctx,
            this.layerImages.rightEar,
            RIGHT_EAR_PIVOT,
            ears.right,
            sourceLeft,
            sourceTop,
            sourceScale,
            drawWidth,
            drawHeight,
        );
    }

    blinkAmount(now) {
        if ([PET_STATES.HAPPY, PET_STATES.PETTING, PET_STATES.SLEEPING].includes(this.state)) {
            return 1;
        }

        if (this.reducedMotion) {
            return 0;
        }

        // A quick natural blink roughly every 4.7 seconds. Using absolute time
        // prevents state changes from restarting the blink rhythm.
        const phase = (now % 4700) / 1000;
        if (phase >= 0.16) {
            return 0;
        }

        return Math.sin((phase / 0.16) * Math.PI);
    }

    drawClosedEyesOverlay(ctx, now, naturalWidth, drawWidth, drawHeight) {
        const amount = this.blinkAmount(now);
        if (amount <= 0.01 || !this.closedEyesReady || !this.closedEyesImage) {
            return;
        }

        const sourceScale = drawWidth / naturalWidth;
        const sourceLeft = -drawWidth / 2;
        const sourceTop = -drawHeight;

        ctx.save();
        ctx.globalAlpha *= Math.min(1, amount * 1.35);
        ctx.drawImage(
            this.closedEyesImage,
            sourceLeft + CLOSED_EYES_SOURCE.x * sourceScale,
            sourceTop + CLOSED_EYES_SOURCE.y * sourceScale,
            CLOSED_EYES_SOURCE.width * sourceScale,
            CLOSED_EYES_SOURCE.height * sourceScale,
        );
        ctx.restore();
    }

    drawPaintedAccents(ctx, seconds, still) {
        if (this.state === PET_STATES.LISTENING) {
            const pulse = still ? 0 : Math.sin(seconds * 4) * 2;
            ctx.save();
            ctx.strokeStyle = 'rgba(211, 163, 82, 0.78)';
            ctx.lineWidth = 3;
            ctx.lineCap = 'round';
            for (let index = 0; index < 2; index += 1) {
                ctx.beginPath();
                ctx.arc(408, 113, 15 + index * 12 + pulse, -0.8, 0.55);
                ctx.stroke();
            }
            ctx.restore();
        }

        if (this.state === PET_STATES.THINKING) {
            for (let index = 0; index < 3; index += 1) {
                const phase = still ? index : (index + Math.floor(seconds * 3)) % 3;
                ctx.save();
                ctx.globalAlpha = 0.38 + phase * 0.25;
                ellipse(ctx, 388 + index * 22, 112 - index * 13, 6 + index, 6 + index, '#d6a457');
                ctx.restore();
            }
        }

        if (this.state === PET_STATES.HAPPY) {
            const sparkle = still ? 0.85 : 0.68 + Math.sin(seconds * 7) * 0.2;
            ctx.save();
            ctx.globalAlpha = sparkle;
            ctx.fillStyle = '#e7bb62';
            for (const [x, y, size] of [[72, 151, 9], [419, 176, 8], [389, 91, 6]]) {
                ctx.beginPath();
                ctx.moveTo(x, y - size);
                ctx.lineTo(x + size * 0.3, y - size * 0.3);
                ctx.lineTo(x + size, y);
                ctx.lineTo(x + size * 0.3, y + size * 0.3);
                ctx.lineTo(x, y + size);
                ctx.lineTo(x - size * 0.3, y + size * 0.3);
                ctx.lineTo(x - size, y);
                ctx.lineTo(x - size * 0.3, y - size * 0.3);
                ctx.closePath();
                ctx.fill();
            }
            ctx.restore();
        }

        if (this.state === PET_STATES.CONFUSED) {
            ctx.save();
            ctx.translate(405, 106);
            ctx.rotate(0.1);
            ctx.font = '700 48px ui-rounded, system-ui, sans-serif';
            ctx.fillStyle = '#bd8741';
            ctx.fillText('?', 0, 0);
            ctx.restore();
        }

        if (this.state === PET_STATES.PETTING) {
            const rise = still ? 0 : (seconds * 20) % 16;
            drawHeart(ctx, 79, 151 - rise * 0.22, 24, '#e99aa1', -0.2);
            drawHeart(ctx, 408, 119 - rise * 0.35, 30, '#e5aa73', 0.18);
            drawHeart(ctx, 433, 161 - rise * 0.15, 17, '#e99aa1', 0.12);
        }

        if (this.state === PET_STATES.SLEEPING) {
            const rise = still ? 0 : (seconds * 16) % 27;
            ctx.save();
            ctx.globalAlpha = 0.72;
            ctx.font = '700 27px ui-rounded, system-ui, sans-serif';
            ctx.fillStyle = '#8798a8';
            ctx.fillText('z', 385, 129 - rise * 0.23);
            ctx.font = '700 37px ui-rounded, system-ui, sans-serif';
            ctx.fillText('Z', 409, 101 - rise * 0.4);
            ctx.restore();
        }

        if (this.state === PET_STATES.WAVE) {
            const opacity = still ? 0.8 : 0.62 + Math.sin(seconds * 7) * 0.2;
            ctx.save();
            ctx.globalAlpha = opacity;
            drawHeart(ctx, 416, 139, 20, '#e6a477', 0.18);
            ctx.restore();
        }
    }

    drawShadow(ctx, bodyY) {
        ctx.save();
        ctx.globalAlpha = 0.2;
        ellipse(ctx, 247, 449 - bodyY * 0.2, 128, 21, '#26313a');
        ctx.restore();
    }

    drawTail(ctx, seconds, still) {
        const active = [PET_STATES.HAPPY, PET_STATES.PETTING, PET_STATES.WAVE].includes(this.state);
        const amplitude = active ? 15 : 6;
        const wag = still ? 0 : Math.sin(seconds * (active ? 4.4 : 2.2)) * amplitude;

        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        const tailGradient = ctx.createLinearGradient(325, 395, 444, 218);
        tailGradient.addColorStop(0, '#aeb8c2');
        tailGradient.addColorStop(0.52, '#e7edf2');
        tailGradient.addColorStop(1, '#fbfdff');

        ctx.beginPath();
        ctx.moveTo(325, 389);
        ctx.bezierCurveTo(420 + wag * 0.35, 422, 458 + wag, 342, 423 + wag * 0.72, 254);
        ctx.strokeStyle = 'rgba(40, 51, 64, 0.18)';
        ctx.lineWidth = 91;
        ctx.stroke();
        ctx.strokeStyle = tailGradient;
        ctx.lineWidth = 82;
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(421 + wag * 0.74, 263);
        ctx.bezierCurveTo(432 + wag * 0.85, 235, 428 + wag * 0.9, 218, 414 + wag * 0.9, 205);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 62;
        ctx.stroke();
        ctx.restore();
    }

    drawBody(ctx, breathing) {
        const bodyGradient = ctx.createLinearGradient(154, 224, 345, 444);
        bodyGradient.addColorStop(0, '#f2f6f8');
        bodyGradient.addColorStop(0.58, '#d9e1e7');
        bodyGradient.addColorStop(1, '#aeb9c3');

        ctx.save();
        ctx.shadowColor = 'rgba(32, 45, 58, 0.22)';
        ctx.shadowBlur = 17;
        ctx.shadowOffsetY = 8;
        ellipse(ctx, 250, 337, 119 + breathing * 0.2, 125 + breathing, bodyGradient);
        ctx.restore();

        const bellyGradient = ctx.createRadialGradient(233, 325, 16, 250, 353, 91);
        bellyGradient.addColorStop(0, '#ffffff');
        bellyGradient.addColorStop(1, '#edf3f6');
        ellipse(ctx, 250, 354, 76, 91 + breathing * 0.3, bellyGradient);

        ctx.save();
        ctx.globalAlpha = 0.25;
        ctx.strokeStyle = '#71808d';
        ctx.lineWidth = 8;
        ctx.lineCap = 'round';
        for (const direction of [-1, 1]) {
            ctx.beginPath();
            ctx.moveTo(250 + direction * 84, 286);
            ctx.quadraticCurveTo(250 + direction * 67, 296, 250 + direction * 58, 315);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(250 + direction * 102, 324);
            ctx.quadraticCurveTo(250 + direction * 78, 330, 250 + direction * 68, 347);
            ctx.stroke();
        }
        ctx.restore();

        // Warm little moon tag: the only warm accent besides Nuoji's eyes.
        ctx.save();
        ctx.strokeStyle = '#b78342';
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(250, 283, 29, 0.18, Math.PI - 0.18);
        ctx.stroke();
        ellipse(ctx, 250, 309, 11, 13, '#d8a95b');
        ellipse(ctx, 255, 305, 7, 10, '#edf3f6');
        ctx.restore();
    }

    drawPaws(ctx, seconds, still) {
        const waving = this.state === PET_STATES.WAVE;
        const petting = this.state === PET_STATES.PETTING;
        const pawGradient = ctx.createLinearGradient(0, 347, 0, 440);
        pawGradient.addColorStop(0, '#d7e0e6');
        pawGradient.addColorStop(1, '#fbfdff');

        const drawPaw = (x, y, rotation = 0, showPads = false) => {
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(rotation);
            ellipse(ctx, 0, 0, 42, 52, pawGradient);
            if (showPads) {
                ellipse(ctx, 0, 11, 12, 14, '#d8a9aa');
                ellipse(ctx, -16, -7, 7, 9, '#e3b7b8');
                ellipse(ctx, 0, -13, 7, 9, '#e3b7b8');
                ellipse(ctx, 16, -7, 7, 9, '#e3b7b8');
            }
            ctx.restore();
        };

        drawPaw(181, 401, -0.1, petting);

        if (waving) {
            const wave = still ? -0.28 : -0.28 + Math.sin(seconds * 8) * 0.24;
            ctx.save();
            ctx.translate(362, 358);
            ctx.rotate(wave);
            ctx.translate(0, -78);
            drawPaw(0, 0, 0.2, true);
            ctx.restore();
        } else {
            drawPaw(319, 401, 0.1, petting);
        }
    }

    drawHead(ctx, seconds, still) {
        const listening = this.state === PET_STATES.LISTENING;
        const confused = this.state === PET_STATES.CONFUSED;
        const earTwitch = still ? 0 : Math.max(0, Math.sin(seconds * 3.1 - 0.4)) * (listening ? 7 : 1.5);
        const leftEarLift = listening ? -8 : 0;
        const rightEarDip = confused ? 12 : 0;

        ctx.save();
        ctx.shadowColor = 'rgba(30, 42, 54, 0.2)';
        ctx.shadowBlur = 15;
        ctx.shadowOffsetY = 7;

        roundedTriangle(
            ctx,
            { x: 162, y: 77 + leftEarLift - earTwitch },
            { x: 132, y: 196 },
            { x: 219, y: 156 },
        );
        ctx.fillStyle = '#b8c3cc';
        ctx.fill();

        roundedTriangle(
            ctx,
            { x: 342, y: 77 + rightEarDip + earTwitch * 0.4 },
            { x: 282, y: 157 },
            { x: 373, y: 196 },
        );
        ctx.fillStyle = '#b8c3cc';
        ctx.fill();
        ctx.restore();

        // Soft pink inner ears.
        ctx.save();
        ctx.globalAlpha = 0.72;
        roundedTriangle(ctx, { x: 164, y: 103 + leftEarLift }, { x: 148, y: 169 }, { x: 198, y: 151 }, 7);
        ctx.fillStyle = '#dcb8b8';
        ctx.fill();
        roundedTriangle(ctx, { x: 340, y: 104 + rightEarDip }, { x: 302, y: 152 }, { x: 358, y: 171 }, 7);
        ctx.fillStyle = '#dcb8b8';
        ctx.fill();
        ctx.restore();

        const headGradient = ctx.createLinearGradient(170, 119, 329, 278);
        headGradient.addColorStop(0, '#f7fafc');
        headGradient.addColorStop(0.58, '#e0e7ec');
        headGradient.addColorStop(1, '#b9c4cd');
        ellipse(ctx, 250, 206, 124, 105, headGradient);

        // Forehead and cheek markings keep the face readable at small sizes.
        ctx.save();
        ctx.strokeStyle = 'rgba(96, 112, 125, 0.43)';
        ctx.lineWidth = 8;
        ctx.lineCap = 'round';
        for (const offset of [-24, 0, 24]) {
            ctx.beginPath();
            ctx.moveTo(250 + offset * 0.58, 121);
            ctx.quadraticCurveTo(250 + offset, 143, 250 + offset * 0.8, 160);
            ctx.stroke();
        }
        for (const direction of [-1, 1]) {
            ctx.beginPath();
            ctx.moveTo(250 + direction * 111, 207);
            ctx.quadraticCurveTo(250 + direction * 85, 211, 250 + direction * 72, 229);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(250 + direction * 106, 232);
            ctx.quadraticCurveTo(250 + direction * 82, 234, 250 + direction * 68, 246);
            ctx.stroke();
        }
        ctx.restore();

        ellipse(ctx, 250, 237, 78, 49, '#f9fbfc');
    }

    drawFace(ctx, seconds, still) {
        const closed = [PET_STATES.HAPPY, PET_STATES.PETTING, PET_STATES.SLEEPING].includes(this.state);
        const blinkCycle = still ? 0 : seconds % 4.8;
        const blinking = !closed && blinkCycle > 4.58;
        const thinking = this.state === PET_STATES.THINKING;
        const confused = this.state === PET_STATES.CONFUSED;
        const listening = this.state === PET_STATES.LISTENING;

        if (closed || blinking) {
            ctx.save();
            ctx.strokeStyle = '#34414d';
            ctx.lineWidth = 8;
            ctx.lineCap = 'round';
            for (const direction of [-1, 1]) {
                ctx.beginPath();
                const y = this.state === PET_STATES.SLEEPING ? 199 : 194;
                ctx.arc(250 + direction * 49, y, 23, 0.2, Math.PI - 0.2, false);
                ctx.stroke();
            }
            ctx.restore();
        } else {
            const eyeRadiusX = listening ? 27 : 25;
            const eyeRadiusY = listening ? 31 : 28;
            const lookX = confused ? -4 : 0;
            const lookY = thinking ? -6 : 1;
            const irisGradient = ctx.createRadialGradient(0, 0, 2, 0, 0, 19);
            irisGradient.addColorStop(0, '#fff1a8');
            irisGradient.addColorStop(0.45, '#d69a38');
            irisGradient.addColorStop(1, '#8a551e');

            for (const direction of [-1, 1]) {
                const x = 250 + direction * 49;
                ellipse(ctx, x, 196, eyeRadiusX, eyeRadiusY, '#f7fbfc');

                ctx.save();
                ctx.translate(x + lookX, 196 + lookY);
                ellipse(ctx, 0, 0, 18, 22, irisGradient);
                ellipse(ctx, 0, 1, 8, 14, '#243039');
                ellipse(ctx, -5, -7, 4.5, 6, 'rgba(255,255,255,0.92)');
                ctx.restore();

                ctx.save();
                ctx.strokeStyle = '#53616d';
                ctx.lineWidth = 5;
                ctx.beginPath();
                ctx.arc(x, 196, eyeRadiusX, Math.PI + 0.18, Math.PI * 2 - 0.18);
                ctx.stroke();
                ctx.restore();
            }
        }

        // Nose, mouth and whiskers.
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(239, 229);
        ctx.quadraticCurveTo(250, 221, 261, 229);
        ctx.quadraticCurveTo(250, 242, 239, 229);
        ctx.fillStyle = '#b77d7d';
        ctx.fill();

        ctx.strokeStyle = '#5b6570';
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(250, 238);
        ctx.lineTo(250, 246);
        ctx.quadraticCurveTo(239, 254, 229, 247);
        ctx.moveTo(250, 246);
        ctx.quadraticCurveTo(261, 254, 271, 247);
        ctx.stroke();

        ctx.globalAlpha = 0.54;
        ctx.lineWidth = 2.6;
        for (const direction of [-1, 1]) {
            for (let row = -1; row <= 1; row += 1) {
                ctx.beginPath();
                ctx.moveTo(250 + direction * 49, 239 + row * 9);
                ctx.quadraticCurveTo(250 + direction * 82, 235 + row * 11, 250 + direction * 111, 231 + row * 14);
                ctx.stroke();
            }
        }
        ctx.restore();

        if ([PET_STATES.HAPPY, PET_STATES.PETTING].includes(this.state)) {
            ctx.save();
            ctx.globalAlpha = 0.36;
            ellipse(ctx, 186, 229, 22, 11, '#ef9da4');
            ellipse(ctx, 314, 229, 22, 11, '#ef9da4');
            ctx.restore();
        }
    }

    drawStateAccents(ctx, seconds, still) {
        if (this.state === PET_STATES.THINKING) {
            const lift = still ? 0 : Math.sin(seconds * 3.2) * 3;
            for (let index = 0; index < 3; index += 1) {
                const alpha = 0.35 + ((index + Math.floor(seconds * 3)) % 3) * 0.24;
                ctx.save();
                ctx.globalAlpha = alpha;
                ellipse(ctx, 344 + index * 22, 109 - index * 12 + lift, 7 + index * 1.5, 7 + index * 1.5, '#d6a457');
                ctx.restore();
            }
        }

        if (this.state === PET_STATES.CONFUSED) {
            ctx.save();
            ctx.translate(356, 116);
            ctx.rotate(0.12);
            ctx.font = '700 55px ui-rounded, system-ui, sans-serif';
            ctx.fillStyle = '#b98543';
            ctx.fillText('?', 0, 0);
            ctx.restore();
        }

        if (this.state === PET_STATES.PETTING) {
            const float = still ? 0 : (seconds * 24) % 18;
            drawHeart(ctx, 151, 131 - float * 0.2, 24, '#e99aa1', -0.2);
            drawHeart(ctx, 355, 113 - float * 0.35, 31, '#e5aa73', 0.18);
            drawHeart(ctx, 382, 154 - float * 0.15, 18, '#e99aa1', 0.12);
        }

        if (this.state === PET_STATES.HAPPY) {
            const sparkle = still ? 1 : 0.72 + Math.sin(seconds * 6) * 0.2;
            ctx.save();
            ctx.globalAlpha = sparkle;
            ctx.fillStyle = '#e2b75d';
            for (const [x, y, size] of [[145, 150, 10], [365, 165, 8], [340, 102, 6]]) {
                ctx.beginPath();
                ctx.moveTo(x, y - size);
                ctx.lineTo(x + size * 0.32, y - size * 0.32);
                ctx.lineTo(x + size, y);
                ctx.lineTo(x + size * 0.32, y + size * 0.32);
                ctx.lineTo(x, y + size);
                ctx.lineTo(x - size * 0.32, y + size * 0.32);
                ctx.lineTo(x - size, y);
                ctx.lineTo(x - size * 0.32, y - size * 0.32);
                ctx.closePath();
                ctx.fill();
            }
            ctx.restore();
        }

        if (this.state === PET_STATES.SLEEPING) {
            const rise = still ? 0 : (seconds * 17) % 30;
            ctx.save();
            ctx.globalAlpha = 0.74;
            ctx.font = '700 28px ui-rounded, system-ui, sans-serif';
            ctx.fillStyle = '#8798a8';
            ctx.fillText('z', 347, 139 - rise * 0.25);
            ctx.font = '700 38px ui-rounded, system-ui, sans-serif';
            ctx.fillText('Z', 372, 112 - rise * 0.45);
            ctx.restore();
        }
    }
}
