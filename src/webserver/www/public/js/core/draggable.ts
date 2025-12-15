// Draggable Panel System
interface PanelPosition {
  x: number;
  y: number;
}

interface DraggablePanel {
  element: HTMLElement;
  handle: HTMLElement;
  position: PanelPosition;
  isDragging: boolean;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
}

class DraggableUI {
  private panels: Map<string, DraggablePanel> = new Map();
  private storageKey = 'ui-panel-positions';

  constructor() {
    this.loadPositions();
  }

  public registerPanel(id: string, element: HTMLElement, handle: HTMLElement) {
    const savedPosition = this.getSavedPosition(id);

    // Set initial position
    if (savedPosition) {
      element.style.left = `${savedPosition.x}px`;
      element.style.top = `${savedPosition.y}px`;
    }

    const panel: DraggablePanel = {
      element,
      handle,
      position: savedPosition || { x: parseInt(element.style.left) || 0, y: parseInt(element.style.top) || 0 },
      isDragging: false,
      startX: 0,
      startY: 0,
      offsetX: 0,
      offsetY: 0
    };

    this.panels.set(id, panel);

    // Setup drag events
    handle.style.cursor = 'grab';
    handle.addEventListener('mousedown', (e) => this.onDragStart(id, e));
    document.addEventListener('mousemove', (e) => this.onDrag(id, e));
    document.addEventListener('mouseup', () => this.onDragEnd(id));
  }

  private onDragStart(id: string, e: MouseEvent) {
    const panel = this.panels.get(id);
    if (!panel) return;

    panel.isDragging = true;
    panel.startX = e.clientX;
    panel.startY = e.clientY;

    const rect = panel.element.getBoundingClientRect();
    panel.offsetX = rect.left;
    panel.offsetY = rect.top;

    panel.handle.style.cursor = 'grabbing';
    panel.element.style.zIndex = '1000'; // Bring to front
  }

  private onDrag(id: string, e: MouseEvent) {
    const panel = this.panels.get(id);
    if (!panel || !panel.isDragging) return;

    const deltaX = e.clientX - panel.startX;
    const deltaY = e.clientY - panel.startY;

    let newX = panel.offsetX + deltaX;
    let newY = panel.offsetY + deltaY;

    // Constrain to viewport
    const rect = panel.element.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width;
    const maxY = window.innerHeight - rect.height;

    newX = Math.max(0, Math.min(newX, maxX));
    newY = Math.max(0, Math.min(newY, maxY));

    panel.element.style.left = `${newX}px`;
    panel.element.style.top = `${newY}px`;

    panel.position.x = newX;
    panel.position.y = newY;
  }

  private onDragEnd(id: string) {
    const panel = this.panels.get(id);
    if (!panel || !panel.isDragging) return;

    panel.isDragging = false;
    panel.handle.style.cursor = 'grab';
    panel.element.style.zIndex = '100';

    // Save position
    this.savePosition(id, panel.position);
  }

  private loadPositions() {
    try {
      const saved = localStorage.getItem(this.storageKey);
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (e) {
      console.warn('Failed to load UI positions:', e);
    }
    return {};
  }

  private getSavedPosition(id: string): PanelPosition | null {
    const positions = this.loadPositions();
    return positions[id] || null;
  }

  private savePosition(id: string, position: PanelPosition) {
    try {
      const positions = this.loadPositions();
      positions[id] = position;
      localStorage.setItem(this.storageKey, JSON.stringify(positions));
    } catch (e) {
      console.warn('Failed to save UI position:', e);
    }
  }

  public resetPositions() {
    localStorage.removeItem(this.storageKey);
    window.location.reload();
  }
}

// Export singleton instance
const draggableUI = new DraggableUI();
export default draggableUI;
