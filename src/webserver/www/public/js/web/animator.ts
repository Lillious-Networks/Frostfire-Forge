/**
 * Animation Metadata Tool
 * Complete animation editor with frame-by-frame timeline control
 */

// ===== TYPE DECLARATIONS =====

declare global {
  interface Window {
    showSaveFilePicker?: (options?: {
      suggestedName?: string;
      startIn?: string;
      types?: Array<{
        description: string;
        accept: { [mimeType: string]: string[] };
      }>;
    }) => Promise<FileSystemFileHandle>;
  }

  interface FileSystemFileHandle {
    createWritable(): Promise<FileSystemWritableFileStream>;
  }

  interface FileSystemWritableFileStream {
    write(data: string | BufferSource | Blob): Promise<void>;
    close(): Promise<void>;
  }
}

// ===== INTERFACES =====

interface AnimationMetadata {
  name: string;
  imageSource: string;
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
  animations: {
    [animationName: string]: {
      directions: {
        [direction: string]: Direction;
      };
    };
  };
}

interface Direction {
  frames: TimelineFrame[];
  loop: boolean;
  offset: {
    x: number;
    y: number;
  };
}

interface TimelineFrame {
  frameIndex: number;
  duration: number;
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
}

interface SplitFrame {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

// ===== MAIN CLASS =====

class AnimatorTool {
  // Metadata
  private metadata: AnimationMetadata;
  private currentImage: HTMLImageElement | null = null;
  private currentImageDataURL: string | null = null;

  // Split frames (from spritesheet)
  private splitFrames: SplitFrame[] = [];

  // Canvas elements
  private previewCanvas: HTMLCanvasElement;
  private previewCtx: CanvasRenderingContext2D;
  private gridCanvas: HTMLCanvasElement;
  private gridCtx: CanvasRenderingContext2D;

  // Grid state
  private gridZoom: number = 3;
  private readonly minZoom: number = 1;
  private readonly maxZoom: number = 3;
  private gridPanX: number = 0;
  private gridPanY: number = 0;
  private gridCellSize: number = 64;
  private readonly maxCoordinateDistance: number = 500;

  // Drag state (for grid canvas)
  private isDraggingFrame: boolean = false;
  private draggedFrameIndex: number | null = null;
  private dragOffsetX: number = 0;
  private dragOffsetY: number = 0;

  // Drag state (for timeline reordering)
  private draggedTimelineElement: HTMLElement | null = null;
  private draggedTimelineIndex: number = -1;
  private dragOverTargetIndex: number = -1;
  private dragOverMouseSide: 'before' | 'after' = 'before';

  // Playback state
  private isPlaying: boolean = false;
  private playbackFrame: number = 0;
  private playbackStartTime: number = 0;
  private playbackAnimationId: number | null = null;

  // Autosave
  private autosaveEnabled: boolean = false;
  private autosaveKey: string = 'animator_autosave';
  private isRestoringAutosave: boolean = false;

  // Current selection
  private selectedAnimation: string = '';
  private selectedDirection: string = '';
  private selectedTimelineFrame: number | null = null;
  private editingAnimationName: string | null = null;

  // Undo/Redo state
  private undoStack: Array<{
    type: 'frames' | 'coords';
    animation: string;
    direction: string;
    frameIndex?: number;
    data: any;
  }> = [];
  private redoStack: Array<{
    type: 'frames' | 'coords';
    animation: string;
    direction: string;
    frameIndex?: number;
    data: any;
  }> = [];
  private readonly maxUndoStackSize: number = 50;

  constructor() {
    this.metadata = this.createEmptyMetadata();

    // Get canvas elements
    this.previewCanvas = document.getElementById('spritesheet-preview-canvas') as HTMLCanvasElement;
    this.previewCtx = this.previewCanvas.getContext('2d')!;
    this.gridCanvas = document.getElementById('timeline-grid-canvas') as HTMLCanvasElement;
    this.gridCtx = this.gridCanvas.getContext('2d')!;

    // Disable image smoothing for crisp pixel art
    this.previewCtx.imageSmoothingEnabled = false;
    this.gridCtx.imageSmoothingEnabled = false;

    // Initialize grid canvas size (will be dynamically sized by CSS)
    const container = this.gridCanvas.parentElement;
    if (container) {
      this.gridCanvas.width = container.clientWidth || 800;
      this.gridCanvas.height = container.clientHeight || 600;
    } else {
      this.gridCanvas.width = 800;
      this.gridCanvas.height = 600;
    }

    // Check if autosave exists before initializing UI
    const hasAutosave = localStorage.getItem(this.autosaveKey) !== null;
    if (hasAutosave) {
      this.isRestoringAutosave = true;
    }

    this.initializeEventListeners();
    this.initializeUI();
    this.restoreAutosave();
  }

  private initializeUI(): void {
    // Hide preview canvas initially
    this.previewCanvas.style.display = 'none';

    // Disable export button initially
    const exportBtn = document.getElementById('export-json-btn') as HTMLButtonElement;
    if (exportBtn) exportBtn.disabled = true;

    // Hide direction select initially
    const directionContainer = document.getElementById('direction-select-container');
    if (directionContainer) directionContainer.style.display = 'none';

    // Update animation and direction selects to reflect empty state
    this.updateAnimationSelect();
    this.updateDirectionSelect();

    // Render initial states with placeholders
    this.renderFramesGrid();
    this.renderTimelineSequence();
    this.renderGridCanvas();
    this.updatePlaybackButtonState();
    this.updateTimelineButtonState();
    this.updateSplitFramesButtonState();
    this.updatePlaybackDisplay();
  }

  private createEmptyMetadata(): AnimationMetadata {
    return {
      name: '',
      imageSource: '',
      frameWidth: 64,
      frameHeight: 64,
      columns: 0,
      rows: 0,
      animations: {}
    };
  }

  // This will be expanded in subsequent features
  private initializeEventListeners(): void {
    // Load image button (in placeholder)
    document.getElementById('load-image-btn-alt')?.addEventListener('click', () => this.loadImage());

    // Frame width/height inputs
    document.getElementById('frame-width')?.addEventListener('input', (e) => {
      this.metadata.frameWidth = parseInt((e.target as HTMLInputElement).value) || 64;
      this.drawSpritesheetPreview();
      this.triggerAutosave();
    });
    document.getElementById('frame-height')?.addEventListener('input', (e) => {
      this.metadata.frameHeight = parseInt((e.target as HTMLInputElement).value) || 64;
      this.drawSpritesheetPreview();
      this.triggerAutosave();
    });

    // Columns/rows inputs
    document.getElementById('columns')?.addEventListener('input', (e) => {
      this.metadata.columns = parseInt((e.target as HTMLInputElement).value) || 0;
      this.drawSpritesheetPreview();
      this.triggerAutosave();
    });
    document.getElementById('rows')?.addEventListener('input', (e) => {
      this.metadata.rows = parseInt((e.target as HTMLInputElement).value) || 0;
      this.drawSpritesheetPreview();
      this.triggerAutosave();
    });

    // Split frames button
    document.getElementById('split-frames-btn')?.addEventListener('click', () => this.splitFramesFromImage());

    // Autosave checkbox
    document.getElementById('autosave-checkbox')?.addEventListener('change', (e) => {
      this.autosaveEnabled = (e.target as HTMLInputElement).checked;
      if (this.autosaveEnabled) {
        this.performAutosave();
        this.showNotification('Autosave enabled', 'success');
      } else {
        this.showNotification('Autosave disabled', 'success');
      }
    });

    // New/Import/Export/Reset buttons
    document.getElementById('new-metadata-btn')?.addEventListener('click', () => this.newMetadata());
    document.getElementById('import-json-input')?.addEventListener('change', async (e) => await this.importJSON(e));
    document.getElementById('export-json-btn')?.addEventListener('click', () => this.exportJSON());
    document.getElementById('reset-btn')?.addEventListener('click', () => this.resetEverything());

    // Metadata inputs
    document.getElementById('metadata-name')?.addEventListener('input', (e) => {
      this.metadata.name = (e.target as HTMLInputElement).value;
      this.triggerAutosave();
    });
    document.getElementById('image-source')?.addEventListener('input', (e) => {
      this.metadata.imageSource = (e.target as HTMLInputElement).value;
      this.triggerAutosave();
    });

    // Animation management
    document.getElementById('add-animation-btn')?.addEventListener('click', () => this.showAnimationModal());
    document.getElementById('edit-animation-btn')?.addEventListener('click', () => this.editCurrentAnimation());
    document.getElementById('delete-animation-btn')?.addEventListener('click', () => this.deleteCurrentAnimation());
    document.getElementById('animation-select')?.addEventListener('change', (e) => {
      if (this.isRestoringAutosave) return;
      this.selectedAnimation = (e.target as HTMLSelectElement).value;
      this.onAnimationChange();
    });

    // Direction management
    document.getElementById('add-direction-btn')?.addEventListener('click', () => this.showDirectionModal());
    document.getElementById('edit-direction-btn')?.addEventListener('click', () => this.editCurrentDirection());
    document.getElementById('delete-direction-btn')?.addEventListener('click', () => this.deleteCurrentDirection());
    document.getElementById('direction-select')?.addEventListener('change', (e) => {
      if (this.isRestoringAutosave) return;
      this.selectedDirection = (e.target as HTMLSelectElement).value;
      this.onDirectionChange();
    });

    // Timeline controls
    document.getElementById('clear-timeline-btn')?.addEventListener('click', () => this.clearTimeline());
    document.getElementById('reset-position-btn')?.addEventListener('click', () => this.resetAllFramePositions());

    // Frame sequence container (for drag & drop)
    const frameSeqContainer = document.getElementById('frame-sequence-list');
    if (frameSeqContainer) {
      frameSeqContainer.addEventListener('dragover', (e) => {
        e.preventDefault();
        // Check if it's a reorder operation or adding a new frame
        const isReorder = e.dataTransfer!.types.includes('timeline-reorder');
        e.dataTransfer!.dropEffect = isReorder ? 'move' : 'copy';
      });
      frameSeqContainer.addEventListener('drop', (e) => {
        // Check if this is a timeline reorder operation
        const reorderData = e.dataTransfer!.getData('timeline-reorder');

        if (reorderData) {
          // Handle reordering at container level since drop events fire here
          e.preventDefault();

          const fromIndex = parseInt(reorderData);
          if (isNaN(fromIndex)) return;

          // Use the target info stored during dragover
          if (this.dragOverTargetIndex === -1) return;

          const targetIndex = this.dragOverTargetIndex;
          const direction = this.getCurrentDirection();
          if (!direction) return;

          // Calculate drop position based on stored dragover info
          let toIndex = targetIndex;
          if (this.dragOverMouseSide === 'after') {
            toIndex = targetIndex + 1;
          }
          if (fromIndex < toIndex) {
            toIndex--;
          }

          if (fromIndex !== toIndex) {
            this.pushUndoState('frames', JSON.parse(JSON.stringify(direction.frames)));

            const [movedFrame] = direction.frames.splice(fromIndex, 1);
            direction.frames.splice(toIndex, 0, movedFrame);

            // Adjust selected frame index
            if (this.selectedTimelineFrame === fromIndex) {
              this.selectedTimelineFrame = toIndex;
            } else if (fromIndex < this.selectedTimelineFrame! && toIndex >= this.selectedTimelineFrame!) {
              this.selectedTimelineFrame!--;
            } else if (fromIndex > this.selectedTimelineFrame! && toIndex <= this.selectedTimelineFrame!) {
              this.selectedTimelineFrame!++;
            }

            this.renderTimelineSequence();
            this.renderTimelineScrubber();
            this.renderGridCanvas();
            this.updatePlaybackDisplay();
            this.triggerAutosave();
          }

          return;
        }

        // Not a reorder - handle adding frame from grid
        e.preventDefault();
        const frameIndex = parseInt(e.dataTransfer!.getData('frameIndex'));
        if (!isNaN(frameIndex)) {
          this.addFrameToTimeline(frameIndex);
        }
      });
    }

    // Timeline grid container (for drag & drop)
    const timelineGridContainer = document.getElementById('timeline-grid-container');
    if (timelineGridContainer) {
      timelineGridContainer.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'copy';
      });
      timelineGridContainer.addEventListener('drop', (e) => {
        e.preventDefault();
        const frameIndex = parseInt(e.dataTransfer!.getData('frameIndex'));
        if (!isNaN(frameIndex)) {
          this.addFrameToTimeline(frameIndex);
        }
      });
    }

