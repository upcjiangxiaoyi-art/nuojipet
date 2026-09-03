import { NuojiRenderer, PET_STATES } from './pet-renderer.js';

const MODULE_NAME = 'nuoji_pet';
const DEFAULT_EXTENSION_NAME = 'third-party/nuoji-pet';
const POSITION_MARGIN = 10;
const DRAG_THRESHOLD = 7;
const HIT_ALPHA = 40;
const HIT_RADIUS_TOUCH = 14;
const HIT_RADIUS_MOUSE = 3;
const CLICK_GUARD_DURATION = 900;
const CLICK_GUARD_RADIUS = 36;

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    scale: 100,
    opacity: 100,
    reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    showBubble: true,
    position: {
        x: 0.82,
        y: 0.68,
    },
});

const stateLabels = Object.freeze({
    [PET_STATES.IDLE]: '糯叽正在陪你',
    [PET_STATES.LISTENING]: '糯叽在听',
    [PET_STATES.THINKING]: '糯叽在认真想',
    [PET_STATES.HAPPY]: '糯叽很开心',
    [PET_STATES.CONFUSED]: '糯叽有点迷糊',
    [PET_STATES.PETTING]: '糯叽被摸摸了',
    [PET_STATES.SLEEPING]: '糯叽睡着了',
    [PET_STATES.WAVE]: '糯叽在挥爪',
});

let context;
let settings;
let renderer;
let ui;
let initializePromise;
let reactionTimer;
let bubbleTimer;
let positionFrame;
let hoverFrame;
let bootTimer;
let settingsLayerFrame;
let settingsLayerTimer;
let currentPriority = 0;
let priorityUntil = 0;
let isGenerating = false;
let publicApi;
let clickGuard;

const cleanups = [];

function on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
}

function onEventSource(source, eventType, handler) {
    source.on(eventType, handler);
    cleanups.push(() => {
        if (typeof source.off === 'function') {
            source.off(eventType, handler);
        } else {
            source.removeListener?.(eventType, handler);
        }
    });
}

const drag = {
    active: false,
    moved: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    startLeft: 0,
    startTop: 0,
};

function cloneDefaults() {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
}

function finiteNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function inferExtensionName() {
    try {
        const pathname = decodeURIComponent(new URL(import.meta.url).pathname);
        const marker = '/scripts/extensions/';
        const markerIndex = pathname.indexOf(marker);
        if (markerIndex === -1) {
            return DEFAULT_EXTENSION_NAME;
        }

        const relativePath = pathname.slice(markerIndex + marker.length);
        return relativePath.replace(/\/index\.js(?:\?.*)?$/, '');
    } catch {
        return DEFAULT_EXTENSION_NAME;
    }
}

function getSettings() {
    const { extensionSettings } = context;

    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = cloneDefaults();
    }

    const stored = extensionSettings[MODULE_NAME];
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(stored, key)) {
            stored[key] = cloneDefaults()[key];
        }
    }

    stored.position = {
        ...DEFAULT_SETTINGS.position,
        ...(stored.position ?? {}),
    };

    stored.scale = clamp(finiteNumber(stored.scale, DEFAULT_SETTINGS.scale), 70, 150);
    stored.opacity = clamp(finiteNumber(stored.opacity, DEFAULT_SETTINGS.opacity), 40, 100);
    stored.position.x = clamp(finiteNumber(stored.position.x, DEFAULT_SETTINGS.position.x), 0, 1);
    stored.position.y = clamp(finiteNumber(stored.position.y, DEFAULT_SETTINGS.position.y), 0, 1);

    return stored;
}

function saveSettings() {
    context?.saveSettingsDebounced?.();
}

