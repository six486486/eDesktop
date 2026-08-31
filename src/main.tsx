import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

const surface = new URLSearchParams(window.location.search).get('surface')
document.title = surface === 'control' ? 'eDesktop · 控制中心' : 'eDesktop · 桌面组件'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
