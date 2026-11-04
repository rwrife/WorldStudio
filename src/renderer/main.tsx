import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './style.css'
import type { StudioApi } from '../shared/types'

declare global { interface Window { studio: StudioApi } }

class ErrorBoundary extends React.Component<React.PropsWithChildren, { error?: string }> {
  state: { error?: string } = {}
  static getDerivedStateFromError(error: Error) { return { error: error.message } }
  render() {
    return this.state.error ? <main className="fatal"><h1>Studio needs to reload</h1><p>{this.state.error}</p><button onClick={() => location.reload()}>Reload studio</button></main> : this.props.children
  }
}
createRoot(document.getElementById('root')!).render(<ErrorBoundary><App /></ErrorBoundary>)