    // Modal close buttons
    document.querySelectorAll('.modal-close').forEach((btn) => {
      btn.addEventListener('click', () => this.closeAllModals());
    });

    // Animation modal save
    document.getElementById('save-animation-btn')?.addEventListener('click', () => this.saveAnimation());

    // Direction modal save
    document.getElementById('save-direction-btn')?.addEventListener('click', () => this.saveDirection());

    // Grid canvas zoom and pan
    this.gridCanvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomSpeed = 0.1;
      const delta = e.deltaY > 0 ? -zoomSpeed : zoomSpeed;
      this.gridZoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.gridZoom + delta));
      // Reset pan to keep everything centered
      this.gridPanX = 0;
      this.gridPanY = 0;
      this.renderGridCanvas();
    });

    let isPanning = false;
    let lastPanX = 0;
    let lastPanY = 0;

    this.gridCanvas.addEventListener('mousedown', (e) => {
      const rect = this.gridCanvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      if (e.button === 0 && !e.shiftKey) { // Left mouse for dragging frames
        // Disable interactions during playback
        if (this.isPlaying) return;

        // Check if clicking on coordinate label first
        if (this.isClickOnCoordinateLabel(mouseX, mouseY)) {
          this.editCoordinates();
          e.preventDefault();
          return;
        }

        const frameIndex = this.getFrameAtPosition(mouseX, mouseY);
        if (frameIndex !== null) {
          this.isDraggingFrame = true;
          this.draggedFrameIndex = frameIndex;

          const direction = this.getCurrentDirection();
          if (direction) {
            const frame = direction.frames[frameIndex];

            // Save state for undo before dragging starts
            this.pushUndoState('coords', {
              x: frame.x,
              y: frame.y,
              offsetX: frame.offsetX,
              offsetY: frame.offsetY
            }, frameIndex);

            const centerX = this.gridCanvas.width / 2 + this.gridPanX;
            const centerY = this.gridCanvas.height / 2 + this.gridPanY;
            const totalX = frame.x + frame.offsetX;
            const totalY = frame.y + frame.offsetY;
            const scaledWidth = this.metadata.frameWidth * this.gridZoom;
            const scaledHeight = this.metadata.frameHeight * this.gridZoom;
            const frameX = centerX + (totalX * this.gridZoom) - scaledWidth / 2;
            const frameY = centerY + (totalY * this.gridZoom) - scaledHeight / 2;
            this.dragOffsetX = mouseX - frameX;
            this.dragOffsetY = mouseY - frameY;
          }
          e.preventDefault();
          return;
        }
      }

      if (e.button === 0 && e.shiftKey) { // Shift+Left mouse for panning
        isPanning = true;
        lastPanX = e.clientX;
        lastPanY = e.clientY;
        e.preventDefault();
      }
    });

    this.gridCanvas.addEventListener('mousemove', (e) => {
      const rect = this.gridCanvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      if (this.isDraggingFrame && this.draggedFrameIndex !== null) {
        const direction = this.getCurrentDirection();
        if (direction) {
          const frame = direction.frames[this.draggedFrameIndex];
          const centerX = this.gridCanvas.width / 2 + this.gridPanX;
          const centerY = this.gridCanvas.height / 2 + this.gridPanY;
          const scaledWidth = this.metadata.frameWidth * this.gridZoom;
          const scaledHeight = this.metadata.frameHeight * this.gridZoom;

          // Calculate new frame position from mouse
          const frameX = mouseX - this.dragOffsetX;
          const frameY = mouseY - this.dragOffsetY;

          // Convert to grid coordinates (centered)
          let newTotalX = (frameX - centerX + scaledWidth / 2) / this.gridZoom;
          let newTotalY = (frameY - centerY + scaledHeight / 2) / this.gridZoom;

          // Clamp to max distance from center
          newTotalX = Math.max(-this.maxCoordinateDistance, Math.min(this.maxCoordinateDistance, newTotalX));
          newTotalY = Math.max(-this.maxCoordinateDistance, Math.min(this.maxCoordinateDistance, newTotalY));

          // Update x, y (keeping offsetX, offsetY constant) and round to whole numbers
          frame.x = Math.round(newTotalX - frame.offsetX);
          frame.y = Math.round(newTotalY - frame.offsetY);

          this.renderGridCanvas();
        }
        this.gridCanvas.style.cursor = 'grabbing';
      } else if (isPanning) {
        const dx = e.clientX - lastPanX;
        const dy = e.clientY - lastPanY;
        this.gridPanX += dx;
        this.gridPanY += dy;
        lastPanX = e.clientX;
        lastPanY = e.clientY;
        this.renderGridCanvas();
        this.gridCanvas.style.cursor = 'grabbing';
      } else {
        // Check if hovering over coordinate label
        if (this.isClickOnCoordinateLabel(mouseX, mouseY)) {
          this.gridCanvas.style.cursor = 'pointer';
        } else {
          // Check if hovering over a frame
          const frameIndex = this.getFrameAtPosition(mouseX, mouseY);
          this.gridCanvas.style.cursor = frameIndex !== null ? 'grab' : 'default';
        }
      }
    });

    this.gridCanvas.addEventListener('mouseup', (e) => {
      if (e.button === 0) {
        isPanning = false;
        this.gridCanvas.style.cursor = 'default';
      }
      if (e.button === 0) {
        if (this.isDraggingFrame) {
          this.triggerAutosave();
        }
        this.isDraggingFrame = false;
        this.draggedFrameIndex = null;

        // Update cursor based on what's under mouse
        const rect = this.gridCanvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        if (this.isClickOnCoordinateLabel(mouseX, mouseY)) {
          this.gridCanvas.style.cursor = 'pointer';
        } else {
          const frameIndex = this.getFrameAtPosition(mouseX, mouseY);
          this.gridCanvas.style.cursor = frameIndex !== null ? 'grab' : 'default';
        }
      }
    });

    this.gridCanvas.addEventListener('mouseleave', () => {
      isPanning = false;
      this.isDraggingFrame = false;
      this.draggedFrameIndex = null;
      this.gridCanvas.style.cursor = 'default';
    });

    // Playback controls
    document.getElementById('play-pause-btn')?.addEventListener('click', () => this.togglePlayPause());
    document.getElementById('stop-btn')?.addEventListener('click', () => this.stopPlayback());

    // Handle window resize to update canvas size
    window.addEventListener('resize', () => this.handleResize());

    // Keyboard shortcuts for undo/redo
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        this.undo();
      } else if (e.ctrlKey && e.key === 'y') {
        e.preventDefault();
        this.redo();
      }
    });
  }

  private handleResize(): void {
    const container = this.gridCanvas.parentElement;
    if (container) {
      const newWidth = container.clientWidth;
      const newHeight = container.clientHeight;

      if (this.gridCanvas.width !== newWidth || this.gridCanvas.height !== newHeight) {
        this.gridCanvas.width = newWidth;
        this.gridCanvas.height = newHeight;
        this.renderGridCanvas();
      }
    }
  }

  // ===== UNDO/REDO =====

  private pushUndoState(type: 'frames' | 'coords', data: any, frameIndex?: number): void {
    if (!this.selectedAnimation || !this.selectedDirection) return;

    this.undoStack.push({
      type,
      animation: this.selectedAnimation,
      direction: this.selectedDirection,
      frameIndex,
      data: JSON.parse(JSON.stringify(data)) // Deep copy
    });

    // Limit stack size
    if (this.undoStack.length > this.maxUndoStackSize) {
      this.undoStack.shift();
    }

    // Clear redo stack when new action is performed
    this.redoStack = [];
  }

  private undo(): void {
    if (this.undoStack.length === 0) {
      this.showNotification('Nothing to undo', 'info');
      return;
    }

    const state = this.undoStack.pop()!;

    // Only allow undo if we're in the same animation/direction (or same frame for coords)
    if (state.animation !== this.selectedAnimation || state.direction !== this.selectedDirection) {
      this.showNotification('Can only undo in the same animation/direction', 'warning');
      this.undoStack.push(state); // Put it back
      return;
    }

    if (state.type === 'coords' && state.frameIndex !== this.selectedTimelineFrame) {
      this.showNotification('Can only undo coords in the same frame', 'warning');
      this.undoStack.push(state); // Put it back
      return;
    }

    const direction = this.getCurrentDirection();
    if (!direction) return;

    // Save current state to redo stack
    if (state.type === 'frames') {
      this.redoStack.push({
        type: 'frames',
        animation: this.selectedAnimation,
        direction: this.selectedDirection,
        data: JSON.parse(JSON.stringify(direction.frames))
      });

      // Restore frames state
      direction.frames = state.data;
    } else if (state.type === 'coords' && state.frameIndex !== undefined) {
      const frame = direction.frames[state.frameIndex];
      if (frame) {
        this.redoStack.push({
          type: 'coords',
          animation: this.selectedAnimation,
          direction: this.selectedDirection,
          frameIndex: state.frameIndex,
          data: { x: frame.x, y: frame.y, offsetX: frame.offsetX, offsetY: frame.offsetY }
        });

        // Restore coords state
        frame.x = state.data.x;
        frame.y = state.data.y;
        frame.offsetX = state.data.offsetX;
        frame.offsetY = state.data.offsetY;
      }
    }

    this.renderTimelineSequence();
    this.renderTimelineScrubber();
    this.renderGridCanvas();
    this.updateExportButtonState();
    this.updatePlaybackButtonState();
    this.updateTimelineButtonState();
    this.updatePlaybackDisplay();
    this.triggerAutosave();
    this.showNotification('Undo', 'success');
  }

  private redo(): void {
    if (this.redoStack.length === 0) {
      this.showNotification('Nothing to redo', 'info');
      return;
    }

    const state = this.redoStack.pop()!;

    // Only allow redo if we're in the same animation/direction (or same frame for coords)
    if (state.animation !== this.selectedAnimation || state.direction !== this.selectedDirection) {
      this.showNotification('Can only redo in the same animation/direction', 'warning');
      this.redoStack.push(state); // Put it back
      return;
    }

    if (state.type === 'coords' && state.frameIndex !== this.selectedTimelineFrame) {
      this.showNotification('Can only redo coords in the same frame', 'warning');
      this.redoStack.push(state); // Put it back
      return;
    }

    const direction = this.getCurrentDirection();
    if (!direction) return;

    // Save current state to undo stack
    if (state.type === 'frames') {
      this.undoStack.push({
        type: 'frames',
        animation: this.selectedAnimation,
        direction: this.selectedDirection,
        data: JSON.parse(JSON.stringify(direction.frames))
      });

      // Restore frames state
      direction.frames = state.data;
    } else if (state.type === 'coords' && state.frameIndex !== undefined) {
      const frame = direction.frames[state.frameIndex];
      if (frame) {
        this.undoStack.push({
          type: 'coords',
          animation: this.selectedAnimation,
          direction: this.selectedDirection,
          frameIndex: state.frameIndex,
          data: { x: frame.x, y: frame.y, offsetX: frame.offsetX, offsetY: frame.offsetY }
        });

        // Restore coords state
        frame.x = state.data.x;
        frame.y = state.data.y;
        frame.offsetX = state.data.offsetX;
        frame.offsetY = state.data.offsetY;
      }
    }

    this.renderTimelineSequence();
    this.renderTimelineScrubber();
    this.renderGridCanvas();
    this.updateExportButtonState();
    this.updatePlaybackButtonState();
    this.updateTimelineButtonState();
    this.updatePlaybackDisplay();
    this.triggerAutosave();
    this.showNotification('Redo', 'success');
  }

  // ===== AUTOSAVE/RESTORE =====

  private restoreAutosave(): void {
    const saved = localStorage.getItem(this.autosaveKey);
    if (!saved) return;

    this.isRestoringAutosave = true;

    try {
      const data = JSON.parse(saved);
      this.metadata = data.metadata || this.createEmptyMetadata();
      this.splitFrames = data.splitFrames || [];
      this.currentImageDataURL = data.imageDataURL || null;
      this.gridZoom = data.gridZoom || 3;
      this.gridPanX = data.gridPanX || 0;
      this.gridPanY = data.gridPanY || 0;

      // Restore saved selections
      this.selectedAnimation = data.selectedAnimation || '';
      this.selectedDirection = data.selectedDirection || '';
      this.selectedTimelineFrame = data.selectedTimelineFrame !== undefined ? data.selectedTimelineFrame : null;

      // Validate that saved selections still exist, fallback to first available if not
      if (this.selectedAnimation) {
        if (!this.metadata.animations[this.selectedAnimation]) {
          // Animation no longer exists, fallback to first
          const animationNames = Object.keys(this.metadata.animations);
          this.selectedAnimation = animationNames.length > 0 ? animationNames[0] : '';
          this.selectedDirection = '';
          this.selectedTimelineFrame = null;
        }
      }

      if (this.selectedAnimation && this.selectedDirection) {
        const directions = this.metadata.animations[this.selectedAnimation]?.directions;
        if (!directions || !directions[this.selectedDirection]) {
          // Direction no longer exists, fallback to first
          const directionNames = directions ? Object.keys(directions) : [];
          this.selectedDirection = directionNames.length > 0 ? directionNames[0] : '';
          this.selectedTimelineFrame = null;
        }
      }

      if (this.selectedAnimation && this.selectedDirection && this.selectedTimelineFrame !== null) {
        const direction = this.metadata.animations[this.selectedAnimation]?.directions[this.selectedDirection];
        if (!direction || !direction.frames[this.selectedTimelineFrame]) {
          // Frame no longer exists, fallback to first or null
          this.selectedTimelineFrame = direction && direction.frames.length > 0 ? 0 : null;
        }
      }

      if (this.currentImageDataURL) {
        const img = new Image();
        img.onload = () => {
          this.currentImage = img;
          this.drawSpritesheetPreview();
          this.renderFramesGrid();
          this.renderTimelineSequence();
          this.renderTimelineScrubber();
          this.renderGridCanvas();
          this.updateFormFields();
          this.updateAnimationSelect();
          this.updateDirectionSelect();
          this.updateExportButtonState();
          this.updatePlaybackButtonState();
          this.updateTimelineButtonState();
          this.updateSplitFramesButtonState();
          this.updatePlaybackDisplay();
          this.showInfoPanel();
        };
        img.src = this.currentImageDataURL;
      }

      this.updateFormFields();
      this.updateAnimationSelect();
      this.updateDirectionSelect();
      this.renderFramesGrid();
      this.renderTimelineSequence();
      this.renderTimelineScrubber();
      this.renderGridCanvas();
      this.updateExportButtonState();
      this.updatePlaybackButtonState();
      this.updateTimelineButtonState();
      this.updatePlaybackDisplay();

      // Enable autosave checkbox if it was enabled
      const autosaveCheckbox = document.getElementById('autosave-checkbox') as HTMLInputElement;
      if (autosaveCheckbox && data.autosaveEnabled) {
        autosaveCheckbox.checked = true;
        this.autosaveEnabled = true;
      }

      // Show notification after restoration is complete
      const timestamp = data.timestamp;
      let timeText = '';
      if (timestamp) {
        const savedDate = new Date(timestamp);
        const now = new Date();
        const diffMs = now.getTime() - savedDate.getTime();
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMins < 1) {
          timeText = 'just now';
        } else if (diffMins < 60) {
          timeText = `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
        } else if (diffHours < 24) {
          timeText = `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
        } else if (diffDays < 7) {
          timeText = `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
        } else {
          timeText = savedDate.toLocaleString();
        }
      }

      const message = timeText ? `Autosave restored from ${timeText}` : 'Autosave restored';
      this.showNotification(message, 'success');

    } catch (error) {
      console.error('Failed to restore autosave:', error);
      this.showNotification('Failed to restore autosave', 'error');
    } finally {
      this.isRestoringAutosave = false;
    }
  }

  // ===== EXPORT/IMPORT/RESET =====

  private async exportJSON(): Promise<void> {
    if (!this.metadata.name) {
      this.showNotification('Please enter a name before exporting.', 'warning');
      return;
    }

    // Convert internal format to export format
    const exportMetadata: any = {
      name: this.metadata.name,
      imageSource: this.metadata.imageSource,
      frameWidth: this.metadata.frameWidth,
      frameHeight: this.metadata.frameHeight,
      columns: this.metadata.columns,
      rows: this.metadata.rows,
      animations: {}
    };

    // Convert TimelineFrame arrays to simple number arrays
    for (const [animName, animData] of Object.entries(this.metadata.animations)) {
      exportMetadata.animations[animName] = {
        directions: {}
      };

      for (const [dirName, dirData] of Object.entries(animData.directions)) {
        // Calculate average duration from timeline frames
        const avgDuration = dirData.frames.length > 0
          ? Math.round(dirData.frames.reduce((sum, f) => sum + f.duration, 0) / dirData.frames.length)
          : 150;

        exportMetadata.animations[animName].directions[dirName] = {
          frames: dirData.frames.map(f => f.frameIndex),
          frameDuration: avgDuration,
          loop: dirData.loop,
          offset: dirData.offset
        };
      }
    }

    const json = JSON.stringify(exportMetadata, null, 2);

    try {
      if (!window.showSaveFilePicker) {
        throw new Error('File System Access API not supported');
      }

      const fileHandle = await window.showSaveFilePicker({
        suggestedName: `${this.metadata.name}.json`,
        startIn: 'documents',
        types: [{
          description: 'JSON Files',
          accept: { 'application/json': ['.json'] }
        }]
      });

      const writable = await fileHandle.createWritable();
      await writable.write(json);
      await writable.close();

      this.showNotification('JSON exported successfully!', 'success');
    } catch (error: any) {
      if (error.name === 'AbortError') {
        return;
      }

      // Fallback to traditional download
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${this.metadata.name}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      this.showNotification('JSON exported successfully!', 'success');
    }
  }

  private async importJSON(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const imported = JSON.parse(e.target?.result as string);

        // Reset everything first
        this.currentImage = null;
        this.currentImageDataURL = null;
        this.splitFrames = [];
        this.selectedAnimation = '';
        this.selectedDirection = '';
        this.selectedTimelineFrame = null;
        this.gridZoom = 3;
        this.gridPanX = 0;
        this.gridPanY = 0;

        // Hide preview canvas and show placeholder
        this.previewCanvas.style.display = 'none';
        const placeholder = document.getElementById('spritesheet-preview-placeholder');
        if (placeholder) placeholder.style.display = 'flex';

        // Convert imported format to internal format
        this.metadata = {
          name: imported.name || '',
          imageSource: imported.imageSource || '',
          frameWidth: imported.frameWidth || 64,
          frameHeight: imported.frameHeight || 64,
          columns: imported.columns || 0,
          rows: imported.rows || 0,
          animations: {}
        };

        // Convert simple number arrays to TimelineFrame arrays
        for (const [animName, animData] of Object.entries(imported.animations || {})) {
          this.metadata.animations[animName] = {
            directions: {}
          };

          const directions = (animData as any).directions || {};
          for (const [dirName, dirData] of Object.entries(directions)) {
            const dir = dirData as any;
            const dirOffset = dir.offset || { x: 0, y: 0 };

            // Clamp direction offset to max distance
            let defaultX = dirOffset.x;
            let defaultY = dirOffset.y;
            defaultX = Math.max(-this.maxCoordinateDistance, Math.min(this.maxCoordinateDistance, defaultX));
            defaultY = Math.max(-this.maxCoordinateDistance, Math.min(this.maxCoordinateDistance, defaultY));

            this.metadata.animations[animName].directions[dirName] = {
              frames: (dir.frames || []).map((frameIndex: number) => ({
                frameIndex,
                duration: dir.frameDuration || 150,
                x: defaultX,
                y: defaultY,
                offsetX: 0,
                offsetY: 0
              })),
              loop: dir.loop || false,
              offset: { x: defaultX, y: defaultY }
            };
          }
        }

        // Auto-select first animation and direction
        const animationNames = Object.keys(this.metadata.animations);
        if (animationNames.length > 0) {
          this.selectedAnimation = animationNames[0];
          const directionNames = Object.keys(this.metadata.animations[this.selectedAnimation].directions);
          if (directionNames.length > 0) {
            this.selectedDirection = directionNames[0];
            // Auto-select first frame if it exists
            const direction = this.metadata.animations[this.selectedAnimation].directions[this.selectedDirection];
            if (direction && direction.frames.length > 0) {
              this.selectedTimelineFrame = 0;
            }
          }
        }

        // Update all UI
        this.updateFormFields();
        this.updateAnimationSelect();
        this.updateDirectionSelect();

        // Render empty states (but not timeline - that needs spritesheet)
        this.renderFramesGrid();
        this.renderGridCanvas();

        this.updateExportButtonState();

        // Prompt to load spritesheet image
        const shouldLoadImage = await this.showConfirm(
          'Spritesheet Lookup',
          `Import complete! Locate the spritesheet image${this.metadata.imageSource ? ` (${this.metadata.imageSource})` : ''} to continue.`
        );

        if (shouldLoadImage) {
          this.loadImageForImport();
        } else {
          this.resetAfterImportCancel();
        }

        // Reset file input
        (event.target as HTMLInputElement).value = '';
        this.triggerAutosave();
      } catch (error) {
        this.showNotification('Failed to import JSON: ' + error, 'error');
      }
    };
    reader.readAsText(file);
  }

  private loadImageForImport(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/jpg,image/webp';

    let fileSelected = false;
    let resetCalled = false;

    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        fileSelected = true;
        const reader = new FileReader();
        reader.onload = async (event) => {
          const img = new Image();
          img.onload = async () => {
            this.currentImage = img;
            this.currentImageDataURL = event.target?.result as string;

            this.drawSpritesheetPreview();
            this.showInfoPanel();
            this.updateSplitFramesButtonState();
            this.triggerAutosave();

            // Auto-split frames if we have grid info
            if (this.metadata.columns > 0 && this.metadata.rows > 0) {
              this.splitFramesFromImage();
            }

            // Render timeline and grid canvas to show frames
            this.renderTimelineSequence();
            this.renderTimelineScrubber();
            this.renderGridCanvas();

            // Update all button states
            this.updateExportButtonState();
            this.updatePlaybackButtonState();
            this.updateTimelineButtonState();
          };
          img.src = event.target?.result as string;
        };
        reader.readAsDataURL(file);
      }
    };

    // Handle cancellation - reset if no file was selected
    input.addEventListener('cancel', () => {
      if (!resetCalled) {
        resetCalled = true;
        this.resetAfterImportCancel();
      }
    });

    // Fallback for browsers that don't support cancel event
    setTimeout(() => {
      document.body.onfocus = () => {
        setTimeout(() => {
          if (!fileSelected && !resetCalled) {
            resetCalled = true;
            this.resetAfterImportCancel();
          }
          document.body.onfocus = null;
        }, 300);
      };
    }, 100);

    input.click();
  }

  private resetAfterImportCancel(): void {
    // Reset everything if user doesn't load spritesheet
    this.metadata = this.createEmptyMetadata();
    this.currentImage = null;
    this.currentImageDataURL = null;
    this.splitFrames = [];
    this.selectedAnimation = '';
    this.selectedDirection = '';
    this.selectedTimelineFrame = null;

    // Hide info panel
    const infoPanel = document.getElementById('info-panel');
    if (infoPanel) infoPanel.style.display = 'none';

    // Show placeholder
    const placeholder = document.getElementById('spritesheet-preview-placeholder');
    if (placeholder) placeholder.style.display = 'flex';
    this.previewCanvas.style.display = 'none';

    this.updateFormFields();
    this.updateAnimationSelect();
    this.updateDirectionSelect();
    this.renderFramesGrid();
    this.renderTimelineSequence();
    this.renderTimelineScrubber();
    this.renderGridCanvas();
    this.updateExportButtonState();

    this.showNotification('Import cancelled - spritesheet required', 'warning');
  }

  private async newMetadata(): Promise<void> {
    const shouldContinue = await this.showConfirm(
      'Create New Metadata',
      'Are you sure? Current work will be lost if not saved.'
    );

    if (!shouldContinue) return;

    this.metadata = this.createEmptyMetadata();
    this.currentImage = null;
    this.currentImageDataURL = null;
    this.splitFrames = [];
    this.selectedAnimation = '';
    this.selectedDirection = '';
    this.selectedTimelineFrame = null;

    // Hide info panel
    const infoPanel = document.getElementById('info-panel');
    if (infoPanel) infoPanel.style.display = 'none';

    // Show placeholder
    this.previewCanvas.style.display = 'none';
    const placeholder = document.getElementById('spritesheet-preview-placeholder');
    if (placeholder) placeholder.style.display = 'flex';

    this.updateFormFields();
    this.updateAnimationSelect();
    this.updateDirectionSelect();
    this.renderFramesGrid();
    this.renderTimelineSequence();
    this.renderTimelineScrubber();
    this.renderGridCanvas();
    this.updateExportButtonState();
    this.updatePlaybackButtonState();
    this.updateTimelineButtonState();
    this.updateSplitFramesButtonState();
    this.updatePlaybackDisplay();
    this.triggerAutosave();
  }

  private async resetEverything(): Promise<void> {
    const shouldReset = await this.showConfirm(
      'Reset Everything',
      'This will clear ALL data including autosave. Are you sure?'
    );

    if (!shouldReset) return;

    localStorage.removeItem(this.autosaveKey);
    this.metadata = this.createEmptyMetadata();
    this.currentImage = null;
    this.currentImageDataURL = null;
    this.splitFrames = [];
    this.selectedAnimation = '';
    this.selectedDirection = '';
    this.selectedTimelineFrame = null;
    this.autosaveEnabled = false;
    this.gridZoom = 3;
    this.gridPanX = 0;
    this.gridPanY = 0;

    const autosaveCheckbox = document.getElementById('autosave-checkbox') as HTMLInputElement;
    if (autosaveCheckbox) autosaveCheckbox.checked = false;

    // Hide info panel
    const infoPanel = document.getElementById('info-panel');
    if (infoPanel) infoPanel.style.display = 'none';

    // Show placeholder
    this.previewCanvas.style.display = 'none';
    const placeholder = document.getElementById('spritesheet-preview-placeholder');
    if (placeholder) placeholder.style.display = 'flex';

    this.updateFormFields();
    this.updateAnimationSelect();
    this.updateDirectionSelect();
    this.renderFramesGrid();
    this.renderTimelineSequence();
    this.renderTimelineScrubber();
    this.renderGridCanvas();
    this.updateExportButtonState();
    this.updatePlaybackButtonState();
    this.updateTimelineButtonState();
    this.updateSplitFramesButtonState();
    this.updatePlaybackDisplay();
  }

  // ===== IMAGE LOADING =====

  private loadImage(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/jpg,image/webp';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        // Auto-populate Image Source with the file name
        if (!this.metadata.imageSource) {
          this.metadata.imageSource = file.name;
        }

        const reader = new FileReader();
        reader.onload = async (event) => {
          const img = new Image();
          img.onload = async () => {
            this.currentImage = img;
            this.currentImageDataURL = event.target?.result as string;

            // Auto-detect grid dimensions
            let autoDetected = false;
            const frameWidth = this.metadata.frameWidth;
            const frameHeight = this.metadata.frameHeight;

            if (frameWidth > 0 && frameHeight > 0) {
              const cols = Math.floor(img.width / frameWidth);
              const rows = Math.floor(img.height / frameHeight);

              if (cols > 0 && rows > 0 && this.metadata.columns === 0 && this.metadata.rows === 0) {
                this.metadata.columns = cols;
                this.metadata.rows = rows;
                autoDetected = true;
              }
            }

            this.drawSpritesheetPreview();
            this.updateFormFields();
            this.showInfoPanel();
            this.updateSplitFramesButtonState();
            this.triggerAutosave();

            // Ask to auto-split if grid was detected
            if (autoDetected) {
              const shouldSplit = await this.showConfirm(
                'Auto-Split Frames?',
                `Detected ${this.metadata.columns}x${this.metadata.rows} grid. Would you like to automatically split frames?`
              );
              if (shouldSplit) {
                this.splitFramesFromImage();
              }
            }

            // Render the grid canvas to show selected frame
            this.renderGridCanvas();
          };
          img.src = event.target?.result as string;
        };
        reader.readAsDataURL(file);
      }
    };
    input.click();
  }

  private drawSpritesheetPreview(): void {
    if (!this.currentImage) return;

    const placeholder = document.getElementById('spritesheet-preview-placeholder');
    if (placeholder) placeholder.style.display = 'none';

    this.previewCanvas.style.display = 'block';
    this.previewCanvas.width = this.currentImage.width;
    this.previewCanvas.height = this.currentImage.height;

    this.previewCtx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
    this.previewCtx.drawImage(this.currentImage, 0, 0);
  }

  private updateFormFields(): void {
    (document.getElementById('frame-width') as HTMLInputElement).value = this.metadata.frameWidth.toString();
    (document.getElementById('frame-height') as HTMLInputElement).value = this.metadata.frameHeight.toString();
    (document.getElementById('columns') as HTMLInputElement).value = this.metadata.columns === 0 ? '' : this.metadata.columns.toString();
    (document.getElementById('rows') as HTMLInputElement).value = this.metadata.rows === 0 ? '' : this.metadata.rows.toString();
    (document.getElementById('metadata-name') as HTMLInputElement).value = this.metadata.name;
    (document.getElementById('image-source') as HTMLInputElement).value = this.metadata.imageSource;
  }

  private showInfoPanel(): void {
    const infoPanel = document.getElementById('info-panel');
    if (infoPanel) infoPanel.style.display = 'block';
  }

  private triggerAutosave(): void {
    if (this.autosaveEnabled) {
      this.performAutosave();
    }
  }

  private performAutosave(): void {
    if (!this.autosaveEnabled) return;

    try {
      const data = {
        metadata: this.metadata,
        splitFrames: this.splitFrames,
        imageDataURL: this.currentImageDataURL,
        gridZoom: this.gridZoom,
        gridPanX: this.gridPanX,
        gridPanY: this.gridPanY,
        autosaveEnabled: this.autosaveEnabled,
        selectedAnimation: this.selectedAnimation,
        selectedDirection: this.selectedDirection,
        selectedTimelineFrame: this.selectedTimelineFrame,
        timestamp: Date.now()
      };

      localStorage.setItem(this.autosaveKey, JSON.stringify(data));
    } catch (error) {
      console.error('Autosave failed:', error);
      this.showNotification('Autosave failed (data may be too large)', 'error');
    }
  }

  // ===== SPLIT FRAMES =====

  private splitFramesFromImage(): void {
    if (!this.currentImage) {
      this.showNotification('Please load an image first', 'warning');
      return;
    }

    if (this.metadata.columns === 0 || this.metadata.rows === 0) {
      this.showNotification('Please set columns and rows', 'warning');
      return;
    }

    this.splitFrames = [];
    const frameWidth = this.metadata.frameWidth;
    const frameHeight = this.metadata.frameHeight;

    let index = 0;
    for (let row = 0; row < this.metadata.rows; row++) {
      for (let col = 0; col < this.metadata.columns; col++) {
        this.splitFrames.push({
          index,
          x: col * frameWidth,
          y: row * frameHeight,
          width: frameWidth,
          height: frameHeight
        });
        index++;
      }
    }

    this.renderFramesGrid();
    this.updateSplitFramesButtonState();
    this.triggerAutosave();
  }

  private renderFramesGrid(): void {
    const container = document.getElementById('frames-grid');
    if (!container) return;

    container.innerHTML = '';

    if (!this.currentImage || this.splitFrames.length === 0) {
      container.innerHTML = '<div class="empty-message" style="color: #4b5563; font-size: 0.85em; text-align: center; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;">Load a spritesheet and click "Split Frames" to get started.</div>';
      return;
    }

    this.splitFrames.forEach((frame) => {
      const frameEl = document.createElement('div');
      frameEl.className = 'frame-item';
      frameEl.draggable = true;
      frameEl.dataset.frameIndex = frame.index.toString();

      const canvas = document.createElement('canvas');
      canvas.width = frame.width;
      canvas.height = frame.height;
      const ctx = canvas.getContext('2d')!;

      ctx.drawImage(
        this.currentImage!,
        frame.x, frame.y, frame.width, frame.height,
        0, 0, frame.width, frame.height
      );

      const label = document.createElement('span');
      label.textContent = frame.index.toString();
      label.className = 'frame-label';

      frameEl.appendChild(canvas);
      frameEl.appendChild(label);

      // Drag start handler
      frameEl.addEventListener('dragstart', (e) => {
        e.dataTransfer!.setData('frameIndex', frame.index.toString());
        e.dataTransfer!.effectAllowed = 'copy';
      });

      container.appendChild(frameEl);
    });
  }

  // ===== TIMELINE MANAGEMENT =====

  private addFrameToTimeline(frameIndex: number): void {
    if (!this.selectedAnimation || !this.selectedDirection) {
      this.showNotification('Please select an animation and direction first', 'warning');
      return;
    }

    const direction = this.getCurrentDirection();
    if (!direction) return;

    // Save state for undo
    this.pushUndoState('frames', JSON.parse(JSON.stringify(direction.frames)));

    // Use direction offset as default position, clamped to max distance
    let defaultX = direction.offset.x;
    let defaultY = direction.offset.y;
    defaultX = Math.max(-this.maxCoordinateDistance, Math.min(this.maxCoordinateDistance, defaultX));
    defaultY = Math.max(-this.maxCoordinateDistance, Math.min(this.maxCoordinateDistance, defaultY));

    direction.frames.push({
      frameIndex,
      duration: 150,
      x: defaultX,
      y: defaultY,
      offsetX: 0,
      offsetY: 0
    });

    // Auto-select the first frame if none selected
    if (this.selectedTimelineFrame === null) {
      this.selectedTimelineFrame = 0;
    }

    this.renderTimelineSequence();
    this.renderTimelineScrubber();
    this.renderGridCanvas();
    this.updateExportButtonState();
    this.updatePlaybackButtonState();
    this.updateTimelineButtonState();
    this.updatePlaybackDisplay();
    this.triggerAutosave();
  }

  private clearTimeline(): void {
    if (!this.selectedAnimation || !this.selectedDirection) return;

    const direction = this.getCurrentDirection();
    if (!direction) return;

    direction.frames = [];
    this.selectedTimelineFrame = null;
    this.renderTimelineSequence();
    this.renderTimelineScrubber();
    this.renderGridCanvas();
    this.updateExportButtonState();
    this.updatePlaybackButtonState();
    this.updateTimelineButtonState();
    this.updatePlaybackDisplay();
    this.triggerAutosave();
    this.showNotification('Timeline cleared', 'success');
  }

  private resetAllFramePositions(): void {
    if (!this.selectedAnimation || !this.selectedDirection) return;

    const direction = this.getCurrentDirection();
    if (!direction) return;

    direction.frames.forEach((frame) => {
      frame.x = 0;
      frame.y = 0;
      frame.offsetX = 0;
      frame.offsetY = 0;
    });

    this.renderGridCanvas();
    this.triggerAutosave();
    this.showNotification('All frame positions reset', 'success');
  }

  private renderTimelineSequence(): void {
    const container = document.getElementById('frame-sequence-list');
    if (!container) return;

    container.innerHTML = '';

    const direction = this.getCurrentDirection();
    if (!direction || direction.frames.length === 0) {
      container.innerHTML = '<div class="empty-message" style="color: #4b5563; font-size: 0.85em; text-align: left; width: 100%; padding: 0 12px; display: flex; align-items: center;">No frames in timeline. Drag frames here.</div>';
      return;
    }

    direction.frames.forEach((timelineFrame, index) => {
      const frameEl = document.createElement('div');
      frameEl.className = 'timeline-frame-item';
      frameEl.dataset.timelineIndex = index.toString();
      frameEl.draggable = true;
      frameEl.style.cssText = `
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        background: transparent;
        border: 1px solid #444;
        border-radius: 4px;
        margin-right: 8px;
        cursor: grab;
      `;

      if (this.selectedTimelineFrame === index) {
        frameEl.style.borderColor = '#8b5cf6';
      }

      // Frame number
      const frameNumber = document.createElement('span');
      frameNumber.textContent = timelineFrame.frameIndex.toString();
      frameNumber.style.cssText = 'color: #fff; font-weight: 500; min-width: 20px;';
      frameEl.appendChild(frameNumber);

      // Duration input (inline editable)
      const durationInput = document.createElement('input');
      durationInput.type = 'number';
      durationInput.value = timelineFrame.duration.toString();
      durationInput.min = '1';
      durationInput.style.cssText = `
        width: 60px;
        padding: 4px 6px;
        background: #1a1a2e;
        border: 1px solid #555;
        border-radius: 3px;
        color: #fff;
        font-size: 13px;
      `;
      durationInput.addEventListener('input', (e) => {
        e.stopPropagation();
        const newDuration = parseInt((e.target as HTMLInputElement).value);
        if (newDuration > 0) {
          timelineFrame.duration = newDuration;
          this.renderTimelineScrubber();
          this.triggerAutosave();
        }
      });
      durationInput.addEventListener('click', (e) => {
        e.stopPropagation();
      });
      frameEl.appendChild(durationInput);

      // ms label
      const msLabel = document.createElement('span');
      msLabel.textContent = 'ms';
      msLabel.style.cssText = 'color: #888; font-size: 12px;';
      frameEl.appendChild(msLabel);

      // Click to select
      frameEl.addEventListener('click', () => {
        if (this.isPlaying) return; // Disable selection during playback
        this.selectedTimelineFrame = index;
        this.renderTimelineSequence();
        this.renderTimelineScrubber();
        this.renderGridCanvas();
        this.updatePlaybackDisplay();
        this.triggerAutosave();
      });

      // Delete button
      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = '×';
      deleteBtn.style.cssText = `
        position: absolute;
        top: -6px;
        right: -6px;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: #ff4444;
        border: none;
        color: #fff;
        font-size: 14px;
        line-height: 1;
        cursor: pointer;
        padding: 0;
        display: flex;
        align-items: center;
        justify-content: center;
      `;
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();

        // Save state for undo
        this.pushUndoState('frames', JSON.parse(JSON.stringify(direction.frames)));

        direction.frames.splice(index, 1);

        // Adjust selected frame index after deletion
        if (direction.frames.length === 0) {
          this.selectedTimelineFrame = null;
        } else if (this.selectedTimelineFrame !== null) {
          if (this.selectedTimelineFrame >= direction.frames.length) {
            this.selectedTimelineFrame = direction.frames.length - 1;
          }
        }

        this.renderTimelineSequence();
        this.renderTimelineScrubber();
        this.renderGridCanvas();
        this.updateExportButtonState();
        this.updatePlaybackButtonState();
        this.updateTimelineButtonState();
        this.updatePlaybackDisplay();
        this.triggerAutosave();
      });
      frameEl.appendChild(deleteBtn);

      // Drag and drop handlers for reordering
      frameEl.addEventListener('dragstart', (e) => {
        this.draggedTimelineElement = frameEl;
        this.draggedTimelineIndex = index;
        frameEl.classList.add('dragging');
        e.dataTransfer!.effectAllowed = 'move';
        e.dataTransfer!.setData('timeline-reorder', index.toString());

        // Add a slight delay to allow the drag image to be created
        setTimeout(() => {
          if (this.draggedTimelineElement) {
            this.draggedTimelineElement.style.opacity = '0.3';
            this.draggedTimelineElement.style.pointerEvents = 'none';
          }
        }, 0);
      });

      frameEl.addEventListener('dragend', (e) => {
        if (this.draggedTimelineElement) {
          this.draggedTimelineElement.style.opacity = '';
          this.draggedTimelineElement.style.pointerEvents = '';
          this.draggedTimelineElement.classList.remove('dragging');
        }
        this.draggedTimelineElement = null;
        this.draggedTimelineIndex = -1;
        this.dragOverTargetIndex = -1;
        this.dragOverMouseSide = 'before';

        // Remove all placeholder classes
        document.querySelectorAll('.timeline-frame-item').forEach(el => {
          el.classList.remove('drag-over', 'drop-before', 'drop-after');
        });
      });

      frameEl.addEventListener('dragover', (e) => {
        if (this.draggedTimelineIndex === -1) return;
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'move';

        // Don't show drop indicator on the dragged element itself
        if (frameEl === this.draggedTimelineElement) return;

        // Remove previous drop indicators
        document.querySelectorAll('.timeline-frame-item').forEach(el => {
          el.classList.remove('drop-before', 'drop-after');
        });

        // Determine if we should insert before or after this element
        const rect = frameEl.getBoundingClientRect();
        const midpoint = rect.left + rect.width / 2;
        const mouseX = e.clientX;

        // Store the target info for the drop handler
        this.dragOverTargetIndex = index;
        this.dragOverMouseSide = mouseX < midpoint ? 'before' : 'after';

        if (mouseX < midpoint) {
          frameEl.classList.add('drop-before');
        } else {
          frameEl.classList.add('drop-after');
        }
      });

      container.appendChild(frameEl);
    });
  }

  private getCurrentDirection(): Direction | null {
    if (!this.selectedAnimation || !this.selectedDirection) return null;
    return this.metadata.animations[this.selectedAnimation]?.directions[this.selectedDirection] || null;
  }

  private renderTimelineScrubber(): void {
    const track = document.getElementById('timeline-track');
    if (!track) return;

    // Clear existing dots (but keep playhead if it exists)
    const existingPlayhead = track.querySelector('.timeline-playhead');
    track.innerHTML = '';
    if (existingPlayhead) {
      track.appendChild(existingPlayhead);
    }

    const direction = this.getCurrentDirection();
    if (!direction || direction.frames.length === 0) return;

    // Calculate total duration
    const totalDuration = direction.frames.reduce((sum, f) => sum + f.duration, 0);
    if (totalDuration === 0) return;

    let accumulatedTime = 0;

    direction.frames.forEach((frame, index) => {
      // Calculate position as percentage
      const position = (accumulatedTime / totalDuration) * 100;

      // Create dot container
      const dotContainer = document.createElement('div');
      dotContainer.className = 'timeline-frame-dot-container';
      dotContainer.style.left = `${position}%`;
      dotContainer.dataset.frameIndex = index.toString();

      // Create dot
      const dot = document.createElement('div');
      dot.className = 'timeline-frame-dot';
      if (index === this.selectedTimelineFrame) {
        dot.classList.add('active');
      }

      // Click to select frame
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.isPlaying) return; // Disable selection during playback
        this.selectedTimelineFrame = index;
        this.renderTimelineSequence();
        this.renderTimelineScrubber();
        this.renderGridCanvas();
        this.updatePlaybackDisplay();
        this.triggerAutosave();
      });

      // Create time label
      const timeLabel = document.createElement('span');
      timeLabel.className = 'timeline-frame-time';
      timeLabel.textContent = `${accumulatedTime}ms`;

      dotContainer.appendChild(dot);
      dotContainer.appendChild(timeLabel);
      track.appendChild(dotContainer);

      accumulatedTime += frame.duration;
    });
  }

  private updateExportButtonState(): void {
    const exportBtn = document.getElementById('export-json-btn') as HTMLButtonElement;
    if (!exportBtn) return;

    // Check if spritesheet is loaded
    if (!this.currentImage) {
      exportBtn.disabled = true;
      return;
    }

    // Check if any animation direction has at least one frame
    let hasAnyFrames = false;
    for (const animName in this.metadata.animations) {
      const animation = this.metadata.animations[animName];
      for (const dirName in animation.directions) {
        const direction = animation.directions[dirName];
        if (direction.frames.length > 0) {
          hasAnyFrames = true;
          break;
        }
      }
      if (hasAnyFrames) break;
    }

    exportBtn.disabled = !hasAnyFrames;
  }

  private updatePlaybackButtonState(): void {
    const playPauseBtn = document.getElementById('play-pause-btn') as HTMLButtonElement;
    const stopBtn = document.getElementById('stop-btn') as HTMLButtonElement;

    const direction = this.getCurrentDirection();
    const hasFrames = direction && direction.frames.length > 0;

    if (playPauseBtn) playPauseBtn.disabled = !hasFrames;
    if (stopBtn) stopBtn.disabled = !hasFrames;
  }

  private updateTimelineButtonState(): void {
    const clearBtn = document.getElementById('clear-timeline-btn') as HTMLButtonElement;
    const resetPosBtn = document.getElementById('reset-position-btn') as HTMLButtonElement;

    const direction = this.getCurrentDirection();
    const hasFrames = direction && direction.frames.length > 0;

    if (clearBtn) clearBtn.disabled = !hasFrames;
    if (resetPosBtn) resetPosBtn.disabled = !hasFrames;
  }

  private updateSplitFramesButtonState(): void {
    const splitBtn = document.getElementById('split-frames-btn') as HTMLButtonElement;
    if (!splitBtn) return;

    // Disable if no spritesheet or frames already split
    const canSplit = this.currentImage && this.splitFrames.length === 0;
    splitBtn.disabled = !canSplit;
  }

  // ===== ANIMATION & DIRECTION MANAGEMENT =====

  private showAnimationModal(editMode: boolean = false): void {
    const modal = document.getElementById('animation-modal');
    const titleEl = document.getElementById('modal-title');
    const nameInput = document.getElementById('animation-name') as HTMLInputElement;

    if (!modal || !nameInput) return;

    if (editMode && this.selectedAnimation) {
      if (titleEl) titleEl.textContent = 'Edit Animation';
      nameInput.value = this.selectedAnimation;
      this.editingAnimationName = this.selectedAnimation;
    } else {
      if (titleEl) titleEl.textContent = 'Add Animation';
      nameInput.value = '';
      this.editingAnimationName = null;
    }

    modal.style.display = 'flex';
    nameInput.focus();
  }

  private saveAnimation(): void {
    const nameInput = document.getElementById('animation-name') as HTMLInputElement;
    const animName = nameInput.value.trim();

    if (!animName) {
      this.showNotification('Please enter an animation name', 'warning');
      return;
    }

    // Edit mode: rename existing animation
    if (this.editingAnimationName) {
      // Check if new name already exists (and it's not the same as current)
      if (animName !== this.editingAnimationName && this.metadata.animations[animName]) {
        this.showNotification('Animation with this name already exists', 'warning');
        return;
      }

      // If name changed, rename the animation
      if (animName !== this.editingAnimationName) {
        this.metadata.animations[animName] = this.metadata.animations[this.editingAnimationName];
        delete this.metadata.animations[this.editingAnimationName];
        this.selectedAnimation = animName;
      }

      this.editingAnimationName = null;
    } else {
      // Add mode: create new animation
      if (this.metadata.animations[animName]) {
        this.showNotification('Animation with this name already exists', 'warning');
        return;
      }

      this.metadata.animations[animName] = { directions: {} };
      this.selectedAnimation = animName;
    }

    this.updateAnimationSelect();
    this.updateDirectionSelect();
    this.closeAllModals();
    this.triggerAutosave();
  }

  private editCurrentAnimation(): void {
    if (!this.selectedAnimation) {
      this.showNotification('Please select an animation first', 'warning');
      return;
    }
    this.showAnimationModal(true);
  }

  private async deleteCurrentAnimation(): Promise<void> {
    if (!this.selectedAnimation) {
      this.showNotification('Please select an animation first', 'warning');
      return;
    }

    const confirmed = await this.showConfirm(
      'Delete Animation',
      `Are you sure you want to delete the animation "${this.selectedAnimation}"? This cannot be undone.`
    );

    if (!confirmed) return;

    delete this.metadata.animations[this.selectedAnimation];
    this.selectedAnimation = '';
    this.selectedDirection = '';
    this.selectedTimelineFrame = null;
    this.updateAnimationSelect();
    this.updateDirectionSelect();
    this.renderTimelineSequence();
    this.renderTimelineScrubber();
    this.renderGridCanvas();
    this.updateExportButtonState();
    this.updatePlaybackButtonState();
    this.triggerAutosave();
  }

  private onAnimationChange(): void {
    this.selectedDirection = '';
    this.selectedTimelineFrame = null;

    // Auto-select first direction if it exists
    if (this.selectedAnimation) {
      const directions = this.metadata.animations[this.selectedAnimation]?.directions || {};
      const directionNames = Object.keys(directions);
      if (directionNames.length > 0) {
        this.selectedDirection = directionNames[0];
        // Auto-select first frame if it exists
        const direction = directions[this.selectedDirection];
        if (direction && direction.frames.length > 0) {
          this.selectedTimelineFrame = 0;
        }
      }
    }

    this.updateDirectionSelect();
    this.renderTimelineSequence();
    this.renderTimelineScrubber();
    this.renderGridCanvas();
    this.updatePlaybackButtonState();
    this.updatePlaybackDisplay();
    this.triggerAutosave();
  }

  private updateAnimationSelect(): void {
    const select = document.getElementById('animation-select') as HTMLSelectElement;
    const editBtn = document.getElementById('edit-animation-btn') as HTMLButtonElement;
    const deleteBtn = document.getElementById('delete-animation-btn') as HTMLButtonElement;

    if (!select) return;

    select.innerHTML = '';
    const animationNames = Object.keys(this.metadata.animations);

    if (animationNames.length === 0) {
      select.style.display = 'none';
      if (editBtn) editBtn.disabled = true;
      if (deleteBtn) deleteBtn.disabled = true;
      return;
    }

    select.style.display = 'block';
    if (editBtn) editBtn.disabled = false;
    if (deleteBtn) deleteBtn.disabled = false;

    // Prevent browser from auto-selecting first option (which triggers change event)
    select.selectedIndex = -1;

    animationNames.forEach((animName) => {
      const option = document.createElement('option');
      option.value = animName;
      option.textContent = animName;
      select.appendChild(option);
    });

    // Explicitly set the select value to the current selection
    if (this.selectedAnimation) {
      select.value = this.selectedAnimation;
    }
  }

  private showDirectionModal(editMode: boolean = false): void {
    if (!this.selectedAnimation) {
      this.showNotification('Please select an animation first', 'warning');
      return;
    }

    const modal = document.getElementById('direction-modal');
    if (!modal) return;

    if (editMode && this.selectedDirection) {
      const direction = this.getCurrentDirection();
      if (direction) {
        (document.getElementById('direction-offset-x') as HTMLInputElement).value = direction.offset.x.toString();
        (document.getElementById('direction-offset-y') as HTMLInputElement).value = direction.offset.y.toString();
        (document.getElementById('loop-checkbox') as HTMLInputElement).checked = direction.loop;
      }
    } else {
      (document.getElementById('direction-offset-x') as HTMLInputElement).value = '0';
      (document.getElementById('direction-offset-y') as HTMLInputElement).value = '0';
      (document.getElementById('loop-checkbox') as HTMLInputElement).checked = false;
    }

    modal.style.display = 'flex';
  }

  private editCurrentDirection(): void {
    if (!this.selectedDirection) {
      this.showNotification('Please select a direction first', 'warning');
      return;
    }
    this.showDirectionModal(true);
  }

  private saveDirection(): void {
    if (!this.selectedAnimation) return;

    const dirName = (document.getElementById('direction-name') as HTMLSelectElement).value;
    const offsetX = parseInt((document.getElementById('direction-offset-x') as HTMLInputElement).value) || 0;
    const offsetY = parseInt((document.getElementById('direction-offset-y') as HTMLInputElement).value) || 0;
    const loop = (document.getElementById('loop-checkbox') as HTMLInputElement).checked;

    if (!this.metadata.animations[this.selectedAnimation].directions[dirName]) {
      this.metadata.animations[this.selectedAnimation].directions[dirName] = {
        frames: [],
        loop,
        offset: { x: offsetX, y: offsetY }
      };
    } else {
      const direction = this.metadata.animations[this.selectedAnimation].directions[dirName];
      direction.loop = loop;
      direction.offset = { x: offsetX, y: offsetY };
    }

    this.selectedDirection = dirName;
    this.selectedTimelineFrame = null; // Clear selected frame for new direction
    this.updateDirectionSelect();
    this.renderTimelineSequence();
    this.renderTimelineScrubber();
    this.renderGridCanvas();
    this.updateExportButtonState();
    this.updatePlaybackButtonState();
    this.updateTimelineButtonState();
    this.updatePlaybackDisplay();
    this.closeAllModals();
    this.triggerAutosave();
  }

  private async deleteCurrentDirection(): Promise<void> {
    if (!this.selectedAnimation || !this.selectedDirection) {
      this.showNotification('Please select a direction first', 'warning');
      return;
    }

    const confirmed = await this.showConfirm(
      'Delete Direction',
      `Are you sure you want to delete the direction "${this.selectedDirection}"? This cannot be undone.`
    );

    if (!confirmed) return;

    delete this.metadata.animations[this.selectedAnimation].directions[this.selectedDirection];
    this.selectedDirection = '';
    this.selectedTimelineFrame = null;

    // Auto-select first remaining direction if any exist
    const directions = this.metadata.animations[this.selectedAnimation]?.directions || {};
    const directionNames = Object.keys(directions);
    if (directionNames.length > 0) {
      this.selectedDirection = directionNames[0];
      // Auto-select first frame if it exists
      const direction = directions[this.selectedDirection];
      if (direction && direction.frames.length > 0) {
        this.selectedTimelineFrame = 0;
      }
    }

    this.updateDirectionSelect();
    this.renderTimelineSequence();
    this.renderTimelineScrubber();
    this.renderGridCanvas();
    this.updateExportButtonState();
    this.updatePlaybackButtonState();
    this.updateTimelineButtonState();
    this.updatePlaybackDisplay();
    this.triggerAutosave();
  }

  private onDirectionChange(): void {
    const direction = this.getCurrentDirection();
    if (direction && direction.frames.length > 0) {
      this.selectedTimelineFrame = 0; // Auto-select first frame
    } else {
      this.selectedTimelineFrame = null;
    }
    this.renderTimelineSequence();
    this.renderTimelineScrubber();
    this.renderGridCanvas();
    this.updateExportButtonState();
    this.updatePlaybackButtonState();
    this.updateTimelineButtonState();
    this.updatePlaybackDisplay();
    this.triggerAutosave();
  }

  private updateDirectionSelect(): void {
    const select = document.getElementById('direction-select') as HTMLSelectElement;
    const container = document.getElementById('direction-select-container');
    const editBtn = document.getElementById('edit-direction-btn') as HTMLButtonElement;
    const deleteBtn = document.getElementById('delete-direction-btn') as HTMLButtonElement;

    if (!select || !container) return;

    select.innerHTML = '';

    if (this.selectedAnimation) {
      const directions = this.metadata.animations[this.selectedAnimation]?.directions || {};
      const directionNames = Object.keys(directions);

      if (directionNames.length === 0) {
        container.style.display = 'block';
        select.style.display = 'none';
        if (editBtn) editBtn.disabled = true;
        if (deleteBtn) deleteBtn.disabled = true;
        return;
      }

      container.style.display = 'block';
      select.style.display = 'block';
      if (editBtn) editBtn.disabled = false;
      if (deleteBtn) deleteBtn.disabled = false;

      // Prevent browser from auto-selecting first option (which triggers change event)
      select.selectedIndex = -1;

      directionNames.forEach((dirName) => {
        const option = document.createElement('option');
        option.value = dirName;
        option.textContent = dirName;
        select.appendChild(option);
      });

      // Explicitly set the select value to the current selection
      if (this.selectedDirection) {
        select.value = this.selectedDirection;
      }
    } else {
      container.style.display = 'none';
    }
  }

  private closeAllModals(): void {
    document.getElementById('animation-modal')!.style.display = 'none';
    document.getElementById('direction-modal')!.style.display = 'none';
    document.getElementById('confirm-modal')!.style.display = 'none';
    this.editingAnimationName = null;
  }

  // ===== PLAYBACK CONTROLS =====

  private togglePlayPause(): void {
    if (!this.selectedAnimation || !this.selectedDirection) {
      this.showNotification('Please select an animation and direction first', 'warning');
      return;
    }

    const direction = this.getCurrentDirection();
    if (!direction || direction.frames.length === 0) {
      this.showNotification('No frames in timeline', 'warning');
      return;
    }

    if (this.isPlaying) {
      this.pausePlayback();
    } else {
      this.startPlayback();
    }
  }

  private startPlayback(): void {
    this.isPlaying = true;
    this.playbackFrame = 0;
    this.playbackStartTime = Date.now();

    const playPauseBtn = document.getElementById('play-pause-btn');
    if (playPauseBtn) {
      playPauseBtn.textContent = '⏸';
      playPauseBtn.className = 'btn btn-pause';
    }

    // Create or show playhead
    const track = document.getElementById('timeline-track');
    if (track) {
      let playhead = track.querySelector('.timeline-playhead') as HTMLElement;
      if (!playhead) {
        playhead = document.createElement('div');
        playhead.className = 'timeline-playhead';
        track.appendChild(playhead);
      }
      playhead.style.left = '0%';
      playhead.style.display = 'block';

      // Reset all dots to normal size at start
      const dots = track.querySelectorAll('.timeline-frame-dot');
      dots.forEach((dot) => {
        (dot as HTMLElement).style.transform = 'scale(1)';
        (dot as HTMLElement).style.transition = 'none';
      });
    }

    this.playbackAnimationId = requestAnimationFrame(() => this.animatePlayback());
  }

  private pausePlayback(): void {
    this.isPlaying = false;

    const playPauseBtn = document.getElementById('play-pause-btn');
    if (playPauseBtn) {
      playPauseBtn.textContent = '▶';
      playPauseBtn.className = 'btn btn-play';
    }

    if (this.playbackAnimationId !== null) {
      cancelAnimationFrame(this.playbackAnimationId);
      this.playbackAnimationId = null;
    }

    // Hide playhead when paused
    const track = document.getElementById('timeline-track');
    if (track) {
      const playhead = track.querySelector('.timeline-playhead') as HTMLElement;
      if (playhead) {
        playhead.style.display = 'none';
      }
    }
  }

  private stopPlayback(): void {
    this.isPlaying = false;
    this.playbackFrame = 0;
    this.playbackStartTime = 0;

    const playPauseBtn = document.getElementById('play-pause-btn');
    if (playPauseBtn) {
      playPauseBtn.textContent = '▶';
      playPauseBtn.className = 'btn btn-play';
    }

    if (this.playbackAnimationId !== null) {
      cancelAnimationFrame(this.playbackAnimationId);
      this.playbackAnimationId = null;
    }

    // Hide playhead
    const track = document.getElementById('timeline-track');
    if (track) {
      const playhead = track.querySelector('.timeline-playhead') as HTMLElement;
      if (playhead) {
        playhead.style.display = 'none';
      }
    }

    // Reset all dots to normal size
    const dots = document.querySelectorAll('.timeline-frame-dot');
    dots.forEach((dot) => {
      (dot as HTMLElement).style.transform = '';
    });

    this.updatePlaybackDisplay();
    this.renderGridCanvas();
  }

  private animatePlayback(): void {
    if (!this.isPlaying) return;

    const direction = this.getCurrentDirection();
    if (!direction || direction.frames.length === 0) {
      this.stopPlayback();
      return;
    }

    const currentTime = Date.now() - this.playbackStartTime;
    const totalDuration = direction.frames.reduce((sum, f) => sum + f.duration, 0);
    let accumulatedTime = 0;
    let currentFrame = 0;

    // Find which frame we should be showing
    for (let i = 0; i < direction.frames.length; i++) {
      accumulatedTime += direction.frames[i].duration;
      if (currentTime < accumulatedTime) {
        currentFrame = i;
        break;
      }
    }

    // Check if animation finished
    if (currentTime >= accumulatedTime) {
      const loopCheckbox = document.getElementById('preview-loop-checkbox') as HTMLInputElement;
      if (loopCheckbox && loopCheckbox.checked) {
        // Loop: restart animation
        this.playbackStartTime = Date.now();
        currentFrame = 0;
      } else {
        // Don't loop: stop at last frame
        currentFrame = direction.frames.length - 1;
        this.stopPlayback();
        return;
      }
    }

    this.playbackFrame = currentFrame;
    this.updatePlaybackDisplay();

    // Update playhead position
    const track = document.getElementById('timeline-track');
    if (track) {
      const playhead = track.querySelector('.timeline-playhead') as HTMLElement;
      if (playhead) {
        const progress = Math.min((currentTime / totalDuration) * 100, 100);
        playhead.style.left = `${progress}%`;
      }

      // Update dot sizes based on current frame
      const dots = track.querySelectorAll('.timeline-frame-dot-container');
      dots.forEach((container, index) => {
        const dot = container.querySelector('.timeline-frame-dot') as HTMLElement;
        if (dot) {
          if (index === currentFrame) {
            // Calculate how far into the current frame we are
            let frameStartTime = 0;
            for (let i = 0; i < index; i++) {
              frameStartTime += direction.frames[i].duration;
            }
            const timeIntoFrame = currentTime - frameStartTime;

            // Get the previous frame's duration for transition
            // If this is frame 0, use the last frame's duration
            const prevFrameIndex = index === 0 ? direction.frames.length - 1 : index - 1;
            const transitionDuration = direction.frames[prevFrameIndex].duration;

            // If we just entered this frame, set transition
            if (timeIntoFrame < 50) { // Within first 50ms of frame
              dot.style.transition = `transform ${transitionDuration}ms linear`;
            }

            // Grow current frame dot
            dot.style.transform = 'scale(1.4)';
          } else if (index < currentFrame) {
            // Already played - keep at max size
            dot.style.transform = 'scale(1.4)';
            dot.style.transition = 'none';
          } else {
            // Not yet played - normal size
            dot.style.transform = 'scale(1)';
            dot.style.transition = 'none';
          }
        }
      });
    }

    // Render only the current playback frame on grid
    this.renderPlaybackFrame(currentFrame);

    this.playbackAnimationId = requestAnimationFrame(() => this.animatePlayback());
  }

  private renderPlaybackFrame(frameIndex: number): void {
    if (!this.gridCanvas || !this.gridCtx) return;

    // Ensure image smoothing is disabled for crisp pixel art
    this.gridCtx.imageSmoothingEnabled = false;

    const width = this.gridCanvas.width;
    const height = this.gridCanvas.height;

    // Clear canvas
    this.gridCtx.fillStyle = '#0e111b';
    this.gridCtx.fillRect(0, 0, width, height);

    // Calculate center point
    const centerX = width / 2 + this.gridPanX;
    const centerY = height / 2 + this.gridPanY;

    // Draw grid
    this.drawGrid(centerX, centerY);

    // Draw center crosshair (purple lines)
    this.gridCtx.strokeStyle = '#8b5cf6';
    this.gridCtx.lineWidth = 2;
    this.gridCtx.setLineDash([]);

    // Vertical line
    this.gridCtx.beginPath();
    this.gridCtx.moveTo(centerX, 0);
    this.gridCtx.lineTo(centerX, height);
    this.gridCtx.stroke();

    // Horizontal line
    this.gridCtx.beginPath();
    this.gridCtx.moveTo(0, centerY);
    this.gridCtx.lineTo(width, centerY);
    this.gridCtx.stroke();

    // Draw only the current frame
    const direction = this.getCurrentDirection();
    if (direction && this.currentImage && direction.frames[frameIndex]) {
      const timelineFrame = direction.frames[frameIndex];
      const splitFrame = this.splitFrames[timelineFrame.frameIndex];
      if (splitFrame) {
        const scaledWidth = splitFrame.width * this.gridZoom;
        const scaledHeight = splitFrame.height * this.gridZoom;

        const totalX = timelineFrame.x + timelineFrame.offsetX;
        const totalY = timelineFrame.y + timelineFrame.offsetY;

        const frameX = centerX + (totalX * this.gridZoom) - scaledWidth / 2;
        const frameY = centerY + (totalY * this.gridZoom) - scaledHeight / 2;

        this.gridCtx.drawImage(
          this.currentImage,
          splitFrame.x, splitFrame.y, splitFrame.width, splitFrame.height,
          frameX, frameY, scaledWidth, scaledHeight
        );

        // Draw coordinate label
        this.gridCtx.fillStyle = '#ffffff';
        this.gridCtx.font = '11px monospace';
        this.gridCtx.textAlign = 'center';
        this.gridCtx.textBaseline = 'top';
        const coordText = `(${totalX}, ${totalY})`;

        // Draw text background
        const textMetrics = this.gridCtx.measureText(coordText);
        const textX = frameX + scaledWidth / 2;
        const textY = frameY + scaledHeight + 4;

        this.gridCtx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        this.gridCtx.fillRect(textX - textMetrics.width / 2 - 3, textY - 2, textMetrics.width + 6, 16);

        // Draw subtle border
        this.gridCtx.strokeStyle = 'rgba(139, 92, 246, 0.5)';
        this.gridCtx.lineWidth = 1;
        this.gridCtx.strokeRect(textX - textMetrics.width / 2 - 3, textY - 2, textMetrics.width + 6, 16);

        this.gridCtx.fillStyle = '#ffffff';
        this.gridCtx.fillText(coordText, textX, textY);
      }
    }
  }

  private updatePlaybackDisplay(): void {
    const frameDisplay = document.getElementById('current-frame-display');
    const timeDisplay = document.getElementById('current-time-display');
    const direction = this.getCurrentDirection();

    // Hide displays if no frames exist
    if (!direction || direction.frames.length === 0) {
      if (frameDisplay) frameDisplay.style.display = 'none';
      if (timeDisplay) timeDisplay.style.display = 'none';
      return;
    }

    // Show displays and update content
    if (frameDisplay) {
      frameDisplay.style.display = 'block';
      if (this.isPlaying) {
        frameDisplay.textContent = `Frame: ${this.playbackFrame + 1}/${direction.frames.length}`;
      } else {
        // When not playing, show selected frame or first frame
        const displayFrame = this.selectedTimelineFrame !== null ? this.selectedTimelineFrame + 1 : 1;
        frameDisplay.textContent = `Frame: ${displayFrame}/${direction.frames.length}`;
      }
    }

    if (timeDisplay) {
      timeDisplay.style.display = 'block';
      if (this.isPlaying && direction.frames[this.playbackFrame]) {
        const elapsedTime = Date.now() - this.playbackStartTime;
        timeDisplay.textContent = `Time: ${Math.round(elapsedTime)}ms`;
      } else {
        timeDisplay.textContent = `Time: 0ms`;
      }
    }
  }

  // ===== GRID CANVAS RENDERING =====

  private renderGridCanvas(): void {
    if (!this.gridCanvas || !this.gridCtx) return;

    // Stop playback when rendering static grid
    if (this.isPlaying) return;

    // Ensure image smoothing is disabled for crisp pixel art
    this.gridCtx.imageSmoothingEnabled = false;

    const width = this.gridCanvas.width;
    const height = this.gridCanvas.height;

    // Clear canvas
    this.gridCtx.fillStyle = '#0e111b';
    this.gridCtx.fillRect(0, 0, width, height);

    // Calculate center point
    const centerX = width / 2 + this.gridPanX;
    const centerY = height / 2 + this.gridPanY;

    // Draw grid
    this.drawGrid(centerX, centerY);

    // Draw center crosshair (purple lines)
    this.gridCtx.strokeStyle = '#8b5cf6';
    this.gridCtx.lineWidth = 2;
    this.gridCtx.setLineDash([]);

    // Vertical line
    this.gridCtx.beginPath();
    this.gridCtx.moveTo(centerX, 0);
    this.gridCtx.lineTo(centerX, height);
    this.gridCtx.stroke();

    // Horizontal line
    this.gridCtx.beginPath();
    this.gridCtx.moveTo(0, centerY);
    this.gridCtx.lineTo(width, centerY);
    this.gridCtx.stroke();

    // Draw only the selected timeline frame
    const direction = this.getCurrentDirection();
    if (direction && this.currentImage && this.selectedTimelineFrame !== null) {
      const timelineFrame = direction.frames[this.selectedTimelineFrame];
      if (timelineFrame) {
        const splitFrame = this.splitFrames[timelineFrame.frameIndex];
        if (splitFrame) {
          const scaledWidth = splitFrame.width * this.gridZoom;
          const scaledHeight = splitFrame.height * this.gridZoom;

          // Position frame at center + position + offset
          const totalX = timelineFrame.x + timelineFrame.offsetX;
          const totalY = timelineFrame.y + timelineFrame.offsetY;

          const frameX = centerX + (totalX * this.gridZoom) - scaledWidth / 2;
          const frameY = centerY + (totalY * this.gridZoom) - scaledHeight / 2;

          // Draw the frame image
          this.gridCtx.drawImage(
            this.currentImage,
            splitFrame.x, splitFrame.y, splitFrame.width, splitFrame.height,
            frameX, frameY, scaledWidth, scaledHeight
          );

          // Draw coordinate label
          this.gridCtx.fillStyle = '#ffffff';
          this.gridCtx.font = '11px monospace';
          this.gridCtx.textAlign = 'center';
          this.gridCtx.textBaseline = 'top';
          const coordText = `(${totalX}, ${totalY})`;

          // Draw text background with border to indicate clickability
          const textMetrics = this.gridCtx.measureText(coordText);
          const textX = frameX + scaledWidth / 2;
          const textY = frameY + scaledHeight + 4;

          this.gridCtx.fillStyle = 'rgba(0, 0, 0, 0.8)';
          this.gridCtx.fillRect(textX - textMetrics.width / 2 - 3, textY - 2, textMetrics.width + 6, 16);

          // Draw subtle border to indicate clickability
          this.gridCtx.strokeStyle = 'rgba(139, 92, 246, 0.5)';
          this.gridCtx.lineWidth = 1;
          this.gridCtx.strokeRect(textX - textMetrics.width / 2 - 3, textY - 2, textMetrics.width + 6, 16);

          this.gridCtx.fillStyle = '#ffffff';
          this.gridCtx.fillText(coordText, textX, textY);
        }
      }
    }
  }

  private getFrameAtPosition(mouseX: number, mouseY: number): number | null {
    const direction = this.getCurrentDirection();
    if (!direction || this.selectedTimelineFrame === null) return null;

    const centerX = this.gridCanvas.width / 2 + this.gridPanX;
    const centerY = this.gridCanvas.height / 2 + this.gridPanY;

    // Only check the selected frame
    const timelineFrame = direction.frames[this.selectedTimelineFrame];
    if (!timelineFrame) return null;

    const splitFrame = this.splitFrames[timelineFrame.frameIndex];
    if (!splitFrame) return null;

    const scaledWidth = splitFrame.width * this.gridZoom;
    const scaledHeight = splitFrame.height * this.gridZoom;

    const totalX = timelineFrame.x + timelineFrame.offsetX;
    const totalY = timelineFrame.y + timelineFrame.offsetY;

    const frameX = centerX + (totalX * this.gridZoom) - scaledWidth / 2;
    const frameY = centerY + (totalY * this.gridZoom) - scaledHeight / 2;

    if (mouseX >= frameX && mouseX <= frameX + scaledWidth &&
        mouseY >= frameY && mouseY <= frameY + scaledHeight) {
      return this.selectedTimelineFrame;
    }

    return null;
  }

  private isClickOnCoordinateLabel(mouseX: number, mouseY: number): boolean {
    const direction = this.getCurrentDirection();
    if (!direction || this.selectedTimelineFrame === null || !this.currentImage) return false;

    const timelineFrame = direction.frames[this.selectedTimelineFrame];
    if (!timelineFrame) return false;

    const splitFrame = this.splitFrames[timelineFrame.frameIndex];
    if (!splitFrame) return false;

    const centerX = this.gridCanvas.width / 2 + this.gridPanX;
    const centerY = this.gridCanvas.height / 2 + this.gridPanY;

    const scaledWidth = splitFrame.width * this.gridZoom;
    const scaledHeight = splitFrame.height * this.gridZoom;

    const totalX = timelineFrame.x + timelineFrame.offsetX;
    const totalY = timelineFrame.y + timelineFrame.offsetY;

    const frameX = centerX + (totalX * this.gridZoom) - scaledWidth / 2;
    const frameY = centerY + (totalY * this.gridZoom) - scaledHeight / 2;

    // Calculate coordinate label bounds
    const coordText = `(${totalX}, ${totalY})`;
    this.gridCtx.font = '11px monospace';
    const textMetrics = this.gridCtx.measureText(coordText);
    const textX = frameX + scaledWidth / 2;
    const textY = frameY + scaledHeight + 4;

    const labelX = textX - textMetrics.width / 2 - 3;
    const labelY = textY - 2;
    const labelWidth = textMetrics.width + 6;
    const labelHeight = 16;

    return mouseX >= labelX && mouseX <= labelX + labelWidth &&
           mouseY >= labelY && mouseY <= labelY + labelHeight;
  }

  private editCoordinates(): void {
    const direction = this.getCurrentDirection();
    if (!direction || this.selectedTimelineFrame === null) return;

    const timelineFrame = direction.frames[this.selectedTimelineFrame];
    if (!timelineFrame) return;

    const splitFrame = this.splitFrames[timelineFrame.frameIndex];
    if (!splitFrame) return;

    const centerX = this.gridCanvas.width / 2 + this.gridPanX;
    const centerY = this.gridCanvas.height / 2 + this.gridPanY;

    const scaledWidth = splitFrame.width * this.gridZoom;
    const scaledHeight = splitFrame.height * this.gridZoom;

    const totalX = timelineFrame.x + timelineFrame.offsetX;
    const totalY = timelineFrame.y + timelineFrame.offsetY;

    const frameX = centerX + (totalX * this.gridZoom) - scaledWidth / 2;
    const frameY = centerY + (totalY * this.gridZoom) - scaledHeight / 2;

    const coordText = `(${totalX}, ${totalY})`;
    this.gridCtx.font = '11px monospace';
    const textMetrics = this.gridCtx.measureText(coordText);
    const textX = frameX + scaledWidth / 2;
    const textY = frameY + scaledHeight + 4;

    const labelX = textX - textMetrics.width / 2 - 3;
    const labelY = textY - 2;
    const labelWidth = textMetrics.width + 6;
    const labelHeight = 16;

    // Remove any existing input
    const existingInput = document.getElementById('coord-inline-input');
    if (existingInput) existingInput.remove();

    // Create inline input
    const input = document.createElement('input');
    input.id = 'coord-inline-input';
    input.type = 'text';
    input.value = `${totalX}, ${totalY}`;
    input.style.cssText = `
      position: absolute;
      left: ${this.gridCanvas.offsetLeft + labelX}px;
      top: ${this.gridCanvas.offsetTop + labelY}px;
      width: ${labelWidth}px;
      height: ${labelHeight}px;
      background: rgba(0, 0, 0, 0.9);
      border: 1px solid #8b5cf6;
      color: #fff;
      font-size: 11px;
      font-family: monospace;
      text-align: center;
      padding: 0;
      margin: 0;
      z-index: 1000;
      outline: none;
    `;

    let isClosing = false;

    const saveAndClose = () => {
      // Prevent multiple calls
      if (isClosing) return;
      isClosing = true;

      // Remove event listeners to prevent duplicate calls
      input.removeEventListener('blur', saveAndClose);

      const parts = input.value.replace(/[()]/g, '').split(',').map(s => s.trim());
      if (parts.length === 2) {
        let newX = parseInt(parts[0]);
        let newY = parseInt(parts[1]);

        if (!isNaN(newX) && !isNaN(newY)) {
          // Save state for undo before changing coords
          this.pushUndoState('coords', {
            x: timelineFrame.x,
            y: timelineFrame.y,
            offsetX: timelineFrame.offsetX,
            offsetY: timelineFrame.offsetY
          }, this.selectedTimelineFrame!);

          // Clamp to max distance from center
          newX = Math.max(-this.maxCoordinateDistance, Math.min(this.maxCoordinateDistance, newX));
          newY = Math.max(-this.maxCoordinateDistance, Math.min(this.maxCoordinateDistance, newY));

          timelineFrame.x = newX - timelineFrame.offsetX;
          timelineFrame.y = newY - timelineFrame.offsetY;
          this.renderGridCanvas();
          this.triggerAutosave();
        }
      }

      if (input.parentElement) {
        input.remove();
      }
    };

    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        saveAndClose();
      } else if (e.key === 'Escape') {
        isClosing = true;
        input.removeEventListener('blur', saveAndClose);
        if (input.parentElement) {
          input.remove();
        }
        this.renderGridCanvas();
      }
    };

    input.addEventListener('keydown', handleKeydown);
    input.addEventListener('blur', saveAndClose);

    this.gridCanvas.parentElement?.appendChild(input);
    input.focus();
    input.select();
  }

  private drawGrid(centerX: number, centerY: number): void {
    const width = this.gridCanvas.width;
    const height = this.gridCanvas.height;
    const gridSize = this.gridCellSize * this.gridZoom;

    this.gridCtx.strokeStyle = '#2a2a3e';
    this.gridCtx.lineWidth = 1;

    // Vertical lines
    let x = centerX % gridSize;
    while (x < width) {
      this.gridCtx.beginPath();
      this.gridCtx.moveTo(x, 0);
      this.gridCtx.lineTo(x, height);
      this.gridCtx.stroke();
      x += gridSize;
    }

    x = centerX % gridSize;
    while (x > 0) {
      this.gridCtx.beginPath();
      this.gridCtx.moveTo(x, 0);
      this.gridCtx.lineTo(x, height);
      this.gridCtx.stroke();
      x -= gridSize;
    }

    // Horizontal lines
    let y = centerY % gridSize;
    while (y < height) {
      this.gridCtx.beginPath();
      this.gridCtx.moveTo(0, y);
      this.gridCtx.lineTo(width, y);
      this.gridCtx.stroke();
      y += gridSize;
    }

    y = centerY % gridSize;
    while (y > 0) {
      this.gridCtx.beginPath();
      this.gridCtx.moveTo(0, y);
      this.gridCtx.lineTo(width, y);
      this.gridCtx.stroke();
      y -= gridSize;
    }
  }

  private async showConfirm(title: string, message: string): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = document.getElementById('confirm-modal');
      const titleEl = document.getElementById('confirm-title');
      const messageEl = document.getElementById('confirm-message');
      const okBtn = document.getElementById('confirm-ok-btn');
      const cancelBtn = document.getElementById('confirm-cancel-btn');
      const closeBtn = modal?.querySelector('.modal-close');

      if (!modal || !titleEl || !messageEl || !okBtn || !cancelBtn) {
        resolve(false);
        return;
      }

      titleEl.textContent = title;
      messageEl.textContent = message;
      modal.style.display = 'flex';

      const cleanup = () => {
        modal.style.display = 'none';
        okBtn.removeEventListener('click', handleOk);
        cancelBtn.removeEventListener('click', handleCancel);
        closeBtn?.removeEventListener('click', handleCancel);
      };

      const handleOk = () => {
        cleanup();
        resolve(true);
      };

      const handleCancel = () => {
        cleanup();
        resolve(false);
      };

      okBtn.addEventListener('click', handleOk);
      cancelBtn.addEventListener('click', handleCancel);
      closeBtn?.addEventListener('click', handleCancel);
    });
  }

  private showNotification(message: string, type: 'success' | 'warning' | 'error' | 'info' = 'success'): void {
    const container = document.getElementById('notification-container');
    if (!container) return;

    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.textContent = message;
    container.appendChild(notification);

    setTimeout(() => {
      notification.classList.add('notification-fade-out');
      setTimeout(() => notification.remove(), 300);
    }, 3000);
  }
}

// Initialize the tool when the page loads
document.addEventListener('DOMContentLoaded', () => {
  new AnimatorTool();
});
