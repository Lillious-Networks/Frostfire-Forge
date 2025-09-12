function preventKeyboardZoom(event: KeyboardEvent) {
    if (event.ctrlKey) {
        const forbiddenKeys = ['+', '-', '=', '0'];
        if (forbiddenKeys.includes(event.key)) {
            event.preventDefault();
        }
    }
}

function preventWheelZoom(event: WheelEvent) {
    if (event.ctrlKey) {
        event.preventDefault();
    }
}

function preventTouchZoom(event: TouchEvent) {
    if (event.touches.length > 1) {
        event.preventDefault();
    }
}

document.addEventListener('keydown', preventKeyboardZoom, { passive: false });
document.addEventListener('wheel', preventWheelZoom, { passive: false });
document.addEventListener('touchmove', preventTouchZoom, { passive: false });