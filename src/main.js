import './assets/theme.css'

import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import { registerServiceWorker } from './pwa'

createApp(App).use(router).mount('#app')

registerServiceWorker()
