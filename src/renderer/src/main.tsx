import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import Dashboard from './Dashboard'
import PaceWindow from './PaceWindow'

// One bundle, three windows. The hash decides which root renders, so the timer,
// its pace loop and the dashboard share every style and component without a
// router.
const route = window.location.hash

// Written inline rather than as a component: a component declared here would
// break fast refresh for the whole entry file.
const root = route.startsWith('#/dashboard') ? (
  <Dashboard />
) : route.startsWith('#/pace') ? (
  <PaceWindow />
) : (
  <App />
)

createRoot(document.getElementById('root')!).render(<StrictMode>{root}</StrictMode>)