function createPetUi() {
    const existing = document.getElementById('nuoji-pet-root');
    existing?.remove();

    const root = document.createElement('div');
    root.id = 'nuoji-pet-root';
    root.className = 'nuoji-pet-root';
    root.setAttribute('role', 'button');
    root.setAttribute('tabindex', '0');
    root.setAttribute('aria-label', stateLabels[PET_STATES.IDLE]);
    root.innerHTML = `
        <div class="nuoji-speech" aria-live="polite"></div>
        <canvas class="nuoji-canvas" width="500" height="500" aria-hidden="true"></canvas>
        <span class="nuoji-drag-hint" aria-hidden="true">拖动我 · 点我摸摸</span>
    `;

    document.body.append(root);

    const canvas = root.querySelector('.nuoji-canvas');
    const bubble = root.querySelector('.nuoji-speech');
    const hint = root.querySelector('.nuoji-drag-hint');

    // The root itself is click-through. A document-level capture listener only
    // claims input that lands on Nuoji's painted pixels.
    on(document, 'pointerdown', handlePointerDown, { capture: true });
    on(document, 'click', handleClickGuard, { capture: true });
    on(document, 'touchstart', handleTouchStartGuard, { capture: true, passive: false });
    on(document, 'pointermove', handlePointerMove, { capture: true, passive: false });
    on(document, 'pointerup', handlePointerUp, { capture: true });
    on(document, 'pointercancel', handlePointerCancel, { capture: true });
    on(document, 'pointermove', handleHoverHint, { passive: true });
    on(root, 'keydown', handlePetKeydown);

    return { root, canvas, bubble, hint };
}

function hitsNuoji(clientX, clientY, pointerType = 'mouse') {
    if (!ui?.root || !renderer?.ctx || !settings?.enabled) {
        return false;
    }

    const rect = ui.root.getBoundingClientRect();
    if (
        clientX < rect.left
        || clientX > rect.right
        || clientY < rect.top
        || clientY > rect.bottom
        || rect.width <= 0
    ) {
        return false;
    }

    const radius = pointerType === 'mouse' ? HIT_RADIUS_MOUSE : HIT_RADIUS_TOUCH;
    const toCanvas = ui.canvas.width / rect.width;
    const centerX = (clientX - rect.left) * toCanvas;
    const centerY = (clientY - rect.top) * toCanvas;
    const sampleRadius = Math.max(1, Math.round(radius * toCanvas));
    const x = clamp(Math.round(centerX - sampleRadius), 0, ui.canvas.width - 1);
    const y = clamp(Math.round(centerY - sampleRadius), 0, ui.canvas.height - 1);
    const width = Math.min(ui.canvas.width - x, sampleRadius * 2 + 1);
    const height = Math.min(ui.canvas.height - y, sampleRadius * 2 + 1);

    try {
        const pixels = renderer.ctx.getImageData(x, y, width, height).data;
        for (let index = 3; index < pixels.length; index += 4) {
            if (pixels[index] > HIT_ALPHA) {
                return true;
            }
        }
    } catch (error) {
        console.warn('[Nuoji Pet] Pixel hit test failed; using the pet box.', error);
        return true;
    }

    return false;
}

function handleTouchStartGuard(event) {
    if (!drag.active) {
        return;
    }

    event.stopImmediatePropagation();
    event.preventDefault();
}

function handleHoverHint(event) {
    if (event.pointerType !== 'mouse' || drag.active) {
        return;
    }

    window.cancelAnimationFrame(hoverFrame);
    hoverFrame = window.requestAnimationFrame(() => {
        ui?.root.classList.toggle('is-hover', hitsNuoji(event.clientX, event.clientY, 'mouse'));
    });
}

function armClickGuard(event) {
    clickGuard = {
        x: event.clientX,
        y: event.clientY,
        expiresAt: performance.now() + CLICK_GUARD_DURATION,
    };
}

function handleClickGuard(event) {
    if (!clickGuard) {
        return;
    }

    const isFresh = performance.now() <= clickGuard.expiresAt;
    const isNearby = Math.hypot(event.clientX - clickGuard.x, event.clientY - clickGuard.y) <= CLICK_GUARD_RADIUS;
    clickGuard = undefined;

    if (isFresh && isNearby) {
        event.stopImmediatePropagation();
        event.preventDefault();
    }
}

