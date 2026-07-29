export type DirectorAssetKind = 'scene' | 'character' | 'prop';
export type DirectorAssetStatus = 'draft' | 'generating' | 'ready' | 'error';

export interface DirectorAsset {
  id: string;
  kind: DirectorAssetKind;
  name: string;
  description: string;
  continuityLocks: string[];
  referenceImage?: string;
  imageSource?: 'uploaded' | 'generated';
  status: DirectorAssetStatus;
  error?: string;
}

export interface DirectorAssetValidation {
  valid: boolean;
  errors: string[];
}
