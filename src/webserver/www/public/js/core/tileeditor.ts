import { sendRequest } from "./socket.js";
import { canvas, ctx, collisionTilesDebugCheckbox, noPvpDebugCheckbox } from "./ui.js";
import { renderChunkToCanvas, clearChunkFromCache } from "./map.js";

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

interface TileChangeGroup {
  changes: TileChange[];
}


interface PanelDragState {
  panel: HTMLElement;
  header: HTMLElement;
  isDragging: boolean;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
}

class TileEditor {
  public isActive: boolean = false;
  private currentTool: 'paint' | 'erase' | 'copy' | 'paste' = 'paint';
  private selectedTile: number | null = null;
  public selectedLayer: string | null = null;
  private currentTilesetIndex: number = 0;
  private dimOtherLayers: boolean = false;
  private undoStack: (TileChange | TileChangeGroup)[] = [];
  private redoStack: (TileChange | TileChangeGroup)[] = [];
  private copiedTile: number | null = null;
  private isMouseDown: boolean = false;
  private previewTilePos: { x: number, y: number } | null = null;
  private hoveredTilesetPos: { x: number, y: number } | null = null;

  // Tileset selection state
  private isSelectingTiles: boolean = false;
  private selectionStartTile: { x: number, y: number } | null = null;
  private selectionEndTile: { x: number, y: number } | null = null;
  private selectedTiles: number[][] = []; // 2D array of selected tile IDs

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
  private resizeStartWidth: number = 0;
  private resizeStartHeight: number = 0;

  // Panel drag state
  private panels: Map<string, PanelDragState> = new Map();

  // UI Elements
  private container: HTMLElement;
  private toolbarPanel: HTMLElement;
  private layersPanel: HTMLElement;
  private tilesetPanel: HTMLElement;
  private tilesetHeader: HTMLElement;
  private paintBtn: HTMLElement;
  private eraseBtn: HTMLElement;
  private copyBtn: HTMLElement;
  private pasteBtn: HTMLElement;
  private undoBtn: HTMLElement;
  private redoBtn: HTMLElement;
  private saveBtn: HTMLElement;
  private resetViewBtn: HTMLElement;
  private toggleOpacityBtn: HTMLElement;
  private toggleGridBtn: HTMLElement;
  private layersList: HTMLElement;
  private tilesetTabs: HTMLElement;
  private tilesetContainer: HTMLElement;
  private tilesetCanvas: HTMLCanvasElement;
  private tilesetCtx: CanvasRenderingContext2D;
  private resizeHandle: HTMLElement;

  constructor() {
    // Get UI elements
    this.container = document.getElementById('tile-editor-container') as HTMLElement;
    this.toolbarPanel = document.getElementById('tile-editor-toolbar-panel') as HTMLElement;
    this.layersPanel = document.getElementById('tile-editor-layers-panel') as HTMLElement;
    this.tilesetPanel = document.getElementById('tile-editor-tileset-panel') as HTMLElement;

    // Toolbar and layers don't have headers, so use the panels themselves as draggable elements
    this.tilesetHeader = this.tilesetPanel.querySelector('.te-panel-header') as HTMLElement;
    this.resizeHandle = this.tilesetPanel.querySelector('.te-resize-handle') as HTMLElement;

    this.paintBtn = document.getElementById('te-tool-paint') as HTMLElement;
    this.eraseBtn = document.getElementById('te-tool-erase') as HTMLElement;
    this.copyBtn = document.getElementById('te-copy') as HTMLElement;
    this.pasteBtn = document.getElementById('te-paste') as HTMLElement;
    this.undoBtn = document.getElementById('te-undo') as HTMLElement;
    this.redoBtn = document.getElementById('te-redo') as HTMLElement;
    this.saveBtn = document.getElementById('te-save') as HTMLElement;
    this.resetViewBtn = document.getElementById('te-reset-view') as HTMLElement;
    this.toggleOpacityBtn = document.getElementById('te-toggle-opacity') as HTMLElement;
    this.toggleGridBtn = document.getElementById('te-toggle-grid') as HTMLElement;
    this.layersList = document.getElementById('tile-editor-layers-list') as HTMLElement;
    this.tilesetTabs = document.getElementById('tile-editor-tileset-tabs') as HTMLElement;
    this.tilesetContainer = document.getElementById('tile-editor-tileset-container') as HTMLElement;
    this.tilesetCanvas = document.getElementById('tile-editor-tileset-canvas') as HTMLCanvasElement;
    this.tilesetCtx = this.tilesetCanvas.getContext('2d')!;

    this.initializePanels();
    this.setupEventListeners();
  }

