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
const DOUBLE_TAP_WINDOW = 320;
const DOUBLE_TAP_RADIUS = 42;
const LONG_PRESS_DURATION = 600;
const TYPING_IDLE_DELAY = 3000;
const THINKING_COMPANION_DELAY = 20000;
const AUTO_LIE_DELAY = 28000;
const AUTO_WALK_MIN_DELAY = 42000;
const AUTO_WALK_JITTER = 36000;
const WALK_MIN_DISTANCE = 52;
const WALK_MAX_DISTANCE = 92;
const WALK_DURATION = 2300;
const GENERATION_SETTLE_DELAY = 520;
const SEND_BUTTON_SELECTOR = '#send_but';
const STOP_BUTTON_SELECTOR = '#mes_stop';

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
let coreApi;
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
let generationWatchdog;
let generationFinishTimer;
let chatActivityFrame;
let chatObserver;
let generationControlFrame;
let generationControlObserver;
let generationControlActive = false;
let generationWasManuallyStopped = false;
let observedChatLength = 0;
let lastSignalStatus = '待命，等你发消息';
let currentPriority = 0;
let priorityUntil = 0;
let isGenerating = false;
let publicApi;
let clickGuard;
let longPressTimer;
let pendingTap;
let typingIdleTimer;
let typingAttentionActive = false;
let thinkingBubble20Timer;
let thinkingBubble40Timer;
let thinkingCompanionMessage = '让我想想…';
let poseTimer;
let roamTimer;
let roamFrame;
let roamRun;

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
    longPress: false,
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
        <span class="nuoji-drag-hint" aria-hidden="true">拖动 · 点摸摸 · 长按抱抱</span>
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
    on(document, 'contextmenu', handleContextMenuGuard, { capture: true });
    on(document, 'pointermove', handleHoverHint, { passive: true });
    on(document, 'input', handleTypingInput, { capture: true, passive: true });
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
    const isPreviewing = settingsPanelIsVisible();
    ui?.root?.classList.toggle('is-settings-preview', isPreviewing);
    renderer?.setSettingsPreviewMode(isPreviewing);
}

