import { sendRequest } from "./socket.js";
import { canvas, ctx, collisionTilesDebugCheckbox, noPvpDebugCheckbox } from "./ui.js";
import { renderChunkToCanvas } from "./map.js";

declare global {
  interface Window {
    mapData?: any;
  }
}

interface TileChange {
  chunkX: number;
  chunkY: number;
  layerName: string;
  tileX: number;
  tileY: number;
  oldTileId: number;
  newTileId: number;
}

interface CopiedRegion {
  startX: number;
  startY: number;
  width: number;
  height: number;
  tiles: Map<string, number>; // key: "layerName:x:y", value: tileId
}

class TileEditor {
  public isActive: boolean = false;
  private currentTool: 'paint' | 'erase' | 'copy' | 'paste' = 'paint';
  private selectedTile: number | null = null;
  public selectedLayer: string | null = null;
  private currentTilesetIndex: number = 0;
  private undoStack: TileChange[] = [];
  private redoStack: TileChange[] = [];
  private copiedTile: number | null = null;
  private isMouseDown: boolean = false;
  private previewTilePos: { x: number, y: number } | null = null;
  private hoveredTilesetPos: { x: number, y: number } | null = null;

  // Drag state
  private isDragging: boolean = false;
  private dragStartX: number = 0;
  private dragStartY: number = 0;
  private editorStartX: number = 0;
  private editorStartY: number = 0;

  // Tileset pan state
  private isPanningTileset: boolean = false;
  private tilesetPanStartX: number = 0;
  private tilesetPanStartY: number = 0;
  private tilesetScrollStartX: number = 0;
  private tilesetScrollStartY: number = 0;

  // Resize state
  private isResizing: boolean = false;
  private resizeStartX: number = 0;
  private resizeStartY: number = 0;
  private editorStartWidth: number = 0;
  private editorStartHeight: number = 0;
  private minWidth: number = 800;
  private minHeight: number = 700;

  // UI Elements
  private container: HTMLElement;
  private editor: HTMLElement;
  private header: HTMLElement;
  private closeBtn: HTMLElement;
  private resizeHandle: HTMLElement;
  private paintBtn: HTMLElement;
  private eraseBtn: HTMLElement;
  private copyBtn: HTMLElement;
  private pasteBtn: HTMLElement;
  private undoBtn: HTMLElement;
  private redoBtn: HTMLElement;
  private saveBtn: HTMLElement;
  private layersList: HTMLElement;
  private tilesetTabs: HTMLElement;
  private tilesetContainer: HTMLElement;
  private tilesetCanvas: HTMLCanvasElement;
  private tilesetCtx: CanvasRenderingContext2D;

  constructor() {
    // Get UI elements
    this.container = document.getElementById('tile-editor-container') as HTMLElement;
    this.editor = document.getElementById('tile-editor') as HTMLElement;
    this.header = document.getElementById('tile-editor-header') as HTMLElement;
    this.closeBtn = document.getElementById('tile-editor-close') as HTMLElement;
    this.resizeHandle = document.getElementById('tile-editor-resize-handle') as HTMLElement;
    this.paintBtn = document.getElementById('te-tool-paint') as HTMLElement;
    this.eraseBtn = document.getElementById('te-tool-erase') as HTMLElement;
    this.copyBtn = document.getElementById('te-copy') as HTMLElement;
    this.pasteBtn = document.getElementById('te-paste') as HTMLElement;
    this.undoBtn = document.getElementById('te-undo') as HTMLElement;
    this.redoBtn = document.getElementById('te-redo') as HTMLElement;
    this.saveBtn = document.getElementById('te-save') as HTMLElement;
    this.layersList = document.getElementById('tile-editor-layers-list') as HTMLElement;
    this.tilesetTabs = document.getElementById('tile-editor-tileset-tabs') as HTMLElement;
    this.tilesetContainer = document.getElementById('tile-editor-tileset-container') as HTMLElement;
    this.tilesetCanvas = document.getElementById('tile-editor-tileset-canvas') as HTMLCanvasElement;
    this.tilesetCtx = this.tilesetCanvas.getContext('2d')!;

    this.setupEventListeners();
  }

