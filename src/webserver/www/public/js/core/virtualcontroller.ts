/**
 * Virtual Joystick Controller for Mobile Devices
 * Provides touch-based movement control that emits gamepadjoystick events
 */

import { mount } from './input.js';

// ============================================
// State Management
// ============================================
interface JoystickState {
    active: boolean;
    touchId: number | null;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
}

const state: JoystickState = {
    active: false,
    touchId: null,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0
};

// ============================================
// Configuration
// ============================================
const CONFIG = {
    maxDistance: 60,        // Maximum distance the stick can move from center
    deadzone: 0.05,         // Deadzone threshold for neutral position (reduced for better responsiveness)
    updateRate: 16          // Update rate in milliseconds (~60fps)
};

// ============================================
// DOM Elements
// ============================================
const container = document.getElementById('virtual-joystick-container') as HTMLElement;
const stick = document.getElementById('virtual-joystick-stick') as HTMLElement;

// ============================================
// Touch Event Handlers
// ============================================

/**
 * Handles the start of a touch interaction
 */
function handleTouchStart(event: TouchEvent): void {
    // Prevent default to avoid scrolling/zooming
    event.preventDefault();

    // Only handle if not already active and single touch
    if (state.touchId !== null || event.touches.length !== 1) {
        return;
    }

    const touch = event.touches[0];
    const rect = container.getBoundingClientRect();

    // Store touch information
    state.touchId = touch.identifier;
    state.active = true;
    state.startX = rect.left + rect.width / 2;
    state.startY = rect.top + rect.height / 2;
    state.currentX = touch.clientX;
    state.currentY = touch.clientY;

    // Visual feedback
    stick.classList.add('active');

    console.log('[VirtualJoystick] Touch start:', {
        touchId: state.touchId,
        x: touch.clientX,
        y: touch.clientY
    });
}

/**
 * Handles touch movement
 */
function handleTouchMove(event: TouchEvent): void {
    // Prevent default to avoid scrolling
    event.preventDefault();

    if (!state.active || state.touchId === null) {
        return;
    }

    // Find the touch that matches our stored ID
    const touch = Array.from(event.touches).find(
        t => t.identifier === state.touchId
    );

    if (!touch) {
        return;
    }

    // Update current position
    state.currentX = touch.clientX;
    state.currentY = touch.clientY;

    // Request animation frame for smooth updates
    requestAnimationFrame(updateStickPosition);
}

/**
 * Handles the end of a touch interaction
 */
function handleTouchEnd(event: TouchEvent): void {
    if (state.touchId === null) {
        return;
    }

    // Check if our specific touch ended
    const touchStillActive = Array.from(event.touches).some(
        t => t.identifier === state.touchId
    );

    if (!touchStillActive) {
        console.log('[VirtualJoystick] Touch end');
        resetJoystick();
    }
}

/**
 * Handles touch cancellation (e.g., phone call, notification)
 */
function handleTouchCancel(event: TouchEvent): void {
    console.log('[VirtualJoystick] Touch cancel');
    handleTouchEnd(event);
}

// ============================================
// Visual Updates
// ============================================

/**
 * Updates the visual position of the joystick stick
 */
function updateStickPosition(): void {
    if (!stick || !state.active) {
        return;
    }

    // Calculate delta from center
    const deltaX = state.currentX - state.startX;
    const deltaY = state.currentY - state.startY;
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

    let x = deltaX;
    let y = deltaY;

    // Clamp to maximum distance
    if (distance > CONFIG.maxDistance) {
        const angle = Math.atan2(deltaY, deltaX);
        x = Math.cos(angle) * CONFIG.maxDistance;
        y = Math.sin(angle) * CONFIG.maxDistance;
    }

    // Update visual position
    stick.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
}

/**
 * Resets the joystick to neutral position
 */
function resetJoystick(): void {
    state.active = false;
    state.touchId = null;

    // Reset visual state
    if (stick) {
        stick.style.transform = 'translate(-50%, -50%)';
        stick.classList.remove('active');
    }

    // Send final zero event to stop movement
    dispatchJoystickEvent(0, 0);
}

// ============================================
// Input Processing
// ============================================

/**
 * Gets normalized joystick input (-1 to 1 range)
 */
function getNormalizedInput(): { x: number; y: number } {
    if (!state.active) {
        return { x: 0, y: 0 };
    }

    const deltaX = state.currentX - state.startX;
    const deltaY = state.currentY - state.startY;

    // Normalize to -1 to 1 range
    let x = deltaX / CONFIG.maxDistance;
    let y = deltaY / CONFIG.maxDistance;

    // Clamp values
    x = Math.max(-1, Math.min(1, x));
    y = Math.max(-1, Math.min(1, y));

    // Apply deadzone
    const magnitude = Math.sqrt(x * x + y * y);
    if (magnitude < CONFIG.deadzone) {
        return { x: 0, y: 0 };
    }

    return { x, y };
}

// ============================================
// Event Dispatching
// ============================================

/**
 * Dispatches a custom gamepadjoystick event
 */
function dispatchJoystickEvent(x: number, y: number): void {
    const event = new CustomEvent('gamepadjoystick', {
        detail: {
            x,
            y,
            type: 'left',
            isVirtual: true
        }
    });

    window.dispatchEvent(event);
}

// ============================================
// Update Loop
// ============================================

/**
 * Main update loop that continuously reads input and dispatches events
 */
function startUpdateLoop(): void {
    let lastUpdate = 0;

    function update(timestamp: number): void {
        // Throttle updates to configured rate
        if (timestamp - lastUpdate >= CONFIG.updateRate) {
            const input = getNormalizedInput();

            // Only dispatch when there's actual input or when stopping
            if (input.x !== 0 || input.y !== 0 || state.active) {
                dispatchJoystickEvent(input.x, input.y);
            }

            lastUpdate = timestamp;
        }

        requestAnimationFrame(update);
    }

    requestAnimationFrame(update);
}

// ============================================
// Initialization
// ============================================

/**
 * Initialize the virtual joystick controller
 */
function initialize(): void {
    // Check if elements exist
    if (!container || !stick) {
        console.error('[VirtualJoystick] Required DOM elements not found');
        return;
    }

    // Only initialize on touch-capable devices
    if (!('ontouchstart' in window)) {
        console.log('[VirtualJoystick] Not a touch device, skipping initialization');
        return;
    }

    console.log('[VirtualJoystick] Initializing on touch device');

    // Register touch event listeners with { passive: false } to allow preventDefault
    container.addEventListener('touchstart', handleTouchStart, { passive: false });
    container.addEventListener('touchmove', handleTouchMove, { passive: false });
    container.addEventListener('touchend', handleTouchEnd, { passive: false });
    container.addEventListener('touchcancel', handleTouchCancel, { passive: false });

    // Start the update loop
    startUpdateLoop();

    console.log('[VirtualJoystick] Initialization complete');
}

// ============================================
// Mount Button Handler
// ============================================

/**
 * Initialize mount button functionality
 */
function initializeMountButton(): void {
    const mountButton = document.getElementById('virtual-mount-button') as HTMLElement;

    if (!mountButton) {
        console.log('[VirtualJoystick] Mount button not found');
        return;
    }

    // Only initialize on touch-capable devices
    if (!('ontouchstart' in window)) {
        return;
    }

    // Handle button click/tap
    mountButton.addEventListener('click', (event) => {
        event.preventDefault();
        console.log('[VirtualJoystick] Mount button clicked');

        // Call the mount function directly
        mount();
    });

    console.log('[VirtualJoystick] Mount button initialized');
}

// Auto-initialize when module loads
initialize();
initializeMountButton();
