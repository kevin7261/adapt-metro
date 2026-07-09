<script setup>
import { store, mapHandle } from '../store'
import MenuDropdown from './MenuDropdown.vue'
import {
  Map as MapIcon, Folder, FilePen, Eye, Database, Wrench, SlidersHorizontal,
  Puzzle, Settings, CircleHelp, Sun, Moon,
  FilePlus2, FolderOpen, Save, Share2, FileDown, Printer, BookOpen,
  Undo2, Redo2, ZoomIn, ZoomOut, Compass, Crosshair, Grid2x2,
  FileJson, FileArchive, Layers2, Globe, Server, Boxes, Mountain,
  Terminal, Sparkles, LayoutDashboard, Table2, GitBranch, Sigma,
  Ruler, Bookmark, Search, MapPin, ScanLine, ListTree, Component,
  Keyboard, Github, Info, MessageSquare, Command as CommandIcon,
} from 'lucide-vue-next'

const projectMenu = [
  { label: 'New…', icon: FilePlus2, shortcut: '⌘N', action: 'new-project' },
  {
    label: 'Open From', icon: FolderOpen,
    children: [
      { label: 'File…' }, { label: 'URL…' }, { label: 'Gallery…' },
    ],
  },
  {
    label: 'Open Recent',
    children: [
      { label: 'adapt-metro.geolibre.json' },
      { label: 'taipei-flood-study.geolibre.json' },
      { type: 'separator' },
      { label: 'Clear Recent' },
    ],
  },
  { type: 'separator' },
  { label: 'Save', icon: Save, shortcut: '⌘S' },
  { label: 'Save As…', shortcut: '⇧⌘S' },
  { label: 'Share…', icon: Share2 },
  { label: 'Export as Interactive HTML…', icon: FileDown },
  { type: 'separator' },
  { label: 'Print Layout…', icon: Printer },
  { label: 'StoryMap…', icon: BookOpen },
]

const editMenu = [
  { label: 'Undo', icon: Undo2, shortcut: '⌘Z' },
  { label: 'Redo', icon: Redo2, shortcut: '⇧⌘Z' },
]

const viewMenu = [
  { label: 'Zoom In', icon: ZoomIn, shortcut: '+', action: 'zoom-in' },
  { label: 'Zoom Out', icon: ZoomOut, shortcut: '−', action: 'zoom-out' },
  { type: 'separator' },
  { label: 'Previous View' },
  { label: 'Next View' },
  { label: 'Reset Orientation', icon: Compass, shortcut: 'N', action: 'reset-north' },
  { label: 'Reset Pitch & Bearing', shortcut: 'U', action: 'reset-view' },
  { label: 'Set View…', icon: Crosshair },
  { type: 'separator' },
  {
    label: 'Split View', icon: Grid2x2,
    children: [
      { label: 'Single map' }, { label: 'Two columns' }, { label: 'Two rows' },
      { label: '2 × 2 grid' }, { label: '3 × 3 grid' },
      { type: 'separator' }, { label: 'Sync views' },
    ],
  },
  { type: 'separator' },
  { label: 'View in Google Maps', icon: Globe },
]

const addDataMenu = [
  { type: 'label', label: 'Files' },
  { label: 'Vector Layer…', icon: FileJson, action: 'add-data' },
  { label: 'Raster Layer…', icon: Mountain, action: 'add-data' },
  { label: 'CAD Drawing (DXF/DWG)…', action: 'add-data' },
  { type: 'separator' },
  { type: 'label', label: 'Web services' },
  { label: 'XYZ Tiles…', icon: Grid2x2, action: 'add-data' },
  { label: 'WMS / WMTS…', icon: Server, action: 'add-data' },
  { label: 'WFS…', icon: Server, action: 'add-data' },
  { label: 'ArcGIS Service…', icon: Server, action: 'add-data' },
  { type: 'separator' },
  { type: 'label', label: 'Cloud formats' },
  { label: 'GeoParquet…', icon: FileArchive, action: 'add-data' },
  { label: 'PMTiles…', icon: Layers2, action: 'add-data' },
  { label: 'COG / GeoTIFF…', icon: Mountain, action: 'add-data' },
  { label: 'Zarr…', icon: Boxes, action: 'add-data' },
  { type: 'separator' },
  { type: 'label', label: '3D layers' },
  { label: '3D Tiles…', icon: Boxes, action: 'add-data' },
  { label: 'LiDAR…', icon: ScanLine, action: 'add-data' },
]

const processingMenu = [
  { label: 'SQL Workspace', icon: Terminal },
  { label: 'Python Console', icon: Terminal },
  { label: 'Assistant (AI)', icon: Sparkles },
  { label: 'Dashboard', icon: LayoutDashboard },
  { type: 'separator' },
  {
    label: 'Vector', icon: GitBranch,
    children: [
      { label: 'Buffer' }, { label: 'Clip' }, { label: 'Dissolve' },
      { label: 'Intersection' }, { label: 'Union' }, { label: 'Spatial Join' },
      { label: 'Convex Hull' }, { label: 'Simplify' }, { label: 'Centroids' },
    ],
  },
  {
    label: 'Raster', icon: Mountain,
    children: [
      { label: 'Hillshade' }, { label: 'Slope' }, { label: 'Contour' },
      { label: 'Reclassify' }, { label: 'Zonal Statistics' }, { label: 'Raster Calculator' },
    ],
  },
  {
    label: 'Spatial Statistics', icon: Sigma,
    children: [
      { label: "Moran's I" }, { label: 'Getis-Ord Gi*' }, { label: 'Kernel Density' },
    ],
  },
  {
    label: 'Conversion',
    children: [
      { label: 'Vector to GeoParquet' }, { label: 'Vector to PMTiles' },
      { label: 'CSV to GeoParquet' }, { label: 'Raster to COG' },
    ],
  },
]