  private initializePanels() {
    // Initialize panel drag state
    // Toolbar: entire panel is draggable (no header)
    this.panels.set('toolbar', {
      panel: this.toolbarPanel,
      header: this.toolbarPanel, // Use panel as header for dragging
      isDragging: false,
      startX: 0,
      startY: 0,
      offsetX: 0,
      offsetY: 0
    });

    // Layers: entire panel is draggable (no header)
    this.panels.set('layers', {
      panel: this.layersPanel,
      header: this.layersPanel, // Use panel as header for dragging
      isDragging: false,
      startX: 0,
      startY: 0,
      offsetX: 0,
      offsetY: 0
    });

    this.panels.set('tileset', {
      panel: this.tilesetPanel,
      header: this.tilesetHeader,
      isDragging: false,
      startX: 0,
      startY: 0,
      offsetX: 0,
      offsetY: 0
    });

    // Load saved positions
    this.loadPanelPositions();

    // Setup close buttons
    const closeButtons = document.querySelectorAll('.te-panel-close');
    closeButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const panelType = target.getAttribute('data-panel');
        if (panelType === 'tileset') {
          // Close the entire tile editor when closing the main tileset panel
          this.toggle();
        }
      });
    });
  }

  private setupEventListeners() {
    // Tool buttons
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
    this.resetViewBtn.addEventListener('click', () => this.resetPanelPositions());
    this.toggleOpacityBtn.addEventListener('click', () => this.toggleLayerOpacity());
    this.toggleGridBtn.addEventListener('click', () => this.toggleGrid());

    // Setup drag for each panel
    this.panels.forEach((panelState, id) => {
      panelState.header.addEventListener('mousedown', (e) => this.onPanelDragStart(id, e));
    });

    document.addEventListener('mousemove', (e) => this.onPanelDrag(e));
    document.addEventListener('mouseup', () => this.onPanelDragEnd());

    // Tileset canvas events
    this.tilesetCanvas.addEventListener('mousedown', (e) => this.onTilesetMouseDown(e));
    this.tilesetCanvas.addEventListener('mousemove', (e) => this.onTilesetMouseMove(e));
    this.tilesetCanvas.addEventListener('mouseup', (e) => this.onTilesetMouseUp(e));
    this.tilesetCanvas.addEventListener('mouseleave', () => this.onTilesetMouseLeave());

    // Tileset panning events (middle mouse button)
    this.tilesetContainer.addEventListener('mousedown', (e) => this.onTilesetPanStart(e));
    this.tilesetContainer.addEventListener('mousemove', (e) => this.onTilesetPan(e));
    this.tilesetContainer.addEventListener('mouseup', (e) => this.onTilesetPanEnd(e));
    this.tilesetContainer.addEventListener('mouseleave', (e) => this.onTilesetPanEnd(e));

    // Resize handle events
    this.resizeHandle.addEventListener('mousedown', (e) => this.onResizeStart(e));
    document.addEventListener('mousemove', (e) => this.onResize(e));
    document.addEventListener('mouseup', () => this.onResizeEnd());

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
    this.container.style.display = this.isActive ? 'block' : 'none';

    if (this.isActive) {
      // Show all panels when opening
      this.panels.forEach(panelState => {
        panelState.panel.style.display = 'flex';
      });
      this.initialize();
    } else {
      // Turn off debug checkboxes when closing tile editor
      collisionTilesDebugCheckbox.checked = false;
      noPvpDebugCheckbox.checked = false;

      // Turn off grid when closing tile editor
      const gridCheckbox = document.getElementById('show-grid-checkbox') as HTMLInputElement;
      if (gridCheckbox) {
        gridCheckbox.checked = false;
      }
      this.toggleGridBtn.classList.remove('active');
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

    // Ensure opacity button starts inactive
    this.toggleOpacityBtn.classList.remove('active');
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

      if (isCollision) {
        layerItem.style.color = '#ff9999';
      } else if (isNoPvp) {
        layerItem.style.color = '#99ff99';
      }

      layerItem.textContent = layer.name;

      layerItem.addEventListener('click', () => this.selectLayer(layer.name));
      this.layersList.appendChild(layerItem);
    });

    // Select first non-special layer by default
    if (layers.length > 0) {
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

    // Draw active selection rectangle (while dragging)
    if (this.isSelectingTiles && this.selectionStartTile && this.selectionEndTile) {
      const minX = Math.min(this.selectionStartTile.x, this.selectionEndTile.x);
      const maxX = Math.max(this.selectionStartTile.x, this.selectionEndTile.x);
      const minY = Math.min(this.selectionStartTile.y, this.selectionEndTile.y);
      const maxY = Math.max(this.selectionStartTile.y, this.selectionEndTile.y);

      this.tilesetCtx.fillStyle = 'rgba(0, 150, 255, 0.3)';
      this.tilesetCtx.fillRect(
        minX * tileWidth,
        minY * tileHeight,
        (maxX - minX + 1) * tileWidth,
        (maxY - minY + 1) * tileHeight
      );

      this.tilesetCtx.strokeStyle = 'rgba(0, 150, 255, 1)';
      this.tilesetCtx.lineWidth = 2;
      this.tilesetCtx.strokeRect(
        minX * tileWidth,
        minY * tileHeight,
        (maxX - minX + 1) * tileWidth,
        (maxY - minY + 1) * tileHeight
      );
    }
    // Draw selected tiles highlight (after selection complete)
    else if (this.selectedTiles.length > 0) {
      const height = this.selectedTiles.length;
      const width = this.selectedTiles[0].length;

      // Find the top-left tile position in tileset coordinates
      const firstTileId = this.selectedTiles[0][0];
      if (firstTileId >= tileset.firstgid && firstTileId < tileset.firstgid + tileset.tilecount) {
        const localTileId = firstTileId - tileset.firstgid;
        const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
        const startX = (localTileId % tilesPerRow);
        const startY = Math.floor(localTileId / tilesPerRow);

        this.tilesetCtx.fillStyle = 'rgba(0, 150, 255, 0.3)';
        this.tilesetCtx.fillRect(
          startX * tileWidth,
          startY * tileHeight,
          width * tileWidth,
          height * tileHeight
        );

        this.tilesetCtx.strokeStyle = 'rgba(0, 150, 255, 1)';
        this.tilesetCtx.lineWidth = 3;
        this.tilesetCtx.strokeRect(
          startX * tileWidth,
          startY * tileHeight,
          width * tileWidth,
          height * tileHeight
        );
      }
    }
    // Draw single selected tile highlight (blue outline)
    else if (this.selectedTile && this.selectedTile >= tileset.firstgid && this.selectedTile < tileset.firstgid + tileset.tilecount) {
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

    // Draw hover highlight (only when not selecting)
    if (this.hoveredTilesetPos && !this.isSelectingTiles) {
      this.tilesetCtx.fillStyle = 'rgba(0, 150, 255, 0.4)';
      this.tilesetCtx.fillRect(
        this.hoveredTilesetPos.x * tileWidth,
        this.hoveredTilesetPos.y * tileHeight,
        tileWidth,
        tileHeight
      );
    }
  }

  private onTilesetMouseDown(e: MouseEvent) {
    if (!window.mapData || e.button !== 0) return; // Only left click

    const tileset = window.mapData.tilesets[this.currentTilesetIndex];
    if (!tileset) return;

    const rect = this.tilesetCanvas.getBoundingClientRect();
    const containerRect = this.tilesetContainer.getBoundingClientRect();

    // Check if click is within the visible container area
    if (e.clientX < containerRect.left || e.clientX > containerRect.right ||
        e.clientY < containerRect.top || e.clientY > containerRect.bottom) {
      return;
    }

    const scale = 1;
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;

    const tileX = Math.floor(x / tileset.tilewidth);
    const tileY = Math.floor(y / tileset.tileheight);

    // Start selection
    this.isSelectingTiles = true;
    this.selectionStartTile = { x: tileX, y: tileY };
    this.selectionEndTile = { x: tileX, y: tileY };

    this.drawTileset();
  }

  private onTilesetMouseUp(e: MouseEvent) {
    if (!window.mapData || !this.isSelectingTiles) return;

    this.isSelectingTiles = false;

    const tileset = window.mapData.tilesets[this.currentTilesetIndex];
    if (!tileset || !this.selectionStartTile || !this.selectionEndTile) return;

    // Calculate selection bounds
    const minX = Math.min(this.selectionStartTile.x, this.selectionEndTile.x);
    const maxX = Math.max(this.selectionStartTile.x, this.selectionEndTile.x);
    const minY = Math.min(this.selectionStartTile.y, this.selectionEndTile.y);
    const maxY = Math.max(this.selectionStartTile.y, this.selectionEndTile.y);

    const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);

    // Build 2D array of selected tiles
    this.selectedTiles = [];
    for (let y = minY; y <= maxY; y++) {
      const row: number[] = [];
      for (let x = minX; x <= maxX; x++) {
        const localTileId = y * tilesPerRow + x;
        const globalTileId = tileset.firstgid + localTileId;
        row.push(globalTileId);
      }
      this.selectedTiles.push(row);
    }

    // For single tile selection, set selectedTile for backward compatibility
    if (this.selectedTiles.length === 1 && this.selectedTiles[0].length === 1) {
      this.selectedTile = this.selectedTiles[0][0];
    } else {
      this.selectedTile = null; // Clear single tile when multi-selecting
    }

    // Always switch to paint mode when selecting from tileset
    this.setTool('paint');

    console.log('Selected tiles:', this.selectedTiles);
    this.drawTileset();
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

    // If selecting, update end position
    if (this.isSelectingTiles) {
      this.selectionEndTile = { x: tileX, y: tileY };
      this.drawTileset();
      return;
    }

    // Only update hover if the hovered tile changed
    if (!this.hoveredTilesetPos || this.hoveredTilesetPos.x !== tileX || this.hoveredTilesetPos.y !== tileY) {
      this.hoveredTilesetPos = { x: tileX, y: tileY };
      this.drawTileset();
    }
  }

  private onTilesetMouseLeave() {
    // End selection if dragging out
    if (this.isSelectingTiles) {
      this.isSelectingTiles = false;
      this.drawTileset();
    }

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

  private onPanelDragStart(panelId: string, e: MouseEvent) {
    const panelState = this.panels.get(panelId);
    if (!panelState) return;

    const target = e.target as HTMLElement;

    // Don't start drag if clicking on close button
    if (target.classList.contains('te-panel-close')) return;

    // Don't start drag if clicking on a button in the toolbar
    if (panelId === 'toolbar' && target.tagName === 'BUTTON') return;

    // Don't start drag if clicking on a layer item in the layers panel
    if (panelId === 'layers' && (target.classList.contains('te-layer-item') || target.closest('.te-layer-item'))) return;

    panelState.isDragging = true;
    panelState.startX = e.clientX;
    panelState.startY = e.clientY;

    // Get current position of panel
    const rect = panelState.panel.getBoundingClientRect();
    panelState.offsetX = rect.left;
    panelState.offsetY = rect.top;

    // Change cursor
    panelState.header.style.cursor = 'grabbing';
    panelState.panel.style.zIndex = '1001'; // Bring to front
  }

  private onPanelDrag(e: MouseEvent) {
    this.panels.forEach(panelState => {
      if (!panelState.isDragging) return;

      const deltaX = e.clientX - panelState.startX;
      const deltaY = e.clientY - panelState.startY;

      let newX = panelState.offsetX + deltaX;
      let newY = panelState.offsetY + deltaY;

      // Constrain to viewport bounds
      const panelRect = panelState.panel.getBoundingClientRect();
      const maxX = window.innerWidth - panelRect.width;
      const maxY = window.innerHeight - panelRect.height;

      newX = Math.max(0, Math.min(newX, maxX));
      newY = Math.max(0, Math.min(newY, maxY));

      // Update position and clear transform to avoid conflicts with initial CSS positioning
      panelState.panel.style.transform = 'none';
      panelState.panel.style.left = `${newX}px`;
      panelState.panel.style.top = `${newY}px`;
      panelState.panel.style.right = 'auto';
      panelState.panel.style.bottom = 'auto';
    });
  }

  private onPanelDragEnd() {
    this.panels.forEach((panelState, id) => {
      if (!panelState.isDragging) return;

      panelState.isDragging = false;
      // Reset cursor - toolbar and layers use grab on the panel, tileset uses grab on header
      if (id === 'toolbar' || id === 'layers') {
        panelState.panel.style.cursor = 'grab';
      } else {
        panelState.header.style.cursor = 'grab';
      }
      panelState.panel.style.zIndex = '1000';

      // Save position
      this.savePanelPosition(id, panelState.panel);
    });
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
    this.resizeStartWidth = this.tilesetPanel.offsetWidth;
    this.resizeStartHeight = this.tilesetPanel.offsetHeight;

    // Disable transitions during resize for smoother experience
    this.tilesetPanel.style.transition = 'none';
  }

  private onResize(e: MouseEvent) {
    if (!this.isResizing) return;

    e.preventDefault();

    const deltaX = e.clientX - this.resizeStartX;
    const deltaY = e.clientY - this.resizeStartY;

    let newWidth = this.resizeStartWidth + deltaX;
    let newHeight = this.resizeStartHeight + deltaY;

    // Apply constraints from CSS
    const minWidth = 400;
    const minHeight = 300;
    const maxWidth = window.innerWidth * 0.9;
    const maxHeight = window.innerHeight * 0.9;

    newWidth = Math.max(minWidth, Math.min(newWidth, maxWidth));
    newHeight = Math.max(minHeight, Math.min(newHeight, maxHeight));

    this.tilesetPanel.style.width = `${newWidth}px`;
    this.tilesetPanel.style.height = `${newHeight}px`;
  }

  private onResizeEnd() {
    if (!this.isResizing) return;

    this.isResizing = false;
    // Re-enable transitions
    this.tilesetPanel.style.transition = '';
  }

  private loadPanelPositions() {
    try {
      const saved = localStorage.getItem('tile-editor-panel-positions');
      if (!saved) return;

      const positions = JSON.parse(saved);
      this.panels.forEach((panelState, id) => {
        const position = positions[id];
        if (position) {
          panelState.panel.style.transform = 'none'; // Clear CSS transform
          panelState.panel.style.left = `${position.x}px`;
          panelState.panel.style.top = `${position.y}px`;
          panelState.panel.style.right = 'auto';
          panelState.panel.style.bottom = 'auto';
        }
      });
    } catch (e) {
      console.warn('Failed to load tile editor panel positions:', e);
    }
  }

  private savePanelPosition(panelId: string, panel: HTMLElement) {
    try {
      const saved = localStorage.getItem('tile-editor-panel-positions');
      const positions = saved ? JSON.parse(saved) : {};

      const rect = panel.getBoundingClientRect();
      positions[panelId] = {
        x: rect.left,
        y: rect.top
      };

      localStorage.setItem('tile-editor-panel-positions', JSON.stringify(positions));
    } catch (e) {
      console.warn('Failed to save tile editor panel position:', e);
    }
  }

  private resetPanelPositions() {
    // Clear saved positions from localStorage
    localStorage.removeItem('tile-editor-panel-positions');

    // Reset each panel to its default CSS position
    this.panels.forEach(panelState => {
      panelState.panel.style.left = '';
      panelState.panel.style.top = '';
      panelState.panel.style.right = '';
      panelState.panel.style.bottom = '';
      panelState.panel.style.transform = '';
    });

    // Reset tileset panel size
    this.tilesetPanel.style.width = '';
    this.tilesetPanel.style.height = '';

    console.log('Panel positions and sizes reset to default');
  }

  private toggleLayerOpacity() {
    this.dimOtherLayers = !this.dimOtherLayers;

    // Update button visual state
    if (this.dimOtherLayers) {
      this.toggleOpacityBtn.classList.add('active');
    } else {
      this.toggleOpacityBtn.classList.remove('active');
    }

    console.log('Layer opacity toggled:', this.dimOtherLayers ? 'Dimming non-selected layers' : 'Showing all layers normally');
  }

  public shouldDimLayer(layerName: string): boolean {
    return this.dimOtherLayers && layerName !== this.selectedLayer;
  }

  private toggleGrid() {
    const gridCheckbox = document.getElementById('show-grid-checkbox') as HTMLInputElement;
    if (gridCheckbox) {
      gridCheckbox.checked = !gridCheckbox.checked;

      // Update button visual state
      if (gridCheckbox.checked) {
        this.toggleGridBtn.classList.add('active');
      } else {
        this.toggleGridBtn.classList.remove('active');
      }

      console.log('Grid toggled:', gridCheckbox.checked ? 'On' : 'Off');
    }
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
    if (!this.selectedLayer || !window.mapData) return;

    // Handle multi-tile placement
    if (this.selectedTiles.length > 0) {
      this.placeMultipleTiles(tileX, tileY);
      return;
    }

    // Handle single tile placement
    if (!this.selectedTile) return;

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

  private placeMultipleTiles(startTileX: number, startTileY: number) {
    if (!this.selectedLayer || !window.mapData || this.selectedTiles.length === 0) return;

    const chunkSize = window.mapData.chunkSize;
    const affectedChunks = new Set<string>();
    const changeGroup: TileChange[] = [];

    // Place each tile in the selection
    for (let row = 0; row < this.selectedTiles.length; row++) {
      for (let col = 0; col < this.selectedTiles[row].length; col++) {
        const tileId = this.selectedTiles[row][col];
        const worldTileX = startTileX + col;
        const worldTileY = startTileY + row;

        const chunkX = Math.floor(worldTileX / chunkSize);
        const chunkY = Math.floor(worldTileY / chunkSize);
        const localTileX = worldTileX % chunkSize;
        const localTileY = worldTileY % chunkSize;

        const chunkKey = `${chunkX}-${chunkY}`;
        const chunk = window.mapData.loadedChunks.get(chunkKey);

        if (!chunk) continue;

        const layer = chunk.layers.find((l: any) => l.name === this.selectedLayer);
        if (!layer) continue;

        const tileIndex = localTileY * chunk.width + localTileX;
        const oldTileId = layer.data[tileIndex];

        if (oldTileId === tileId) continue; // No change

        // Record change in group
        changeGroup.push({
          chunkX,
          chunkY,
          layerName: this.selectedLayer,
          tileX: localTileX,
          tileY: localTileY,
          oldTileId,
          newTileId: tileId
        });

        // Update tile data
        layer.data[tileIndex] = tileId;

        // Track affected chunk
        affectedChunks.add(chunkKey);
      }
    }

    // Push entire group as one undo action
    if (changeGroup.length > 0) {
      this.undoStack.push({ changes: changeGroup });
      this.redoStack = []; // Clear redo stack on new action
    }

    // Re-render all affected chunks
    affectedChunks.forEach(chunkKey => {
      const [chunkX, chunkY] = chunkKey.split('-').map(Number);
      this.rerenderChunk(chunkX, chunkY);
    });
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
    const item = this.undoStack.pop();
    if (!item) return;

    const affectedChunks = new Set<string>();

    // Check if it's a group or single change
    if ('changes' in item) {
      // Handle group of changes
      const group = item as TileChangeGroup;
      group.changes.forEach(change => {
        const chunkKey = `${change.chunkX}-${change.chunkY}`;
        const chunk = window.mapData.loadedChunks.get(chunkKey);
        if (!chunk) return;

        const layer = chunk.layers.find((l: any) => l.name === change.layerName);
        if (!layer) return;

        const tileIndex = change.tileY * chunk.width + change.tileX;
        layer.data[tileIndex] = change.oldTileId;

        affectedChunks.add(chunkKey);
      });
      this.redoStack.push(group);
    } else {
      // Handle single change
      const change = item as TileChange;
      const chunkKey = `${change.chunkX}-${change.chunkY}`;
      const chunk = window.mapData.loadedChunks.get(chunkKey);
      if (!chunk) return;

      const layer = chunk.layers.find((l: any) => l.name === change.layerName);
      if (!layer) return;

      const tileIndex = change.tileY * chunk.width + change.tileX;
      layer.data[tileIndex] = change.oldTileId;

      affectedChunks.add(chunkKey);
      this.redoStack.push(change);
    }

    // Re-render all affected chunks
    affectedChunks.forEach(chunkKey => {
      const [chunkX, chunkY] = chunkKey.split('-').map(Number);
      this.rerenderChunk(chunkX, chunkY);
    });
  }

  private redo() {
    const item = this.redoStack.pop();
    if (!item) return;

    const affectedChunks = new Set<string>();

    // Check if it's a group or single change
    if ('changes' in item) {
      // Handle group of changes
      const group = item as TileChangeGroup;
      group.changes.forEach(change => {
        const chunkKey = `${change.chunkX}-${change.chunkY}`;
        const chunk = window.mapData.loadedChunks.get(chunkKey);
        if (!chunk) return;

        const layer = chunk.layers.find((l: any) => l.name === change.layerName);
        if (!layer) return;

        const tileIndex = change.tileY * chunk.width + change.tileX;
        layer.data[tileIndex] = change.newTileId;

        affectedChunks.add(chunkKey);
      });
      this.undoStack.push(group);
    } else {
      // Handle single change
      const change = item as TileChange;
      const chunkKey = `${change.chunkX}-${change.chunkY}`;
      const chunk = window.mapData.loadedChunks.get(chunkKey);
      if (!chunk) return;

      const layer = chunk.layers.find((l: any) => l.name === change.layerName);
      if (!layer) return;

      const tileIndex = change.tileY * chunk.width + change.tileX;
      layer.data[tileIndex] = change.newTileId;

      affectedChunks.add(chunkKey);
      this.undoStack.push(change);
    }

    // Re-render all affected chunks
    affectedChunks.forEach(chunkKey => {
      const [chunkX, chunkY] = chunkKey.split('-').map(Number);
      this.rerenderChunk(chunkX, chunkY);
    });
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

    this.undoStack.forEach(item => {
      // Handle both single changes and change groups
      const changes: TileChange[] = 'changes' in item ? item.changes : [item as TileChange];

      changes.forEach(change => {
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

    // Clear cached chunks so they reload with new data
    chunks.forEach(chunk => {
      clearChunkFromCache(window.mapData.name, chunk.chunkX, chunk.chunkY);
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

    // Don't trigger hotkeys when typing in input fields
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
      return;
    }

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
      (this.pasteBtn as HTMLButtonElement).disabled = true;
      this.pasteBtn.style.opacity = '0.5';
      this.pasteBtn.style.cursor = 'not-allowed';
    } else {
      (this.pasteBtn as HTMLButtonElement).disabled = false;
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
    if (!this.isActive || !this.previewTilePos || !window.mapData || !ctx) return;

    ctx.save();
    ctx.globalAlpha = 0.6;

    // Handle multi-tile preview
    if (this.currentTool === 'paint' && this.selectedTiles.length > 0) {
      try {
        for (let row = 0; row < this.selectedTiles.length; row++) {
          for (let col = 0; col < this.selectedTiles[row].length; col++) {
            const tileId = this.selectedTiles[row][col];
            if (tileId === 0) continue; // Skip empty tiles

            const tileset = window.mapData.tilesets.find((t: any) =>
              t.firstgid <= tileId && tileId < t.firstgid + t.tilecount
            );

            if (!tileset) continue;

            const image = window.mapData.images[window.mapData.tilesets.indexOf(tileset)];
            if (!image || !image.complete) continue;

            const localTileId = tileId - tileset.firstgid;
            const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
            const srcX = (localTileId % tilesPerRow) * tileset.tilewidth;
            const srcY = Math.floor(localTileId / tilesPerRow) * tileset.tileheight;

            const worldX = (this.previewTilePos.x + col) * window.mapData.tilewidth;
            const worldY = (this.previewTilePos.y + row) * window.mapData.tileheight;

            ctx.drawImage(
              image,
              srcX, srcY,
              tileset.tilewidth, tileset.tileheight,
              worldX, worldY,
              window.mapData.tilewidth, window.mapData.tileheight
            );
          }
        }
      } catch (e) {
        console.error('Error drawing multi-tile preview:', e);
      }
      ctx.restore();
      return;
    }

    // Handle erase mode - show red outline with background
    if (this.currentTool === 'erase') {
      const worldX = this.previewTilePos.x * window.mapData.tilewidth;
      const worldY = this.previewTilePos.y * window.mapData.tileheight;

      // Draw red background
      ctx.fillStyle = 'rgba(231, 76, 60, 0.3)';
      ctx.fillRect(
        worldX,
        worldY,
        window.mapData.tilewidth,
        window.mapData.tileheight
      );

      // Draw red outline
      ctx.strokeStyle = 'rgba(255, 89, 71, 1.0)';
      ctx.lineWidth = 3;
      ctx.strokeRect(
        worldX,
        worldY,
        window.mapData.tilewidth,
        window.mapData.tileheight
      );

      ctx.restore();
      return;
    }

    // Handle single tile preview
    let tileToPreview: number | null = null;
    if (this.currentTool === 'paint' && this.selectedTile) {
      tileToPreview = this.selectedTile;
    } else if (this.currentTool === 'paste' && this.copiedTile !== null) {
      tileToPreview = this.copiedTile;
    }

    // Show white outline when paint mode with no tile or paste mode with empty tile (ID 0)
    if ((this.currentTool === 'paint' && !this.selectedTile) ||
        (this.currentTool === 'paste' && this.copiedTile === 0)) {
      const worldX = this.previewTilePos.x * window.mapData.tilewidth;
      const worldY = this.previewTilePos.y * window.mapData.tileheight;

      // Draw white background
      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.fillRect(
        worldX,
        worldY,
        window.mapData.tilewidth,
        window.mapData.tileheight
      );

      // Draw white outline
      ctx.strokeStyle = 'rgba(255, 255, 255, 1.0)';
      ctx.lineWidth = 3;
      ctx.strokeRect(
        worldX,
        worldY,
        window.mapData.tilewidth,
        window.mapData.tileheight
      );

      ctx.restore();
      return;
    }

    // Don't show preview for tile ID 0 (empty tile) unless already handled above
    if (tileToPreview === null || tileToPreview === 0) {
      ctx.restore();
      return;
    }

    const tileset = window.mapData.tilesets.find((t: any) =>
      t.firstgid <= tileToPreview! && tileToPreview! < t.firstgid + t.tilecount
    );

    if (!tileset) {
      ctx.restore();
      return;
    }

    const image = window.mapData.images[window.mapData.tilesets.indexOf(tileset)];
    if (!image || !image.complete) {
      ctx.restore();
      return;
    }

    const localTileId = tileToPreview - tileset.firstgid;
    const tilesPerRow = Math.floor(tileset.imagewidth / tileset.tilewidth);
    const srcX = (localTileId % tilesPerRow) * tileset.tilewidth;
    const srcY = Math.floor(localTileId / tilesPerRow) * tileset.tileheight;

    const worldX = this.previewTilePos.x * window.mapData.tilewidth;
    const worldY = this.previewTilePos.y * window.mapData.tileheight;

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
