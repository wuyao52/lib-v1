import type { DirectorAsset } from './directorAsset';
import type { DirectorClipGeneration } from '@/services/directorVideoService';

export interface DirectorShot {
  clipId: string;
  sceneId: string;
  sequenceIndex: number;
  sourceSegmentIds: string[];
  sourceEvidence: string;
  title: string;
  narrativeJob: string;
  feltIntent: string;
  arcPosition: string;
  targetDurationSec: number;
  generationMode: string;
  camera: string;
  lighting: string;
  performance: string;
  audio: string;
  plannedEndState: string;
  continuityLocks: string[];
  reservedForLater: string[];
  status: 'ready' | 'provisional';
  prompt: string;
}

export interface StoryboardPlan {
  projectId: string;
  title: string;
  source: 'ai';
  targetDurationSec: number;
  durationRecommendationReason: string;
  storySummary: string;
  storyPromise: string;
  finalOutcome: string;
  directorVoice: { name: string; camera: string; light: string; performance: string };
  scenes: Array<{ sceneId: string; narrativeFunction: string; arcPosition: string; assignedClipIds: string[] }>;
  shots: DirectorShot[];
  customSkills: Array<{ id: string; name: string; instructions: string }>;
}

export interface DirectorSession {
  id: string;
  story: string;
  voice: string;
  durationMode: DirectorDurationMode;
  manualDurationSec: number;
  plan: StoryboardPlan;
  assets: DirectorAsset[];
  clips: Record<string, DirectorClipGeneration>;
  status: 'draft' | 'generating' | 'partial' | 'completed' | 'cancelled';
  updatedAt: string;
}

export type DirectorDurationMode = 'ai' | 'manual';
