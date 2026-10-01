import { createStore } from 'zustand/vanilla'
import type { Artifact, PartyRole } from '@/types'
import { db, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'

export interface ArtifactState {
  artifacts: Artifact[]
  loaded: boolean
  hydrate: () => Promise<void>
  /** role 为现场时自增 fieldRev（现场器物号贴在实物上，资料室侧只回填定稿号） */
  save: (artifact: Artifact, role?: PartyRole) => Promise<void>
  remove: (id: string) => Promise<void>
  removeByStratum: (stratumId: string) => Promise<void>
}

export const artifactStore = createStore<ArtifactState>((set, get) => ({
  artifacts: [],
  loaded: false,
  hydrate: async () => {
    const artifacts = await syncAll<Artifact>(db.artifacts)
    artifacts.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN', { numeric: true }))
    set({ artifacts, loaded: true })
  },
  save: async (artifact, role = 'field') => {
    const previous = get().artifacts.find((item) => item.id === artifact.id)
    const fieldRev = role === 'field' ? Math.max(artifact.fieldRev ?? 1, previous?.fieldRev ?? 0) + 1 : artifact.fieldRev ?? 1
    await syncPut<Artifact>(db.artifacts, { ...artifact, fieldRev })
    await get().hydrate()
  },
  remove: async (id) => {
    await syncDelete<Artifact>(db.artifacts, id)
    await get().hydrate()
  },
  removeByStratum: async (stratumId) => {
    const targets = get().artifacts.filter((item) => item.stratumId === stratumId)
    await Promise.all(targets.map((item) => syncDelete<Artifact>(db.artifacts, item.id)))
    await get().hydrate()
  }
}))