async function createSettingsUi() {
    if (document.getElementById('nuoji-settings')) {
        return;
    }

    const settingsHost = document.querySelector('#extensions_settings2, #extensions_settings');
    if (!settingsHost) {
        console.warn('[Nuoji Pet] Could not find the extensions settings panel.');
        return;
    }

    let html;
    try {
        const extensionName = inferExtensionName();
        html = await context.renderExtensionTemplateAsync(extensionName, 'settings');
    } catch (error) {
        console.warn('[Nuoji Pet] Template renderer failed; using direct template fetch.', error);
        const response = await fetch(new URL('./settings.html', import.meta.url));
        if (!response.ok) {
            throw new Error(`Unable to load settings.html (${response.status})`);
        }
        html = await response.text();
    }

    settingsHost.insertAdjacentHTML('beforeend', html);
    bindSettingsControls();
    syncSettingsControls();
    bindSettingsPreviewLayer();
}

function settingsPanelIsVisible() {
    const panel = document.getElementById('nuoji-settings');
    const content = panel?.querySelector('.inline-drawer-content');
    if (!content) {
        return false;
    }

    const styles = window.getComputedStyle(content);
    const rect = content.getBoundingClientRect();
    const viewport = viewportBox();
    const viewportRight = viewport.left + viewport.width;
    const viewportBottom = viewport.top + viewport.height;
    const intersectsViewport = (
        rect.right > viewport.left
        && rect.left < viewportRight
        && rect.bottom > viewport.top
        && rect.top < viewportBottom
    );

    return (
        styles.display !== 'none'
        && styles.visibility !== 'hidden'
        && styles.opacity !== '0'
        && rect.width > 1
        && rect.height > 1
        && intersectsViewport
    );
}

function syncSettingsPreviewLayer() {
    ui?.root?.classList.toggle('is-settings-preview', settingsPanelIsVisible());
}

function scheduleSettingsPreviewLayer() {
    window.cancelAnimationFrame(settingsLayerFrame);
    window.clearTimeout(settingsLayerTimer);
    settingsLayerFrame = window.requestAnimationFrame(syncSettingsPreviewLayer);
    settingsLayerTimer = window.setTimeout(syncSettingsPreviewLayer, 320);
}

function bindSettingsPreviewLayer() {
    on(document, 'click', scheduleSettingsPreviewLayer, { capture: true });
    on(document, 'keydown', scheduleSettingsPreviewLayer, { capture: true });
    on(document, 'scroll', scheduleSettingsPreviewLayer, { capture: true, passive: true });
    scheduleSettingsPreviewLayer();
}

function bindSettingsControls() {
    const enabled = document.getElementById('nuoji-enabled');
    const scale = document.getElementById('nuoji-scale');
    const opacity = document.getElementById('nuoji-opacity');
    const reducedMotion = document.getElementById('nuoji-reduced-motion');
    const showBubble = document.getElementById('nuoji-show-bubble');
    const resetPosition = document.getElementById('nuoji-reset-position');

    if (enabled) {
        on(enabled, 'change', (event) => {
            settings.enabled = event.currentTarget.checked;
            applyVisualSettings();
            saveSettings();
        });
    }

    if (scale) {
        on(scale, 'input', (event) => {
            settings.scale = clamp(Number(event.currentTarget.value), 70, 150);
            applyVisualSettings({ reposition: true });
            syncSettingsControls();
            saveSettings();
        });
    }

    if (opacity) {
        on(opacity, 'input', (event) => {
            settings.opacity = clamp(Number(event.currentTarget.value), 40, 100);
            applyVisualSettings();
            syncSettingsControls();
            saveSettings();
        });
    }

    if (reducedMotion) {
        on(reducedMotion, 'change', (event) => {
            settings.reducedMotion = event.currentTarget.checked;
            renderer?.setReducedMotion(settings.reducedMotion);
            saveSettings();
        });
    }

    if (showBubble) {
        on(showBubble, 'change', (event) => {
            settings.showBubble = event.currentTarget.checked;
            if (!settings.showBubble) {
                hideBubble();
            }
            saveSettings();
        });
    }

    if (resetPosition) {
        on(resetPosition, 'click', () => {
            settings.position = { ...DEFAULT_SETTINGS.position };
            applyStoredPosition();
            transitionTo(PET_STATES.WAVE, {
                duration: 1500,
                bubble: '我回来啦～',
                priority: 30,
                force: true,
            });
            saveSettings();
        });
    }

    document.querySelectorAll('[data-nuoji-preview]').forEach((button) => {
        on(button, 'click', () => {
            const state = button.dataset.nuojiPreview;
            if (!Object.values(PET_STATES).includes(state)) {
                return;
            }

            transitionTo(state, {
                duration: state === PET_STATES.SLEEPING ? 3000 : 1800,
                bubble: previewBubbleFor(state),
                priority: 35,
                force: true,
            });
        });
    });
}

