import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { startControlPlane, stopControlPlane } from './server/bootstrap'
import type { Register } from '@tanstack/react-router'
import type { RequestHandler } from '@tanstack/react-start/server'

const handler = createStartHandler(defaultStreamHandler)
const fetch: RequestHandler<Register> = async (...args) => {
  await startControlPlane()
  return handler(...args)
}

export default { fetch, initialize: startControlPlane, shutdown: stopControlPlane }