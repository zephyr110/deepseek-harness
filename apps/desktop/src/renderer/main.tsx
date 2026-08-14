import { createRoot } from 'react-dom/client'

const el = document.getElementById('root')
if (el === null) throw new Error('desktop renderer: missing #root')
createRoot(el).render(<div>DeepSeek Harness desktop</div>)
