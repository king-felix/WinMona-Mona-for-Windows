import type { ResumeBrief, SinceYouLeft } from '@mona/project-state';
import type { IpcResult } from './catalog.js';

/**
 * The brief and digest cross the bridge already assembled from recorded rows.
 * The renderer cannot ask for "a summary"; it can only ask for this projection.
 */
export const BRIEFING_CHANNELS = {
  get: 'mona:briefing-get',
} as const;

export type BriefingRequest = {
  projectId: string;
  /** Update the stored last-seen timestamp after computing the digest. */
  markSeen?: boolean;
};

export type BriefingView = {
  resume: ResumeBrief;
  since: SinceYouLeft;
};

export type BriefingBridge = {
  briefingGet(input: BriefingRequest): Promise<IpcResult<BriefingView>>;
};
