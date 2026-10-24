import './assets/main.css'
import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createTheme, MantineProvider } from '@mantine/core'
import { Notifications } from '@mantine/notifications'
import App from './App'

const theme = createTheme({
  cursorType: 'pointer',
  primaryColor: 'blue',
  defaultRadius: 'md',
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  headings: { fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="light">
      <Notifications position="bottom-left" limit={4} />
      <App />
    </MantineProvider>
  </StrictMode>
)
