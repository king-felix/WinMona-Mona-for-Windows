/**
 * Fixture data for the visual harness. This is labelled test data: it never
 * reaches the product as a "demo success" fallback, and nothing here performs a
 * request or claims a real engine result. Long paths, long names, unknown cost,
 * disconnected and blocked states are deliberate.
 */
export const HARNESS_LABEL = 'Visual development harness — fixture data, not live state';

export const fixtures = {
  project: {
    name: 'mona-workspace-with-a-deliberately-long-project-name',
    path: 'X:\\AI_projects\\Mona\\worktrees\\feature\\transactional-project-state-and-migrations',
    branch: 'feature/p05-state',
    model: 'deepseek-flash',
    permission: 'Full Access',
    spend: '$0.0035',
  },
  tasks: [
    {
      id: 'P05',
      title: 'Build transactional project state and safe migrations with crash injection',
      status: 'verifying' as const,
      note: '23 new tests, real crash child process, backup verified',
    },
    {
      id: 'P06',
      title: "Build Mona's distinctive design system",
      status: 'running' as const,
      note: 'Contrast measured, keyboard sweep in progress',
    },
    {
      id: 'P07',
      title: 'Assemble the project catalog and desktop shell',
      status: 'pending' as const,
      note: 'Blocked by nothing; starts after P06',
    },
    {
      id: 'P08',
      title: 'Deliver the live work studio',
      status: 'pending' as const,
      note: 'Unstarted tasks stay unstarted — no guessed percentages',
    },
  ],
  events: [
    { at: '09:41:02', kind: 'submission', text: 'intent persisted before send (opa_…7f21)' },
    { at: '09:41:03', kind: 'engine', text: 'accepted by runtime 0.10.2 ff466b2' },
    { at: '09:41:19', kind: 'tool', text: 'write packages/project-state/src/store.ts (12,484 bytes)' },
    { at: '09:42:40', kind: 'test', text: '134 passed · 0 failed · exit 0' },
    { at: '09:43:11', kind: 'usage', text: 'cache hit 18,240 · cache miss 2,310 · output 1,904' },
  ],
  cost: {
    known: '$0.0035',
    unknownLabel: 'Unknown — the runtime reported usage without complete pricing',
    buckets: [
      { label: 'Cache hit', value: '18,240 tokens' },
      { label: 'Cache miss', value: '2,310 tokens' },
      { label: 'Output', value: '1,904 tokens' },
    ],
  },
  blocker: {
    id: 'P05-ISSUE-002',
    title: 'Backup restore raced an ingestion worker in a simulated test',
    attempts: 2,
    requirement: 'MONA-025 / backup-restore',
    evidence: 'docs/evidence/P05-state.md',
    help: 'Confirm whether the ingestion worker may write during a snapshot or must pause.',
  },
  settings: {
    provider: 'deepseek',
    endpoint: 'api.deepseek.com',
    model: 'deepseek-flash',
    posture: 'Full Access',
    telemetry: 'engine default (unchanged by Mona)',
  },
  longEvents: Array.from({ length: 60 }, (_, index) => ({
    at: `10:${String(index % 60).padStart(2, '0')}:00`,
    kind: index % 5 === 0 ? 'tool' : index % 3 === 0 ? 'test' : 'event',
    text: `event ${index + 1}: a moderately long line that must wrap without pushing the layout sideways`,
  })),
};