  private setupEventListeners() {
    // Tool buttons
    this.closeBtn.addEventListener('click', () => this.toggle());
    this.paintBtn.addEventListener('click', () => this.setTool('paint'));
    this.eraseBtn.addEventListener('click', () => this.setTool('erase'));
    this.copyBtn.addEventListener('click', () => this.setTool('copy'));
    this.pasteBtn.addEventListener('click', () => {
      // Only allow switching to paste if there's a copied tile
      if (this.copiedTile !== null) {
        this.setTool('paste');
      }
    });

    // Action buttons
    this.undoBtn.addEventListener('click', () => this.undo());
    this.redoBtn.addEventListener('click', () => this.redo());
    this.saveBtn.addEventListener('click', () => this.save());

    // Drag events for header
    this.header.addEventListener('mousedown', (e) => this.onDragStart(e));
    document.addEventListener('mousemove', (e) => this.onDrag(e));
    document.addEventListener('mouseup', () => this.onDragEnd());

    // Resize events for resize handle
    this.resizeHandle.addEventListener('mousedown', (e) => this.onResizeStart(e));
    document.addEventListener('mousemove', (e) => this.onResize(e));
    document.addEventListener('mouseup', () => this.onResizeEnd());

    // Tileset canvas events
    this.tilesetCanvas.addEventListener('click', (e) => this.onTilesetClick(e));
    this.tilesetCanvas.addEventListener('mousemove', (e) => this.onTilesetMouseMove(e));
    this.tilesetCanvas.addEventListener('mouseleave', () => this.onTilesetMouseLeave());

    // Tileset panning events (middle mouse button)
    this.tilesetContainer.addEventListener('mousedown', (e) => this.onTilesetPanStart(e));
    this.tilesetContainer.addEventListener('mousemove', (e) => this.onTilesetPan(e));
    this.tilesetContainer.addEventListener('mouseup', (e) => this.onTilesetPanEnd(e));
    this.tilesetContainer.addEventListener('mouseleave', (e) => this.onTilesetPanEnd(e));

    // Game canvas events for tile placement
    canvas.addEventListener('mousemove', (e) => this.onMapMouseMove(e));
    canvas.addEventListener('mousedown', (e) => this.onMapMouseDown(e));
    canvas.addEventListener('mouseup', () => this.onMapMouseUp());
    canvas.addEventListener('mouseleave', () => this.onMapMouseUp());

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => this.onKeyDown(e));
  }

  public toggle() {
    this.isActive = !this.isActive;
    this.container.style.display = this.isActive ? 'flex' : 'none';

    if (this.isActive) {
      this.initialize();
    } else {
      // Turn off debug checkboxes when closing tile editor
      collisionTilesDebugCheckbox.checked = false;
      noPvpDebugCheckbox.checked = false;
    }
  }

  private initialize() {
    if (!window.mapData) return;

    // Load layers
    this.loadLayers();

    // Load tilesets
    this.loadTilesets();

    // Update paste button state
    this.updatePasteButtonState();
  }

  private loadLayers() {
    if (!window.mapData) return;

    this.layersList.innerHTML = '';

    // Get a sample chunk to read layer information
    const firstChunk = window.mapData.loadedChunks.values().next().value;
    if (!firstChunk) return;

    // Include all layers (including collision and no-pvp) and sort by zIndex
    const layers = firstChunk.layers
      .sort((a: any, b: any) => a.zIndex - b.zIndex);

    layers.forEach((layer: any) => {
      const layerItem = document.createElement('div');
      layerItem.className = 'te-layer-item ui';

      // Add visual indicators for special layers
      const isCollision = layer.name.toLowerCase().includes('collision');
      const isNoPvp = layer.name.toLowerCase().includes('nopvp') || layer.name.toLowerCase().includes('no-pvp');

      let displayName = layer.name;
      if (isCollision) {
        displayName += ' [Collision]';
        layerItem.style.color = '#ff9999';
      } else if (isNoPvp) {
        displayName += ' [No-PVP]';
        layerItem.style.color = '#99ff99';
      }

      layerItem.textContent = displayName;

      layerItem.addEventListener('click', () => this.selectLayer(layer.name));
      this.layersList.appendChild(layerItem);
    });

    // Select first non-special layer by default
    if (layers.length > 0 && !this.selectedLayer) {
      const firstNonSpecial = layers.find((l: any) => {
        const name = l.name.toLowerCase();
        return !name.includes('collision') && !name.includes('nopvp') && !name.includes('no-pvp');
      });
      this.selectLayer(firstNonSpecial ? firstNonSpecial.name : layers[0].name);
    }
  }

  private selectLayer(layerName: string) {
    this.selectedLayer = layerName;

    // Update UI
    const layerItems = this.layersList.querySelectorAll('.te-layer-item');
    layerItems.forEach((item) => {
      if (item.textContent?.includes(layerName)) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });

    // Toggle debug checkboxes based on layer type
    const lowerName = layerName.toLowerCase();
    const isCollision = lowerName.includes('collision');
    const isNoPvp = lowerName.includes('nopvp') || lowerName.includes('no-pvp');

    // Enable/disable collision tiles debug
    collisionTilesDebugCheckbox.checked = isCollision;

    // Enable/disable no-pvp debug
    noPvpDebugCheckbox.checked = isNoPvp;
  }

  private loadTilesets() {
    if (!window.mapData) return;

    this.tilesetTabs.innerHTML = '';

    window.mapData.tilesets.forEach((tileset: any, index: number) => {
      const tab = document.createElement('div');
      const tabName = tileset.name || `Tileset ${index + 1}`;
      tab.className = 'te-tileset-tab ui';
      tab.textContent = tabName;
      tab.title = tabName; // Show full name on hover
      tab.addEventListener('click', () => this.selectTileset(index));
      this.tilesetTabs.appendChild(tab);
    });

    // Select first tileset by default
    if (window.mapData.tilesets.length > 0) {
      this.selectTileset(0);
    }
  }

  private selectTileset(index: number) {
    this.currentTilesetIndex = index;

    // Update tabs UI
    const tabs = this.tilesetTabs.querySelectorAll('.te-tileset-tab');
    tabs.forEach((tab, i) => {
      if (i === index) {
        tab.classList.add('active');
      } else {
        tab.classList.remove('active');
      }
    });

    // Draw tileset on canvas
    this.drawTileset();
  }

  private drawTileset() {
    if (!window.mapData) return;

    const tileset = window.mapData.tilesets[this.currentTilesetIndex];
    const image = window.mapData.images[this.currentTilesetIndex];

    if (!image || !tileset) return;

    // Set canvas size to tileset size with scale
    const scale = 1;
    this.tilesetCanvas.width = tileset.imagewidth * scale;
    this.tilesetCanvas.height = tileset.imageheight * scale;

    // Draw tileset image
    this.tilesetCtx.imageSmoothingEnabled = false;
    this.tilesetCtx.drawImage(image, 0, 0, tileset.imagewidth * scale, tileset.imageheight * scale);

    // Draw grid
    this.tilesetCtx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    this.tilesetCtx.lineWidth = 1;

    const tileWidth = tileset.tilewidth * scale;
    const tileHeight = tileset.tileheight * scale;
    const cols = Math.floor(tileset.imagewidth / tileset.tilewidth);
    const rows = Math.floor(tileset.imageheight / tileset.tileheight);

    for (let x = 0; x <= cols; x++) {
      this.tilesetCtx.beginPath();
      this.tilesetCtx.moveTo(x * tileWidth, 0);
      this.tilesetCtx.lineTo(x * tileWidth, rows * tileHeight);
      this.tilesetCtx.stroke();
    }

    for (let y = 0; y <= rows; y++) {
      this.tilesetCtx.beginPath();
      this.tilesetCtx.moveTo(0, y * tileHeight);
      this.tilesetCtx.lineTo(cols * tileWidth, y * tileHeight);
      this.tilesetCtx.stroke();
    }

    // Draw selected tile highlight (blue outline)
    if (this.selectedTile && this.selectedTile >= tileset.firstgid && this.selectedTile < tileset.firstgid + tileset.tilecount) {
      const localTileId = this.selectedTile - tileset.firstgid;
      const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
      const selectedX = (localTileId % tilesPerRow);
      const selectedY = Math.floor(localTileId / tilesPerRow);

      this.tilesetCtx.strokeStyle = 'rgba(0, 150, 255, 1)';
      this.tilesetCtx.lineWidth = 3;
      this.tilesetCtx.strokeRect(
        selectedX * tileWidth,
        selectedY * tileHeight,
        tileWidth,
        tileHeight
      );
    }

    // Draw hover highlight
    if (this.hoveredTilesetPos) {
      this.tilesetCtx.fillStyle = 'rgba(0, 150, 255, 0.4)';
      this.tilesetCtx.fillRect(
        this.hoveredTilesetPos.x * tileWidth,
        this.hoveredTilesetPos.y * tileHeight,
        tileWidth,
        tileHeight
      );
    }
  }

  private onTilesetClick(e: MouseEvent) {
    if (!window.mapData) return;

    const tileset = window.mapData.tilesets[this.currentTilesetIndex];
    if (!tileset) return;

    const rect = this.tilesetCanvas.getBoundingClientRect();
    const scale = 1;
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;

    const tileX = Math.floor(x / tileset.tilewidth);
    const tileY = Math.floor(y / tileset.tileheight);
    const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);

    const localTileId = tileY * tilesPerRow + tileX;
    this.selectedTile = tileset.firstgid + localTileId;

    // Always switch to paint mode when selecting from tileset
    this.setTool('paint');

    // Redraw tileset to show selection
    this.drawTileset();

    console.log('Selected tile:', this.selectedTile);
  }

  private onTilesetMouseMove(e: MouseEvent) {
    if (!window.mapData) return;

    const tileset = window.mapData.tilesets[this.currentTilesetIndex];
    if (!tileset) return;

    const rect = this.tilesetCanvas.getBoundingClientRect();
    const scale = 1;
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;

    const tileX = Math.floor(x / tileset.tilewidth);
    const tileY = Math.floor(y / tileset.tileheight);

    // Only update if the hovered tile changed
    if (!this.hoveredTilesetPos || this.hoveredTilesetPos.x !== tileX || this.hoveredTilesetPos.y !== tileY) {
      this.hoveredTilesetPos = { x: tileX, y: tileY };
      this.drawTileset();
    }
  }

  private onTilesetMouseLeave() {
    if (this.hoveredTilesetPos) {
      this.hoveredTilesetPos = null;
      this.drawTileset();
    }
  }

  private onMapMouseMove(e: MouseEvent) {
    if (!this.isActive || !window.mapData) {
      this.previewTilePos = null;
      return;
    }

    const worldPos = this.screenToWorld(e.clientX, e.clientY);
    const tileX = Math.floor(worldPos.x / window.mapData.tilewidth);
    const tileY = Math.floor(worldPos.y / window.mapData.tileheight);

    this.previewTilePos = { x: tileX, y: tileY };

    // If mouse is down and paint tool, continue painting
    if (this.isMouseDown && this.currentTool === 'paint') {
      this.placeTile(tileX, tileY);
    } else if (this.isMouseDown && this.currentTool === 'erase') {
      this.eraseTile(tileX, tileY);
    } else if (this.isMouseDown && this.currentTool === 'paste') {
      this.pasteTile(tileX, tileY);
    }
  }

  private onMapMouseDown(e: MouseEvent) {
    if (!this.isActive || !window.mapData) return;

    // Don't interfere with clicks on the editor UI itself
    if ((e.target as HTMLElement).closest('#tile-editor-container')) {
      return;
    }

    const worldPos = this.screenToWorld(e.clientX, e.clientY);
    const tileX = Math.floor(worldPos.x / window.mapData.tilewidth);
    const tileY = Math.floor(worldPos.y / window.mapData.tileheight);

    // Right click - copy tile from world
    if (e.button === 2) {
      e.preventDefault();
      this.copyTileFromWorld(tileX, tileY);
      return;
    }

    // Left click
    if (e.button === 0) {
      this.isMouseDown = true;

      console.log(`Tile editor click: tile (${tileX}, ${tileY}), tool: ${this.currentTool}, selectedTile: ${this.selectedTile}`);

      if (this.currentTool === 'paint') {
        this.placeTile(tileX, tileY);
      } else if (this.currentTool === 'erase') {
        this.eraseTile(tileX, tileY);
      } else if (this.currentTool === 'paste') {
        this.pasteTile(tileX, tileY);
      }
    }
  }

  private onMapMouseUp() {
    this.isMouseDown = false;
  }

  private onDragStart(e: MouseEvent) {
    // Don't start drag if clicking on close button
    if (e.target === this.closeBtn) return;

    this.isDragging = true;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;

    // Get current position of editor
    const rect = this.editor.getBoundingClientRect();
    this.editorStartX = rect.left;
    this.editorStartY = rect.top;

    // Change cursor
    this.header.style.cursor = 'grabbing';
  }

  private onDrag(e: MouseEvent) {
    if (!this.isDragging) return;

    const deltaX = e.clientX - this.dragStartX;
    const deltaY = e.clientY - this.dragStartY;

    let newX = this.editorStartX + deltaX;
    let newY = this.editorStartY + deltaY;

    // Constrain to viewport bounds
    const editorRect = this.editor.getBoundingClientRect();
    const maxX = window.innerWidth - editorRect.width;
    const maxY = window.innerHeight - editorRect.height;

    newX = Math.max(0, Math.min(newX, maxX));
    newY = Math.max(0, Math.min(newY, maxY));

    // Update position
    this.editor.style.left = `${newX}px`;
    this.editor.style.top = `${newY}px`;
  }

  private onDragEnd() {
    if (!this.isDragging) return;

    this.isDragging = false;
    this.header.style.cursor = '';
  }

  private onTilesetPanStart(e: MouseEvent) {
    // Only pan with middle mouse button
    if (e.button !== 1) return;

    e.preventDefault();
    this.isPanningTileset = true;
    this.tilesetPanStartX = e.clientX;
    this.tilesetPanStartY = e.clientY;
    this.tilesetScrollStartX = this.tilesetContainer.scrollLeft;
    this.tilesetScrollStartY = this.tilesetContainer.scrollTop;

    // Change cursor
    this.tilesetContainer.style.cursor = 'grabbing';
  }

  private onTilesetPan(e: MouseEvent) {
    if (!this.isPanningTileset) return;

    e.preventDefault();

    const deltaX = e.clientX - this.tilesetPanStartX;
    const deltaY = e.clientY - this.tilesetPanStartY;

    // Update scroll position (inverted for natural panning feel)
    this.tilesetContainer.scrollLeft = this.tilesetScrollStartX - deltaX;
    this.tilesetContainer.scrollTop = this.tilesetScrollStartY - deltaY;
  }

  private onTilesetPanEnd(e: MouseEvent) {
    if (!this.isPanningTileset) return;

    this.isPanningTileset = false;
    this.tilesetContainer.style.cursor = '';
  }

  private onResizeStart(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();

    this.isResizing = true;
    this.resizeStartX = e.clientX;
    this.resizeStartY = e.clientY;

    // Get current dimensions
    const rect = this.editor.getBoundingClientRect();
    this.editorStartWidth = rect.width;
    this.editorStartHeight = rect.height;
  }

  private onResize(e: MouseEvent) {
    if (!this.isResizing) return;

    const deltaX = e.clientX - this.resizeStartX;
    const deltaY = e.clientY - this.resizeStartY;

    let newWidth = this.editorStartWidth + deltaX;
    let newHeight = this.editorStartHeight + deltaY;

    // Apply minimum constraints
    newWidth = Math.max(this.minWidth, newWidth);
    newHeight = Math.max(this.minHeight, newHeight);

    // Apply maximum constraints (viewport bounds)
    const maxWidth = window.innerWidth - 20; // 20px margin
    const maxHeight = window.innerHeight - 20;
    newWidth = Math.min(newWidth, maxWidth);
    newHeight = Math.min(newHeight, maxHeight);

    // Update editor dimensions
    this.editor.style.width = `${newWidth}px`;
    this.editor.style.height = `${newHeight}px`;
  }

  private onResizeEnd() {
    if (!this.isResizing) return;

    this.isResizing = false;
  }

  private screenToWorld(screenX: number, screenY: number): { x: number, y: number } {
    // Get camera position from renderer (you may need to export these from renderer.ts)
    const cameraX = (window as any).cameraX || 0;
    const cameraY = (window as any).cameraY || 0;

    return {
      x: screenX - (window.innerWidth / 2) + cameraX,
      y: screenY - (window.innerHeight / 2) + cameraY
    };
  }

  private placeTile(tileX: number, tileY: number) {
    if (!this.selectedTile || !this.selectedLayer || !window.mapData) return;

    const chunkSize = window.mapData.chunkSize;
    const chunkX = Math.floor(tileX / chunkSize);
    const chunkY = Math.floor(tileY / chunkSize);
    const localTileX = tileX % chunkSize;
    const localTileY = tileY % chunkSize;

    const chunkKey = `${chunkX}-${chunkY}`;
    const chunk = window.mapData.loadedChunks.get(chunkKey);

    if (!chunk) return;

    const layer = chunk.layers.find((l: any) => l.name === this.selectedLayer);
    if (!layer) return;

    const tileIndex = localTileY * chunk.width + localTileX;
    const oldTileId = layer.data[tileIndex];

    if (oldTileId === this.selectedTile) return; // No change

    // Record change for undo
    this.undoStack.push({
      chunkX,
      chunkY,
      layerName: this.selectedLayer,
      tileX: localTileX,
      tileY: localTileY,
      oldTileId,
      newTileId: this.selectedTile
    });
    this.redoStack = []; // Clear redo stack on new action

    // Update tile data
    layer.data[tileIndex] = this.selectedTile;

    // Re-render chunk
    this.rerenderChunk(chunkX, chunkY);
  }

  private eraseTile(tileX: number, tileY: number) {
    if (!this.selectedLayer || !window.mapData) return;

    const chunkSize = window.mapData.chunkSize;
    const chunkX = Math.floor(tileX / chunkSize);
    const chunkY = Math.floor(tileY / chunkSize);
    const localTileX = tileX % chunkSize;
    const localTileY = tileY % chunkSize;

    const chunkKey = `${chunkX}-${chunkY}`;
    const chunk = window.mapData.loadedChunks.get(chunkKey);

    if (!chunk) return;

    const layer = chunk.layers.find((l: any) => l.name === this.selectedLayer);
    if (!layer) return;

    const tileIndex = localTileY * chunk.width + localTileX;
    const oldTileId = layer.data[tileIndex];

    if (oldTileId === 0) return; // Already empty

    // Record change for undo
    this.undoStack.push({
      chunkX,
      chunkY,
      layerName: this.selectedLayer,
      tileX: localTileX,
      tileY: localTileY,
      oldTileId,
      newTileId: 0
    });
    this.redoStack = [];

    // Erase tile
    layer.data[tileIndex] = 0;

    // Re-render chunk
    this.rerenderChunk(chunkX, chunkY);
  }

  private copyTileFromWorld(tileX: number, tileY: number) {
    if (!this.selectedLayer || !window.mapData) return;

    const chunkSize = window.mapData.chunkSize;
    const chunkX = Math.floor(tileX / chunkSize);
    const chunkY = Math.floor(tileY / chunkSize);
    const localTileX = tileX % chunkSize;
    const localTileY = tileY % chunkSize;

    const chunkKey = `${chunkX}-${chunkY}`;
    const chunk = window.mapData.loadedChunks.get(chunkKey);

    if (!chunk) return;

    const layer = chunk.layers.find((l: any) => l.name === this.selectedLayer);
    if (!layer) return;

    const tileIndex = localTileY * chunk.width + localTileX;
    const tileId = layer.data[tileIndex];

    // Copy the tile and switch directly to paste mode
    this.copiedTile = tileId;

    // If copying a non-empty tile, select it in the tileset
    if (tileId > 0) {
      this.selectedTile = tileId;

      // Switch to the tileset that contains this tile
      const tilesetIndex = window.mapData.tilesets.findIndex((t: any) =>
        t.firstgid <= tileId && tileId < t.firstgid + t.tilecount
      );

      if (tilesetIndex !== -1 && tilesetIndex !== this.currentTilesetIndex) {
        this.selectTileset(tilesetIndex);
      } else if (tilesetIndex !== -1) {
        // Same tileset, just redraw to show selection
        this.drawTileset();
      }

      // Auto-scroll to the selected tile
      this.scrollToSelectedTile();
    }

    this.setTool('paste');
    this.updatePasteButtonState();
    console.log('Copied tile:', tileId, '- switched to paste mode');
  }

  private pasteTile(tileX: number, tileY: number) {
    // Allow pasting tile ID 0 (empty tile), so check for null instead of falsy
    if (this.copiedTile === null || !this.selectedLayer || !window.mapData) return;

    const chunkSize = window.mapData.chunkSize;
    const chunkX = Math.floor(tileX / chunkSize);
    const chunkY = Math.floor(tileY / chunkSize);
    const localTileX = tileX % chunkSize;
    const localTileY = tileY % chunkSize;

    const chunkKey = `${chunkX}-${chunkY}`;
    const chunk = window.mapData.loadedChunks.get(chunkKey);

    if (!chunk) return;

    const layer = chunk.layers.find((l: any) => l.name === this.selectedLayer);
    if (!layer) return;

    const tileIndex = localTileY * chunk.width + localTileX;
    const oldTileId = layer.data[tileIndex];

    if (oldTileId === this.copiedTile) return; // No change

    // Record change for undo (copiedTile can be 0 for empty tiles)
    this.undoStack.push({
      chunkX,
      chunkY,
      layerName: this.selectedLayer,
      tileX: localTileX,
      tileY: localTileY,
      oldTileId,
      newTileId: this.copiedTile
    });
    this.redoStack = []; // Clear redo stack on new action

    // Update tile data (can be 0 to clear a tile)
    layer.data[tileIndex] = this.copiedTile;

    // Re-render chunk
    this.rerenderChunk(chunkX, chunkY);
  }

  private async rerenderChunk(chunkX: number, chunkY: number) {
    if (!window.mapData) return;

    const chunkKey = `${chunkX}-${chunkY}`;
    const chunk = window.mapData.loadedChunks.get(chunkKey);
    if (!chunk) return;

    // Re-render chunk canvases
    const { lowerCanvas, upperCanvas } = await renderChunkToCanvas(chunk);
    chunk.lowerCanvas = lowerCanvas;
    chunk.upperCanvas = upperCanvas;
    chunk.canvas = lowerCanvas; // Keep for backwards compatibility

    console.log(`Chunk ${chunkX}-${chunkY} re-rendered`);
  }

  private undo() {
    const change = this.undoStack.pop();
    if (!change) return;

    // Apply reverse change
    const chunkKey = `${change.chunkX}-${change.chunkY}`;
    const chunk = window.mapData.loadedChunks.get(chunkKey);
    if (!chunk) return;

    const layer = chunk.layers.find((l: any) => l.name === change.layerName);
    if (!layer) return;

    const tileIndex = change.tileY * chunk.width + change.tileX;
    layer.data[tileIndex] = change.oldTileId;

    this.redoStack.push(change);
    this.rerenderChunk(change.chunkX, change.chunkY);
  }

  private redo() {
    const change = this.redoStack.pop();
    if (!change) return;

    // Apply forward change
    const chunkKey = `${change.chunkX}-${change.chunkY}`;
    const chunk = window.mapData.loadedChunks.get(chunkKey);
    if (!chunk) return;

    const layer = chunk.layers.find((l: any) => l.name === change.layerName);
    if (!layer) return;

    const tileIndex = change.tileY * chunk.width + change.tileX;
    layer.data[tileIndex] = change.newTileId;

    this.undoStack.push(change);
    this.rerenderChunk(change.chunkX, change.chunkY);
  }

  private save() {
    console.log('Saving map changes...');

    // Check if there are any changes to save
    if (this.undoStack.length === 0) {
      console.log('No changes to save');
      return;
    }

    // Group changes by chunk
    const chunkChanges = new Map<string, any>();

    this.undoStack.forEach(change => {
      const chunkKey = `${change.chunkX}-${change.chunkY}`;

      if (!chunkChanges.has(chunkKey)) {
        const chunk = window.mapData.loadedChunks.get(chunkKey);
        if (chunk) {
          // Deep copy the chunk data
          chunkChanges.set(chunkKey, {
            chunkX: change.chunkX,
            chunkY: change.chunkY,
            width: chunk.width,
            height: chunk.height,
            layers: chunk.layers.map((layer: any) => ({
              name: layer.name,
              zIndex: layer.zIndex,
              data: [...layer.data]
            }))
          });
        }
      }
    });

    // Convert map to array for sending
    const chunks = Array.from(chunkChanges.values());

    console.log(`Saving ${chunks.length} modified chunks...`);

    // Send modified chunks to server
    sendRequest({
      type: 'SAVE_MAP',
      data: {
        mapName: window.mapData.name,
        chunks: chunks
      }
    });

    // Clear undo/redo stacks after save
    this.undoStack = [];
    this.redoStack = [];
  }

  private setTool(tool: 'paint' | 'erase' | 'copy' | 'paste') {
    this.currentTool = tool;

    // Update UI
    this.paintBtn.classList.toggle('active', tool === 'paint');
    this.eraseBtn.classList.toggle('active', tool === 'erase');
    this.copyBtn.classList.toggle('active', tool === 'copy');
    this.pasteBtn.classList.toggle('active', tool === 'paste');
  }

  private onKeyDown(e: KeyboardEvent) {
    if (!this.isActive) return;

    // Tool shortcuts
    if (e.key === 'p') this.setTool('paint');
    if (e.key === 'e') this.setTool('erase');
    if (e.key === 'c') this.setTool('copy');
    if (e.key === 'v') {
      // Only allow switching to paste if there's a copied tile
      if (this.copiedTile !== null) {
        this.setTool('paste');
      }
    }

    // Undo/Redo
    if (e.ctrlKey && e.key === 'z') {
      e.preventDefault();
      this.undo();
    }
    if (e.ctrlKey && e.key === 'y') {
      e.preventDefault();
      this.redo();
    }
  }

  private updatePasteButtonState() {
    // Disable paste button if nothing is copied
    if (this.copiedTile === null) {
      this.pasteBtn.disabled = true;
      this.pasteBtn.style.opacity = '0.5';
      this.pasteBtn.style.cursor = 'not-allowed';
    } else {
      this.pasteBtn.disabled = false;
      this.pasteBtn.style.opacity = '1';
      this.pasteBtn.style.cursor = 'pointer';
    }
  }

  private scrollToSelectedTile() {
    if (!this.selectedTile || !window.mapData) return;

    const tileset = window.mapData.tilesets[this.currentTilesetIndex];
    if (!tileset) return;

    // Check if selected tile is in current tileset
    if (this.selectedTile < tileset.firstgid || this.selectedTile >= tileset.firstgid + tileset.tilecount) {
      return;
    }

    const localTileId = this.selectedTile - tileset.firstgid;
    const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
    const tileX = (localTileId % tilesPerRow);
    const tileY = Math.floor(localTileId / tilesPerRow);

    // Calculate pixel position of the tile in the canvas
    const tilePixelX = tileX * tileset.tilewidth;
    const tilePixelY = tileY * tileset.tileheight;

    // Get the container dimensions
    const containerWidth = this.tilesetContainer.clientWidth;
    const containerHeight = this.tilesetContainer.clientHeight;

    // Calculate the desired scroll position to center the tile
    const scrollLeft = tilePixelX - (containerWidth / 2) + (tileset.tilewidth / 2);
    const scrollTop = tilePixelY - (containerHeight / 2) + (tileset.tileheight / 2);

    // Smooth scroll to the tile
    this.tilesetContainer.scrollTo({
      left: Math.max(0, scrollLeft),
      top: Math.max(0, scrollTop),
      behavior: 'smooth'
    });
  }

  public renderPreview() {
    if (!this.isActive || !this.previewTilePos || !window.mapData) return;

    // Show preview for paint mode (selected tile) or paste mode (copied tile)
    let tileToPreview: number | null = null;
    if (this.currentTool === 'paint' && this.selectedTile) {
      tileToPreview = this.selectedTile;
    } else if (this.currentTool === 'paste' && this.copiedTile !== null) {
      tileToPreview = this.copiedTile;
    }

    // Don't show preview for tile ID 0 (empty tile)
    if (tileToPreview === null || tileToPreview === 0) return;

    const tileset = window.mapData.tilesets.find((t: any) =>
      t.firstgid <= tileToPreview! && tileToPreview! < t.firstgid + t.tilecount
    );

    if (!tileset) return;

    const image = window.mapData.images[window.mapData.tilesets.indexOf(tileset)];
    if (!image || !image.complete) return;

    const localTileId = tileToPreview - tileset.firstgid;
    const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
    const srcX = (localTileId % tilesPerRow) * tileset.tilewidth;
    const srcY = Math.floor(localTileId / tilesPerRow) * tileset.tileheight;

    const worldX = this.previewTilePos.x * window.mapData.tilewidth;
    const worldY = this.previewTilePos.y * window.mapData.tileheight;

    // Draw semi-transparent preview (context is already translated in renderer)
    ctx.save();
    ctx.globalAlpha = 0.6;

    try {
      ctx.drawImage(
        image,
        srcX, srcY,
        tileset.tilewidth, tileset.tileheight,
        worldX, worldY,
        window.mapData.tilewidth, window.mapData.tileheight
      );
    } catch (e) {
      console.error('Error drawing preview:', e);
    }

    ctx.restore();
  }
}

// Create singleton instance
const tileEditor = new TileEditor();

// Expose to window for renderer access
(window as any).tileEditor = tileEditor;

export default tileEditor;