function syncSettingsControls() {
    const enabled = document.getElementById('nuoji-enabled');
    const scale = document.getElementById('nuoji-scale');
    const scaleValue = document.getElementById('nuoji-scale-value');
    const opacity = document.getElementById('nuoji-opacity');
    const opacityValue = document.getElementById('nuoji-opacity-value');
    const reducedMotion = document.getElementById('nuoji-reduced-motion');
    const showBubble = document.getElementById('nuoji-show-bubble');

    if (enabled) enabled.checked = Boolean(settings.enabled);
    if (scale) scale.value = String(settings.scale);
    if (scaleValue) scaleValue.textContent = `${settings.scale}%`;
    if (opacity) opacity.value = String(settings.opacity);
    if (opacityValue) opacityValue.textContent = `${settings.opacity}%`;
    if (reducedMotion) reducedMotion.checked = Boolean(settings.reducedMotion);
    if (showBubble) showBubble.checked = Boolean(settings.showBubble);
}

function previewBubbleFor(state) {
    const bubbles = {
        [PET_STATES.IDLE]: '陪着你呀',
        [PET_STATES.LISTENING]: '嗯嗯，我在听',
        [PET_STATES.THINKING]: '让我想想…',
        [PET_STATES.HAPPY]: '好耶！',
        [PET_STATES.CONFUSED]: '欸？',
        [PET_STATES.PETTING]: '呼噜呼噜～',
        [PET_STATES.SLEEPING]: '困嘟嘟…',
        [PET_STATES.WAVE]: '小狐狸回来啦！',
    };
    return bubbles[state] ?? '';
}

function applyVisualSettings({ reposition = false } = {}) {
    if (!ui?.root) {
        return;
    }

    ui.root.classList.toggle('is-disabled', !settings.enabled);
    if (settings.enabled) {
        renderer?.start();
    } else {
        renderer?.stop();
        hideBubble();
        window.clearTimeout(reactionTimer);
    }
    ui.root.style.setProperty('--nuoji-scale', String(settings.scale / 100));
    ui.root.style.setProperty('--nuoji-opacity', String(settings.opacity / 100));
    renderer?.setReducedMotion(settings.reducedMotion);
    scheduleSettingsPreviewLayer();

    if (reposition) {
        window.cancelAnimationFrame(positionFrame);
        positionFrame = window.requestAnimationFrame(applyStoredPosition);
    }
}

function viewportBox() {
    const visualViewport = window.visualViewport;
    if (visualViewport) {
        return {
            left: visualViewport.offsetLeft,
            top: visualViewport.offsetTop,
            width: visualViewport.width,
            height: visualViewport.height,
        };
    }

    return {
        left: 0,
        top: 0,
        width: document.documentElement.clientWidth || window.innerWidth,
        height: document.documentElement.clientHeight || window.innerHeight,
    };
}

function movementBounds() {
    const viewport = viewportBox();
    const rect = ui.root.getBoundingClientRect();
    const styles = window.getComputedStyle(ui.root);
    const safeTop = Number.parseFloat(styles.getPropertyValue('--nuoji-safe-top')) || 0;
    const safeRight = Number.parseFloat(styles.getPropertyValue('--nuoji-safe-right')) || 0;
    const safeBottom = Number.parseFloat(styles.getPropertyValue('--nuoji-safe-bottom')) || 0;
    const safeLeft = Number.parseFloat(styles.getPropertyValue('--nuoji-safe-left')) || 0;
    const minimumLeft = viewport.left + POSITION_MARGIN + safeLeft;
    const minimumTop = viewport.top + POSITION_MARGIN + safeTop;
    const maximumLeft = Math.max(
        minimumLeft,
        viewport.left + viewport.width - rect.width - POSITION_MARGIN - safeRight,
    );
    const maximumTop = Math.max(
        minimumTop,
        viewport.top + viewport.height - rect.height - POSITION_MARGIN - safeBottom,
    );

    return {
        minimumLeft,
        minimumTop,
        maximumLeft,
        maximumTop,
    };
}

