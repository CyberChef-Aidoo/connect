import 'express-session';

declare module 'express-session' {
  interface SessionData {
    userId: string;
    csrfToken: string;
  }
}

export type PublicUser = {
  id: string;
  username: string;
};

export type Limits = {
  maxFileBytes: number;
  maxStorageBytes: number;
};

export type FileRecord = {
  id: string;
  originalName: string;
  sizeBytes: number;
  createdAt: string;
  ownerId: string;
  ownerUsername: string;
  canDelete: boolean;
  folderId: string | null;
  folderName: string | null;
  favorite: boolean;
  tags: Array<{ id: string; name: string }>;
  preview: 'image' | 'text' | 'none';
  versionCount: number;
};
