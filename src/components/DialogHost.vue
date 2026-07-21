<script setup>
import { computed } from 'vue'
import { useMapStore } from '../stores/mapStore'
import { IMPORT_DIALOGS, useDialogCatalog } from './dialogs/useDialogCatalog'
import ImportDialog from './dialogs/ImportDialog.vue'
import AddD3Dialog from './dialogs/AddD3Dialog.vue'
import AddHillClimbDialog from './dialogs/AddHillClimbDialog.vue'
import AddRwdDialog from './dialogs/AddRwdDialog.vue'
import AddDataDialog from './dialogs/AddDataDialog.vue'
import SkillsDialog from './dialogs/SkillsDialog.vue'
import SettingsDialog from './dialogs/SettingsDialog.vue'
import ShortcutsDialog from './dialogs/ShortcutsDialog.vue'
import AboutDialog from './dialogs/AboutDialog.vue'
import NewProjectDialog from './dialogs/NewProjectDialog.vue'
import './dialogs/dialogs.css'

const store = useMapStore()
useDialogCatalog()

const dialog = computed(() => store.ui.dialog)
function close() { store.ui.dialog = null }

const HIGHWAY_DIALOGS = ['import-highway-quick', 'import-highway-stations', 'import-highway-map']
const RAILWAY_DIALOGS = ['import-railway-quick', 'import-railway-stations', 'import-railway-map']
const ALL_IMPORT_DIALOGS = [...IMPORT_DIALOGS, ...RAILWAY_DIALOGS, ...HIGHWAY_DIALOGS]
</script>

<template>
  <div v-if="dialog" class="dialog-overlay" @mousedown.self="close">
    <ImportDialog v-if="ALL_IMPORT_DIALOGS.includes(dialog)" :dialog="dialog" @close="close" />
    <AddD3Dialog v-else-if="dialog === 'add-d3'" @close="close" />
    <AddHillClimbDialog v-else-if="dialog === 'add-hillclimb'" @close="close" />
    <AddRwdDialog v-else-if="dialog === 'add-rwd'" @close="close" />
    <AddDataDialog v-else-if="dialog === 'add-data'" @close="close" />
    <SkillsDialog v-else-if="dialog === 'skills'" :dialog="dialog" @close="close" />
    <NewProjectDialog v-else-if="dialog === 'new-project'" @close="close" />
    <SettingsDialog v-else-if="dialog === 'settings'" @close="close" />
    <ShortcutsDialog v-else-if="dialog === 'shortcuts'" @close="close" />
    <AboutDialog v-else-if="dialog === 'about'" @close="close" />
  </div>
</template>
