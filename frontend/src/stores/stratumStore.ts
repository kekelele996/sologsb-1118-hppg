import { createStore } from 'zustand/vanilla'
import type { Stratum, UnitType } from '@/types'
import { db, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'
import type { PartyRole } from '@/types'

export interface StratumState {
  strata: Stratum[]
  loaded: boolean
  hydrate: () => Promise<void>
  /** role 为现场时自增 fieldRev；资料室侧只通过定稿流程写资料室字段 */
  save: (stratum: Stratum, role?: PartyRole) => Promise<void>
  remove: (id: string) => Promise<void>
  bulkSetType: (ids: string[], type: UnitType) => Promise<void>
}

export const stratumStore = createStore<StratumState>((set, get) => ({
  strata: [],
  loaded: false,
  hydrate: async () => {
    const strata = await syncAll<Stratum>(db.strata)
    strata.sort((a, b) => (a.topDepth === b.topDepth ? a.code.localeCompare(b.code, 'zh-Hans-CN') : a.topDepth - b.topDepth))
    set({ strata, loaded: true })
  },
  save: async (stratum, role = 'field') => {
    const previous = get().strata.find((item) => item.id === stratum.id)
    const fieldRev = role === 'field' ? Math.max(stratum.fieldRev ?? 1, previous?.fieldRev ?? 0) + 1 : stratum.fieldRev ?? 1
    await syncPut<Stratum>(db.strata, { ...stratum, fieldRev })
    await get().hydrate()
  },
  remove: async (id) => {
    await syncDelete<Stratum>(db.strata, id)
    await get().hydrate()
  },
  bulkSetType: async (ids, type) => {
    const targets = get().strata.filter((item) => ids.includes(item.id))
    await Promise.all(
      targets.map((item) => syncPut<Stratum>(db.strata, { ...item, type, fieldRev: (item.fieldRev ?? 1) + 1 }))
    )
    await get().hydrate()
  }
}))
