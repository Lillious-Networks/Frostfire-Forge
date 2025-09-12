// Playstation 4 controller button mapping
type KeyMap = {
    [key: number]: string;
};

const keyMap: KeyMap = {
    0: "X",
    1: "Circle",
    2: "Square",
    3: "Triangle",
    4: "Left bumper",
    5: "Right bumper",
    6: "Left trigger",
    7: "Right trigger",
    8: "Share",
    9: "Options",
    10: "Left stick",
    11: "Right stick",
    12: "Up",
    13: "Down",
    14: "Left",
    15: "Right",
    16: "Home",
    17: "Touchpad",
};

// Array to store the indexes of the buttons pressed in the previous frame
let previousIndexes: number[] = [];

const controllerInputLoop = () => {
    // Get the first connected gamepad
    const gamepad = navigator.getGamepads()[0] || null;

    // If no gamepad is connected, request the next frame
    if (!gamepad) {
        window.requestAnimationFrame(controllerInputLoop);
        return;
    }
    
    // Map the buttons to an array of booleans
    const input = gamepad.buttons.map((b) => b.pressed);

    // Check if multiple buttons are pressed
    const indexes = input.map((b, i) => b ? i : -1).filter((i) => i !== -1);
    
    // If multiple buttons are pressed, dispatch a custom event with the indexes of the buttons
    if (indexes.length > 0) {
        const gamepadKeyDown = new CustomEvent("gamepadkeydown", {
            detail: {
                indexes,
                names: indexes.map((i) => keyMap[i]),
                sensitivities: indexes.map((i) => gamepad.buttons[i].value),
            }
        });

        // Update the previous indexes
        previousIndexes = indexes;

        // Dispatch the event
        window.dispatchEvent(gamepadKeyDown);

    } else if (indexes.length === 0 && previousIndexes.length > 0) {
        // If no buttons are pressed, dispatch a custom event with the index of the released button
        const gamepadKeyUp = new CustomEvent("gamepadkeyup", {
            detail: {
                index: previousIndexes[0],
                name: keyMap[previousIndexes[0]],
            }
        });

        // Reset the previous indexes
        previousIndexes = [];

        // Dispatch the event
        window.dispatchEvent(gamepadKeyUp);
    }

    // Check for joystick movement left or right
    const axes = gamepad.axes;
    const deadzone = 0.01;
    const x = Math.abs(axes[0]) > deadzone ? axes[0] : 0;
    const y = Math.abs(axes[1]) > deadzone ? axes[1] : 0;

    // Dispatch a custom event with the joystick coordinates and the type of joystick
    if (x !== 0 || y !== 0) {
        // Left joystick movement event with x and y coordinates
        const gamepadJoystick = new CustomEvent("gamepadjoystick", {
            detail: {
                x,
                y,
                type: "left",
            }
        });

        // Dispatch the event
        window.dispatchEvent(gamepadJoystick);
    } else if (axes.length > 2) {
        const x = Math.abs(axes[2]) > deadzone ? axes[2] : 0;
        const y = Math.abs(axes[3]) > deadzone ? axes[3] : 0;

        if (x !== 0 || y !== 0) {
            // Right joystick movement event with x and y coordinates
            const gamepadJoystick = new CustomEvent("gamepadjoystick", {
                detail: {
                    x,
                    y,
                    type: "right",
                }
            });

            // Dispatch the event
            window.dispatchEvent(gamepadJoystick);
        }
    }
    // Request the next frame
    window.requestAnimationFrame(controllerInputLoop);
}

// Start the event loop
controllerInputLoop();

// Custom event listener usage for button presses and joystick movement

/*
    // Event listener for button presses
    window.addEventListener("gamepadkeydown", (e: CustomEventInit) => {
        console.log(`Button combination ${e.detail.names.join(", ")} pressed with sensitivity of ${e.detail.sensitivities.join(", ")}`);
    });
*/

/* 
    // Event listener for button releases
    window.addEventListener("gamepadkeyup", (e: CustomEventInit) => {
        console.log(`Button ${e.detail.name} released`);
    });
*/

/*
    // Event listener for joystick movement
    window.addEventListener("gamepadjoystick", (e: CustomEventInit) => {
        console.log(`Joystick ${e.detail.type} moved to x: ${e.detail.x}, y: ${e.detail.y}`);
    });
*/