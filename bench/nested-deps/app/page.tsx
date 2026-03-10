'use client'

import { foo } from './actions'

export default function Page() {
  return <button onClick={foo}>Click me</button>
}
