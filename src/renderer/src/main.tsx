import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import Dashboard from './Dashboard'

// One bundle, two windows. The hash decides which root renders, so the timer
// and the dashboard share every style and component without a router.
const isDashboard = window.location.hash.startsWith('#/dashboard')

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isDashboard ? <Dashboard /> : <App />}</StrictMode>
)