function setPixelPosition(left, top) {
    const bounds = movementBounds();
    ui.root.style.left = `${clamp(left, bounds.minimumLeft, bounds.maximumLeft)}px`;
    ui.root.style.top = `${clamp(top, bounds.minimumTop, bounds.maximumTop)}px`;
}

function applyStoredPosition() {
    if (!ui?.root) {
        return;
    }

    const bounds = movementBounds();
    const horizontalRange = Math.max(0, bounds.maximumLeft - bounds.minimumLeft);
    const verticalRange = Math.max(0, bounds.maximumTop - bounds.minimumTop);
    const left = bounds.minimumLeft + horizontalRange * clamp(settings.position.x, 0, 1);
    const top = bounds.minimumTop + verticalRange * clamp(settings.position.y, 0, 1);
    setPixelPosition(left, top);
}

function rememberCurrentPosition() {
    const bounds = movementBounds();
    const rect = ui.root.getBoundingClientRect();
    const horizontalRange = Math.max(1, bounds.maximumLeft - bounds.minimumLeft);
    const verticalRange = Math.max(1, bounds.maximumTop - bounds.minimumTop);

    settings.position = {
        x: clamp((rect.left - bounds.minimumLeft) / horizontalRange, 0, 1),
        y: clamp((rect.top - bounds.minimumTop) / verticalRange, 0, 1),
    };
    saveSettings();
}

function handlePointerDown(event) {
    // A deliberate new pointer action must never inherit an old synthetic-click guard.
    clickGuard = undefined;
    if (event.button !== undefined && event.button !== 0) {
        return;
    }
    if (
        drag.active
        || !event.isPrimary
        || !hitsNuoji(event.clientX, event.clientY, event.pointerType || 'mouse')
    ) {
        return;
    }

    event.stopImmediatePropagation();
    const rect = ui.root.getBoundingClientRect();
    drag.active = true;
    drag.moved = false;
    drag.pointerId = event.pointerId;
    drag.startX = event.clientX;
    drag.startY = event.clientY;
    drag.startLeft = rect.left;
    drag.startTop = rect.top;
    ui.root.classList.add('is-pressed');
    armClickGuard(event);
    event.preventDefault();
}

function handlePointerMove(event) {
    if (!drag.active || event.pointerId !== drag.pointerId) {
        return;
    }

    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) >= DRAG_THRESHOLD) {
        drag.moved = true;
        ui.root.classList.add('is-dragging');
        transitionTo(PET_STATES.LISTENING, {
            bubble: '带我去哪呀？',
            priority: 45,
            force: true,
        });
    }

    if (drag.moved) {
        setPixelPosition(drag.startLeft + deltaX, drag.startTop + deltaY);
    }

    event.stopImmediatePropagation();
    event.preventDefault();
}

function handlePointerUp(event) {
    if (!drag.active || event.pointerId !== drag.pointerId) {
        return;
    }

    event.stopImmediatePropagation();
    event.preventDefault();
    armClickGuard(event);
    const wasDragged = drag.moved;
    finishPointerInteraction();

    if (wasDragged) {
        rememberCurrentPosition();
        transitionTo(PET_STATES.WAVE, {
            duration: 1100,
            bubble: '这里可以！',
            priority: 35,
            force: true,
        });
    } else {
        petNuoji();
    }
}

function handlePointerCancel(event) {
    if (!drag.active || event.pointerId !== drag.pointerId) {
        return;
    }

    event.stopImmediatePropagation();
    event.preventDefault();
    armClickGuard(event);
    const wasDragged = drag.moved;
    finishPointerInteraction();
    if (wasDragged) {
        rememberCurrentPosition();
    }
    returnToAmbient();
}

function finishPointerInteraction() {
    ui.root.classList.remove('is-pressed', 'is-dragging');
    drag.active = false;
    drag.moved = false;
    drag.pointerId = null;
}

function handlePetKeydown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') {
        return;
    }

    event.preventDefault();
    petNuoji();
}

function petNuoji() {
    transitionTo(PET_STATES.PETTING, {
        duration: 1900,
        bubble: '呼噜呼噜～',
        priority: 40,
        force: true,
    });
}

