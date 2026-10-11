import './assets/theme.css'

import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import { registerServiceWorker } from './pwa'
import './research' // RESEARCH: remove with src/research

createApp(App).use(router).mount('#app')

registerServiceWorker()