const controlsMenu = [
  { label: 'Measure', icon: Ruler },
  { label: 'Bookmark', icon: Bookmark },
  { label: 'Minimap', icon: MapPin },
  { label: 'Search', icon: Search },
  { label: 'Legend', icon: ListTree },
  { label: 'Gridlines', icon: Grid2x2 },
  { label: 'View State', icon: Component },
  { type: 'separator' },
  { label: 'Field Collection…' },
  { label: 'Record Map Tour…' },
]

const pluginsMenu = [
  { label: 'Manage Plugins…', icon: Puzzle },
  { type: 'separator' },
  { label: 'Basemap Picker' },
  { label: 'Overture Maps' },
  { label: 'Planetary Computer' },
  { label: 'Earth Engine' },
]

const helpMenu = [
  { label: 'Command Palette', icon: CommandIcon, shortcut: '⌘K', action: 'command-palette' },
  { label: 'Keyboard Shortcuts', icon: Keyboard, shortcut: '?', action: 'shortcuts' },
  { type: 'separator' },
  { label: 'Website', icon: Globe },
  { label: 'GitHub Repository', icon: Github },
  { label: 'Give Feedback', icon: MessageSquare },
  { type: 'separator' },
  { label: 'About', icon: Info, action: 'about' },
]

function onAction(item) {
  const map = mapHandle.map
  switch (item.action) {
    case 'new-project': store.ui.dialog = 'new-project'; break
    case 'add-data': store.ui.dialog = 'add-data'; break
    case 'about': store.ui.dialog = 'about'; break
    case 'shortcuts': store.ui.dialog = 'shortcuts'; break
    case 'command-palette': store.ui.commandPalette = true; break
    case 'zoom-in': map?.zoomIn(); break
    case 'zoom-out': map?.zoomOut(); break
    case 'reset-north': map?.resetNorth(); break
    case 'reset-view': map?.easeTo({ pitch: 0, bearing: 0 }); break
    default: store.fake(item.label)
  }
}
</script>

<template>
  <header class="toolbar">
    <div class="brand">
      <MapIcon :size="16" />
      <span class="brand-name">Adapt-Metro GIS</span>
    </div>

    <MenuDropdown label="Project" :icon="Folder" :items="projectMenu" @action="onAction" />
    <MenuDropdown label="Edit" :icon="FilePen" :items="editMenu" @action="onAction" />
    <MenuDropdown label="View" :icon="Eye" :items="viewMenu" @action="onAction" />
    <MenuDropdown label="Add Data" :icon="Database" :items="addDataMenu" @action="onAction" />
    <MenuDropdown label="Processing" :icon="Wrench" :items="processingMenu" @action="onAction" />
    <MenuDropdown label="Controls" :icon="SlidersHorizontal" :items="controlsMenu" @action="onAction" />
    <MenuDropdown label="Plugins" :icon="Puzzle" :items="pluginsMenu" @action="onAction" />
    <button class="btn-ghost" title="Settings" @click="store.ui.dialog = 'settings'">
      <Settings :size="14" />
    </button>
    <MenuDropdown label="Help" :icon="CircleHelp" :items="helpMenu" @action="onAction" />

    <div class="right-cluster">
      <button
        class="btn-icon"
        :title="store.dark ? 'Switch to light mode' : 'Switch to dark mode'"
        @click="store.dark = !store.dark"
      >
        <Sun v-if="store.dark" :size="15" />
        <Moon v-else :size="15" />
      </button>
      <input v-model="store.projectName" class="project-name" spellcheck="false" />
    </div>
  </header>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 44px;
  padding: 4px 8px;
  flex-shrink: 0;
  border-bottom: 1px solid hsl(var(--border));
  background: hsl(var(--card));
  flex-wrap: wrap;
}
.brand {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px 0 4px;
  font-size: 13px;
  font-weight: 600;
  color: hsl(var(--primary));
  white-space: nowrap;
  flex-shrink: 0;
}
.right-cluster {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding-left: 8px;
  flex-shrink: 0;
}
.project-name {
  height: 28px;
  width: 200px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: calc(var(--radius) - 2px);
  background: transparent;
  color: hsl(var(--muted-foreground));
  font-size: 12px;
}
.project-name:hover { border-color: hsl(var(--border)); }
.project-name:focus {
  outline: none;
  border-color: hsl(var(--ring));
  color: hsl(var(--foreground));
}
@media (max-width: 900px) {
  .brand-name, .project-name { display: none; }
}
</style>
