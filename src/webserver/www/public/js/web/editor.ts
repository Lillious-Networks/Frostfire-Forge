import { APNGEncoder } from "../libs/apng_encoder";

document.addEventListener('DOMContentLoaded', () => {
    const dropzone = document.getElementById('editor-dropzone');
    const imagesContainer = document.getElementById('editor-images-container');

    // Prevent default drag behaviors
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropzone?.addEventListener(eventName, preventDefaults);
        document.body.addEventListener(eventName, preventDefaults);
    });

    // Highlight drop zone when dragging over it
    ['dragenter', 'dragover'].forEach(eventName => {
        dropzone?.addEventListener(eventName, () => {
            dropzone?.classList.add('highlight');
        });
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropzone?.addEventListener(eventName, () => {
            dropzone?.classList.remove('highlight');
        });
    });

    // Handle dropped files
    dropzone?.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        if (!dt) return;
        
        const files = Array.from(dt.files);
        
        files.forEach(file => {
            if (file.type === 'image/png') {
                addImageToContainer(file);
            }
        });
    });

    // Add autosave functionality
    const AUTOSAVE_KEY = 'animation_editor_autosave';
    const autosaveCheckbox = document.getElementById('autosave-checkbox') as HTMLInputElement;
    
    // Load autosave preference
    autosaveCheckbox.checked = localStorage.getItem('autosave_enabled') === 'true';
    
    // Load autosaved data if autosave is enabled
    if (autosaveCheckbox.checked) {
        const savedData = localStorage.getItem(AUTOSAVE_KEY);
        if (savedData) {
            loadConfigurationFromData(savedData);
        }
    }

    // Handle autosave checkbox changes
    autosaveCheckbox.addEventListener('change', () => {
        localStorage.setItem('autosave_enabled', autosaveCheckbox.checked.toString());
        if (!autosaveCheckbox.checked) {
            localStorage.removeItem(AUTOSAVE_KEY);
        } else {
            saveToLocalStorage();
        }
    });

    function addImageToContainer(file: File) {
        const reader = new FileReader();
        
        reader.onload = (e) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'image-wrapper';
            wrapper.draggable = true;
            
            wrapper.addEventListener('dragstart', (e) => {
                // Get element directly under the mouse
                const elementUnderMouse = document.elementFromPoint(e.clientX, e.clientY);
                
                // Prevent drag if directly over input, buttons, or their containers
                if (
                    elementUnderMouse instanceof HTMLInputElement ||
                    elementUnderMouse instanceof HTMLButtonElement ||
                    elementUnderMouse?.closest('.frame-duration') ||
                    elementUnderMouse?.closest('.image-controls')
                ) {
                    e.preventDefault();
                    return;
                }
                wrapper.classList.add('dragging');
                e.dataTransfer?.setData('text/plain', ''); // Required for Firefox
            });
            
            wrapper.addEventListener('dragend', () => {
                wrapper.classList.remove('dragging');
            });
            
            wrapper.addEventListener('dragover', (e) => {
                e.preventDefault();
                const draggingItem = document.querySelector('.dragging');
                if (!draggingItem || !imagesContainer) return;
                
                const siblings = Array.from(imagesContainer.querySelectorAll('.image-wrapper:not(.dragging)'));
                const nextSibling = siblings.find(sibling => {
                    const rect = sibling.getBoundingClientRect();
                    const mousePosition = e.clientY;
                    return mousePosition < rect.top + rect.height / 2;
                });
                
                // If no next sibling is found and we're below the last element, append to the end
                if (!nextSibling && siblings.length > 0) {
                    const lastSibling = siblings[siblings.length - 1];
                    const rect = lastSibling.getBoundingClientRect();
                    if (e.clientY > rect.bottom) {
                        imagesContainer.appendChild(draggingItem);
                        return;
                    }
                }
                
                imagesContainer.insertBefore(draggingItem, nextSibling || null);
            });

            const imageContent = document.createElement('div');
            imageContent.className = 'image-content';
            
            const img = document.createElement('img');
            img.src = e.target?.result as string;
            
            const durationContainer = document.createElement('div');
            durationContainer.className = 'frame-duration';
            
            const durationInput = document.createElement('input');
            durationInput.type = 'number';
            durationInput.value = '120';
            durationInput.min = '1';
            
            const durationLabel = document.createElement('span');
            durationLabel.textContent = 'ms';
            
            durationContainer.appendChild(durationInput);
            durationContainer.appendChild(durationLabel);
            
            const controls = document.createElement('div');
            controls.className = 'image-controls';
            
            const duplicateBtn = document.createElement('button');
            duplicateBtn.className = 'duplicate-button';
            duplicateBtn.title = 'Duplicate';
            duplicateBtn.onclick = () => {
                const newWrapper = wrapper.cloneNode(true) as HTMLElement;
                
                // Copy the frame duration from the original
                const originalDurationInput = wrapper.querySelector('.frame-duration input') as HTMLInputElement;
                const newDurationInput = newWrapper.querySelector('.frame-duration input') as HTMLInputElement;
                if (originalDurationInput && newDurationInput) {
                    newDurationInput.value = originalDurationInput.value;
                }

                // Re-attach drag event listeners to the new wrapper
                newWrapper.draggable = true;
                
                newWrapper.addEventListener('dragstart', (e) => {
                    const elementUnderMouse = document.elementFromPoint(e.clientX, e.clientY);
                    
                    if (
                        elementUnderMouse instanceof HTMLInputElement ||
                        elementUnderMouse instanceof HTMLButtonElement ||
                        elementUnderMouse?.closest('.frame-duration') ||
                        elementUnderMouse?.closest('.image-controls')
                    ) {
                        e.preventDefault();
                        return;
                    }
                    newWrapper.classList.add('dragging');
                    e.dataTransfer?.setData('text/plain', '');
                });
                
                newWrapper.addEventListener('dragend', () => {
                    newWrapper.classList.remove('dragging');
                });
                
                newWrapper.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    const draggingItem = document.querySelector('.dragging');
                    if (!draggingItem || !imagesContainer) return;
                    
                    const siblings = Array.from(imagesContainer.querySelectorAll('.image-wrapper:not(.dragging)'));
                    const nextSibling = siblings.find(sibling => {
                        const rect = sibling.getBoundingClientRect();
                        const mousePosition = e.clientY;
                        return mousePosition < rect.top + rect.height / 2;
                    });
                    
                    if (!nextSibling && siblings.length > 0) {
                        const lastSibling = siblings[siblings.length - 1];
                        const rect = lastSibling.getBoundingClientRect();
                        if (e.clientY > rect.bottom) {
                            imagesContainer.appendChild(draggingItem);
                            return;
                        }
                    }
                    
                    imagesContainer.insertBefore(draggingItem, nextSibling || null);
                });

                // Re-attach button click handlers
                const newDuplicateBtn = newWrapper.querySelector('.duplicate-button');
                if (newDuplicateBtn) {
                    (newDuplicateBtn as HTMLButtonElement).onclick = duplicateBtn.onclick;
                }
                
                const newDeleteBtn = newWrapper.querySelector('.delete-button');
                if (newDeleteBtn) {
                    (newDeleteBtn as HTMLButtonElement).onclick = () => newWrapper.remove();
                }

                imagesContainer?.appendChild(newWrapper);
            };
            
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'delete-button';
            deleteBtn.title = 'Delete';
            deleteBtn.onclick = () => wrapper.remove();
            
            controls.appendChild(duplicateBtn);
            controls.appendChild(deleteBtn);
            
            imageContent.appendChild(img);
            imageContent.appendChild(durationContainer);
            imageContent.appendChild(controls);
            wrapper.appendChild(imageContent);
            imagesContainer?.appendChild(wrapper);
        };
        
        reader.readAsDataURL(file);
        setTimeout(saveToLocalStorage, 0);
    }

    function preventDefaults(e: Event) {
        e.preventDefault();
        e.stopPropagation();
    }

    const animateButton = document.getElementById('animate-button');
    let previewSection: HTMLElement | null = null;
    let previewImage: HTMLImageElement | null = null;

    function createPreviewSection() {
        // Remove existing preview section if it exists
        const existingPreview = document.getElementById('preview-section');
        if (existingPreview) {
            existingPreview.remove();
        }

        previewSection = document.createElement('div');
        previewSection.id = 'preview-section';
        previewSection.style.position = 'fixed';
        previewSection.style.top = '90px';
        previewSection.style.right = '-3px';
        previewSection.style.zIndex = '1000';
        previewSection.style.backgroundColor = 'transparent';
        previewSection.style.padding = '10px';
        previewSection.style.borderRadius = '4px';
        
        const closeButton = document.createElement('button');
        closeButton.innerHTML = '×';
        closeButton.style.position = 'absolute';
        closeButton.style.right = '5px';
        closeButton.style.top = '5px';
        closeButton.style.background = 'none';
        closeButton.style.border = 'none';
        closeButton.style.color = '#fff';
        closeButton.style.fontSize = '20px';
        closeButton.style.cursor = 'pointer';
        closeButton.style.padding = '0 5px';
        closeButton.onclick = () => previewSection?.remove();
        
        const container = document.createElement('div');
        container.id = 'preview-container';
        container.style.width = 'fit-content';
        container.style.height = 'fit-content';
        
        previewImage = document.createElement('img');
        previewImage.id = 'preview-image';
        previewImage.style.maxWidth = '300px';
        previewImage.style.height = 'auto';
        previewImage.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24"%3E%3Cpath fill="%23666" d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/%3E%3C/svg%3E';
        
        container.appendChild(previewImage);
        previewSection.appendChild(closeButton);
        previewSection.appendChild(container);
        
        const navbar = document.getElementById('editor-navbar');
        if (navbar && navbar.parentNode) {
            navbar.parentNode.insertBefore(previewSection, navbar.nextSibling);
        }
    }

    function generateAnimation() {
        console.log("Starting animation generation");
        const frames = Array.from(document.querySelectorAll('.image-wrapper')).map(wrapper => {
            const img = wrapper.querySelector('img');
            const durationInput = wrapper.querySelector('.frame-duration input') as HTMLInputElement;
            console.log("Frame found:", { src: img?.src, duration: durationInput?.value });
            return {
                src: img?.src || '',
                duration: parseInt(durationInput?.value || '120', 10)
            };
        });

        if (frames.length === 0) {
            console.log("No frames found");
            return;
        }
        console.log("Total frames:", frames.length);

        // Create temporary canvas and context
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            console.error("Failed to get canvas context");
            return;
        }

        // Wait for all images to be fully loaded before proceeding
        Promise.all(frames.map(frame => {
            return new Promise<HTMLImageElement>((resolve, reject) => {
                const img = new Image();
                img.onload = () => {
                    console.log("Image loaded:", frame.src);
                    resolve(img);
                };
                img.onerror = (e) => {
                    console.error("Image load error:", frame.src, e);
                    reject(new Error('Failed to load image'));
                };
                img.src = frame.src;
            });
        }))
        .then(images => {
            console.log("All images loaded, starting encoding");
            // Set canvas size to first image dimensions
            canvas.width = images[0].width;
            canvas.height = images[0].height;

            // Create frames
            const encoder = new APNGEncoder();
            
            return Promise.all(images.map((img, i) => {
                console.log("Processing frame", i);
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d')!;
                ctx.drawImage(img, 0, 0);
                
                return encoder.addFrame(canvas, { delay: frames[i].duration });
            })).then(() => {
                console.log("Frames added, finishing encoding");
                return encoder.finish();
            });
        })
        .then(pngData => {
            console.log("Animation generated, creating blob");
            const blob = new Blob([pngData as any], { type: 'image/png' });
            
            // Show preview
            createPreviewSection();
            if (previewImage && previewSection) {
                previewImage.src = URL.createObjectURL(blob);
                previewImage.onerror = (e) => console.error('Preview image load error:', e);
                previewSection.classList.add('visible');
                console.log("Preview displayed");
            }
        })
        .catch(error => {
            console.error('Animation generation failed:', error);
        });
    }

    // Make sure the button is properly connected
    if (animateButton) {
        console.log("Animate button found, attaching listener");
        animateButton.addEventListener('click', () => {
            console.log("Animate button clicked");
            generateAnimation();
        });
    } else {
        console.error("Animate button not found");
    }

    // Add save button to the navbar
    const saveButton = document.createElement('button');
    saveButton.id = 'save-button';
    saveButton.textContent = 'Save';
    saveButton.onclick = saveConfiguration;
    document.getElementById('editor-navbar')?.appendChild(saveButton);

    // Add load button and file input
    const loadInput = document.createElement('input');
    loadInput.type = 'file';
    loadInput.accept = '.forge';
    loadInput.style.display = 'none';
    loadInput.onchange = loadConfiguration;
    
    const loadButton = document.createElement('button');
    loadButton.id = 'load-button';
    loadButton.textContent = 'Load';
    loadButton.onclick = () => loadInput.click();
    document.getElementById('editor-navbar')?.appendChild(loadButton);
    document.body.appendChild(loadInput);

    function saveConfiguration() {
        const frames = Array.from(document.querySelectorAll('.image-wrapper')).map(wrapper => {
            const img = wrapper.querySelector('img');
            const durationInput = wrapper.querySelector('.frame-duration input') as HTMLInputElement;
            return {
                imageData: img?.src || '',
                duration: parseInt(durationInput?.value || '120', 10)
            };
        });

        const config = {
            version: 1,
            frames: frames
        };

        const blob = new Blob([JSON.stringify(config)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const link = document.createElement('a');
        link.href = url;
        link.download = 'animation.forge';
        link.click();
        
        URL.revokeObjectURL(url);
        saveToLocalStorage();
    }

    function loadConfiguration(e: Event) {
        const input = e.target as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const configData = e.target?.result as string;
                loadConfigurationFromData(configData);
                
                // If autosave is enabled, override the existing autosave with the loaded file
                if (autosaveCheckbox.checked) {
                    localStorage.setItem(AUTOSAVE_KEY, configData);
                }
            } catch (error) {
                console.error('Error loading configuration:', error);
                alert('Error loading configuration file');
            }
        };
        reader.readAsText(file);
        input.value = ''; // Reset input for future loads
    }

    function attachDragListeners(wrapper: HTMLElement) {
        wrapper.addEventListener('dragstart', (e) => {
            const elementUnderMouse = document.elementFromPoint(e.clientX, e.clientY);
            if (
                elementUnderMouse instanceof HTMLInputElement ||
                elementUnderMouse instanceof HTMLButtonElement ||
                elementUnderMouse?.closest('.frame-duration') ||
                elementUnderMouse?.closest('.image-controls')
            ) {
                e.preventDefault();
                return;
            }
            wrapper.classList.add('dragging');
            e.dataTransfer?.setData('text/plain', '');
        });
        
        wrapper.addEventListener('dragend', () => {
            wrapper.classList.remove('dragging');
        });
    }

    // Move dragover listener to the container
    const container = document.getElementById('editor-content');
    let autoScrollInterval: number | null = null;

    imagesContainer?.addEventListener('dragover', (e) => {
        e.preventDefault();
        const draggingItem = document.querySelector('.dragging');
        if (!draggingItem || !imagesContainer) return;

        const SCROLL_SPEED = 3;
        const SCROLL_ZONE = 300;
        const dropzone = document.getElementById('editor-dropzone');
        if (!dropzone) return;

        const dropzoneRect = dropzone.getBoundingClientRect();
        const mouseY = e.clientY;

        if (autoScrollInterval) {
            clearInterval(autoScrollInterval);
            autoScrollInterval = null;
        }

        if (mouseY - dropzoneRect.top < SCROLL_ZONE) {
            autoScrollInterval = window.setInterval(() => {
                dropzone.scrollBy(0, -SCROLL_SPEED);
            }, 16);
        } else if (dropzoneRect.bottom - mouseY < SCROLL_ZONE) {
            autoScrollInterval = window.setInterval(() => {
                dropzone.scrollBy(0, SCROLL_SPEED);
            }, 16);
        }

        const siblings = Array.from(imagesContainer.querySelectorAll('.image-wrapper:not(.dragging)'));
        const nextSibling = siblings.find(sibling => {
            const rect = sibling.getBoundingClientRect();
            return mouseY < rect.top + rect.height / 2;
        });
        
        if (!nextSibling && siblings.length > 0) {
            const lastSibling = siblings[siblings.length - 1];
            const rect = lastSibling.getBoundingClientRect();
            if (mouseY > rect.bottom) {
                imagesContainer.appendChild(draggingItem);
                return;
            }
        }
        
        imagesContainer.insertBefore(draggingItem, nextSibling || null);
    });

    container?.addEventListener('dragend', () => {
        if (autoScrollInterval) {
            clearInterval(autoScrollInterval);
            autoScrollInterval = null;
        }
    });

    function createDuplicateHandler(wrapper: HTMLElement) {
        return () => {
            const newWrapper = wrapper.cloneNode(true) as HTMLElement;
            
            // Copy the frame duration from the original
            const originalDurationInput = wrapper.querySelector('.frame-duration input') as HTMLInputElement;
            const newDurationInput = newWrapper.querySelector('.frame-duration input') as HTMLInputElement;
            if (originalDurationInput && newDurationInput) {
                newDurationInput.value = originalDurationInput.value;
            }

            // Re-attach all event listeners
            newWrapper.draggable = true;
            attachDragListeners(newWrapper);

            // Re-attach button click handlers
            const newDuplicateBtn = newWrapper.querySelector('.duplicate-button');
            if (newDuplicateBtn) {
                (newDuplicateBtn as HTMLButtonElement).onclick = createDuplicateHandler(newWrapper);
            }
            
            const newDeleteBtn = newWrapper.querySelector('.delete-button');
            if (newDeleteBtn) {
                (newDeleteBtn as HTMLButtonElement).onclick = () => newWrapper.remove();
            }

            imagesContainer?.appendChild(newWrapper);
            setTimeout(saveToLocalStorage, 0);
        };
    }

    // Helper function to load configuration from data string
    function loadConfigurationFromData(configData: string) {
        const config = JSON.parse(configData);
        
        // Clear existing images
        if (imagesContainer) {
            imagesContainer.innerHTML = '';
        }

        // Remove preview if it exists
        const previewSection = document.getElementById('preview-section');
        if (previewSection) {
            previewSection.remove();
        }

        // Load each frame
        for (const frame of config.frames) {
            const wrapper = document.createElement('div');
            wrapper.className = 'image-wrapper';
            wrapper.draggable = true;
            
            // Re-attach drag event listeners
            attachDragListeners(wrapper);

            const imageContent = document.createElement('div');
            imageContent.className = 'image-content';
            
            const img = document.createElement('img');
            img.src = frame.imageData;
            
            const durationContainer = document.createElement('div');
            durationContainer.className = 'frame-duration';
            
            const durationInput = document.createElement('input');
            durationInput.type = 'number';
            durationInput.value = frame.duration.toString();
            durationInput.min = '1';
            
            const durationLabel = document.createElement('span');
            durationLabel.textContent = 'ms';
            
            durationContainer.appendChild(durationInput);
            durationContainer.appendChild(durationLabel);
            
            const controls = document.createElement('div');
            controls.className = 'image-controls';
            
            const duplicateBtn = document.createElement('button');
            duplicateBtn.className = 'duplicate-button';
            duplicateBtn.title = 'Duplicate';
            duplicateBtn.onclick = createDuplicateHandler(wrapper);
            
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'delete-button';
            deleteBtn.title = 'Delete';
            deleteBtn.onclick = () => wrapper.remove();
            
            controls.appendChild(duplicateBtn);
            controls.appendChild(deleteBtn);
            
            imageContent.appendChild(img);
            imageContent.appendChild(durationContainer);
            imageContent.appendChild(controls);
            wrapper.appendChild(imageContent);
            imagesContainer?.appendChild(wrapper);
        }
    }

    // Function to save current state to localStorage
    function saveToLocalStorage() {
        if (!autosaveCheckbox.checked) return;

        const frames = Array.from(document.querySelectorAll('.image-wrapper')).map(wrapper => {
            const img = wrapper.querySelector('img');
            const durationInput = wrapper.querySelector('.frame-duration input') as HTMLInputElement;
            return {
                imageData: img?.src || '',
                duration: parseInt(durationInput?.value || '120', 10)
            };
        });

        const config = {
            version: 1,
            frames: frames
        };

        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(config));
    }

    // Keep the existing event listeners
    imagesContainer?.addEventListener('dragend', () => saveToLocalStorage());
    imagesContainer?.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.matches('.delete-button, .duplicate-button')) {
            setTimeout(saveToLocalStorage, 0);
        }
    });
    imagesContainer?.addEventListener('change', (e) => {
        const target = e.target as HTMLElement;
        if (target.matches('.frame-duration input')) {
            saveToLocalStorage();
        }
    });
});