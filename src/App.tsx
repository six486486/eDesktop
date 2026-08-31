import { ControlCenter } from './ControlCenter'
import { DesktopSurface } from './DesktopSurface'

export default function App() {
  const params = new URLSearchParams(window.location.search)
  const surface = params.get('surface')
  const capture = params.get('capture') === '1'

  if (surface === 'desktop') return <DesktopSurface capture={capture} />
  return <ControlCenter />
}
