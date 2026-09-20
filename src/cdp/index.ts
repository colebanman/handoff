/**
 * Factory export for the CDP service. Each call returns a fresh instance
 * (a singleton-per-call): the composition root creates exactly one.
 */

import type { CdpService } from '../shared/types'
import { CdpServiceImpl } from './service'

export function createCdpService(): CdpService {
  return new CdpServiceImpl()
}
