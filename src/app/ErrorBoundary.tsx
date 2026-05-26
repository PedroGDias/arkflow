import { Component, ErrorInfo, ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { error: Error | null; info: string | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info)
    this.setState({ info: info.componentStack ?? null })
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: '100vh', padding: 32, fontFamily: 'var(--mono, monospace)' }}>
          <div style={{ maxWidth: 800, margin: '0 auto' }}>
            <h1 style={{ fontFamily: 'var(--serif, serif)', fontSize: 28 }}>Something broke on this page</h1>
            <p style={{ color: 'var(--text3, #666)', fontSize: 13 }}>
              The error below is what crashed the view. Reloading may help; if it persists, send this text.
            </p>
            <pre
              style={{
                whiteSpace: 'pre-wrap', background: '#fff5f5', border: '1px solid #f0c0c0',
                borderRadius: 8, padding: 16, fontSize: 12, color: '#a33', overflow: 'auto',
              }}
            >
              {this.state.error.message}
              {this.state.info ? `\n\nComponent stack:${this.state.info}` : ''}
            </pre>
            <button
              onClick={() => { this.setState({ error: null, info: null }); window.location.assign('/') }}
              style={{
                marginTop: 12, padding: '10px 16px', borderRadius: 8, border: '1px solid #ccc',
                background: '#fff', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13,
              }}
            >
              Go home
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