function transitionTo(state, {
    duration = 0,
    bubble = '',
    priority = 0,
    force = false,
} = {}) {
    if (!renderer || !Object.values(PET_STATES).includes(state)) {
        return;
    }

    const now = Date.now();
    if (!force && priority < currentPriority && now < priorityUntil) {
        return;
    }

    window.clearTimeout(reactionTimer);
    currentPriority = priority;
    priorityUntil = duration > 0 ? now + duration : Number.POSITIVE_INFINITY;
    renderer.setState(state);
    ui.root.setAttribute('aria-label', stateLabels[state] ?? stateLabels[PET_STATES.IDLE]);

    if (bubble) {
        showBubble(bubble, Math.min(Math.max(duration || 1600, 1000), 2200));
    }

    if (duration > 0) {
        reactionTimer = window.setTimeout(returnToAmbient, duration);
    }
}

function returnToAmbient() {
    window.clearTimeout(reactionTimer);
    currentPriority = 0;
    priorityUntil = 0;

    const ambientState = isGenerating ? PET_STATES.THINKING : PET_STATES.IDLE;
    renderer?.setState(ambientState);
    ui?.root.setAttribute('aria-label', stateLabels[ambientState]);

    if (!isGenerating) {
        hideBubble();
    }
}

function showBubble(message, duration = 1500) {
    if (!ui?.bubble || !settings.showBubble || !message) {
        return;
    }

    window.clearTimeout(bubbleTimer);
    ui.bubble.textContent = message;
    ui.bubble.classList.add('is-visible');
    bubbleTimer = window.setTimeout(hideBubble, duration);
}

function hideBubble() {
    window.clearTimeout(bubbleTimer);
    ui?.bubble.classList.remove('is-visible');
}

function listen(eventName, handler) {
    const eventType = context.event_types?.[eventName];
    if (!eventType) {
        return;
    }

    onEventSource(context.eventSource, eventType, handler);
}

function bindSillyTavernEvents() {
    listen('MESSAGE_SENT', () => {
        transitionTo(PET_STATES.LISTENING, {
            duration: 1200,
            bubble: '嗯嗯，我在听',
            priority: 25,
            force: true,
        });
    });

    listen('GENERATION_STARTED', () => {
        isGenerating = true;
        transitionTo(PET_STATES.THINKING, {
            bubble: '让我想想…',
            priority: 20,
            force: true,
        });
    });

    listen('STREAM_TOKEN_RECEIVED', () => {
        renderer?.pulse();
    });

    listen('MESSAGE_RECEIVED', () => {
        isGenerating = false;
        transitionTo(PET_STATES.HAPPY, {
            duration: 2100,
            bubble: '回信来啦！',
            priority: 35,
            force: true,
        });
    });

    listen('CHARACTER_MESSAGE_RENDERED', () => {
        if (renderer?.state === PET_STATES.THINKING) {
            isGenerating = false;
            transitionTo(PET_STATES.HAPPY, {
                duration: 1800,
                bubble: '好耶！',
                priority: 35,
                force: true,
            });
        }
    });

    listen('GENERATION_STOPPED', () => {
        isGenerating = false;
        transitionTo(PET_STATES.CONFUSED, {
            duration: 1900,
            bubble: '停在这里嘛？',
            priority: 35,
            force: true,
        });
    });

    listen('GENERATION_ENDED', () => {
        isGenerating = false;
        if (renderer?.state === PET_STATES.THINKING) {
            transitionTo(PET_STATES.CONFUSED, {
                duration: 1500,
                bubble: '欸，结束啦？',
                priority: 25,
                force: true,
            });
        }
    });

    listen('CHAT_CHANGED', () => {
        isGenerating = false;
        transitionTo(PET_STATES.WAVE, {
            duration: 1700,
            bubble: '我也跟过来啦！',
            priority: 30,
            force: true,
        });
    });
}

function bindViewportEvents() {
    const scheduleReposition = () => {
        window.cancelAnimationFrame(positionFrame);
        positionFrame = window.requestAnimationFrame(applyStoredPosition);
        scheduleSettingsPreviewLayer();
    };

    on(window, 'resize', scheduleReposition, { passive: true });
    if (window.visualViewport) {
        on(window.visualViewport, 'resize', scheduleReposition, { passive: true });
        on(window.visualViewport, 'scroll', scheduleReposition, { passive: true });
    }
}

