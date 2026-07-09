import { createApp } from 'vue'
import { createPinia } from 'pinia'
import 'maplibre-gl/dist/maplibre-gl.css'
import 'dockview-vue/dist/styles/dockview.css'
import './style.css'
import App from './App.vue'

createApp(App).use(createPinia()).mount('#app')