function scheduleSettingsPreviewLayer() {
    window.cancelAnimationFrame(settingsLayerFrame);
    window.clearTimeout(settingsLayerTimer);
    window.clearTimeout(generationEndTimer);
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
    const previewWalk = document.getElementById('nuoji-preview-walk');

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
            } else if (isGenerating) {
                showBubble('让我想想…', 0);
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

    if (previewWalk) {
        on(previewWalk, 'click', () => {
            startAutoWalk(0, 1900, { announce: true });
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
        if (renderer?.state === PET_STATES.IDLE) {
            scheduleAutoLie();
            scheduleAutoWalk();
        }
    } else {
        renderer?.stop();
        clearPoseTimer();
        cancelAutoWalk({ settle: false });
        clearAutoWalkTimer();
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
    wakeNuoji();
    const rect = ui.root.getBoundingClientRect();
    drag.active = true;
    drag.moved = false;
    drag.pointerId = event.pointerId;
    drag.startX = event.clientX;
    drag.startY = event.clientY;
    drag.startLeft = rect.left;
    drag.startTop = rect.top;
    drag.longPress = false;
    ui.root.classList.add('is-pressed');
    scheduleLongPress();
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
        clearLongPressTimer();
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
    const wasLongPress = drag.longPress;
    const tapX = event.clientX;
    const tapY = event.clientY;
    finishPointerInteraction();

    if (wasDragged) {
        rememberCurrentPosition();
        transitionTo(PET_STATES.WAVE, {
            duration: 1100,
            bubble: '这里可以！',
            priority: 35,
            force: true,
        });
    } else if (wasLongPress) {
        returnToAmbient();
    } else {
        registerTap(tapX, tapY);
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
    const wasLongPress = drag.longPress;
    finishPointerInteraction();
    if (wasDragged) {
        rememberCurrentPosition();
    }
    if (wasDragged || wasLongPress) {
        returnToAmbient();
    }
}

function finishPointerInteraction() {
    clearLongPressTimer();
    ui.root.classList.remove('is-pressed', 'is-dragging');
    drag.active = false;
    drag.moved = false;
    drag.pointerId = null;
    drag.longPress = false;
}

function clearLongPressTimer() {
    window.clearTimeout(longPressTimer);
    longPressTimer = undefined;
}

function scheduleLongPress() {
    clearLongPressTimer();
    longPressTimer = window.setTimeout(() => {
        longPressTimer = undefined;
        if (!drag.active || drag.moved) {
            return;
        }

        drag.longPress = true;
        transitionTo(PET_STATES.PETTING, {
            bubble: '呼噜呼噜呼噜～',
            priority: 55,
            force: true,
        });
    }, LONG_PRESS_DURATION);
}

function clearPendingTap() {
    window.clearTimeout(pendingTap?.timer);
    pendingTap = undefined;
}

function registerTap(clientX, clientY) {
    const now = Date.now();
    if (
        pendingTap
        && now - pendingTap.time <= DOUBLE_TAP_WINDOW
        && Math.hypot(clientX - pendingTap.x, clientY - pendingTap.y) <= DOUBLE_TAP_RADIUS
    ) {
        clearPendingTap();
        doublePetNuoji();
        return;
    }

    clearPendingTap();
    const tap = { time: now, x: clientX, y: clientY, timer: undefined };
    tap.timer = window.setTimeout(() => {
        if (pendingTap === tap) {
            pendingTap = undefined;
            petNuoji();
        }
    }, DOUBLE_TAP_WINDOW);
    pendingTap = tap;
}

function doublePetNuoji() {
    transitionTo(PET_STATES.HAPPY, {
        duration: 2200,
        bubble: '翻个软乎乎的小肚皮～',
        priority: 48,
        force: true,
    });
}

function handleContextMenuGuard(event) {
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) {
        return;
    }
    if (!drag.active && !hitsNuoji(event.clientX, event.clientY, 'touch')) {
        return;
    }
    event.stopImmediatePropagation();
    event.preventDefault();
}

function isSendTextarea(target) {
    return target?.id === 'send_textarea' || target?.matches?.('#send_textarea');
}

function clearTypingAttention({ restore = false } = {}) {
    window.clearTimeout(typingIdleTimer);
    typingIdleTimer = undefined;
    const wasActive = typingAttentionActive;
    typingAttentionActive = false;
    if (restore && wasActive && !isGenerating && !drag.active) {
        returnToAmbient();
    }
}

function handleTypingInput(event) {
    if (!isSendTextarea(event.target)) {
        return;
    }

    const hasText = String(event.target.value ?? '').trim().length > 0;
    if (!hasText) {
        clearTypingAttention({ restore: true });
        return;
    }
    if (isGenerating || drag.longPress) {
        return;
    }

    const firstKeystroke = !typingAttentionActive;
    typingAttentionActive = true;
    window.clearTimeout(typingIdleTimer);
    if (firstKeystroke || renderer?.state !== PET_STATES.LISTENING) {
        transitionTo(PET_STATES.LISTENING, {
            priority: 22,
            force: true,
        });
    }
    if (firstKeystroke) {
        showBubble('我在看你写～', 1400);
    }
    typingIdleTimer = window.setTimeout(() => {
        typingIdleTimer = undefined;
        typingAttentionActive = false;
        if (!isGenerating && !drag.active) {
            returnToAmbient();
        }
    }, TYPING_IDLE_DELAY);
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

function clearPoseTimer() {
    window.clearTimeout(poseTimer);
    poseTimer = undefined;
}

function clearAutoWalkTimer() {
    window.clearTimeout(roamTimer);
    roamTimer = undefined;
}

function cancelAutoWalk({ settle = true, remember = true } = {}) {
    window.cancelAnimationFrame(roamFrame);
    roamFrame = undefined;
    const wasWalking = Boolean(roamRun);
    roamRun = undefined;
    if (wasWalking && remember && ui?.root && settings) {
        rememberCurrentPosition();
    }
    if (wasWalking && settle) {
        renderer?.setForm('sitting');
    }
}

function wakeNuoji() {
    clearPoseTimer();
    clearAutoWalkTimer();
    cancelAutoWalk({ settle: false });
    renderer?.setForm('sitting');
}

function scheduleAutoLie() {
    clearPoseTimer();
    if (isGenerating || typingAttentionActive || drag.active || !settings?.enabled) {
        return;
    }
    poseTimer = window.setTimeout(() => {
        poseTimer = undefined;
        if (isGenerating || typingAttentionActive || drag.active || renderer?.state !== PET_STATES.IDLE) {
            return;
        }
        renderer.setForm('lying');
        showBubble('趴一会儿陪你～', 1600);
    }, AUTO_LIE_DELAY);
}

function scheduleAutoWalk() {
    clearAutoWalkTimer();
    if (
        isGenerating
        || typingAttentionActive
        || drag.active
        || roamRun
        || !settings?.enabled
        || settings.reducedMotion
    ) {
        return;
    }
    const delay = AUTO_WALK_MIN_DELAY + Math.random() * AUTO_WALK_JITTER;
    roamTimer = window.setTimeout(() => {
        roamTimer = undefined;
        startAutoWalk();
    }, delay);
}

function chooseWalkTarget(preferredDirection = 0) {
    const bounds = movementBounds();
    const rect = ui.root.getBoundingClientRect();
    const startLeft = clamp(
        finiteNumber(Number.parseFloat(ui.root.style.left), rect.left),
        bounds.minimumLeft,
        bounds.maximumLeft,
    );
    const startTop = clamp(
        finiteNumber(Number.parseFloat(ui.root.style.top), rect.top),
        bounds.minimumTop,
        bounds.maximumTop,
    );
    const roomLeft = startLeft - bounds.minimumLeft;
    const roomRight = bounds.maximumLeft - startLeft;
    let direction = Math.sign(preferredDirection);

    if (!direction) {
        if (roomLeft < WALK_MIN_DISTANCE && roomRight < WALK_MIN_DISTANCE) {
            direction = roomRight >= roomLeft ? 1 : -1;
        } else if (roomLeft < WALK_MIN_DISTANCE) {
            direction = 1;
        } else if (roomRight < WALK_MIN_DISTANCE) {
            direction = -1;
        } else {
            direction = Math.random() < 0.5 ? -1 : 1;
        }
    }
    if (direction < 0 && roomLeft < Math.min(WALK_MIN_DISTANCE, roomRight)) {
        direction = 1;
    } else if (direction > 0 && roomRight < Math.min(WALK_MIN_DISTANCE, roomLeft)) {
        direction = -1;
    }

    const available = direction < 0 ? roomLeft : roomRight;
    const requested = WALK_MIN_DISTANCE + Math.random() * (WALK_MAX_DISTANCE - WALK_MIN_DISTANCE);
    const distance = Math.min(requested, available);
    return {
        startLeft,
        startTop,
        targetLeft: startLeft + direction * distance,
        direction,
        distance,
    };
}

function startAutoWalk(preferredDirection = 0, duration = WALK_DURATION, { announce = false } = {}) {
    if (!ui?.root || !renderer || !settings?.enabled || isGenerating || typingAttentionActive || drag.active) {
        return false;
    }
    if (!announce && renderer.state !== PET_STATES.IDLE) {
        scheduleAutoWalk();
        return false;
    }

    clearPoseTimer();
    clearAutoWalkTimer();
    cancelAutoWalk({ settle: false });
    window.clearTimeout(reactionTimer);
    currentPriority = 0;
    priorityUntil = 0;
    const path = chooseWalkTarget(preferredDirection);
    if (path.distance < 8) {
        renderer.setForm('sitting');
        scheduleAutoLie();
        scheduleAutoWalk();
        return false;
    }

    const safeDuration = clamp(finiteNumber(duration, WALK_DURATION), 600, 6000);
    roamRun = { ...path, duration: safeDuration, startedAt: undefined };
    renderer.setWalkDirection(path.direction);
    renderer.setState(PET_STATES.IDLE);
    renderer.setForm('walking');
    ui.root.setAttribute('aria-label', '糯叽正在走过来陪你');
    if (announce) {
        showBubble('走两步陪你～', 1300);
    }

    const step = (now) => {
        if (!roamRun) {
            return;
        }
        if (roamRun.startedAt === undefined) {
            roamRun.startedAt = now;
        }
        const progress = clamp((now - roamRun.startedAt) / roamRun.duration, 0, 1);
        const eased = progress * progress * (3 - 2 * progress);
        setPixelPosition(
            roamRun.startLeft + (roamRun.targetLeft - roamRun.startLeft) * eased,
            roamRun.startTop,
        );
        if (progress < 1) {
            roamFrame = window.requestAnimationFrame(step);
            return;
        }

        roamFrame = undefined;
        roamRun = undefined;
        rememberCurrentPosition();
        renderer.setForm('sitting');
        renderer.setState(PET_STATES.IDLE);
        ui.root.setAttribute('aria-label', stateLabels[PET_STATES.IDLE]);
        if (announce) {
            showBubble('换个地方陪你～', 1200);
        }
        scheduleAutoLie();
        scheduleAutoWalk();
    };
    roamFrame = window.requestAnimationFrame(step);
    return true;
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
    if (state === PET_STATES.THINKING) {
        clearPoseTimer();
        renderer.setForm('ball');
    } else if (state === PET_STATES.SLEEPING) {
        clearPoseTimer();
        renderer.setForm('lying');
    } else {
        wakeNuoji();
    }
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
    if (isGenerating) {
        renderer?.setForm('ball');
    }
    renderer?.setState(ambientState);
    ui?.root.setAttribute('aria-label', stateLabels[ambientState]);

    if (isGenerating) {
        showBubble(thinkingCompanionMessage, 0);
    } else {
        if (renderer?.currentForm(performance.now()) === 'ball') {
            renderer.setForm('sitting');
        }
        hideBubble();
        scheduleAutoLie();
        scheduleAutoWalk();
    }
}

function showBubble(message, duration = 1500) {
    if (!ui?.bubble || !settings.showBubble || !message) {
        return;
    }

    window.clearTimeout(bubbleTimer);
    bubbleTimer = undefined;
    ui.bubble.textContent = message;
    ui.bubble.classList.add('is-visible');
    if (Number.isFinite(duration) && duration > 0) {
        bubbleTimer = window.setTimeout(hideBubble, duration);
    }
}

function hideBubble() {
    window.clearTimeout(bubbleTimer);
    bubbleTimer = undefined;
    ui?.bubble.classList.remove('is-visible');
}

function listen(eventName, handler) {
    const source = coreApi?.eventSource ?? context.eventSource;
    const eventType = coreApi?.event_types?.[eventName] ?? context.event_types?.[eventName];
    if (!source || !eventType) {
        return;
    }

    onEventSource(source, eventType, handler);
}

async function loadSillyTavernCoreApi() {
    try {
        // Same stable public-module bridge used by the reference typing
        // indicator. Context remains the fallback for older layouts.
        return await import('../../../../script.js');
    } catch {
        return undefined;
    }
}

function clearGenerationWatchdog() {
    window.clearTimeout(generationWatchdog);
    generationWatchdog = undefined;
}

function clearGenerationFinishTimer() {
    window.clearTimeout(generationFinishTimer);
    generationFinishTimer = undefined;
    generationEndTimer = undefined;
}

function clearThinkingCompanionTimers({ resetMessage = true } = {}) {
    window.clearTimeout(thinkingBubble20Timer);
    window.clearTimeout(thinkingBubble40Timer);
    thinkingBubble20Timer = undefined;
    thinkingBubble40Timer = undefined;
    if (resetMessage) {
        thinkingCompanionMessage = '让我想想…';
    }
}

function scheduleThinkingCompanionBubbles() {
    clearThinkingCompanionTimers();
    thinkingBubble20Timer = window.setTimeout(() => {
        thinkingBubble20Timer = undefined;
        if (!isGenerating) {
            return;
        }
        thinkingCompanionMessage = '这次想得久哦～';
        showBubble(thinkingCompanionMessage, 0);
    }, THINKING_COMPANION_DELAY);
    thinkingBubble40Timer = window.setTimeout(() => {
        thinkingBubble40Timer = undefined;
        if (!isGenerating) {
            return;
        }
        thinkingCompanionMessage = '还在想呢…';
        showBubble(thinkingCompanionMessage, 0);
    }, THINKING_COMPANION_DELAY * 2);
}

function setSignalStatus(message, source = '') {
    lastSignalStatus = message;
    const status = document.getElementById('nuoji-signal-status');
    if (status) {
        status.textContent = `联动状态：${message}`;
    }
    if (ui?.root && source) {
        ui.root.dataset.signalSource = source;
    }
}

function beginThinking(source = 'event') {
    clearTypingAttention();
    clearPendingTap();
    wakeNuoji();
    isGenerating = true;
    setSignalStatus('已收到发送，正在等回信', typeof source === 'string' ? source : 'event');
    clearGenerationFinishTimer();
    clearGenerationWatchdog();
    generationWatchdog = window.setTimeout(() => {
        if (!isGenerating) {
            return;
        }

        isGenerating = false;
        clearThinkingCompanionTimers();
        setSignalStatus('等待超时，已经回到陪伴');
        transitionTo(PET_STATES.CONFUSED, {
            duration: 1700,
            bubble: '唔，回信走丢了吗？',
            priority: 30,
            force: true,
        });
    }, 180000);

    transitionTo(PET_STATES.THINKING, {
        priority: 25,
        force: true,
    });
    // A typing indicator should remain visible for the entire generation,
    // not just for the first animation beat.
    showBubble('让我想想…', 0);
    scheduleThinkingCompanionBubbles();
}

function finishThinking(bubble = '回信来啦！') {
    clearGenerationFinishTimer();
    clearGenerationWatchdog();
    clearThinkingCompanionTimers();
    isGenerating = false;
    replyArrived = false;
    setSignalStatus('回复已到达');
    transitionTo(PET_STATES.HAPPY, {
        duration: 2100,
        bubble,
        priority: 35,
        force: true,
    });
}

function stopThinkingManually() {
    clearGenerationFinishTimer();
    clearGenerationWatchdog();
    clearThinkingCompanionTimers();
    isGenerating = false;
    setSignalStatus('生成已手动停止');
    transitionTo(PET_STATES.CONFUSED, {
        duration: 1700,
        bubble: '停在这里嘛？',
        priority: 35,
        force: true,
    });
}

function chatLog() {
    return Array.isArray(context?.chat) ? context.chat : [];
}

function resetObservedChatLength() {
    observedChatLength = chatLog().length;
}

function inspectChatActivity() {
    chatActivityFrame = undefined;
    const chat = chatLog();

    if (chat.length < observedChatLength) {
        observedChatLength = chat.length;
        return;
    }

    if (chat.length === observedChatLength) {
        return;
    }

    const newEntries = chat.slice(observedChatLength);
    observedChatLength = chat.length;

    // This is a deliberate DOM-backed fallback for third-party input flows
    // that render messages but skip one of SillyTavern's generation events.
    for (const entry of newEntries) {
        if (entry?.is_user === true) {
            beginThinking('chat-observer');
        } else if (entry?.is_user === false && isGenerating) {
            if (streamingModeIsEnabled() || stopControlIsActive()) {
                setSignalStatus('已看到流式开头，继续等完整回信', 'chat-observer');
            } else {
                scheduleGenerationFinish('chat-observer');
            }
        }
    }
}

function scheduleChatActivityInspection() {
    window.cancelAnimationFrame(chatActivityFrame);
    chatActivityFrame = window.requestAnimationFrame(inspectChatActivity);
}

function bindChatActivityFallback() {
    resetObservedChatLength();
    const chatElement = document.getElementById('chat');
    if (!chatElement || typeof MutationObserver !== 'function') {
        return;
    }

    chatObserver = new MutationObserver(scheduleChatActivityInspection);
    chatObserver.observe(chatElement, { childList: true });
    cleanups.push(() => chatObserver?.disconnect());
}

function closestSignalControl(target, selector) {
    if (typeof target?.closest === 'function') {
        return target.closest(selector);
    }
    return target?.id === selector.slice(1) ? target : null;
}

function controlIsVisible(element) {
    if (!element || element.classList?.contains('displayNone') || element.hidden) {
        return false;
    }

    const styles = window.getComputedStyle(element);
    return styles.display !== 'none' && styles.visibility !== 'hidden' && styles.opacity !== '0';
}

function stopControlIsActive() {
    return controlIsVisible(document.getElementById('mes_stop'));
}

function streamingModeIsEnabled() {
    const check = coreApi?.isStreamingEnabled ?? context?.isStreamingEnabled;
    if (typeof check !== 'function') {
        return false;
    }

    try {
        return Boolean(check());
    } catch {
        return false;
    }
}

function scheduleGenerationFinish(source = 'settled') {
    if (!isGenerating) {
        return;
    }

    clearGenerationFinishTimer();
    generationFinishTimer = window.setTimeout(() => {
        generationFinishTimer = undefined;
        if (!isGenerating || stopControlIsActive()) {
            return;
        }

        finishThinking();
        setSignalStatus('完整回复已到达', source);
    }, GENERATION_SETTLE_DELAY);
}

function handleDirectGenerationControl(event) {
    const sendButton = closestSignalControl(event.target, SEND_BUTTON_SELECTOR);
    if (sendButton) {
        const textarea = document.getElementById('send_textarea');
        if (!textarea || String(textarea.value ?? '').trim()) {
            beginThinking('send-button');
        }
        return;
    }

    if (closestSignalControl(event.target, STOP_BUTTON_SELECTOR)) {
        generationWasManuallyStopped = true;
    }
}

function syncGenerationControls() {
    generationControlFrame = undefined;
    const nextActive = controlIsVisible(document.getElementById('mes_stop'));

    if (nextActive && !generationControlActive) {
        clearGenerationFinishTimer();
        generationWasManuallyStopped = false;
        beginThinking('stop-button');
    } else if (!nextActive && generationControlActive && isGenerating) {
        if (generationWasManuallyStopped) {
            stopThinkingManually();
        } else {
            // SillyTavern may briefly swap controls while a streaming request
            // is still settling. Match proven typing-indicator behaviour by
            // requiring the Stop control to remain hidden for a short beat.
            scheduleGenerationFinish('stop-button-hidden');
        }
    }

    generationControlActive = nextActive;
}

function scheduleGenerationControlSync() {
    window.cancelAnimationFrame(generationControlFrame);
    generationControlFrame = window.requestAnimationFrame(syncGenerationControls);
}

function bindDirectInputSignals() {
    // Capture before SillyTavern clears the textarea or swaps Send for Stop.
    on(document, 'pointerdown', handleDirectGenerationControl, { capture: true, passive: true });
    on(document, 'click', handleDirectGenerationControl, { capture: true, passive: true });

    const controls = [
        document.getElementById('send_but'),
        document.getElementById('mes_stop'),
    ].filter(Boolean);
    const controlsHost = document.getElementById('rightSendForm');

    generationControlActive = controlIsVisible(document.getElementById('mes_stop'));
    if (generationControlActive) {
        beginThinking('stop-button');
    }

    if ((controls.length || controlsHost) && typeof MutationObserver === 'function') {
        generationControlObserver = new MutationObserver(scheduleGenerationControlSync);
        for (const control of controls) {
            generationControlObserver.observe(control, {
                attributes: true,
                attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
            });
        }
        if (controlsHost) {
            // Some themes replace the Send / Stop nodes instead of only
            // changing their style. Observing the stable form catches both.
            generationControlObserver.observe(controlsHost, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
            });
        }
        cleanups.push(() => generationControlObserver?.disconnect());
    }

    setSignalStatus(lastSignalStatus);
}

let replyArrived = false;
let generationEndTimer;

/**
 * Canonical SillyTavern generation lifecycle (verified against release script.js):
 *   GENERATION_STARTED(type, args, dryRun)  -- also fires for dryRun and type==='quiet' (background
 *                                              generations from other extensions). Those NEVER emit
 *                                              MESSAGE_RECEIVED, so they must be ignored here.
 *   streaming:     hideStopButton() -> GENERATION_ENDED, then MESSAGE_RECEIVED, CHARACTER_MESSAGE_RENDERED
 *   non-streaming: MESSAGE_RECEIVED, CHARACTER_MESSAGE_RENDERED, ... then GENERATION_ENDED
 *   GENERATION_STOPPED on manual abort (GENERATION_ENDED follows).
 * So: GENERATION_ENDED is always the end. Whether it is "happy" or "confused" is decided
 * by whether a reply arrives within a short settle window around it.
 */
function bindSillyTavernEvents() {
    listen('MESSAGE_SENT', () => {
        clearTypingAttention();
        clearPendingTap();
        transitionTo(PET_STATES.LISTENING, { duration: 1200, bubble: '嗯嗯，我在听', priority: 25, force: true });
    });

    listen('GENERATION_STARTED', (type, _args, dryRun) => {
        if (dryRun || type === 'quiet') {
            return; // token counting / background prompts from other extensions
        }
        replyArrived = false;
        window.clearTimeout(generationEndTimer);
        beginThinking(`GENERATION_STARTED:${type}`);
    });

    listen('STREAM_TOKEN_RECEIVED', () => {
        renderer?.pulse();
    });

    listen('MESSAGE_RECEIVED', (_messageId, type) => {
        if (type === 'quiet' || !isGenerating && !generationEndTimer) {
            return;
        }
        replyArrived = true;
        window.clearTimeout(generationEndTimer);
        generationEndTimer = undefined;
        finishThinking();
    });

    listen('GENERATION_STOPPED', () => {
        replyArrived = true; // suppress the "结束啦?" follow-up from GENERATION_ENDED
        window.clearTimeout(generationEndTimer);
        generationEndTimer = undefined;
        stopThinkingManually();
    });

    listen('GENERATION_ENDED', () => {
        if (!isGenerating) {
            return;
        }
        clearGenerationWatchdog();
        clearThinkingCompanionTimers();
        isGenerating = false;
        if (replyArrived) {
            return; // non-streaming: HAPPY already played
        }
        // streaming: MESSAGE_RECEIVED lands a few ms after this. Give it a beat.
        window.clearTimeout(generationEndTimer);
        generationEndTimer = window.setTimeout(() => {
            generationEndTimer = undefined;
            if (replyArrived) {
                return;
            }
            setSignalStatus('生成结束但没有回信（报错？）', 'GENERATION_ENDED');
            transitionTo(PET_STATES.CONFUSED, { duration: 1700, bubble: '欸，结束啦？', priority: 30, force: true });
        }, 400);
    });

    listen('CHAT_CHANGED', () => {
        clearTypingAttention();
        clearThinkingCompanionTimers();
        clearGenerationWatchdog();
        window.clearTimeout(generationEndTimer);
        generationEndTimer = undefined;
        isGenerating = false;
        setSignalStatus('已切换聊天，等待发送');
        transitionTo(PET_STATES.WAVE, { duration: 1700, bubble: '我也跟过来啦！', priority: 30, force: true });
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
    clearGenerationFinishTimer();
    clearGenerationWatchdog();
    clearThinkingCompanionTimers();
    clearTypingAttention();
    clearLongPressTimer();
    clearPendingTap();
    clearPoseTimer();
    clearAutoWalkTimer();
    cancelAutoWalk({ settle: false, remember: false });
    window.cancelAnimationFrame(chatActivityFrame);
    window.cancelAnimationFrame(generationControlFrame);
    renderer?.destroy();
    ui?.root?.remove();
    document.getElementById('nuoji-settings')?.remove();

    if (window.NuojiPet === publicApi) {
        delete window.NuojiPet;
    }

    context = undefined;
    coreApi = undefined;
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
    generationWatchdog = undefined;
    generationFinishTimer = undefined;
    chatActivityFrame = undefined;
    chatObserver = undefined;
    generationControlFrame = undefined;
    generationControlObserver = undefined;
    generationControlActive = false;
    generationWasManuallyStopped = false;
    observedChatLength = 0;
    lastSignalStatus = '待命，等你发消息';
    currentPriority = 0;
    priorityUntil = 0;
    isGenerating = false;
    publicApi = undefined;
    clickGuard = undefined;
    poseTimer = undefined;
    roamTimer = undefined;
    roamFrame = undefined;
    roamRun = undefined;
    drag.active = false;
    drag.moved = false;
    drag.pointerId = null;
    drag.longPress = false;
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
        coreApi = await loadSillyTavernCoreApi();
        settings = getSettings();
        ui = createPetUi();
        renderer = new NuojiRenderer(ui.canvas);
        renderer.setReducedMotion(settings.reducedMotion);
        renderer.start();

        applyVisualSettings();
        applyStoredPosition();
        await createSettingsUi();
        // v0.3.6: the DOM/button/chat-observer fallbacks were the cause of the
        // stuck "让我想想…" (they re-entered thinking on quiet/dryRun generations
        // and ignored GENERATION_ENDED). Events alone are sufficient and exact.
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
            status() {
                return Object.freeze({
                    state: renderer?.state,
                    form: renderer?.currentForm(performance.now()),
                    isGenerating,
                    signal: lastSignalStatus,
                    generationControlActive,
                });
            },
            react(state, message = '', duration = 1800) {
                window.dispatchEvent(new CustomEvent('nuoji:react', {
                    detail: { state, message, duration },
                }));
            },
            lieDown() {
                clearPoseTimer();
                renderer?.setForm('lying');
                showBubble('趴趴～', 1200);
            },
            sitUp() {
                wakeNuoji();
            },
            rollUp() {
                clearPoseTimer();
                renderer?.setForm('ball');
                renderer?.setState(PET_STATES.THINKING);
                showBubble('咕噜噜～', 1200);
            },
            walk(direction = 0, duration = WALK_DURATION) {
                return startAutoWalk(direction, duration, { announce: true });
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