function bindCustomReactionEvent() {
    on(window, 'nuoji:react', (event) => {
        const state = event.detail?.state;
        if (!Object.values(PET_STATES).includes(state)) {
            return;
        }

        transitionTo(state, {
            duration: clamp(Number(event.detail?.duration) || 1800, 300, 10000),
            bubble: String(event.detail?.message ?? ''),
            priority: 30,
            force: true,
        });
    });
}

export function destroy() {
    while (cleanups.length) {
        try {
            cleanups.pop()();
        } catch (error) {
            console.warn('[Nuoji Pet] Cleanup failed.', error);
        }
    }

    window.clearTimeout(bootTimer);
    window.clearTimeout(reactionTimer);
    window.clearTimeout(bubbleTimer);
    window.cancelAnimationFrame(positionFrame);
    window.cancelAnimationFrame(hoverFrame);
    window.cancelAnimationFrame(settingsLayerFrame);
    window.clearTimeout(settingsLayerTimer);
    renderer?.destroy();
    ui?.root?.remove();
    document.getElementById('nuoji-settings')?.remove();

    if (window.NuojiPet === publicApi) {
        delete window.NuojiPet;
    }

    context = undefined;
    settings = undefined;
    renderer = undefined;
    ui = undefined;
    initializePromise = undefined;
    reactionTimer = undefined;
    bubbleTimer = undefined;
    positionFrame = undefined;
    hoverFrame = undefined;
    bootTimer = undefined;
    settingsLayerFrame = undefined;
    settingsLayerTimer = undefined;
    currentPriority = 0;
    priorityUntil = 0;
    isGenerating = false;
    publicApi = undefined;
    clickGuard = undefined;
    drag.active = false;
    drag.moved = false;
    drag.pointerId = null;
}

export function onDisable() {
    destroy();
}

async function initialize() {
    if (initializePromise) {
        return initializePromise;
    }

    initializePromise = (async () => {
        const previousApi = window.NuojiPet;
        if (typeof previousApi?.destroy === 'function' && previousApi.destroy !== destroy) {
            previousApi.destroy();
        }
        if (ui || renderer) {
            destroy();
        }

        context = SillyTavern.getContext();
        settings = getSettings();
        ui = createPetUi();
        renderer = new NuojiRenderer(ui.canvas);
        renderer.setReducedMotion(settings.reducedMotion);
        renderer.start();

        applyVisualSettings();
        applyStoredPosition();
        await createSettingsUi();
        bindSillyTavernEvents();
        bindViewportEvents();
        bindCustomReactionEvent();

        transitionTo(PET_STATES.WAVE, {
            duration: 1800,
            bubble: '小狐狸，我来啦～',
            priority: 30,
            force: true,
        });

        // A tiny debug/integration surface for future affection and feeding modules.
        publicApi = Object.freeze({
            states: PET_STATES,
            destroy,
            react(state, message = '', duration = 1800) {
                window.dispatchEvent(new CustomEvent('nuoji:react', {
                    detail: { state, message, duration },
                }));
            },
        });
        window.NuojiPet = publicApi;

        console.info('[Nuoji Pet] 糯叽已就位。');
    })().catch((error) => {
        destroy();
        console.error('[Nuoji Pet] Initialization failed.', error);
        throw error;
    });

    return initializePromise;
}

function scheduleInitialize() {
    window.clearTimeout(bootTimer);
    bootTimer = window.setTimeout(() => {
        bootTimer = undefined;
        void initialize();
    }, 0);
}

function boot() {
    try {
        const initialContext = SillyTavern.getContext();
        const appReady = initialContext.event_types?.APP_READY;

        if (appReady) {
            // APP_READY auto-fires for late subscribers. Defer so we do not hold up ST's loader.
            onEventSource(initialContext.eventSource, appReady, scheduleInitialize);
        } else {
            scheduleInitialize();
        }
    } catch (error) {
        console.error('[Nuoji Pet] Could not attach to SillyTavern.', error);
    }
}

if (document.readyState === 'loading') {
    on(document, 'DOMContentLoaded', boot, { once: true });
} else {
    boot();
}
